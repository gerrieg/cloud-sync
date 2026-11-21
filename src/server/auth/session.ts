import crypto from 'node:crypto';
import type { CookieOptions } from 'hono/utils/cookie';
import type { Clock } from '../clock.js';

export const SESSION_COOKIE_NAME = 'cloud_sync_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export interface SessionPayload {
  readonly username: string;
  readonly iat: number;
  readonly exp: number;
}

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v1';

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

  const key = deriveSessionKey(sessionSecret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const tokenBytes = Buffer.concat([iv, authTag, ciphertext]);
  return `${VERSION_PREFIX}.${tokenBytes.toString('base64url')}`;
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

  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] !== VERSION_PREFIX || !parts[1]) {
    return null;
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }

  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    return null;
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const key = deriveSessionKey(sessionSecret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(decrypted.toString('utf8'));

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
