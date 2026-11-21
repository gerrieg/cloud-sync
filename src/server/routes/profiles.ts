import { Hono } from 'hono';
import type { AppVariables } from '../app.js';
import { createOAuthState } from '../auth/oauth-state.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import type { AppDatabase } from '../db/index.js';
import { resolveGoogleRedirectUri } from './google-oauth.js';
import type { SyncProvidersFactory } from '../providers/types.js';
import {
  deleteProfile,
  findProfile,
  generateTriggerToken,
  insertProfile,
  listProfiles,
  toProfileDto,
  toProvidersContext,
  updateProfile,
  type ProfilePatch,
} from '../profiles/profile-store.js';

export interface ProfileRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly createSyncProviders: SyncProvidersFactory;
}

const MAX_NAME_LENGTH = 100;

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function createProfileRoutes(deps: ProfileRouteDeps): Hono<{ Variables: AppVariables }> {
  const { config, db, clock, createSyncProviders } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get('/', (c) => c.json(listProfiles(db).map(toProfileDto), 200));

  routes.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = parseName(body?.name);
    if (!name) {
      return c.json({ error: `Name is required (max ${MAX_NAME_LENGTH} characters)` }, 400);
    }
    return c.json(toProfileDto(insertProfile(db, name, config.encryptionKey)), 201);
  });

  routes.get('/:id', (c) => {
    const row = findProfile(db, c.req.param('id'));
    return row ? c.json(toProfileDto(row), 200) : c.json({ error: 'Profile not found' }, 404);
  });

  routes.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!findProfile(db, id)) {
      return c.json({ error: 'Profile not found' }, 404);
    }

    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      enabled?: unknown;
      appleId?: unknown;
      appleAppPassword?: unknown;
    } | null;
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const patch: ProfilePatch = {};
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

    const updated = updateProfile(db, id, patch);
    return updated ? c.json(toProfileDto(updated), 200) : c.json({ error: 'Profile not found' }, 404);
  });

  routes.delete('/:id', (c) =>
    deleteProfile(db, c.req.param('id'))
      ? c.body(null, 204)
      : c.json({ error: 'Profile not found' }, 404),
  );

  routes.post('/:id/test-apple', async (c) => {
    const row = findProfile(db, c.req.param('id'));
    if (!row) {
      return c.json({ error: 'Profile not found' }, 404);
    }
    const context = toProvidersContext(row, config.encryptionKey);
    if (!context.apple) {
      return c.json({ error: 'No Apple credentials configured for this Profile' }, 409);
    }
    const report = await createSyncProviders(context).apple.testConnection();
    return c.json(
      { ok: report.caldav.ok && report.carddav.ok && report.imap.ok, ...report },
      200,
    );
  });

  routes.get('/:id/google/auth-url', (c) => {
    const row = findProfile(db, c.req.param('id'));
    const session = c.get('session');
    if (!row || !session) {
      return c.json({ error: 'Profile not found' }, 404);
    }
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

  routes.get('/:id/trigger-token', (c) => {
    const row = findProfile(db, c.req.param('id'));
    if (!row) {
      return c.json({ error: 'Profile not found' }, 404);
    }
    return c.json({ token: decryptSecret(row.triggerTokenEnc, config.encryptionKey) }, 200);
  });

  routes.post('/:id/rotate-trigger-token', (c) => {
    const id = c.req.param('id');
    const token = generateTriggerToken();
    const updated = updateProfile(db, id, {
      triggerTokenEnc: encryptSecret(token, config.encryptionKey),
    });
    return updated ? c.json({ token }, 200) : c.json({ error: 'Profile not found' }, 404);
  });

  return routes;
}
