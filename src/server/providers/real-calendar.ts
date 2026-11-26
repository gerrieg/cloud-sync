import { google, type calendar_v3 } from 'googleapis';
import type {
  AppleCalendarObject,
  GoogleCalendarInfo,
  GoogleEvent,
  GoogleEventDraft,
  GoogleWriteOptions,
} from './calendar-types.js';
import {
  AppleObjectNotFoundError,
  ApplePreconditionFailedError,
  GoogleEventNotFoundError,
  GoogleSyncTokenExpiredError,
} from './calendar-types.js';
import { describeAppleCalendar, fromApiEvent, instantOf, isEventCalendar, toApiEvent } from './calendar-mapping.js';
import { createDavSession, createGoogleClient, type GoogleClientConfig } from './client-helpers.js';
import { httpStatus, translateGoogleError } from './google-errors.js';
import type { AppleCredentials, GoogleTokens, SyncProviders } from './types.js';

export type { GoogleClientConfig };

const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com';

type AppleCalendars = SyncProviders['apple']['calendars'];
type GoogleCalendars = SyncProviders['google']['calendars'];

export function createRealAppleCalendars(credentials: AppleCredentials | null): AppleCalendars {
  const connect = createDavSession(ICLOUD_CALDAV_URL, 'caldav', credentials);

  return {
    async list() {
      const client = await connect();
      return (await client.fetchCalendars()).filter(isEventCalendar).map(describeAppleCalendar);
    },
    async listObjects(calendarUrl): Promise<AppleCalendarObject[]> {
      const client = await connect();
      const objects = await client.fetchCalendarObjects({ calendar: { url: calendarUrl } });
      return objects.flatMap((object) =>
        typeof object.data === 'string'
          ? [{ href: object.url, etag: object.etag ?? '', ics: object.data }]
          : [],
      );
    },
    async putObject(calendarUrl, input) {
      const client = await connect();
      const calendar = { url: calendarUrl };
      const href = input.href ?? new URL(`${encodeURIComponent(input.uid)}.ics`, calendarUrl).href;
      const response =
        input.href === null
          ? await client.createCalendarObject({
              calendar,
              filename: href.slice(href.lastIndexOf('/') + 1),
              iCalString: input.ics,
            })
          : await client.updateCalendarObject({
              calendarObject: { url: href, data: input.ics, etag: input.etag ?? undefined },
            });
      assertCalDavWrite(response, href);

      // iCloud does not always answer a PUT with the new ETag: read it back
      const etag =
        response.headers.get('etag') ??
        (await client.fetchCalendarObjects({ calendar, objectUrls: [href] }))[0]?.etag;
      if (!etag) {
        throw new Error(`CalDAV did not report an ETag for ${href}`);
      }
      return { href, etag };
    },
    async deleteObject(href, etag) {
      const client = await connect();
      const response = await client.deleteCalendarObject({ calendarObject: { url: href, etag } });
      assertCalDavWrite(response, href);
    },
  };
}

/** Maps the status of a CalDAV write to the typed errors of the SyncProviders seam. */
export function assertCalDavWrite(response: Response, href: string): void {
  if (response.ok) {
    return;
  }
  if (response.status === 404 || response.status === 410) {
    throw new AppleObjectNotFoundError(href);
  }
  if (response.status === 412) {
    throw new ApplePreconditionFailedError(href);
  }
  throw new Error(`CalDAV write to ${href} failed (${response.status})`);
}

async function guarded<T>(
  limit: <R>(call: () => Promise<R>) => Promise<R>,
  call: () => Promise<T>,
  eventId?: string,
): Promise<T> {
  try {
    return await limit(call);
  } catch (error) {
    throw translateGoogleError(
      error,
      eventId === undefined ? undefined : { statuses: [404, 410], error: () => new GoogleEventNotFoundError(eventId) },
    );
  }
}

export function createRealGoogleCalendars(
  config: GoogleClientConfig,
  tokens: GoogleTokens | null,
  /** Spaces the calls of one Profile and repeats the ones Google rate-limits (see `createGoogleThrottle`). */
  limit: <T>(call: () => Promise<T>) => Promise<T>,
  /** Stands in for the Google client, for tests. */
  makeClient?: () => calendar_v3.Calendar,
  onTokensRefreshed?: (tokens: GoogleTokens) => void,
): GoogleCalendars {
  const guard = <T>(call: () => Promise<T>, eventId?: string) => guarded(limit, call, eventId);
  const client = createGoogleClient(
    config,
    tokens,
    (auth) => google.calendar({ version: 'v3', auth }),
    makeClient,
    onTokensRefreshed,
  );

  /** Occurrences of a series are separate Google events: find the one to override. */
  async function findInstance(calendarId: string, draft: GoogleEventDraft): Promise<string> {
    const wanted = instantOf(draft.originalStartTime);
    const masterId = draft.recurringEventId ?? '';
    const response = await guard(() =>
      client().events.instances({
        calendarId,
        eventId: masterId,
        timeMin: new Date((wanted ?? 0) - 86_400_000).toISOString(),
        timeMax: new Date((wanted ?? 0) + 86_400_000).toISOString(),
      }),
    );
    const match = (response.data.items ?? []).find(
      (item) => instantOf(item.originalStartTime ?? undefined) === wanted,
    );
    if (!match?.id) {
      throw new GoogleEventNotFoundError(masterId);
    }
    return match.id;
  }

  /** Full replace (`update`, not `patch`), so fields removed in Apple are cleared in Google too. */
  async function replaceEvent(
    calendarId: string,
    eventId: string,
    draft: GoogleEventDraft,
    options: GoogleWriteOptions,
  ): Promise<GoogleEvent> {
    const response = await guard(
      () =>
        client().events.update({
          calendarId,
          eventId,
          sendUpdates: options.sendUpdates,
          requestBody: toApiEvent(draft),
        }),
      eventId,
    );
    return fromApiEvent(response.data);
  }

  return {
    async list(): Promise<GoogleCalendarInfo[]> {
      const response = await guard(() => client().calendarList.list({ maxResults: 250 }));
      return (response.data.items ?? []).map((item) => ({
        id: item.id ?? '',
        name: item.summaryOverride ?? item.summary ?? item.id ?? '',
        primary: item.primary === true,
        writable: item.accessRole === 'owner' || item.accessRole === 'writer',
      }));
    },
    async listEvents(calendarId) {
      const events: GoogleEvent[] = [];
      let pageToken: string | undefined;
      do {
        const response = await guard(() =>
          client().events.list({ calendarId, maxResults: 2500, singleEvents: false, pageToken }),
        );
        events.push(...(response.data.items ?? []).map(fromApiEvent));
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);
      return events;
    },
    async listChanges(calendarId, syncToken) {
      const events: GoogleEvent[] = [];
      const deletedIds: string[] = [];
      let nextSyncToken: string | undefined;
      let pageToken: string | undefined;
      try {
        do {
          const response = await guard(() =>
            client().events.list({
              calendarId,
              maxResults: 2500,
              singleEvents: false,
              pageToken,
              ...(syncToken ? { syncToken } : {}),
            }),
          );
          for (const item of response.data.items ?? []) {
            if (item.status === 'cancelled') {
              if (item.id) {
                deletedIds.push(item.id);
              }
            } else {
              events.push(fromApiEvent(item));
            }
          }
          nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
          pageToken = response.data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (error) {
        // HTTP 410 Gone: the token is stale and the caller must list everything again
        if (syncToken && httpStatus(error) === 410) {
          throw new GoogleSyncTokenExpiredError();
        }
        throw error;
      }
      if (!nextSyncToken) {
        throw new Error('Google did not return a sync token');
      }
      return { events, deletedIds, nextSyncToken };
    },
    async insertEvent(calendarId, draft, options) {
      if (draft.recurringEventId) {
        return replaceEvent(calendarId, await findInstance(calendarId, draft), draft, options);
      }
      const response = await guard(() =>
        client().events.insert({
          calendarId,
          sendUpdates: options.sendUpdates,
          requestBody: toApiEvent(draft),
        }),
      );
      return fromApiEvent(response.data);
    },
    updateEvent: replaceEvent,
    async deleteEvent(calendarId, eventId, options) {
      await guard(
        () => client().events.delete({ calendarId, eventId, sendUpdates: options.sendUpdates }),
        eventId,
      );
    },
    async watch(calendarId, { channelId, address, token }) {
      const response = await guard(() =>
        client().events.watch({
          calendarId,
          requestBody: { id: channelId, type: 'web_hook', address, token },
        }),
      );
      const expiresAt = Number(response.data.expiration);
      if (!response.data.resourceId || !Number.isFinite(expiresAt)) {
        throw new Error('Google did not describe the notification channel');
      }
      return { resourceId: response.data.resourceId, expiresAt };
    },
    async stopWatch(channelId, resourceId) {
      try {
        await guard(() => client().channels.stop({ requestBody: { id: channelId, resourceId } }));
      } catch (error) {
        if (httpStatus(error) !== 404) {
          throw error;
        }
      }
    },
  };
}
