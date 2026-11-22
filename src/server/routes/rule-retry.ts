import { Hono } from 'hono';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import type { SyncProvidersFactory } from '../providers/types.js';
import { findContactRule } from '../sync/contact-rules-store.js';
import { findMailRule } from '../sync/mail-rules-store.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { runProfileSync, type SyncDomain } from '../sync/profile-sync.js';
import { findRule } from '../sync/rules-store.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';

export interface RuleRetryRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

type RuleKind = Exclude<SyncDomain, 'all'>;

/**
 * `POST /api/profiles/:id/rules/:kind/:ruleId/retry`: runs the rule's sync right away. A calendar
 * rule runs on its own; contacts and mail sync profile-wide, so their whole domain runs. The sync
 * log closes the errors of every item that succeeds.
 */
export function createRuleRetryRoutes(deps: RuleRetryRouteDeps): Hono<ProfileEnv> {
  const { db, clock } = deps;
  const withConnectedProviders = createConnectedProviders(deps);
  const routes = new Hono<ProfileEnv>();

  const ruleExists = (kind: RuleKind, profileId: string, ruleId: string) =>
    (kind === 'calendars' ? findRule : kind === 'contacts' ? findContactRule : findMailRule)(db, profileId, ruleId) !== undefined;

  routes.post('/:id/rules/:kind/:ruleId/retry', (c) => {
    const kind = c.req.param('kind');
    const ruleId = c.req.param('ruleId');
    if (kind !== 'calendars' && kind !== 'contacts' && kind !== 'mail') {
      return c.json({ error: 'Rule not found' }, 404);
    }
    if (!ruleExists(kind, c.get('profile').id, ruleId)) {
      return c.json({ error: 'Rule not found' }, 404);
    }
    return withConnectedProviders(
      c,
      async (providers, profile, appleId) => {
        if (!profile.enabled) {
          return c.json({ error: 'This Profile is paused' }, 409);
        }
        const result = await runProfileSync({
          db,
          clock,
          profile,
          appleId,
          providers,
          domain: kind,
          dryRun: false,
          force: false,
          ruleId,
        });
        return c.json(result, 200);
      },
      { exclusive: true },
    );
  });

  return routes;
}
