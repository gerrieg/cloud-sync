import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileOverviewDto } from '../../src/shared/profile.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN } from '../helpers/api.js';
import { HOME, setupCalendar } from '../helpers/calendar-scenario.js';
import { simpleIcs } from '../helpers/fixtures.js';
import { rawMail } from '../helpers/mail-scenario.js';

describe('overview and Sync All', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  /** Anna and Ben are connected with a calendar rule each; Cora is paused; Dora has no accounts. */
  async function household() {
    const s = await setupCalendar();
    close = () => s.ctx.close();
    s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Annas Termin', 1));

    const ben = await s.api.createProfile('Ben');
    await s.api.connectAccounts(ben, { appleId: 'ben@icloud.com', googleRefreshToken: 'ben-token' });
    s.world.addAppleCalendar('ben@icloud.com', { url: '/cal/ben/', name: 'Ben privat' });
    s.world.addGoogleCalendar('ben-token', { id: 'primary', name: 'Ben', primary: true });
    await s.api.request(`/api/profiles/${ben.id}/rules/calendars`, {
      method: 'POST',
      body: { appleCalendarUrl: '/cal/ben/', googleCalendarId: 'primary' },
    });
    s.world.putAppleEvent('ben@icloud.com', '/cal/ben/', 'b.ics', simpleIcs('uid-b', 'Bens Termin', 2));

    const cora = await s.api.createProfile('Cora');
    await s.api.connectAccounts(cora, { appleId: 'cora@icloud.com', googleRefreshToken: 'cora-token' });
    await s.api.request(`/api/profiles/${cora.id}`, { method: 'PATCH', body: { enabled: false } });
    const dora = await s.api.createProfile('Dora');

    const syncAll = (cookie?: string | null) => s.api.request('/api/sync-all', { method: 'POST', cookie });
    const overview = () => s.api.json<ProfileOverviewDto[]>('/api/overview');
    return { ...s, ben, cora, dora, syncAll, overview };
  }

  describe('POST /api/sync-all', () => {
    it('queues a sync for every active Profile and skips paused and unconnected ones', async () => {
      const s = await household();

      const response = await s.syncAll();

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ queued: [s.profile.id, s.ben.id] });
      await s.ctx.realtime.settled();
      expect(s.googleEvents().map((event) => event.summary)).toEqual(['Annas Termin']);
      expect(s.world.googleEvents('ben-token', 'primary').map((event) => event.summary)).toEqual(['Bens Termin']);
    });

    it('needs a session', async () => {
      const s = await household();

      expect((await s.syncAll(null)).status).toBe(401);
      await s.ctx.realtime.settled();
      expect(s.googleEvents()).toEqual([]);
    });
  });

  describe('GET /api/overview', () => {
    it('lists every Profile with its last successful sync, live status and open errors', async () => {
      const s = await household();
      await s.syncAll();
      await s.ctx.realtime.settled();
      const syncedAt = s.ctx.clock.now();

      const cards = await s.overview();

      expect(cards.map((card) => card.profile.name)).toEqual(['Anna', 'Ben', 'Cora', 'Dora']);
      expect(cards[0]).toMatchObject({
        profile: { id: s.profile.id, lastSyncAt: syncedAt, lastSuccessfulSyncAt: syncedAt, lastSyncStatus: 'ok' },
        status: { mailIdle: 'disconnected', googleCalendar: 'inactive' },
        openErrors: 0,
      });
      expect(cards[2]).toMatchObject({ profile: { enabled: false }, status: { mailIdle: 'paused' } });
      expect(cards[3]).toMatchObject({ profile: { lastSuccessfulSyncAt: null }, openErrors: 0 });
    });

    it('keeps the last successful sync when a later run fails, and counts the open errors', async () => {
      const s = await household();
      await s.syncAll();
      await s.ctx.realtime.settled();
      const okAt = s.ctx.clock.now();
      s.ctx.clock.advanceMinutes(10);
      s.world.putAppleEvent(APPLE_ID, HOME, 'c.ics', simpleIcs('uid-c', 'Neu', 3));
      s.world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Google is down'));
      await s.sync();

      const [anna] = await s.overview();

      expect(anna).toMatchObject({
        profile: { lastSyncAt: s.ctx.clock.now(), lastSuccessfulSyncAt: okAt, lastSyncStatus: 'error' },
        openErrors: 1,
      });
    });

    it('needs a session', async () => {
      const s = await household();

      expect((await s.api.request('/api/overview', { cookie: null })).status).toBe(401);
    });
  });

  describe('per kind of data: rules, linked items and the runs', () => {
    it('shows what is enabled, what the last run carried over and the totals of the last 24 hours', async () => {
      const s = await household();
      await s.syncAll();
      await s.ctx.realtime.settled();

      const [anna, , cora] = await s.overview();

      expect(anna!.domains.map((d) => d.domain)).toEqual(['calendars', 'contacts', 'mail']);
      expect(anna!.domains[0]).toMatchObject({
        rulesEnabled: 1,
        rulesTotal: 1,
        direction: s.rule.direction,
        tracked: 1,
        running: false,
        lastRun: { at: s.ctx.clock.now(), status: 'ok', created: 1, updated: 0, deleted: 0 },
        last24h: { runs: 1, failedRuns: 0, created: 1, updated: 0, deleted: 0 },
      });
      // No contact or mail rule: nothing enabled, nothing ran
      expect(anna!.domains[1]).toMatchObject({ rulesEnabled: 0, rulesTotal: 0, direction: null, tracked: 0, lastRun: null });
      expect(anna!.domains[2]).toMatchObject({ rulesTotal: 0, lastRun: null, last24h: { runs: 0 } });
      expect(cora!.domains.every((d) => d.lastRun === null)).toBe(true);
    });

    it('records a failed run, and ages runs out of the 24 hour totals but keeps the last run', async () => {
      const s = await household();
      await s.syncAll();
      await s.ctx.realtime.settled();
      s.ctx.clock.advanceMinutes(10);
      s.world.putAppleEvent(APPLE_ID, HOME, 'c.ics', simpleIcs('uid-c', 'Neu', 3));
      s.world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Google is down'));
      await s.sync();

      const failed = (await s.overview())[0]!.domains[0]!;
      expect(failed.lastRun).toMatchObject({ status: 'error', created: 0 });
      expect(failed.last24h).toMatchObject({ runs: 2, failedRuns: 1, created: 1 });

      s.ctx.clock.advanceMinutes(25 * 60);
      const aged = (await s.overview())[0]!.domains[0]!;
      expect(aged.lastRun).toMatchObject({ status: 'error' });
      expect(aged.last24h).toMatchObject({ runs: 0, failedRuns: 0, created: 0 });
    });

    it('records no run for a dry run', async () => {
      const s = await household();

      await s.api.request(`/api/profiles/${s.profile.id}/dry-run`, { method: 'POST', body: {} });

      expect((await s.overview())[0]!.domains[0]!.lastRun).toBeNull();
    });
  });

  describe('what counts as a successful sync', () => {
    /** Anna with a calendar rule (fine) and an INBOX mail rule (one message Gmail will reject). */
    async function calendarAndMail() {
      const s = await setupCalendar();
      close = () => s.ctx.close();
      const mail = s.ctx.providers.mail;
      mail.addGoogleAccount(GOOGLE_REFRESH_TOKEN);
      mail.addAppleFolder(APPLE_ID, 'INBOX', 'inbox');
      await s.api.request(`/api/profiles/${s.profile.id}/rules/mail`, { method: 'POST', body: { appleFolderPath: 'INBOX' } });
      mail.deliver(APPLE_ID, 'INBOX', { raw: rawMail({ subject: 'Poison' }), internalDate: s.ctx.clock.now() - 86_400_000 });
      mail.rejectImportsContaining('Subject: Poison');
      const reloadProfile = () => s.api.json<ProfileDto>(`/api/profiles/${s.profile.id}`);
      return { ...s, mail, reloadProfile };
    }

    it('does not count a full run as successful when its mail part failed', async () => {
      const s = await calendarAndMail();

      await s.sync({});

      expect(await s.reloadProfile()).toMatchObject({ lastSyncStatus: 'error', lastSuccessfulSyncAt: null });
    });

    it('counts a later error-free mail-only run as successful but does not clear the Profile error', async () => {
      const s = await calendarAndMail();
      await s.sync({});
      s.mail.clearImportRejections();
      s.ctx.clock.advanceMinutes(5);

      await s.sync({ domain: 'mail' });

      expect(await s.reloadProfile()).toMatchObject({ lastSyncStatus: 'error', lastSuccessfulSyncAt: s.ctx.clock.now() });
    });

    it('lets only a full run of the calendar rules clear the Profile error', async () => {
      const s = await calendarAndMail();
      await s.sync({});
      s.mail.clearImportRejections();

      await s.sync({ domain: 'calendars' });

      expect(await s.reloadProfile()).toMatchObject({ lastSyncStatus: 'ok' });
    });

    it('does not clear the Profile error when a single rule is retried', async () => {
      const s = await calendarAndMail();
      await s.sync({});

      await s.api.request(`/api/profiles/${s.profile.id}/rules/calendars/${s.rule.id}/retry`, { method: 'POST' });

      expect(await s.reloadProfile()).toMatchObject({ lastSyncStatus: 'error' });
    });
  });
});
