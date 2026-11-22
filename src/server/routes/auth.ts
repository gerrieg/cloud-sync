import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppVariables } from '../app.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { verifyAdminCredentials } from '../auth/password.js';
import {
  buildClearedSessionCookieOptions,
  buildSessionCookieOptions,
  sealSession,
  SESSION_COOKIE_NAME,
} from '../auth/session.js';
import { verifyAndClaimTotp } from '../auth/totp.js';

export interface AuthRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
  totpCode?: unknown;
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono<{ Variables: AppVariables }> {
  const { config, db, clock } = deps;
  const isProduction = config.nodeEnv === 'production';
  const auth = new Hono<{ Variables: AppVariables }>();

  auth.post('/login', async (c) => {
    let body: LoginBody;
    try {
      body = (await c.req.json()) as LoginBody;
    } catch {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const { totpSecret } = config;
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      return c.json({ error: 'Username and password are required' }, 400);
    }
    if (totpSecret && typeof body.totpCode !== 'string') {
      return c.json({ error: 'Username, password, and 6-digit TOTP code are required' }, 400);
    }

    const credentialsValid = await verifyAdminCredentials({
      username: body.username.trim(),
      password: body.password,
      expectedUsername: config.userName,
      expectedPasswordHash: config.userPasswordHash,
    });

    if (!credentialsValid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    if (totpSecret) {
      const totpResult = verifyAndClaimTotp({
        db,
        totpSecret,
        totpCode: (body.totpCode as string).trim(),
        clock,
      });

      if (!totpResult.ok) {
        if (totpResult.reason === 'locked') {
          c.header('Retry-After', String(totpResult.retryAfterSeconds));
          return c.json(
            {
              error: 'Too many failed verification attempts. Try again later.',
              lockedUntil: totpResult.lockedUntil,
              retryAfterSeconds: totpResult.retryAfterSeconds,
            },
            429,
          );
        }
        return c.json({ error: 'Invalid credentials' }, 401);
      }
    }

    const token = sealSession(config.userName, config.sessionSecret, clock);
    setCookie(c, SESSION_COOKIE_NAME, token, buildSessionCookieOptions(isProduction));

    return c.json({ username: config.userName }, 200);
  });

  auth.get('/config', (c) => c.json({ totpRequired: config.totpSecret !== null }, 200));

  auth.get('/me', (c) => {
    const session = c.get('session');
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json({ username: session.username }, 200);
  });

  auth.post('/logout', (c) => {
    setCookie(c, SESSION_COOKIE_NAME, '', buildClearedSessionCookieOptions(isProduction));
    return c.json({ ok: true }, 200);
  });

  return auth;
}
