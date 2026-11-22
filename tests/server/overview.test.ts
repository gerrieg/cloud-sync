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
