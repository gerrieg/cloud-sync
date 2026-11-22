import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarRuleDto, SyncRunResult } from '../../src/shared/calendar.js';
import type { SyncLogDto } from '../../src/shared/logs.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN } from '../helpers/api.js';
import { HOME, setupCalendar } from '../helpers/calendar-scenario.js';
import { appleCard, G_FAMILIE, setupContacts } from '../helpers/contacts-scenario.js';
import { simpleIcs } from '../helpers/fixtures.js';
import { setupMail } from '../helpers/mail-scenario.js';

const WORK = '/cal/work/';

describe('retrying a Sync Rule from the Errors tab', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function failingCalendar() {
    const s = await setupCalendar();
    close = () => s.ctx.close();
    s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Alpha', 1));
    s.world.putAppleEvent(APPLE_ID, HOME, 'b.ics', simpleIcs('uid-b', 'Beta', 2));
    s.world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Google is down'));
    await s.sync();
    const open = () => s.api.json<SyncLogDto[]>('/api/logs?unresolvedOnly=true');
    const retry = (ruleId = s.rule.id) =>
      s.api.request(`/api/profiles/${s.profile.id}/rules/calendars/${ruleId}/retry`, { method: 'POST' });
    return { ...s, open, retry };
  }

  it('re-runs the rule and closes the errors of the items that now succeed', async () => {
    const s = await failingCalendar();
    const [error] = await s.open();
    expect(error).toMatchObject({ level: 'error', resolvedAt: null });
    expect(s.googleEvents()).toHaveLength(1);
    s.ctx.clock.advanceMinutes(10);

    const response = await s.retry();

    expect(response.status).toBe(200);
    expect(((await response.json()) as SyncRunResult).rules[0]).toMatchObject({ ruleId: s.rule.id, status: 'ok' });
    expect(s.googleEvents()).toHaveLength(2);
    expect(await s.open()).toEqual([]);
    const resolved = (await s.api.json<SyncLogDto[]>('/api/logs?level=error'))[0]!;
    expect(resolved).toMatchObject({ id: error!.id, resolvedAt: s.ctx.clock.now() });
  });

  it('keeps the error open, with the new message, while the item still fails', async () => {
    const s = await failingCalendar();
    s.world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Still down'));

    const response = await s.retry();

    expect(((await response.json()) as SyncRunResult).rules[0]).toMatchObject({ status: 'error' });
    expect(await s.open()).toMatchObject([{ message: 'Still down', resolvedAt: null }]);
  });

  it('runs only the affected rule, not the other rules of the Profile', async () => {
    const s = await failingCalendar();
    s.world.addAppleCalendar(APPLE_ID, { url: WORK, name: 'Arbeit' });
    s.world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'work', name: 'Arbeit', primary: false });
    const other = await s.api.json<CalendarRuleDto>(`/api/profiles/${s.profile.id}/rules/calendars`, {
      method: 'POST',
      body: { appleCalendarUrl: WORK, googleCalendarId: 'work' },
    });
    s.world.trace.length = 0;

    const result = (await (await s.retry()).json()) as SyncRunResult;

    expect(result.rules.map((rule) => rule.ruleId)).toEqual([s.rule.id]);
    expect(s.world.trace.filter((entry) => entry.includes(WORK) && entry.startsWith('apple.objects'))).toEqual([]);
    expect(other.id).not.toBe(s.rule.id);
  });

  it('is closed by an ordinary later sync as well', async () => {
    const s = await failingCalendar();

    await s.sync();

    expect(await s.open()).toEqual([]);
  });

  it('answers 404 for an unknown rule or a rule of another Profile, and 409 for a paused Profile', async () => {
    const s = await failingCalendar();
    const other = await s.api.createProfile('Ben');

    expect((await s.retry('no-such-rule')).status).toBe(404);
    expect(
      (await s.api.request(`/api/profiles/${other.id}/rules/calendars/${s.rule.id}/retry`, { method: 'POST' })).status,
    ).toBe(404);

    await s.api.request(`/api/profiles/${s.profile.id}`, { method: 'PATCH', body: { enabled: false } });
    expect((await s.retry()).status).toBe(409);
  });

  it('drops the open errors of a rule together with the rule', async () => {
    const s = await failingCalendar();

    await s.api.request(`/api/profiles/${s.profile.id}/rules/calendars/${s.rule.id}`, { method: 'DELETE' });

    expect(await s.open()).toEqual([]);
  });

  it('retries a contact rule, closing the error of the contact that now succeeds', async () => {
    const s = await setupContacts();
    close = () => s.ctx.close();
    const rule = await s.createRule('all', G_FAMILIE);
    s.world.putAppleVCard(s.appleId, 'p.vcf', appleCard('uid-p', 'Poison', 'Pill'));
    s.world.rejectGoogleWritesFor('Poison');
    await s.sync();
    expect(await s.api.json<SyncLogDto[]>('/api/logs?unresolvedOnly=true')).toHaveLength(1);

    s.world.clearWriteRejections();
    const response = await s.api.request(`/api/profiles/${s.profile.id}/rules/contacts/${rule.id}/retry`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(s.google()).toHaveLength(1);
    expect(await s.api.json<SyncLogDto[]>('/api/logs?unresolvedOnly=true')).toEqual([]);
  });

  it('retries a mail rule, closing the error of the message that now imports', async () => {
    const s = await setupMail();
    close = () => s.ctx.close();
    const rule = await s.createRule('INBOX');
    s.deliver('INBOX', 'Poison');
    s.world.rejectImportsContaining('Subject: Poison');
    await s.sync();
    expect(await s.api.json<SyncLogDto[]>('/api/logs?unresolvedOnly=true')).toHaveLength(1);

    s.world.clearImportRejections();
    const response = await s.api.request(`/api/profiles/${s.profile.id}/rules/mail/${rule.id}/retry`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(s.gmail()).toHaveLength(1);
    expect(await s.api.json<SyncLogDto[]>('/api/logs?unresolvedOnly=true')).toEqual([]);
  });

  it('does not close an error because the same event succeeded under another rule', async () => {
    const s = await setupCalendar();
    close = () => s.ctx.close();
    s.world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'second', name: 'Zweit', primary: false });
    await s.api.request(`/api/profiles/${s.profile.id}/rules/calendars`, {
      method: 'POST',
      body: { appleCalendarUrl: HOME, googleCalendarId: 'second' },
    });
    s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Alpha', 1));
    // The first rule's write fails, the second rule carries the same Apple event over
    s.world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Google is down'));

    await s.sync();

    const open = await s.api.json<SyncLogDto[]>('/api/logs?unresolvedOnly=true');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ ruleId: s.rule.id, itemKey: 'uid-a' });
    expect(s.world.googleEvents(GOOGLE_REFRESH_TOKEN, 'second')).toHaveLength(1);
  });
});
