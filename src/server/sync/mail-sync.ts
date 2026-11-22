import type { MailDeleteBehavior, MailRunResult, PlannedMailAction } from '../../shared/mail.js';
import { GMAIL_STARRED, GMAIL_UNREAD } from '../../shared/mail.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import type { ProfileRow } from '../profiles/profile-store.js';
import {
  AppleMailFolderNotFoundError,
  GoogleMessageNotFoundError,
  type AppleMailEnvelope,
  type AppleMailListing,
  type AppleMailMessage,
} from '../providers/mail-types.js';
import { GoogleAuthError, type SyncProviders } from '../providers/types.js';
import { mailRuleLabel } from './rule-labels.js';
import { SyncLog } from './sync-log-store.js';
import { holdBackDeletions, queueDeletions, type GuardedDeletion } from './delete-guard.js';
import { messageKey } from './mail-key.js';
import { listMailRules, type MailRuleRow } from './mail-rules-store.js';
import {
  deleteMailFolderState,
  deleteSyncedEmail,
  insertSyncedEmail,
  listMailFolderStates,
  listSyncedEmails,
  parseLocations,
  setMailFolderState,
  updateSyncedEmail,
  type MailLocation,
  type SyncedEmailRow,
} from './mail-store.js';

const DAY_MS = 86_400_000;
/** One run imports at most this many messages, so a large backfill never turns into one endless request. */
const MAX_IMPORTS_PER_RUN = 100;

export interface MailSyncOptions {
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly profile: ProfileRow;
  readonly providers: SyncProviders;
  /** Plan only: read from both sides, write nothing anywhere (not even a Gmail label). */
  readonly dryRun: boolean;
  /** Force-Resync: push the iCloud labels and flags of every tracked message again. */
  readonly force: boolean;
}

/** One planned deletion: everything needed to carry it out later, e.g. after an admin approval. */
export interface MailDeletion extends GuardedDeletion {
  readonly target: 'google';
  readonly syncedEmailId: string;
  readonly uid: string;
  readonly summary: string;
  readonly googleMessageId: string;
  readonly behavior: MailDeleteBehavior;
}

interface PlanEntry {
  readonly report: PlannedMailAction;
  readonly apply?: () => Promise<void>;
  readonly deletion?: MailDeletion;
  /** The rule of the folder the message sits in, for the sync log; absent when not attributable. */
  readonly ruleId?: string;
}

/** One copy of a message in a synced iCloud folder. */
interface Presence {
  readonly rule: MailRuleRow;
  readonly uid: number;
  readonly seen: boolean;
  readonly flagged: boolean;
  readonly internalDate: number;
}

interface FolderRead {
  readonly rule: MailRuleRow;
  readonly listing: AppleMailListing;
  /** The server renumbered the folder since the last run: stored UIDs mean nothing anymore. */
  readonly revalidated: boolean;
}

const noSubject = '(no subject)';

async function ignoreGmailNotFound(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof GoogleMessageNotFoundError)) {
      throw error;
    }
  }
}

/** Resolves Gmail label names to ids, creating missing custom labels only when asked to. */
function createLabelResolver(providers: SyncProviders) {
  // Gmail label names are case-insensitive: `receipts` and `Receipts` are the same label
  const keyOf = (name: string) => name.toLowerCase();
  let known: Promise<Map<string, string>> | null = null;
  const load = () => (known ??= providers.google.mail.listLabels().then((labels) => new Map(labels.map((l) => [keyOf(l.name), l.id]))));
  return {
    async find(name: string): Promise<string | undefined> {
      return (await load()).get(keyOf(name));
    },
    async ensure(name: string): Promise<string> {
      const labels = await load();
      let id = labels.get(keyOf(name));
      if (!id) {
        id = (await providers.google.mail.createLabel(name)).id;
        labels.set(keyOf(name), id);
      }
      return id;
    },
  };
}

function flagLabels(seen: boolean, flagged: boolean) {
  return {
    add: [...(seen ? [] : [GMAIL_UNREAD]), ...(flagged ? [GMAIL_STARRED] : [])],
    remove: [...(seen ? [GMAIL_UNREAD] : []), ...(flagged ? [] : [GMAIL_STARRED])],
  };
}

/** Carries out one planned deletion and drops its tracking record. */
export async function executeMailDeletion(
  env: { readonly db: AppDatabase; readonly providers: SyncProviders },
  item: MailDeletion,
): Promise<void> {
  const mail = env.providers.google.mail;
  await ignoreGmailNotFound(() => (item.behavior === 'delete' ? mail.delete(item.googleMessageId) : mail.trash(item.googleMessageId)));
  deleteSyncedEmail(env.db, item.syncedEmailId);
}

/** `trash` unless every rule involved says `delete`: the recoverable choice wins when rules disagree. */
function behaviorFor(rules: readonly MailRuleRow[]): MailDeleteBehavior {
  return rules.length > 0 && rules.every((rule) => rule.deleteBehavior === 'delete') ? 'delete' : 'trash';
}

async function readEnvelopes(
  providers: SyncProviders,
  path: string,
  messages: readonly AppleMailMessage[],
): Promise<Map<number, { envelope: AppleMailEnvelope; message: AppleMailMessage }>> {
  const found = new Map<number, { envelope: AppleMailEnvelope; message: AppleMailMessage }>();
  if (messages.length === 0) {
    return found;
  }
  const byUid = new Map(messages.map((message) => [message.uid, message]));
  for (const envelope of await providers.apple.mail.fetchEnvelopes(path, messages.map((message) => message.uid))) {
    const message = byUid.get(envelope.uid);
    if (message) {
      found.set(envelope.uid, { envelope, message });
    }
  }
  return found;
}

/** The iCloud Trash folder as seen in this run. */
interface TrashRead {
  readonly path: string;
  readonly listing: AppleMailListing;
  /** Messages that arrived since the last run, by message key. */
  readonly fresh: ReadonlyMap<string, number>;
  /** The server renumbered the Trash: its UIDs say nothing about earlier runs. */
  readonly reset: boolean;
}

function mailDeletion(row: SyncedEmailRow, behavior: MailDeleteBehavior): MailDeletion {
  return {
    target: 'google',
    syncedEmailId: row.id,
    uid: row.messageIdKey,
    summary: row.summary,
    googleMessageId: row.googleMessageId,
    behavior,
  };
}

async function plan(
  options: MailSyncOptions,
  rules: MailRuleRow[],
  reads: FolderRead[],
  rows: SyncedEmailRow[],
  trash: TrashRead | null,
): Promise<PlanEntry[]> {
  const { db, providers, profile, clock } = options;
  const labels = createLabelResolver(providers);
  const windowStart = (rule: MailRuleRow) => (rule.syncWindowDays === null ? null : clock.now() - rule.syncWindowDays * DAY_MS);
  const inWindow = (presence: Presence) => {
    const start = windowStart(presence.rule);
    return start === null || presence.internalDate >= start;
  };
  let imports = 0;
  const ruleOf = new Map(rules.map((rule) => [rule.appleFolderPath, rule]));
  const processed = new Map(reads.map((read) => [read.rule.appleFolderPath, read]));
  const byKey = new Map(rows.map((row) => [row.messageIdKey, row]));
  const subjects = new Map<string, string>();

  // Who is where: known messages by their stored UID, the rest by their headers
  const presence = new Map<string, Presence[]>();
  const addPresence = (key: string, entry: Presence) => {
    const list = presence.get(key) ?? [];
    if (!list.some((other) => other.rule.id === entry.rule.id)) {
      list.push(entry);
    }
    presence.set(key, list);
  };
  const knownKeys = new Map<string, string>();
  for (const row of rows) {
    for (const location of parseLocations(row)) {
      knownKeys.set(`${location.folder}\n${location.uid}`, row.messageIdKey);
    }
  }
  const asPresence = (read: FolderRead, message: AppleMailMessage): Presence => ({
    rule: read.rule,
    uid: message.uid,
    seen: message.seen,
    flagged: message.flagged,
    internalDate: message.internalDate,
  });
  /** Messages whose headers were not worth reading (yet), per folder. */
  const deferred = new Map<string, AppleMailMessage[]>();
  for (const read of reads) {
    const path = read.rule.appleFolderPath;
    const unknown: AppleMailMessage[] = [];
    for (const message of read.listing.messages) {
      const key = read.revalidated ? undefined : knownKeys.get(`${path}\n${message.uid}`);
      if (key) {
        addPresence(key, asPresence(read, message));
      } else {
        unknown.push(message);
      }
    }
    // A re-indexed folder needs every identity; otherwise only messages we might import
    const start = windowStart(read.rule);
    const worthReading = (message: AppleMailMessage) => read.revalidated || start === null || message.internalDate >= start;
    for (const { envelope, message } of (await readEnvelopes(providers, path, unknown.filter(worthReading))).values()) {
      const key = messageKey(envelope, message.size);
      subjects.set(key, envelope.subject.trim() || noSubject);
      addPresence(key, asPresence(read, message));
    }
    deferred.set(path, unknown.filter((message) => !worthReading(message)));
  }

  // A tracked message that vanished from its folder may just have moved to a folder of its own
  // that holds it outside the window: only then is it worth reading the older headers
  const vanished = (row: SyncedEmailRow) =>
    !presence.has(row.messageIdKey) && parseLocations(row).some((location) => processed.has(location.folder));
  if (rows.some(vanished)) {
    for (const read of reads) {
      const path = read.rule.appleFolderPath;
      for (const { envelope, message } of (await readEnvelopes(providers, path, deferred.get(path) ?? [])).values()) {
        const key = messageKey(envelope, message.size);
        if (byKey.has(key)) {
          addPresence(key, asPresence(read, message));
        }
      }
    }
  }

  const entries: PlanEntry[] = [];
  const report = (action: PlannedMailAction['action'], uid: string, summary: string, reason?: string): PlannedMailAction => ({
    action,
    uid,
    summary,
    ...(reason ? { reason } : {}),
  });
  const locationsOf = (copies: readonly Presence[]): MailLocation[] =>
    copies.map((copy) => ({ folder: copy.rule.appleFolderPath, uid: copy.uid }));

  /** (Re-)imports a message into Gmail and returns its new id. */
  async function importCopy(read: Presence, labelNames: readonly string[]): Promise<string> {
    const raw = await providers.apple.mail.fetchRaw(read.rule.appleFolderPath, read.uid);
    const labelIds = await Promise.all(labelNames.map((name) => labels.ensure(name)));
    const flags = flagLabels(read.seen, read.flagged);
    return providers.google.mail.importMessage({ raw, labelIds: [...labelIds, ...flags.add] });
  }

  for (const [key, copies] of presence) {
    const row = byKey.get(key);
    const first = copies[0]!;
    const labelNames = [...new Set(copies.map((copy) => copy.rule.googleLabel))];

    if (!row) {
      if (!copies.some(inWindow) || imports >= MAX_IMPORTS_PER_RUN) {
        continue; // outside the window, or left for the next run
      }
      imports += 1;
      const summary = subjects.get(key) ?? noSubject;
      entries.push({
        report: report('create', key, summary),
        ruleId: first.rule.id,
        apply: async () => {
          const googleMessageId = await importCopy(first, labelNames);
          insertSyncedEmail(db, {
            profileId: profile.id,
            messageIdKey: key,
            summary,
            googleMessageId,
            locations: JSON.stringify(locationsOf(copies)),
            seen: first.seen,
            flagged: first.flagged,
          });
        },
      });
      continue;
    }

    const stored = parseLocations(row);
    const heldLocations = stored.filter((location) => !processed.has(location.folder));
    const wasIn = new Set(stored.filter((location) => processed.has(location.folder)).map((location) => location.folder));
    const nowIn = new Set(copies.map((copy) => copy.rule.appleFolderPath));
    const labelOf = (folder: string) => ruleOf.get(folder)!.googleLabel;
    const wanted = new Set(labelNames);
    const added = [...nowIn].filter((folder) => !wasIn.has(folder)).map(labelOf);
    const remove = [...wasIn].filter((folder) => !nowIn.has(folder)).map(labelOf).filter((name) => !wanted.has(name));
    const flagsChanged = row.seen !== first.seen || row.flagged !== first.flagged;
    const labelsChanged = added.length > 0 || remove.length > 0;
    const newLocations = JSON.stringify([...heldLocations, ...locationsOf(copies)]);
    const restored = row.trashUid !== null;
    if (!labelsChanged && !flagsChanged && !options.force && !restored) {
      const reindexed = newLocations !== row.locations;
      entries.push({
        report: report('skip', key, row.summary, reindexed ? 'reindexed' : 'unchanged'),
        ...(reindexed ? { apply: async () => updateSyncedEmail(db, row.id, { locations: newLocations }) } : {}),
      });
      continue;
    }

    // Gmail takes a trashed message out of the inbox, so a restored one gets all of its labels back
    const forceLabels = options.force || restored
      ? {
          add: labelNames,
          remove: [...new Set(rules.filter((rule) => rule.enabled).map((rule) => rule.googleLabel))].filter((name) => !wanted.has(name)),
        }
      : { add: [...new Set(added)], remove };
    const flags = flagLabels(first.seen, first.flagged);
    const reason = restored ? 'restored_from_trash' : labelsChanged ? 'moved' : flagsChanged ? 'flags_changed' : 'force_resync';
    entries.push({
      report: report('update', key, row.summary, reason),
      ruleId: first.rule.id,
      apply: async () => {
        if (restored) {
          await ignoreGmailNotFound(() => providers.google.mail.untrash(row.googleMessageId));
        }
        const addIds = await Promise.all(forceLabels.add.map((name) => labels.ensure(name)));
        const removeIds = (await Promise.all(forceLabels.remove.map((name) => labels.find(name)))).flatMap((id) => (id ? [id] : []));
        let googleMessageId = row.googleMessageId;
        try {
          await providers.google.mail.modify(googleMessageId, {
            addLabelIds: [...addIds, ...flags.add],
            removeLabelIds: [...removeIds, ...flags.remove],
          });
        } catch (error) {
          if (!(error instanceof GoogleMessageNotFoundError)) {
            throw error;
          }
          // Deleted by hand in Gmail: iCloud changed, so the message starts afresh
          googleMessageId = await importCopy(first, labelNames);
        }
        updateSyncedEmail(db, row.id, {
          googleMessageId,
          trashUid: null,
          locations: newLocations,
          seen: first.seen,
          flagged: first.flagged,
        });
      },
    });
  }

  for (const row of rows) {
    if (presence.has(row.messageIdKey)) {
      continue;
    }
    const stored = parseLocations(row);
    const inProcessed = stored.filter((location) => processed.has(location.folder));
    const originRules = stored.flatMap((location) => {
      const rule = ruleOf.get(location.folder);
      return rule ? [rule] : [];
    });

    const deletion = (reason: string, behavior: MailDeleteBehavior): PlanEntry => {
      const item = mailDeletion(row, behavior);
      return {
        report: report('delete', row.messageIdKey, row.summary, reason),
        ...(originRules[0] ? { ruleId: originRules[0].id } : {}),
        apply: () => executeMailDeletion({ db, providers }, item),
        deletion: item,
      };
    };

    if (row.trashUid !== null) {
      // Already moved to the iCloud Trash: only its permanent removal from there is left to notice
      if (!trash || trash.reset || trash.listing.messages.some((message) => message.uid === row.trashUid)) {
        continue;
      }
      const behavior = behaviorFor(originRules);
      entries.push(
        behavior === 'delete'
          ? deletion('expunged', behavior)
          : {
              report: report('skip', row.messageIdKey, row.summary, 'no_longer_synced'),
              apply: async () => deleteSyncedEmail(db, row.id),
            },
      );
      continue;
    }
    if (inProcessed.length === 0) {
      continue; // held by a paused rule, or no rule manages its folder anymore
    }
    if (inProcessed.some((location) => processed.get(location.folder)!.revalidated)) {
      // The folder was renumbered: a message missing from the fresh listing is not proof of a deletion.
      // Its old UIDs mean nothing now (another message may get them), so they are forgotten; the next
      // run, which knows the new UIDVALIDITY, then judges it by its absence.
      const forgotten = JSON.stringify(
        stored.map((location) => (processed.get(location.folder)?.revalidated ? { ...location, uid: 0 } : location)),
      );
      entries.push({
        report: report('skip', row.messageIdKey, row.summary, 'uidvalidity_changed'),
        apply: async () => updateSyncedEmail(db, row.id, { locations: forgotten }),
      });
      continue;
    }
    const trashedAs = trash?.fresh.get(row.messageIdKey);
    if (trashedAs !== undefined) {
      entries.push({
        report: report('update', row.messageIdKey, row.summary, 'moved_to_trash'),
        ...(originRules[0] ? { ruleId: originRules[0].id } : {}),
        apply: async () => {
          await ignoreGmailNotFound(() => providers.google.mail.trash(row.googleMessageId));
          updateSyncedEmail(db, row.id, { trashUid: trashedAs });
        },
      });
      continue;
    }
    entries.push(deletion('expunged', behaviorFor(originRules)));
  }
  return entries;
}

async function run(options: MailSyncOptions): Promise<MailRunResult | null> {
  const { db, clock, profile, providers } = options;
  const rules = listMailRules(db, profile.id);
  if (rules.length === 0) {
    return null;
  }
  const enabled = rules.filter((rule) => rule.enabled);
  if (enabled.length === 0) {
    return { status: 'skipped', reason: 'paused', actions: [] };
  }

  const log = new SyncLog(db, clock, profile.id, 'email');
  const states = listMailFolderStates(db, profile.id);
  const reads: FolderRead[] = [];
  for (const rule of enabled) {
    try {
      const listing = await providers.apple.mail.listFolder(rule.appleFolderPath);
      const state = states.get(rule.appleFolderPath);
      reads.push({ rule, listing, revalidated: state !== undefined && state.uidValidity !== listing.uidValidity });
    } catch (error) {
      if (error instanceof AppleMailFolderNotFoundError) {
        const message = `The Apple mail folder "${rule.appleFolderName}" no longer exists`;
        if (!options.dryRun) {
          log.runFailed(rule.id, mailRuleLabel(rule), new Error(message));
        }
        return { status: 'error', error: message, actions: [] };
      }
      throw error;
    }
  }

  // The Trash folder is only watched for new arrivals: that is how a "delete" in Mail.app shows up
  const trashFolder = (await providers.apple.mail.listFolders()).find((folder) => folder.use === 'trash');
  let trash: TrashRead | null = null;
  if (trashFolder) {
    try {
      const listing = await providers.apple.mail.listFolder(trashFolder.path);
      const state = states.get(trashFolder.path);
      const reset = state !== undefined && state.uidValidity !== listing.uidValidity;
      const fresh = new Map<string, number>();
      if (state && !reset) {
        const arrivals = listing.messages.filter((message) => message.uid > state.lastUid);
        for (const { envelope, message } of (await readEnvelopes(providers, trashFolder.path, arrivals)).values()) {
          fresh.set(messageKey(envelope, message.size), message.uid);
        }
      }
      trash = { path: trashFolder.path, listing, fresh, reset };
    } catch (error) {
      if (!(error instanceof AppleMailFolderNotFoundError)) {
        throw error;
      }
    }
  }

  const rows = listSyncedEmails(db, profile.id);
  const guarded = holdBackDeletions(
    await plan(options, rules, reads, rows, trash),
    rows.length,
    (_entry, deletion): PlanEntry => ({
      report: { action: 'skip', uid: deletion.uid, summary: deletion.summary, reason: 'delete_guard' },
    }),
  );

  if (options.dryRun) {
    return { status: 'ok', actions: guarded.entries.map((entry) => entry.report) };
  }
  const deleteApprovalId =
    guarded.batch.length > 0
      ? queueDeletions(db, { profileId: profile.id, domain: 'mail', ruleId: null, items: guarded.batch, now: clock.now() }).id
      : undefined;
  const withApproval = deleteApprovalId ? { deleteApprovalId } : {};
  for (const rule of [...enabled, null]) {
    log.runRecovered(rule?.id ?? null);
  }

  // One message that cannot be carried over (say, Gmail rejects it) must not hold up all the others
  const applied: PlannedMailAction[] = [];
  let failure: string | null = null;
  for (const entry of guarded.entries) {
    try {
      await entry.apply?.();
      applied.push(entry.report);
      log.applied(entry.ruleId ?? null, entry.report);
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        throw error;
      }
      failure ??= error instanceof Error ? error.message : 'Sync failed';
      log.failed(entry.ruleId ?? null, entry.report, error);
    }
  }
  if (failure !== null) {
    // The folder cursors stay put so the next run tries the failed ones again
    return { status: 'error', error: failure, ...withApproval, actions: applied };
  }

  for (const read of reads) {
    setMailFolderState(db, profile.id, read.rule.appleFolderPath, { uidValidity: read.listing.uidValidity, lastUid: 0 });
  }
  if (trash) {
    setMailFolderState(db, profile.id, trash.path, {
      uidValidity: trash.listing.uidValidity,
      lastUid: Math.max(0, ...trash.listing.messages.map((message) => message.uid)),
    });
  }
  return { status: 'ok', ...withApproval, actions: applied };
}

/** Plans (and, unless `dryRun`, applies) the profile-wide mail sync; null when there are no mail rules. */
export async function runMailSync(options: MailSyncOptions): Promise<MailRunResult | null> {
  try {
    return await run(options);
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      throw error;
    }
    if (!options.dryRun) {
      new SyncLog(options.db, options.clock, options.profile.id, 'email').runFailed(null, 'Mail sync', error);
    }
    return { status: 'error', error: error instanceof Error ? error.message : 'Sync failed', actions: [] };
  }
}

/** Deleting a rule keeps the synced Gmail messages: the sync only forgets that the folder is managed. */
export function forgetRuleFolder(db: AppDatabase, profileId: string, rule: MailRuleRow): void {
  for (const row of listSyncedEmails(db, profileId)) {
    const locations = parseLocations(row);
    if (locations.some((location) => location.folder === rule.appleFolderPath)) {
      updateSyncedEmail(db, row.id, {
        locations: JSON.stringify(locations.filter((location) => location.folder !== rule.appleFolderPath)),
      });
    }
  }
  deleteMailFolderState(db, profileId, rule.appleFolderPath);
}

/**
 * Cleanup opt-in: removes the rule's label from the synced messages and trashes or deletes (as the
 * rule says) the ones no other rule keeps. Safe to retry after a failure.
 */
export async function removeRuleFromGoogle(env: {
  readonly db: AppDatabase;
  readonly providers: SyncProviders;
  readonly profileId: string;
  readonly rule: MailRuleRow;
  readonly remaining: MailRuleRow[];
}): Promise<void> {
  const { db, providers, profileId, rule, remaining } = env;
  const labels = createLabelResolver(providers);
  const remainingByFolder = new Map(remaining.map((other) => [other.appleFolderPath, other]));
  for (const row of listSyncedEmails(db, profileId)) {
    const locations = parseLocations(row);
    if (!locations.some((location) => location.folder === rule.appleFolderPath)) {
      continue;
    }
    const kept = locations.filter((location) => location.folder !== rule.appleFolderPath);
    const keptRules = kept.flatMap((location) => {
      const other = remainingByFolder.get(location.folder);
      return other ? [other] : [];
    });
    if (keptRules.length === 0) {
      await executeMailDeletion({ db, providers }, mailDeletion(row, rule.deleteBehavior));
      continue;
    }
    if (!keptRules.some((other) => other.googleLabel === rule.googleLabel)) {
      const labelId = await labels.find(rule.googleLabel);
      if (labelId) {
        await ignoreGmailNotFound(() => providers.google.mail.modify(row.googleMessageId, { addLabelIds: [], removeLabelIds: [labelId] }));
      }
    }
    updateSyncedEmail(db, row.id, { locations: JSON.stringify(kept) });
  }
}
