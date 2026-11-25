/** Mail-sync contracts shared by the server API and the React client. */

/** The special use of an IMAP folder, as far as the sync cares about it. */
export type MailFolderUse = 'inbox' | 'sent' | 'drafts' | 'junk' | 'trash' | null;

export interface AppleMailFolderDto {
  /** Full IMAP path, e.g. `INBOX` or `Receipts/2026`. */
  readonly path: string;
  readonly name: string;
  /** The Gmail label the folder's messages get: `INBOX`, `SENT` or a custom label. */
  readonly googleLabel: string;
}

/** Response of `GET /api/profiles/:id/discover/mail-folders`. */
export interface MailFolderDiscovery {
  readonly folders: readonly AppleMailFolderDto[];
}

export interface MailRuleDto {
  readonly id: string;
  readonly appleFolderPath: string;
  readonly appleFolderName: string;
  readonly googleLabel: string;
  /** Days of history to import; null means everything. */
  readonly syncWindowDays: number | null;
  readonly enabled: boolean;
}

/** Body of `POST /api/profiles/:id/rules/mail`. */
export interface MailRuleCreate {
  readonly appleFolderPath: string;
  readonly syncWindowDays?: number | null;
  readonly enabled?: boolean;
}

/** Body of `PATCH /api/profiles/:id/rules/mail/:ruleId`. */
export type MailRuleUpdate = Partial<Omit<MailRuleCreate, 'appleFolderPath'>>;

/** Everything a Sync Rule changes about one message, as shown in a run report. */
export interface PlannedMailAction {
  /** `create` imports a message, `update` changes labels or flags, `delete` moves it to the Gmail Trash. */
  readonly action: 'create' | 'update' | 'delete' | 'skip';
  /** The profile-wide message key (normalized Message-ID or the fallback hash). */
  readonly uid: string;
  readonly summary: string;
  /** Why: `moved`, `flags_changed`, `force_resync`, `moved_to_trash`, `restored_from_trash`, `expunged`, `reindexed`, `uidvalidity_changed`, `unchanged`, `no_longer_synced`, `delete_guard`. */
  readonly reason?: string;
}

/** Outcome of the profile-wide mail sync of one run. */
export interface MailRunResult {
  /** `skipped` means nothing was processed (see `reason`: `paused`). */
  readonly status: 'ok' | 'skipped' | 'error';
  readonly reason?: string;
  readonly error?: string;
  /** Set when the Delete Guard halted this run's deletions and queued them for approval. */
  readonly deleteApprovalId?: string;
  readonly actions: readonly PlannedMailAction[];
}

/** Gmail system labels the sync maps iCloud state onto. */
const GMAIL_INBOX = 'INBOX';
const GMAIL_SENT = 'SENT';
export const GMAIL_UNREAD = 'UNREAD';
export const GMAIL_STARRED = 'STARRED';

/** Which Gmail label the messages of an iCloud folder get. */
export function resolveGoogleLabel(folder: { readonly path: string; readonly name: string; readonly use: MailFolderUse }): string {
  if (folder.use === 'inbox' || folder.path.toUpperCase() === 'INBOX') {
    return GMAIL_INBOX;
  }
  if (folder.use === 'sent' || folder.name === 'Sent Messages') {
    return GMAIL_SENT;
  }
  return folder.name;
}
