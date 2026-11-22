import { Readable } from 'node:stream';
import { google, type gmail_v1 } from 'googleapis';
import { ImapFlow } from 'imapflow';
import type { MailFolderUse } from '../../shared/mail.js';
import {
  AppleMailFolderNotFoundError,
  GoogleMessageNotFoundError,
  type AppleMailEnvelope,
  type AppleMailFolder,
  type AppleMailFolderStatus,
  type AppleMailListing,
  type InboxIdleConnection,
} from './mail-types.js';
import { httpStatus, isInvalidGrant, type GoogleClientConfig } from './real-calendar.js';
import {
  GOOGLE_INVALID_GRANT,
  GoogleAuthError,
  type AppleCredentials,
  type GoogleTokens,
  type SyncProviders,
} from './types.js';

export const ICLOUD_IMAP_HOST = 'imap.mail.me.com';
export const ICLOUD_IMAP_PORT = 993;
/** Gmail charges `messages.import` heavily: about one or two imports per second per Profile. */
export const GMAIL_IMPORT_MIN_INTERVAL_MS = 600;
/** UID sets in a FETCH command stay short enough for the server's line limit. */
const FETCH_CHUNK = 200;

type AppleMail = SyncProviders['apple']['mail'];
type GoogleMail = SyncProviders['google']['mail'];

function isMissingFolder(error: unknown): boolean {
  return (
    (error as { serverResponseCode?: unknown }).serverResponseCode === 'NONEXISTENT' ||
    /not exist|nonexistent|unknown mailbox/i.test(String((error as Error).message))
  );
}

const SPECIAL_USES: Record<string, MailFolderUse> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
};

export function createRealAppleMail(credentials: AppleCredentials | null): AppleMail {
  function newClient(): ImapFlow {
    if (!credentials) {
      throw new Error('No Apple credentials configured');
    }
    return new ImapFlow({
      host: ICLOUD_IMAP_HOST,
      port: ICLOUD_IMAP_PORT,
      secure: true,
      auth: { user: credentials.appleId, pass: credentials.appPassword },
      logger: false,
    });
  }

  /** iCloud caps concurrent IMAP connections, so every call uses one short-lived connection. */
  async function withClient<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = newClient();
    // imapflow emits connection errors; without a listener they would crash the process
    client.on('error', () => undefined);
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async function inFolder<T>(client: ImapFlow, path: string, work: () => Promise<T>): Promise<T> {
    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
    try {
      lock = await client.getMailboxLock(path, { readOnly: true });
    } catch (error) {
      if (isMissingFolder(error)) {
        throw new AppleMailFolderNotFoundError(path);
      }
      throw error;
    }
    try {
      return await work();
    } finally {
      lock.release();
    }
  }

  return {
    listFolders: () =>
      withClient(async (client): Promise<AppleMailFolder[]> =>
        (await client.list()).map((entry) => ({
          path: entry.path,
          name: entry.path.split(entry.delimiter).join('/'),
          use: entry.path.toUpperCase() === 'INBOX' ? 'inbox' : (SPECIAL_USES[entry.specialUse ?? ''] ?? null),
          selectable: !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'),
        })),
      ),
    listFolder: (path) =>
      withClient((client) =>
        inFolder(client, path, async (): Promise<AppleMailListing> => {
          const mailbox = client.mailbox;
          const uidValidity = mailbox ? Number(mailbox.uidValidity) : 0;
          const messages: AppleMailListing['messages'][number][] = [];
          if (mailbox && mailbox.exists > 0) {
            for await (const message of client.fetch('1:*', { uid: true, flags: true, size: true, internalDate: true })) {
              messages.push({
                uid: message.uid,
                seen: message.flags?.has('\\Seen') ?? false,
                flagged: message.flags?.has('\\Flagged') ?? false,
                size: message.size ?? 0,
                internalDate: message.internalDate ? new Date(message.internalDate).getTime() : 0,
              });
            }
          }
          return { uidValidity, messages };
        }),
      ),
    fetchEnvelopes: (path, uids) =>
      withClient((client) =>
        inFolder(client, path, async (): Promise<AppleMailEnvelope[]> => {
          const envelopes: AppleMailEnvelope[] = [];
          for (let start = 0; start < uids.length; start += FETCH_CHUNK) {
            const range = uids.slice(start, start + FETCH_CHUNK).join(',');
            for await (const message of client.fetch(range, { uid: true, envelope: true }, { uid: true })) {
              const envelope = message.envelope;
              envelopes.push({
                uid: message.uid,
                messageId: envelope?.messageId ?? null,
                // A Date header nobody can parse must not make the whole run fail
                date: envelope?.date && !Number.isNaN(new Date(envelope.date).getTime()) ? new Date(envelope.date).toISOString() : null,
                from: (envelope?.from ?? []).map((a) => a.address ?? '').join(','),
                subject: envelope?.subject ?? '',
              });
            }
          }
          return envelopes;
        }),
      ),
    fetchRaw: (path, uid) =>
      withClient((client) =>
        inFolder(client, path, async () => {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message || !message.source) {
            throw new Error(`Message ${uid} of "${path}" could not be read`);
          }
          return message.source;
        }),
      ),
    folderStatus: (paths) =>
      withClient(async (client): Promise<AppleMailFolderStatus[]> => {
        const statuses: AppleMailFolderStatus[] = [];
        for (const path of paths) {
          try {
            const status = await client.status(path, { messages: true, uidNext: true, uidValidity: true, unseen: true });
            if (!status) {
              continue;
            }
            statuses.push({
              path,
              uidValidity: Number(status.uidValidity ?? 0),
              uidNext: status.uidNext ?? 0,
              messages: status.messages ?? 0,
              unseen: status.unseen ?? 0,
            });
          } catch (error) {
            // A folder that is gone shows up as a missing entry; the sync run itself reports it
            if (!isMissingFolder(error)) {
              throw error;
            }
          }
        }
        return statuses;
      }),
    async openInboxIdle({ onChange, onClose }): Promise<InboxIdleConnection> {
      const client = newClient();
      let lastError: Error | null = null;
      let opened = false;
      let closing = false;
      client.on('error', (error: Error) => {
        lastError = error;
      });
      // imapflow IDLEs by itself while a mailbox is open and no command is running
      client.on('exists', onChange);
      client.on('expunge', onChange);
      client.on('flags', onChange);
      client.on('close', () => {
        if (opened && !closing) {
          onClose(lastError);
        }
      });
      try {
        await client.connect();
        await client.mailboxOpen('INBOX', { readOnly: true });
      } catch (error) {
        client.close();
        throw error;
      }
      opened = true;
      return {
        close: async () => {
          closing = true;
          await client.logout().catch(() => client.close());
        },
      };
    },
  };
}

export function createRealGoogleMail(
  config: GoogleClientConfig,
  tokens: GoogleTokens | null,
  /** Spaces the imports of one Profile. */
  limitImports: <T>(call: () => Promise<T>) => Promise<T>,
): GoogleMail {
  function client(): gmail_v1.Gmail {
    if (!tokens) {
      throw new Error('Google account is not connected');
    }
    const auth = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
    auth.setCredentials({ ...tokens });
    return google.gmail({ version: 'v1', auth });
  }

  async function guarded<T>(call: (gmail: gmail_v1.Gmail) => Promise<T>, messageId?: string): Promise<T> {
    try {
      return await call(client());
    } catch (error) {
      if (isInvalidGrant(error)) {
        throw new GoogleAuthError(GOOGLE_INVALID_GRANT, error instanceof Error ? error.message : undefined);
      }
      if (messageId !== undefined && httpStatus(error) === 404) {
        throw new GoogleMessageNotFoundError(messageId);
      }
      throw error;
    }
  }

  return {
    async listLabels() {
      const response = await guarded((gmail) => gmail.users.labels.list({ userId: 'me' }));
      return (response.data.labels ?? []).flatMap((label) => (label.id && label.name ? [{ id: label.id, name: label.name }] : []));
    },
    async createLabel(name) {
      const response = await guarded((gmail) =>
        gmail.users.labels.create({
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        }),
      );
      if (!response.data.id) {
        throw new Error(`Gmail did not create the label "${name}"`);
      }
      return { id: response.data.id, name };
    },
    async importMessage({ raw, labelIds }) {
      const response = await limitImports(() =>
        guarded((gmail) =>
          gmail.users.messages.import({
            userId: 'me',
            internalDateSource: 'dateHeader',
            neverMarkSpam: true,
            requestBody: { labelIds: [...labelIds] },
            media: { mimeType: 'message/rfc822', body: Readable.from(raw) },
          }),
        ),
      );
      if (!response.data.id) {
        throw new Error('Gmail did not return an id for the imported message');
      }
      return response.data.id;
    },
    async modify(id, { addLabelIds, removeLabelIds }) {
      await guarded(
        (gmail) =>
          gmail.users.messages.modify({
            userId: 'me',
            id,
            requestBody: { addLabelIds: [...addLabelIds], removeLabelIds: [...removeLabelIds] },
          }),
        id,
      );
    },
    async trash(id) {
      await guarded((gmail) => gmail.users.messages.trash({ userId: 'me', id }), id);
    },
    async untrash(id) {
      await guarded((gmail) => gmail.users.messages.untrash({ userId: 'me', id }), id);
    },
    async delete(id) {
      await guarded((gmail) => gmail.users.messages.delete({ userId: 'me', id }), id);
    },
  };
}
