import type { DeleteApprovalDomain, DeleteApprovalDto } from '../../shared/delete-guard.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { GoogleAuthError, type SyncProviders } from '../providers/types.js';
import { executeCalendarDeletion, type CalendarDeletion } from './calendar-sync.js';
import { executeContactDeletion, type ContactDeletion } from './contact-sync.js';
import {
  approvalItems,
  findApproval,
  listPendingApprovals,
  resolveApproval,
  type ApprovalRow,
} from './delete-guard.js';
import { executeMailDeletion, type MailDeletion } from './mail-sync.js';
import { findRule } from './rules-store.js';

/**
 * What the admin can do with a deletion batch the Delete Guard halted: see it, approve it (the
 * recorded batch is executed, nothing is re-planned) or dismiss it. What each kind of data needs to
 * execute and to label a batch is known here and nowhere else.
 */
interface BatchKind {
  /** What the batch belongs to, for display. */
  label(db: AppDatabase, row: ApprovalRow): string;
  /** Executes the batch; false when it can no longer be executed (its rule is gone). */
  execute(env: { readonly db: AppDatabase; readonly providers: SyncProviders }, row: ApprovalRow): Promise<boolean>;
}

const kinds: Record<DeleteApprovalDomain, BatchKind> = {
  calendar: {
    label(db, row) {
      const rule = row.ruleId ? findRule(db, row.profileId, row.ruleId) : undefined;
      return rule ? `${rule.appleCalendarName} → ${rule.googleCalendarName}` : 'Calendar';
    },
    async execute({ db, providers }, row) {
      const rule = row.ruleId ? findRule(db, row.profileId, row.ruleId) : undefined;
      if (!rule) {
        return false;
      }
      for (const item of approvalItems<CalendarDeletion>(row)) {
        await executeCalendarDeletion({ db, providers, rule }, item);
      }
      return true;
    },
  },
  contacts: {
    label: () => 'Contacts',
    async execute(env, row) {
      for (const item of approvalItems<ContactDeletion>(row)) {
        await executeContactDeletion(env, item);
      }
      return true;
    },
  },
  mail: {
    label: () => 'Mail',
    async execute(env, row) {
      for (const item of approvalItems<MailDeletion>(row)) {
        await executeMailDeletion(env, item);
      }
      return true;
    },
  },
};

export function toApprovalDto(db: AppDatabase, row: ApprovalRow): DeleteApprovalDto {
  return {
    id: row.id,
    domain: row.domain,
    ruleId: row.ruleId,
    label: kinds[row.domain].label(db, row),
    status: row.status,
    createdAt: row.createdAt,
    items: approvalItems(row).map(({ uid, summary, target }) => ({ uid, summary, target })),
  };
}

/** The batches of a Profile that wait for the admin's decision, newest first. */
export function listPendingBatches(db: AppDatabase, profileId: string): DeleteApprovalDto[] {
  return listPendingApprovals(db, profileId).map((row) => toApprovalDto(db, row));
}

export type ApproveResult =
  | { readonly status: 'approved'; readonly approval: DeleteApprovalDto }
  /** Decided already, or no longer executable. */
  | { readonly status: 'not_pending' }
  /** Executing failed; the batch stays pending, items already done are skipped quietly on a retry. */
  | { readonly status: 'failed' };

/** Executes the recorded batch and closes it. A Google auth error is the caller's to handle. */
export async function approveBatch(
  env: { readonly db: AppDatabase; readonly clock: Clock; readonly providers: SyncProviders },
  approvalId: string,
): Promise<ApproveResult> {
  const { db, clock, providers } = env;
  const approval = findApproval(db, approvalId);
  if (!approval || approval.status !== 'pending') {
    return { status: 'not_pending' };
  }
  try {
    if (!(await kinds[approval.domain].execute({ db, providers }, approval))) {
      return { status: 'not_pending' };
    }
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      throw error;
    }
    return { status: 'failed' };
  }
  const resolved = resolveApproval(db, approval.id, 'approved', clock.now());
  return { status: 'approved', approval: toApprovalDto(db, resolved ?? approval) };
}

/** Closes the batch without executing it; undefined when it was not pending (anymore). */
export function dismissBatch(db: AppDatabase, clock: Clock, approvalId: string): DeleteApprovalDto | undefined {
  const resolved = resolveApproval(db, approvalId, 'dismissed', clock.now());
  return resolved ? toApprovalDto(db, resolved) : undefined;
}
