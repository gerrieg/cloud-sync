import type { SyncRunResult } from '../../shared/calendar.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { recordSyncOutcome, type ProfileRow } from '../profiles/profile-store.js';
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
  /** Narrows the calendar part of the run to one Sync Rule; contacts and mail always run profile-wide. */
  readonly ruleId?: string;
}

/** Runs the selected sync domains of one Profile and records the outcome on the Profile. */
export async function runProfileSync(options: ProfileSyncOptions): Promise<SyncRunResult> {
  const { db, clock, profile, appleId, providers, domain, dryRun, force, ruleId } = options;
  const covers = (part: Exclude<SyncDomain, 'all'>) => domain === 'all' || domain === part;
  const calendars = covers('calendars')
    ? await runCalendarSync({ db, clock, profile, appleId, providers, dryRun, force, ...(ruleId !== undefined ? { ruleId } : {}) })
    : { dryRun, rules: [] };
  const contacts = covers('contacts') ? await runContactSync({ db, clock, profile, providers, dryRun, force }) : null;
  const mail = covers('mail') ? await runMailSync({ db, clock, profile, providers, dryRun, force }) : null;
  if (!dryRun) {
    const runFailed =
      calendars.rules.some((rule) => rule.status === 'error') || contacts?.status === 'error' || mail?.status === 'error';
    // Only a run of all of the Profile's calendar rules can say that an earlier error is gone
    const coversAllCalendarRules = covers('calendars') && ruleId === undefined;
    const status = runFailed || (!coversAllCalendarRules && profile.lastSyncStatus === 'error') ? 'error' : 'ok';
    recordSyncOutcome(db, profile.id, clock.now(), { status, runFailed });
  }
  return { ...calendars, ...(contacts ? { contacts } : {}), ...(mail ? { mail } : {}) };
}
