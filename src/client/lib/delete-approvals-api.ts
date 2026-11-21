import type { DeleteApprovalDto } from '../../shared/delete-guard.js';
import { apiRequest } from './http.js';

export type { DeleteApprovalDto };

export function listDeleteApprovals(profileId: string): Promise<DeleteApprovalDto[]> {
  return apiRequest(`/api/profiles/${encodeURIComponent(profileId)}/delete-approvals`);
}

/** Executes the halted deletion batch exactly as it was recorded. */
export function approveDeletions(approvalId: string): Promise<DeleteApprovalDto> {
  return apiRequest(`/api/delete-approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST' });
}

/** Drops the halted deletion batch without deleting anything. */
export function dismissDeletions(approvalId: string): Promise<DeleteApprovalDto> {
  return apiRequest(`/api/delete-approvals/${encodeURIComponent(approvalId)}/dismiss`, { method: 'POST' });
}
