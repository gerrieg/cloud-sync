import {
  AppleMailFolderNotFoundError,
  GoogleMessageNotFoundError,
  type AppleMailEnvelope,
  type GoogleMailLabel,
  type InboxIdleHandlers,
} from '../../src/server/providers/mail-types.js';
import { GoogleAuthError, type SyncProviders } from '../../src/server/providers/types.js';
import type { MailFolderUse } from '../../src/shared/mail.js';

export interface GoogleMailLog {
  readonly kind: 'import' | 'modify' | 'trash' | 'untrash' | 'delete' | 'createLabel';
  readonly id: string;
}

interface AppleMessage {
  raw: Buffer;
  seen: boolean;
  flagged: boolean;
  internalDate: number;
}

interface AppleFolder {
  use: MailFolderUse;
  selectable: boolean;
  uidValidity: number;
  nextUid: number;
  messages: Map<number, AppleMessage>;
}

interface GmailMessage {
  raw: Buffer;
  labelIds: Set<string>;
}

interface GmailAccount {
  labels: Map<string, string>;
  messages: Map<string, GmailMessage>;
}

interface IdleSession {
  readonly handlers: InboxIdleHandlers;
  open: boolean;
}

const SYSTEM_LABELS = ['INBOX', 'SENT', 'UNREAD', 'STARRED', 'TRASH'];

function header(raw: Buffer, name: string): string | null {
  const head = raw.toString('utf8').split(/\r?\n\r?\n/, 1)[0] ?? '';
  const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

/** Stateful in-memory iCloud IMAP + Gmail, keyed by Apple ID / refresh token. */
export class FakeMailWorld {
  readonly googleWrites: GoogleMailLog[] = [];
  /** Every envelope the app asked for, to see that known messages are not read again. */
  readonly envelopeFetches: { path: string; uid: number }[] = [];
  readonly rawFetches: { path: string; uid: number }[] = [];

  /** Every `STATUS` request, in order, so tests can see which folders were polled. */
  readonly statusRequests: string[][] = [];
  /** Highest number of IDLE connections that were open at the same time, per Apple ID. */
  private readonly peakIdle = new Map<string, number>();

  private readonly dropOnOpen = new Set<string>();
  private readonly idleAttempts = new Map<string, number>();
  private readonly idleSessions = new Map<string, IdleSession[]>();
  private readonly idleConnectFailures = new Map<string, number>();
  private readonly apple = new Map<string, Map<string, AppleFolder>>();
  private readonly google = new Map<string, GmailAccount>();
  private counter = 0;
  private importFailures: { match: string; error: Error }[] = [];

  // ---- Apple IMAP --------------------------------------------------------------------------

  addAppleFolder(appleId: string, path: string, use: MailFolderUse = null, selectable = true): void {
    this.folders(appleId).set(path, { use, selectable, uidValidity: 1000, nextUid: 1, messages: new Map() });
  }

  removeAppleFolder(appleId: string, path: string): void {
    this.folders(appleId).delete(path);
  }

  /** Delivers a message and returns its UID. */
  deliver(
    appleId: string,
    path: string,
    message: { raw: string; seen?: boolean; flagged?: boolean; internalDate?: number },
  ): number {
    const folder = this.folder(appleId, path);
    const uid = folder.nextUid++;
    folder.messages.set(uid, {
      raw: Buffer.from(message.raw),
      seen: message.seen ?? false,
      flagged: message.flagged ?? false,
      internalDate: message.internalDate ?? Date.parse(header(Buffer.from(message.raw), 'Date') ?? ''),
    });
    this.notifyIdle(appleId, path);
    return uid;
  }

  /** IMAP MOVE: the message gets a new UID in the target folder and disappears from the source. */
  move(appleId: string, from: string, uid: number, to: string): number {
    const source = this.folder(appleId, from);
    const message = source.messages.get(uid);
    if (!message) {
      throw new Error(`No message ${uid} in ${from}`);
    }
    source.messages.delete(uid);
    const target = this.folder(appleId, to);
    const newUid = target.nextUid++;
    target.messages.set(newUid, { ...message });
    this.notifyIdle(appleId, from);
    this.notifyIdle(appleId, to);
    return newUid;
  }

  /** IMAP COPY: the message stays where it is. */
  copy(appleId: string, from: string, uid: number, to: string): number {
    const message = this.folder(appleId, from).messages.get(uid);
    if (!message) {
      throw new Error(`No message ${uid} in ${from}`);
    }
    const target = this.folder(appleId, to);
    const newUid = target.nextUid++;
    target.messages.set(newUid, { ...message });
    this.notifyIdle(appleId, to);
    return newUid;
  }

  expunge(appleId: string, path: string, uid: number): void {
    this.folder(appleId, path).messages.delete(uid);
    this.notifyIdle(appleId, path);
  }

  setFlags(appleId: string, path: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): void {
    const message = this.folder(appleId, path).messages.get(uid);
    if (!message) {
      throw new Error(`No message ${uid} in ${path}`);
    }
    Object.assign(message, flags);
    this.notifyIdle(appleId, path);
  }

  // ---- Apple IMAP IDLE ---------------------------------------------------------------------

  /** Number of IDLE connections currently open for an Apple ID. */
  openIdleConnections(appleId: string): number {
    return (this.idleSessions.get(appleId) ?? []).filter((session) => session.open).length;
  }

  /** The most IDLE connections that were ever open at once for an Apple ID. */
  peakIdleConnections(appleId: string): number {
    return this.peakIdle.get(appleId) ?? 0;
  }

  /** How often the app tried to open an IDLE connection for an Apple ID, failed attempts included. */
  idleConnectAttempts(appleId: string): number {
    return this.idleAttempts.get(appleId) ?? 0;
  }

  /** The next IDLE connection of the Apple ID drops right after it was opened, before the app stored it. */
  dropNextIdleRightAfterOpen(appleId: string): void {
    this.dropOnOpen.add(appleId);
  }

  /** The next `count` attempts to open an IDLE connection fail. */
  failIdleConnects(appleId: string, count: number): void {
    this.idleConnectFailures.set(appleId, count);
  }

  /** The server (or the network) drops every IDLE connection of the Apple ID. */
  dropIdleConnections(appleId: string): void {
    for (const session of this.idleSessions.get(appleId) ?? []) {
      if (session.open) {
        session.open = false;
        session.handlers.onClose(new Error('Connection reset by peer'));
      }
    }
  }

  /** The server renumbers the folder: new UIDVALIDITY, every message under a new UID. Returns old → new. */
  resetUidValidity(appleId: string, path: string, firstUid = 500): Map<number, number> {
    const folder = this.folder(appleId, path);
    folder.uidValidity += 1;
    const mapping = new Map<number, number>();
    const renumbered = new Map<number, AppleMessage>();
    folder.nextUid = firstUid;
    for (const [uid, message] of [...folder.messages].reverse()) {
      mapping.set(uid, folder.nextUid);
      renumbered.set(folder.nextUid++, message);
    }
    folder.messages = renumbered;
    return mapping;
  }

  appleUids(appleId: string, path: string): number[] {
    return [...this.folder(appleId, path).messages.keys()];
  }

  // ---- Gmail -------------------------------------------------------------------------------

  addGoogleAccount(refreshToken: string, customLabels: string[] = []): void {
    const labels = new Map(SYSTEM_LABELS.map((name) => [name, name]));
    customLabels.forEach((name) => labels.set(`Label_seed_${labels.size}`, name));
    this.google.set(refreshToken, { labels, messages: new Map() });
  }

  gmailMessages(refreshToken: string): { id: string; labels: string[]; raw: string }[] {
    const account = this.account(refreshToken);
    return [...account.messages].map(([id, message]) => ({
      id,
      labels: [...message.labelIds].map((labelId) => account.labels.get(labelId) ?? labelId).sort(),
      raw: message.raw.toString('utf8'),
    }));
  }

  gmailLabelNames(refreshToken: string): string[] {
    return [...this.account(refreshToken).labels.values()];
  }

  /** Simulates a manual change in the Gmail web UI. */
  editGmail(refreshToken: string, id: string, change: { add?: string[]; remove?: string[] }): void {
    const account = this.account(refreshToken);
    const message = account.messages.get(id);
    if (!message) {
      throw new GoogleMessageNotFoundError(id);
    }
    change.add?.forEach((name) => message.labelIds.add(this.labelId(account, name)));
    change.remove?.forEach((name) => message.labelIds.delete(this.labelId(account, name)));
  }

  /** Simulates a manual, permanent deletion in Gmail. */
  removeGmailMessage(refreshToken: string, id: string): void {
    this.account(refreshToken).messages.delete(id);
  }

  /** Imports of messages whose raw text contains `match` fail, as Gmail does for a message it rejects. */
  rejectImportsContaining(match: string, error: Error = new Error('Gmail rejected the message')): void {
    this.importFailures.push({ match, error });
  }

  /** Gmail accepts every message again. */
  clearImportRejections(): void {
    this.importFailures = [];
  }

  // ---- Provider views ----------------------------------------------------------------------

  appleMailFor(appleId: string | null): SyncProviders['apple']['mail'] {
    const id = appleId ?? '';
    return {
      listFolders: async () =>
        [...this.folders(id)].map(([path, folder]) => ({
          path,
          name: path,
          use: folder.use,
          selectable: folder.selectable,
        })),
      listFolder: async (path) => {
        const folder = this.findFolder(id, path);
        return {
          uidValidity: folder.uidValidity,
          messages: [...folder.messages].map(([uid, m]) => ({
            uid,
            seen: m.seen,
            flagged: m.flagged,
            size: m.raw.length,
            internalDate: m.internalDate,
          })),
        };
      },
      fetchEnvelopes: async (path, uids) => {
        const folder = this.findFolder(id, path);
        const envelopes: AppleMailEnvelope[] = [];
        for (const uid of uids) {
          const message = folder.messages.get(uid);
          if (message) {
            this.envelopeFetches.push({ path, uid });
            envelopes.push({
              uid,
              messageId: header(message.raw, 'Message-ID'),
              date: header(message.raw, 'Date'),
              from: header(message.raw, 'From') ?? '',
              subject: header(message.raw, 'Subject') ?? '',
            });
          }
        }
        return envelopes;
      },
      fetchRaw: async (path, uid) => {
        const message = this.findFolder(id, path).messages.get(uid);
        if (!message) {
          throw new Error(`No message ${uid} in ${path}`);
        }
        this.rawFetches.push({ path, uid });
        return message.raw;
      },
      folderStatus: async (paths) => {
        this.statusRequests.push([...paths]);
        return paths.flatMap((path) => {
          const folder = this.folders(id).get(path);
          return folder
            ? [
                {
                  path,
                  uidValidity: folder.uidValidity,
                  uidNext: folder.nextUid,
                  messages: folder.messages.size,
                  unseen: [...folder.messages.values()].filter((message) => !message.seen).length,
                },
              ]
            : [];
        });
      },
      openInboxIdle: async (handlers) => {
        this.idleAttempts.set(id, (this.idleAttempts.get(id) ?? 0) + 1);
        const failures = this.idleConnectFailures.get(id) ?? 0;
        if (failures > 0) {
          this.idleConnectFailures.set(id, failures - 1);
          throw new Error('IMAP connection refused');
        }
        const session: IdleSession = { handlers, open: true };
        this.idleSessions.set(id, [...(this.idleSessions.get(id) ?? []), session]);
        this.peakIdle.set(id, Math.max(this.peakIdle.get(id) ?? 0, this.openIdleConnections(id)));
        if (this.dropOnOpen.delete(id)) {
          session.open = false;
          handlers.onClose(new Error('Connection reset by peer'));
        }
        return {
          close: async () => {
            session.open = false;
          },
        };
      },
    };
  }

  googleMailFor(refreshToken: string | null): SyncProviders['google']['mail'] {
    const token = refreshToken ?? '';
    const account = () => {
      if (!this.google.has(token)) {
        throw new GoogleAuthError('invalid_grant', 'Token has been expired or revoked.');
      }
      return this.account(token);
    };
    const message = (id: string) => {
      const found = account().messages.get(id);
      if (!found) {
        throw new GoogleMessageNotFoundError(id);
      }
      return found;
    };

    return {
      listLabels: async () => [...account().labels].map(([id, name]): GoogleMailLabel => ({ id, name })),
      createLabel: async (name) => {
        const labels = account().labels;
        const id = `Label_new_${(this.counter += 1)}`;
        labels.set(id, name);
        this.googleWrites.push({ kind: 'createLabel', id });
        return { id, name };
      },
      importMessage: async ({ raw, labelIds }) => {
        const failure = this.importFailures.find(({ match }) => raw.toString('utf8').includes(match));
        if (failure) {
          throw failure.error;
        }
        const id = `msg-${(this.counter += 1)}`;
        account().messages.set(id, { raw, labelIds: new Set(labelIds) });
        this.googleWrites.push({ kind: 'import', id });
        return id;
      },
      modify: async (id, { addLabelIds, removeLabelIds }) => {
        const found = message(id);
        addLabelIds.forEach((label) => found.labelIds.add(label));
        removeLabelIds.forEach((label) => found.labelIds.delete(label));
        this.googleWrites.push({ kind: 'modify', id });
      },
      trash: async (id) => {
        const found = message(id);
        found.labelIds.add('TRASH');
        found.labelIds.delete('INBOX'); // Gmail takes a trashed message out of the inbox
        this.googleWrites.push({ kind: 'trash', id });
      },
      untrash: async (id) => {
        message(id).labelIds.delete('TRASH');
        this.googleWrites.push({ kind: 'untrash', id });
      },
      delete: async (id) => {
        message(id);
        account().messages.delete(id);
        this.googleWrites.push({ kind: 'delete', id });
      },
    };
  }

  // ---- internals ---------------------------------------------------------------------------

  private notifyIdle(appleId: string, path: string): void {
    if (path.toUpperCase() !== 'INBOX') {
      return;
    }
    for (const session of this.idleSessions.get(appleId) ?? []) {
      if (session.open) {
        session.handlers.onChange();
      }
    }
  }

  private folders(appleId: string): Map<string, AppleFolder> {
    let folders = this.apple.get(appleId);
    if (!folders) {
      folders = new Map();
      this.apple.set(appleId, folders);
    }
    return folders;
  }

  private folder(appleId: string, path: string): AppleFolder {
    const folder = this.folders(appleId).get(path);
    if (!folder) {
      throw new Error(`Unknown fake mail folder ${path}`);
    }
    return folder;
  }

  private findFolder(appleId: string, path: string): AppleFolder {
    const folder = this.folders(appleId).get(path);
    if (!folder) {
      throw new AppleMailFolderNotFoundError(path);
    }
    return folder;
  }

  private account(refreshToken: string): GmailAccount {
    const account = this.google.get(refreshToken);
    if (!account) {
      throw new Error(`Unknown fake Google account ${refreshToken}`);
    }
    return account;
  }

  private labelId(account: GmailAccount, name: string): string {
    const found = [...account.labels].find(([, labelName]) => labelName === name);
    if (!found) {
      throw new Error(`Unknown Gmail label ${name}`);
    }
    return found[0];
  }
}
