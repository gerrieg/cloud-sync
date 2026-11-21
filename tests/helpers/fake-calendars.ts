import {
  GoogleEventNotFoundError,
  type AppleCalendarInfo,
  type AppleCalendarObject,
  type GoogleCalendarInfo,
  type GoogleDateTime,
  type GoogleEvent,
  type GoogleEventDraft,
} from '../../src/server/providers/calendar-types.js';
import { GoogleAuthError, type SyncProviders } from '../../src/server/providers/types.js';

export interface GoogleWrite {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly calendarId: string;
  readonly eventId: string | null;
  readonly sendUpdates: string;
}

interface AppleCalendarState {
  info: Omit<AppleCalendarInfo, 'ctag'>;
  ctag: string;
  objects: Map<string, { etag: string; ics: string }>;
}

interface GoogleCalendarState {
  info: GoogleCalendarInfo;
  events: Map<string, GoogleEvent>;
}

export interface SeedGoogleEvent {
  summary: string;
  start: GoogleDateTime;
  end: GoogleDateTime;
  iCalUID?: string;
}

/**
 * Stateful in-memory Apple CalDAV + Google Calendar. Apple state is keyed by Apple ID, Google
 * state by the account's refresh token, so several Profiles can live side by side.
 */
export class FakeCalendarWorld {
  /** Every Google write, in order, with the `sendUpdates` it was called with. */
  readonly writes: GoogleWrite[] = [];
  /** Chronological log of read calls, e.g. `apple.list:anna@icloud.com`. */
  readonly trace: string[] = [];

  private readonly apple = new Map<string, Map<string, AppleCalendarState>>();
  private readonly google = new Map<string, Map<string, GoogleCalendarState>>();
  private readonly gates = new Map<string, Promise<void>>();
  private readonly invalidGrant = new Set<string>();
  private readonly failingWrites = new Map<string, { remaining: number; error: Error }>();
  private counter = 0;

  // ---- Apple world -------------------------------------------------------------------------

  addAppleCalendar(
    appleId: string,
    calendar: { url: string; name: string; readOnly?: boolean; subscribed?: boolean },
  ): void {
    const calendars = this.apple.get(appleId) ?? new Map<string, AppleCalendarState>();
    calendars.set(calendar.url, {
      info: {
        url: calendar.url,
        name: calendar.name,
        readOnly: calendar.readOnly ?? false,
        subscribed: calendar.subscribed ?? false,
      },
      ctag: this.next('ctag'),
      objects: new Map(),
    });
    this.apple.set(appleId, calendars);
  }

  putAppleEvent(appleId: string, calendarUrl: string, href: string, ics: string): void {
    const calendar = this.appleCalendar(appleId, calendarUrl);
    calendar.objects.set(href, { etag: this.next('etag'), ics });
    calendar.ctag = this.next('ctag');
  }

  removeAppleEvent(appleId: string, calendarUrl: string, href: string): void {
    const calendar = this.appleCalendar(appleId, calendarUrl);
    calendar.objects.delete(href);
    calendar.ctag = this.next('ctag');
  }

  appleCalendarObject(appleId: string, calendarUrl: string, href: string) {
    return this.appleCalendar(appleId, calendarUrl).objects.get(href);
  }

  // ---- Google world ------------------------------------------------------------------------

  addGoogleCalendar(
    refreshToken: string,
    calendar: { id: string; name: string; primary?: boolean; writable?: boolean },
  ): void {
    const calendars = this.google.get(refreshToken) ?? new Map<string, GoogleCalendarState>();
    calendars.set(calendar.id, {
      info: {
        id: calendar.id,
        name: calendar.name,
        primary: calendar.primary ?? false,
        writable: calendar.writable ?? true,
      },
      events: new Map(),
    });
    this.google.set(refreshToken, calendars);
  }

  /** A pre-existing Google event, as if created by hand or by an earlier import. */
  seedGoogleEvent(refreshToken: string, calendarId: string, event: SeedGoogleEvent): GoogleEvent {
    const created: GoogleEvent = {
      id: this.next('seed'),
      summary: event.summary,
      start: event.start,
      end: event.end,
      iCalUID: event.iCalUID ?? `${this.next('uid')}@google.com`,
      reminders: { useDefault: false, overrides: [] },
    };
    this.googleCalendar(refreshToken, calendarId).events.set(created.id, created);
    return created;
  }

  googleEvents(refreshToken: string, calendarId: string): GoogleEvent[] {
    return [...this.googleCalendar(refreshToken, calendarId).events.values()];
  }

  /** Simulates a manual edit made in the Google Calendar UI. */
  editGoogleEvent(
    refreshToken: string,
    calendarId: string,
    eventId: string,
    patch: Partial<GoogleEventDraft>,
  ): void {
    const events = this.googleCalendar(refreshToken, calendarId).events;
    const existing = events.get(eventId);
    if (!existing) {
      throw new GoogleEventNotFoundError(eventId);
    }
    events.set(eventId, { ...existing, ...patch });
  }

  /** Simulates a manual deletion made in the Google Calendar UI. */
  removeGoogleEvent(refreshToken: string, calendarId: string, eventId: string): void {
    this.googleCalendar(refreshToken, calendarId).events.delete(eventId);
  }

  /** Holds every Google write of this account until `release()` is called. */
  holdGoogleWrites(refreshToken: string): { release(): void } {
    let release!: () => void;
    this.gates.set(
      refreshToken,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return {
      release: () => {
        this.gates.delete(refreshToken);
        release();
      },
    };
  }

  rejectGoogleWithInvalidGrant(refreshToken: string): void {
    this.invalidGrant.add(refreshToken);
  }

  failNextGoogleWrite(refreshToken: string, error: Error): void {
    this.failGoogleWriteAfter(refreshToken, 0, error);
  }

  /** Lets `successfulWrites` Google writes through, then fails the next one once. */
  failGoogleWriteAfter(refreshToken: string, successfulWrites: number, error: Error): void {
    this.failingWrites.set(refreshToken, { remaining: successfulWrites, error });
  }

  // ---- Provider views ----------------------------------------------------------------------

  appleCalendarsFor(appleId: string | null): SyncProviders['apple']['calendars'] {
    return {
      list: async () => {
        this.trace.push(`apple.list:${appleId}`);
        return [...this.appleCalendarsOf(appleId).values()].map((c) => ({ ...c.info, ctag: c.ctag }));
      },
      listObjects: async (calendarUrl) => {
        this.trace.push(`apple.objects:${appleId}:${calendarUrl}`);
        const calendar = this.appleCalendarsOf(appleId).get(calendarUrl);
        if (!calendar) {
          throw new Error(`Apple calendar ${calendarUrl} not found`);
        }
        return [...calendar.objects.entries()].map(
          ([href, object]): AppleCalendarObject => ({ href, etag: object.etag, ics: object.ics }),
        );
      },
    };
  }

  googleCalendarsFor(refreshToken: string | null): SyncProviders['google']['calendars'] {
    const token = refreshToken ?? '';
    const authenticate = () => {
      if (this.invalidGrant.has(token) || !this.google.has(token)) {
        throw new GoogleAuthError('invalid_grant', 'Token has been expired or revoked.');
      }
    };
    const beforeWrite = async (write: GoogleWrite) => {
      authenticate();
      await this.gates.get(token);
      const failure = this.failingWrites.get(token);
      if (failure && failure.remaining === 0) {
        this.failingWrites.delete(token);
        throw failure.error;
      }
      if (failure) {
        failure.remaining -= 1;
      }
      this.writes.push(write);
    };

    return {
      list: async () => {
        this.trace.push(`google.list:${token}`);
        authenticate();
        return [...(this.google.get(token) ?? []).values()].map((c) => ({ ...c.info }));
      },
      listEvents: async (calendarId) => {
        this.trace.push(`google.events:${token}:${calendarId}`);
        authenticate();
        return this.googleEvents(token, calendarId);
      },
      insertEvent: async (calendarId, draft, options) => {
        await beforeWrite({ kind: 'insert', calendarId, eventId: null, sendUpdates: options.sendUpdates });
        const event: GoogleEvent = { ...draft, id: this.next('evt') };
        this.googleCalendar(token, calendarId).events.set(event.id, event);
        return event;
      },
      updateEvent: async (calendarId, eventId, draft, options) => {
        await beforeWrite({ kind: 'update', calendarId, eventId, sendUpdates: options.sendUpdates });
        const events = this.googleCalendar(token, calendarId).events;
        if (!events.has(eventId)) {
          throw new GoogleEventNotFoundError(eventId);
        }
        const event: GoogleEvent = { ...draft, id: eventId };
        events.set(eventId, event);
        return event;
      },
      deleteEvent: async (calendarId, eventId, options) => {
        await beforeWrite({ kind: 'delete', calendarId, eventId, sendUpdates: options.sendUpdates });
        const events = this.googleCalendar(token, calendarId).events;
        if (!events.delete(eventId)) {
          throw new GoogleEventNotFoundError(eventId);
        }
        // Deleting a series also removes its overridden occurrences
        for (const [id, event] of events) {
          if (event.recurringEventId === eventId) {
            events.delete(id);
          }
        }
      },
    };
  }

  // ---- internals ---------------------------------------------------------------------------

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private appleCalendarsOf(appleId: string | null): Map<string, AppleCalendarState> {
    return (appleId !== null && this.apple.get(appleId)) || new Map();
  }

  private appleCalendar(appleId: string, calendarUrl: string): AppleCalendarState {
    const calendar = this.appleCalendarsOf(appleId).get(calendarUrl);
    if (!calendar) {
      throw new Error(`Unknown fake Apple calendar ${calendarUrl}`);
    }
    return calendar;
  }

  private googleCalendar(refreshToken: string, calendarId: string): GoogleCalendarState {
    const calendar = this.google.get(refreshToken)?.get(calendarId);
    if (!calendar) {
      throw new Error(`Unknown fake Google calendar ${calendarId}`);
    }
    return calendar;
  }
}
