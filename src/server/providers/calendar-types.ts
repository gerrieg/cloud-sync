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

/** The identity of one Apple CalDAV resource at a point in time. */
export interface AppleObjectRef {
  readonly href: string;
  readonly etag: string;
}

/** A write of one iCalendar resource to Apple CalDAV. */
export interface AppleObjectWrite {
  /** The resource to overwrite, or null to create a new one (the adapter derives its URL from `uid`). */
  readonly href: string | null;
  readonly uid: string;
  readonly ics: string;
  /** ETag the overwrite is conditional on (`If-Match`); ignored for creates. */
  readonly etag: string | null;
}

/** A page-less view of what changed in a Google calendar since a sync token. */
export interface GoogleEventChanges {
  /** Created or modified events (never cancelled ones). */
  readonly events: readonly GoogleEvent[];
  /** Ids of events that were deleted. Always empty for a full listing. */
  readonly deletedIds: readonly string[];
  /** Pass this back next time to receive only what changed after this read. */
  readonly nextSyncToken: string;
}

/** Google answered HTTP 410 Gone: the sync token is stale and a full listing is needed. */
export class GoogleSyncTokenExpiredError extends Error {
  constructor() {
    super('Google sync token expired');
    this.name = 'GoogleSyncTokenExpiredError';
  }
}

export class AppleObjectNotFoundError extends Error {
  constructor(href: string) {
    super(`Apple calendar object ${href} not found`);
    this.name = 'AppleObjectNotFoundError';
  }
}

/** The conditional write failed: the Apple resource changed since its ETag was read. */
export class ApplePreconditionFailedError extends Error {
  constructor(href: string) {
    super(`Apple calendar object ${href} changed concurrently`);
    this.name = 'ApplePreconditionFailedError';
  }
}
