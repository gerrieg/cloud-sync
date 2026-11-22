import type { SyncRunResult } from '../../shared/calendar.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { updateProfile, type ProfileRow } from '../profiles/profile-store.js';
import type { SyncProviders } from '../providers/types.js';
import { runCalendarSync } from './calendar-sync.js';
import { runContactSync } from './contact-sync.js';
import { runMailSync } from './mail-sync.js';

/** `domain` narrows a run to one kind of data; `all` syncs everything. */
export type SyncDomain = 'all' | 'calendars' | 'contacts' | 'mail';

export interface ProfileSyncOptions {
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly profile: ProfileRow;
  /** The Profile's Apple ID, used to recognise foreign invitations. */
  readonly appleId: string;
  readonly providers: SyncProviders;
  readonly domain: SyncDomain;
  readonly dryRun: boolean;
  readonly force: boolean;
}

/** Runs the selected sync domains of one Profile and records the outcome on the Profile. */
export async function runProfileSync(options: ProfileSyncOptions): Promise<SyncRunResult> {
  const { db, clock, profile, appleId, providers, domain, dryRun, force } = options;
  const covers = (part: Exclude<SyncDomain, 'all'>) => domain === 'all' || domain === part;
  const calendars = covers('calendars')
    ? await runCalendarSync({ db, clock, profile, appleId, providers, dryRun, force })
    : { dryRun, rules: [] };
  const contacts = covers('contacts') ? await runContactSync({ db, clock, profile, providers, dryRun, force }) : null;
  const mail = covers('mail') ? await runMailSync({ db, clock, profile, providers, dryRun, force }) : null;
  // Calendar runs record the outcome themselves; other runs add theirs on top
  const failed = contacts?.status === 'error' || mail?.status === 'error';
  if (!dryRun && (domain === 'contacts' || domain === 'mail' || failed)) {
    updateProfile(db, profile.id, {
      lastSyncAt: clock.now(),
      lastSyncStatus: failed || profile.lastSyncStatus === 'error' ? 'error' : 'ok',
    });
  }
  return { ...calendars, ...(contacts ? { contacts } : {}), ...(mail ? { mail } : {}) };
}
