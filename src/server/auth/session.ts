import crypto from 'node:crypto';
import type { CookieOptions } from 'hono/utils/cookie';
import type { Clock } from '../clock.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';

export const SESSION_COOKIE_NAME = 'cloud_sync_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export interface SessionPayload {
  readonly username: string;
  readonly iat: number;
  readonly exp: number;
}

function deriveSessionKey(sessionSecret: string): Buffer {
  return crypto
    .createHash('sha256')
    .update('cloud-sync:session:v1:')
    .update(sessionSecret)
    .digest();
}

export function sealSession(
  username: string,
  sessionSecret: string,
  clock: Clock,
): string {
  const now = clock.now();
  const payload: SessionPayload = {
    username,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };

  return encryptSecret(JSON.stringify(payload), deriveSessionKey(sessionSecret));
}

export function unsealSession(
  token: string | undefined,
  sessionSecret: string,
  expectedUsername: string,
  clock: Clock,
): SessionPayload | null {
  if (!token || typeof token !== 'string') {
    return null;
  }

  try {
    const decrypted = decryptSecret(token, deriveSessionKey(sessionSecret));
    const parsed: unknown = JSON.parse(decrypted);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SessionPayload).username !== 'string' ||
      typeof (parsed as SessionPayload).iat !== 'number' ||
      typeof (parsed as SessionPayload).exp !== 'number'
    ) {
      return null;
    }

    const session = parsed as SessionPayload;
    if (session.username !== expectedUsername) {
      return null;
    }
    if (session.exp <= clock.now()) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

export function buildSessionCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function buildClearedSessionCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProduction,
    path: '/',
    maxAge: 0,
  };
}
