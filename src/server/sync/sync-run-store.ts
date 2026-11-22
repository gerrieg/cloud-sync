import crypto from 'node:crypto';
import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { DomainOverviewDto, OverviewDomain, RunSummaryDto } from '../../shared/profile.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import {
  calendarSyncRules,
  contactSyncRules,
  mailSyncRules,
  syncedContacts,
  syncedEmails,
  syncedEvents,
  syncRuns,
} from '../db/schema.js';

export const OVERVIEW_DOMAINS: readonly OverviewDomain[] = ['calendars', 'contacts', 'mail'];

const DAY_MS = 86_400_000;
const RUN_RETENTION_DAYS = 7;

/** What a run did, as far as the Overview shows it. */
export interface RunOutcome {
  readonly status: 'ok' | 'skipped' | 'error';
  readonly actions: readonly { readonly action: string }[];
}

/** Counts the changes a run carried over; null when nothing was processed at all (no rule, or all paused). */
export function summarizeOutcomes(outcomes: readonly (RunOutcome & { readonly reason?: string })[]): RunOutcome | null {
  const processed = outcomes.filter((o) => !(o.status === 'skipped' && o.reason === 'paused'));
  if (processed.length === 0) {
    return null;
  }
  return {
    status: processed.some((o) => o.status === 'error') ? 'error' : processed.every((o) => o.status === 'skipped') ? 'skipped' : 'ok',
    actions: processed.flatMap((o) => o.actions),
  };
}

export function recordRun(
  db: AppDatabase,
  profileId: string,
  domain: OverviewDomain,
  startedAt: number,
  durationMs: number,
  outcome: RunOutcome,
): void {
  const counted = (action: string) => outcome.actions.filter((a) => a.action === action).length;
  db.insert(syncRuns)
    .values({
      id: crypto.randomUUID(),
      profileId,
      domain,
      startedAt,
      durationMs,
      status: outcome.status,
      created: counted('create'),
      updated: counted('update'),
      deleted: counted('delete'),
    })
    .run();
}

export function pruneSyncRuns(db: AppDatabase, clock: Clock): void {
  db.delete(syncRuns)
    .where(lt(syncRuns.startedAt, clock.now() - RUN_RETENTION_DAYS * DAY_MS))
    .run();
}

// A run in progress exists only in memory: a restart ends it
const running = new Map<string, number>();
const runningKey = (profileId: string, domain: OverviewDomain) => `${profileId}:${domain}`;

/** Marks a run as in progress; call the returned function when it ends. */
export function markRunning(profileId: string, domain: OverviewDomain): () => void {
  const key = runningKey(profileId, domain);
  running.set(key, (running.get(key) ?? 0) + 1);
  return () => {
    const left = (running.get(key) ?? 1) - 1;
    if (left > 0) {
      running.set(key, left);
    } else {
      running.delete(key);
    }
  };
}

function ruleSummary(rules: readonly { enabled: boolean; direction?: 'one_way' | 'bidirectional' }[]) {
  const enabled = rules.filter((rule) => rule.enabled);
  // Mail rules have no direction: iCloud → Gmail only
  const directions = new Set(enabled.map((rule) => rule.direction ?? 'one_way'));
  return {
    rulesEnabled: enabled.length,
    rulesTotal: rules.length,
    direction: (directions.size === 0 ? null : directions.size === 2 ? 'mixed' : [...directions][0]) as DomainOverviewDto['direction'],
  };
}

function trackedCount(db: AppDatabase, profileId: string, domain: OverviewDomain): number {
  const [row] =
    domain === 'calendars'
      ? db
          .select({ n: count() })
          .from(syncedEvents)
          .innerJoin(calendarSyncRules, eq(syncedEvents.ruleId, calendarSyncRules.id))
          .where(eq(calendarSyncRules.profileId, profileId))
          .all()
      : domain === 'contacts'
        ? db.select({ n: count() }).from(syncedContacts).where(eq(syncedContacts.profileId, profileId)).all()
        : db.select({ n: count() }).from(syncedEmails).where(eq(syncedEmails.profileId, profileId)).all();
  return row?.n ?? 0;
}

/** Rules, linked items, the latest run and the last 24 hours of each kind of data of a Profile. */
export function domainOverviews(db: AppDatabase, clock: Clock, profileId: string): DomainOverviewDto[] {
  const since = clock.now() - DAY_MS;
  return OVERVIEW_DOMAINS.map((domain) => {
    const rules =
      domain === 'calendars'
        ? db.select().from(calendarSyncRules).where(eq(calendarSyncRules.profileId, profileId)).all()
        : domain === 'contacts'
          ? db.select().from(contactSyncRules).where(eq(contactSyncRules.profileId, profileId)).all()
          : db.select().from(mailSyncRules).where(eq(mailSyncRules.profileId, profileId)).all();
    const latest = db
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.profileId, profileId), eq(syncRuns.domain, domain)))
      .orderBy(desc(syncRuns.startedAt), sql`rowid desc`)
      .limit(1)
      .get();
    const lastRun: RunSummaryDto | null = latest
      ? {
          at: latest.startedAt,
          durationMs: latest.durationMs,
          status: latest.status,
          created: latest.created,
          updated: latest.updated,
          deleted: latest.deleted,
        }
      : null;
    const totals = db
      .select({
        runs: count(),
        failedRuns: sql<number>`coalesce(sum(${syncRuns.status} = 'error'), 0)`,
        created: sql<number>`coalesce(sum(${syncRuns.created}), 0)`,
        updated: sql<number>`coalesce(sum(${syncRuns.updated}), 0)`,
        deleted: sql<number>`coalesce(sum(${syncRuns.deleted}), 0)`,
      })
      .from(syncRuns)
      .where(and(eq(syncRuns.profileId, profileId), eq(syncRuns.domain, domain), gte(syncRuns.startedAt, since)))
      .get();
    return {
      domain,
      ...ruleSummary(rules),
      tracked: trackedCount(db, profileId, domain),
      running: running.has(runningKey(profileId, domain)),
      lastRun,
      last24h: {
        runs: totals?.runs ?? 0,
        failedRuns: totals?.failedRuns ?? 0,
        created: totals?.created ?? 0,
        updated: totals?.updated ?? 0,
        deleted: totals?.deleted ?? 0,
      },
    };
  });
}
