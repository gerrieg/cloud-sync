/** Mail-specific shapes exchanged through the SyncProviders seam. */
import type { MailFolderUse } from '../../shared/mail.js';

export interface AppleMailFolder {
  /** Full IMAP path, used to select the folder. */
  readonly path: string;
  /** Display name with `/` between the levels of nested folders. */
  readonly name: string;
  readonly use: MailFolderUse;
  /** False for folders that only hold other folders (`\Noselect`). */
  readonly selectable: boolean;
}

/** The cheap per-message facts of a folder listing; no headers, no body. */
export interface AppleMailMessage {
  readonly uid: number;
  readonly seen: boolean;
  readonly flagged: boolean;
  /** RFC 822 size in bytes. */
  readonly size: number;
  /** IMAP INTERNALDATE in epoch milliseconds. */
  readonly internalDate: number;
}

export interface AppleMailListing {
  /** Changes whenever the server renumbers the folder; UIDs of an older validity mean nothing. */
  readonly uidValidity: number;
  readonly messages: readonly AppleMailMessage[];
}

/** The header values a message is identified by. */
export interface AppleMailEnvelope {
  readonly uid: number;
  readonly messageId: string | null;
  readonly date: string | null;
  readonly from: string;
  readonly subject: string;
}

export interface GoogleMailLabel {
  /** Gmail label id; the system labels (`INBOX`, `SENT`, `UNREAD`, `STARRED`) have their name as id. */
  readonly id: string;
  readonly name: string;
}

export interface GoogleMailImport {
  readonly raw: Buffer;
  readonly labelIds: readonly string[];
}

export interface GoogleMailModify {
  readonly addLabelIds: readonly string[];
  readonly removeLabelIds: readonly string[];
}

export class AppleMailFolderNotFoundError extends Error {
  constructor(path: string) {
    super(`The Apple mail folder "${path}" no longer exists`);
    this.name = 'AppleMailFolderNotFoundError';
  }
}

export class GoogleMessageNotFoundError extends Error {
  constructor(id: string) {
    super(`Gmail message ${id} not found`);
    this.name = 'GoogleMessageNotFoundError';
  }
}
