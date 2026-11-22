import crypto from 'node:crypto';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import type { ProfileStatusDto } from '../../shared/profile.js';
import { encryptSecret } from '../crypto/secrets.js';
import {
  findProfile,
  isActive,
  listProfiles,
  toProvidersContext,
  type ProfileRow,
} from '../profiles/profile-store.js';
import type { InboxIdleConnection } from '../providers/mail-types.js';
import {
  GoogleAuthError,
  type SyncProviders,
  type SyncProvidersFactory,
} from '../providers/types.js';
import { pruneSyncLogs } from '../sync/log-retention.js';
import { pruneSyncRuns } from '../sync/sync-run-store.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { pollingTargetsOf } from '../sync/polling-targets.js';
import { flagGoogleReauth, ProfileRunner } from '../sync/profile-runner.js';
import { runProfileSync, type SyncDomain } from '../sync/profile-sync.js';
import {
  deleteWatchChannel,
  insertWatchChannel,
  listWatchChannels,
  type WatchChannelRow,
} from './watch-channels-store.js';

/** How often the app looks at all mail folders that are not covered by the IDLE connection. */
const MAIL_POLL_INTERVAL_MS = 45_000;
const IDLE_BACKOFF_BASE_MS = 1_000;
const IDLE_BACKOFF_MAX_MS = 300_000;
/** A connection that stayed up this long counts as healthy: the next drop starts the backoff over. */
const IDLE_STABLE_AFTER_MS = 60_000;
const TICK_INTERVAL_MS = 1_000;
const LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
/** Apple's calendar tags are cheap to read, so changes show up quickly. */
const CTAG_POLL_INTERVAL_MS = 30_000;
/** `syncToken` polling of Google calendars that no healthy webhook channel covers. */
const GOOGLE_POLL_INTERVAL_MS = 60_000;
/** Safety net for missed notifications while a webhook channel is healthy. */
const GOOGLE_SAFETY_POLL_INTERVAL_MS = 15 * 60_000;
const CONTACTS_POLL_INTERVAL_MS = 120_000;
/** Channels are replaced once less than this is left of their lifetime. */
const WATCH_RENEW_BEFORE_MS = 24 * 60 * 60_000;
const WATCH_RETRY_INTERVAL_MS = 5 * 60_000;

interface IdleState {
  connection: InboxIdleConnection | null;
  /** Bumped whenever the connection is opened or torn down, so callbacks of an old one are ignored. */
  generation: number;
  failures: number;
  retryAt: number;
  connectedAt: number;
}

/** What the orchestrator remembers about one Profile between ticks. */
interface ProfileRuntime {
  readonly idle: IdleState;
  /** Last seen `STATUS` counters per mail folder path. */
  readonly mailSignatures: Map<string, string>;
  lastMailPollAt: number | null;
  /** Last seen collection tag per Apple calendar URL. */
  readonly calendarCtags: Map<string, string | null>;
  lastCtagPollAt: number | null;
  lastGooglePollAt: number | null;
  lastContactsPollAt: number | null;
  /** Earliest time a channel for a Google calendar may be registered again, after a success or a failure. */
  readonly watchRetryAt: Map<string, number>;
  /** Steps that are currently running, so a slow step is never started twice. */
  readonly running: Set<string>;
}

export interface RealtimeDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

/**
 * Keeps the background triggers of all active Profiles running (IMAP IDLE, polling, Google
 * webhooks) and funnels every trigger into one coalescing per-Profile sync queue.
 */
export class RealtimeOrchestrator {
  private readonly queued = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly runtimes = new Map<string, ProfileRuntime>();
  private timer: NodeJS.Timeout | null = null;
  private lastLogPruneAt: number | null = null;

  private readonly runner: ProfileRunner;

  constructor(private readonly deps: RealtimeDeps) {
    this.runner = new ProfileRunner(deps);
  }

  /** Starts ticking once per second. */
  start(): void {
    this.timer ??= setInterval(() => {
      this.tick().catch((error: unknown) => console.error('Real-time tick failed:', error));
    }, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  /** Stops ticking, closes every IDLE connection and waits for running syncs. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all([...this.runtimes.values()].map((runtime) => this.closeIdle(runtime)));
    this.runtimes.clear();
    await this.settled();
  }

  /**
   * One scheduling pass: reconciles every Profile with what it should currently be doing (open
   * or close its IDLE connection, poll what is due) and waits for that work to finish.
   */
  async tick(): Promise<void> {
    this.pruneLogsWhenDue();
    const profiles = listProfiles(this.deps.db);
    const known = new Set(profiles.map((profile) => profile.id));
    for (const [id, runtime] of this.runtimes) {
      if (!known.has(id)) {
        this.runtimes.delete(id);
        await this.closeIdle(runtime);
      }
    }
    await Promise.all(profiles.map((profile) => this.tickProfile(profile)));
  }

  /** The sync log and the run history are trimmed right at start-up and then once a day. */
  private pruneLogsWhenDue(): void {
    const now = this.deps.clock.now();
    if (this.lastLogPruneAt !== null && now - this.lastLogPruneAt < LOG_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastLogPruneAt = now;
    try {
      pruneSyncLogs(this.deps.db, this.deps.clock);
      pruneSyncRuns(this.deps.db, this.deps.clock);
    } catch (error) {
      console.error('Pruning the sync log failed:', error);
    }
  }

  statusOf(profile: ProfileRow): ProfileStatusDto {
    const targets = pollingTargetsOf(this.deps.db, profile);
    const wantsIdle = targets.appleMailFolders.length > 0;
    const connected = this.runtimes.get(profile.id)?.idle.connection != null;
    const watched = targets.watchedGoogleCalendarIds;
    const healthy = this.healthyChannelCalendars(profile);
    return {
      mailIdle: !profile.enabled ? 'paused' : !wantsIdle ? 'disconnected' : connected ? 'connected' : 'reconnecting',
      googleCalendar:
        watched.length === 0 ? 'inactive' : watched.every((id) => healthy.has(id)) ? 'webhook' : 'polling',
    };
  }

  /**
   * Queues a sync of one domain behind the Profile's lock. A request that arrives while an
   * identical one is still waiting for its turn joins it instead of queueing another run.
   */
  requestSync(profileId: string, domain: SyncDomain): Promise<void> {
    const key = `${profileId}:${domain}`;
    const waiting = this.queued.get(key);
    if (waiting) {
      return waiting;
    }
    const run = this.deps.locks.run(profileId, async () => {
      this.queued.delete(key);
      await this.syncNow(profileId, domain);
    });
    this.queued.set(key, run);
    return this.track(run);
  }

  /** Resolves once every queued or running background job has finished. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const forget = () => {
      this.inflight.delete(work);
    };
    work.then(forget, forget);
    return work;
  }

  private runtimeOf(profileId: string): ProfileRuntime {
    let runtime = this.runtimes.get(profileId);
    if (!runtime) {
      runtime = {
        idle: { connection: null, generation: 0, failures: 0, retryAt: 0, connectedAt: 0 },
        mailSignatures: new Map(),
        lastMailPollAt: null,
        calendarCtags: new Map(),
        lastCtagPollAt: null,
        lastGooglePollAt: null,
        lastContactsPollAt: null,
        watchRetryAt: new Map(),
        running: new Set(),
      };
      this.runtimes.set(profileId, runtime);
    }
    return runtime;
  }

  private providersFor(profile: ProfileRow): SyncProviders {
    const context = toProvidersContext(profile, this.deps.config.encryptionKey);
    return this.deps.createSyncProviders(context);
  }

  private async tickProfile(profile: ProfileRow): Promise<void> {
    const runtime = this.runtimeOf(profile.id);
    const active = isActive(profile);
    const targets = pollingTargetsOf(this.deps.db, profile);
    const watched = targets.watchedGoogleCalendarIds;
    await Promise.all([
      this.step(profile, runtime, 'idle', () => this.maintainIdle(profile, runtime, targets.appleMailFolders.length > 0)),
      this.step(profile, runtime, 'mail', () => this.pollMail(profile, runtime, targets.appleMailFolders)),
      this.step(profile, runtime, 'watch', () => this.maintainWatches(profile, runtime, active, watched)),
      this.step(profile, runtime, 'ctag', () => this.pollCalendarTags(profile, runtime, targets.appleCalendarUrls)),
      this.step(profile, runtime, 'google', () => this.pollGoogleCalendars(profile, runtime, watched)),
      this.step(profile, runtime, 'contacts', () => this.pollContacts(profile, runtime, targets.hasContactRules)),
    ]);
  }

  /** Runs one kind of work for a Profile unless the previous run of it is still going. */
  private async step(profile: ProfileRow, runtime: ProfileRuntime, name: string, work: () => Promise<void>): Promise<void> {
    if (runtime.running.has(name)) {
      return;
    }
    runtime.running.add(name);
    try {
      await work();
    } catch (error) {
      if (!flagGoogleReauth(this.deps.db, profile.id, error)) {
        console.error(`Real-time ${name} of Profile ${profile.id} failed:`, error);
      }
    } finally {
      runtime.running.delete(name);
    }
  }

  /** Keeps exactly one IDLE connection on INBOX while the Profile has enabled mail rules. */
  private async maintainIdle(profile: ProfileRow, runtime: ProfileRuntime, wanted: boolean): Promise<void> {
    const { idle } = runtime;
    if (!wanted) {
      await this.closeIdle(runtime);
      idle.failures = 0;
      idle.retryAt = 0;
      return;
    }
    if (idle.connection || this.deps.clock.now() < idle.retryAt) {
      return;
    }
    idle.generation += 1;
    const generation = idle.generation;
    let droppedWhileConnecting = false;
    try {
      const connection = await this.providersFor(profile).apple.mail.openInboxIdle({
        onChange: () => void this.requestSync(profile.id, 'mail'),
        onClose: () => {
          if (idle.generation !== generation) {
            return;
          }
          droppedWhileConnecting = idle.connection === null;
          idle.connection = null;
          this.scheduleIdleRetry(idle, true);
        },
      });
      if (idle.generation !== generation) {
        // The Profile was paused or deleted while connecting
        await connection.close().catch(() => undefined);
        return;
      }
      if (droppedWhileConnecting) {
        // Already dead and already scheduled for a retry: never store it as the live connection
        return;
      }
      idle.connection = connection;
      idle.connectedAt = this.deps.clock.now();
      // Whatever arrived while there was no connection
      void this.requestSync(profile.id, 'mail');
    } catch (error) {
      console.error(`Opening the IDLE connection of Profile ${profile.id} failed:`, error);
      this.scheduleIdleRetry(idle, false);
    }
  }

  private scheduleIdleRetry(idle: IdleState, wasConnected: boolean): void {
    const now = this.deps.clock.now();
    if (wasConnected && now - idle.connectedAt >= IDLE_STABLE_AFTER_MS) {
      idle.failures = 0;
    }
    idle.failures += 1;
    idle.retryAt = now + Math.min(IDLE_BACKOFF_MAX_MS, IDLE_BACKOFF_BASE_MS * 2 ** (idle.failures - 1));
  }

  private async closeIdle(runtime: ProfileRuntime): Promise<void> {
    const { idle } = runtime;
    idle.generation += 1;
    const connection = idle.connection;
    idle.connection = null;
    await connection?.close().catch(() => undefined);
  }

  /**
   * Looks at the folders IDLE does not cover with a cheap `STATUS` and syncs when any counter
   * moved. INBOX is polled too while its IDLE connection is down.
   */
  private async pollMail(profile: ProfileRow, runtime: ProfileRuntime, folderPaths: readonly string[]): Promise<void> {
    const now = this.deps.clock.now();
    if (runtime.lastMailPollAt !== null && now - runtime.lastMailPollAt < MAIL_POLL_INTERVAL_MS) {
      return;
    }
    const idleCoversInbox = runtime.idle.connection !== null;
    const paths = folderPaths.filter((path) => !(idleCoversInbox && path.toUpperCase() === 'INBOX'));
    if (paths.length === 0) {
      return;
    }
    runtime.lastMailPollAt = now;
    let changed = false;
    for (const status of await this.providersFor(profile).apple.mail.folderStatus(paths)) {
      const signature = `${status.uidValidity}:${status.uidNext}:${status.messages}:${status.unseen}`;
      if (runtime.mailSignatures.get(status.path) !== signature) {
        runtime.mailSignatures.set(status.path, signature);
        changed = true;
      }
    }
    if (changed) {
      await this.requestSync(profile.id, 'mail');
    }
  }

  /** Google calendars with a channel that is alive and that Google has proven to reach the webhook with. */
  private healthyChannelCalendars(profile: ProfileRow): Set<string> {
    const now = this.deps.clock.now();
    return new Set(
      listWatchChannels(this.deps.db, profile.id)
        .filter((channel) => channel.confirmedAt !== null && channel.expiresAt > now)
        .map((channel) => channel.googleCalendarId),
    );
  }

  /**
   * Keeps one `events.watch` channel per watched Google calendar (only with a public URL),
   * renews it before it lapses and stops channels nobody needs anymore.
   */
  private async maintainWatches(
    profile: ProfileRow,
    runtime: ProfileRuntime,
    active: boolean,
    watched: readonly string[],
  ): Promise<void> {
    const { db, clock, config } = this.deps;
    if (!active) {
      return;
    }
    const needed = config.publicBaseUrl ? watched : [];
    const rows = listWatchChannels(db, profile.id);
    const now = clock.now();
    const stale = rows.filter((row) => !needed.includes(row.googleCalendarId));
    const toRegister = needed.filter((calendarId) => {
      const newest = Math.max(0, ...rows.filter((row) => row.googleCalendarId === calendarId).map((row) => row.expiresAt));
      return newest - now <= WATCH_RENEW_BEFORE_MS && now >= (runtime.watchRetryAt.get(calendarId) ?? 0);
    });
    if (stale.length === 0 && toRegister.length === 0) {
      return;
    }

    const providers = this.providersFor(profile);
    for (const row of stale) {
      await this.stopChannel(providers, row);
    }
    for (const calendarId of toRegister) {
      const channelId = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('base64url');
      try {
        const { resourceId, expiresAt } = await providers.google.calendars.watch(calendarId, {
          channelId,
          address: `${config.publicBaseUrl}/webhooks/google/${profile.id}`,
          token,
        });
        insertWatchChannel(db, {
          id: channelId,
          profileId: profile.id,
          googleCalendarId: calendarId,
          resourceId,
          tokenEnc: encryptSecret(token, config.encryptionKey),
          expiresAt,
          confirmedAt: null,
        });
      } catch (error) {
        if (error instanceof GoogleAuthError) {
          throw error;
        }
        // The calendar keeps being polled until a channel exists
        console.error(`Registering a Google webhook for Profile ${profile.id} failed:`, error);
        runtime.watchRetryAt.set(calendarId, now + WATCH_RETRY_INTERVAL_MS);
        continue;
      }
      // Also after a success: a channel Google lets lapse sooner than the renewal window must not be replaced every tick
      runtime.watchRetryAt.set(calendarId, now + WATCH_RETRY_INTERVAL_MS);
      for (const replaced of rows.filter((row) => row.googleCalendarId === calendarId)) {
        await this.stopChannel(providers, replaced);
      }
    }
  }

  private async stopChannel(providers: SyncProviders, row: WatchChannelRow): Promise<void> {
    try {
      await providers.google.calendars.stopWatch(row.id, row.resourceId);
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        throw error;
      }
      // Google lets an unstopped channel lapse by itself, and a lapsed one is rejected by the webhook
      console.error(`Stopping Google channel ${row.id} failed:`, error);
    }
    deleteWatchChannel(this.deps.db, row.id);
  }

  /** Reads the Apple calendar tags every 30s and syncs when one moved (the first look counts as a move). */
  private async pollCalendarTags(profile: ProfileRow, runtime: ProfileRuntime, calendarUrls: readonly string[]): Promise<void> {
    const now = this.deps.clock.now();
    if (calendarUrls.length === 0 || (runtime.lastCtagPollAt !== null && now - runtime.lastCtagPollAt < CTAG_POLL_INTERVAL_MS)) {
      return;
    }
    runtime.lastCtagPollAt = now;
    const calendars = await this.providersFor(profile).apple.calendars.list();
    let changed = false;
    for (const url of calendarUrls) {
      const ctag = calendars.find((calendar) => calendar.url === url)?.ctag ?? null;
      const seen = runtime.calendarCtags.has(url);
      // A calendar without a tag cannot tell us anything beyond the first look
      if (!seen || (ctag !== null && runtime.calendarCtags.get(url) !== ctag)) {
        changed = true;
      }
      runtime.calendarCtags.set(url, ctag);
    }
    if (changed) {
      await this.requestSync(profile.id, 'calendars');
    }
  }

  /** `syncToken` polling for Google → Apple; slow while webhook channels cover every watched calendar. */
  private async pollGoogleCalendars(profile: ProfileRow, runtime: ProfileRuntime, watched: readonly string[]): Promise<void> {
    if (watched.length === 0) {
      return;
    }
    const now = this.deps.clock.now();
    const healthy = this.healthyChannelCalendars(profile);
    const interval = watched.every((id) => healthy.has(id)) ? GOOGLE_SAFETY_POLL_INTERVAL_MS : GOOGLE_POLL_INTERVAL_MS;
    if (runtime.lastGooglePollAt !== null && now - runtime.lastGooglePollAt < interval) {
      return;
    }
    runtime.lastGooglePollAt = now;
    await this.requestSync(profile.id, 'calendars');
  }

  /** Contacts have no push channel: the contact sync itself checks for deltas every two minutes. */
  private async pollContacts(profile: ProfileRow, runtime: ProfileRuntime, hasRules: boolean): Promise<void> {
    const now = this.deps.clock.now();
    if (!hasRules || (runtime.lastContactsPollAt !== null && now - runtime.lastContactsPollAt < CONTACTS_POLL_INTERVAL_MS)) {
      return;
    }
    runtime.lastContactsPollAt = now;
    await this.requestSync(profile.id, 'contacts');
  }

  private async syncNow(profileId: string, domain: SyncDomain): Promise<void> {
    const { db, clock } = this.deps;
    const profile = findProfile(db, profileId);
    if (!profile || !profile.enabled || profile.googleReauthRequired) {
      return;
    }
    try {
      await this.runner.run(profile, (providers, current, appleId) =>
        runProfileSync({ db, clock, profile: current, appleId, providers, domain, dryRun: false, force: false }),
      );
    } catch (error) {
      console.error(`Background sync of Profile ${profile.id} failed:`, error);
    }
  }
}
