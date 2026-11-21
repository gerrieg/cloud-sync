import type { PlannedAction, RuleRunResult, SyncRunResult } from '../../shared/calendar.js';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import type { ProfileRow } from '../profiles/profile-store.js';
import { updateProfile } from '../profiles/profile-store.js';
import {
  GoogleEventNotFoundError,
  type AppleCalendarInfo,
  type AppleCalendarObject,
  type GoogleDateTime,
  type GoogleEvent,
  type GoogleEventDraft,
  type GoogleWriteOptions,
} from '../providers/calendar-types.js';
import { GoogleAuthError, type SyncProviders } from '../providers/types.js';
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

/** One planned change: what it is, and (unless it is a no-op) how to carry it out. */
interface PlanEntry {
  readonly report: PlannedAction;
  readonly apply?: () => Promise<void>;
}

interface RuleContext {
  readonly options: CalendarSyncOptions;
  readonly rule: RuleRow;
  readonly apple: AppleCalendarInfo;
}

/** The identity of one Apple CalDAV resource at a point in time. */
type AppleObjectRef = Pick<AppleCalendarObject, 'href' | 'etag'>;

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Same normalization as the ICS side: UTC instant for timed events, `YYYY-MM-DD` for all-day. */
function googleStartKey(value: GoogleDateTime): string | null {
  if (value.date) {
    return value.date;
  }
  const instant = value.dateTime ? new Date(value.dateTime) : null;
  return instant && !Number.isNaN(instant.getTime()) ? instant.toISOString() : null;
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

  async plan(): Promise<PlanEntry[]> {
    const { options, rule, apple } = this.context;
    const objects = await options.providers.apple.calendars.listObjects(apple.url);
    const tracked = new Map(listSyncedEvents(options.db, rule.id).map((row) => [row.appleHref, row]));

    // Initial Sync: adopt pre-existing Google events instead of duplicating them
    const unclaimed =
      rule.initialSyncCompletedAt === null
        ? (await this.google.listEvents(this.calendarId)).filter((event) => !event.recurringEventId)
        : [];

    const windowStart =
      rule.syncWindowDays === null ? null : options.clock.now() - rule.syncWindowDays * DAY_MS;
    const entries: PlanEntry[] = [];
    const seen = new Set<string>();

    for (const object of objects) {
      seen.add(object.href);
      const known = tracked.get(object.href);
      if (known && known.appleEtag === object.etag && !options.force) {
        entries.push(this.skip(known.appleUid, known.summary, 'unchanged'));
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
        entries.push(this.skip(translated.uid, translated.master.summary, 'outside_window'));
        continue;
      }

      if (known) {
        entries.push(this.update(known, object.etag, translated));
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
    return entries;
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
    return { masterId: master.id, exceptionIds };
  }

  private create(object: AppleObjectRef, translated: TranslatedCalendarObject): PlanEntry {
    return {
      report: this.report('create', translated),
      apply: async () => {
        const db = this.context.options.db;
        let rowId: string | null = null;
        const { exceptionIds } = await this.writeSeries(translated, (masterId, ids) => {
          // The ETag stays empty until the series is complete, so an interrupted run is redone
          if (rowId === null) {
            rowId = this.record(object.href, '', translated, masterId, ids);
          } else {
            updateSyncedEvent(db, rowId, { googleExceptionIds: JSON.stringify(ids) });
          }
        });
        updateSyncedEvent(db, rowId!, {
          appleEtag: object.etag,
          googleExceptionIds: JSON.stringify(exceptionIds),
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
        this.record(object.href, object.etag, translated, match.id, {});
      },
    };
  }

  private update(
    row: SyncedEventRow,
    etag: string,
    translated: TranslatedCalendarObject,
  ): PlanEntry {
    return {
      report: this.report('update', translated),
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
          const { masterId, exceptionIds } = await this.writeSeries(translated, (id, ids) =>
            this.save(row, '', translated, id, ids),
          );
          this.save(row, etag, translated, masterId, exceptionIds);
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
    try {
      await this.google.updateEvent(this.calendarId, row.googleEventId, translated.master, NO_NOTIFICATIONS);
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
    this.save(row, etag, translated, row.googleEventId, exceptionIds);
    return true;
  }

  private remove(row: SyncedEventRow): PlanEntry {
    return {
      report: {
        action: 'delete',
        ruleId: this.context.rule.id,
        uid: row.appleUid,
        summary: row.summary,
      },
      apply: async () => {
        await ignoreNotFound(() =>
          this.google.deleteEvent(this.calendarId, row.googleEventId, NO_NOTIFICATIONS),
        );
        deleteSyncedEvent(this.context.options.db, row.id);
      },
    };
  }

  private record(
    href: string,
    etag: string,
    translated: TranslatedCalendarObject,
    googleEventId: string,
    exceptionIds: Record<string, string>,
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
    });
  }

  private save(
    row: SyncedEventRow,
    etag: string,
    translated: TranslatedCalendarObject,
    googleEventId: string,
    exceptionIds: Record<string, string>,
  ): void {
    updateSyncedEvent(this.context.options.db, row.id, {
      appleUid: translated.uid,
      appleEtag: etag,
      summary: translated.master.summary,
      googleEventId,
      googleExceptionIds: JSON.stringify(exceptionIds),
      foreignInvitation: translated.foreignInvitation,
    });
  }
}

async function runRule(context: RuleContext): Promise<RuleRunResult> {
  const { options, rule, apple } = context;
  const entries = await new RulePlanner(context).plan();

  if (options.dryRun) {
    return { ruleId: rule.id, status: 'ok', actions: entries.map((entry) => entry.report) };
  }

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
      actions: applied,
    };
  }

  // Only a fully successful run advances the cursor
  updateRule(options.db, rule.id, {
    appleCtag: apple.ctag,
    initialSyncCompletedAt: rule.initialSyncCompletedAt ?? options.clock.now(),
  });
  return { ruleId: rule.id, status: 'ok', actions: applied };
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
