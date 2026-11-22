import crypto from 'node:crypto';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { LogEntityType, SyncLogQuery } from '../../shared/logs.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { syncLogs } from '../db/schema.js';

export type SyncLogRow = typeof syncLogs.$inferSelect;

/** What a sync run reports about one item it handled. */
export interface LoggedItem {
  readonly action: string;
  readonly uid: string;
  readonly summary: string;
  readonly reason?: string;
}

const DEFAULT_LIMIT = 200;
export const MAX_LOG_LIMIT = 1000;

/** Writes the sync log of one run of one kind of data (calendar, contacts or mail) of one Profile. */
export class SyncLog {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly profileId: string,
    private readonly entityType: LogEntityType,
  ) {}

  /**
   * A change was carried over: logs it and closes the open errors of the item. A skip carries
   * nothing over (it may be a held-back deletion or unreadable data), so it logs and closes nothing.
   */
  applied(ruleId: string | null, item: LoggedItem): void {
    if (item.action === 'skip') {
      return;
    }
    this.db
      .insert(syncLogs)
      .values({
        id: crypto.randomUUID(),
        profileId: this.profileId,
        ruleId,
        entityType: this.entityType,
        level: 'info',
        action: item.action,
        itemKey: item.uid,
        summary: item.summary,
        message: item.reason ?? '',
        createdAt: this.clock.now(),
      })
      .run();
    // Calendar events are tracked per rule, so another rule's success says nothing about this one;
    // contacts and mails are one record per Profile, whichever rule carried them
    const sameRule = this.entityType === 'calendar' && ruleId !== null ? eq(syncLogs.ruleId, ruleId) : undefined;
    this.resolve(and(eq(syncLogs.itemKey, item.uid), sameRule));
  }

  /** One item failed. A failure that is still open for the item is updated instead of repeated. */
  failed(ruleId: string | null, item: Pick<LoggedItem, 'action' | 'uid' | 'summary'>, error: unknown): void {
    this.recordError(ruleId, item.uid, item.action, item.summary, errorMessage(error));
  }

  /** A whole rule (or, without a rule, the whole run) failed before any item could be handled. */
  runFailed(ruleId: string | null, summary: string, error: unknown): void {
    this.recordError(ruleId, null, null, summary, errorMessage(error));
  }

  /** A rule (or run) got through planning again: closes the open errors that concerned all of it. */
  runRecovered(ruleId: string | null): void {
    this.resolve(
      and(isNull(syncLogs.itemKey), ruleId === null ? isNull(syncLogs.ruleId) : eq(syncLogs.ruleId, ruleId)),
    );
  }

  private recordError(ruleId: string | null, itemKey: string | null, action: string | null, summary: string, message: string): void {
    const now = this.clock.now();
    const open = this.db
      .select({ id: syncLogs.id })
      .from(syncLogs)
      .where(
        and(
          eq(syncLogs.profileId, this.profileId),
          eq(syncLogs.entityType, this.entityType),
          eq(syncLogs.level, 'error'),
          isNull(syncLogs.resolvedAt),
          ruleId === null ? isNull(syncLogs.ruleId) : eq(syncLogs.ruleId, ruleId),
          itemKey === null ? isNull(syncLogs.itemKey) : eq(syncLogs.itemKey, itemKey),
        ),
      )
      .get();
    if (open) {
      this.db.update(syncLogs).set({ action, summary, message, createdAt: now }).where(eq(syncLogs.id, open.id)).run();
      return;
    }
    this.db
      .insert(syncLogs)
      .values({
        id: crypto.randomUUID(),
        profileId: this.profileId,
        ruleId,
        entityType: this.entityType,
        level: 'error',
        action,
        itemKey,
        summary,
        message,
        createdAt: now,
      })
      .run();
  }

  private resolve(scope: SQL | undefined): void {
    this.db
      .update(syncLogs)
      .set({ resolvedAt: this.clock.now() })
      .where(
        and(
          eq(syncLogs.profileId, this.profileId),
          eq(syncLogs.entityType, this.entityType),
          eq(syncLogs.level, 'error'),
          isNull(syncLogs.resolvedAt),
          scope,
        ),
      )
      .run();
  }
}

/** The text of an error for the log and for the result of a run; an empty message counts as none. */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Sync failed';
}

export function listSyncLogs(db: AppDatabase, query: SyncLogQuery): SyncLogRow[] {
  const conditions = [
    query.profileId !== undefined ? eq(syncLogs.profileId, query.profileId) : undefined,
    query.entityType !== undefined ? eq(syncLogs.entityType, query.entityType) : undefined,
    query.level !== undefined ? eq(syncLogs.level, query.level) : undefined,
    query.unresolvedOnly ? and(eq(syncLogs.level, 'error'), isNull(syncLogs.resolvedAt)) : undefined,
  ];
  return db
    .select()
    .from(syncLogs)
    .where(and(...conditions))
    .orderBy(desc(syncLogs.createdAt), sql`rowid DESC`)
    .limit(Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LOG_LIMIT))
    .all();
}

/** The number of open errors per Profile. */
export function countOpenErrors(db: AppDatabase): Map<string, number> {
  const rows = db
    .select({ profileId: syncLogs.profileId, count: sql<number>`count(*)` })
    .from(syncLogs)
    .where(and(eq(syncLogs.level, 'error'), isNull(syncLogs.resolvedAt)))
    .groupBy(syncLogs.profileId)
    .all();
  return new Map(rows.map((row) => [row.profileId, row.count]));
}

/** A deleted rule can no longer be retried: its open errors go with it (its info lines stay as history). */
export function dropOpenErrors(db: AppDatabase, ruleId: string): void {
  db.delete(syncLogs)
    .where(and(eq(syncLogs.ruleId, ruleId), eq(syncLogs.level, 'error'), isNull(syncLogs.resolvedAt)))
    .run();
}
