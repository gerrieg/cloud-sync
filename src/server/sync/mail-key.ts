import crypto from 'node:crypto';
import type { AppleMailEnvelope } from '../providers/mail-types.js';

/**
 * The profile-wide identity of a message: its normalized `Message-ID`, or, when the header is
 * missing or empty, a deterministic SHA-256 over Date + From + Subject + Size.
 */
export function messageKey(envelope: Pick<AppleMailEnvelope, 'messageId' | 'date' | 'from' | 'subject'>, size: number): string {
  const id = envelope.messageId?.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  if (id) {
    return `id:${id}`;
  }
  const fields = [envelope.date ?? '', envelope.from, envelope.subject, String(size)].map((field) => field.trim());
  return `hash:${crypto.createHash('sha256').update(fields.join('\n')).digest('hex')}`;
}
