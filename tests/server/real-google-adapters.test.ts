import type { calendar_v3, gmail_v1, people_v1 } from 'googleapis';
import { describe, expect, it, vi } from 'vitest';
import { GoogleEventNotFoundError, GoogleSyncTokenExpiredError, type GoogleEventDraft } from '../../src/server/providers/calendar-types.js';
import { GoogleContactNotFoundError } from '../../src/server/providers/contact-types.js';
import { GoogleMessageNotFoundError } from '../../src/server/providers/mail-types.js';
import { createRealGoogleCalendars } from '../../src/server/providers/real-calendar.js';
import { createRealGoogleContacts } from '../../src/server/providers/real-contacts.js';
import { createRealGoogleMail } from '../../src/server/providers/real-mail.js';
import { GoogleAuthError } from '../../src/server/providers/types.js';

const config = { googleClientId: 'id', googleClientSecret: 'secret' };
const tokens = { refresh_token: 'r' };
const respond = <T>(data: T) => Promise.resolve({ data });
const failure = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const none = <T>(call: () => Promise<T>) => call();

/** A limiter that lets every call through and counts them. */
function countingLimiter() {
  const limiter = Object.assign(<T>(call: () => Promise<T>): Promise<T> => {
    limiter.calls += 1;
    return call();
  }, { calls: 0 });
  return limiter;
}

describe('the Google Calendar adapter', () => {
  const draft: GoogleEventDraft = {
    summary: 'Termin',
    start: { dateTime: '2026-03-10T09:00:00Z' },
    end: { dateTime: '2026-03-10T10:00:00Z' },
    iCalUID: 'uid-1',
    reminders: { useDefault: false, overrides: [] },
  };
  const options = { sendUpdates: 'none' } as const;

  /** `events` stands for the part of the Google client the adapter talks to. */
  function adapter(events: Partial<Record<'list' | 'insert' | 'update' | 'delete' | 'instances' | 'watch', ReturnType<typeof vi.fn>>>, extra: object = {}) {
    return createRealGoogleCalendars(config, tokens, () => ({ events, ...extra }) as unknown as calendar_v3.Calendar);
  }

  it('lists the calendars with their names, primary flag and whether they can be written', async () => {
    const calendars = adapter({}, {
      calendarList: {
        list: async () => ({
          data: {
            items: [
              { id: 'primary', summary: 'Anna', primary: true, accessRole: 'owner' },
              { id: 'shared', summary: 'Team', summaryOverride: 'Mein Team', accessRole: 'writer' },
              { id: 'feiertage', summary: 'Feiertage', accessRole: 'reader' },
            ],
          },
        }),
      },
    });

    expect(await calendars.list()).toEqual([
      { id: 'primary', name: 'Anna', primary: true, writable: true },
      { id: 'shared', name: 'Mein Team', primary: false, writable: true },
      { id: 'feiertage', name: 'Feiertage', primary: false, writable: false },
    ]);
  });

  it('reads every page of the events', async () => {
    const list = vi
      .fn()
      .mockImplementationOnce(() => respond({ items: [{ id: 'a', summary: 'A' }], nextPageToken: 'p2' }))
      .mockImplementationOnce(() => respond({ items: [{ id: 'b', summary: 'B' }] }));

    const events = await adapter({ list }).listEvents('primary');

    expect(events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ pageToken: 'p2', singleEvents: false });
  });

  describe('changes since the last run', () => {
    it('separates the changed events from the deleted ones and keeps the last token', async () => {
      const list = vi
        .fn()
        .mockImplementationOnce(() =>
          respond({ items: [{ id: 'a', summary: 'A' }, { id: 'gone', status: 'cancelled' }, { status: 'cancelled' }], nextPageToken: 'p2' }),
        )
        .mockImplementationOnce(() => respond({ items: [{ id: 'b', summary: 'B' }], nextSyncToken: 'token-2' }));

      const changes = await adapter({ list }).listChanges('primary', 'token-1');

      expect(changes).toEqual({ events: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })], deletedIds: ['gone'], nextSyncToken: 'token-2' });
      expect(list.mock.calls[0]?.[0]).toMatchObject({ syncToken: 'token-1' });
    });

    it('lists everything without a token', async () => {
      const list = vi.fn().mockImplementation(() => respond({ items: [], nextSyncToken: 't' }));

      await adapter({ list }).listChanges('primary', null);

      expect(list.mock.calls[0]?.[0]).not.toHaveProperty('syncToken');
    });

    it('tells a stale token from other failures', async () => {
      const stale = adapter({ list: vi.fn().mockRejectedValue(failure(410)) });

      await expect(stale.listChanges('primary', 'old')).rejects.toBeInstanceOf(GoogleSyncTokenExpiredError);
      // Without a token there is nothing that could be stale
      await expect(stale.listChanges('primary', null)).rejects.toMatchObject({ response: { status: 410 } });
    });

    it('fails when Google does not hand out a new token', async () => {
      const calendars = adapter({ list: vi.fn().mockImplementation(() => respond({ items: [] })) });

      await expect(calendars.listChanges('primary', null)).rejects.toThrow('Google did not return a sync token');
    });
  });

  describe('writing', () => {
    it('inserts a new event without notifying anyone', async () => {
      const insert = vi.fn().mockImplementation(() => respond({ id: 'g1', summary: 'Termin' }));

      const event = await adapter({ insert }).insertEvent('primary', draft, options);

      expect(event.id).toBe('g1');
      expect(insert.mock.calls[0]?.[0]).toMatchObject({ calendarId: 'primary', sendUpdates: 'none' });
    });

    it('replaces the occurrence of a series that an exception overrides', async () => {
      const instances = vi.fn().mockImplementation(() =>
        respond({
          items: [
            { id: 'master_20260310', originalStartTime: { dateTime: '2026-03-10T09:00:00Z' } },
            { id: 'master_20260317', originalStartTime: { dateTime: '2026-03-17T09:00:00Z' } },
          ],
        }),
      );
      const update = vi.fn().mockImplementation(() => respond({ id: 'master_20260317', summary: 'Verschoben' }));
      const exception: GoogleEventDraft = {
        ...draft,
        recurringEventId: 'master',
        originalStartTime: { dateTime: '2026-03-17T09:00:00Z' },
      };

      const event = await adapter({ instances, update }).insertEvent('primary', exception, options);

      expect(event.id).toBe('master_20260317');
      expect(instances.mock.calls[0]?.[0]).toMatchObject({ eventId: 'master' });
      expect(update.mock.calls[0]?.[0]).toMatchObject({ eventId: 'master_20260317', sendUpdates: 'none' });
    });

    it('reports an occurrence that is not there as a missing event', async () => {
      const instances = vi.fn().mockImplementation(() => respond({ items: [] }));
      const exception: GoogleEventDraft = { ...draft, recurringEventId: 'master', originalStartTime: { dateTime: '2026-03-17T09:00:00Z' } };

      await expect(adapter({ instances }).insertEvent('primary', exception, options)).rejects.toBeInstanceOf(GoogleEventNotFoundError);
    });

    it('reports an event that is gone from Google as missing, on update and delete', async () => {
      const calendars = adapter({ update: vi.fn().mockRejectedValue(failure(404)), delete: vi.fn().mockRejectedValue(failure(410)) });

      await expect(calendars.updateEvent('primary', 'g1', draft, options)).rejects.toBeInstanceOf(GoogleEventNotFoundError);
      await expect(calendars.deleteEvent('primary', 'g1', options)).rejects.toBeInstanceOf(GoogleEventNotFoundError);
    });

    it('asks for a re-authentication when the authorization is dead', async () => {
      const calendars = adapter({ insert: vi.fn().mockRejectedValue(failure(400, { error: 'invalid_grant' })) });

      await expect(calendars.insertEvent('primary', draft, options)).rejects.toBeInstanceOf(GoogleAuthError);
    });
  });

  describe('notification channels', () => {
    it('reports where Google will notify and when the channel runs out', async () => {
      const watch = vi.fn().mockImplementation(() => respond({ resourceId: 'res-1', expiration: '1773000000000' }));

      const channel = await adapter({ watch }).watch('primary', { channelId: 'c1', address: 'https://x/hook', token: 't' });

      expect(channel).toEqual({ resourceId: 'res-1', expiresAt: 1773000000000 });
      expect(watch.mock.calls[0]?.[0]).toMatchObject({ requestBody: { id: 'c1', type: 'web_hook', address: 'https://x/hook', token: 't' } });
    });

    it.each([[{ expiration: '1773000000000' }], [{ resourceId: 'r' }], [{ resourceId: 'r', expiration: 'soon' }]])(
      'refuses a channel Google did not describe (%j)',
      async (data) => {
        const watch = vi.fn().mockImplementation(() => respond(data));

        await expect(adapter({ watch }).watch('primary', { channelId: 'c', address: 'a', token: 't' })).rejects.toThrow(
          'Google did not describe the notification channel',
        );
      },
    );

    it('treats stopping a channel that is gone as done, but not any other failure', async () => {
      const stop = vi.fn();
      const calendars = adapter({}, { channels: { stop } });

      stop.mockRejectedValueOnce(failure(404));
      await expect(calendars.stopWatch('c1', 'r1')).resolves.toBeUndefined();

      stop.mockRejectedValueOnce(failure(500));
      await expect(calendars.stopWatch('c1', 'r1')).rejects.toMatchObject({ response: { status: 500 } });
    });
  });

  it('needs a connected Google account when it is not handed a client', async () => {
    await expect(createRealGoogleCalendars(config, null).list()).rejects.toThrow('Google account is not connected');
  });
});

describe('the Google People adapter', () => {
  function adapter(people: object) {
    return createRealGoogleContacts(config, tokens, none, () => people as unknown as people_v1.People);
  }
  const connections = (list: ReturnType<typeof vi.fn>) => ({ people: { connections: { list } } });

  it('lists only the labels people made themselves', async () => {
    const contacts = adapter({
      contactGroups: {
        list: async () => ({
          data: {
            contactGroups: [
              { resourceName: 'contactGroups/fam', name: 'Familie', groupType: 'USER_CONTACT_GROUP' },
              { resourceName: 'contactGroups/myContacts', name: 'myContacts', groupType: 'SYSTEM_CONTACT_GROUP' },
              { name: 'No resource', groupType: 'USER_CONTACT_GROUP' },
            ],
          },
        }),
      },
    });

    expect(await contacts.listGroups()).toEqual([{ resourceName: 'contactGroups/fam', name: 'Familie' }]);
  });

  describe('changes since the last run', () => {
    it('separates the changed contacts from the deleted ones across pages', async () => {
      const list = vi
        .fn()
        .mockImplementationOnce(() =>
          respond({
            connections: [{ resourceName: 'people/a', names: [{ givenName: 'A' }] }, { resourceName: 'people/x', metadata: { deleted: true } }],
            nextPageToken: 'p2',
          }),
        )
        .mockImplementationOnce(() => respond({ connections: [{ resourceName: 'people/b' }], nextSyncToken: 'token-2' }));

      const changes = await adapter(connections(list)).listChanges('token-1');

      expect(changes.contacts.map((contact) => contact.resourceName)).toEqual(['people/a', 'people/b']);
      expect(changes.deletedResourceNames).toEqual(['people/x']);
      expect(changes.nextSyncToken).toBe('token-2');
      expect(list.mock.calls[0]?.[0]).toMatchObject({ syncToken: 'token-1', requestSyncToken: true });
    });

    it.each([
      ['an HTTP 410', failure(410)],
      ['an EXPIRED_SYNC_TOKEN message', new Error('Sync token is expired. EXPIRED_SYNC_TOKEN')],
      // As reported for the real API: HTTP 400, the reason only in the error details, the message without the constant
      [
        'an HTTP 400 with the text Google uses',
        Object.assign(new Error('Sync token is expired. Clear local cache and retry call without the sync token.'), {
          response: { status: 400, data: { error: { code: 400, message: 'Sync token is expired.' } } },
        }),
      ],
      [
        'an HTTP 400 whose details name the reason',
        Object.assign(new Error('Request contains an invalid argument.'), {
          response: {
            status: 400,
            data: { error: { code: 400, status: 'FAILED_PRECONDITION', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'EXPIRED_SYNC_TOKEN' }] } },
          },
        }),
      ],
    ])('tells a stale token from %s', async (_name, error) => {
      const contacts = adapter(connections(vi.fn().mockRejectedValue(error)));

      await expect(contacts.listChanges('old')).rejects.toBeInstanceOf(GoogleSyncTokenExpiredError);
      await expect(contacts.listChanges(null)).rejects.toBe(error);
    });

    it('does not mistake any other HTTP 400 for a stale token', async () => {
      const invalid = Object.assign(new Error('Request contains an invalid argument.'), { response: { status: 400, data: { error: { code: 400 } } } });
      const contacts = adapter(connections(vi.fn().mockRejectedValue(invalid)));

      await expect(contacts.listChanges('old')).rejects.toBe(invalid);
    });

    it('fails when Google does not hand out a new token', async () => {
      const contacts = adapter(connections(vi.fn().mockImplementation(() => respond({ connections: [] }))));

      await expect(contacts.listChanges(null)).rejects.toThrow('Google did not return a sync token');
    });
  });

  describe('writing', () => {
    const write = { data: undefined, addGroups: [] as string[], removeGroups: [] as string[] };

    it('puts a new contact into the labels it asks for', async () => {
      const createContact = vi.fn().mockImplementation(() => respond({ resourceName: 'people/new' }));
      const contacts = adapter({ people: { createContact } });
      const data = fromEmpty('Anna');

      const created = await contacts.create({ ...write, data, addGroups: ['contactGroups/fam'] });

      expect(created.resourceName).toBe('people/new');
      expect(createContact.mock.calls[0]?.[0].requestBody.memberships).toEqual([
        { contactGroupMembership: { contactGroupResourceName: 'contactGroups/fam' } },
      ]);
    });

    it('refuses to create a contact without data', async () => {
      await expect(adapter({}).create(write)).rejects.toThrow('A new contact needs its data');
    });

    it('keeps the other labels of a contact, applies the changes, and never drops it from My Contacts', async () => {
      const get = vi.fn().mockImplementation(() =>
        respond({
          etag: 'etag-1',
          memberships: [
            { contactGroupMembership: { contactGroupResourceName: 'contactGroups/fam' } },
            { contactGroupMembership: { contactGroupResourceName: 'contactGroups/work' } },
          ],
        }),
      );
      const updateContact = vi.fn().mockImplementation(() => respond({ resourceName: 'people/c1' }));
      const contacts = adapter({ people: { get, updateContact } });

      await contacts.update('people/c1', { ...write, addGroups: ['contactGroups/new'], removeGroups: ['contactGroups/fam'] });

      const request = updateContact.mock.calls[0]?.[0];
      expect(request.requestBody.etag).toBe('etag-1');
      expect(request.updatePersonFields).toBe('memberships');
      expect(request.requestBody.memberships.map((m: people_v1.Schema$Membership) => m.contactGroupMembership?.contactGroupResourceName)).toEqual([
        'contactGroups/work',
        'contactGroups/new',
        'contactGroups/myContacts',
      ]);
    });

    it('updates the fields of the data it is given', async () => {
      const get = vi.fn().mockImplementation(() => respond({ etag: 'e', memberships: [] }));
      const updateContact = vi.fn().mockImplementation(() => respond({ resourceName: 'people/c1' }));

      await adapter({ people: { get, updateContact } }).update('people/c1', { ...write, data: fromEmpty('Anna') });

      expect(updateContact.mock.calls[0]?.[0].updatePersonFields.split(',')).toEqual(
        expect.arrayContaining(['names', 'emailAddresses', 'memberships']),
      );
    });

    it('reports a contact that is gone from Google as missing', async () => {
      const contacts = adapter({
        people: {
          get: vi.fn().mockRejectedValue(failure(404)),
          deleteContact: vi.fn().mockRejectedValue(failure(410)),
          updateContactPhoto: vi.fn().mockRejectedValue(failure(404)),
        },
      });

      await expect(contacts.update('people/c1', write)).rejects.toBeInstanceOf(GoogleContactNotFoundError);
      await expect(contacts.delete('people/c1')).rejects.toBeInstanceOf(GoogleContactNotFoundError);
      await expect(contacts.updatePhoto('people/c1', Buffer.from('x'))).rejects.toBeInstanceOf(GoogleContactNotFoundError);
    });

    it('asks for a re-authentication when the authorization is dead', async () => {
      const contacts = adapter({ contactGroups: { list: vi.fn().mockRejectedValue(failure(400, { error: 'invalid_grant' })) } });

      await expect(contacts.listGroups()).rejects.toBeInstanceOf(GoogleAuthError);
    });
  });

  it('spaces every call through the limiter it is given', async () => {
    const limit = countingLimiter();
    const contacts = createRealGoogleContacts(config, tokens, limit, () => ({ contactGroups: { list: async () => ({ data: {} }) } }) as unknown as people_v1.People);

    await contacts.listGroups();

    expect(limit.calls).toBe(1);
  });
});

function fromEmpty(givenName: string) {
  return {
    givenName,
    familyName: '',
    middleName: '',
    prefix: '',
    suffix: '',
    organization: '',
    title: '',
    emails: ['a@example.com'],
    phones: [],
    birthday: null,
    addresses: [],
    note: '',
  };
}

describe('the Gmail adapter', () => {
  function adapter(users: object, limit: <T>(call: () => Promise<T>) => Promise<T> = none) {
    return createRealGoogleMail(config, tokens, limit, () => ({ users }) as unknown as gmail_v1.Gmail);
  }

  it('lists the labels it can name', async () => {
    const mail = adapter({
      labels: { list: async () => ({ data: { labels: [{ id: 'L1', name: 'Receipts' }, { id: 'L2' }, { name: 'No id' }] } }) },
    });

    expect(await mail.listLabels()).toEqual([{ id: 'L1', name: 'Receipts' }]);
  });

  it('creates a visible label, and fails when Gmail did not make one', async () => {
    const create = vi.fn().mockImplementationOnce(() => respond({ id: 'L9' })).mockImplementationOnce(() => respond({}));
    const mail = adapter({ labels: { create } });

    expect(await mail.createLabel('Receipts')).toEqual({ id: 'L9', name: 'Receipts' });
    expect(create.mock.calls[0]?.[0].requestBody).toMatchObject({ name: 'Receipts', labelListVisibility: 'labelShow' });
    await expect(mail.createLabel('Other')).rejects.toThrow('Gmail did not create the label "Other"');
  });

  describe('importing', () => {
    const raw = Buffer.from('Subject: hi\r\n\r\nbody');

    it('imports with the labels it is given, through the limiter, and returns the id', async () => {
      const importMessage = vi.fn().mockImplementation(() => respond({ id: 'm1' }));
      const limit = countingLimiter();
      const mail = adapter({ messages: { import: importMessage } }, limit);

      expect(await mail.importMessage({ raw, labelIds: ['INBOX', 'UNREAD'] })).toBe('m1');
      expect(limit.calls).toBe(1);
      expect(importMessage.mock.calls[0]?.[0]).toMatchObject({
        internalDateSource: 'dateHeader',
        neverMarkSpam: true,
        requestBody: { labelIds: ['INBOX', 'UNREAD'] },
      });
    });

    it('fails when Gmail did not return an id', async () => {
      const mail = adapter({ messages: { import: vi.fn().mockImplementation(() => respond({})) } });

      await expect(mail.importMessage({ raw, labelIds: [] })).rejects.toThrow('Gmail did not return an id for the imported message');
    });
  });

  it('reports a message that is gone from Gmail as missing, but only for a 404', async () => {
    const messages = {
      modify: vi.fn().mockRejectedValue(failure(404)),
      trash: vi.fn().mockRejectedValue(failure(404)),
      untrash: vi.fn().mockRejectedValue(failure(404)),
    };
    const mail = adapter({ messages });

    await expect(mail.modify('m1', { addLabelIds: [], removeLabelIds: ['L'] })).rejects.toBeInstanceOf(GoogleMessageNotFoundError);
    await expect(mail.trash('m1')).rejects.toBeInstanceOf(GoogleMessageNotFoundError);
    await expect(mail.untrash('m1')).rejects.toBeInstanceOf(GoogleMessageNotFoundError);
    const gone = adapter({ messages: { modify: vi.fn().mockRejectedValue(failure(410)) } });
    await expect(gone.modify('m1', { addLabelIds: [], removeLabelIds: [] })).rejects.toMatchObject({ response: { status: 410 } });
  });

  it('asks for a re-authentication when the authorization is dead', async () => {
    const mail = adapter({ labels: { list: vi.fn().mockRejectedValue(failure(400, { error: 'invalid_grant' })) } });

    await expect(mail.listLabels()).rejects.toBeInstanceOf(GoogleAuthError);
  });
});
