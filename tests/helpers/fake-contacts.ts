import {
  AppleObjectNotFoundError,
  ApplePreconditionFailedError,
  GoogleSyncTokenExpiredError,
} from '../../src/server/providers/calendar-types.js';
import {
  GoogleContactNotFoundError,
  type AppleContactObject,
  type ContactData,
  type GoogleContact,
  type GoogleContactGroupInfo,
} from '../../src/server/providers/contact-types.js';
import { GoogleAuthError, type SyncProviders } from '../../src/server/providers/types.js';

export function contactData(overrides: Partial<ContactData> = {}): ContactData {
  return {
    givenName: '',
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
    ...overrides,
  };
}

export interface GoogleContactLog {
  readonly kind: 'create' | 'update' | 'delete' | 'photo';
  readonly resourceName: string;
}

interface AppleBook {
  ctag: string;
  objects: Map<string, { etag: string; vcard: string }>;
}

interface GoogleBook {
  groups: Map<string, GoogleContactGroupInfo>;
  contacts: Map<string, { data: ContactData; groups: Set<string>; photo: Buffer | null }>;
  version: number;
  minValidVersion: number;
  changedAt: Map<string, number>;
  deletedAt: Map<string, number>;
}

/** Stateful in-memory iCloud address book + Google People, keyed by Apple ID / refresh token. */
export class FakeContactWorld {
  readonly googleWrites: GoogleContactLog[] = [];
  readonly appleWrites: { kind: 'put' | 'delete'; href: string }[] = [];
  /** Photo uploads in order, with the bytes that were sent. */
  readonly photoUploads: { resourceName: string; photo: Buffer }[] = [];
  /** URLs downloaded through `fetchPhoto`, in order. */
  readonly photoDownloads: string[] = [];
  readonly trace: string[] = [];

  private readonly apple = new Map<string, AppleBook>();
  private readonly google = new Map<string, GoogleBook>();
  private beforeNextApplePut: (() => void) | null = null;
  private photoFailure: Error | null = null;
  private readonly applePhotos = new Map<string, Buffer>();
  private readonly writeRejections: { givenName: string; error: Error }[] = [];
  private counter = 0;

  // ---- Apple -------------------------------------------------------------------------------

  /** A photo iCloud serves at `url`, which a vCard links to with `PHOTO;VALUE=uri`. */
  putApplePhoto(url: string, bytes: Buffer): void {
    this.applePhotos.set(url, bytes);
  }

  putAppleVCard(appleId: string, href: string, vcard: string): void {
    const book = this.appleBook(appleId);
    book.objects.set(href, { etag: this.next('etag'), vcard });
    book.ctag = this.next('ctag');
  }

  removeAppleVCard(appleId: string, href: string): void {
    const book = this.appleBook(appleId);
    book.objects.delete(href);
    book.ctag = this.next('ctag');
  }

  appleVCard(appleId: string, href: string): string | undefined {
    return this.appleBook(appleId).objects.get(href)?.vcard;
  }

  appleHrefs(appleId: string): string[] {
    return [...this.appleBook(appleId).objects.keys()];
  }

  /** Runs `change` right before the next overwrite reaches Apple, i.e. after the caller read the ETag. */
  changeAppleBeforeNextOverwrite(change: () => void): void {
    this.beforeNextApplePut = change;
  }

  // ---- Google ------------------------------------------------------------------------------

  addGoogleAccount(refreshToken: string, groups: GoogleContactGroupInfo[] = []): void {
    this.google.set(refreshToken, {
      groups: new Map(groups.map((g) => [g.resourceName, g])),
      contacts: new Map(),
      version: 0,
      minValidVersion: 0,
      changedAt: new Map(),
      deletedAt: new Map(),
    });
  }

  /** A pre-existing Google contact, as if created by hand. */
  seedGoogleContact(refreshToken: string, data: Partial<ContactData>, groups: string[] = []): GoogleContact {
    const resourceName = this.next('people/seed');
    this.store(this.googleBook(refreshToken), resourceName, { data: contactData(data), groups: new Set(groups), photo: null });
    return this.googleContact(refreshToken, resourceName)!;
  }

  googleContacts(refreshToken: string): GoogleContact[] {
    return [...this.googleBook(refreshToken).contacts.keys()].map((name) => this.googleContact(refreshToken, name)!);
  }

  googleContact(refreshToken: string, resourceName: string): GoogleContact | undefined {
    const stored = this.googleBook(refreshToken).contacts.get(resourceName);
    return stored && { resourceName, data: stored.data, groupResourceNames: [...stored.groups] };
  }

  googlePhoto(refreshToken: string, resourceName: string): Buffer | null {
    return this.googleBook(refreshToken).contacts.get(resourceName)?.photo ?? null;
  }

  /** Simulates a manual edit in Google Contacts. */
  editGoogleContact(refreshToken: string, resourceName: string, patch: Partial<ContactData>): void {
    const book = this.googleBook(refreshToken);
    const existing = book.contacts.get(resourceName);
    if (!existing) {
      throw new GoogleContactNotFoundError(resourceName);
    }
    this.store(book, resourceName, { ...existing, data: { ...existing.data, ...patch } });
  }

  /** Simulates a manual deletion in Google Contacts. */
  removeGoogleContact(refreshToken: string, resourceName: string): void {
    this.drop(this.googleBook(refreshToken), resourceName);
  }

  /** Google refuses to create or change contacts with this given name until `clearWriteRejections` is called. */
  rejectGoogleWritesFor(givenName: string, error: Error = new Error('Google rejected the contact')): void {
    this.writeRejections.push({ givenName, error });
  }

  clearWriteRejections(): void {
    this.writeRejections.length = 0;
  }

  /** Makes the next photo upload fail once. */
  failNextPhotoUpload(error: Error): void {
    this.photoFailure = error;
  }

  expireGoogleSyncTokens(refreshToken: string): void {
    const book = this.googleBook(refreshToken);
    book.version += 1;
    book.minValidVersion = book.version;
  }

  // ---- Provider views ----------------------------------------------------------------------

  appleContactsFor(appleId: string | null): SyncProviders['apple']['contacts'] {
    return {
      ctag: async () => {
        this.trace.push(`apple.contacts.ctag:${appleId}`);
        return this.appleBook(appleId ?? '').ctag;
      },
      list: async () => {
        this.trace.push(`apple.contacts:${appleId}`);
        const book = this.appleBook(appleId ?? '');
        return {
          ctag: book.ctag,
          objects: [...book.objects.entries()].map(
            ([href, o]): AppleContactObject => ({ href, etag: o.etag, vcard: o.vcard }),
          ),
        };
      },
      putObject: async (input) => {
        if (input.href !== null && this.beforeNextApplePut) {
          const change = this.beforeNextApplePut;
          this.beforeNextApplePut = null;
          change();
        }
        const book = this.appleBook(appleId ?? '');
        const href = input.href ?? `/card/${input.uid}.vcf`;
        if (input.href !== null) {
          const existing = book.objects.get(href);
          if (!existing) {
            throw new AppleObjectNotFoundError(href);
          }
          if (existing.etag !== input.etag) {
            throw new ApplePreconditionFailedError(href);
          }
        }
        this.appleWrites.push({ kind: 'put', href });
        const etag = this.next('etag');
        book.objects.set(href, { etag, vcard: input.vcard });
        book.ctag = this.next('ctag');
        return { href, etag };
      },
      fetchPhoto: async (url) => {
        this.photoDownloads.push(url);
        const bytes = this.applePhotos.get(url);
        if (!bytes) {
          throw new Error(`No photo at ${url}`);
        }
        return bytes;
      },
      deleteObject: async (href, etag) => {
        const book = this.appleBook(appleId ?? '');
        const existing = book.objects.get(href);
        if (!existing) {
          throw new AppleObjectNotFoundError(href);
        }
        if (existing.etag !== etag) {
          throw new ApplePreconditionFailedError(href);
        }
        this.appleWrites.push({ kind: 'delete', href });
        book.objects.delete(href);
        book.ctag = this.next('ctag');
      },
    };
  }

  googleContactsFor(refreshToken: string | null): SyncProviders['google']['contacts'] {
    const token = refreshToken ?? '';
    const book = () => {
      if (!this.google.has(token)) {
        throw new GoogleAuthError('invalid_grant', 'Token has been expired or revoked.');
      }
      return this.googleBook(token);
    };
    const rejectIfMarked = (data: { givenName: string } | undefined) => {
      const rejection = this.writeRejections.find(({ givenName }) => givenName === data?.givenName);
      if (rejection) {
        throw rejection.error;
      }
    };
    const applyGroups = (stored: { groups: Set<string> }, write: { addGroups: readonly string[]; removeGroups: readonly string[] }) => {
      write.addGroups.forEach((g) => stored.groups.add(g));
      write.removeGroups.forEach((g) => stored.groups.delete(g));
    };

    return {
      listGroups: async () => {
        this.trace.push(`google.groups:${token}`);
        return [...book().groups.values()];
      },
      listChanges: async (syncToken) => {
        this.trace.push(`google.contact-changes:${token}:${syncToken ?? 'full'}`);
        const b = book();
        const nextSyncToken = `cst-${b.version}`;
        if (syncToken === null) {
          return { contacts: this.googleContacts(token), deletedResourceNames: [], nextSyncToken };
        }
        const since = Number(syncToken.replace('cst-', ''));
        if (Number.isNaN(since) || since < b.minValidVersion) {
          throw new GoogleSyncTokenExpiredError();
        }
        return {
          contacts: this.googleContacts(token).filter((c) => (b.changedAt.get(c.resourceName) ?? 0) > since),
          deletedResourceNames: [...b.deletedAt].filter(([, at]) => at > since).map(([name]) => name),
          nextSyncToken,
        };
      },
      create: async (write) => {
        rejectIfMarked(write.data);
        const b = book();
        const resourceName = this.next('people/c');
        const stored = { data: write.data ?? contactData(), groups: new Set<string>(), photo: null };
        applyGroups(stored, write);
        this.googleWrites.push({ kind: 'create', resourceName });
        this.store(b, resourceName, stored);
        return this.googleContact(token, resourceName)!;
      },
      update: async (resourceName, write) => {
        rejectIfMarked(write.data);
        const b = book();
        const existing = b.contacts.get(resourceName);
        if (!existing) {
          throw new GoogleContactNotFoundError(resourceName);
        }
        const stored = { ...existing, data: write.data ?? existing.data, groups: new Set(existing.groups) };
        applyGroups(stored, write);
        this.googleWrites.push({ kind: 'update', resourceName });
        this.store(b, resourceName, stored);
        return this.googleContact(token, resourceName)!;
      },
      delete: async (resourceName) => {
        const b = book();
        if (!b.contacts.has(resourceName)) {
          throw new GoogleContactNotFoundError(resourceName);
        }
        this.googleWrites.push({ kind: 'delete', resourceName });
        this.drop(b, resourceName);
      },
      updatePhoto: async (resourceName, photo) => {
        const b = book();
        if (this.photoFailure) {
          const failure = this.photoFailure;
          this.photoFailure = null;
          throw failure;
        }
        const existing = b.contacts.get(resourceName);
        if (!existing) {
          throw new GoogleContactNotFoundError(resourceName);
        }
        this.googleWrites.push({ kind: 'photo', resourceName });
        this.photoUploads.push({ resourceName, photo });
        existing.photo = photo; // a photo upload is no content change the delta reports
      },
    };
  }

  // ---- internals ---------------------------------------------------------------------------

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private appleBook(appleId: string): AppleBook {
    let book = this.apple.get(appleId);
    if (!book) {
      book = { ctag: this.next('ctag'), objects: new Map() };
      this.apple.set(appleId, book);
    }
    return book;
  }

  private googleBook(refreshToken: string): GoogleBook {
    const book = this.google.get(refreshToken);
    if (!book) {
      throw new Error(`Unknown fake Google account ${refreshToken}`);
    }
    return book;
  }

  private store(book: GoogleBook, resourceName: string, stored: GoogleBook['contacts'] extends Map<string, infer V> ? V : never): void {
    book.version += 1;
    book.contacts.set(resourceName, stored);
    book.changedAt.set(resourceName, book.version);
    book.deletedAt.delete(resourceName);
  }

  private drop(book: GoogleBook, resourceName: string): void {
    book.version += 1;
    book.contacts.delete(resourceName);
    book.changedAt.delete(resourceName);
    book.deletedAt.set(resourceName, book.version);
  }
}
