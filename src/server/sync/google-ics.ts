import ICAL from 'ical.js';
import type { GoogleDateTime, GoogleEvent } from '../providers/calendar-types.js';
import { googleStartKey } from './google-events.js';

/**
 * Google → Apple translation. Times are written in UTC (Apple shows them in the device zone), so
 * no VTIMEZONE is needed; a recurring event that is moved in Google therefore loses its
 * wall-clock anchoring across DST changes.
 */

function timeOf(value: GoogleDateTime): ICAL.Time {
  return value.date
    ? ICAL.Time.fromDateString(value.date)
    : ICAL.Time.fromJSDate(new Date(value.dateTime ?? ''), true);
}

function setTime(vevent: ICAL.Component, name: 'dtstart' | 'dtend', value: GoogleDateTime): void {
  vevent.removeAllProperties(name);
  const property = new ICAL.Property(name);
  property.setValue(timeOf(value));
  vevent.addProperty(property);
}

function setText(vevent: ICAL.Component, name: string, value: string | undefined): void {
  vevent.removeAllProperties(name);
  if (value) {
    vevent.addPropertyWithValue(name, value);
  }
}

function currentKey(time: ICAL.Time): string {
  return time.isDate ? time.toString() : new Date(time.toUnixTime() * 1000).toISOString();
}

function stamp(vevent: ICAL.Component, nowMs: number): void {
  const now = ICAL.Time.fromJSDate(new Date(nowMs), true);
  vevent.removeAllProperties('dtstamp');
  vevent.addPropertyWithValue('dtstamp', now);
  vevent.removeAllProperties('last-modified');
  vevent.addPropertyWithValue('last-modified', now);
}

/**
 * Applies the synced fields of a Google event to an existing Apple resource. Everything Google
 * does not model (attendees, alarms, overridden occurrences, time zones of untouched times, …)
 * stays exactly as Apple has it. Throws when `ics` is not a usable calendar resource.
 */
export function patchIcsWithGoogle(ics: string, event: GoogleEvent, nowMs: number): string {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  const vevents = calendar.getAllSubcomponents('vevent');
  const master = vevents.find((vevent) => !vevent.hasProperty('recurrence-id')) ?? vevents[0];
  if (!master) {
    throw new Error('Calendar data contains no VEVENT');
  }

  setText(master, 'summary', event.summary);
  setText(master, 'description', event.description);
  setText(master, 'location', event.location);

  const apple = new ICAL.Event(master);
  if (googleStartKey(event.start) !== currentKey(apple.startDate)) {
    setTime(master, 'dtstart', event.start);
  }
  if (googleStartKey(event.end) !== currentKey(apple.endDate)) {
    setTime(master, 'dtend', event.end);
  }
  stamp(master, nowMs);
  return calendar.toString();
}

/** Builds a new Apple resource for an event that only exists in Google. */
export function googleEventToIcs(event: GoogleEvent, uid: string, nowMs: number): string {
  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.addPropertyWithValue('version', '2.0');
  calendar.addPropertyWithValue('prodid', '-//cloud-sync//EN');
  calendar.addPropertyWithValue('calscale', 'GREGORIAN');

  const vevent = new ICAL.Component('vevent');
  vevent.addPropertyWithValue('uid', uid);
  setText(vevent, 'summary', event.summary);
  setText(vevent, 'description', event.description);
  setText(vevent, 'location', event.location);
  setTime(vevent, 'dtstart', event.start);
  setTime(vevent, 'dtend', event.end);
  for (const line of event.recurrence ?? []) {
    if (/^(RRULE|EXDATE)[:;]/i.test(line)) {
      vevent.addProperty(new ICAL.Property(ICAL.parse.property(line)));
    }
  }
  stamp(vevent, nowMs);
  calendar.addSubcomponent(vevent);
  return calendar.toString();
}
