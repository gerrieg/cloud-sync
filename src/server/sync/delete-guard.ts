import crypto from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DeleteApprovalItemDto } from '../../shared/delete-guard.js';
import type { AppDatabase } from '../db/index.js';
import { pendingDeleteApprovals } from '../db/schema.js';

/** A run that plans more deletions than this, or a larger share of the tracked items, is halted. */
const DELETE_GUARD_MAX_ITEMS = 10;
const DELETE_GUARD_MAX_SHARE = 0.2;

/** What every guarded deletion must tell the admin; domains add whatever they need to execute it. */
export interface GuardedDeletion extends DeleteApprovalItemDto {}

export type ApprovalRow = typeof pendingDeleteApprovals.$inferSelect;

export function exceedsDeleteGuard(plannedDeletions: number, trackedItems: number): boolean {
  return (
    plannedDeletions > DELETE_GUARD_MAX_ITEMS ||
    (trackedItems > 0 && plannedDeletions / trackedItems > DELETE_GUARD_MAX_SHARE)
  );
}

/**
 * Delete Guard for one run: when the planned deletions exceed the threshold, they are replaced in
 * the plan by `held(entry, deletion)` (reported as skipped) and returned as one batch to be queued
 * for the admin's approval. Below the threshold the plan is returned untouched.
 */
export function holdBackDeletions<D extends GuardedDeletion, E extends { readonly deletion?: D }>(
  entries: E[],
  trackedItems: number,
  held: (entry: E, deletion: D) => E,
): { entries: E[]; batch: D[] } {
  const batch = entries.flatMap((entry) => (entry.deletion ? [entry.deletion] : []));
  if (!exceedsDeleteGuard(batch.length, trackedItems)) {
    return { entries, batch: [] };
  }
  return { entries: entries.map((entry) => (entry.deletion ? held(entry, entry.deletion) : entry)), batch };
}

/**
 * Persists a halted deletion batch. Re-planning the very same batch (e.g. a repeated run before
 * the admin decided) returns the pending record instead of queueing a second one.
 */
export function queueDeletions(
  db: AppDatabase,
  input: {
    readonly profileId: string;
    readonly domain: 'calendar' | 'contacts' | 'mail';
    /** The Sync Rule of a calendar batch; null for the profile-wide contact and mail syncs. */
    readonly ruleId: string | null;
    readonly items: readonly GuardedDeletion[];
    readonly now: number;
  },
): ApprovalRow {
  const items = JSON.stringify(input.items);
  const existing = db
    .select()
    .from(pendingDeleteApprovals)
    .where(
      and(
        eq(pendingDeleteApprovals.profileId, input.profileId),
        eq(pendingDeleteApprovals.domain, input.domain),
        input.ruleId === null ? isNull(pendingDeleteApprovals.ruleId) : eq(pendingDeleteApprovals.ruleId, input.ruleId),
        eq(pendingDeleteApprovals.status, 'pending'),
        eq(pendingDeleteApprovals.items, items),
      ),
    )
    .get();
  if (existing) {
    return existing;
  }
  return db
    .insert(pendingDeleteApprovals)
    .values({
      id: crypto.randomUUID(),
      profileId: input.profileId,
      domain: input.domain,
      ruleId: input.ruleId,
      items,
      createdAt: input.now,
    })
    .returning()
    .get();
}

export function listPendingApprovals(db: AppDatabase, profileId: string): ApprovalRow[] {
  return db
    .select()
    .from(pendingDeleteApprovals)
    .where(and(eq(pendingDeleteApprovals.profileId, profileId), eq(pendingDeleteApprovals.status, 'pending')))
    .orderBy(desc(pendingDeleteApprovals.createdAt))
    .all();
}

export function findApproval(db: AppDatabase, id: string): ApprovalRow | undefined {
  return db.select().from(pendingDeleteApprovals).where(eq(pendingDeleteApprovals.id, id)).get();
}

/** Closes a pending approval; returns undefined when it was not pending (anymore). */
export function resolveApproval(
  db: AppDatabase,
  id: string,
  status: 'approved' | 'dismissed',
  now: number,
): ApprovalRow | undefined {
  return db
    .update(pendingDeleteApprovals)
    .set({ status, resolvedAt: now })
    .where(and(eq(pendingDeleteApprovals.id, id), eq(pendingDeleteApprovals.status, 'pending')))
    .returning()
    .get();
}

/** The full batch as recorded when the run was halted. */
export function approvalItems<T extends GuardedDeletion>(row: ApprovalRow): T[] {
  return JSON.parse(row.items) as T[];
}
