/** Contact-specific shapes exchanged through the SyncProviders seam. */

export interface ContactAddress {
  readonly street: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * The standard fields both sides share. Everything else a vCard carries (`X-APPLE-*`, labels,
 * social profiles, …) is Apple's own and never leaves Apple.
 */
export interface ContactData {
  readonly givenName: string;
  readonly familyName: string;
  readonly middleName: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly organization: string;
  readonly title: string;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  /** `YYYY-MM-DD`, or null. */
  readonly birthday: string | null;
  readonly addresses: readonly ContactAddress[];
  readonly note: string;
}

/** One vCard resource of the iCloud address book: a contact or a contact group. */
export interface AppleContactObject {
  readonly href: string;
  readonly etag: string;
  readonly vcard: string;
}

export interface AppleContactBook {
  /** Collection tag; changes whenever anything in the address book changes. */
  readonly ctag: string | null;
  readonly objects: readonly AppleContactObject[];
}

/** A write of one vCard to Apple CardDAV. */
export interface AppleContactWrite {
  /** The resource to overwrite, or null to create a new one (the adapter derives its URL from `uid`). */
  readonly href: string | null;
  readonly uid: string;
  readonly vcard: string;
  /** ETag the overwrite is conditional on (`If-Match`); ignored for creates. */
  readonly etag: string | null;
}

export interface GoogleContactGroupInfo {
  /** e.g. `contactGroups/6c2d3a`. */
  readonly resourceName: string;
  readonly name: string;
}

export interface GoogleContact {
  /** e.g. `people/c123`. */
  readonly resourceName: string;
  readonly data: ContactData;
  /** Resource names of the user contact groups (labels) the contact carries. */
  readonly groupResourceNames: readonly string[];
}

export interface GoogleContactChanges {
  /** Created or modified contacts. */
  readonly contacts: readonly GoogleContact[];
  /** Resource names of deleted contacts. Always empty for a full listing. */
  readonly deletedResourceNames: readonly string[];
  readonly nextSyncToken: string;
}

/** A change to a Google contact: fields (when given) plus the labels to add and remove. */
export interface GoogleContactWrite {
  readonly data?: ContactData;
  readonly addGroups: readonly string[];
  readonly removeGroups: readonly string[];
}

/** iCloud no longer serves the photo a vCard links to (HTTP 404 or 410): retrying cannot help. */
export class ApplePhotoGoneError extends Error {
  constructor(url: string, status: number) {
    super(`iCloud contact photo is gone (HTTP ${status}): ${new URL(url).host}`);
    this.name = 'ApplePhotoGoneError';
  }
}

export class GoogleContactNotFoundError extends Error {
  constructor(resourceName: string) {
    super(`Google contact ${resourceName} not found`);
    this.name = 'GoogleContactNotFoundError';
  }
}
