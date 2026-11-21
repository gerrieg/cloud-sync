/** Delete Guard contracts shared by the server API and the React client. */

export type DeleteApprovalStatus = 'pending' | 'approved' | 'dismissed';

export type DeleteApprovalDomain = 'calendar' | 'contacts';

export interface DeleteApprovalItemDto {
  readonly uid: string;
  /** Display name of the item that would be deleted. */
  readonly summary: string;
  /** The side the item would be deleted from. */
  readonly target: 'apple' | 'google';
}

/** A batch of deletions a sync run halted instead of executing. */
export interface DeleteApprovalDto {
  readonly id: string;
  readonly domain: DeleteApprovalDomain;
  /** The calendar Sync Rule whose run planned the deletions; null for contacts (profile-wide). */
  readonly ruleId: string | null;
  /** What the batch belongs to, for display: `Privat → Anna` for a calendar rule, `Contacts`. */
  readonly label: string;
  readonly status: DeleteApprovalStatus;
  readonly createdAt: number;
  readonly items: readonly DeleteApprovalItemDto[];
}
