import type { CalendarRuleDto, SyncRunResult } from '../../src/shared/calendar.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from './api.js';
import { createTestContext } from './test-app.js';

export const HOME = '/cal/home/';

/** A connected Profile "Anna" with one calendar rule Privat → Anna. */
export async function setupCalendar(ruleOptions: Record<string, unknown> = {}, profileName = 'Anna') {
  const ctx = createTestContext();
  const api = new TestApi(ctx, await ctx.signIn());
  const world = ctx.providers.calendars;
  world.addAppleCalendar(APPLE_ID, { url: HOME, name: 'Privat' });
  world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna', primary: true });
  const profile = (await api.createProfile(profileName)) as ProfileDto;
  await api.connectAccounts(profile);
  const rule = await api.json<CalendarRuleDto>(`/api/profiles/${profile.id}/rules/calendars`, {
    method: 'POST',
    body: { appleCalendarUrl: HOME, googleCalendarId: 'primary', ...ruleOptions },
  });
  const sync = async (body: unknown = { domain: 'calendars' }) =>
    (await (await api.request(`/api/profiles/${profile.id}/sync`, { method: 'POST', body })).json()) as SyncRunResult;
  const googleEvents = () => world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary');
  return { ctx, api, world, profile, rule, sync, googleEvents };
}
