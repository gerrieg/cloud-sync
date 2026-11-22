import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../../src/server/auth/session.js';
import {
  createTestContext,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from '../helpers/test-app.js';

function extractCookiePair(response: Response): string | undefined {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    return undefined;
  }
  return setCookie.split(';')[0];
}

async function postLogin(
  ctx: TestContext,
  body: Record<string, unknown>,
): Promise<Response> {
  return ctx.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Single-Admin 2FA Auth & Session HTTP Seam', () => {
  let ctx: TestContext | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    ctx?.close();
    ctx = undefined;
  });

  it('signs in with valid credentials + TOTP, sets encrypted httpOnly 30-day cookie, serves /api/auth/me, and logs out', async () => {
    ctx = createTestContext();

    const loginRes = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });

    expect(loginRes.status).toBe(200);
    await expect(loginRes.json()).resolves.toEqual({ username: TEST_USERNAME });

    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(setCookie).not.toContain('Secure');
    // Cookie value must be encrypted (not containing plaintext username)
    expect(setCookie).not.toContain(TEST_USERNAME);

    const cookieHeader = extractCookiePair(loginRes)!;
    const meRes = await ctx.app.request('/api/auth/me', {
      headers: { cookie: cookieHeader },
    });
    expect(meRes.status).toBe(200);
    await expect(meRes.json()).resolves.toEqual({ username: TEST_USERNAME });

    const logoutRes = await ctx.app.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: cookieHeader },
    });
    expect(logoutRes.status).toBe(200);
    const clearedSetCookie = logoutRes.headers.get('set-cookie') ?? '';
    expect(clearedSetCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(clearedSetCookie).toContain('Max-Age=0');
    expect(clearedSetCookie).toContain('HttpOnly');

    const afterLogoutMe = await ctx.app.request('/api/auth/me');
    expect(afterLogoutMe.status).toBe(401);
  });

  it('sets Secure cookie attribute in production', async () => {
    ctx = createTestContext({ envOverrides: { NODE_ENV: 'production' } });

    const loginRes = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.headers.get('set-cookie')).toContain('Secure');
  });

  it('keeps the session valid for 30 days and rejects it once expired or tampered', async () => {
    ctx = createTestContext();

    const loginRes = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });
    const cookieHeader = extractCookiePair(loginRes)!;

    // 29 days, 23 hours later: still valid
    ctx.clock.advanceSeconds(30 * 24 * 60 * 60 - 60);
    const stillValid = await ctx.app.request('/api/auth/me', {
      headers: { cookie: cookieHeader },
    });
    expect(stillValid.status).toBe(200);

    // Tampered cookie rejected
    const tampered = `${cookieHeader.slice(0, -4)}AAAA`;
    const tamperedRes = await ctx.app.request('/api/auth/me', {
      headers: { cookie: tampered },
    });
    expect(tamperedRes.status).toBe(401);

    // 1 minute later (exactly 30 days): expired
    ctx.clock.advanceSeconds(60);
    const expiredRes = await ctx.app.request('/api/auth/me', {
      headers: { cookie: cookieHeader },
    });
    expect(expiredRes.status).toBe(401);
  });

  it('runs bcrypt password comparison even when the username is unknown', async () => {
    const compareSpy = vi.spyOn(bcrypt, 'compare');
    ctx = createTestContext();

    const res = await postLogin(ctx, {
      username: 'unknown-user',
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });

    expect(res.status).toBe(401);
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts TOTP codes within ±1 time step window and rejects outside ±1', async () => {
    ctx = createTestContext();

    // Outside window (-2 and +2) rejected
    const tooOld = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(-2),
    });
    expect(tooOld.status).toBe(401);

    const tooNew = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(2),
    });
    expect(tooNew.status).toBe(401);

    // -1 step accepted
    const minusOne = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(-1),
    });
    expect(minusOne.status).toBe(200);

    // 0 step (strictly newer than -1) accepted
    const zeroStep = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });
    expect(zeroStep.status).toBe(200);

    // +1 step (strictly newer than 0) accepted
    const plusOne = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(1),
    });
    expect(plusOne.status).toBe(200);
  });

  it('enforces single-use TOTP codes per time step and blocks replay or older steps', async () => {
    ctx = createTestContext();
    const currentCode = ctx.generateTotp(0);
    const previousCode = ctx.generateTotp(-1);

    const first = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: currentCode,
    });
    expect(first.status).toBe(200);

    // Replay of same code in same step fails
    const replay = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: currentCode,
    });
    expect(replay.status).toBe(401);

    // Attempting an older step (-1) after step 0 was claimed also fails
    const olderStep = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: previousCode,
    });
    expect(olderStep.status).toBe(401);

    // Advancing 30s to the next time step allows a fresh code
    ctx.clock.advanceSeconds(30);
    const nextStep = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });
    expect(nextStep.status).toBe(200);
  });

  it('locks login for 15 minutes after 5 failed TOTP attempts without revealing lockout on wrong password', async () => {
    ctx = createTestContext();

    // Attempts 1–4 fail with 401
    for (let i = 0; i < 4; i += 1) {
      const res = await postLogin(ctx, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
        totpCode: '000000',
      });
      expect(res.status).toBe(401);
    }

    // Attempt 5 triggers 15-minute lockout (429)
    const fifth = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: '000000',
    });
    expect(fifth.status).toBe(429);
    const lockBody = (await fifth.json()) as { retryAfterSeconds: number; lockedUntil: number };
    expect(lockBody.retryAfterSeconds).toBe(15 * 60);
    expect(lockBody.lockedUntil).toBe(ctx.clock.now() + 15 * 60 * 1000);
    expect(fifth.headers.get('retry-after')).toBe('900');

    // During lockout: valid password + VALID TOTP is still locked (429)
    ctx.clock.advanceMinutes(5);
    const lockedWithValidCode = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });
    expect(lockedWithValidCode.status).toBe(429);

    // During lockout: WRONG password returns 401 and does NOT reveal lockout
    const wrongPasswordDuringLockout = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: 'wrong-password',
      totpCode: ctx.generateTotp(0),
    });
    expect(wrongPasswordDuringLockout.status).toBe(401);
    const wrongPwBody = (await wrongPasswordDuringLockout.json()) as Record<string, unknown>;
    expect(wrongPwBody.lockedUntil).toBeUndefined();
    expect(wrongPwBody.retryAfterSeconds).toBeUndefined();

    // Just before 15 minutes expire (14m59s): still locked
    ctx.clock.advanceSeconds(10 * 60 - 1);
    const stillLocked = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });
    expect(stillLocked.status).toBe(429);

    // At 15 minutes: lockout expires and valid TOTP succeeds
    ctx.clock.advanceSeconds(1);
    const unlocked = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });
    expect(unlocked.status).toBe(200);
  });

  it('resets failed TOTP counter after a successful login', async () => {
    ctx = createTestContext();

    for (let i = 0; i < 4; i += 1) {
      const res = await postLogin(ctx, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
        totpCode: '000000',
      });
      expect(res.status).toBe(401);
    }

    const ok = await postLogin(ctx, {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      totpCode: ctx.generateTotp(0),
    });
    expect(ok.status).toBe(200);

    // Another 4 failed attempts should still return 401 (counter was reset)
    for (let i = 0; i < 4; i += 1) {
      const res = await postLogin(ctx, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
        totpCode: '000000',
      });
      expect(res.status).toBe(401);
    }
  });

  it('redirects unauthenticated UI routes safely, returns 401 on protected API routes, and lets self-authenticated prefixes bypass session redirect', async () => {
    ctx = createTestContext();

    const uiRoot = await ctx.app.request('/');
    expect(uiRoot.status).toBe(302);
    expect(uiRoot.headers.get('location')).toBe('/login');

    const uiNested = await ctx.app.request('/profiles/42?tab=rules');
    expect(uiNested.status).toBe(302);
    expect(uiNested.headers.get('location')).toBe('/login?next=%2Fprofiles%2F42%3Ftab%3Drules');

    const protectedApi = await ctx.app.request('/api/auth/me');
    expect(protectedApi.status).toBe(401);

    // Self-authenticated routes never redirect to /login. They answer 401 themselves when their own
    // credential is missing; that they work without a session is covered by the trigger-sync and
    // realtime-google tests, which succeed with a valid token and no cookie.
    const webhookRes = await ctx.app.request('/webhooks/google/profile-1', { method: 'POST' });
    expect(webhookRes.status).toBe(401);
    expect(webhookRes.headers.get('location')).toBeNull();

    const triggerRes = await ctx.app.request('/api/trigger-sync/profile-1', { method: 'POST' });
    expect(triggerRes.status).toBe(401);
    expect(triggerRes.headers.get('location')).toBeNull();
  });
});
