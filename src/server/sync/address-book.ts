import type { AppleContactBook, AppleContactObject } from '../providers/contact-types.js';
import { parseVCard, type ParsedVCard } from './vcard.js';

export interface AddressBookEntry {
  readonly object: AppleContactObject;
  readonly card: ParsedVCard;
}

export interface AddressBook {
  readonly contacts: Map<string, AddressBookEntry>;
  readonly groups: Map<string, AddressBookEntry>;
  /** Hrefs of resources that are not usable vCards: they must not be mistaken for deleted contacts. */
  readonly unreadableHrefs: Set<string>;
}

/** Sorts the vCards of the iCloud address book into contacts and contact groups, keyed by UID. */
export function readAddressBook(book: AppleContactBook): AddressBook {
  const result: AddressBook = { contacts: new Map(), groups: new Map(), unreadableHrefs: new Set() };
  for (const object of book.objects) {
    try {
      const card = parseVCard(object.vcard);
      (card.isGroup ? result.groups : result.contacts).set(card.uid, { object, card });
    } catch {
      result.unreadableHrefs.add(object.href);
    }
  }
  return result;
}
