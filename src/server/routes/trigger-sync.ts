import { Hono } from 'hono';
import type { AppVariables } from '../app.js';
import { timingSafeEqualStrings } from '../auth/password.js';
import type { AppConfig } from '../config.js';
import { decryptSecret } from '../crypto/secrets.js';
import type { AppDatabase } from '../db/index.js';
import { findProfile } from '../profiles/profile-store.js';
import type { RealtimeOrchestrator } from '../realtime/orchestrator.js';

export interface TriggerSyncRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly realtime: RealtimeOrchestrator;
}

const BEARER_PATTERN = /^Bearer (.+)$/;

/**
 * Self-authenticated endpoint for iOS/macOS Shortcuts (ADR-0001): the Profile's trigger token
 * replaces the session cookie. Unknown Profiles and wrong tokens look identical.
 */
export function createTriggerSyncRoutes(deps: TriggerSyncRouteDeps): Hono<{ Variables: AppVariables }> {
  const { config, db, realtime } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post('/:profileId', (c) => {
    const profile = findProfile(db, c.req.param('profileId'));
    const presented = BEARER_PATTERN.exec(c.req.header('authorization') ?? '')?.[1];
    const expected = profile ? decryptSecret(profile.triggerTokenEnc, config.encryptionKey) : null;
    if (!profile || !presented || expected === null || !timingSafeEqualStrings(presented, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!profile.enabled) {
      return c.json({ error: 'This Profile is paused' }, 409);
    }
    void realtime.requestSync(profile.id, 'all');
    return c.json({ queued: true }, 202);
  });

  return routes;
}
