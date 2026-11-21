import { describe, expect, it } from 'vitest';
import { translateIcs } from '../../src/server/sync/ics.js';
import { icsFixture as fixture } from '../helpers/fixtures.js';

const OPTIONS = { syncReminders: false, appleId: 'anna@icloud.com' } as const;

describe('Apple .ics → Google event translation', () => {
  it('translates a timed event with TZID, location and description, with reminders off by default', () => {
    const result = translateIcs(fixture('timed-berlin.ics'), OPTIONS);

    expect(result.uid).toBe('4F6C2B1A-0001-4B1E-9A11-AAAAAAAAAAAA');
    expect(result.master).toEqual({
      summary: 'Zahnarzt',
      description: 'Kontrolle und Zahnreinigung',
      location: 'Praxis Dr. Meier, Hauptstraße 1',
      start: { dateTime: '2026-03-10T10:00:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-03-10T11:00:00', timeZone: 'Europe/Berlin' },
      iCalUID: '4F6C2B1A-0001-4B1E-9A11-AAAAAAAAAAAA',
      reminders: { useDefault: false, overrides: [] },
    });
    expect(result.exceptions).toEqual([]);
    expect(result.foreignInvitation).toBe(false);
  });

  it('carries VALARM reminders over only when reminders are opted in', () => {
    const on = translateIcs(fixture('timed-berlin.ics'), { ...OPTIONS, syncReminders: true });
    expect(on.master.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 15 }],
    });

    const off = translateIcs(fixture('timed-berlin.ics'), OPTIONS);
    expect(off.master.reminders.overrides).toEqual([]);
  });

  it('translates all-day events to date values with an exclusive end date', () => {
    const result = translateIcs(fixture('all-day.ics'), OPTIONS);

    expect(result.master.start).toEqual({ date: '2026-03-20' });
    expect(result.master.end).toEqual({ date: '2026-03-21' });
    expect(result.matchStart).toBe('2026-03-20');
    expect(result.lastEndMs).toBe(Date.UTC(2026, 2, 21));
  });

  it('translates UTC times', () => {
    const result = translateIcs(fixture('utc.ics'), OPTIONS);

    expect(result.master.start).toEqual({ dateTime: '2026-04-01T08:00:00Z', timeZone: 'UTC' });
    expect(result.master.end).toEqual({ dateTime: '2026-04-01T08:30:00Z', timeZone: 'UTC' });
  });

  it('maps RRULE and EXDATE to the series and RECURRENCE-ID overrides to exceptions', () => {
    const result = translateIcs(fixture('recurring-with-exception.ics'), OPTIONS);

    expect(result.master.recurrence).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'EXDATE;TZID=Europe/Berlin:20260317T100000',
    ]);
    expect(result.master.summary).toBe('Teamrunde');
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toMatchObject({
      summary: 'Teamrunde (verschoben)',
      start: { dateTime: '2026-03-24T14:00:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-03-24T15:00:00', timeZone: 'Europe/Berlin' },
      originalStartTime: { dateTime: '2026-03-24T10:00:00', timeZone: 'Europe/Berlin' },
      iCalUID: '4F6C2B1A-0004-4B1E-9A11-DDDDDDDDDDDD',
    });
    expect(result.exceptions[0].recurrence).toBeUndefined();
  });

  it('reports when a series ends: never for open-ended rules, at the last occurrence for COUNT', () => {
    expect(translateIcs(fixture('recurring-with-exception.ics'), OPTIONS).lastEndMs).toBeNull();
    // Third Tuesday occurrence (17 March 2026, 11:00 CET) ends at 10:00 UTC
    expect(translateIcs(fixture('recurring-count.ics'), OPTIONS).lastEndMs).toBe(
      Date.UTC(2026, 2, 17, 10, 0, 0),
    );
    expect(translateIcs(fixture('timed-berlin.ics'), OPTIONS).lastEndMs).toBe(
      Date.UTC(2026, 2, 10, 10, 0, 0),
    );
  });

  it('exposes the start as a normalized UTC instant for fallback matching', () => {
    expect(translateIcs(fixture('timed-berlin.ics'), OPTIONS).matchStart).toBe(
      '2026-03-10T09:00:00.000Z',
    );
  });

  it('flags invitations whose organizer is not the Profile Apple ID (case-insensitive for own)', () => {
    expect(translateIcs(fixture('foreign-invitation.ics'), OPTIONS).foreignInvitation).toBe(true);
    expect(
      translateIcs(fixture('timed-berlin.ics'), { ...OPTIONS, appleId: 'ANNA@icloud.com' })
        .foreignInvitation,
    ).toBe(false);
  });

  it('converts non-IANA time zones (e.g. Apple GMT+0100) to UTC, which Google would reject as a zone name', () => {
    const result = translateIcs(fixture('custom-timezone.ics'), OPTIONS);

    expect(result.master.start).toEqual({ dateTime: '2026-03-10T09:00:00Z', timeZone: 'UTC' });
    expect(result.master.end).toEqual({ dateTime: '2026-03-10T10:00:00Z', timeZone: 'UTC' });
  });

  it('keeps at most five reminders, the limit Google accepts', () => {
    const alarms = [5, 10, 15, 30, 60, 120]
      .map((m) => `BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT${m}M\r\nEND:VALARM\r\n`)
      .join('');
    const ics = fixture('timed-berlin.ics').replace(/BEGIN:VALARM[\s\S]*END:VALARM\r\n/, alarms);

    const result = translateIcs(ics, { ...OPTIONS, syncReminders: true });

    expect(result.master.reminders.overrides.map((r) => r.minutes)).toEqual([5, 10, 15, 30, 60]);
  });

  it('rejects calendar data without an event', () => {
    expect(() => translateIcs('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', OPTIONS)).toThrow(
      /VEVENT/,
    );
  });
});
