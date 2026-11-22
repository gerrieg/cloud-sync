import type { FetchMessageObject, ListResponse } from 'imapflow';
import type { MailFolderUse } from '../../shared/mail.js';
import type { AppleMailEnvelope, AppleMailFolder, AppleMailListing } from './mail-types.js';

/** The server says the folder does not exist (anymore). */
export function isMissingFolder(error: unknown): boolean {
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

export function describeFolder(entry: Pick<ListResponse, 'path' | 'delimiter' | 'specialUse' | 'flags'>): AppleMailFolder {
  return {
    path: entry.path,
    name: entry.path.split(entry.delimiter).join('/'),
    use: entry.path.toUpperCase() === 'INBOX' ? 'inbox' : (SPECIAL_USES[entry.specialUse ?? ''] ?? null),
    selectable: !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'),
  };
}

export function toListedMessage(message: Pick<FetchMessageObject, 'uid' | 'flags' | 'size' | 'internalDate'>): AppleMailListing['messages'][number] {
  return {
    uid: message.uid,
    seen: message.flags?.has('\\Seen') ?? false,
    flagged: message.flags?.has('\\Flagged') ?? false,
    size: message.size ?? 0,
    internalDate: message.internalDate ? new Date(message.internalDate).getTime() : 0,
  };
}

export function toEnvelope(message: Pick<FetchMessageObject, 'uid' | 'envelope'>): AppleMailEnvelope {
  const envelope = message.envelope;
  return {
    uid: message.uid,
    messageId: envelope?.messageId ?? null,
    // A Date header nobody can parse must not make the whole run fail
    date: envelope?.date && !Number.isNaN(new Date(envelope.date).getTime()) ? new Date(envelope.date).toISOString() : null,
    from: (envelope?.from ?? []).map((a) => a.address ?? '').join(','),
    subject: envelope?.subject ?? '',
  };
}
