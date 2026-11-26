import { Hono, type Context } from 'hono';
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
import {
  checkLoginLockout,
  clearFailedLoginAttempts,
  recordFailedLoginAttempt,
  verifyAndClaimTotp,
  type LoginLockout,
} from '../auth/totp.js';

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

/**
 * Sets the cookie `Secure` flag only when the deployment is actually served over HTTPS
 * (`PUBLIC_BASE_URL`, `X-Forwarded-Proto`, or request scheme), so local LAN Docker setups over
 * plain HTTP do not silently drop the session cookie.
 */
function shouldUseSecureCookie(config: AppConfig, c: Context<{ Variables: AppVariables }>): boolean {
  if (config.publicBaseUrl) {
    return config.publicBaseUrl.startsWith('https://');
  }
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwardedProto) {
    return forwardedProto === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}

function lockedResponse(c: Context<{ Variables: AppVariables }>, lockout: LoginLockout) {
  c.header('Retry-After', String(lockout.retryAfterSeconds));
  return c.json(
    {
      error: 'Too many failed verification attempts. Try again later.',
      lockedUntil: lockout.lockedUntil,
      retryAfterSeconds: lockout.retryAfterSeconds,
    },
    429,
  );
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono<{ Variables: AppVariables }> {
  const { config, db, clock } = deps;
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

    // Check lockout before bcrypt so locked callers cannot brute-force or probe passwords
    const activeLock = checkLoginLockout(db, clock);
    if (activeLock) {
      return lockedResponse(c, activeLock);
    }

    const credentialsValid = await verifyAdminCredentials({
      username: body.username.trim(),
      password: body.password,
      expectedUsername: config.userName,
      expectedPasswordHash: config.userPasswordHash,
    });

    if (!credentialsValid) {
      const triggeredLock = recordFailedLoginAttempt(db, clock);
      if (triggeredLock) {
        return lockedResponse(c, triggeredLock);
      }
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
          return lockedResponse(c, totpResult);
        }
        return c.json({ error: 'Invalid credentials' }, 401);
      }
    } else {
      clearFailedLoginAttempts(db);
    }

    const token = sealSession(config.userName, config.sessionSecret, clock);
    setCookie(c, SESSION_COOKIE_NAME, token, buildSessionCookieOptions(shouldUseSecureCookie(config, c)));

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
    setCookie(c, SESSION_COOKIE_NAME, '', buildClearedSessionCookieOptions(shouldUseSecureCookie(config, c)));
    return c.json({ ok: true }, 200);
  });

  return auth;
}
