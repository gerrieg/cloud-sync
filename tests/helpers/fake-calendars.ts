import {
  AppleObjectNotFoundError,
  ApplePreconditionFailedError,
  GoogleEventNotFoundError,
  GoogleSyncTokenExpiredError,
  type AppleCalendarInfo,
  type AppleCalendarObject,
  type GoogleCalendarInfo,
  type GoogleDateTime,
  type GoogleEvent,
  type GoogleEventDraft,
} from '../../src/server/providers/calendar-types.js';
import { instantOf } from '../../src/server/providers/calendar-mapping.js';
import { GoogleAuthError, type SyncProviders } from '../../src/server/providers/types.js';

export interface GoogleWrite {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly calendarId: string;
  readonly eventId: string | null;
  readonly sendUpdates: string;
}

export interface AppleWrite {
  readonly kind: 'put' | 'delete';
  readonly href: string;
}

interface AppleCalendarState {
  info: Omit<AppleCalendarInfo, 'ctag'>;
  ctag: string;
  objects: Map<string, { etag: string; ics: string }>;
}

interface GoogleCalendarState {
  info: GoogleCalendarInfo;
  events: Map<string, GoogleEvent>;
  /** Monotonic change counter; sync tokens are `st-<version>`. */
  version: number;
  /** Tokens issued before this version are answered with HTTP 410 Gone. */
  minValidVersion: number;
  changedAt: Map<string, number>;
  deletedAt: Map<string, number>;
}

export interface SeedGoogleEvent {
  summary: string;
  start: GoogleDateTime;
  end: GoogleDateTime;
  iCalUID?: string;
  recurrence?: readonly string[];
  /** Makes it an overridden occurrence of that series. */
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
}

/**
 * Stateful in-memory Apple CalDAV + Google Calendar. Apple state is keyed by Apple ID, Google
 * state by the account's refresh token, so several Profiles can live side by side.
 */
export interface FakeWatchChannel {
  readonly id: string;
  readonly resourceId: string;
  readonly calendarId: string;
  readonly address: string;
  readonly token: string;
  readonly expiresAt: number;
  stopped: boolean;
}

/** How long the fake Google keeps a notification channel alive. */
export const FAKE_WATCH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export class FakeCalendarWorld {
  /** Every notification channel ever registered per account, stopped ones included. */
  readonly watchChannels: FakeWatchChannel[] = [];
  /** How long the fake Google keeps a notification channel alive; a test may shorten it. */
  watchLifetimeMs = FAKE_WATCH_LIFETIME_MS;
  /** Optional hook invoked right before `events.watch` returns (e.g. to simulate an immediate `sync` webhook). */
  onWatch: ((channel: FakeWatchChannel) => Promise<void> | void) | null = null;
  private readonly failingWatches = new Map<string, Error>();

  constructor(private readonly clock: { now(): number } = { now: () => Date.now() }) {}

  /** Every Google write, in order, with the `sendUpdates` it was called with. */
  readonly writes: GoogleWrite[] = [];
  /** Every Apple write (CalDAV PUT / DELETE), in order. */
  readonly appleWrites: AppleWrite[] = [];
  /** Chronological log of read calls, e.g. `apple.list:anna@icloud.com`. */
  readonly trace: string[] = [];

  private readonly apple = new Map<string, Map<string, AppleCalendarState>>();
  private readonly google = new Map<string, Map<string, GoogleCalendarState>>();
  private readonly gates = new Map<string, Promise<void>>();
  private readonly invalidGrant = new Set<string>();
  private beforeNextApplePut: (() => void) | null = null;
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
      version: 0,
      minValidVersion: 0,
      changedAt: new Map(),
      deletedAt: new Map(),
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
      ...(event.recurrence ? { recurrence: event.recurrence } : {}),
      ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
      ...(event.originalStartTime ? { originalStartTime: event.originalStartTime } : {}),
    };
    this.storeGoogleEvent(this.googleCalendar(refreshToken, calendarId), created);
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
    this.storeGoogleEvent(this.googleCalendar(refreshToken, calendarId), { ...existing, ...patch });
  }

  /** Simulates a manual deletion made in the Google Calendar UI. */
  removeGoogleEvent(refreshToken: string, calendarId: string, eventId: string): void {
    this.dropGoogleEvent(this.googleCalendar(refreshToken, calendarId), eventId);
  }

  /** Runs `change` right before the next overwrite reaches Apple, i.e. after the caller read the ETag. */
  changeAppleBeforeNextOverwrite(change: () => void): void {
    this.beforeNextApplePut = change;
  }

  /** Makes every sync token issued so far stale: Google answers the next delta with HTTP 410. */
  expireGoogleSyncTokens(refreshToken: string, calendarId: string): void {
    const calendar = this.googleCalendar(refreshToken, calendarId);
    calendar.version += 1;
    calendar.minValidVersion = calendar.version;
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

  /** Every `events.watch` of this account fails with `error` until `clearWatchFailure` is called. */
  failWatches(refreshToken: string, error: Error): void {
    this.failingWatches.set(refreshToken, error);
  }

  clearWatchFailure(refreshToken: string): void {
    this.failingWatches.delete(refreshToken);
  }

  /** The channels of a calendar that Google would still deliver to. */
  activeWatchChannels(calendarId: string): FakeWatchChannel[] {
    return this.watchChannels.filter(
      (channel) => channel.calendarId === calendarId && !channel.stopped && channel.expiresAt > this.clock.now(),
    );
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
      putObject: async (calendarUrl, input) => {
        if (input.href !== null && this.beforeNextApplePut) {
          const change = this.beforeNextApplePut;
          this.beforeNextApplePut = null;
          change();
        }
        const calendar = this.appleCalendar(appleId ?? '', calendarUrl);
        const href = input.href ?? `${calendarUrl}${input.uid}.ics`;
        if (input.href !== null) {
          const existing = calendar.objects.get(href);
          if (!existing) {
            throw new AppleObjectNotFoundError(href);
          }
          if (existing.etag !== input.etag) {
            throw new ApplePreconditionFailedError(href);
          }
        }
        this.appleWrites.push({ kind: 'put', href });
        const etag = this.next('etag');
        calendar.objects.set(href, { etag, ics: input.ics });
        calendar.ctag = this.next('ctag');
        return { href, etag };
      },
      deleteObject: async (href, etag) => {
        const calendar = [...this.appleCalendarsOf(appleId).values()].find((c) => c.objects.has(href));
        const existing = calendar?.objects.get(href);
        if (!calendar || !existing) {
          throw new AppleObjectNotFoundError(href);
        }
        if (existing.etag !== etag) {
          throw new ApplePreconditionFailedError(href);
        }
        this.appleWrites.push({ kind: 'delete', href });
        calendar.objects.delete(href);
        calendar.ctag = this.next('ctag');
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
      watch: async (calendarId, request) => {
        authenticate();
        const failure = this.failingWatches.get(token);
        if (failure) {
          throw failure;
        }
        const channel: FakeWatchChannel = {
          id: request.channelId,
          resourceId: `resource-${this.next('res')}`,
          calendarId,
          address: request.address,
          token: request.token,
          expiresAt: this.clock.now() + this.watchLifetimeMs,
          stopped: false,
        };
        this.watchChannels.push(channel);
        await this.onWatch?.(channel);
        return { resourceId: channel.resourceId, expiresAt: channel.expiresAt };
      },
      stopWatch: async (channelId) => {
        authenticate();
        const channel = this.watchChannels.find((candidate) => candidate.id === channelId);
        if (channel) {
          channel.stopped = true;
        }
      },
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
      listChanges: async (calendarId, syncToken) => {
        this.trace.push(`google.changes:${token}:${calendarId}:${syncToken ?? 'full'}`);
        authenticate();
        const calendar = this.googleCalendar(token, calendarId);
        const nextSyncToken = `st-${calendar.version}`;
        if (syncToken === null) {
          return { events: this.googleEvents(token, calendarId), deletedIds: [], nextSyncToken };
        }
        const since = Number(syncToken.replace('st-', ''));
        if (Number.isNaN(since) || since < calendar.minValidVersion) {
          throw new GoogleSyncTokenExpiredError();
        }
        return {
          events: [...calendar.events.values()].filter((e) => (calendar.changedAt.get(e.id) ?? 0) > since),
          deletedIds: [...calendar.deletedAt].filter(([, at]) => at > since).map(([id]) => id),
          nextSyncToken,
        };
      },
      insertEvent: async (calendarId, draft, options) => {
        // As in Google, an overridden occurrence is the occurrence itself changed: writing it again
        // replaces the one that is there instead of adding a second
        const instance = draft.recurringEventId
          ? [...this.googleCalendar(token, calendarId).events.values()].find(
              (existing) =>
                existing.recurringEventId === draft.recurringEventId &&
                instantOf(existing.originalStartTime) === instantOf(draft.originalStartTime),
            )
          : undefined;
        if (instance) {
          await beforeWrite({ kind: 'update', calendarId, eventId: instance.id, sendUpdates: options.sendUpdates });
          const replaced: GoogleEvent = { ...draft, id: instance.id };
          this.storeGoogleEvent(this.googleCalendar(token, calendarId), replaced);
          return replaced;
        }
        await beforeWrite({ kind: 'insert', calendarId, eventId: null, sendUpdates: options.sendUpdates });
        const event: GoogleEvent = { ...draft, id: this.next('evt') };
        this.storeGoogleEvent(this.googleCalendar(token, calendarId), event);
        return event;
      },
      updateEvent: async (calendarId, eventId, draft, options) => {
        await beforeWrite({ kind: 'update', calendarId, eventId, sendUpdates: options.sendUpdates });
        const calendar = this.googleCalendar(token, calendarId);
        if (!calendar.events.has(eventId)) {
          throw new GoogleEventNotFoundError(eventId);
        }
        const event: GoogleEvent = { ...draft, id: eventId };
        this.storeGoogleEvent(calendar, event);
        return event;
      },
      deleteEvent: async (calendarId, eventId, options) => {
        await beforeWrite({ kind: 'delete', calendarId, eventId, sendUpdates: options.sendUpdates });
        const calendar = this.googleCalendar(token, calendarId);
        if (!calendar.events.has(eventId)) {
          throw new GoogleEventNotFoundError(eventId);
        }
        this.dropGoogleEvent(calendar, eventId);
      },
    };
  }

  // ---- internals ---------------------------------------------------------------------------

  private storeGoogleEvent(calendar: GoogleCalendarState, event: GoogleEvent): void {
    calendar.version += 1;
    calendar.events.set(event.id, event);
    calendar.changedAt.set(event.id, calendar.version);
    calendar.deletedAt.delete(event.id);
  }

  /** Deleting a series also removes its overridden occurrences. */
  private dropGoogleEvent(calendar: GoogleCalendarState, eventId: string): void {
    for (const [id, event] of [...calendar.events]) {
      if (id === eventId || event.recurringEventId === eventId) {
        calendar.version += 1;
        calendar.events.delete(id);
        calendar.changedAt.delete(id);
        calendar.deletedAt.set(id, calendar.version);
      }
    }
  }

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
