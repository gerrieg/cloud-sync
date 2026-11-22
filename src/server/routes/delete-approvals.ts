import { Hono } from 'hono';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { findProfile } from '../profiles/profile-store.js';
import type { SyncProvidersFactory } from '../providers/types.js';
import { approveBatch, dismissBatch } from '../sync/delete-approvals.js';
import { findApproval } from '../sync/delete-guard.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';

export interface DeleteApprovalRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

/** `/api/delete-approvals/:id/approve|dismiss`: the admin's decision on a halted deletion batch. */
export function createDeleteApprovalRoutes(deps: DeleteApprovalRouteDeps): Hono<ProfileEnv> {
  const { db, clock, locks } = deps;
  const withConnectedProviders = createConnectedProviders(deps);
  const routes = new Hono<ProfileEnv>();

  // Every route below acts for the Profile the approval belongs to
  routes.use('/:id/*', async (c, next) => {
    const approval = findApproval(db, c.req.param('id') ?? '');
    const profile = approval ? findProfile(db, approval.profileId) : undefined;
    if (!approval || !profile) {
      return c.json({ error: 'Delete approval not found' }, 404);
    }
    c.set('profile', profile);
    await next();
  });

  routes.post('/:id/approve', (c) =>
    withConnectedProviders(
      c,
      async (providers) => {
        const result = await approveBatch({ db, clock, providers }, c.req.param('id') ?? '');
        switch (result.status) {
          case 'approved':
            return c.json(result.approval, 200);
          case 'not_pending':
            return c.json({ error: 'This deletion batch is no longer pending' }, 409);
          case 'failed':
            return c.json({ error: 'Could not execute the deletions; the batch is still pending' }, 502);
        }
      },
      { exclusive: true },
    ),
  );

  routes.post('/:id/dismiss', (c) =>
    locks.run(c.get('profile').id, async () => {
      const dismissed = dismissBatch(db, clock, c.req.param('id') ?? '');
      return dismissed
        ? c.json(dismissed, 200)
        : c.json({ error: 'This deletion batch is no longer pending' }, 409);
    }),
  );

  return routes;
}
