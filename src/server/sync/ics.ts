import ICAL from 'ical.js';
import type {
  GoogleDateTime,
  GoogleEventDraft,
  GoogleReminder,
} from '../providers/calendar-types.js';

export interface TranslateOptions {
  readonly syncReminders: boolean;
  /** The Profile's Apple ID; invitations organized by anyone else are flagged. */
  readonly appleId: string;
}

export interface TranslatedCalendarObject {
  readonly uid: string;
  readonly master: GoogleEventDraft;
  /** Overridden occurrences of a recurring series (iCal RECURRENCE-ID). */
  readonly exceptions: readonly GoogleEventDraft[];
  readonly foreignInvitation: boolean;
  /** End of the last occurrence in epoch ms, or null when the series never ends. */
  readonly lastEndMs: number | null;
  /** Normalized start for fallback matching: UTC instant, or `YYYY-MM-DD` for all-day events. */
  readonly matchStart: string;
}

const MAX_REMINDER_MINUTES = 40_320; // Google: four weeks
const MAX_REMINDERS = 5; // Google: at most five reminder overrides per event
const MAX_OCCURRENCES = 10_000;

function unfold(line: string): string {
  return line.replace(/\r?\n[ \t]/g, '');
}

function isIanaZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wall-clock fields plus zone. Floating times are treated as UTC, and zones Google cannot name
 * (custom Apple zones such as `GMT+0100`) are converted to the equivalent UTC instant.
 */
function toGoogleDateTime(time: ICAL.Time, tzid: string | null): GoogleDateTime {
  if (time.isDate) {
    return { date: time.toString() };
  }
  if (time.zone === ICAL.Timezone.utcTimezone) {
    return { dateTime: time.toString(), timeZone: 'UTC' };
  }
  if (tzid && isIanaZone(tzid)) {
    return { dateTime: time.toString(), timeZone: tzid };
  }
  if (tzid) {
    const utc = new Date(time.toUnixTime() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return { dateTime: utc, timeZone: 'UTC' };
  }
  return { dateTime: `${time.toString()}Z`, timeZone: 'UTC' };
}

function tzidOf(component: ICAL.Component, property: string): string | null {
  const value = component.getFirstProperty(property)?.getParameter('tzid');
  return typeof value === 'string' ? value : null;
}

function readReminders(vevent: ICAL.Component): GoogleReminder[] {
  const reminders: GoogleReminder[] = [];
  for (const alarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstPropertyValue('trigger');
    if (!(trigger instanceof ICAL.Duration)) {
      continue; // absolute triggers have no Google equivalent
    }
    const minutes = Math.round(-trigger.toSeconds() / 60);
    if (minutes < 0 || minutes > MAX_REMINDER_MINUTES) {
      continue;
    }
    const action = String(alarm.getFirstPropertyValue('action') ?? '').toUpperCase();
    const method = action === 'EMAIL' ? 'email' : 'popup';
    if (!reminders.some((r) => r.method === method && r.minutes === minutes)) {
      reminders.push({ method, minutes });
    }
  }
  return reminders;
}

function buildDraft(vevent: ICAL.Component, options: TranslateOptions): GoogleEventDraft {
  const event = new ICAL.Event(vevent);
  const startTzid = tzidOf(vevent, 'dtstart');
  const endTzid = tzidOf(vevent, 'dtend') ?? startTzid;
  const recurrence = ['rrule', 'exdate'].flatMap((name) =>
    vevent.getAllProperties(name).map((property) => unfold(property.toICALString())),
  );

  return {
    summary: event.summary ?? '',
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    start: toGoogleDateTime(event.startDate, startTzid),
    end: toGoogleDateTime(event.endDate, endTzid),
    ...(recurrence.length > 0 ? { recurrence } : {}),
    ...(event.isRecurrenceException()
      ? { originalStartTime: toGoogleDateTime(event.recurrenceId, tzidOf(vevent, 'recurrence-id')) }
      : {}),
    iCalUID: event.uid,
    reminders: {
      useDefault: false,
      overrides: options.syncReminders ? readReminders(vevent).slice(0, MAX_REMINDERS) : [],
    },
  };
}

function lastEndMs(vevent: ICAL.Component): number | null {
  const event = new ICAL.Event(vevent);
  const durationMs = (event.endDate.toUnixTime() - event.startDate.toUnixTime()) * 1000;

  if (!event.isRecurring()) {
    return event.endDate.toUnixTime() * 1000;
  }

  const rules = vevent.getAllProperties('rrule').map((p) => p.getFirstValue() as ICAL.Recur);
  if (rules.some((rule) => !rule.isFinite())) {
    return null;
  }

  const iterator = event.iterator();
  let last: ICAL.Time | null = null;
  for (let i = 0; i < MAX_OCCURRENCES; i += 1) {
    const next = iterator.next();
    if (!next) {
      break;
    }
    last = next;
  }
  const lastStartMs = (last ?? event.startDate).toUnixTime() * 1000;
  return lastStartMs + durationMs;
}

function matchStartOf(time: ICAL.Time): string {
  return time.isDate ? time.toString() : new Date(time.toUnixTime() * 1000).toISOString();
}

function isForeign(vevent: ICAL.Component, appleId: string): boolean {
  const organizer = vevent.getFirstPropertyValue('organizer');
  if (typeof organizer !== 'string' || organizer === '') {
    return false;
  }
  const address = organizer.replace(/^mailto:/i, '').trim().toLowerCase();
  return address !== appleId.trim().toLowerCase();
}

/** Translates one Apple CalDAV resource (a series with its overrides) into Google event drafts. */
export function translateIcs(ics: string, options: TranslateOptions): TranslatedCalendarObject {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  for (const timezone of calendar.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(timezone);
  }

  const vevents = calendar.getAllSubcomponents('vevent');
  if (vevents.length === 0) {
    throw new Error('Calendar data contains no VEVENT');
  }

  const isOverride = (vevent: ICAL.Component) => vevent.hasProperty('recurrence-id');
  const master = vevents.find((vevent) => !isOverride(vevent)) ?? vevents[0];
  const overrides = vevents.filter((vevent) => vevent !== master && isOverride(vevent));

  const draft = buildDraft(master, options);
  // A lone override (e.g. an invitation to a single occurrence) stands on its own
  const standalone = isOverride(master) ? { ...draft, originalStartTime: undefined } : draft;
  const masterEvent = new ICAL.Event(master);

  return {
    uid: masterEvent.uid,
    master: standalone,
    exceptions: overrides.map((vevent) => buildDraft(vevent, options)),
    foreignInvitation: isForeign(master, options.appleId),
    lastEndMs: lastEndMs(master),
    matchStart: matchStartOf(masterEvent.startDate),
  };
}
