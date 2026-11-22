import { afterEach, describe, expect, it } from 'vitest';
import type { SyncLogDto } from '../../src/shared/logs.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from '../helpers/api.js';
import { HOME, setupCalendar } from '../helpers/calendar-scenario.js';
import { simpleIcs } from '../helpers/fixtures.js';

const DAY_MS = 86_400_000;
const ROW_CAP = 10_000;

describe('sync log retention', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  /** One synced event (an info line) and one failed event (an open error), both logged "now". */
  async function logged() {
    const s = await setupCalendar();
    close = () => s.ctx.close();
    s.world.putAppleEvent(APPLE_ID, HOME, 'a.ics', simpleIcs('uid-a', 'Alpha', 1));
    s.world.putAppleEvent(APPLE_ID, HOME, 'b.ics', simpleIcs('uid-b', 'Beta', 2));
    s.world.failGoogleWriteAfter(GOOGLE_REFRESH_TOKEN, 1, new Error('Google is down'));
    await s.sync();
    // Paused, so that the ticks below only prune and do not sync (and log) on their own
    await s.api.request(`/api/profiles/${s.profile.id}`, { method: 'PATCH', body: { enabled: false } });
    // A fresh sign-in per read: the session itself would expire over the simulated weeks
    const levels = async () => {
      const api = new TestApi(s.ctx, await s.ctx.signIn());
      return (await api.json<SyncLogDto[]>('/api/logs')).map((entry) => entry.level).sort();
    };
    const days = async (count: number) => {
      s.ctx.clock.advanceMs(count * DAY_MS);
      await s.ctx.realtime.tick();
      await s.ctx.realtime.settled();
    };
    const rowCount = (profileId: string) =>
      (s.ctx.dbContext.sqlite.prepare('SELECT count(*) AS n FROM sync_logs WHERE profile_id = ?').get(profileId) as { n: number }).n;
    /** Inserts `count` info lines for a Profile, all newer than anything logged so far. */
    const bulkInfos = (profileId: string, count: number) =>
      s.ctx.dbContext.sqlite
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO sync_logs (id, profile_id, entity_type, level, summary, message, created_at)
           SELECT 'bulk-' || ? || '-' || i, ?, 'calendar', 'info', 'Bulk ' || i, '', ? + i FROM n`,
        )
        .run(count, profileId, profileId, s.ctx.clock.now());
    return { ...s, levels, days, rowCount, bulkInfos };
  }

  it('removes info lines after 14 days and error lines after 30 days, driven by the Clock', async () => {
    const s = await logged();
    expect(await s.levels()).toEqual(['error', 'info']);
    await s.ctx.realtime.tick();

    await s.days(13);
    expect(await s.levels()).toEqual(['error', 'info']);

    await s.days(2);
    expect(await s.levels()).toEqual(['error']);

    await s.days(10);
    expect(await s.levels()).toEqual(['error']);

    await s.days(6);
    expect(await s.levels()).toEqual([]);
  });

  it('prunes once a day, not on every tick', async () => {
    const s = await logged();
    const hours = async (count: number) => {
      s.ctx.clock.advanceMs(count * 3_600_000);
      await s.ctx.realtime.tick();
    };
    await hours(13 * 24 + 12); // first pass: nothing is old enough yet
    expect(await s.levels()).toEqual(['error', 'info']);

    await hours(13); // the info line is now older than 14 days, but the last pass was only 13 hours ago
    expect(await s.levels()).toEqual(['error', 'info']);

    await hours(12); // a day after the last pass
    expect(await s.levels()).toEqual(['error']);
  });

  it('keeps at most 10,000 lines per Profile, dropping the oldest first and sparing open errors and other Profiles', async () => {
    const s = await logged();
    const ben = await s.api.createProfile('Ben');
    s.bulkInfos(s.profile.id, ROW_CAP + 5);
    s.bulkInfos(ben.id, 50);

    await s.ctx.realtime.tick();

    expect(s.rowCount(s.profile.id)).toBe(ROW_CAP);
    expect(s.rowCount(ben.id)).toBe(50);
    expect((await s.api.json<SyncLogDto[]>(`/api/logs?profileId=${s.profile.id}&unresolvedOnly=true`)).map((e) => e.level)).toEqual(['error']);
    const newest = await s.api.json<SyncLogDto[]>(`/api/logs?profileId=${s.profile.id}&limit=1`);
    expect(newest[0]!.summary).toBe(`Bulk ${ROW_CAP + 5}`);
  });
});
