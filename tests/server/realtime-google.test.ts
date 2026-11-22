import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarRuleDto } from '../../src/shared/calendar.js';
import type { ProfileStatusDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from '../helpers/api.js';
import { FAKE_WATCH_LIFETIME_MS } from '../helpers/fake-calendars.js';
import { simpleIcs } from '../helpers/fixtures.js';
import { createTestContext } from '../helpers/test-app.js';

const HOME = '/cal/home/';
const BASE_URL = 'https://sync.example.com';
const DAY_MS = 86_400_000;

describe('real-time calendar sync', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function scenario(options: { publicBaseUrl?: string | null; direction?: 'one_way' | 'bidirectional' } = {}) {
    const ctx = createTestContext({
      envOverrides: { PUBLIC_BASE_URL: options.publicBaseUrl === undefined ? BASE_URL : (options.publicBaseUrl ?? undefined) },
    });
    close = () => ctx.close();
    const api = new TestApi(ctx, await ctx.signIn());
    const world = ctx.providers.calendars;
    world.addAppleCalendar(APPLE_ID, { url: HOME, name: 'Privat' });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna', primary: true });
    const profile = await api.createProfile('Anna');
    await api.connectAccounts(profile);
    const rulePath = `/api/profiles/${profile.id}/rules/calendars`;
    const rule = await api.json<CalendarRuleDto>(rulePath, {
      method: 'POST',
      body: { appleCalendarUrl: HOME, googleCalendarId: 'primary', direction: options.direction ?? 'bidirectional' },
    });

    const tick = async (advanceMs = 0) => {
      ctx.clock.advanceMs(advanceMs);
      await ctx.realtime.tick();
      await ctx.realtime.settled();
    };
    const webhook = (headers: Record<string, string>, profileId = profile.id) =>
      ctx.app.request(`/webhooks/google/${profileId}`, { method: 'POST', headers });
    const notify = (channel: { id: string; token: string }, state = 'exists') =>
      webhook({ 'x-goog-channel-id': channel.id, 'x-goog-channel-token': channel.token, 'x-goog-resource-state': state });
    /** What Google does right after `events.watch`: it calls the webhook once with state `sync`. */
    const confirmChannels = async () => {
      for (const channel of world.activeWatchChannels('primary')) {
        await notify(channel, 'sync');
      }
    };
    const status = () => api.json<ProfileStatusDto>(`/api/profiles/${profile.id}/status`);
    const googleChangeReads = () => world.trace.filter((entry) => entry.startsWith('google.changes:')).length;
    const channels = () => world.activeWatchChannels('primary');
    /** An Apple event that is already synced to Google, followed by a Google-side edit that is not yet in Apple. */
    const seedSyncedEvent = async () => {
      world.putAppleEvent(APPLE_ID, HOME, 'e1.ics', simpleIcs('uid-1', 'Termin'));
      await api.request(`/api/profiles/${profile.id}/sync`, { method: 'POST', body: {} });
      return world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary')[0]!;
    };
    const editInGoogle = (id: string) =>
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', id, { summary: 'Verschoben in Google' });
    const appleSummary = () => world.appleCalendarObject(APPLE_ID, HOME, 'e1.ics')!.ics.match(/SUMMARY:(.*)/)![1]!.trim();

    return { ctx, api, world, profile, rule, rulePath, tick, webhook, notify, confirmChannels, status, googleChangeReads, channels, seedSyncedEvent, editInGoogle, appleSummary };
  }

  describe('Google Calendar webhooks', () => {
    it('registers a channel for a bidirectional rule that points at the Profile webhook', async () => {
      const s = await scenario();
      await s.tick();

      expect(s.channels()).toHaveLength(1);
      expect(s.channels()[0]).toMatchObject({ address: `${BASE_URL}/webhooks/google/${s.profile.id}` });
    });

    it('treats a channel as degraded until Google has reached the webhook, and as healthy afterwards', async () => {
      const s = await scenario();
      await s.tick();
      expect(await s.status()).toMatchObject({ googleCalendar: 'polling' });

      await s.confirmChannels();
      expect(await s.status()).toMatchObject({ googleCalendar: 'webhook' });
    });

    it('keeps polling every 60s while the webhook was never reached, e.g. because the public URL is unreachable', async () => {
      const s = await scenario();
      const event = await s.seedSyncedEvent();
      await s.tick();

      s.editInGoogle(event.id);
      await s.tick(60_000);

      expect(s.appleSummary()).toBe('Verschoben in Google');
    });

    it('counts a real change notification as proof that the webhook works', async () => {
      const s = await scenario();
      await s.tick();

      await s.notify(s.channels()[0]!, 'exists');
      await s.ctx.realtime.settled();

      expect(await s.status()).toMatchObject({ googleCalendar: 'webhook' });
    });

    it('does not register channels for one-way rules', async () => {
      const s = await scenario({ direction: 'one_way' });
      await s.tick();

      expect(s.world.watchChannels).toEqual([]);
      expect(await s.status()).toMatchObject({ googleCalendar: 'inactive' });
    });

    it('syncs a Google change into Apple as soon as a valid notification arrives, without a session', async () => {
      const s = await scenario();
      const event = await s.seedSyncedEvent();
      await s.tick();
      s.editInGoogle(event.id);

      const response = await s.notify(s.channels()[0]!);
      expect(response.status).toBe(200);
      await s.ctx.realtime.settled();

      expect(s.appleSummary()).toBe('Verschoben in Google');
    });

    it('acknowledges the initial `sync` handshake without syncing', async () => {
      const s = await scenario();
      await s.tick();
      const reads = s.googleChangeReads();

      const response = await s.notify(s.channels()[0]!, 'sync');
      await s.ctx.realtime.settled();

      expect(response.status).toBe(200);
      expect(s.googleChangeReads()).toBe(reads);
    });

    it.each([
      ['no channel headers', {}, 401],
      ['a missing token', { 'x-goog-channel-id': 'x' }, 401],
      ['an unknown channel', { 'x-goog-channel-id': 'unknown', 'x-goog-channel-token': 'whatever' }, 403],
    ])('rejects %s instead of redirecting to the login', async (_label, headers, expected) => {
      const s = await scenario();
      await s.tick();
      const reads = s.googleChangeReads();

      const response = await s.webhook(headers);
      await s.ctx.realtime.settled();

      expect(response.status).toBe(expected);
      expect(response.headers.get('location')).toBeNull();
      expect(s.googleChangeReads()).toBe(reads);
    });

    it('rejects a wrong token, and a channel presented for another Profile', async () => {
      const s = await scenario();
      await s.tick();
      const channel = s.channels()[0]!;
      const reads = s.googleChangeReads();

      const wrongToken = await s.notify({ id: channel.id, token: `${channel.token}x` });
      const otherProfile = await s.api.createProfile('Ben');
      const wrongProfile = await s.webhook(
        { 'x-goog-channel-id': channel.id, 'x-goog-channel-token': channel.token },
        otherProfile.id,
      );
      await s.ctx.realtime.settled();

      expect(wrongToken.status).toBe(403);
      expect(wrongProfile.status).toBe(403);
      expect(s.googleChangeReads()).toBe(reads);
    });

    it('stores the channel token encrypted', async () => {
      const s = await scenario();
      await s.tick();
      const token = s.channels()[0]!.token;

      const rows = s.ctx.dbContext.sqlite.prepare('SELECT * FROM google_watch_channels').all();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('renews the channel before it expires and stops using the old one', async () => {
      const s = await scenario();
      await s.tick();
      const [first] = s.channels();

      await s.tick(FAKE_WATCH_LIFETIME_MS - 2 * DAY_MS);
      expect(s.channels()).toHaveLength(1);

      await s.tick(DAY_MS + 3_600_000);
      const [renewed] = s.channels();
      expect(s.channels()).toHaveLength(1);
      expect(renewed!.id).not.toBe(first!.id);
      expect(first!.stopped).toBe(true);
      expect((await s.notify(first!)).status).toBe(403);
      expect((await s.notify(renewed!)).status).toBe(200);
    });

    it('does not register a channel on every tick when Google grants a lifetime shorter than the renewal window', async () => {
      const s = await scenario();
      s.world.watchLifetimeMs = 12 * 3_600_000;

      await s.tick();
      await s.tick(1000);
      await s.tick(1000);

      expect(s.world.watchChannels).toHaveLength(1);
    });

    it('rejects a notification for a channel that has expired', async () => {
      const s = await scenario();
      await s.tick();
      const [channel] = s.channels();
      s.world.failWatches(GOOGLE_REFRESH_TOKEN, new Error('Webhook URL not reachable'));

      await s.tick(FAKE_WATCH_LIFETIME_MS + 1000);

      expect((await s.notify(channel!)).status).toBe(403);
    });

    it('stops the channel when the bidirectional rule is removed', async () => {
      const s = await scenario();
      await s.tick();
      const [channel] = s.channels();

      await s.api.request(`${s.rulePath}/${s.rule.id}`, { method: 'DELETE' });
      await s.tick();

      expect(channel!.stopped).toBe(true);
      expect(await s.status()).toMatchObject({ googleCalendar: 'inactive' });
    });
  });

  describe('syncToken polling', () => {
    it('keeps Google → Apple running every 60s when PUBLIC_BASE_URL is not configured', async () => {
      const s = await scenario({ publicBaseUrl: null });
      const event = await s.seedSyncedEvent();
      await s.tick();
      expect(s.world.watchChannels).toEqual([]);
      expect(await s.status()).toMatchObject({ googleCalendar: 'polling' });

      s.editInGoogle(event.id);
      await s.tick(30_000);
      expect(s.appleSummary()).toBe('Termin');

      await s.tick(30_000);
      expect(s.appleSummary()).toBe('Verschoben in Google');
    });

    it('does not poll Google every minute while a webhook channel is healthy', async () => {
      const s = await scenario();
      await s.tick();
      await s.confirmChannels();
      const reads = s.googleChangeReads();

      await s.tick(60_000);
      await s.tick(60_000);

      expect(s.googleChangeReads()).toBe(reads);
    });

    it('falls back to polling when the channel cannot be registered, and registers it later', async () => {
      const s = await scenario();
      const event = await s.seedSyncedEvent();
      s.world.failWatches(GOOGLE_REFRESH_TOKEN, new Error('Webhook URL not reachable'));
      await s.tick();
      expect(await s.status()).toMatchObject({ googleCalendar: 'polling' });

      s.editInGoogle(event.id);
      await s.tick(60_000);
      expect(s.appleSummary()).toBe('Verschoben in Google');

      s.world.clearWatchFailure(GOOGLE_REFRESH_TOKEN);
      await s.tick(5 * 60_000);
      await s.confirmChannels();
      expect(await s.status()).toMatchObject({ googleCalendar: 'webhook' });
    });

    it('falls back to polling once an unrenewable channel has expired', async () => {
      const s = await scenario();
      const event = await s.seedSyncedEvent();
      await s.tick();
      await s.confirmChannels();
      expect(await s.status()).toMatchObject({ googleCalendar: 'webhook' });
      s.world.failWatches(GOOGLE_REFRESH_TOKEN, new Error('Webhook URL not reachable'));

      await s.tick(FAKE_WATCH_LIFETIME_MS + 1_000);
      expect(await s.status()).toMatchObject({ googleCalendar: 'polling' });

      s.editInGoogle(event.id);
      await s.tick(60_000);
      expect(s.appleSummary()).toBe('Verschoben in Google');
    });
  });

  describe('Apple CalDAV ctag polling', () => {
    it('syncs a new Apple event to Google within 30s of the calendar changing', async () => {
      const s = await scenario({ direction: 'one_way', publicBaseUrl: null });
      await s.tick();

      s.world.putAppleEvent(APPLE_ID, HOME, 'new.ics', simpleIcs('uid-new', 'Neu'));
      await s.tick(10_000);
      expect(s.world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary')).toEqual([]);

      await s.tick(20_000);
      expect(s.world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary').map((e) => e.summary)).toEqual(['Neu']);
    });

    it('does not read anything but the calendar list while no ctag changed', async () => {
      const s = await scenario({ direction: 'one_way', publicBaseUrl: null });
      await s.tick();
      s.world.trace.length = 0;

      await s.tick(30_000);
      await s.tick(30_000);

      expect(s.world.trace.filter((entry) => !entry.startsWith('apple.list:'))).toEqual([]);
    });
  });
});
