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

export function instantOf(value: calendar_v3.Schema$EventDateTime | GoogleDateTime | undefined): number | null {
  if (value?.dateTime) {
    return new Date(value.dateTime).getTime();
  }
  return value?.date ? new Date(`${value.date}T00:00:00Z`).getTime() : null;
}
