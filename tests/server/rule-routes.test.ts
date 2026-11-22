import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarRuleDto, SyncRunResult } from '../../src/shared/calendar.js';
import { parseRuleOptions } from '../../src/server/routes/rule-routes.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from '../helpers/api.js';
import { ARBEIT_GROUP, FAMILIE_GROUP, G_ARBEIT, G_FAMILIE, appleCard, groupCard, setupContacts } from '../helpers/contacts-scenario.js';
import { simpleIcs } from '../helpers/fixtures.js';
import { createTestContext } from '../helpers/test-app.js';

describe('parseRuleOptions', () => {
  const all = ['direction', 'syncWindowDays', 'syncReminders', 'deleteBehavior', 'enabled'] as const;

  it('takes the valid options of the body and leaves the others unset', () => {
    expect(parseRuleOptions({ direction: 'bidirectional', enabled: false }, all)).toEqual({
      ok: true,
      value: { direction: 'bidirectional', enabled: false },
    });
    expect(parseRuleOptions({}, all)).toEqual({ ok: true, value: {} });
  });

  it('ignores options the kind of rule does not accept', () => {
    expect(parseRuleOptions({ direction: 'sideways', deleteBehavior: 'delete' }, ['enabled'])).toEqual({
      ok: true,
      value: {},
    });
  });

  it.each([
    [{ direction: 'sideways' }, 'direction must be "one_way" or "bidirectional"'],
    [{ syncWindowDays: 0 }, 'syncWindowDays must be a positive integer or null (all history)'],
    [{ syncWindowDays: 1.5 }, 'syncWindowDays must be a positive integer or null (all history)'],
    [{ syncWindowDays: '7' }, 'syncWindowDays must be a positive integer or null (all history)'],
    [{ syncReminders: 'yes' }, 'syncReminders must be a boolean'],
    [{ deleteBehavior: 'archive' }, 'deleteBehavior must be "trash" or "delete"'],
    [{ enabled: 1 }, 'enabled must be a boolean'],
  ])('rejects %j', (body, error) => {
    expect(parseRuleOptions(body, all)).toEqual({ ok: false, error });
  });

  it('accepts all history (null) and a positive number of days', () => {
    expect(parseRuleOptions({ syncWindowDays: null }, all)).toEqual({ ok: true, value: { syncWindowDays: null } });
    expect(parseRuleOptions({ syncWindowDays: 30 }, all)).toEqual({ ok: true, value: { syncWindowDays: 30 } });
  });

  it('reports the first invalid option in the order of the accepted ones', () => {
    const body = { enabled: 'x', direction: 'y' };

    expect(parseRuleOptions(body, ['direction', 'enabled'])).toMatchObject({ error: expect.stringContaining('direction') });
    expect(parseRuleOptions(body, ['enabled', 'direction'])).toMatchObject({ error: expect.stringContaining('enabled') });
  });
});

describe('a changed rule is applied by the next run although Apple did not change', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  describe('calendars (tracked per rule)', () => {
    const HOME = '/cal/home/';

    async function setup() {
      const ctx = createTestContext();
      close = () => ctx.close();
      const api = new TestApi(ctx, await ctx.signIn());
      ctx.providers.calendars.addAppleCalendar(APPLE_ID, { url: HOME, name: 'Privat' });
      ctx.providers.calendars.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna', primary: true });
      ctx.providers.calendars.putAppleEvent(APPLE_ID, HOME, 'e1.ics', simpleIcs('uid-1', 'Termin 1', 3));
      const profile = await api.createProfile('Anna');
      await api.connectAccounts(profile);
      const rule = await api.json<CalendarRuleDto>(`/api/profiles/${profile.id}/rules/calendars`, {
        method: 'POST',
        body: { appleCalendarUrl: HOME, googleCalendarId: 'primary' },
      });
      const sync = async () =>
        (await api.json<SyncRunResult>(`/api/profiles/${profile.id}/sync`, { method: 'POST', body: {} })).rules[0];
      return { api, profile, rule, sync };
    }

    it('idles on an unchanged calendar, but not after the rule was updated', async () => {
      const { api, profile, rule, sync } = await setup();
      expect(await sync()).toMatchObject({ status: 'ok' });
      expect(await sync()).toMatchObject({ status: 'skipped', reason: 'unchanged' });

      const res = await api.request(`/api/profiles/${profile.id}/rules/calendars/${rule.id}`, {
        method: 'PATCH',
        body: { syncReminders: true },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ syncReminders: true });
      expect(await sync()).toMatchObject({ status: 'ok' });
      expect(await sync()).toMatchObject({ status: 'skipped', reason: 'unchanged' });
    });
  });

  describe('contacts (tracked profile-wide)', () => {
    async function setup() {
      const scenario = await setupContacts();
      close = () => scenario.ctx.close();
      const { world, appleId } = scenario;
      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Eins', 'Test'));
      world.putAppleVCard(appleId, '/card/familie.vcf', groupCard(FAMILIE_GROUP, 'Familie', ['u1']));
      world.putAppleVCard(appleId, '/card/arbeit.vcf', groupCard(ARBEIT_GROUP, 'Arbeit', ['u1']));
      const family = await scenario.createRule(FAMILIE_GROUP, G_FAMILIE);
      expect(await scenario.sync()).toMatchObject({ status: 'ok' });
      expect(await scenario.sync()).toMatchObject({ status: 'skipped', reason: 'unchanged' });
      return { ...scenario, family };
    }

    it('after a rule was updated', async () => {
      const { api, profile, family, sync } = await setup();

      // Even an update that changes nothing visible asks for a fresh look at the address book
      await api.request(`/api/profiles/${profile.id}/rules/contacts/${family.id}`, {
        method: 'PATCH',
        body: { direction: 'one_way' },
      });

      expect(await sync()).toMatchObject({ status: 'ok' });
      expect(await sync()).toMatchObject({ status: 'skipped', reason: 'unchanged' });
    });

    it('after a rule was deleted', async () => {
      const { api, profile, family, createRule, sync } = await setup();
      await createRule(ARBEIT_GROUP, G_ARBEIT);
      expect(await sync()).toMatchObject({ status: 'ok' });
      expect(await sync()).toMatchObject({ status: 'skipped', reason: 'unchanged' });

      const res = await api.request(`/api/profiles/${profile.id}/rules/contacts/${family.id}`, { method: 'DELETE' });

      expect(res.status).toBe(204);
      expect(await sync()).toMatchObject({ status: 'ok' });
    });
  });
});
