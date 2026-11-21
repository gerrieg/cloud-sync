import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarRuleDto, SyncRunResult } from '../../src/shared/calendar.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from '../helpers/api.js';
import { icsFixture } from '../helpers/fixtures.js';
import { createTestContext } from '../helpers/test-app.js';

const HOME = '/cal/home/';
const ZAHNARZT_UID = '4F6C2B1A-0001-4B1E-9A11-AAAAAAAAAAAA';

describe('One-way calendar sync HTTP seam', () => {
  let api: TestApi | undefined;

  afterEach(() => {
    api?.ctx.close();
    api = undefined;
  });

  async function setup(ruleOptions: Record<string, unknown> = {}) {
    const ctx = createTestContext();
    api = new TestApi(ctx, await ctx.signIn());
    const world = ctx.providers.calendars;
    world.addAppleCalendar(APPLE_ID, { url: HOME, name: 'Privat' });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna', primary: true });
    const profile = await api.createProfile('Anna');
    await api.connectAccounts(profile);
    const rule = await api.json<CalendarRuleDto>(`/api/profiles/${profile.id}/rules/calendars`, {
      method: 'POST',
      body: { appleCalendarUrl: HOME, googleCalendarId: 'primary', ...ruleOptions },
    });
    return { api, world, profile, rule };
  }

  const sync = (api: TestApi, profile: ProfileDto, body: unknown = {}) =>
    api.request(`/api/profiles/${profile.id}/sync`, { method: 'POST', body });

  const googleEvents = (world: ReturnType<typeof createTestContext>['providers']['calendars']) =>
    world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary');

  it('creates Apple events in Google without notifying anyone, then idles while the ctag is unchanged', async () => {
    const { api, world, profile, rule } = await setup();
    world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
    world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));

    const res = await sync(api, profile);

    expect(res.status).toBe(200);
    const result = (await res.json()) as SyncRunResult;
    expect(result.dryRun).toBe(false);
    expect(result.rules).toEqual([
      {
        ruleId: rule.id,
        status: 'ok',
        actions: [
          { action: 'create', ruleId: rule.id, uid: ZAHNARZT_UID, summary: 'Zahnarzt', foreignInvitation: false },
          {
            action: 'create',
            ruleId: rule.id,
            uid: '4F6C2B1A-0002-4B1E-9A11-BBBBBBBBBBBB',
            summary: 'Geburtstag Oma',
            foreignInvitation: false,
          },
        ],
      },
    ]);
    expect(googleEvents(world).map((e) => e.summary)).toEqual(['Zahnarzt', 'Geburtstag Oma']);
    expect(world.writes).toHaveLength(2);
    expect(world.writes.every((w) => w.kind === 'insert' && w.sendUpdates === 'none')).toBe(true);

    const after = await api.json<ProfileDto>(`/api/profiles/${profile.id}`);
    expect(after).toMatchObject({ lastSyncAt: api.ctx.clock.now(), lastSyncStatus: 'ok' });

    // Nothing changed on Apple: ctag delta detection skips the rule without listing events
    const objectReads = world.trace.filter((t) => t.startsWith('apple.objects')).length;
    const again = (await (await sync(api, profile)).json()) as SyncRunResult;
    expect(again.rules[0]).toMatchObject({ status: 'skipped', reason: 'unchanged', actions: [] });
    expect(world.trace.filter((t) => t.startsWith('apple.objects'))).toHaveLength(objectReads);
    expect(world.writes).toHaveLength(2);
  });

  it('pushes Apple updates and deletions to Google', async () => {
    const { api, world, profile, rule } = await setup();
    const original = icsFixture('timed-berlin.ics');
    world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', original);
    world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));
    await sync(api, profile);
    const zahnarztId = googleEvents(world).find((e) => e.summary === 'Zahnarzt')!.id;

    world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', original.replace('SUMMARY:Zahnarzt', 'SUMMARY:Zahnarzt (verlegt)'));
    world.removeAppleEvent(APPLE_ID, HOME, 'geburtstag.ics');
    const result = (await (await sync(api, profile)).json()) as SyncRunResult;

    expect(result.rules[0].actions).toEqual([
      { action: 'update', ruleId: rule.id, uid: ZAHNARZT_UID, summary: 'Zahnarzt (verlegt)', foreignInvitation: false },
      { action: 'delete', ruleId: rule.id, uid: '4F6C2B1A-0002-4B1E-9A11-BBBBBBBBBBBB', summary: 'Geburtstag Oma' },
    ]);
    const events = googleEvents(world);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: zahnarztId, summary: 'Zahnarzt (verlegt)' });
    expect(world.writes.slice(2).every((w) => w.sendUpdates === 'none')).toBe(true);
  });

  it('refuses to sync a paused Profile and requires connected accounts', async () => {
    const { api, profile } = await setup();
    await api.request(`/api/profiles/${profile.id}`, { method: 'PATCH', body: { enabled: false } });
    expect((await sync(api, profile)).status).toBe(409);

    const unconnected = await api.createProfile('Ben');
    expect((await sync(api, unconnected)).status).toBe(409);
  });

  describe('Dry-Run', () => {
    function snapshotOfState(api: TestApi) {
      const sqlite = api.ctx.dbContext.sqlite;
      return JSON.stringify({
        profiles: sqlite.prepare('SELECT * FROM profiles').all(),
        rules: sqlite.prepare('SELECT * FROM calendar_sync_rules').all(),
        events: sqlite.prepare('SELECT * FROM synced_events').all(),
      });
    }

    it('previews create/update/delete/skip without writing to Google or to SQLite cursors and ETags', async () => {
      const { api, world, profile, rule } = await setup();
      const original = icsFixture('timed-berlin.ics');
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', original);
      world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));
      world.putAppleEvent(APPLE_ID, HOME, 'kurs.ics', icsFixture('recurring-count.ics'));
      await sync(api, profile);

      api.ctx.clock.advanceMinutes(5);
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', original.replace('SUMMARY:Zahnarzt', 'SUMMARY:Zahnarzt neu'));
      world.removeAppleEvent(APPLE_ID, HOME, 'geburtstag.ics');
      world.putAppleEvent(APPLE_ID, HOME, 'call.ics', icsFixture('utc.ics'));
      const stateBefore = snapshotOfState(api);
      const writesBefore = world.writes.length;
      const googleBefore = JSON.stringify(googleEvents(world));

      const res = await api.request(`/api/profiles/${profile.id}/dry-run`, { method: 'POST', body: {} });

      expect(res.status).toBe(200);
      const result = (await res.json()) as SyncRunResult;
      expect(result.dryRun).toBe(true);
      expect(result.rules[0].actions.map((a) => [a.action, a.summary, a.reason])).toEqual([
        ['update', 'Zahnarzt neu', undefined],
        ['skip', 'Kurs', 'unchanged'],
        ['create', 'Call mit Team', undefined],
        ['delete', 'Geburtstag Oma', undefined],
      ]);
      expect(world.writes).toHaveLength(writesBefore);
      expect(JSON.stringify(googleEvents(world))).toBe(googleBefore);
      expect(snapshotOfState(api)).toBe(stateBefore);

      // The real run does exactly what the preview announced
      const real = (await (await sync(api, profile)).json()) as SyncRunResult;
      expect(real.rules[0].actions).toEqual(
        result.rules[0].actions.map((action) => ({ ...action, ruleId: rule.id })),
      );
    });

    it('leaves a never-synced rule uninitialized and works for paused Profiles', async () => {
      const { api, world, profile } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      await api.request(`/api/profiles/${profile.id}`, { method: 'PATCH', body: { enabled: false } });
      const stateBefore = snapshotOfState(api);

      const res = await api.request(`/api/profiles/${profile.id}/dry-run`, { method: 'POST', body: {} });

      expect(res.status).toBe(200);
      expect(((await res.json()) as SyncRunResult).rules[0].actions).toHaveLength(1);
      expect(world.writes).toHaveLength(0);
      expect(snapshotOfState(api)).toBe(stateBefore);
    });
  });

  describe('Initial Sync matching', () => {
    it('adopts pre-existing Google events by iCal UID or by normalized title + start, and never deletes unmatched ones', async () => {
      const { api, world, profile } = await setup();
      const byUid = world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: 'Anderer Titel',
        start: { dateTime: '2026-03-10T09:00:00Z' },
        end: { dateTime: '2026-03-10T10:00:00Z' },
        iCalUID: ZAHNARZT_UID,
      });
      const byTitle = world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: '  GEBURTSTAG   oma ',
        start: { date: '2026-03-20' },
        end: { date: '2026-03-21' },
      });
      const unrelated = world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: 'Privater Termin ohne Apple-Pendant',
        start: { dateTime: '2026-05-01T10:00:00Z' },
        end: { dateTime: '2026-05-01T11:00:00Z' },
      });
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));
      world.putAppleEvent(APPLE_ID, HOME, 'call.ics', icsFixture('utc.ics'));

      const result = (await (await sync(api, profile)).json()) as SyncRunResult;

      expect(result.rules[0].actions.map((a) => [a.action, a.summary, a.reason])).toEqual([
        ['skip', 'Zahnarzt', 'matched_existing'],
        ['skip', 'Geburtstag Oma', 'matched_existing'],
        ['create', 'Call mit Team', undefined],
      ]);
      // Only the genuinely new event was written; nothing was duplicated or deleted
      expect(world.writes.map((w) => w.kind)).toEqual(['insert']);
      const ids = googleEvents(world).map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([byUid.id, byTitle.id, unrelated.id]));
      expect(ids).toHaveLength(4);

      // Adopted events are tracked from now on: an Apple change updates them in place
      const changed = icsFixture('timed-berlin.ics').replace('SUMMARY:Zahnarzt', 'SUMMARY:Zahnarzt 2');
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', changed);
      await sync(api, profile);
      expect(googleEvents(world).find((e) => e.id === byUid.id)?.summary).toBe('Zahnarzt 2');

      // ...and removing it on Apple removes the tracked Google event, but still not the unrelated one
      world.removeAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics');
      await sync(api, profile);
      expect(googleEvents(world).map((e) => e.id)).toContain(unrelated.id);
      expect(googleEvents(world).map((e) => e.id)).not.toContain(byUid.id);
    });
  });

  describe('Recurring series', () => {
    const SERIES = 'teamrunde.ics';
    const withoutOverride = (ics: string) =>
      `${ics.slice(0, ics.indexOf('BEGIN:VEVENT', ics.indexOf('BEGIN:VEVENT') + 1))}END:VCALENDAR\r\n`;

    it('pushes RRULE/EXDATE on the master and RECURRENCE-ID overrides as exceptions', async () => {
      const { api, world, profile } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, SERIES, icsFixture('recurring-with-exception.ics'));

      await sync(api, profile);

      const [master, exception] = googleEvents(world);
      expect(master).toMatchObject({
        summary: 'Teamrunde',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=Europe/Berlin:20260317T100000'],
      });
      expect(exception).toMatchObject({
        summary: 'Teamrunde (verschoben)',
        recurringEventId: master.id,
        originalStartTime: { dateTime: '2026-03-24T10:00:00', timeZone: 'Europe/Berlin' },
        start: { dateTime: '2026-03-24T14:00:00', timeZone: 'Europe/Berlin' },
      });
    });

    it('updates series and overrides in place, but rebuilds the series when an override disappears', async () => {
      const { api, world, profile } = await setup();
      const original = icsFixture('recurring-with-exception.ics');
      world.putAppleEvent(APPLE_ID, HOME, SERIES, original);
      await sync(api, profile);
      const [master, exception] = googleEvents(world);

      world.putAppleEvent(APPLE_ID, HOME, SERIES, original.replace('SUMMARY:Teamrunde\r', 'SUMMARY:Teamrunde neu\r'));
      await sync(api, profile);
      const afterRename = googleEvents(world);
      expect(afterRename.map((e) => e.id)).toEqual([master.id, exception.id]);
      expect(afterRename[0].summary).toBe('Teamrunde neu');

      world.putAppleEvent(APPLE_ID, HOME, SERIES, withoutOverride(original));
      await sync(api, profile);
      const afterRevert = googleEvents(world);
      expect(afterRevert).toHaveLength(1);
      expect(afterRevert[0].id).not.toBe(master.id);
      expect(afterRevert[0].summary).toBe('Teamrunde');
      expect(world.writes.every((w) => w.sendUpdates === 'none')).toBe(true);
    });
  });

  describe('Rule options', () => {
    it('leaves reminders off by default and carries them over after opt-in plus Force-Resync', async () => {
      const { api, world, profile, rule } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      await sync(api, profile);
      expect(googleEvents(world)[0].reminders).toEqual({ useDefault: false, overrides: [] });

      await api.request(`/api/profiles/${profile.id}/rules/calendars/${rule.id}`, {
        method: 'PATCH',
        body: { syncReminders: true },
      });
      await sync(api, profile, { force: true });

      expect(googleEvents(world)[0].reminders).toEqual({
        useDefault: false,
        overrides: [{ method: 'popup', minutes: 15 }],
      });
    });

    it('syncs only the configured history window, or everything when set to All', async () => {
      const { api, world, profile, rule } = await setup();
      const past = icsFixture('timed-berlin.ics').replaceAll('20260310', '20251101');
      world.putAppleEvent(APPLE_ID, HOME, 'alt.ics', past);
      world.putAppleEvent(APPLE_ID, HOME, 'serie.ics', icsFixture('recurring-with-exception.ics'));

      const first = (await (await sync(api, profile)).json()) as SyncRunResult;
      expect(first.rules[0].actions.map((a) => [a.action, a.summary, a.reason])).toEqual([
        ['skip', 'Zahnarzt', 'outside_window'],
        ['create', 'Teamrunde', undefined],
      ]);

      await api.request(`/api/profiles/${profile.id}/rules/calendars/${rule.id}`, {
        method: 'PATCH',
        body: { syncWindowDays: null },
      });
      // Widening the window takes effect on the next plain run, without a Force-Resync
      const second = (await (await sync(api, profile)).json()) as SyncRunResult;
      expect(second.rules[0].actions.find((a) => a.summary === 'Zahnarzt')).toMatchObject({
        action: 'create',
      });
    });

    it('does not process paused rules', async () => {
      const { api, world, profile, rule } = await setup({ enabled: false });
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));

      const result = (await (await sync(api, profile)).json()) as SyncRunResult;

      expect(result.rules).toEqual([{ ruleId: rule.id, status: 'skipped', reason: 'paused', actions: [] }]);
      expect(world.writes).toHaveLength(0);
    });
  });

  it('flags invitations organized by someone else', async () => {
    const { api, world, profile } = await setup();
    world.putAppleEvent(APPLE_ID, HOME, 'kickoff.ics', icsFixture('foreign-invitation.ics'));
    world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));

    const result = (await (await sync(api, profile)).json()) as SyncRunResult;

    expect(result.rules[0].actions.map((a) => [a.summary, a.foreignInvitation])).toEqual([
      ['Projekt-Kickoff', true],
      ['Zahnarzt', false],
    ]);
  });

  describe('One-Way drift immunity and Force-Resync', () => {
    async function syncedPair() {
      const ctx = await setup();
      ctx.world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      ctx.world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));
      await sync(ctx.api, ctx.profile);
      const events = googleEvents(ctx.world);
      const zahnarzt = events.find((e) => e.summary === 'Zahnarzt')!;
      const geburtstag = events.find((e) => e.summary === 'Geburtstag Oma')!;
      ctx.world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', zahnarzt.id, { summary: 'Von Hand geändert' });
      ctx.world.removeGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', geburtstag.id);
      return { ...ctx, zahnarzt, geburtstag };
    }

    it('ignores manual edits and deletions in Google while Apple is unchanged', async () => {
      const { api, world, profile } = await syncedPair();
      const writes = world.writes.length;

      const result = (await (await sync(api, profile)).json()) as SyncRunResult;

      expect(result.rules[0]).toMatchObject({ status: 'skipped', reason: 'unchanged' });
      expect(world.writes).toHaveLength(writes);
      expect(googleEvents(world).map((e) => e.summary)).toEqual(['Von Hand geändert']);
    });

    it('overwrites a manual edit and recreates a manually deleted event once Apple changes it', async () => {
      const { api, world, profile, zahnarzt } = await syncedPair();
      world.putAppleEvent(
        APPLE_ID,
        HOME,
        'geburtstag.ics',
        icsFixture('all-day.ics').replace('Geburtstag Oma', 'Geburtstag Oma (80)'),
      );
      world.putAppleEvent(
        APPLE_ID,
        HOME,
        'zahnarzt.ics',
        icsFixture('timed-berlin.ics').replace('Kontrolle', 'Kontrolle und'),
      );

      await sync(api, profile);

      const events = googleEvents(world);
      expect(events.map((e) => e.summary).sort()).toEqual(['Geburtstag Oma (80)', 'Zahnarzt']);
      expect(events.find((e) => e.id === zahnarzt.id)).toBeDefined();
    });

    it('Force-Resync restores everything from Apple even though nothing changed there', async () => {
      const { api, world, profile } = await syncedPair();

      const result = (await (await sync(api, profile, { force: true })).json()) as SyncRunResult;

      expect(result.rules[0].actions.map((a) => a.action)).toEqual(['update', 'update']);
      expect(googleEvents(world).map((e) => e.summary).sort()).toEqual(['Geburtstag Oma', 'Zahnarzt']);
    });
  });

  describe('Failures', () => {
    it('reports a failing rule, keeps the cursor back and recovers on the next run without duplicates', async () => {
      const { api, world, profile, rule } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));
      world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Google is down'));

      const failed = (await (await sync(api, profile)).json()) as SyncRunResult;

      expect(failed.rules[0]).toMatchObject({ ruleId: rule.id, status: 'error', error: 'Google is down' });
      expect(await api.json<ProfileDto>(`/api/profiles/${profile.id}`)).toMatchObject({
        lastSyncStatus: 'error',
      });

      const recovered = (await (await sync(api, profile)).json()) as SyncRunResult;
      expect(recovered.rules[0].status).toBe('ok');
      expect(googleEvents(world)).toHaveLength(2);
    });

    it('reports the work that was applied before a failure and then completes without duplicates', async () => {
      const { api, world, profile, rule } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));
      world.failGoogleWriteAfter(GOOGLE_REFRESH_TOKEN, 1, new Error('Google is down'));

      const failed = (await (await sync(api, profile)).json()) as SyncRunResult;

      expect(failed.rules[0]).toMatchObject({ status: 'error', error: 'Google is down' });
      expect(failed.rules[0].actions).toEqual([
        { action: 'create', ruleId: rule.id, uid: ZAHNARZT_UID, summary: 'Zahnarzt', foreignInvitation: false },
      ]);

      await sync(api, profile);
      expect(googleEvents(world).map((e) => e.summary).sort()).toEqual(['Geburtstag Oma', 'Zahnarzt']);
    });

    it('does not orphan the master event when writing a series fails halfway', async () => {
      const { api, world, profile } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, 'teamrunde.ics', icsFixture('recurring-with-exception.ics'));
      // The master is written, then the overridden occurrence fails
      world.failGoogleWriteAfter(GOOGLE_REFRESH_TOKEN, 1, new Error('Google is down'));

      const failed = (await (await sync(api, profile)).json()) as SyncRunResult;
      expect(failed.rules[0].status).toBe('error');
      const [master] = googleEvents(world);
      expect(googleEvents(world)).toHaveLength(1);

      const recovered = (await (await sync(api, profile)).json()) as SyncRunResult;

      expect(recovered.rules[0].status).toBe('ok');
      const events = googleEvents(world);
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe(master.id);
      expect(events[1]).toMatchObject({ recurringEventId: master.id });
    });

    it('flags the Profile for re-authentication when Google revoked access', async () => {
      const { api, world, profile } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      world.rejectGoogleWithInvalidGrant(GOOGLE_REFRESH_TOKEN);

      const res = await sync(api, profile);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reauthRequired: true });
      expect(await api.json<ProfileDto>(`/api/profiles/${profile.id}`)).toMatchObject({
        googleReauthRequired: true,
      });
    });
  });

  describe('Deleting a rule', () => {
    const rulesPath = (profile: ProfileDto) => `/api/profiles/${profile.id}/rules/calendars`;

    async function syncedRule() {
      const ctx = await setup();
      ctx.world.putAppleEvent(APPLE_ID, HOME, 'teamrunde.ics', icsFixture('recurring-with-exception.ics'));
      ctx.world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      const unrelated = ctx.world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: 'Gehört nur Google',
        start: { dateTime: '2026-05-01T10:00:00Z' },
        end: { dateTime: '2026-05-01T11:00:00Z' },
      });
      await sync(ctx.api, ctx.profile);
      const syncedRows = () =>
        ctx.api.ctx.dbContext.sqlite.prepare('SELECT COUNT(*) AS n FROM synced_events').get() as { n: number };
      return { ...ctx, unrelated, syncedRows };
    }

    it('keeps the synced Google events by default and lets a re-created rule adopt them again', async () => {
      const { api, world, profile, rule, syncedRows } = await syncedRule();
      const before = googleEvents(world).map((e) => e.id);
      const writes = world.writes.length;

      const res = await api.request(`${rulesPath(profile)}/${rule.id}`, { method: 'DELETE' });

      expect(res.status).toBe(204);
      expect(await api.json<CalendarRuleDto[]>(rulesPath(profile))).toEqual([]);
      expect(syncedRows().n).toBe(0);
      expect(world.writes).toHaveLength(writes);
      expect(googleEvents(world).map((e) => e.id)).toEqual(before);

      const again = await api.json<CalendarRuleDto>(rulesPath(profile), {
        method: 'POST',
        body: { appleCalendarUrl: HOME, googleCalendarId: 'primary' },
      });
      const result = (await (await sync(api, profile)).json()) as SyncRunResult;
      expect(result.rules[0].ruleId).toBe(again.id);
      expect(result.rules[0].actions.every((a) => a.reason === 'matched_existing')).toBe(true);
      expect(googleEvents(world)).toHaveLength(before.length);
    });

    it('with the cleanup opt-in removes exactly the tracked Google events (series and overrides) first', async () => {
      const { api, world, profile, rule, unrelated, syncedRows } = await syncedRule();
      expect(googleEvents(world)).toHaveLength(4);

      const res = await api.request(`${rulesPath(profile)}/${rule.id}?cleanupGoogle=true`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(204);
      expect(googleEvents(world).map((e) => e.id)).toEqual([unrelated.id]);
      expect(world.writes.filter((w) => w.kind === 'delete').every((w) => w.sendUpdates === 'none')).toBe(true);
      expect(await api.json<CalendarRuleDto[]>(rulesPath(profile))).toEqual([]);
      expect(syncedRows().n).toBe(0);
    });

    it('tolerates events already deleted by hand during cleanup', async () => {
      const { api, world, profile, rule } = await syncedRule();
      const zahnarzt = googleEvents(world).find((e) => e.summary === 'Zahnarzt')!;
      world.removeGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', zahnarzt.id);

      const res = await api.request(`${rulesPath(profile)}/${rule.id}?cleanupGoogle=true`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(204);
    });

    it('keeps the rule when the cleanup fails, so nothing is orphaned', async () => {
      const { api, world, profile, rule, syncedRows } = await syncedRule();
      world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Google is down'));

      const failed = await api.request(`${rulesPath(profile)}/${rule.id}?cleanupGoogle=true`, {
        method: 'DELETE',
      });

      expect(failed.status).toBe(502);
      expect(await api.json<CalendarRuleDto[]>(rulesPath(profile))).toHaveLength(1);
      expect(syncedRows().n).toBeGreaterThan(0);

      const retry = await api.request(`${rulesPath(profile)}/${rule.id}?cleanupGoogle=true`, {
        method: 'DELETE',
      });
      expect(retry.status).toBe(204);
    });

    it('rejects an invalid cleanup flag and unknown or foreign rules', async () => {
      const { api, profile, rule } = await syncedRule();
      const other = await api.createProfile('Ben');

      expect((await api.request(`${rulesPath(profile)}/${rule.id}?cleanupGoogle=maybe`, { method: 'DELETE' })).status).toBe(400);
      expect((await api.request(`${rulesPath(other)}/${rule.id}`, { method: 'DELETE' })).status).toBe(404);
      expect((await api.request(`${rulesPath(profile)}/nope`, { method: 'DELETE' })).status).toBe(404);
      expect(await api.json<CalendarRuleDto[]>(rulesPath(profile))).toHaveLength(1);
    });
  });

  describe('Per-Profile mutex', () => {
    it('serializes concurrent runs of one Profile while other Profiles run independently', async () => {
      const { api, world, profile: anna } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, 'zahnarzt.ics', icsFixture('timed-berlin.ics'));
      world.putAppleEvent(APPLE_ID, HOME, 'geburtstag.ics', icsFixture('all-day.ics'));

      const BEN_APPLE = 'ben@icloud.com';
      const BEN_TOKEN = 'ben-refresh-token';
      world.addAppleCalendar(BEN_APPLE, { url: HOME, name: 'Privat' });
      world.addGoogleCalendar(BEN_TOKEN, { id: 'primary', name: 'Ben', primary: true });
      world.putAppleEvent(BEN_APPLE, HOME, 'call.ics', icsFixture('utc.ics'));
      const ben = await api.createProfile('Ben');
      await api.connectAccounts(ben, { appleId: BEN_APPLE, googleRefreshToken: BEN_TOKEN });
      await api.request(`/api/profiles/${ben.id}/rules/calendars`, {
        method: 'POST',
        body: { appleCalendarUrl: HOME, googleCalendarId: 'primary' },
      });

      // Every sync run starts by listing the Apple calendars, so these calls mark when a run began
      const annaRunsStarted = () => world.trace.filter((t) => t === `apple.list:${APPLE_ID}`).length;
      const baseline = annaRunsStarted();

      const gate = world.holdGoogleWrites(GOOGLE_REFRESH_TOKEN);
      const annaFirst = sync(api, anna);
      await vi.waitFor(() => expect(annaRunsStarted()).toBe(baseline + 1));
      const annaSecond = sync(api, anna);

      // Ben is not blocked by Anna's stalled run
      const benResult = (await (await sync(api, ben)).json()) as SyncRunResult;
      expect(benResult.rules[0].status).toBe('ok');
      expect(world.googleEvents(BEN_TOKEN, 'primary')).toHaveLength(1);

      // Anna's second run has not even started while her first one is still running
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(annaRunsStarted()).toBe(baseline + 1);

      gate.release();
      const first = (await (await annaFirst).json()) as SyncRunResult;
      const second = (await (await annaSecond).json()) as SyncRunResult;

      expect(first.rules[0].actions.map((a) => a.action)).toEqual(['create', 'create']);
      // Serialized: the second run saw the finished first run (no duplicate creates)
      expect(second.rules[0]).toMatchObject({ status: 'skipped', reason: 'unchanged' });
      expect(googleEvents(world)).toHaveLength(2);
      expect(annaRunsStarted()).toBe(baseline + 2);
    });
  });
});
