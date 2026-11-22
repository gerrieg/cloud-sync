import { google, type people_v1 } from 'googleapis';
import { createDAVClient } from 'tsdav';
import { GoogleSyncTokenExpiredError } from './calendar-types.js';
import {
  GoogleContactNotFoundError,
  type AppleContactBook,
  type GoogleContact,
  type GoogleContactChanges,
  type GoogleContactGroupInfo,
  type GoogleContactWrite,
} from './contact-types.js';
import { fromPerson, membership, toPerson } from './contact-mapping.js';
import { httpStatus, translateGoogleError } from './google-errors.js';
import { assertCalDavWrite, type GoogleClientConfig } from './real-calendar.js';
import type { AppleCredentials, GoogleTokens, SyncProviders } from './types.js';

const ICLOUD_CARDDAV_URL = 'https://contacts.icloud.com';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,birthdays,addresses,biographies,memberships';
const MY_CONTACTS = 'contactGroups/myContacts';

type AppleContacts = SyncProviders['apple']['contacts'];
type GoogleContacts = SyncProviders['google']['contacts'];

export function createRealAppleContacts(credentials: AppleCredentials | null): AppleContacts {
  async function connect() {
    if (!credentials) {
      throw new Error('No Apple credentials configured');
    }
    const client = await createDAVClient({
      serverUrl: ICLOUD_CARDDAV_URL,
      credentials: { username: credentials.appleId, password: credentials.appPassword },
      authMethod: 'Basic',
      defaultAccountType: 'carddav',
    });
    // iCloud keeps all contacts, and the contact groups as vCards, in one address book
    const addressBook = (await client.fetchAddressBooks())[0];
    if (!addressBook) {
      throw new Error('No iCloud address book found');
    }
    return { client, addressBook };
  }

  return {
    async list(): Promise<AppleContactBook> {
      const { client, addressBook } = await connect();
      const cards = await client.fetchVCards({ addressBook });
      return {
        ctag: typeof addressBook.ctag === 'string' ? addressBook.ctag : null,
        // A card without data stays in the list (as unreadable) so it is not taken for a deleted contact
        objects: cards.map((card) => ({
          href: card.url,
          etag: card.etag ?? '',
          vcard: typeof card.data === 'string' ? card.data : '',
        })),
      };
    },
    async putObject(input) {
      const { client, addressBook } = await connect();
      const href = input.href ?? new URL(`${encodeURIComponent(input.uid)}.vcf`, addressBook.url).href;
      const response =
        input.href === null
          ? await client.createVCard({
              addressBook,
              filename: href.slice(href.lastIndexOf('/') + 1),
              vCardString: input.vcard,
            })
          : await client.updateVCard({
              vCard: { url: href, data: input.vcard, etag: input.etag ?? undefined },
            });
      assertCalDavWrite(response, href);

      // iCloud does not always answer a PUT with the new ETag: read it back
      const etag =
        response.headers.get('etag') ??
        (await client.fetchVCards({ addressBook, objectUrls: [href] }))[0]?.etag;
      if (!etag) {
        throw new Error(`CardDAV did not report an ETag for ${href}`);
      }
      return { href, etag };
    },
    async deleteObject(href, etag) {
      const { client } = await connect();
      assertCalDavWrite(await client.deleteVCard({ vCard: { url: href, etag } }), href);
    },
  };
}


export function createRealGoogleContacts(
  config: GoogleClientConfig,
  tokens: GoogleTokens | null,
  /** Spaces the People API calls of one Profile (about one request per second). */
  limit: <T>(call: () => Promise<T>) => Promise<T>,
  /** Stands in for the Google client, for tests. */
  makeClient?: () => people_v1.People,
): GoogleContacts {
  function client(): people_v1.People {
    if (makeClient) {
      return makeClient();
    }
    if (!tokens) {
      throw new Error('Google account is not connected');
    }
    const auth = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
    auth.setCredentials({ ...tokens });
    return google.people({ version: 'v1', auth });
  }

  async function guarded<T>(call: (people: people_v1.People) => Promise<T>, resourceName?: string): Promise<T> {
    try {
      return await limit(() => call(client()));
    } catch (error) {
      throw translateGoogleError(
        error,
        resourceName === undefined
          ? undefined
          : { statuses: [404, 410], error: () => new GoogleContactNotFoundError(resourceName) },
      );
    }
  }

  async function fetchPerson(resourceName: string): Promise<people_v1.Schema$Person> {
    return (await guarded((people) => people.people.get({ resourceName, personFields: PERSON_FIELDS }), resourceName)).data;
  }

  return {
    async listGroups(): Promise<GoogleContactGroupInfo[]> {
      const response = await guarded((people) => people.contactGroups.list({ pageSize: 200 }));
      return (response.data.contactGroups ?? []).flatMap((group) =>
        group.groupType === 'USER_CONTACT_GROUP' && group.resourceName
          ? [{ resourceName: group.resourceName, name: group.name ?? group.resourceName }]
          : [],
      );
    },
    async listChanges(syncToken): Promise<GoogleContactChanges> {
      const contacts: GoogleContact[] = [];
      const deletedResourceNames: string[] = [];
      let nextSyncToken: string | undefined;
      let pageToken: string | undefined;
      try {
        do {
          const response = await guarded((people) =>
            people.people.connections.list({
              resourceName: 'people/me',
              personFields: `${PERSON_FIELDS},metadata`,
              pageSize: 1000,
              requestSyncToken: true,
              pageToken,
              ...(syncToken ? { syncToken } : {}),
            }),
          );
          for (const person of response.data.connections ?? []) {
            if (person.metadata?.deleted) {
              if (person.resourceName) {
                deletedResourceNames.push(person.resourceName);
              }
            } else {
              contacts.push(fromPerson(person));
            }
          }
          nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
          pageToken = response.data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (error) {
        // People API answers an expired token with HTTP 400 (EXPIRED_SYNC_TOKEN) or 410
        const expired = syncToken && (httpStatus(error) === 410 || (error instanceof Error && error.message.includes('EXPIRED_SYNC_TOKEN')));
        if (expired) {
          throw new GoogleSyncTokenExpiredError();
        }
        throw error;
      }
      if (!nextSyncToken) {
        throw new Error('Google did not return a sync token');
      }
      return { contacts, deletedResourceNames, nextSyncToken };
    },
    async create(write: GoogleContactWrite) {
      if (!write.data) {
        throw new Error('A new contact needs its data');
      }
      const body = toPerson(write.data);
      const response = await guarded((people) =>
        people.people.createContact({
          personFields: PERSON_FIELDS,
          requestBody: { ...body, memberships: write.addGroups.map(membership) },
        }),
      );
      return fromPerson(response.data);
    },
    async update(resourceName, write) {
      const current = await fetchPerson(resourceName);
      const kept = (current.memberships ?? []).flatMap((m) => {
        const name = m.contactGroupMembership?.contactGroupResourceName;
        return name && !write.removeGroups.includes(name) ? [name] : [];
      });
      const groups = [...new Set([...kept, ...write.addGroups, MY_CONTACTS])];
      const fields = write.data ? Object.keys(toPerson(write.data)) : [];
      const response = await guarded(
        (people) =>
          people.people.updateContact({
            resourceName,
            personFields: PERSON_FIELDS,
            updatePersonFields: [...fields, 'memberships'].join(','),
            requestBody: {
              etag: current.etag,
              ...(write.data ? toPerson(write.data) : {}),
              memberships: groups.map(membership),
            },
          }),
        resourceName,
      );
      return fromPerson(response.data);
    },
    async delete(resourceName) {
      await guarded((people) => people.people.deleteContact({ resourceName }), resourceName);
    },
    async updatePhoto(resourceName, photo) {
      await guarded(
        (people) =>
          people.people.updateContactPhoto({
            resourceName,
            requestBody: { photoBytes: photo.toString('base64'), personFields: 'photos' },
          }),
        resourceName,
      );
    },
  };
}
