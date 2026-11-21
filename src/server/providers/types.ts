import type { AppleConnectionReport } from '../../shared/profile.js';
import type {
  AppleCalendarInfo,
  AppleCalendarObject,
  AppleObjectRef,
  AppleObjectWrite,
  GoogleCalendarInfo,
  GoogleEvent,
  GoogleEventChanges,
  GoogleEventDraft,
  GoogleWriteOptions,
} from './calendar-types.js';
import type {
  AppleContactBook,
  AppleContactWrite,
  GoogleContact,
  GoogleContactChanges,
  GoogleContactGroupInfo,
  GoogleContactWrite,
} from './contact-types.js';

export interface AppleCredentials {
  readonly appleId: string;
  readonly appPassword: string;
}

export interface GoogleTokens {
  readonly refresh_token: string;
  readonly access_token?: string;
  readonly expiry_date?: number;
  readonly scope?: string;
}

export const GOOGLE_INVALID_GRANT = 'invalid_grant';

export class GoogleAuthError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

/**
 * The single external I/O boundary, instantiated per Profile.
 * Production wires tsdav / imapflow / googleapis adapters; tests inject stateful fakes.
 */
export interface SyncProviders {
  readonly apple: {
    /** Checks CalDAV, CardDAV and IMAP simultaneously; never throws for per-protocol failures. */
    testConnection(): Promise<AppleConnectionReport>;
    readonly calendars: {
      list(): Promise<AppleCalendarInfo[]>;
      /** All events of one calendar with their ETags. */
      listObjects(calendarUrl: string): Promise<AppleCalendarObject[]>;
      /**
       * Creates (`href` null) or conditionally overwrites a resource and returns its new identity.
       * Throws ApplePreconditionFailedError when `etag` no longer matches.
       */
      putObject(calendarUrl: string, input: AppleObjectWrite): Promise<AppleObjectRef>;
      /**
       * Throws AppleObjectNotFoundError if the resource is gone and ApplePreconditionFailedError
       * when `etag` no longer matches.
       */
      deleteObject(href: string, etag: string): Promise<void>;
    };
    /** The single iCloud address book: contacts and contact groups are vCards in it. */
    readonly contacts: {
      list(): Promise<AppleContactBook>;
      /** Same contract as the calendar `putObject`: typed errors for 412 and 404. */
      putObject(input: AppleContactWrite): Promise<AppleObjectRef>;
      deleteObject(href: string, etag: string): Promise<void>;
    };
  };
  readonly google: {
    buildAuthUrl(input: { readonly redirectUri: string; readonly state: string }): string;
    /** Throws GoogleAuthError (e.g. `invalid_grant`) when Google rejects the code. */
    exchangeCode(input: {
      readonly code: string;
      readonly redirectUri: string;
    }): Promise<GoogleTokens>;
    /** Calendar calls throw GoogleAuthError (`invalid_grant`) when the stored authorization is dead. */
    readonly calendars: {
      list(): Promise<GoogleCalendarInfo[]>;
      listEvents(calendarId: string): Promise<GoogleEvent[]>;
      /**
       * Everything that changed since `syncToken`, or a full listing when it is null. Throws
       * GoogleSyncTokenExpiredError when Google answers HTTP 410 Gone for a stale token.
       */
      listChanges(calendarId: string, syncToken: string | null): Promise<GoogleEventChanges>;
      /** With `recurringEventId` + `originalStartTime` this overrides that occurrence of the series. */
      insertEvent(
        calendarId: string,
        draft: GoogleEventDraft,
        options: GoogleWriteOptions,
      ): Promise<GoogleEvent>;
      /** Throws GoogleEventNotFoundError if the event no longer exists. */
      updateEvent(
        calendarId: string,
        eventId: string,
        draft: GoogleEventDraft,
        options: GoogleWriteOptions,
      ): Promise<GoogleEvent>;
      /** Throws GoogleEventNotFoundError if the event no longer exists. */
      deleteEvent(calendarId: string, eventId: string, options: GoogleWriteOptions): Promise<void>;
    };
    /** People API calls are throttled to about one per second per Profile by the adapter. */
    readonly contacts: {
      /** The user's own contact groups (labels). */
      listGroups(): Promise<GoogleContactGroupInfo[]>;
      /** Same contract as the calendar `listChanges`: null token = full listing, stale = expired error. */
      listChanges(syncToken: string | null): Promise<GoogleContactChanges>;
      create(write: GoogleContactWrite): Promise<GoogleContact>;
      /** Throws GoogleContactNotFoundError if the contact no longer exists. */
      update(resourceName: string, write: GoogleContactWrite): Promise<GoogleContact>;
      /** Throws GoogleContactNotFoundError if the contact no longer exists. */
      delete(resourceName: string): Promise<void>;
      updatePhoto(resourceName: string, photo: Buffer): Promise<void>;
    };
  };
}

export interface SyncProvidersContext {
  readonly profileId: string;
  readonly apple: AppleCredentials | null;
  readonly googleTokens: GoogleTokens | null;
}

export type SyncProvidersFactory = (context: SyncProvidersContext) => SyncProviders;
