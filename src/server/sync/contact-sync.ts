import crypto from 'node:crypto';
import type { ContactRunResult, PlannedContactAction } from '../../shared/contacts.js';
import { ALL_CONTACTS_GROUP } from '../../shared/contacts.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import type { ProfileRow } from '../profiles/profile-store.js';
import {
  AppleObjectNotFoundError,
  ApplePreconditionFailedError,
  GoogleSyncTokenExpiredError,
  type AppleObjectRef,
} from '../providers/calendar-types.js';
import {
  GoogleContactNotFoundError,
  type GoogleContact,
  type GoogleContactChanges,
} from '../providers/contact-types.js';
import type { SyncProviders } from '../providers/types.js';
import { readAddressBook, type AddressBookEntry } from './address-book.js';
import { contactFingerprint, findMatchingContact, photoHash } from './contact-data.js';
import { listContactRules, updateContactRule, type ContactRuleRow } from './contact-rules-store.js';
import {
  deleteSyncedContact,
  getContactCursor,
  insertSyncedContact,
  listSyncedContacts,
  parseLabels,
  setContactCursor,
  updateSyncedContact,
  type SyncedContactRow,
} from './contact-store.js';
import { contactRuleLabel } from './rule-labels.js';
import { SyncLog } from './sync-log-store.js';
import type { GuardedDeletion } from './delete-guard.js';
import { carryOutPlan, failedRun, ignoringNotFound, type PlanEntryOf } from './run-plan.js';
import { addGroupMember, buildVCard, displayName, mergeIntoVCard, parseVCard } from './vcard.js';

export interface ContactSyncOptions {
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly profile: ProfileRow;
  readonly providers: SyncProviders;
  /** Plan only: read from both sides, write nothing anywhere. */
  readonly dryRun: boolean;
  /** Force-Resync: ignore ctag/ETag shortcuts and push every Apple contact again. */
  readonly force: boolean;
}

/** One planned deletion: everything needed to carry it out later, e.g. after an admin approval. */
export interface ContactDeletion extends GuardedDeletion {
  readonly target: 'apple' | 'google';
  readonly syncedContactId: string;
  readonly uid: string;
  readonly summary: string;
  readonly googleResourceName: string;
  readonly appleHref: string;
  readonly appleEtag: string;
}

type PlanEntry = PlanEntryOf<PlannedContactAction, ContactDeletion>;

/** What changed in Google since the last run (or everything, for a full listing). */
interface GoogleRead {
  readonly changes: GoogleContactChanges;
  readonly fullListing: boolean;
  /** Whether a tracked contact missing from a full listing counts as deleted in Google. */
  readonly absenceMeansDeleted: boolean;
}

const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort();

function ignoreGoogleNotFound(work: () => Promise<unknown>): Promise<void> {
  return ignoringNotFound(GoogleContactNotFoundError, work);
}

/** Carries out one planned deletion and drops its tracking record. */
export async function executeContactDeletion(
  env: { readonly db: AppDatabase; readonly providers: SyncProviders },
  item: ContactDeletion,
): Promise<void> {
  const { db, providers } = env;
  if (item.target === 'google') {
    await ignoreGoogleNotFound(() => providers.google.contacts.delete(item.googleResourceName));
  } else {
    try {
      await providers.apple.contacts.deleteObject(item.appleHref, item.appleEtag);
    } catch (error) {
      if (error instanceof ApplePreconditionFailedError) {
        return; // Apple changed in the meantime: Apple Master, keep it and let its change win
      }
      if (!(error instanceof AppleObjectNotFoundError)) {
        throw error;
      }
    }
  }
  deleteSyncedContact(db, item.syncedContactId);
}

/** Whether the rule's Apple group (or "All Contacts") holds the contact. */
function ruleClaims(book: ReturnType<typeof readAddressBook>, rule: ContactRuleRow, uid: string): boolean {
  return rule.appleGroupUid === ALL_CONTACTS_GROUP || (book.groups.get(rule.appleGroupUid)?.card.memberUids.includes(uid) ?? false);
}

function plan(
  options: ContactSyncOptions,
  rules: ContactRuleRow[],
  book: ReturnType<typeof readAddressBook>,
  google: GoogleRead | null,
): { entries: PlanEntry[]; trackedCount: number } {
  const { db, profile, providers } = options;
  const rows = listSyncedContacts(db, profile.id);
  const tracked = new Map(rows.map((row) => [row.appleContactUid, row]));

  const claims = (rule: ContactRuleRow, uid: string) => ruleClaims(book, rule, uid);
  const enabled = rules.filter((rule) => rule.enabled);
  const inScope = (uid: string) => enabled.some((rule) => claims(rule, uid));
  const enabledLabels = new Set(enabled.map((rule) => rule.googleGroupResourceName));
  const pausedLabels = new Set(
    rules.filter((rule) => !rule.enabled && !enabledLabels.has(rule.googleGroupResourceName)).map((rule) => rule.googleGroupResourceName),
  );
  const labelsOf = (uid: string) =>
    sortedUnique(enabled.filter((rule) => claims(rule, uid)).map((rule) => rule.googleGroupResourceName));
  // A paused rule is not processed at all: the labels it put on a contact stay exactly as they are
  const heldLabels = (row: SyncedContactRow) => parseLabels(row).filter((label) => pausedLabels.has(label));
  const isFrozen = (row: SyncedContactRow) => {
    const stored = parseLabels(row);
    return stored.length > 0 && heldLabels(row).length === stored.length;
  };
  const trackedResources = new Set(rows.map((row) => row.googleResourceName));
  // Google-only contacts: linked to an untracked Apple contact (Initial Sync) or imported into Apple
  const unclaimed = (google?.changes.contacts ?? []).filter((contact) => !trackedResources.has(contact.resourceName));
  const candidates = google?.fullListing ? unclaimed : [];

  // Google changes only reach contacts that a bidirectional rule claims
  const bidi = (uid: string) => enabled.some((rule) => rule.direction === 'bidirectional' && claims(rule, uid));
  const changedInGoogle = new Map((google?.changes.contacts ?? []).map((contact) => [contact.resourceName, contact]));
  const deletedInGoogle = new Set(google?.changes.deletedResourceNames ?? []);
  const goneFromGoogle = (row: SyncedContactRow) =>
    google !== null &&
    (google.fullListing
      ? google.absenceMeansDeleted && !changedInGoogle.has(row.googleResourceName)
      : deletedInGoogle.has(row.googleResourceName));
  // The Google contact of a tracked row, if it was edited there (not merely echoing our own write)
  const editedInGoogle = (row: SyncedContactRow): GoogleContact | undefined => {
    const contact = changedInGoogle.get(row.googleResourceName);
    return contact && row.googleFingerprint !== '' && contactFingerprint(contact.data) !== row.googleFingerprint
      ? contact
      : undefined;
  };
  const groups = new Map(
    [...book.groups].map(([uid, { object }]) => [uid, { href: object.href, etag: object.etag, vcard: object.vcard }]),
  );

  const entries: PlanEntry[] = [];
  const report = (action: PlannedContactAction['action'], uid: string, summary: string, reason?: string): PlannedContactAction => ({
    action,
    uid,
    summary,
    ...(reason ? { reason } : {}),
  });

  for (const [uid, entry] of book.contacts) {
    if (!inScope(uid)) {
      continue;
    }
    const row = tracked.get(uid);
    if (row) {
      entries.push(syncKnown(row, entry, sortedUnique([...labelsOf(uid), ...heldLabels(row)])));
      continue;
    }
    const labels = labelsOf(uid);
    const match = findMatchingContact(candidates, entry.card.data);
    if (match) {
      candidates.splice(candidates.indexOf(match), 1);
      entries.push(adopt(entry, match, labels));
    } else {
      entries.push(create(entry, labels));
    }
  }

  for (const row of rows) {
    const entry = book.contacts.get(row.appleContactUid);
    if ((entry && inScope(row.appleContactUid)) || isFrozen(row)) {
      continue;
    }
    // A card that cannot be read is not a deleted contact: leave it and its Google contact alone
    if (!entry && book.unreadableHrefs.has(row.appleHref)) {
      entries.push({ report: report('skip', row.appleContactUid, row.summary, 'invalid_vcard') });
      continue;
    }
    // A released contact (no labels left) is no longer managed in Google; only the record remains
    const released = parseLabels(row).length === 0;
    if (entry) {
      if (parseLabels(row).length > heldLabels(row).length) {
        entries.push(leave(row));
      }
      continue;
    }
    // A deleted contact can linger in group cards for a while, so absence from the book decides
    entries.push(released ? release(row) : remove(row));
  }

  for (const contact of unclaimed) {
    const targets = enabled.filter(
      (rule) => rule.direction === 'bidirectional' && contact.groupResourceNames.includes(rule.googleGroupResourceName),
    );
    if (targets.length === 0) {
      continue;
    }
    // Its Apple twin may simply sit outside the rule's group: importing would duplicate it
    const hasAppleTwin = [...book.contacts.values()].some(
      ({ card }) => !tracked.has(card.uid) && findMatchingContact([contact], card.data) !== undefined,
    );
    entries.push(
      hasAppleTwin
        ? { report: report('skip', contact.resourceName, displayName(contact.data) || contact.resourceName, 'matches_apple_contact') }
        : importToApple(contact, targets),
    );
  }
  return { entries, trackedCount: rows.length };

  /** A Google-only contact carrying a bidirectional rule's label: create it in Apple, in the rule's group. */
  function importToApple(contact: GoogleContact, targets: ContactRuleRow[]): PlanEntry {
    const uid = crypto.randomUUID().toUpperCase();
    const vcard = buildVCard(uid, contact.data);
    const summary = parseVCard(vcard).name;
    const labels = sortedUnique(targets.map((rule) => rule.googleGroupResourceName));
    return {
      report: { action: 'create', uid, summary, direction: 'google_to_apple' },
      apply: async () => {
        // The group is updated first: the contact must never exist in Apple outside its group,
        // or the next run would take it for a contact that left the group
        for (const groupUid of sortedUnique(targets.map((rule) => rule.appleGroupUid))) {
          const group = groups.get(groupUid);
          const extended = group ? addGroupMember(group.vcard, uid) : null;
          if (group && extended !== null && extended !== group.vcard) {
            const written = await providers.apple.contacts.putObject({
              href: group.href,
              uid: groupUid,
              vcard: extended,
              etag: group.etag,
            });
            groups.set(groupUid, { href: group.href, etag: written.etag, vcard: extended });
          }
        }
        const written = await providers.apple.contacts.putObject({ href: null, uid, vcard, etag: null });
        insertSyncedContact(db, {
          profileId: profile.id,
          appleContactUid: uid,
          appleHref: written.href,
          appleEtag: written.etag,
          summary,
          googleResourceName: contact.resourceName,
          googleFingerprint: contactFingerprint(contact.data),
          labels: JSON.stringify(labels),
        });
      },
    };
  }

  /** An uncontested Google edit: merge it into the current Apple vCard, leaving the rest of the card as is. */
  function writeBack(row: SyncedContactRow, entry: AddressBookEntry, edit: GoogleContact): PlanEntry {
    const { object } = entry;
    const merged = mergeIntoVCard(object.vcard, edit.data);
    const fingerprint = contactFingerprint(edit.data);
    if (merged === object.vcard) {
      return {
        report: report('skip', row.appleContactUid, row.summary, 'unchanged'),
        apply: async () => updateSyncedContact(db, row.id, { googleFingerprint: fingerprint }),
      };
    }
    const summary = parseVCard(merged).name;
    return {
      report: { action: 'update', uid: row.appleContactUid, summary, direction: 'google_to_apple' },
      apply: async () => {
        let written: AppleObjectRef;
        try {
          written = await providers.apple.contacts.putObject({
            href: object.href,
            uid: row.appleContactUid,
            vcard: merged,
            etag: object.etag,
          });
        } catch (error) {
          if (error instanceof ApplePreconditionFailedError) {
            return; // Apple changed meanwhile: Apple Master, its change is pushed to Google next run
          }
          throw error;
        }
        updateSyncedContact(db, row.id, { appleEtag: written.etag, summary, googleFingerprint: fingerprint });
      },
    };
  }

  /** Deleted in Google and untouched in Apple: delete it in Apple as well. */
  function removeFromApple(row: SyncedContactRow, entry: AddressBookEntry): PlanEntry {
    return deletion('apple', row, entry.object.etag);
  }

  /** Uploads the Apple photo unless its hash is the one already in Google; returns the hash now in Google. */
  async function syncPhoto(resourceName: string, photo: Buffer | null, knownHash: string): Promise<string> {
    if (!photo || photoHash(photo) === knownHash) {
      return knownHash;
    }
    await providers.google.contacts.updatePhoto(resourceName, photo);
    return photoHash(photo);
  }

  function create(entry: AddressBookEntry, labels: string[]): PlanEntry {
    const { card, object } = entry;
    return {
      report: report('create', card.uid, card.name),
      apply: async () => {
        const created = await providers.google.contacts.create({ data: card.data, addGroups: labels, removeGroups: [] });
        const id = insertSyncedContact(db, {
          profileId: profile.id,
          appleContactUid: card.uid,
          appleHref: object.href,
          appleEtag: object.etag,
          summary: card.name,
          googleResourceName: created.resourceName,
          googleFingerprint: contactFingerprint(created.data),
          labels: JSON.stringify(labels),
        });
        updateSyncedContact(db, id, { photoHash: await syncPhoto(created.resourceName, card.photo, '') });
      },
    };
  }

  /** Initial Sync found the contact in Google already: link it (adding the labels), never duplicate it. */
  function adopt(entry: AddressBookEntry, match: GoogleContact, labels: string[]): PlanEntry {
    const { card, object } = entry;
    return {
      report: report('skip', card.uid, card.name, 'matched_existing'),
      apply: async () => {
        if (labels.length > 0) {
          await providers.google.contacts.update(match.resourceName, { addGroups: labels, removeGroups: [] });
        }
        const id = insertSyncedContact(db, {
          profileId: profile.id,
          appleContactUid: card.uid,
          appleHref: object.href,
          appleEtag: object.etag,
          summary: card.name,
          googleResourceName: match.resourceName,
          googleFingerprint: contactFingerprint(match.data),
          labels: JSON.stringify(labels),
        });
        updateSyncedContact(db, id, { photoHash: await syncPhoto(match.resourceName, card.photo, '') });
      },
    };
  }

  function syncKnown(row: SyncedContactRow, entry: AddressBookEntry, labels: string[]): PlanEntry {
    const stored = parseLabels(row);
    const changed = row.appleEtag !== entry.object.etag || options.force;
    const writable = bidi(row.appleContactUid);
    const edit = writable ? editedInGoogle(row) : undefined;
    const gone = writable && goneFromGoogle(row);
    if (changed) {
      return updateGoogle(row, entry, labels, stored, gone || edit !== undefined);
    }
    if (gone) {
      return removeFromApple(row, entry);
    }
    if (edit) {
      return writeBack(row, entry, edit);
    }
    const labelsEqual = stored.join('\n') === labels.join('\n');
    // A photo that never made it to Google (e.g. the upload failed) is retried without an Apple change
    const photoPending = entry.card.photo !== null && photoHash(entry.card.photo) !== row.photoHash;
    if (labelsEqual && !photoPending) {
      return { report: report('skip', row.appleContactUid, row.summary, 'unchanged') };
    }
    return {
      report: report('update', row.appleContactUid, row.summary, labelsEqual ? 'photo_changed' : 'labels_changed'),
      apply: async () => {
        let hash = row.photoHash;
        try {
          if (!labelsEqual) {
            await providers.google.contacts.update(row.googleResourceName, {
              addGroups: labels.filter((label) => !stored.includes(label)),
              removeGroups: stored.filter((label) => !labels.includes(label)),
            });
          }
          hash = await syncPhoto(row.googleResourceName, entry.card.photo, row.photoHash);
        } catch (error) {
          if (!(error instanceof GoogleContactNotFoundError)) {
            throw error;
          }
          // Deleted by hand in Google: One-Way Sync leaves it, so there is no photo to retry either
          hash = entry.card.photo ? photoHash(entry.card.photo) : hash;
        }
        updateSyncedContact(db, row.id, { labels: JSON.stringify(labels), photoHash: hash });
      },
    };
  }

  /** The Apple contact changed: push its fields (and photo) to Google; Apple Master. */
  function updateGoogle(
    row: SyncedContactRow,
    entry: AddressBookEntry,
    labels: string[],
    stored: string[],
    /** Google changed the same contact since the last run; Apple Master settles it. */
    contested: boolean,
  ): PlanEntry {
    const { card, object } = entry;
    return {
      report: report('update', card.uid, card.name, contested ? 'apple_master' : undefined),
      apply: async () => {
        const write = {
          data: card.data,
          addGroups: labels.filter((label) => !stored.includes(label)),
          removeGroups: stored.filter((label) => !labels.includes(label)),
        };
        let resourceName = row.googleResourceName;
        let current: GoogleContact;
        try {
          current = await providers.google.contacts.update(resourceName, write);
        } catch (error) {
          if (!(error instanceof GoogleContactNotFoundError)) {
            throw error;
          }
          // Deleted by hand in Google: start the contact afresh
          current = await providers.google.contacts.create({ data: card.data, addGroups: labels, removeGroups: [] });
          resourceName = current.resourceName;
        }
        updateSyncedContact(db, row.id, {
          appleEtag: object.etag,
          summary: card.name,
          googleResourceName: resourceName,
          googleFingerprint: contactFingerprint(current.data),
          labels: JSON.stringify(labels),
          photoHash: await syncPhoto(resourceName, card.photo, row.photoHash),
        });
      },
    };
  }

  /**
   * The contact is still in the address book but in no synced group: drop the labels, keep the
   * Google contact. The record stays (without labels), so a contact that rejoins a group is
   * re-linked instead of duplicated.
   */
  function leave(row: SyncedContactRow): PlanEntry {
    const held = heldLabels(row);
    const removed = parseLabels(row).filter((label) => !held.includes(label));
    return {
      report: report('update', row.appleContactUid, row.summary, 'left_group'),
      apply: async () => {
        await ignoreGoogleNotFound(() =>
          providers.google.contacts.update(row.googleResourceName, { addGroups: [], removeGroups: removed }),
        );
        updateSyncedContact(db, row.id, { labels: JSON.stringify(held) });
      },
    };
  }

  /** A released contact was deleted in Apple: its Google contact is not ours to delete, just forget it. */
  function release(row: SyncedContactRow): PlanEntry {
    return {
      report: report('skip', row.appleContactUid, row.summary, 'no_longer_synced'),
      apply: async () => deleteSyncedContact(db, row.id),
    };
  }

  function remove(row: SyncedContactRow): PlanEntry {
    return deletion('google', row, row.appleEtag);
  }

  function deletion(target: 'apple' | 'google', row: SyncedContactRow, appleEtag: string): PlanEntry {
    const item: ContactDeletion = {
      target,
      syncedContactId: row.id,
      uid: row.appleContactUid,
      summary: row.summary,
      googleResourceName: row.googleResourceName,
      appleHref: row.appleHref,
      appleEtag,
    };
    return {
      report: {
        action: 'delete',
        uid: row.appleContactUid,
        summary: row.summary,
        ...(target === 'apple' ? { direction: 'google_to_apple' as const } : {}),
      },
      apply: () => executeContactDeletion({ db, providers }, item),
      deletion: item,
    };
  }
}

/**
 * Reads Google: the delta since the last run for bidirectional rules (a stale token is cleared and
 * replaced by a full listing), or a full listing when pre-existing contacts must be matched
 * (Initial Sync). One-Way Sync that has nothing to match never reads Google at all.
 */
async function readGoogle(
  options: ContactSyncOptions,
  syncToken: string | null,
  bidirectional: boolean,
  needsMatching: boolean,
): Promise<GoogleRead | null> {
  const { db, profile, providers } = options;
  if (!bidirectional && !needsMatching) {
    return null;
  }
  if (bidirectional && !needsMatching && syncToken !== null) {
    try {
      return {
        changes: await providers.google.contacts.listChanges(syncToken),
        fullListing: false,
        absenceMeansDeleted: false,
      };
    } catch (error) {
      if (!(error instanceof GoogleSyncTokenExpiredError)) {
        throw error;
      }
      if (!options.dryRun) {
        setContactCursor(db, profile.id, { googleSyncToken: null });
      }
    }
  }
  // Without a token ever issued (first bidirectional run, e.g. after switching from One-Way), a
  // missing contact may be a manual deletion from the One-Way era, which One-Way Sync ignores.
  // Only after a token existed do we know that the full listing replaces a delta we could have missed.
  return {
    changes: await providers.google.contacts.listChanges(null),
    fullListing: true,
    absenceMeansDeleted: bidirectional && syncToken !== null,
  };
}

async function run(options: ContactSyncOptions): Promise<ContactRunResult | null> {
  const { db, clock, profile, providers } = options;
  const rules = listContactRules(db, profile.id);
  if (rules.length === 0) {
    return null;
  }
  const enabled = rules.filter((rule) => rule.enabled);
  if (enabled.length === 0) {
    return { status: 'skipped', reason: 'paused', actions: [] };
  }

  const cursor = getContactCursor(db, profile.id);
  const raw = await providers.apple.contacts.list();
  const initialDone = enabled.every((rule) => rule.initialSyncCompletedAt !== null);
  const bidirectional = enabled.some((rule) => rule.direction === 'bidirectional');
  // Google may have changed without Apple noticing, so only One-Way Sync can idle on the ctag
  if (!bidirectional && !options.force && initialDone && raw.ctag !== null && raw.ctag === cursor.appleCtag) {
    return { status: 'skipped', reason: 'unchanged', actions: [] };
  }
  const book = readAddressBook(raw);
  const log = new SyncLog(db, clock, profile.id, 'contact');
  for (const rule of enabled) {
    if (rule.appleGroupUid !== ALL_CONTACTS_GROUP && !book.groups.has(rule.appleGroupUid)) {
      const error = `The Apple contact group "${rule.appleGroupName}" no longer exists`;
      if (!options.dryRun) {
        log.runFailed(rule.id, contactRuleLabel(rule), new Error(error));
      }
      return { status: 'error', error, actions: [] };
    }
  }

  const google = await readGoogle(options, cursor.googleSyncToken, bidirectional, !initialDone);
  const planned = plan(options, rules, book, google);
  // A contact belongs to the rule whose group holds it, or else to the rule whose label it carries
  const syncedLabels = new Map(listSyncedContacts(db, profile.id).map((row) => [row.appleContactUid, parseLabels(row)]));
  const ruleIdOf = (uid: string): string | null =>
    (
      enabled.find((rule) => ruleClaims(book, rule, uid)) ??
      rules.find((rule) => syncedLabels.get(uid)?.includes(rule.googleGroupResourceName))
    )?.id ?? null;

  return carryOutPlan({
    db,
    clock,
    profileId: profile.id,
    log,
    dryRun: options.dryRun,
    entries: planned.entries,
    trackedItems: planned.trackedCount,
    held: (_entry, deletion): PlanEntry => ({
      report: { action: 'skip', uid: deletion.uid, summary: deletion.summary, reason: 'delete_guard' },
    }),
    domain: 'contacts',
    approvalRuleId: null,
    recovered: [...enabled.map((rule) => rule.id), null],
    logRuleId: (entry) => ruleIdOf(entry.report.uid),
    commit: () => {
      setContactCursor(db, profile.id, {
        appleCtag: raw.ctag,
        googleSyncToken: bidirectional ? (google?.changes.nextSyncToken ?? null) : null,
      });
      for (const rule of enabled) {
        updateContactRule(db, rule.id, { initialSyncCompletedAt: rule.initialSyncCompletedAt ?? clock.now() });
      }
    },
  });
}

/**
 * Contacts are tracked profile-wide: after any contact rule changed, the next run must look at the
 * address book again, as an unchanged Apple side must not hide the changed rules.
 */
export function invalidateContactSync(db: AppDatabase, profileId: string): void {
  setContactCursor(db, profileId, { appleCtag: null });
}

/** Plans (and, unless `dryRun`, applies) the profile-wide contact sync; null when there are no contact rules. */
export async function runContactSync(options: ContactSyncOptions): Promise<ContactRunResult | null> {
  try {
    return await run(options);
  } catch (error) {
    const log = new SyncLog(options.db, options.clock, options.profile.id, 'contact');
    const message = failedRun({ log, dryRun: options.dryRun, ruleId: null, summary: 'Contact sync' }, error);
    return { status: 'error', error: message, actions: [] };
  }
}

/**
 * Deleting a rule keeps the synced Google contacts: the sync only forgets that it manages the
 * rule's label (unless another rule uses the same Google label).
 */
export function forgetRuleLabel(db: AppDatabase, profileId: string, rule: ContactRuleRow, remaining: ContactRuleRow[]): void {
  if (remaining.some((other) => other.googleGroupResourceName === rule.googleGroupResourceName)) {
    return;
  }
  for (const row of listSyncedContacts(db, profileId)) {
    const labels = parseLabels(row);
    if (labels.includes(rule.googleGroupResourceName)) {
      updateSyncedContact(db, row.id, {
        labels: JSON.stringify(labels.filter((label) => label !== rule.googleGroupResourceName)),
      });
    }
  }
}

/**
 * Cleanup opt-in: removes the rule's label from the synced contacts and deletes the Google
 * contacts that no other rule keeps. Safe to retry after a failure.
 */
export async function removeRuleFromGoogle(env: {
  readonly db: AppDatabase;
  readonly providers: SyncProviders;
  readonly profileId: string;
  readonly rule: ContactRuleRow;
  readonly remaining: ContactRuleRow[];
}): Promise<void> {
  const { db, providers, profileId, rule, remaining } = env;
  if (remaining.some((other) => other.googleGroupResourceName === rule.googleGroupResourceName)) {
    return;
  }
  for (const row of listSyncedContacts(db, profileId)) {
    const labels = parseLabels(row);
    if (!labels.includes(rule.googleGroupResourceName)) {
      continue;
    }
    const kept = labels.filter((label) => label !== rule.googleGroupResourceName);
    if (kept.length === 0) {
      await ignoreGoogleNotFound(() => providers.google.contacts.delete(row.googleResourceName));
      deleteSyncedContact(db, row.id);
    } else {
      await ignoreGoogleNotFound(() =>
        providers.google.contacts.update(row.googleResourceName, { addGroups: [], removeGroups: [rule.googleGroupResourceName] }),
      );
      updateSyncedContact(db, row.id, { labels: JSON.stringify(kept) });
    }
  }
}
