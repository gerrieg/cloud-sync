import { Hono } from 'hono';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { findProfile } from '../profiles/profile-store.js';
import { GoogleAuthError, type SyncProvidersFactory } from '../providers/types.js';
import { executeCalendarDeletion, type CalendarDeletion } from '../sync/calendar-sync.js';
import {
  approvalItems,
  findApproval,
  resolveApproval,
  toApprovalDto,
} from '../sync/delete-guard.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { findRule } from '../sync/rules-store.js';
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
      async (providers, profile) => {
        const approval = findApproval(db, c.req.param('id') ?? '');
        const rule = approval ? findRule(db, profile.id, approval.ruleId) : undefined;
        if (!approval || approval.status !== 'pending' || !rule) {
          return c.json({ error: 'This deletion batch is no longer pending' }, 409);
        }
        try {
          // Exactly the batch that was recorded when the run was halted, nothing re-planned
          for (const item of approvalItems<CalendarDeletion>(approval)) {
            await executeCalendarDeletion({ db, providers, rule }, item);
          }
        } catch (error) {
          if (error instanceof GoogleAuthError) {
            throw error;
          }
          // Stays pending: items already done are skipped quietly when the admin retries
          return c.json({ error: 'Could not execute the deletions; the batch is still pending' }, 502);
        }
        const resolved = resolveApproval(db, approval.id, 'approved', clock.now());
        return c.json(toApprovalDto(resolved ?? approval), 200);
      },
      { exclusive: true },
    ),
  );

  routes.post('/:id/dismiss', (c) =>
    locks.run(c.get('profile').id, async () => {
      const resolved = resolveApproval(db, c.req.param('id') ?? '', 'dismissed', clock.now());
      return resolved
        ? c.json(toApprovalDto(resolved), 200)
        : c.json({ error: 'This deletion batch is no longer pending' }, 409);
    }),
  );

  return routes;
}
