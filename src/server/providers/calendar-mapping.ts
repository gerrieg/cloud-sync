import type { calendar_v3 } from 'googleapis';
import type { DAVCalendar } from 'tsdav';
import type { AppleCalendarInfo, GoogleDateTime, GoogleEvent, GoogleEventDraft } from './calendar-types.js';

/** Reminder lists (VTODO-only collections) are not event calendars. */
export function isEventCalendar(calendar: DAVCalendar): boolean {
  return !calendar.components || calendar.components.includes('VEVENT');
}

export function describeAppleCalendar(calendar: DAVCalendar): AppleCalendarInfo {
  // Apple marks calendar subscriptions with a `subscribed` resource type; they are read-only.
  const resourceTypes = Object.keys(calendar.resourcetype ?? {}).map((key) => key.toLowerCase());
  const subscribed = resourceTypes.some((type) => type.includes('subscribed'));
  return {
    url: calendar.url,
    name: typeof calendar.displayName === 'string' ? calendar.displayName : calendar.url,
    ctag: calendar.ctag ?? null,
    readOnly: subscribed,
    subscribed,
  };
}

export function toApiEvent(draft: GoogleEventDraft): calendar_v3.Schema$Event {
  return {
    summary: draft.summary,
    description: draft.description,
    location: draft.location,
    start: { ...draft.start },
    end: { ...draft.end },
    recurrence: draft.recurrence ? [...draft.recurrence] : undefined,
    reminders: { useDefault: false, overrides: draft.reminders.overrides.map((r) => ({ ...r })) },
    // Google generates its own iCalUID on insert; keep the Apple UID for later matching
    extendedProperties: { private: { appleUid: draft.iCalUID } },
  };
}

export function fromApiEvent(event: calendar_v3.Schema$Event): GoogleEvent {
  const toDateTime = (value: calendar_v3.Schema$EventDateTime | undefined): GoogleDateTime => ({
    ...(value?.date ? { date: value.date } : {}),
    ...(value?.dateTime ? { dateTime: value.dateTime } : {}),
    ...(value?.timeZone ? { timeZone: value.timeZone } : {}),
  });
  return {
    id: event.id ?? '',
    summary: event.summary ?? '',
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    start: toDateTime(event.start ?? undefined),
    end: toDateTime(event.end ?? undefined),
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.originalStartTime ? { originalStartTime: toDateTime(event.originalStartTime) } : {}),
    iCalUID: event.extendedProperties?.private?.appleUid ?? event.iCalUID ?? '',
    reminders: {
      useDefault: false,
      overrides: (event.reminders?.overrides ?? []).flatMap((r) =>
        r.method && r.minutes !== null && r.minutes !== undefined
          ? [{ method: r.method === 'email' ? ('email' as const) : ('popup' as const), minutes: r.minutes }]
          : [],
      ),
    },
  };
}

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** The offset of a time zone at an instant, in ms: what a wall clock there shows minus UTC. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const wallClock = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wallClock - Math.floor(instant / 1000) * 1000;
}

/** A wall-clock time like `2026-03-24T10:00:00` in a named zone, as an instant (the server's own zone plays no part). */
function zonedInstant(wallClock: string, timeZone: string): number | null {
  const asUtc = Date.parse(`${wallClock}Z`);
  if (Number.isNaN(asUtc)) {
    return null;
  }
  try {
    // The offset is read at the first guess, then again at the corrected instant, which settles DST changes
    const guess = asUtc - zoneOffsetMs(asUtc, timeZone);
    return asUtc - zoneOffsetMs(guess, timeZone);
  } catch {
    return null; // not an IANA zone
  }
}

export function instantOf(value: calendar_v3.Schema$EventDateTime | GoogleDateTime | undefined): number | null {
  if (value?.dateTime) {
    if (value.timeZone && !HAS_OFFSET.test(value.dateTime)) {
      const zoned = zonedInstant(value.dateTime, value.timeZone);
      if (zoned !== null) {
        return zoned;
      }
    }
    return new Date(value.dateTime).getTime();
  }
  return value?.date ? new Date(`${value.date}T00:00:00Z`).getTime() : null;
}
