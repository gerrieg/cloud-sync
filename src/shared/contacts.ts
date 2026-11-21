/** Contact-sync contracts shared by the server API and the React client. */
import type { SyncDirection } from './calendar.js';

/** The `appleGroupUid` of a rule that covers the whole address book ("All Contacts"). */
export const ALL_CONTACTS_GROUP = 'all';

export interface AppleContactGroupDto {
  /** Group UID, or `all` for "All Contacts". */
  readonly uid: string;
  readonly name: string;
}

export interface GoogleContactGroupDto {
  /** e.g. `contactGroups/6c2d3a`. */
  readonly resourceName: string;
  readonly name: string;
}

/** Response of `GET /api/profiles/:id/discover/contact-groups`. */
export interface ContactGroupDiscovery {
  readonly apple: readonly AppleContactGroupDto[];
  readonly google: readonly GoogleContactGroupDto[];
}

export interface ContactRuleDto {
  readonly id: string;
  readonly appleGroupUid: string;
  readonly appleGroupName: string;
  readonly googleGroupResourceName: string;
  readonly googleGroupName: string;
  readonly direction: SyncDirection;
  readonly enabled: boolean;
}

/** Body of `POST /api/profiles/:id/rules/contacts`. */
export interface ContactRuleCreate {
  readonly appleGroupUid: string;
  readonly googleGroupResourceName: string;
  readonly direction?: SyncDirection;
  readonly enabled?: boolean;
}

/** Body of `PATCH /api/profiles/:id/rules/contacts/:ruleId`. */
export type ContactRuleUpdate = Partial<Pick<ContactRuleCreate, 'direction' | 'enabled'>>;

export interface PlannedContactAction {
  readonly action: 'create' | 'update' | 'delete' | 'skip';
  /** The Apple contact UID (for contacts that only exist in Google: the UID given to the new card). */
  readonly uid: string;
  readonly summary: string;
  /** Why a contact is skipped or how a conflict was settled: `unchanged`, `matched_existing`, `apple_master`, `delete_guard`, … */
  readonly reason?: string;
  /** Set when the change is written to Apple instead of Google (bidirectional rules only). */
  readonly direction?: 'google_to_apple';
}

/** Outcome of the profile-wide contact sync of one run. */
export interface ContactRunResult {
  /** `skipped` means nothing was processed (see `reason`: `paused` or `unchanged`). */
  readonly status: 'ok' | 'skipped' | 'error';
  readonly reason?: string;
  readonly error?: string;
  /** Set when the Delete Guard halted this run's deletions and queued them for approval. */
  readonly deleteApprovalId?: string;
  readonly actions: readonly PlannedContactAction[];
}
