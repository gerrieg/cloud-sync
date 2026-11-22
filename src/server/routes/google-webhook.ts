import { Hono } from 'hono';
import type { AppVariables } from '../app.js';
import { timingSafeEqualStrings } from '../auth/password.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import { decryptSecret } from '../crypto/secrets.js';
import type { AppDatabase } from '../db/index.js';
import type { RealtimeOrchestrator } from '../realtime/orchestrator.js';
import { confirmWatchChannel, findWatchChannel } from '../realtime/watch-channels-store.js';

export interface GoogleWebhookRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly realtime: RealtimeOrchestrator;
}

/**
 * Self-authenticated endpoint Google Calendar pushes to (ADR-0001): the per-channel token Google
 * echoes replaces the session cookie. A missing token is 401, a wrong or unknown channel 403.
 */
export function createGoogleWebhookRoutes(deps: GoogleWebhookRouteDeps): Hono<{ Variables: AppVariables }> {
  const { config, db, clock, realtime } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post('/:profileId', (c) => {
    const profileId = c.req.param('profileId');
    const channelId = c.req.header('x-goog-channel-id');
    const token = c.req.header('x-goog-channel-token');
    if (!channelId || !token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const channel = findWatchChannel(db, channelId);
    if (
      !channel ||
      channel.profileId !== profileId ||
      channel.expiresAt <= clock.now() ||
      !timingSafeEqualStrings(token, decryptSecret(channel.tokenEnc, config.encryptionKey))
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Any valid call proves that Google can reach us, so the channel counts as healthy from now on
    confirmWatchChannel(db, channel, clock.now());
    // Google first sends a `sync` message to confirm the channel; only real changes need a sync
    if (c.req.header('x-goog-resource-state') !== 'sync') {
      void realtime.requestSync(profileId, 'calendars');
    }
    return c.body(null, 200);
  });

  return routes;
}
