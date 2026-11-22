import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppleTestReport } from '../../shared/profile.js';
import { createOAuthState } from '../auth/oauth-state.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import type { AppDatabase } from '../db/index.js';
import { resolveGoogleRedirectUri } from '../profiles/google-redirect.js';
import {
  deleteProfile,
  findProfile,
  generateTriggerToken,
  insertProfile,
  listProfiles,
  toProfileDto,
  toProvidersContext,
  updateProfile,
  type ProfileRowPatch,
} from '../profiles/profile-store.js';
import type { SyncProvidersFactory } from '../providers/types.js';
import type { RealtimeOrchestrator } from '../realtime/orchestrator.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { createCalendarRoutes } from './calendar-sync.js';
import { createContactRoutes } from './contact-sync.js';
import { createMailRoutes } from './mail-sync.js';
import { createRuleRetryRoutes } from './rule-retry.js';
import type { ProfileEnv } from './profile-context.js';

export interface ProfileRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
  readonly realtime: RealtimeOrchestrator;
}

const MAX_NAME_LENGTH = 100;

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function createProfileRoutes(deps: ProfileRouteDeps): Hono<ProfileEnv> {
  const { config, db, clock, locks, createSyncProviders, realtime } = deps;
  const routes = new Hono<ProfileEnv>();

  // Every `/:id` route works on an existing Profile: resolve it once, answer 404 otherwise.
  const loadProfile = createMiddleware<ProfileEnv>(async (c, next) => {
    const row = findProfile(db, c.req.param('id') ?? '');
    if (!row) {
      return c.json({ error: 'Profile not found' }, 404);
    }
    c.set('profile', row);
    await next();
  });
  routes.use('/:id', loadProfile);
  routes.use('/:id/*', loadProfile);
  routes.route('/', createCalendarRoutes({ config, db, clock, locks, createSyncProviders }));
  routes.route('/', createContactRoutes({ config, db, locks, createSyncProviders }));
  routes.route('/', createMailRoutes({ config, db, locks, createSyncProviders }));
  routes.route('/', createRuleRetryRoutes({ config, db, clock, locks, createSyncProviders }));

  routes.get('/', (c) => c.json(listProfiles(db).map(toProfileDto), 200));

  routes.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = parseName(body?.name);
    if (!name) {
      return c.json({ error: `Name is required (max ${MAX_NAME_LENGTH} characters)` }, 400);
    }
    return c.json(toProfileDto(insertProfile(db, name, config.encryptionKey)), 201);
  });

  routes.get('/:id', (c) => c.json(toProfileDto(c.get('profile')), 200));

  routes.get('/:id/status', (c) => c.json(realtime.statusOf(c.get('profile')), 200));

  routes.patch('/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      enabled?: unknown;
      appleId?: unknown;
      appleAppPassword?: unknown;
    } | null;
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const patch: ProfileRowPatch = {};
    if (body.name !== undefined) {
      const name = parseName(body.name);
      if (!name) {
        return c.json({ error: `Name must be 1-${MAX_NAME_LENGTH} characters` }, 400);
      }
      patch.name = name;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'enabled must be a boolean' }, 400);
      }
      patch.enabled = body.enabled;
    }
    if (body.appleId !== undefined || body.appleAppPassword !== undefined) {
      const appleId = typeof body.appleId === 'string' ? body.appleId.trim() : '';
      const appPassword = typeof body.appleAppPassword === 'string' ? body.appleAppPassword.trim() : '';
      if (!appleId || !appPassword) {
        return c.json({ error: 'appleId and appleAppPassword are required together' }, 400);
      }
      patch.appleId = appleId;
      patch.appleAppPasswordEnc = encryptSecret(appPassword, config.encryptionKey);
    }

    return c.json(toProfileDto(updateProfile(db, c.get('profile').id, patch)), 200);
  });

  routes.delete('/:id', (c) => {
    deleteProfile(db, c.get('profile').id);
    return c.body(null, 204);
  });

  routes.post('/:id/test-apple', async (c) => {
    const context = toProvidersContext(c.get('profile'), config.encryptionKey);
    if (!context.apple) {
      return c.json({ error: 'No Apple credentials configured for this Profile' }, 409);
    }
    const report = await createSyncProviders(context).apple.testConnection();
    const body: AppleTestReport = {
      ok: report.caldav.ok && report.carddav.ok && report.imap.ok,
      ...report,
    };
    return c.json(body, 200);
  });

  routes.get('/:id/google/auth-url', (c) => {
    const session = c.get('session');
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const row = c.get('profile');
    const state = createOAuthState({
      profileId: row.id,
      sessionIat: session.iat,
      sessionSecret: config.sessionSecret,
      clock,
    });
    const url = createSyncProviders(toProvidersContext(row, config.encryptionKey)).google.buildAuthUrl({
      redirectUri: resolveGoogleRedirectUri(config, c.req.url),
      state,
    });
    return c.json({ url }, 200);
  });

  routes.get('/:id/trigger-token', (c) =>
    c.json({ token: decryptSecret(c.get('profile').triggerTokenEnc, config.encryptionKey) }, 200),
  );

  routes.post('/:id/rotate-trigger-token', (c) => {
    const token = generateTriggerToken();
    updateProfile(db, c.get('profile').id, {
      triggerTokenEnc: encryptSecret(token, config.encryptionKey),
    });
    return c.json({ token }, 200);
  });

  return routes;
}
