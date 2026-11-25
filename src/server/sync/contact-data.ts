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

const MIN_PHONE_DIGITS = 6;

function fullName(data: ContactData): string {
  return [data.givenName, data.familyName].map(lower).filter(Boolean).join(' ');
}

interface IndexedCandidate {
  readonly contact: GoogleContact;
  readonly index: number;
}

/**
 * Pre-indexes pre-existing Google contacts by email, phone and full name so matching and claiming
 * during Initial Sync stays O(1) amortized instead of scanning all candidates per Apple contact.
 */
export function createContactCandidateIndex(candidates: readonly GoogleContact[]) {
  const claimed = new Set<GoogleContact>();
  const byEmail = new Map<string, IndexedCandidate[]>();
  const byPhone = new Map<string, IndexedCandidate[]>();
  const byName = new Map<string, IndexedCandidate[]>();
  const add = (map: Map<string, IndexedCandidate[]>, key: string, entry: IndexedCandidate) => {
    if (!key) {
      return;
    }
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      map.set(key, [entry]);
    }
  };
  for (let index = 0; index < candidates.length; index += 1) {
    const contact = candidates[index]!;
    const entry: IndexedCandidate = { contact, index };
    for (const email of contact.data.emails) {
      add(byEmail, lower(email), entry);
    }
    for (const phone of contact.data.phones) {
      const normalized = digits(phone);
      if (normalized.length >= MIN_PHONE_DIGITS) {
        add(byPhone, normalized, entry);
      }
    }
    add(byName, fullName(contact.data), entry);
  }

  const firstUnclaimed = (map: Map<string, IndexedCandidate[]>, keys: readonly string[]): GoogleContact | undefined => {
    let best: IndexedCandidate | undefined;
    for (const key of keys) {
      const bucket = map.get(key);
      if (!bucket) {
        continue;
      }
      while (bucket.length > 0 && claimed.has(bucket[0]!.contact)) {
        bucket.shift();
      }
      const head = bucket[0];
      if (head && (!best || head.index < best.index)) {
        best = head;
      }
    }
    return best?.contact;
  };

  return {
    /** Claims and returns the pre-existing Google contact matching `data`: by email, else phone, else full name. */
    claim(data: ContactData): GoogleContact | undefined {
      const emails = data.emails.map(lower).filter(Boolean);
      const phones = data.phones.map(digits).filter((p) => p.length >= MIN_PHONE_DIGITS);
      const name = data.givenName && data.familyName ? fullName(data) : '';
      const match =
        firstUnclaimed(byEmail, emails) ??
        firstUnclaimed(byPhone, phones) ??
        (name ? firstUnclaimed(byName, [name]) : undefined);
      if (match) {
        claimed.add(match);
      }
      return match;
    },
    isClaimed(contact: GoogleContact): boolean {
      return claimed.has(contact);
    },
  };
}

/**
 * Pre-indexes untracked Apple contacts so checking whether a Google-only contact already has an
 * Apple twin (by email, phone or full name) runs in O(1) instead of scanning the address book.
 */
export function createAppleContactTwinIndex(contacts: Iterable<ContactData>) {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const names = new Set<string>();
  for (const data of contacts) {
    for (const email of data.emails) {
      const normalized = lower(email);
      if (normalized) {
        emails.add(normalized);
      }
    }
    for (const phone of data.phones) {
      const normalized = digits(phone);
      if (normalized.length >= MIN_PHONE_DIGITS) {
        phones.add(normalized);
      }
    }
    if (data.givenName && data.familyName) {
      const name = fullName(data);
      if (name) {
        names.add(name);
      }
    }
  }
  return {
    hasTwin(candidate: ContactData): boolean {
      if (candidate.emails.some((e) => emails.has(lower(e)))) {
        return true;
      }
      if (candidate.phones.some((p) => phones.has(digits(p)))) {
        return true;
      }
      const name = fullName(candidate);
      return name !== '' && names.has(name);
    },
  };
}
