import type { SyncRunResult } from '../../shared/calendar.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { recordSyncOutcome, type ProfileRow } from '../profiles/profile-store.js';
import type { SyncProviders } from '../providers/types.js';
import { runCalendarSync } from './calendar-sync.js';
import { runContactSync } from './contact-sync.js';
import { runMailSync } from './mail-sync.js';
import { markRunning, recordRun, summarizeOutcomes, type RunOutcome } from './sync-run-store.js';

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
  /** Times a part of the run for the Overview; a dry run changes nothing and leaves no trace there. */
  async function tracked<T>(part: Exclude<SyncDomain, 'all'>, work: () => Promise<T>, outcomes: (result: T) => readonly (RunOutcome & { reason?: string })[]): Promise<T> {
    if (dryRun) {
      return work();
    }
    const startedAt = clock.now();
    const finished = markRunning(profile.id, part);
    try {
      const result = await work();
      const outcome = summarizeOutcomes(outcomes(result));
      if (outcome) {
        recordRun(db, profile.id, part, startedAt, clock.now() - startedAt, outcome);
      }
      return result;
    } finally {
      finished();
    }
  }
  const calendars = covers('calendars')
    ? await tracked(
        'calendars',
        () => runCalendarSync({ db, clock, profile, appleId, providers, dryRun, force, ...(ruleId !== undefined ? { ruleId } : {}) }),
        (result) => result.rules,
      )
    : { dryRun, rules: [] };
  const contacts = covers('contacts')
    ? await tracked('contacts', () => runContactSync({ db, clock, profile, providers, dryRun, force }), (result) => (result ? [result] : []))
    : null;
  const mail = covers('mail')
    ? await tracked('mail', () => runMailSync({ db, clock, profile, providers, dryRun, force }), (result) => (result ? [result] : []))
    : null;
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
