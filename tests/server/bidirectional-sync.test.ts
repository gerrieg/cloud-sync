import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarRuleDto, SyncRunResult } from '../../src/shared/calendar.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from '../helpers/api.js';
import { icsFixture, simpleIcs } from '../helpers/fixtures.js';
import { createTestContext } from '../helpers/test-app.js';

const HOME = '/cal/home/';
const ZAHNARZT_HREF = 'zahnarzt.ics';
const ZAHNARZT_UID = '4F6C2B1A-0001-4B1E-9A11-AAAAAAAAAAAA';

describe('Bidirectional calendar sync (Apple Master) HTTP seam', () => {
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
      body: { appleCalendarUrl: HOME, googleCalendarId: 'primary', direction: 'bidirectional', ...ruleOptions },
    });
    return { api, world, profile, rule };
  }

  async function sync(api: TestApi, profile: ProfileDto): Promise<SyncRunResult> {
    const res = await api.request(`/api/profiles/${profile.id}/sync`, { method: 'POST', body: {} });
    return (await res.json()) as SyncRunResult;
  }

  const googleEvents = (world: ReturnType<typeof createTestContext>['providers']['calendars']) =>
    world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary');

  /** Syncs `count` Apple events so that single deletions stay below the Delete Guard threshold. */
  async function setupWithEvents(count: number) {
    const ctx = await setup();
    for (let i = 1; i <= count; i += 1) {
      ctx.world.putAppleEvent(APPLE_ID, HOME, `e${i}.ics`, simpleIcs(`uid-${i}`, `Termin ${i}`, i));
    }
    await sync(ctx.api, ctx.profile);
    return ctx;
  }

  describe('Google → Apple', () => {
    it('writes an uncontested Google edit back to Apple without touching Google, then settles', async () => {
      const { api, world, profile, rule } = await setup();
      world.putAppleEvent(APPLE_ID, HOME, ZAHNARZT_HREF, icsFixture('timed-berlin.ics'));
      await sync(api, profile);
      const googleId = googleEvents(world)[0].id;
      const googleWrites = world.writes.length;

      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', googleId, {
        summary: 'Zahnarzt (in Google verschoben)',
        location: 'Praxis Dr. Schulz',
        start: { dateTime: '2026-03-11T11:00:00+01:00', timeZone: 'Europe/Berlin' },
        end: { dateTime: '2026-03-11T12:00:00+01:00', timeZone: 'Europe/Berlin' },
      });
      const result = await sync(api, profile);

      expect(result.rules[0]).toMatchObject({ ruleId: rule.id, status: 'ok' });
      expect(result.rules[0].actions).toEqual([
        {
          action: 'update',
          ruleId: rule.id,
          uid: ZAHNARZT_UID,
          summary: 'Zahnarzt (in Google verschoben)',
          direction: 'google_to_apple',
        },
      ]);
      const apple = world.appleCalendarObject(APPLE_ID, HOME, ZAHNARZT_HREF)!;
      expect(apple.ics).toContain('SUMMARY:Zahnarzt (in Google verschoben)');
      expect(apple.ics).toContain('LOCATION:Praxis Dr. Schulz');
      expect(apple.ics).toContain('DTSTART:20260311T100000Z');
      expect(apple.ics).toContain('DTEND:20260311T110000Z');
      // What Apple already knew about the event is preserved
      expect(apple.ics).toContain('ORGANIZER');
      expect(apple.ics).toContain('BEGIN:VALARM');
      expect(world.appleWrites).toEqual([{ kind: 'put', href: ZAHNARZT_HREF }]);
      expect(world.writes).toHaveLength(googleWrites);

      // Our own write is no new change on either side
      const again = await sync(api, profile);
      expect(again.rules[0].actions.every((a) => a.action === 'skip')).toBe(true);
      expect(world.appleWrites).toHaveLength(1);
      expect(world.writes).toHaveLength(googleWrites);
    });

    it('imports an event created in Google into Apple and tracks it from then on', async () => {
      const { api, world, profile, rule } = await setupWithEvents(2);
      const created = world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: 'Neu in Google',
        start: { dateTime: '2026-03-15T14:00:00+01:00', timeZone: 'Europe/Berlin' },
        end: { dateTime: '2026-03-15T15:00:00+01:00', timeZone: 'Europe/Berlin' },
        iCalUID: 'ext-1@google.com',
      });
      const googleWrites = world.writes.length;

      const result = await sync(api, profile);

      expect(result.rules[0].actions).toEqual([
        ...[1, 2].map((i) => expect.objectContaining({ action: 'skip', summary: `Termin ${i}`, reason: 'unchanged' })),
        { action: 'create', ruleId: rule.id, uid: 'ext-1@google.com', summary: 'Neu in Google', direction: 'google_to_apple' },
      ]);
      const imported = world.appleCalendarObject(APPLE_ID, HOME, `${HOME}ext-1@google.com.ics`)!;
      expect(imported.ics).toContain('UID:ext-1@google.com');
      expect(imported.ics).toContain('SUMMARY:Neu in Google');
      expect(imported.ics).toContain('DTSTART:20260315T130000Z');
      expect(world.writes).toHaveLength(googleWrites);

      // Tracked now: no duplicate import, and a later Google edit is carried over
      await sync(api, profile);
      expect(world.appleWrites.filter((w) => w.kind === 'put')).toHaveLength(1);
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', created.id, { summary: 'Umbenannt' });
      await sync(api, profile);
      expect(world.appleCalendarObject(APPLE_ID, HOME, `${HOME}ext-1@google.com.ics`)!.ics).toContain(
        'SUMMARY:Umbenannt',
      );
    });

    it('deletes in Apple what was deleted in Google, without writing to Google', async () => {
      const { api, world, profile, rule } = await setupWithEvents(6);
      const doomed = googleEvents(world).find((e) => e.summary === 'Termin 3')!;
      const googleWrites = world.writes.length;
      world.removeGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', doomed.id);

      const result = await sync(api, profile);

      expect(result.rules[0].actions).toContainEqual({
        action: 'delete',
        ruleId: rule.id,
        uid: 'uid-3',
        summary: 'Termin 3',
        direction: 'google_to_apple',
      });
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e3.ics')).toBeUndefined();
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e4.ics')).toBeDefined();
      expect(world.writes).toHaveLength(googleWrites);

      // The deletion is final: nothing is re-created in Google
      await sync(api, profile);
      expect(googleEvents(world)).toHaveLength(5);
      expect(world.writes).toHaveLength(googleWrites);
    });
  });

  describe('Apple Master', () => {
    it('lets Apple overwrite Google when both sides edited the same event', async () => {
      const { api, world, profile, rule } = await setupWithEvents(2);
      const google = googleEvents(world).find((e) => e.summary === 'Termin 1')!;
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', google.id, { summary: 'Google-Version' });
      world.putAppleEvent(APPLE_ID, HOME, 'e1.ics', simpleIcs('uid-1', 'Apple-Version', 1));

      const result = await sync(api, profile);

      expect(result.rules[0].actions).toContainEqual({
        action: 'update',
        ruleId: rule.id,
        uid: 'uid-1',
        summary: 'Apple-Version',
        foreignInvitation: false,
        reason: 'apple_master',
      });
      expect(googleEvents(world).find((e) => e.id === google.id)?.summary).toBe('Apple-Version');
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e1.ics')!.ics).toContain('SUMMARY:Apple-Version');
      expect(world.appleWrites).toEqual([]);

      // Settled: the ETags were updated, so neither side is seen as changed again
      const writes = world.writes.length;
      const again = await sync(api, profile);
      expect(again.rules[0].actions.every((a) => a.action === 'skip')).toBe(true);
      expect(world.writes).toHaveLength(writes);
    });

    it('re-creates in Google an event that Google deleted while Apple edited it', async () => {
      const { api, world, profile } = await setupWithEvents(2);
      const google = googleEvents(world).find((e) => e.summary === 'Termin 2')!;
      world.removeGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', google.id);
      world.putAppleEvent(APPLE_ID, HOME, 'e2.ics', simpleIcs('uid-2', 'Termin 2 neu', 2));

      await sync(api, profile);

      expect(googleEvents(world).map((e) => e.summary)).toContain('Termin 2 neu');
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e2.ics')).toBeDefined();
      expect(world.appleWrites).toEqual([]);
    });

    it('deletes in Google what Apple deleted, even if Google edited it meanwhile', async () => {
      const { api, world, profile } = await setupWithEvents(6);
      const google = googleEvents(world).find((e) => e.summary === 'Termin 4')!;
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', google.id, { summary: 'Google-Edit' });
      world.removeAppleEvent(APPLE_ID, HOME, 'e4.ics');

      await sync(api, profile);

      expect(googleEvents(world).map((e) => e.id)).not.toContain(google.id);
      expect(world.appleWrites).toEqual([]);
    });
  });

  describe('Foreign invitations', () => {
    it('never writes Google edits or deletions of an invitation back to Apple', async () => {
      const { api, world, profile, rule } = await setupWithEvents(2);
      world.putAppleEvent(APPLE_ID, HOME, 'kickoff.ics', icsFixture('foreign-invitation.ics'));
      await sync(api, profile);
      const invite = googleEvents(world).find((e) => e.summary === 'Projekt-Kickoff')!;
      const original = world.appleCalendarObject(APPLE_ID, HOME, 'kickoff.ics')!;

      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', invite.id, { summary: 'Kickoff (Google)' });
      const edited = await sync(api, profile);
      expect(edited.rules[0].actions).toContainEqual(
        expect.objectContaining({ action: 'skip', reason: 'foreign_invitation', foreignInvitation: true }),
      );
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'kickoff.ics')).toEqual(original);

      world.removeGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', invite.id);
      const deleted = await sync(api, profile);
      expect(deleted.rules[0].actions.some((a) => a.action === 'delete')).toBe(false);
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'kickoff.ics')).toEqual(original);
      expect(world.appleWrites).toEqual([]);
      expect(rule.direction).toBe('bidirectional');
    });
  });

  describe('Google sync token', () => {
    it('recovers from HTTP 410 Gone with a full re-reconciliation, neither duplicating nor falsely deleting', async () => {
      const { api, world, profile } = await setupWithEvents(6);
      const edited = googleEvents(world).find((e) => e.summary === 'Termin 2')!;
      const removed = googleEvents(world).find((e) => e.summary === 'Termin 5')!;
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', edited.id, { summary: 'Termin 2 (Google)' });
      world.removeGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', removed.id);
      world.expireGoogleSyncTokens(GOOGLE_REFRESH_TOKEN, 'primary');
      const googleWrites = world.writes.length;
      world.trace.length = 0;

      const result = await sync(api, profile);

      expect(result.rules[0].status).toBe('ok');
      const reads = world.trace.filter((t) => t.startsWith('google.changes'));
      expect(reads).toHaveLength(2);
      expect(reads[0]).toMatch(/:st-\d+$/);
      expect(reads[1]).toMatch(/:full$/);
      // The edit and the deletion made before the token expired still arrive in Apple
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e2.ics')!.ics).toContain('SUMMARY:Termin 2 (Google)');
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e5.ics')).toBeUndefined();
      // Everything else is untouched: no duplicates, no false deletions, no Google writes
      for (const i of [1, 3, 4, 6]) {
        expect(world.appleCalendarObject(APPLE_ID, HOME, `e${i}.ics`)).toBeDefined();
      }
      expect(googleEvents(world)).toHaveLength(5);
      expect(world.writes).toHaveLength(googleWrites);

      // The fresh token from the full listing is used from now on
      world.trace.length = 0;
      await sync(api, profile);
      expect(world.trace.filter((t) => t.startsWith('google.changes'))).toEqual([
        expect.stringMatching(/:st-\d+$/),
      ]);
    });
  });

  describe('Idle polling', () => {
    it('does not list the Apple calendar while neither side has changed, and wakes up on a Google edit', async () => {
      const { api, world, profile } = await setupWithEvents(3);
      await sync(api, profile); // settles the echo of the first run's own Google writes
      world.trace.length = 0;

      const idle = await sync(api, profile);

      expect(idle.rules[0]).toMatchObject({ status: 'skipped', reason: 'unchanged', actions: [] });
      expect(world.trace.filter((t) => t.startsWith('apple.objects'))).toEqual([]);

      const edited = googleEvents(world).find((e) => e.summary === 'Termin 2')!;
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', edited.id, { summary: 'Termin 2 (Google)' });
      const woken = await sync(api, profile);

      expect(woken.rules[0].status).toBe('ok');
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e2.ics')!.ics).toContain('SUMMARY:Termin 2 (Google)');
    });
  });

  describe('Initial Sync', () => {
    it('imports unmatched Google events into Apple and links matched ones without duplicates', async () => {
      const ctx = await setup();
      const { api, world, profile } = ctx;
      const matched = world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: 'Bereits in Google',
        start: { dateTime: '2026-03-10T09:00:00Z' },
        end: { dateTime: '2026-03-10T10:00:00Z' },
        iCalUID: 'uid-1',
      });
      const googleOnly = world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: 'Nur in Google',
        start: { dateTime: '2026-03-16T09:00:00Z' },
        end: { dateTime: '2026-03-16T10:00:00Z' },
        iCalUID: 'google-only@google.com',
      });
      world.putAppleEvent(APPLE_ID, HOME, 'e1.ics', simpleIcs('uid-1', 'Termin 1', 10));
      world.putAppleEvent(APPLE_ID, HOME, 'e2.ics', simpleIcs('uid-2', 'Nur in Apple', 11));

      const result = await sync(api, profile);

      expect(result.rules[0].actions.map((a) => [a.action, a.summary, a.reason, a.direction])).toEqual([
        ['skip', 'Termin 1', 'matched_existing', undefined],
        ['create', 'Nur in Apple', undefined, undefined],
        ['create', 'Nur in Google', undefined, 'google_to_apple'],
      ]);
      expect(googleEvents(world).map((e) => e.summary).sort()).toEqual([
        'Bereits in Google',
        'Nur in Apple',
        'Nur in Google',
      ]);
      expect(googleEvents(world).map((e) => e.id)).toEqual(expect.arrayContaining([matched.id, googleOnly.id]));
      expect(world.appleCalendarObject(APPLE_ID, HOME, `${HOME}google-only@google.com.ics`)).toBeDefined();
      expect(world.writes).toHaveLength(1);

      // The linked event is tracked: nothing is imported or created twice
      await sync(api, profile);
      expect(world.writes).toHaveLength(1);
      expect(world.appleWrites).toHaveLength(1);
    });
  });

  describe('Safety nets', () => {
    it('links an Apple event outside the history window to its Google twin instead of importing a duplicate', async () => {
      const { api, world, profile } = await setup({ syncWindowDays: 30 });
      world.putAppleEvent(
        APPLE_ID,
        HOME,
        'alt.ics',
        simpleIcs('uid-alt', 'Alter Termin', 10).replaceAll('202603', '202506'),
      );
      world.seedGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', {
        summary: 'Alter Termin',
        start: { dateTime: '2025-06-10T09:00:00Z' },
        end: { dateTime: '2025-06-10T10:00:00Z' },
        iCalUID: 'uid-alt',
      });

      const result = await sync(api, profile);

      expect(result.rules[0].actions).toEqual([
        expect.objectContaining({ action: 'skip', summary: 'Alter Termin', reason: 'outside_window' }),
      ]);
      expect(world.appleWrites).toEqual([]);
      expect(googleEvents(world)).toHaveLength(1);
    });

    it('lets Apple win and carries on when Apple changes an event while Google edits are being written back', async () => {
      const { api, world, profile } = await setupWithEvents(3);
      const [first, second] = ['Termin 1', 'Termin 2'].map(
        (summary) => googleEvents(world).find((e) => e.summary === summary)!,
      );
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', first.id, { summary: 'Google-Edit 1' });
      world.editGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', second.id, { summary: 'Google-Edit 2' });
      world.changeAppleBeforeNextOverwrite(() =>
        world.putAppleEvent(APPLE_ID, HOME, 'e1.ics', simpleIcs('uid-1', 'Apple-Edit 1', 1)),
      );

      const result = await sync(api, profile);

      // The lost race does not abort the run: the other edit still arrives in Apple
      expect(result.rules[0].status).toBe('ok');
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e2.ics')!.ics).toContain('SUMMARY:Google-Edit 2');

      // Apple Master: the Apple edit is what ends up in Google
      await sync(api, profile);
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e1.ics')!.ics).toContain('SUMMARY:Apple-Edit 1');
      expect(googleEvents(world).find((e) => e.id === first.id)?.summary).toBe('Apple-Edit 1');
    });

    it('does not read events deleted in Google during a One-Way era as deletions when switching to bidirectional', async () => {
      const { api, world, profile, rule } = await setupWithEvents(0);
      for (let i = 1; i <= 6; i += 1) {
        world.putAppleEvent(APPLE_ID, HOME, `e${i}.ics`, simpleIcs(`uid-${i}`, `Termin ${i}`, i));
      }
      await api.request(`/api/profiles/${profile.id}/rules/calendars/${rule.id}`, {
        method: 'PATCH',
        body: { direction: 'one_way' },
      });
      await sync(api, profile);
      world.removeGoogleEvent(
        GOOGLE_REFRESH_TOKEN,
        'primary',
        googleEvents(world).find((e) => e.summary === 'Termin 2')!.id,
      );

      await api.request(`/api/profiles/${profile.id}/rules/calendars/${rule.id}`, {
        method: 'PATCH',
        body: { direction: 'bidirectional' },
      });
      const result = await sync(api, profile);

      expect(result.rules[0].actions.some((a) => a.action === 'delete')).toBe(false);
      expect(world.appleCalendarObject(APPLE_ID, HOME, 'e2.ics')).toBeDefined();
    });
  });
});
