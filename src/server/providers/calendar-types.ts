/** Calendar-specific shapes exchanged through the SyncProviders seam. */

export interface AppleCalendarInfo {
  readonly url: string;
  readonly name: string;
  /** Collection tag; changes whenever anything inside the calendar changes. */
  readonly ctag: string | null;
  readonly readOnly: boolean;
  readonly subscribed: boolean;
}

export interface AppleCalendarObject {
  readonly href: string;
  readonly etag: string;
  /** Raw iCalendar text of the resource. */
  readonly ics: string;
}

export interface GoogleCalendarInfo {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
  readonly writable: boolean;
}

export interface GoogleDateTime {
  readonly date?: string;
  readonly dateTime?: string;
  readonly timeZone?: string;
}

export interface GoogleReminder {
  readonly method: 'popup' | 'email';
  readonly minutes: number;
}

export interface GoogleEventDraft {
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: GoogleDateTime;
  readonly end: GoogleDateTime;
  /** RRULE / EXDATE lines of a recurring series. */
  readonly recurrence?: readonly string[];
  /** Set for exceptions of a recurring series: id of the master event. */
  readonly recurringEventId?: string;
  /** Set for exceptions: the original start of the overridden occurrence (iCal RECURRENCE-ID). */
  readonly originalStartTime?: GoogleDateTime;
  /** The Apple event UID; lets Google (and a later Initial Sync) recognise the same event. */
  readonly iCalUID: string;
  readonly reminders: { readonly useDefault: false; readonly overrides: readonly GoogleReminder[] };
}

export interface GoogleEvent extends GoogleEventDraft {
  readonly id: string;
}

/** Every Google write passes `sendUpdates: 'none'` so no invitation emails are ever sent. */
export interface GoogleWriteOptions {
  readonly sendUpdates: 'none';
}

export class GoogleEventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Google event ${eventId} not found`);
    this.name = 'GoogleEventNotFoundError';
  }
}
