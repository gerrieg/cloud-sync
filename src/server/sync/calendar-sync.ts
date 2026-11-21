import type { PlannedAction, RuleRunResult, SyncRunResult } from '../../shared/calendar.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import type { ProfileRow } from '../profiles/profile-store.js';
import { updateProfile } from '../profiles/profile-store.js';
import {
  AppleObjectNotFoundError,
  ApplePreconditionFailedError,
  GoogleEventNotFoundError,
  GoogleSyncTokenExpiredError,
  type AppleCalendarInfo,
  type AppleCalendarObject,
  type AppleObjectRef,
  type GoogleEvent,
  type GoogleEventChanges,
  type GoogleEventDraft,
  type GoogleWriteOptions,
} from '../providers/calendar-types.js';
import { GoogleAuthError, type SyncProviders } from '../providers/types.js';
import { exceedsDeleteGuard, queueDeletions, type GuardedDeletion } from './delete-guard.js';
import { googleFingerprint, googleStartKey } from './google-events.js';
import { googleEventToIcs, patchIcsWithGoogle } from './google-ics.js';
import { translateIcs, type TranslatedCalendarObject } from './ics.js';
import { listRules, updateRule, type RuleRow } from './rules-store.js';
import {
  deleteSyncedEvent,
  insertSyncedEvent,
  listSyncedEvents,
  updateSyncedEvent,
  type SyncedEventRow,
} from './sync-store.js';

const DAY_MS = 86_400_000;
/** Google must never email invitation updates for events we mirror. */
const NO_NOTIFICATIONS: GoogleWriteOptions = { sendUpdates: 'none' };

export interface CalendarSyncOptions {
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly profile: ProfileRow;
  /** The Profile's Apple ID, used to recognise foreign invitations. */
  readonly appleId: string;
  readonly providers: SyncProviders;
  /** Plan only: read from both sides, write nothing anywhere. */
  readonly dryRun: boolean;
  /** Force-Resync: ignore ctag/ETag shortcuts and push every Apple event again. */
  readonly force: boolean;
}

/** One planned deletion: everything needed to carry it out later, e.g. after an admin approval. */
export interface CalendarDeletion extends GuardedDeletion {
  /** Which side the item is deleted from. */
  readonly target: 'apple' | 'google';
  readonly syncedEventId: string;
  readonly uid: string;
  readonly summary: string;
  readonly googleEventId: string;
  readonly appleHref: string;
  readonly appleEtag: string;
}

/** One planned change: what it is, and (unless it is a no-op) how to carry it out. */
interface PlanEntry {
  readonly report: PlannedAction;
  readonly apply?: () => Promise<void>;
  /** Set on deletions, which the Delete Guard may hold back for approval. */
  readonly deletion?: CalendarDeletion;
}

interface RuleContext {
  readonly options: CalendarSyncOptions;
  readonly rule: RuleRow;
  readonly apple: AppleCalendarInfo;
}

interface Plan {
  readonly entries: PlanEntry[];
  /** Google delta cursor to persist after a fully successful run (bidirectional rules only). */
  readonly googleSyncToken: string | null;
}

/** Read-only and subscribed Apple calendars can never receive Google changes. */
function isBidirectional(rule: RuleRow): boolean {
  return rule.direction === 'bidirectional' && !rule.appleReadOnly;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function exceptionKey(draft: GoogleEventDraft): string {
  return draft.originalStartTime?.dateTime ?? draft.originalStartTime?.date ?? '';
}

function parseExceptionIds(row: SyncedEventRow): Record<string, string> {
  return JSON.parse(row.googleExceptionIds) as Record<string, string>;
}

/** Finds a pre-existing Google event for an Apple event: by iCal UID, else by title + start. */
function findExistingMatch(
  candidates: readonly GoogleEvent[],
  translated: TranslatedCalendarObject,
): GoogleEvent | undefined {
  return (
    candidates.find((event) => event.iCalUID === translated.uid) ??
    candidates.find(
      (event) =>
        normalizeTitle(event.summary) === normalizeTitle(translated.master.summary) &&
        googleStartKey(event.start) === translated.matchStart,
    )
  );
}

async function ignoreNotFound(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof GoogleEventNotFoundError)) {
      throw error;
    }
  }
}

class RulePlanner {
  constructor(private readonly context: RuleContext) {}

  private get google() {
    return this.context.options.providers.google.calendars;
  }

  private get calendarId() {
    return this.context.rule.googleCalendarId;
  }

  async plan(): Promise<Plan> {
    const { options, rule, apple } = this.context;
    const google = isBidirectional(rule) ? await this.readGoogleChanges() : null;
    const googleChanges = google?.changes ?? null;
    const changedByGoogleId = new Map(
      (googleChanges?.events ?? []).filter((event) => !event.recurringEventId).map((event) => [event.id, event]),
    );
    const objects = await options.providers.apple.calendars.listObjects(apple.url);
    const rows = listSyncedEvents(options.db, rule.id);
    const tracked = new Map(rows.map((row) => [row.appleHref, row]));
    const trackedGoogleIds = new Set(rows.map((row) => row.googleEventId));
    // A full listing lists everything that exists, so what is missing from it was deleted
    const isFullListing = google?.fullListing ?? false;
    const absenceMeansDeleted = google?.absenceMeansDeleted ?? false;
    const presentInGoogle = new Set((googleChanges?.events ?? []).map((event) => event.id));
    const deletedInGoogle = new Set(googleChanges?.deletedIds ?? []);
    // The Google event of a tracked row, if it was edited there (not merely echoing our own write)
    const editedInGoogle = (row: SyncedEventRow): GoogleEvent | undefined => {
      const edit = changedByGoogleId.get(row.googleEventId);
      return edit && row.googleFingerprint !== '' && googleFingerprint(edit) !== row.googleFingerprint
        ? edit
        : undefined;
    };
    const goneFromGoogle = (row: SyncedEventRow) =>
      googleChanges !== null &&
      (isFullListing
        ? absenceMeansDeleted && !presentInGoogle.has(row.googleEventId)
        : deletedInGoogle.has(row.googleEventId));

    // Pre-existing (Initial Sync) or newly created Google events: adopt matches instead of duplicating
    let unclaimed: GoogleEvent[];
    if (googleChanges) {
      unclaimed = googleChanges.events.filter(
        (event) => !event.recurringEventId && !trackedGoogleIds.has(event.id),
      );
    } else if (rule.initialSyncCompletedAt === null) {
      unclaimed = (await this.google.listEvents(this.calendarId)).filter((event) => !event.recurringEventId);
    } else {
      unclaimed = [];
    }

    const windowStart =
      rule.syncWindowDays === null ? null : options.clock.now() - rule.syncWindowDays * DAY_MS;
    const entries: PlanEntry[] = [];
    const seen = new Set<string>();

    for (const object of objects) {
      seen.add(object.href);
      const known = tracked.get(object.href);
      if (known && known.appleEtag === object.etag && !options.force) {
        const edit = editedInGoogle(known);
        if (known.foreignInvitation && (goneFromGoogle(known) || edit)) {
          // Invitations belong to their organizer's calendar: Google never changes them in Apple
          entries.push({
            report: {
              action: 'skip',
              ruleId: rule.id,
              uid: known.appleUid,
              summary: known.summary,
              reason: 'foreign_invitation',
              foreignInvitation: true,
            },
          });
        } else if (goneFromGoogle(known)) {
          entries.push(this.removeFromApple(known, object));
        } else if (edit) {
          entries.push(this.writeBack(known, object, edit));
        } else {
          entries.push(this.skip(known.appleUid, known.summary, 'unchanged'));
        }
        continue;
      }

      let translated: TranslatedCalendarObject;
      try {
        translated = translateIcs(object.ics, {
          syncReminders: rule.syncReminders,
          appleId: options.appleId,
        });
      } catch {
        entries.push(this.skip(object.href, object.href, 'invalid_calendar_data'));
        continue;
      }

      if (windowStart !== null && translated.lastEndMs !== null && translated.lastEndMs < windowStart) {
        // Its Google twin must not be mistaken for a Google-only event and imported again
        const twin = findExistingMatch(unclaimed, translated);
        if (twin) {
          unclaimed.splice(unclaimed.indexOf(twin), 1);
        }
        entries.push(this.skip(translated.uid, translated.master.summary, 'outside_window'));
        continue;
      }

      if (known) {
        const contested = goneFromGoogle(known) || editedInGoogle(known) !== undefined;
        entries.push(this.update(known, object.etag, translated, contested));
        continue;
      }

      const match = findExistingMatch(unclaimed, translated);
      if (match) {
        unclaimed.splice(unclaimed.indexOf(match), 1);
        entries.push(this.adopt(object, translated, match));
      } else {
        entries.push(this.create(object, translated));
      }
    }

    for (const row of tracked.values()) {
      if (!seen.has(row.appleHref)) {
        entries.push(this.remove(row));
      }
    }

    // Only bidirectional rules import what is left over; One-Way Sync leaves Google data untouched
    if (googleChanges) {
      for (const event of unclaimed) {
        entries.push(this.importFromGoogle(event, windowStart));
      }
    }
    return { entries, googleSyncToken: googleChanges?.nextSyncToken ?? null };
  }

  /** An event that only exists in Google: create its Apple counterpart and track the pair. */
  private importFromGoogle(event: GoogleEvent, windowStart: number | null): PlanEntry {
    const { options, rule, apple } = this.context;
    const uid = event.iCalUID || `google-${event.id}@cloud-sync`;
    const endMs = Date.parse(googleStartKey(event.end) ?? '');
    if (windowStart !== null && !event.recurrence && !Number.isNaN(endMs) && endMs < windowStart) {
      return this.skip(uid, event.summary, 'outside_window');
    }
    let ics: string;
    try {
      ics = googleEventToIcs(event, uid, options.clock.now());
    } catch {
      return this.skip(uid, event.summary, 'invalid_calendar_data');
    }
    return {
      report: { action: 'create', ruleId: rule.id, uid, summary: event.summary, direction: 'google_to_apple' },
      apply: async () => {
        const written = await options.providers.apple.calendars.putObject(apple.url, {
          href: null,
          uid,
          ics,
          etag: null,
        });
        insertSyncedEvent(options.db, {
          ruleId: rule.id,
          appleHref: written.href,
          appleUid: uid,
          appleEtag: written.etag,
          summary: event.summary,
          googleEventId: event.id,
          googleExceptionIds: '{}',
          foreignInvitation: false,
          googleFingerprint: googleFingerprint(event),
        });
      },
    };
  }

  /** Deleted in Google and untouched in Apple: delete it in Apple as well. */
  private removeFromApple(row: SyncedEventRow, object: AppleCalendarObject): PlanEntry {
    return this.deletion('apple', row, object.etag);
  }

  private deletion(target: 'apple' | 'google', row: SyncedEventRow, appleEtag: string): PlanEntry {
    const { options, rule } = this.context;
    const item: CalendarDeletion = {
      target,
      syncedEventId: row.id,
      uid: row.appleUid,
      summary: row.summary,
      googleEventId: row.googleEventId,
      appleHref: row.appleHref,
      appleEtag,
    };
    return {
      report: {
        action: 'delete',
        ruleId: rule.id,
        uid: row.appleUid,
        summary: row.summary,
        ...(target === 'apple' ? { direction: 'google_to_apple' as const } : {}),
      },
      apply: () => executeCalendarDeletion({ db: options.db, providers: options.providers, rule }, item),
      deletion: item,
    };
  }

  /**
   * Reads what changed in Google since the last run. A stale token (HTTP 410 Gone) is cleared and
   * replaced by a full listing, which the caller reconciles against the tracked events.
   */
  private async readGoogleChanges(): Promise<{
    changes: GoogleEventChanges;
    fullListing: boolean;
    /** Whether an event missing from a full listing counts as deleted in Google. */
    absenceMeansDeleted: boolean;
  }> {
    const { options, rule } = this.context;
    if (rule.googleSyncToken !== null) {
      try {
        return {
          changes: await this.google.listChanges(this.calendarId, rule.googleSyncToken),
          fullListing: false,
          absenceMeansDeleted: false,
        };
      } catch (error) {
        if (!(error instanceof GoogleSyncTokenExpiredError)) {
          throw error;
        }
        if (!options.dryRun) {
          updateRule(options.db, rule.id, { googleSyncToken: null });
        }
      }
    }
    // Without a token ever issued (first bidirectional run, e.g. after switching from One-Way), a
    // missing event may be a manual deletion from the One-Way era, which One-Way Sync ignores.
    // Only after a stale token do we know that the listing replaces a delta we could have missed.
    return {
      changes: await this.google.listChanges(this.calendarId, null),
      fullListing: true,
      absenceMeansDeleted: rule.googleSyncToken !== null,
    };
  }

  /** An uncontested Google edit: carry it over into the Apple resource it belongs to. */
  private writeBack(row: SyncedEventRow, object: AppleCalendarObject, edit: GoogleEvent): PlanEntry {
    const { options, apple } = this.context;
    let ics: string;
    try {
      ics = patchIcsWithGoogle(object.ics, edit, options.clock.now());
    } catch {
      return this.skip(row.appleUid, row.summary, 'invalid_calendar_data');
    }
    return {
      report: {
        action: 'update',
        ruleId: this.context.rule.id,
        uid: row.appleUid,
        summary: edit.summary,
        direction: 'google_to_apple',
      },
      apply: async () => {
        let written: AppleObjectRef;
        try {
          written = await options.providers.apple.calendars.putObject(apple.url, {
            href: object.href,
            uid: row.appleUid,
            ics,
            etag: object.etag,
          });
        } catch (error) {
          if (error instanceof ApplePreconditionFailedError) {
            return; // Apple changed meanwhile: Apple Master, its change is pushed to Google next run
          }
          throw error;
        }
        updateSyncedEvent(options.db, row.id, {
          appleEtag: written.etag,
          summary: edit.summary,
          googleFingerprint: googleFingerprint(edit),
        });
      },
    };
  }

  private skip(uid: string, summary: string, reason: string): PlanEntry {
    return { report: { action: 'skip', ruleId: this.context.rule.id, uid, summary, reason } };
  }

  private report(
    action: 'create' | 'update',
    translated: TranslatedCalendarObject,
  ): PlannedAction {
    return {
      action,
      ruleId: this.context.rule.id,
      uid: translated.uid,
      summary: translated.master.summary,
      foreignInvitation: translated.foreignInvitation,
    };
  }

  /**
   * Writes the series (master first, then its overridden occurrences) to Google. `progress` is
   * called after every write so the caller can persist what exists in Google even if a later write
   * fails; otherwise a half-written series would be duplicated by the next run.
   */
  private async writeSeries(
    translated: TranslatedCalendarObject,
    progress: (masterId: string, exceptionIds: Record<string, string>) => void,
  ) {
    const master = await this.google.insertEvent(this.calendarId, translated.master, NO_NOTIFICATIONS);
    const exceptionIds: Record<string, string> = {};
    progress(master.id, { ...exceptionIds });
    for (const exception of translated.exceptions) {
      const created = await this.google.insertEvent(
        this.calendarId,
        { ...exception, recurringEventId: master.id },
        NO_NOTIFICATIONS,
      );
      exceptionIds[exceptionKey(exception)] = created.id;
      progress(master.id, { ...exceptionIds });
    }
    return { masterId: master.id, exceptionIds, fingerprint: googleFingerprint(master) };
  }

  private create(object: AppleObjectRef, translated: TranslatedCalendarObject): PlanEntry {
    return {
      report: this.report('create', translated),
      apply: async () => {
        const db = this.context.options.db;
        let rowId: string | null = null;
        const { exceptionIds, fingerprint } = await this.writeSeries(translated, (masterId, ids) => {
          // The ETag stays empty until the series is complete, so an interrupted run is redone
          if (rowId === null) {
            rowId = this.record(object.href, '', translated, masterId, ids, '');
          } else {
            updateSyncedEvent(db, rowId, { googleExceptionIds: JSON.stringify(ids) });
          }
        });
        updateSyncedEvent(db, rowId!, {
          appleEtag: object.etag,
          googleExceptionIds: JSON.stringify(exceptionIds),
          googleFingerprint: fingerprint,
        });
      },
    };
  }

  /** Initial Sync found the event already in Google: link it, never create a duplicate. */
  private adopt(
    object: AppleObjectRef,
    translated: TranslatedCalendarObject,
    match: GoogleEvent,
  ): PlanEntry {
    return {
      report: {
        action: 'skip',
        ruleId: this.context.rule.id,
        uid: translated.uid,
        summary: translated.master.summary,
        reason: 'matched_existing',
        foreignInvitation: translated.foreignInvitation,
      },
      apply: async () => {
        this.record(object.href, object.etag, translated, match.id, {}, googleFingerprint(match));
      },
    };
  }

  /** `contested`: Google changed the same event since the last run; Apple Master settles it. */
  private update(
    row: SyncedEventRow,
    etag: string,
    translated: TranslatedCalendarObject,
    contested: boolean,
  ): PlanEntry {
    return {
      report: { ...this.report('update', translated), ...(contested ? { reason: 'apple_master' } : {}) },
      apply: async () => {
        const known = parseExceptionIds(row);
        const current = new Set(translated.exceptions.map(exceptionKey));
        const droppedOverride = Object.keys(known).some((key) => !current.has(key));

        const updatedInPlace =
          !droppedOverride && (await this.updateInPlace(row, etag, translated, known));
        if (!updatedInPlace) {
          // Google cannot revert an overridden occurrence, and a manually deleted event is gone:
          // start the series afresh.
          await ignoreNotFound(() =>
            this.google.deleteEvent(this.calendarId, row.googleEventId, NO_NOTIFICATIONS),
          );
          const { masterId, exceptionIds, fingerprint } = await this.writeSeries(translated, (id, ids) =>
            this.save(row, '', translated, id, ids, ''),
          );
          this.save(row, etag, translated, masterId, exceptionIds, fingerprint);
        }
      },
    };
  }

  /** Returns false when the Google event no longer exists. */
  private async updateInPlace(
    row: SyncedEventRow,
    etag: string,
    translated: TranslatedCalendarObject,
    known: Record<string, string>,
  ): Promise<boolean> {
    let fingerprint: string;
    try {
      const master = await this.google.updateEvent(
        this.calendarId,
        row.googleEventId,
        translated.master,
        NO_NOTIFICATIONS,
      );
      fingerprint = googleFingerprint(master);
    } catch (error) {
      if (error instanceof GoogleEventNotFoundError) {
        return false;
      }
      throw error;
    }

    const exceptionIds: Record<string, string> = {};
    for (const exception of translated.exceptions) {
      const key = exceptionKey(exception);
      const draft = { ...exception, recurringEventId: row.googleEventId };
      exceptionIds[key] = known[key]
        ? (await this.google.updateEvent(this.calendarId, known[key], draft, NO_NOTIFICATIONS)).id
        : (await this.google.insertEvent(this.calendarId, draft, NO_NOTIFICATIONS)).id;
      // Keep newly created overrides tracked even if a later write fails (the ETag stays old)
      updateSyncedEvent(this.context.options.db, row.id, {
        googleExceptionIds: JSON.stringify({ ...known, ...exceptionIds }),
      });
    }
    this.save(row, etag, translated, row.googleEventId, exceptionIds, fingerprint);
    return true;
  }

  private remove(row: SyncedEventRow): PlanEntry {
    return this.deletion('google', row, row.appleEtag);
  }

  private record(
    href: string,
    etag: string,
    translated: TranslatedCalendarObject,
    googleEventId: string,
    exceptionIds: Record<string, string>,
    fingerprint: string,
  ): string {
    return insertSyncedEvent(this.context.options.db, {
      ruleId: this.context.rule.id,
      appleHref: href,
      appleUid: translated.uid,
      appleEtag: etag,
      summary: translated.master.summary,
      googleEventId,
      googleExceptionIds: JSON.stringify(exceptionIds),
      foreignInvitation: translated.foreignInvitation,
      googleFingerprint: fingerprint,
    });
  }

  private save(
    row: SyncedEventRow,
    etag: string,
    translated: TranslatedCalendarObject,
    googleEventId: string,
    exceptionIds: Record<string, string>,
    fingerprint: string,
  ): void {
    updateSyncedEvent(this.context.options.db, row.id, {
      appleUid: translated.uid,
      appleEtag: etag,
      summary: translated.master.summary,
      googleEventId,
      googleExceptionIds: JSON.stringify(exceptionIds),
      foreignInvitation: translated.foreignInvitation,
      googleFingerprint: fingerprint,
    });
  }
}

/** Carries out one planned deletion and drops its tracking record. */
export async function executeCalendarDeletion(
  env: { readonly db: AppDatabase; readonly providers: SyncProviders; readonly rule: RuleRow },
  item: CalendarDeletion,
): Promise<void> {
  const { db, providers, rule } = env;
  if (item.target === 'google') {
    await ignoreNotFound(() =>
      providers.google.calendars.deleteEvent(rule.googleCalendarId, item.googleEventId, NO_NOTIFICATIONS),
    );
  } else {
    try {
      await providers.apple.calendars.deleteObject(item.appleHref, item.appleEtag);
    } catch (error) {
      if (error instanceof ApplePreconditionFailedError) {
        return; // Apple changed in the meantime: Apple Master, keep it and let its change win
      }
      if (!(error instanceof AppleObjectNotFoundError)) {
        throw error;
      }
    }
  }
  deleteSyncedEvent(db, item.syncedEventId);
}

/**
 * Delete Guard: when the planned deletions exceed the threshold, they are taken out of the plan
 * (reported as skipped) and returned as one batch to be queued for the admin's approval.
 */
function holdBackDeletions(
  entries: PlanEntry[],
  trackedItems: number,
): { entries: PlanEntry[]; batch: CalendarDeletion[] } {
  const batch = entries.flatMap((entry) => (entry.deletion ? [entry.deletion] : []));
  if (!exceedsDeleteGuard(batch.length, trackedItems)) {
    return { entries, batch: [] };
  }
  const held = entries.map((entry): PlanEntry =>
    entry.deletion
      ? {
          report: {
            action: 'skip',
            ruleId: entry.report.ruleId,
            uid: entry.deletion.uid,
            summary: entry.deletion.summary,
            reason: 'delete_guard',
          },
        }
      : entry,
  );
  return { entries: held, batch };
}

async function runRule(context: RuleContext): Promise<RuleRunResult> {
  const { options, rule, apple } = context;
  const plan = await new RulePlanner(context).plan();
  const { googleSyncToken } = plan;
  const guarded = holdBackDeletions(plan.entries, listSyncedEvents(options.db, rule.id).length);
  const entries = guarded.entries;

  if (options.dryRun) {
    return { ruleId: rule.id, status: 'ok', actions: entries.map((entry) => entry.report) };
  }
  const deleteApprovalId =
    guarded.batch.length > 0
      ? queueDeletions(options.db, {
          profileId: options.profile.id,
          ruleId: rule.id,
          items: guarded.batch,
          now: options.clock.now(),
        }).id
      : undefined;

  const applied: PlannedAction[] = [];
  try {
    for (const entry of entries) {
      await entry.apply?.();
      applied.push(entry.report);
    }
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      throw error;
    }
    // Keep what was done so far visible; the cursor stays put so the next run finishes the job
    return {
      ruleId: rule.id,
      status: 'error',
      error: error instanceof Error ? error.message : 'Sync failed',
      ...(deleteApprovalId ? { deleteApprovalId } : {}),
      actions: applied,
    };
  }

  // Only a fully successful run advances the cursor
  updateRule(options.db, rule.id, {
    appleCtag: apple.ctag,
    googleSyncToken,
    initialSyncCompletedAt: rule.initialSyncCompletedAt ?? options.clock.now(),
  });
  return { ruleId: rule.id, status: 'ok', ...(deleteApprovalId ? { deleteApprovalId } : {}), actions: applied };
}

/** Plans (and, unless `dryRun`, applies) one-way Apple → Google sync for all rules of a Profile. */
export async function runCalendarSync(options: CalendarSyncOptions): Promise<SyncRunResult> {
  const { db, clock, profile, providers } = options;
  const appleCalendars = await providers.apple.calendars.list();
  const results: RuleRunResult[] = [];

  for (const rule of listRules(db, profile.id)) {
    if (!rule.enabled) {
      results.push({ ruleId: rule.id, status: 'skipped', reason: 'paused', actions: [] });
      continue;
    }
    const apple = appleCalendars.find((calendar) => calendar.url === rule.appleCalendarUrl);
    if (!apple) {
      results.push({
        ruleId: rule.id,
        status: 'error',
        error: 'The Apple calendar no longer exists',
        actions: [],
      });
      continue;
    }
    const unchanged =
      !isBidirectional(rule) &&
      !options.force &&
      rule.initialSyncCompletedAt !== null &&
      apple.ctag !== null &&
      apple.ctag === rule.appleCtag;
    if (unchanged) {
      results.push({ ruleId: rule.id, status: 'skipped', reason: 'unchanged', actions: [] });
      continue;
    }

    try {
      results.push(await runRule({ options, rule, apple }));
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        throw error;
      }
      results.push({
        ruleId: rule.id,
        status: 'error',
        error: error instanceof Error ? error.message : 'Sync failed',
        actions: [],
      });
    }
  }

  if (!options.dryRun) {
    updateProfile(db, profile.id, {
      lastSyncAt: clock.now(),
      lastSyncStatus: results.every((result) => result.status !== 'error') ? 'ok' : 'error',
    });
  }
  return { dryRun: options.dryRun, rules: results };
}

/**
 * Deletes the Google events a rule created or adopted (series and their overrides go with their
 * master). Events that only exist in Google are never touched.
 */
export async function removeTrackedGoogleEvents(options: {
  readonly db: AppDatabase;
  readonly providers: SyncProviders;
  readonly rule: RuleRow;
}): Promise<void> {
  const { db, providers, rule } = options;
  for (const row of listSyncedEvents(db, rule.id)) {
    await ignoreNotFound(() =>
      providers.google.calendars.deleteEvent(rule.googleCalendarId, row.googleEventId, NO_NOTIFICATIONS),
    );
  }
}
