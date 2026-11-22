import type { LogEntityType } from '../../shared/logs.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { GoogleAuthError } from '../providers/types.js';
import { holdBackDeletions, queueDeletions, type GuardedDeletion } from './delete-guard.js';
import { errorMessage, SyncLog, type LoggedItem } from './sync-log-store.js';

/** One planned change: what it is, and (unless it is a no-op) how to carry it out. */
export interface PlanEntryOf<Report extends LoggedItem, Deletion extends GuardedDeletion> {
  readonly report: Report;
  readonly apply?: () => Promise<void>;
  /** Set on deletions, which the Delete Guard may hold back for approval. */
  readonly deletion?: Deletion;
}

/** The part of a run result that is the same for every kind of data. */
export interface PlanOutcome<Report> {
  readonly status: 'ok' | 'error';
  readonly error?: string;
  /** Set when the Delete Guard halted this run's deletions and queued them for approval. */
  readonly deleteApprovalId?: string;
  readonly actions: Report[];
}

/**
 * A run (or one rule of it) failed as a whole: Google auth errors go to the caller, who must ask
 * for a re-authorization; anything else is logged (not on a dry run) and becomes the error text of
 * the run's result.
 */
export function failedRun(
  failure: {
    readonly log: SyncLog;
    readonly dryRun: boolean;
    /** The rule that failed; null when the whole profile-wide run did. */
    readonly ruleId: string | null;
    readonly summary: string;
  },
  error: unknown,
): string {
  if (error instanceof GoogleAuthError) {
    throw error;
  }
  if (!failure.dryRun) {
    failure.log.runFailed(failure.ruleId, failure.summary, error);
  }
  return errorMessage(error);
}

/**
 * Runs a profile-wide sync (contacts, mail); when it fails as a whole, the failure is logged under
 * `entityType` and becomes the error result.
 */
export async function runProfileWide<Result>(
  run: {
    readonly db: AppDatabase;
    readonly clock: Clock;
    readonly profileId: string;
    readonly dryRun: boolean;
    readonly entityType: LogEntityType;
    readonly summary: string;
  },
  work: () => Promise<Result>,
): Promise<Result | { readonly status: 'error'; readonly error: string; readonly actions: [] }> {
  try {
    return await work();
  } catch (error) {
    const log = new SyncLog(run.db, run.clock, run.profileId, run.entityType);
    const message = failedRun({ log, dryRun: run.dryRun, ruleId: null, summary: run.summary }, error);
    return { status: 'error', error: message, actions: [] };
  }
}

/** A deletion the Delete Guard holds back is reported as skipped (the profile-wide syncs' `held`). */
export function heldAsSkipped(
  _entry: unknown,
  deletion: GuardedDeletion,
): { readonly report: { readonly action: 'skip'; readonly uid: string; readonly summary: string; readonly reason: 'delete_guard' } } {
  return { report: { action: 'skip', uid: deletion.uid, summary: deletion.summary, reason: 'delete_guard' } };
}

/** Runs `work`, ignoring only the error that says the thing to change is already gone. */
export async function ignoringNotFound(notFound: abstract new (...args: never[]) => Error, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof notFound)) {
      throw error;
    }
  }
}

/**
 * Carries out one planned run of one kind of data: the Delete Guard holds back mass deletions
 * (queued for approval), the rest is applied entry by entry and logged. One entry that cannot be
 * carried over must not hold up all the others, and a run with a failed entry keeps its cursor, so
 * `commit` (which advances it) only runs after a fully successful run. A dry run only reports.
 */
export async function carryOutPlan<Entry extends PlanEntryOf<LoggedItem, GuardedDeletion>>(run: {
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly profileId: string;
  readonly log: SyncLog;
  readonly dryRun: boolean;
  readonly entries: Entry[];
  /** How many items the plan's deletions are measured against (the Delete Guard's share threshold). */
  readonly trackedItems: number;
  /** Replaces a deletion the guard holds back; it is reported as skipped. */
  readonly held: (entry: Entry, deletion: NonNullable<Entry['deletion']>) => Entry;
  readonly domain: 'calendar' | 'contacts' | 'mail';
  /** The Sync Rule of a calendar batch; null for the profile-wide contact and mail syncs. */
  readonly approvalRuleId: string | null;
  /** The rules (null: the run itself) whose open run-wide errors this run got past planning for. */
  readonly recovered: readonly (string | null)[];
  /** The rule a reported item is logged under. */
  readonly logRuleId: (entry: Entry) => string | null;
  /** Advances the cursor; only called when every entry was carried over. */
  readonly commit: () => void;
}): Promise<PlanOutcome<Entry['report']>> {
  const guarded = holdBackDeletions(run.entries, run.trackedItems, run.held);
  if (run.dryRun) {
    return { status: 'ok', actions: guarded.entries.map((entry) => entry.report) };
  }
  for (const ruleId of run.recovered) {
    run.log.runRecovered(ruleId);
  }
  const deleteApprovalId =
    guarded.batch.length > 0
      ? queueDeletions(run.db, {
          profileId: run.profileId,
          domain: run.domain,
          ruleId: run.approvalRuleId,
          items: guarded.batch,
          now: run.clock.now(),
        }).id
      : undefined;
  const withApproval = deleteApprovalId ? { deleteApprovalId } : {};

  const applied: Entry['report'][] = [];
  let failure: string | null = null;
  for (const entry of guarded.entries) {
    try {
      await entry.apply?.();
      applied.push(entry.report);
      run.log.applied(run.logRuleId(entry), entry.report);
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        throw error;
      }
      failure ??= errorMessage(error);
      run.log.failed(run.logRuleId(entry), entry.report, error);
    }
  }
  if (failure !== null) {
    return { status: 'error', error: failure, ...withApproval, actions: applied };
  }
  run.commit();
  return { status: 'ok', ...withApproval, actions: applied };
}
