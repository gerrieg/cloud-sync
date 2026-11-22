import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarRuleDto, SyncRunResult } from '../../src/shared/calendar.js';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from '../helpers/api.js';
import { simpleIcs } from '../helpers/fixtures.js';
import { createTestContext } from '../helpers/test-app.js';

const HOME = '/cal/home/';

describe('Delete Guard HTTP seam', () => {
  let api: TestApi | undefined;

  afterEach(() => {
    api?.ctx.close();
    api = undefined;
  });

  /** A synced calendar with `count` tracked events `Termin 1..count` (hrefs `e<i>.ics`). */
  async function setup(count: number, ruleOptions: Record<string, unknown> = {}) {
    const ctx = createTestContext();
    api = new TestApi(ctx, await ctx.signIn());
    const world = ctx.providers.calendars;
    world.addAppleCalendar(APPLE_ID, { url: HOME, name: 'Privat' });
    world.addGoogleCalendar(GOOGLE_REFRESH_TOKEN, { id: 'primary', name: 'Anna', primary: true });
    const profile = await api.createProfile('Anna');
    await api.connectAccounts(profile);
    const rule = await api.json<CalendarRuleDto>(`/api/profiles/${profile.id}/rules/calendars`, {
      method: 'POST',
      body: { appleCalendarUrl: HOME, googleCalendarId: 'primary', syncWindowDays: null, ...ruleOptions },
    });
    for (let i = 1; i <= count; i += 1) {
      world.putAppleEvent(APPLE_ID, HOME, `e${i}.ics`, simpleIcs(`uid-${i}`, `Termin ${i}`, (i % 28) + 1));
    }
    await sync(api, profile);
    return { api, world, profile, rule };
  }

  async function sync(api: TestApi, profile: ProfileDto, body: unknown = {}): Promise<SyncRunResult> {
    const res = await api.request(`/api/profiles/${profile.id}/sync`, { method: 'POST', body });
    return (await res.json()) as SyncRunResult;
  }

  const pending = (api: TestApi, profile: ProfileDto) =>
    api.json<DeleteApprovalDto[]>(`/api/profiles/${profile.id}/delete-approvals`);

  const googleSummaries = (world: ReturnType<typeof createTestContext>['providers']['calendars']) =>
    world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary').map((e) => e.summary);

  function deleteInApple(world: ReturnType<typeof createTestContext>['providers']['calendars'], from: number, to: number) {
    for (let i = from; i <= to; i += 1) {
      world.removeAppleEvent(APPLE_ID, HOME, `e${i}.ics`);
    }
  }

  describe('threshold', () => {
    it.each([
      { tracked: 60, deleted: 10, halts: false, why: 'exactly 10 items' },
      { tracked: 60, deleted: 11, halts: true, why: 'more than 10 items' },
      { tracked: 5, deleted: 1, halts: false, why: 'exactly 20% of tracked items' },
      { tracked: 4, deleted: 1, halts: true, why: 'more than 20% of tracked items' },
    ])('$why: halts = $halts', async ({ tracked, deleted, halts }) => {
      const { api, world, profile } = await setup(tracked);
      deleteInApple(world, 1, deleted);

      const result = await sync(api, profile);

      expect(result.rules[0].status).toBe('ok');
      expect(result.rules[0].deleteApprovalId !== undefined).toBe(halts);
      expect(googleSummaries(world)).toHaveLength(halts ? tracked : tracked - deleted);
      expect(await pending(api, profile)).toHaveLength(halts ? 1 : 0);
    });
  });

  describe('halt → inspect → approve / dismiss', () => {
    async function halted() {
      const ctx = await setup(6);
      deleteInApple(ctx.world, 1, 2);
      // A deletion batch is not the only thing in this run: an unrelated create must still go through
      ctx.world.putAppleEvent(APPLE_ID, HOME, 'neu.ics', simpleIcs('uid-neu', 'Neu', 20));
      const result = await sync(ctx.api, ctx.profile);
      const [approval] = await pending(ctx.api, ctx.profile);
      return { ...ctx, result, approval };
    }

    it('blocks the deletions, persists the batch and still applies everything else', async () => {
      const { api, world, rule, result, approval } = await halted();

      expect(result.rules[0].deleteApprovalId).toBe(approval.id);
      expect(result.rules[0].actions.filter((a) => a.action === 'skip' && a.reason === 'delete_guard')).toHaveLength(2);
      expect(result.rules[0].actions).toContainEqual(expect.objectContaining({ action: 'create', summary: 'Neu' }));
      expect(googleSummaries(world)).toEqual(expect.arrayContaining(['Termin 1', 'Termin 2', 'Neu']));

      expect(approval).toMatchObject({
        ruleId: rule.id,
        status: 'pending',
        items: [
          { uid: 'uid-1', summary: 'Termin 1', target: 'google' },
          { uid: 'uid-2', summary: 'Termin 2', target: 'google' },
        ],
      });
      const row = api.ctx.dbContext.sqlite.prepare('SELECT status FROM pending_delete_approvals').all();
      expect(row).toEqual([{ status: 'pending' }]);
    });

    it('does not queue the same batch twice when the run is repeated before the admin decides', async () => {
      const { api, profile } = await halted();

      await sync(api, profile, { force: true });
      await sync(api, profile, { force: true });

      expect(await pending(api, profile)).toHaveLength(1);
    });

    it('approve executes exactly the approved batch and marks it approved', async () => {
      const { api, world, profile, approval } = await halted();
      // Something else disappears from Apple after the batch was recorded
      world.removeAppleEvent(APPLE_ID, HOME, 'e3.ics');

      const res = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: approval.id, status: 'approved', label: 'Privat → Anna' });
      expect(googleSummaries(world)).not.toContain('Termin 1');
      expect(googleSummaries(world)).not.toContain('Termin 2');
      expect(googleSummaries(world)).toContain('Termin 3');
      expect(await pending(api, profile)).toEqual([]);

      // Approving twice must not run the batch again
      const again = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });
      expect(again.status).toBe(409);
    });

    it('dismiss marks the batch dismissed and deletes nothing', async () => {
      const { api, world, profile, approval } = await halted();
      const before = world.writes.length;

      const res = await api.request(`/api/delete-approvals/${approval.id}/dismiss`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: approval.id, status: 'dismissed' });
      expect(world.writes).toHaveLength(before);
      expect(googleSummaries(world)).toEqual(expect.arrayContaining(['Termin 1', 'Termin 2']));
      expect(await pending(api, profile)).toEqual([]);

      const approveLater = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });
      expect(approveLater.status).toBe(409);
      expect(googleSummaries(world)).toContain('Termin 1');
    });

    it('requires a session and an existing approval', async () => {
      const { api, approval } = await halted();

      const anonymous = await api.request(`/api/delete-approvals/${approval.id}/approve`, {
        method: 'POST',
        cookie: null,
      });
      expect(anonymous.status).toBe(401);
      expect((await api.request('/api/delete-approvals/unknown/approve', { method: 'POST' })).status).toBe(404);
      expect((await api.request('/api/delete-approvals/unknown/dismiss', { method: 'POST' })).status).toBe(404);
    });

    it('keeps the approval pending when executing it fails, so it can be retried', async () => {
      const { api, world, approval } = await halted();
      world.failNextGoogleWrite(GOOGLE_REFRESH_TOKEN, new Error('Google is down'));

      const failed = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });
      expect(failed.status).toBe(502);

      const retried = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });
      expect(retried.status).toBe(200);
      expect(googleSummaries(world)).not.toContain('Termin 1');
      expect(googleSummaries(world)).not.toContain('Termin 2');
    });
  });

  describe('Dry-Run', () => {
    it('shows the halted deletions but persists no approval', async () => {
      const { api, world, profile } = await setup(6);
      deleteInApple(world, 1, 3);

      const res = await api.request(`/api/profiles/${profile.id}/dry-run`, { method: 'POST', body: {} });
      const result = (await res.json()) as SyncRunResult;

      expect(result.rules[0].actions.filter((a) => a.reason === 'delete_guard')).toHaveLength(3);
      expect(result.rules[0].deleteApprovalId).toBeUndefined();
      expect(await pending(api, profile)).toEqual([]);
    });
  });

  describe('bidirectional rules', () => {
    it('halts a mass deletion made in Google before it reaches Apple, and executes it on approval', async () => {
      const { api, world, profile } = await setup(6, { direction: 'bidirectional' });
      for (const event of world.googleEvents(GOOGLE_REFRESH_TOKEN, 'primary').slice(0, 3)) {
        world.removeGoogleEvent(GOOGLE_REFRESH_TOKEN, 'primary', event.id);
      }

      const result = await sync(api, profile);

      expect(result.rules[0].actions.filter((a) => a.reason === 'delete_guard')).toHaveLength(3);
      for (const i of [1, 2, 3, 4, 5, 6]) {
        expect(world.appleCalendarObject(APPLE_ID, HOME, `e${i}.ics`)).toBeDefined();
      }
      const [approval] = await pending(api, profile);
      expect(approval.items.map((item) => item.target)).toEqual(['apple', 'apple', 'apple']);

      const res = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });

      expect(res.status).toBe(200);
      const remaining = [1, 2, 3, 4, 5, 6].filter((i) => world.appleCalendarObject(APPLE_ID, HOME, `e${i}.ics`));
      expect(remaining).toHaveLength(3);
      expect(world.appleWrites.filter((w) => w.kind === 'delete')).toHaveLength(3);
    });
  });
});
