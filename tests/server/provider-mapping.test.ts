import type { calendar_v3, people_v1 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import type { DAVCalendar } from 'tsdav';
import type { GoogleEvent, GoogleEventDraft } from '../../src/server/providers/calendar-types.js';
import { describeAppleCalendar, fromApiEvent, instantOf, isEventCalendar, toApiEvent } from '../../src/server/providers/calendar-mapping.js';
import { fromPerson, toPerson } from '../../src/server/providers/contact-mapping.js';
import type { ContactData } from '../../src/server/providers/contact-types.js';
import { GoogleAuthError } from '../../src/server/providers/types.js';
import { httpStatus, isInvalidGrant, translateGoogleError } from '../../src/server/providers/google-errors.js';
import { describeFolder, isMissingFolder, toEnvelope, toListedMessage } from '../../src/server/providers/mail-mapping.js';
import { assertCalDavWrite } from '../../src/server/providers/real-calendar.js';
import { AppleObjectNotFoundError, ApplePreconditionFailedError } from '../../src/server/providers/calendar-types.js';

const googleError = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe('google errors', () => {
  it('recognizes a dead authorization by the response or the message', () => {
    expect(isInvalidGrant(googleError(400, { error: 'invalid_grant' }))).toBe(true);
    expect(isInvalidGrant(new Error('invalid_grant: Token has been expired or revoked.'))).toBe(true);
    expect(isInvalidGrant(googleError(400, { error: 'invalid_request' }))).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
    expect(isInvalidGrant('invalid_grant')).toBe(false);
  });

  it('reads the HTTP status of a failed call', () => {
    expect(httpStatus(googleError(410))).toBe(410);
    expect(httpStatus(new Error('boom'))).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
  });

  describe('translateGoogleError', () => {
    class Gone extends Error {}
    const notFound = { statuses: [404, 410], error: () => new Gone('gone') };

    it('turns a dead authorization into a GoogleAuthError, whatever else was asked for', () => {
      const translated = translateGoogleError(googleError(404, { error: 'invalid_grant' }), notFound);

      expect(translated).toBeInstanceOf(GoogleAuthError);
      expect((translated as GoogleAuthError).code).toBe('invalid_grant');
    });

    it('turns the given statuses into the not-found error', () => {
      expect(translateGoogleError(googleError(404), notFound)).toBeInstanceOf(Gone);
      expect(translateGoogleError(googleError(410), notFound)).toBeInstanceOf(Gone);
    });

    it('leaves other statuses, and every status without a not-found rule, as they are', () => {
      const other = googleError(500);
      const missing = googleError(404);

      expect(translateGoogleError(other, notFound)).toBe(other);
      expect(translateGoogleError(missing)).toBe(missing);
      expect(translateGoogleError(googleError(410), { statuses: [404], error: () => new Gone() })).toMatchObject({
        response: { status: 410 },
      });
    });
  });
});

describe('CalDAV writes', () => {
  const response = (status: number) => new Response(null, { status });

  it('accepts a successful write', () => {
    expect(() => assertCalDavWrite(response(201), '/e.ics')).not.toThrow();
  });

  it.each([
    [404, AppleObjectNotFoundError],
    [410, AppleObjectNotFoundError],
    [412, ApplePreconditionFailedError],
  ])('maps %i to a typed error', (status, expected) => {
    expect(() => assertCalDavWrite(response(status), '/e.ics')).toThrow(expected);
  });

  it('fails any other status with it', () => {
    expect(() => assertCalDavWrite(response(500), '/e.ics')).toThrow('CalDAV write to /e.ics failed (500)');
  });
});

describe('Apple calendars', () => {
  const calendar = (extra: Partial<DAVCalendar>): DAVCalendar => ({ url: '/cal/home/', ...extra }) as DAVCalendar;

  it('keeps event calendars and drops reminder lists', () => {
    expect(isEventCalendar(calendar({ components: ['VEVENT', 'VTODO'] }))).toBe(true);
    expect(isEventCalendar(calendar({}))).toBe(true);
    expect(isEventCalendar(calendar({ components: ['VTODO'] }))).toBe(false);
  });

  it('describes a calendar, falling back to its URL for a name', () => {
    expect(describeAppleCalendar(calendar({ displayName: 'Privat', ctag: 'c1' }))).toEqual({
      url: '/cal/home/',
      name: 'Privat',
      ctag: 'c1',
      readOnly: false,
      subscribed: false,
    });
    expect(describeAppleCalendar(calendar({}))).toMatchObject({ name: '/cal/home/', ctag: null });
  });

  it('treats a subscription as read-only', () => {
    const subscribed = describeAppleCalendar(
      calendar({ displayName: 'Feiertage', resourcetype: { collection: {}, 'Subscribed': {} } as never }),
    );

    expect(subscribed).toMatchObject({ readOnly: true, subscribed: true });
  });
});

describe('Google events', () => {
  const draft: GoogleEventDraft = {
    summary: 'Zahnarzt',
    description: 'Kontrolle',
    location: 'Praxis',
    start: { dateTime: '2026-03-10T09:00:00Z', timeZone: 'Europe/Vienna' },
    end: { dateTime: '2026-03-10T10:00:00Z', timeZone: 'Europe/Vienna' },
    recurrence: ['RRULE:FREQ=WEEKLY'],
    iCalUID: 'APPLE-UID-1',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }, { method: 'email', minutes: 60 }] },
  };

  it('keeps the Apple UID as a private property and always replaces the default reminders', () => {
    const body = toApiEvent(draft);

    expect(body.extendedProperties).toEqual({ private: { appleUid: 'APPLE-UID-1' } });
    expect(body.reminders).toEqual({ useDefault: false, overrides: draft.reminders.overrides });
    expect(body).not.toHaveProperty('iCalUID');
  });

  it('reads back what it wrote', () => {
    const written: calendar_v3.Schema$Event = { ...toApiEvent(draft), id: 'g1', iCalUID: 'google-made-uid@google.com' };

    const read = fromApiEvent(written);

    expect(read).toEqual({ ...draft, id: 'g1' } satisfies GoogleEvent);
  });

  it('reads all-day events, overrides of a series and events not written by this app', () => {
    const read = fromApiEvent({
      id: 'g2',
      summary: undefined,
      start: { date: '2026-03-12' },
      end: { date: '2026-03-13' },
      recurringEventId: 'master',
      originalStartTime: { date: '2026-03-12' },
      iCalUID: 'foreign@example.com',
      reminders: { overrides: [{ method: 'sms', minutes: 5 }, { method: 'popup', minutes: null }, { method: 'popup', minutes: 0 }] },
    });

    expect(read).toEqual({
      id: 'g2',
      summary: '',
      start: { date: '2026-03-12' },
      end: { date: '2026-03-13' },
      recurringEventId: 'master',
      originalStartTime: { date: '2026-03-12' },
      iCalUID: 'foreign@example.com',
      // An unknown method counts as a popup; a reminder without minutes is dropped
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }, { method: 'popup', minutes: 0 }] },
    });
  });

  it('measures an instant for both kinds of start', () => {
    expect(instantOf({ dateTime: '2026-03-10T09:00:00Z' })).toBe(Date.UTC(2026, 2, 10, 9));
    expect(instantOf({ date: '2026-03-10' })).toBe(Date.UTC(2026, 2, 10));
    expect(instantOf(undefined)).toBeNull();
  });
});

describe('Google contacts', () => {
  const data: ContactData = {
    givenName: 'Anna',
    familyName: 'Muster',
    middleName: 'Maria',
    prefix: 'Dr.',
    suffix: 'MSc',
    organization: 'ACME',
    title: 'CTO',
    emails: ['anna@example.com', 'a@work.example'],
    phones: ['+43 1 234'],
    birthday: '1985-03-07',
    addresses: [{ street: 'Hauptstr. 1', city: 'Wien', region: 'W', postalCode: '1010', country: 'AT' }],
    note: 'Notiz',
  };

  it('reads back what it wrote', () => {
    const person: people_v1.Schema$Person = { ...toPerson(data), resourceName: 'people/c1' };

    expect(fromPerson(person)).toEqual({ resourceName: 'people/c1', data, groupResourceNames: [] });
  });

  it('writes an empty contact as one without organization, birthday, address and note', () => {
    const empty: ContactData = {
      givenName: 'Nur',
      familyName: '',
      middleName: '',
      prefix: '',
      suffix: '',
      organization: '',
      title: '',
      emails: [],
      phones: [],
      birthday: null,
      addresses: [],
      note: '',
    };

    expect(toPerson(empty)).toMatchObject({ organizations: [], birthdays: [], addresses: [], biographies: [] });
    expect(fromPerson({ ...toPerson(empty), resourceName: 'people/c2' }).data).toEqual(empty);
  });

  it('does not sync a birthday without a year, and drops empty values', () => {
    const read = fromPerson({
      resourceName: 'people/c3',
      birthdays: [{ date: { month: 3, day: 7 } }],
      emailAddresses: [{ value: 'a@example.com' }, { value: '' }, {}],
      phoneNumbers: [{}],
    });

    expect(read.data.birthday).toBeNull();
    expect(read.data.emails).toEqual(['a@example.com']);
    expect(read.data.phones).toEqual([]);
  });

  it('pads the date of a birthday', () => {
    expect(fromPerson({ birthdays: [{ date: { year: 985, month: 3, day: 7 } }] }).data.birthday).toBe('0985-03-07');
  });

  it('reports the contact labels the person belongs to', () => {
    const read = fromPerson({
      resourceName: 'people/c4',
      memberships: [
        { contactGroupMembership: { contactGroupResourceName: 'contactGroups/fam' } },
        { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
        { domainMembership: { inViewerDomain: true } },
      ],
    });

    expect(read.groupResourceNames).toEqual(['contactGroups/fam', 'contactGroups/myContacts']);
  });
});

describe('Apple mail', () => {
  it('recognizes a folder that does not exist', () => {
    expect(isMissingFolder(Object.assign(new Error('x'), { serverResponseCode: 'NONEXISTENT' }))).toBe(true);
    expect(isMissingFolder(new Error('Mailbox does not exist'))).toBe(true);
    expect(isMissingFolder(new Error('Unknown Mailbox: Foo'))).toBe(true);
    expect(isMissingFolder(new Error('Connection reset'))).toBe(false);
  });

  describe('folders', () => {
    const entry = (path: string, specialUse: string | undefined, flags: string[] = [], delimiter = '/') =>
      ({ path, delimiter, specialUse, flags: new Set(flags) }) as never;

    it('names the INBOX and the special folders', () => {
      expect(describeFolder(entry('INBOX', undefined))).toMatchObject({ use: 'inbox', selectable: true });
      expect(describeFolder(entry('inbox', undefined))).toMatchObject({ use: 'inbox' });
      expect(describeFolder(entry('Sent Messages', '\\Sent'))).toMatchObject({ use: 'sent' });
      expect(describeFolder(entry('Deleted Messages', '\\Trash'))).toMatchObject({ use: 'trash' });
      expect(describeFolder(entry('Archive', undefined))).toMatchObject({ use: null });
      expect(describeFolder(entry('Archive', '\\Archive'))).toMatchObject({ use: null });
    });

    it('joins the levels of a path with slashes and knows what cannot be selected', () => {
      expect(describeFolder(entry('Reisen.2026', undefined, [], '.'))).toMatchObject({ path: 'Reisen.2026', name: 'Reisen/2026' });
      expect(describeFolder(entry('Container', undefined, ['\\Noselect']))).toMatchObject({ selectable: false });
      expect(describeFolder(entry('Gone', undefined, ['\\NonExistent']))).toMatchObject({ selectable: false });
    });
  });

  it('lists a message with its flags and date', () => {
    expect(
      toListedMessage({ uid: 7, flags: new Set(['\\Seen', '\\Flagged']), size: 1234, internalDate: new Date('2026-03-10T09:00:00Z') }),
    ).toEqual({ uid: 7, seen: true, flagged: true, size: 1234, internalDate: Date.UTC(2026, 2, 10, 9) });
    expect(toListedMessage({ uid: 8 })).toEqual({ uid: 8, seen: false, flagged: false, size: 0, internalDate: 0 });
  });

  describe('envelopes', () => {
    it('reads the headers a message is told apart by', () => {
      expect(
        toEnvelope({
          uid: 3,
          envelope: {
            messageId: '<a@b>',
            date: new Date('2026-03-10T09:00:00Z'),
            from: [{ address: 'x@example.com' }, { name: 'No Address' }],
            subject: 'Hallo',
          },
        }),
      ).toEqual({ uid: 3, messageId: '<a@b>', date: '2026-03-10T09:00:00.000Z', from: 'x@example.com,', subject: 'Hallo' });
    });

    it('survives a Date header nobody can parse, and a missing envelope', () => {
      expect(toEnvelope({ uid: 4, envelope: { date: new Date('not a date') } as never }).date).toBeNull();
      expect(toEnvelope({ uid: 5 })).toEqual({ uid: 5, messageId: null, date: null, from: '', subject: '' });
    });
  });
});
