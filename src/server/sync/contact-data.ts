import crypto from 'node:crypto';
import type { ContactData, GoogleContact } from '../providers/contact-types.js';

const lower = (value: string) => value.trim().toLowerCase();
const digits = (value: string) => value.replace(/[^\d]/g, '');
const sorted = (values: readonly string[]) => [...values].sort();

/** Content hash of the synced fields, tolerant of formatting Google may normalize. */
export function contactFingerprint(data: ContactData): string {
  const content = [
    [data.givenName, data.familyName, data.middleName, data.prefix, data.suffix].map(lower),
    lower(data.organization),
    lower(data.title),
    sorted(data.emails.map(lower)),
    sorted(data.phones.map(digits)),
    data.birthday,
    sorted(data.addresses.map((a) => [a.street, a.city, a.region, a.postalCode, a.country].map(lower).join('|'))),
    data.note.trim(),
  ];
  return crypto.createHash('sha1').update(JSON.stringify(content)).digest('hex');
}

export function photoHash(photo: Buffer): string {
  return crypto.createHash('sha1').update(photo).digest('hex');
}

const MIN_PHONE_DIGITS = 6;

function fullName(data: ContactData): string {
  return [data.givenName, data.familyName].map(lower).filter(Boolean).join(' ');
}

/** Finds the pre-existing Google contact for an Apple contact: by email, else phone, else full name. */
export function findMatchingContact(
  candidates: readonly GoogleContact[],
  data: ContactData,
): GoogleContact | undefined {
  const emails = new Set(data.emails.map(lower).filter(Boolean));
  const phones = new Set(data.phones.map(digits).filter((p) => p.length >= MIN_PHONE_DIGITS));
  const name = data.givenName && data.familyName ? fullName(data) : '';
  return (
    candidates.find((c) => c.data.emails.some((e) => emails.has(lower(e)))) ??
    candidates.find((c) => c.data.phones.some((p) => phones.has(digits(p)))) ??
    (name ? candidates.find((c) => fullName(c.data) === name) : undefined)
  );
}
