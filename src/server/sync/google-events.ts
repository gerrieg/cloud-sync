import crypto from 'node:crypto';
import type { GoogleDateTime, GoogleEventDraft } from '../providers/calendar-types.js';

/** Same normalization as the ICS side: UTC instant for timed events, `YYYY-MM-DD` for all-day. */
export function googleStartKey(value: GoogleDateTime): string | null {
  if (value.date) {
    return value.date;
  }
  const instant = value.dateTime ? new Date(value.dateTime) : null;
  return instant && !Number.isNaN(instant.getTime()) ? instant.toISOString() : null;
}

/**
 * Content hash of the fields that are synced. Times are normalized to instants, so Google
 * re-expressing a time in another offset does not look like an edit.
 */
export function googleFingerprint(event: GoogleEventDraft): string {
  const content = [
    event.summary,
    event.description ?? '',
    event.location ?? '',
    googleStartKey(event.start),
    googleStartKey(event.end),
    (event.recurrence ?? []).join('\n'),
  ];
  return crypto.createHash('sha1').update(JSON.stringify(content)).digest('hex');
}
