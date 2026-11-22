import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseContext } from '../../src/server/db/index.js';
import { insertProfile } from '../../src/server/profiles/profile-store.js';
import { GoogleAuthError } from '../../src/server/providers/types.js';
import { listPendingApprovals, type GuardedDeletion } from '../../src/server/sync/delete-guard.js';
import { carryOutPlan, failedRun, ignoringNotFound, type PlanEntryOf } from '../../src/server/sync/run-plan.js';
import { listSyncLogs, SyncLog, type LoggedItem } from '../../src/server/sync/sync-log-store.js';
import { FakeClock } from '../helpers/test-app.js';

type Entry = PlanEntryOf<LoggedItem, GuardedDeletion> & { readonly ruleId?: string };

class MissingThing extends Error {}

describe('carryOutPlan', () => {
  let dbContext: DatabaseContext;
  let clock: FakeClock;
  let profileId: string;
  let log: SyncLog;
  let commits: number;

  beforeEach(() => {
    dbContext = createDatabase(':memory:');
    clock = new FakeClock();
    profileId = insertProfile(dbContext.db, 'Anna', Buffer.alloc(32)).id;
    log = new SyncLog(dbContext.db, clock, profileId, 'contact');
    commits = 0;
  });

  afterEach(() => dbContext.close());

  const change = (uid: string, apply?: () => Promise<void>): Entry => ({
    report: { action: 'update', uid, summary: uid },
    ...(apply ? { apply } : {}),
  });
  const removal = (uid: string, apply?: () => Promise<void>): Entry => ({
    report: { action: 'delete', uid, summary: uid },
    deletion: { uid, summary: uid, target: 'google' },
    ...(apply ? { apply } : {}),
  });

  function carryOut(entries: Entry[], overrides: { dryRun?: boolean; trackedItems?: number } = {}) {
    return carryOutPlan<Entry>({
      db: dbContext.db,
      clock,
      profileId,
      log,
      dryRun: overrides.dryRun ?? false,
      entries,
      trackedItems: overrides.trackedItems ?? 100,
      held: (entry, deletion): Entry => ({
        report: { action: 'skip', uid: deletion.uid, summary: deletion.summary, reason: 'delete_guard' },
        ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
      }),
      domain: 'contacts',
      approvalRuleId: null,
      recovered: [null],
      logRuleId: (entry) => entry.ruleId ?? null,
      commit: () => {
        commits += 1;
      },
    });
  }

  const logs = () => listSyncLogs(dbContext.db, { profileId });

  it('applies every entry, logs what was carried over and then commits', async () => {
    const applied: string[] = [];
    const outcome = await carryOut([
      change('a', async () => void applied.push('a')),
      change('b', async () => void applied.push('b')),
    ]);

    expect(outcome).toEqual({
      status: 'ok',
      actions: [
        { action: 'update', uid: 'a', summary: 'a' },
        { action: 'update', uid: 'b', summary: 'b' },
      ],
    });
    expect(applied).toEqual(['a', 'b']);
    expect(commits).toBe(1);
    expect(logs().map((row) => row.itemKey)).toEqual(['b', 'a']);
  });

  it('does not log a skip as carried over', async () => {
    const outcome = await carryOut([{ report: { action: 'skip', uid: 'a', summary: 'a', reason: 'unchanged' } }]);

    expect(outcome.status).toBe('ok');
    expect(outcome.actions).toHaveLength(1);
    expect(logs()).toEqual([]);
  });

  describe('a failing entry', () => {
    it('does not hold up the other entries, but keeps the cursor and reports the first failure', async () => {
      const applied: string[] = [];
      const outcome = await carryOut([
        change('a', async () => void applied.push('a')),
        change('b', async () => {
          throw new Error('Gmail said no');
        }),
        change('c', async () => {
          throw new Error('second failure');
        }),
        change('d', async () => void applied.push('d')),
      ]);

      expect(outcome.status).toBe('error');
      expect(outcome.error).toBe('Gmail said no');
      expect(outcome.actions.map((action) => action.uid)).toEqual(['a', 'd']);
      expect(applied).toEqual(['a', 'd']);
      expect(commits).toBe(0);
      expect(
        logs()
          .filter((row) => row.level === 'error')
          .map((row) => [row.itemKey, row.message])
          .sort(),
      ).toEqual([
        ['b', 'Gmail said no'],
        ['c', 'second failure'],
      ]);
    });

    it('is retried by the next run, which then closes the open error', async () => {
      await carryOut([
        change('a', async () => {
          throw new Error('boom');
        }),
      ]);
      expect(logs().filter((row) => row.level === 'error' && row.resolvedAt === null)).toHaveLength(1);

      const outcome = await carryOut([change('a', async () => undefined)]);

      expect(outcome.status).toBe('ok');
      expect(commits).toBe(1);
      expect(logs().filter((row) => row.level === 'error' && row.resolvedAt === null)).toHaveLength(0);
    });

    it('hands a Google auth error to the caller instead of recording it as an item failure', async () => {
      const run = carryOut([
        change('a', async () => {
          throw new GoogleAuthError('invalid_grant');
        }),
        change('b', async () => undefined),
      ]);

      await expect(run).rejects.toBeInstanceOf(GoogleAuthError);
      expect(commits).toBe(0);
      expect(logs().filter((row) => row.level === 'error')).toEqual([]);
    });
  });

  it('logs an item under the rule its entry names', async () => {
    await carryOut([{ ...change('a', async () => undefined), ruleId: 'rule-1' }]);

    expect(logs().map((row) => row.ruleId)).toEqual(['rule-1']);
  });

  it('closes the open run-wide errors once planning succeeded', async () => {
    log.runFailed(null, 'Contact sync', new Error('no listing'));
    expect(logs().filter((row) => row.resolvedAt === null)).toHaveLength(1);

    await carryOut([]);

    expect(logs().filter((row) => row.resolvedAt === null)).toEqual([]);
  });

  describe('Delete Guard', () => {
    it('lets deletions through below the threshold', async () => {
      const deleted: string[] = [];
      const outcome = await carryOut([removal('a', async () => void deleted.push('a')), change('b')], {
        trackedItems: 20,
      });

      expect(outcome.status).toBe('ok');
      expect(outcome.deleteApprovalId).toBeUndefined();
      expect(deleted).toEqual(['a']);
      expect(listPendingApprovals(dbContext.db, profileId)).toEqual([]);
    });

    it('holds back all deletions above the threshold, queues them and carries over the rest', async () => {
      const deleted: string[] = [];
      const updated: string[] = [];
      const entries = [
        ...Array.from({ length: 11 }, (_, i) => removal(`gone-${i}`, async () => void deleted.push(`gone-${i}`))),
        change('kept', async () => void updated.push('kept')),
      ];

      const outcome = await carryOut(entries, { trackedItems: 100 });

      expect(deleted).toEqual([]);
      expect(updated).toEqual(['kept']);
      expect(outcome.status).toBe('ok');
      expect(commits).toBe(1);
      expect(outcome.actions.filter((action) => action.reason === 'delete_guard')).toHaveLength(11);
      const [approval] = listPendingApprovals(dbContext.db, profileId);
      expect(outcome.deleteApprovalId).toBe(approval?.id);
      expect(approval?.domain).toBe('contacts');
      expect(JSON.parse(approval?.items ?? '[]')).toHaveLength(11);
    });

    it('queues the same halted batch only once when the run is repeated', async () => {
      const entries = () => Array.from({ length: 11 }, (_, i) => removal(`gone-${i}`));

      const first = await carryOut(entries());
      const second = await carryOut(entries());

      expect(second.deleteApprovalId).toBe(first.deleteApprovalId);
      expect(listPendingApprovals(dbContext.db, profileId)).toHaveLength(1);
    });

    it('still reports the approval when another entry failed', async () => {
      const outcome = await carryOut([
        ...Array.from({ length: 11 }, (_, i) => removal(`gone-${i}`)),
        change('broken', async () => {
          throw new Error('boom');
        }),
      ]);

      expect(outcome.status).toBe('error');
      expect(outcome.deleteApprovalId).toBeDefined();
      expect(commits).toBe(0);
    });
  });

  describe('dry run', () => {
    it('only reports: nothing is applied, logged, queued or committed', async () => {
      const applied: string[] = [];
      const outcome = await carryOut(
        [
          ...Array.from({ length: 11 }, (_, i) => removal(`gone-${i}`, async () => void applied.push('x'))),
          change('a', async () => void applied.push('a')),
        ],
        { dryRun: true },
      );

      expect(outcome.status).toBe('ok');
      expect(outcome.actions).toHaveLength(12);
      expect(outcome.actions.filter((action) => action.reason === 'delete_guard')).toHaveLength(11);
      expect(outcome.deleteApprovalId).toBeUndefined();
      expect(applied).toEqual([]);
      expect(commits).toBe(0);
      expect(logs()).toEqual([]);
      expect(listPendingApprovals(dbContext.db, profileId)).toEqual([]);
    });
  });
});

describe('failedRun', () => {
  let dbContext: DatabaseContext;
  let log: SyncLog;
  let profileId: string;

  beforeEach(() => {
    dbContext = createDatabase(':memory:');
    profileId = insertProfile(dbContext.db, 'Anna', Buffer.alloc(32)).id;
    log = new SyncLog(dbContext.db, new FakeClock(), profileId, 'email');
  });

  afterEach(() => dbContext.close());

  it('logs the failure of the run and returns its message', () => {
    const message = failedRun({ log, dryRun: false, ruleId: null, summary: 'Mail sync' }, new Error('IMAP down'));

    expect(message).toBe('IMAP down');
    expect(listSyncLogs(dbContext.db, { profileId }).map((row) => [row.level, row.summary, row.message])).toEqual([
      ['error', 'Mail sync', 'IMAP down'],
    ]);
  });

  it('logs the failure under the rule it concerns', () => {
    failedRun({ log, dryRun: false, ruleId: 'rule-1', summary: 'Privat → Anna' }, new Error('gone'));

    expect(listSyncLogs(dbContext.db, { profileId }).map((row) => row.ruleId)).toEqual(['rule-1']);
  });

  it('names a failure that is no Error "Sync failed"', () => {
    expect(failedRun({ log, dryRun: false, ruleId: null, summary: 'Mail sync' }, 'oops')).toBe('Sync failed');
  });

  it('does not log a dry run', () => {
    const message = failedRun({ log, dryRun: true, ruleId: null, summary: 'Mail sync' }, new Error('IMAP down'));

    expect(message).toBe('IMAP down');
    expect(listSyncLogs(dbContext.db, { profileId })).toEqual([]);
  });

  it('hands a Google auth error to the caller, logged nowhere', () => {
    expect(() =>
      failedRun({ log, dryRun: false, ruleId: null, summary: 'Mail sync' }, new GoogleAuthError('invalid_grant')),
    ).toThrow(GoogleAuthError);
    expect(listSyncLogs(dbContext.db, { profileId })).toEqual([]);
  });
});

describe('ignoringNotFound', () => {
  it('swallows only the given error', async () => {
    await expect(
      ignoringNotFound(MissingThing, async () => {
        throw new MissingThing('gone');
      }),
    ).resolves.toBeUndefined();
    await expect(
      ignoringNotFound(MissingThing, async () => {
        throw new Error('other');
      }),
    ).rejects.toThrow('other');
  });
});
