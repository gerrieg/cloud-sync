import { afterEach, describe, expect, it } from 'vitest';
import type { SyncLogDto } from '../../src/shared/logs.js';
import { APPLE_ID } from '../helpers/api.js';
import { HOME, setupCalendar } from '../helpers/calendar-scenario.js';
import { simpleIcs } from '../helpers/fixtures.js';
import { appleCard, G_FAMILIE, setupContacts } from '../helpers/contacts-scenario.js';
import { setupMail } from '../helpers/mail-scenario.js';

describe('sync logs', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function calendar() {
    const s = await setupCalendar();
    close = () => s.ctx.close();
    const logs = (query = '') => s.api.json<SyncLogDto[]>(`/api/logs${query}`);
    return { ...s, logs };
  }

  describe('per-item failure isolation', () => {
    it('logs the failing event as an unresolved error and still syncs the others', async () => {
      const s = await calendar();
      s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Alpha', 1));
      s.world.putAppleEvent(APPLE_ID, HOME, 'b.ics', simpleIcs('uid-b', 'Beta', 2));
      s.world.putAppleEvent(APPLE_ID, HOME, 'c.ics', simpleIcs('uid-c', 'Gamma', 3));
      s.world.failNextGoogleWrite('anna-refresh-token', new Error('Google rejected the event'));

      const result = await s.sync();

      expect(result.rules[0]).toMatchObject({ status: 'error', error: 'Google rejected the event' });
      expect(s.googleEvents()).toHaveLength(2);
      const errors = await s.logs('?level=error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        profileId: s.profile.id,
        profileName: 'Anna',
        ruleId: s.rule.id,
        ruleName: 'Privat → Anna',
        entityType: 'calendar',
        level: 'error',
        message: 'Google rejected the event',
        resolvedAt: null,
      });
      expect(['Alpha', 'Beta', 'Gamma']).toContain(errors[0]!.summary);
      expect(s.googleEvents().map((event) => event.summary)).not.toContain(errors[0]!.summary);
    });

    it('does not log anything for a dry run', async () => {
      const s = await calendar();
      s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Alpha', 1));

      await s.api.request(`/api/profiles/${s.profile.id}/dry-run`, { method: 'POST', body: {} });

      expect(await s.logs()).toEqual([]);
    });

    it('keeps one unresolved error per item however often the run fails again', async () => {
      const s = await calendar();
      s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Alpha', 1));
      s.world.failNextGoogleWrite('anna-refresh-token', new Error('first failure'));
      await s.sync();
      s.world.failNextGoogleWrite('anna-refresh-token', new Error('second failure'));
      await s.sync();

      const errors = await s.logs('?level=error');

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: 'second failure' });
    });
  });

  describe('contacts and mail', () => {
    it('isolates a failing contact, attributes it to the rule that claims it and logs it', async () => {
      const s = await setupContacts();
      close = () => s.ctx.close();
      const rule = await s.createRule('all', G_FAMILIE);
      s.world.putAppleVCard(s.appleId, 'a.vcf', appleCard('uid-a', 'Anna', 'Muster'));
      s.world.putAppleVCard(s.appleId, 'p.vcf', appleCard('uid-p', 'Poison', 'Pill'));
      s.world.putAppleVCard(s.appleId, 'b.vcf', appleCard('uid-b', 'Ben', 'Beispiel'));
      s.world.rejectGoogleWritesFor('Poison', new Error('Google rejected the contact'));

      const result = await s.sync();

      expect(result.status).toBe('error');
      expect(s.google().map((contact) => contact.data.givenName).sort()).toEqual(['Anna', 'Ben']);
      const errors = await s.api.json<SyncLogDto[]>('/api/logs?level=error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        entityType: 'contact',
        ruleId: rule.id,
        itemKey: 'uid-p',
        summary: 'Poison Pill',
        message: 'Google rejected the contact',
        resolvedAt: null,
      });
    });

    it('logs a mail that Gmail rejects and attributes it to the rule of its folder', async () => {
      const s = await setupMail();
      close = () => s.ctx.close();
      const rule = await s.createRule('INBOX');
      s.deliver('INBOX', 'Fine');
      s.deliver('INBOX', 'Poison');
      s.world.rejectImportsContaining('Subject: Poison', new Error('Gmail rejected the message'));

      const result = await s.sync();

      expect(result.status).toBe('error');
      expect(s.gmail()).toHaveLength(1);
      const errors = await s.api.json<SyncLogDto[]>('/api/logs?level=error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        entityType: 'email',
        ruleId: rule.id,
        summary: 'Poison',
        message: 'Gmail rejected the message',
        resolvedAt: null,
      });
    });

    it('logs a mail rule whose folder is gone as an error of that rule', async () => {
      const s = await setupMail();
      close = () => s.ctx.close();
      const rule = await s.createRule('Receipts');
      s.world.removeAppleFolder(s.appleId, 'Receipts');

      await s.sync();

      const errors = await s.api.json<SyncLogDto[]>('/api/logs?level=error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        entityType: 'email',
        ruleId: rule.id,
        itemKey: null,
        message: expect.stringContaining('no longer exists'),
      });
    });
  });

  describe('info entries and GET /api/logs', () => {
    /** Anna's calendar run with one failing and two good events, plus Ben's mail run with one message. */
    async function twoProfiles() {
      const s = await setupCalendar();
      close = () => s.ctx.close();
      s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Alpha', 1));
      s.world.putAppleEvent(APPLE_ID, HOME, 'b.ics', simpleIcs('uid-b', 'Beta', 2));
      s.world.putAppleEvent(APPLE_ID, HOME, 'c.ics', simpleIcs('uid-c', 'Gamma', 3));
      s.world.failNextGoogleWrite('anna-refresh-token', new Error('Google rejected the event'));
      await s.sync();

      const ben = await s.api.createProfile('Ben');
      await s.api.connectAccounts(ben, { appleId: 'ben@icloud.com', googleRefreshToken: 'ben-token' });
      s.ctx.providers.mail.addGoogleAccount('ben-token');
      s.ctx.providers.mail.addAppleFolder('ben@icloud.com', 'INBOX', 'inbox');
      await s.api.request(`/api/profiles/${ben.id}/rules/mail`, { method: 'POST', body: { appleFolderPath: 'INBOX' } });
      s.ctx.clock.advanceMinutes(5);
      s.ctx.providers.mail.deliver('ben@icloud.com', 'INBOX', {
        raw: 'Message-ID: <hi@example.com>\r\nFrom: a@example.com\r\nSubject: Hallo\r\nDate: Wed, 14 Jan 2026 09:00:00 +0000\r\n\r\nBody',
        internalDate: s.ctx.clock.now() - 86_400_000,
      });
      await s.api.request(`/api/profiles/${ben.id}/sync`, { method: 'POST', body: { domain: 'mail' } });
      return { ...s, ben, logs: (query = '') => s.api.json<SyncLogDto[]>(`/api/logs${query}`) };
    }

    it('logs every carried-over change as an info line and nothing for unchanged items', async () => {
      const s = await twoProfiles();

      const infos = await s.logs(`?level=info&profileId=${s.profile.id}`);
      expect(infos).toHaveLength(2);
      expect(infos.map((entry) => entry.action)).toEqual(['create', 'create']);
      expect(infos[0]).toMatchObject({ entityType: 'calendar', ruleId: s.rule.id, ruleName: 'Privat → Anna', resolvedAt: null });

      const before = (await s.logs()).length;
      await s.sync();
      await s.sync();
      // The failed event is now created, everything else is unchanged
      expect((await s.logs()).length).toBe(before + 1);
    });

    it('filters by Profile, entity type, level and unresolved errors', async () => {
      const s = await twoProfiles();

      expect((await s.logs(`?profileId=${s.ben.id}`)).map((e) => [e.entityType, e.level])).toEqual([['email', 'info']]);
      expect(new Set((await s.logs('?entityType=calendar')).map((e) => e.profileId))).toEqual(new Set([s.profile.id]));
      expect((await s.logs('?entityType=email&level=error'))).toEqual([]);
      expect((await s.logs('?level=error')).map((e) => e.level)).toEqual(['error']);
      expect((await s.logs('?unresolvedOnly=true')).map((e) => e.level)).toEqual(['error']);
      expect((await s.logs('?unresolvedOnly=false&level=info')).length).toBe(3);
    });

    it('lists the newest entries first and honours the limit', async () => {
      const s = await twoProfiles();

      const all = await s.logs();
      expect(all.map((e) => e.createdAt)).toEqual([...all.map((e) => e.createdAt)].sort((a, b) => b - a));
      expect(all[0]).toMatchObject({ profileId: s.ben.id });
      expect(await s.logs('?limit=2')).toHaveLength(2);
    });

    it.each(['entityType=file', 'level=warn', 'unresolvedOnly=yes', 'limit=0', 'limit=5000', 'limit=x'])(
      'rejects the invalid filter %s',
      async (query) => {
        const s = await twoProfiles();

        expect((await s.api.request(`/api/logs?${query}`)).status).toBe(400);
      },
    );

    it('is only available with a session', async () => {
      const s = await twoProfiles();

      expect((await s.api.request('/api/logs', { cookie: null })).status).toBe(401);
    });
  });
});
