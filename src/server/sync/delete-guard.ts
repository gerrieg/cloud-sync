import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DeleteApprovalDto, DeleteApprovalItemDto } from '../../shared/delete-guard.js';
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
 * Persists a halted deletion batch. Re-planning the very same batch (e.g. a repeated run before
 * the admin decided) returns the pending record instead of queueing a second one.
 */
export function queueDeletions(
  db: AppDatabase,
  input: {
    readonly profileId: string;
    readonly ruleId: string;
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
        eq(pendingDeleteApprovals.ruleId, input.ruleId),
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

export function toApprovalDto(row: ApprovalRow): DeleteApprovalDto {
  return {
    id: row.id,
    ruleId: row.ruleId,
    status: row.status,
    createdAt: row.createdAt,
    items: approvalItems(row).map(({ uid, summary, target }) => ({ uid, summary, target })),
  };
}
