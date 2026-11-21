import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarRuleDto } from '../../src/shared/calendar.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from '../helpers/api.js';
import { createTestContext } from '../helpers/test-app.js';

describe('Calendar discovery HTTP seam', () => {
  let api: TestApi | undefined;

  afterEach(() => {
    api?.ctx.close();
    api = undefined;
  });

  async function setup(): Promise<{ api: TestApi; profile: ProfileDto }> {
    const ctx = createTestContext();
    api = new TestApi(ctx, await ctx.signIn());
    return { api, profile: await api.createProfile('Anna') };
  }

  it('lists Apple calendars (flagging read-only and subscribed ones) and Google calendars', async () => {
    const { api, profile } = await setup();
    const world = api.ctx.providers.calendars;
    world.addAppleCalendar(APPLE_ID, { url: '/cal/home/', name: 'Privat' });
    world.addAppleCalendar(APPLE_ID, {
      url: '/cal/holidays/',
      name: 'Feiertage',
      readOnly: true,
      subscribed: true,
    });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna', primary: true });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'shared', name: 'Familie', writable: false });
    await api.connectAccounts(profile);

    const res = await api.request(`/api/profiles/${profile.id}/discover/calendars`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      apple: [
        { url: '/cal/home/', name: 'Privat', readOnly: false, subscribed: false },
        { url: '/cal/holidays/', name: 'Feiertage', readOnly: true, subscribed: true },
      ],
      google: [
        { id: 'primary', name: 'Anna', primary: true, writable: true },
        { id: 'shared', name: 'Familie', primary: false, writable: false },
      ],
    });
  });

  it('requires both accounts to be connected', async () => {
    const { api, profile } = await setup();

    const res = await api.request(`/api/profiles/${profile.id}/discover/calendars`);

    expect(res.status).toBe(409);
  });

  it('reports a revoked Google authorization and flags the Profile for re-authentication', async () => {
    const { api, profile } = await setup();
    api.ctx.providers.calendars.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna' });
    await api.connectAccounts(profile);
    api.ctx.providers.calendars.rejectGoogleWithInvalidGrant(GOOGLE_REFRESH_TOKEN);

    const res = await api.request(`/api/profiles/${profile.id}/discover/calendars`);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reauthRequired: true });
    expect(await api.json<ProfileDto>(`/api/profiles/${profile.id}`)).toMatchObject({
      googleReauthRequired: true,
    });
  });
});

describe('Calendar Sync Rules HTTP seam', () => {
  let api: TestApi | undefined;

  afterEach(() => {
    api?.ctx.close();
    api = undefined;
  });

  async function setup() {
    const ctx = createTestContext();
    api = new TestApi(ctx, await ctx.signIn());
    const world = ctx.providers.calendars;
    world.addAppleCalendar(APPLE_ID, { url: '/cal/home/', name: 'Privat' });
    world.addAppleCalendar(APPLE_ID, { url: '/cal/work/', name: 'Arbeit' });
    world.addAppleCalendar(APPLE_ID, {
      url: '/cal/holidays/',
      name: 'Feiertage',
      readOnly: true,
      subscribed: true,
    });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna', primary: true });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'family', name: 'Familie' });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'shared', name: 'Fremd', writable: false });
    const profile = await api.createProfile('Anna');
    await api.connectAccounts(profile);
    return { api, profile };
  }

  const rulesPath = (profile: ProfileDto) => `/api/profiles/${profile.id}/rules/calendars`;

  async function createRule(
    api: TestApi,
    profile: ProfileDto,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return api.request(rulesPath(profile), { method: 'POST', body });
  }

  it('creates a rule with defaults (30-day window, reminders off, active, one-way) and lists it', async () => {
    const { api, profile } = await setup();

    const res = await createRule(api, profile, {
      appleCalendarUrl: '/cal/home/',
      googleCalendarId: 'primary',
    });

    expect(res.status).toBe(201);
    const rule = (await res.json()) as CalendarRuleDto;
    expect(rule).toMatchObject({
      appleCalendarUrl: '/cal/home/',
      appleCalendarName: 'Privat',
      appleReadOnly: false,
      googleCalendarId: 'primary',
      googleCalendarName: 'Anna',
      direction: 'one_way',
      syncWindowDays: 30,
      syncReminders: false,
      enabled: true,
    });
    expect(await api.json<CalendarRuleDto[]>(rulesPath(profile))).toEqual([rule]);
  });

  it('accepts bidirectional, an all-history window and reminders opt-in on creation', async () => {
    const { api, profile } = await setup();

    const rule = (await (
      await createRule(api, profile, {
        appleCalendarUrl: '/cal/work/',
        googleCalendarId: 'family',
        direction: 'bidirectional',
        syncWindowDays: null,
        syncReminders: true,
      })
    ).json()) as CalendarRuleDto;

    expect(rule).toMatchObject({ direction: 'bidirectional', syncWindowDays: null, syncReminders: true });
  });

  it('enforces one-way for read-only and subscribed Apple calendars, on creation and on update', async () => {
    const { api, profile } = await setup();

    const rule = (await (
      await createRule(api, profile, {
        appleCalendarUrl: '/cal/holidays/',
        googleCalendarId: 'primary',
        direction: 'bidirectional',
      })
    ).json()) as CalendarRuleDto;
    expect(rule).toMatchObject({ appleReadOnly: true, direction: 'one_way' });

    const patched = await api.request(`${rulesPath(profile)}/${rule.id}`, {
      method: 'PATCH',
      body: { direction: 'bidirectional' },
    });
    expect(await patched.json()).toMatchObject({ direction: 'one_way' });
  });

  it('updates window, reminders, direction and the active flag', async () => {
    const { api, profile } = await setup();
    const rule = (await (
      await createRule(api, profile, { appleCalendarUrl: '/cal/home/', googleCalendarId: 'primary' })
    ).json()) as CalendarRuleDto;

    const res = await api.request(`${rulesPath(profile)}/${rule.id}`, {
      method: 'PATCH',
      body: { syncWindowDays: null, syncReminders: true, enabled: false, direction: 'bidirectional' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: rule.id,
      syncWindowDays: null,
      syncReminders: true,
      enabled: false,
      direction: 'bidirectional',
    });
  });

  it('rejects invalid input, unknown or non-writable calendars, and duplicate pairs', async () => {
    const { api, profile } = await setup();
    const valid = { appleCalendarUrl: '/cal/home/', googleCalendarId: 'primary' };

    expect((await createRule(api, profile, { ...valid, direction: 'sideways' })).status).toBe(400);
    expect((await createRule(api, profile, { ...valid, syncWindowDays: 0 })).status).toBe(400);
    expect((await createRule(api, profile, { ...valid, syncWindowDays: 1.5 })).status).toBe(400);
    expect((await createRule(api, profile, { ...valid, syncReminders: 'yes' })).status).toBe(400);
    expect((await createRule(api, profile, { ...valid, appleCalendarUrl: '/cal/none/' })).status).toBe(400);
    expect((await createRule(api, profile, { ...valid, googleCalendarId: 'nope' })).status).toBe(400);
    expect((await createRule(api, profile, { ...valid, googleCalendarId: 'shared' })).status).toBe(400);

    expect((await createRule(api, profile, valid)).status).toBe(201);
    expect((await createRule(api, profile, valid)).status).toBe(409);
  });

  it('keeps rules isolated per Profile and answers 404 for unknown rules', async () => {
    const { api, profile } = await setup();
    const other = await api.createProfile('Ben');
    const rule = (await (
      await createRule(api, profile, { appleCalendarUrl: '/cal/home/', googleCalendarId: 'primary' })
    ).json()) as CalendarRuleDto;

    expect(await api.json<CalendarRuleDto[]>(rulesPath(other))).toEqual([]);
    const foreign = await api.request(`${rulesPath(other)}/${rule.id}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(foreign.status).toBe(404);
    const missing = await api.request(`${rulesPath(profile)}/nope`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(missing.status).toBe(404);
  });
});
