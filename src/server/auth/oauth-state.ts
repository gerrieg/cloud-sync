import crypto from 'node:crypto';
import type { Clock } from '../clock.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  readonly profileId: string;
  readonly sessionIat: number;
  readonly nonce: string;
  readonly exp: number;
}

function sign(encodedPayload: string, sessionSecret: string): Buffer {
  const key = crypto
    .createHash('sha256')
    .update('cloud-sync:oauth-state:v1:')
    .update(sessionSecret)
    .digest();
  return crypto.createHmac('sha256', key).update(encodedPayload).digest();
}

/**
 * Mints an OAuth `state` bound to one Profile and to the admin session that started the flow,
 * so a callback replayed from another session or for another Profile is rejected (CSRF).
 */
export function createOAuthState(input: {
  profileId: string;
  sessionIat: number;
  sessionSecret: string;
  clock: Clock;
}): string {
  const payload: OAuthStatePayload = {
    profileId: input.profileId,
    sessionIat: input.sessionIat,
    nonce: crypto.randomBytes(16).toString('base64url'),
    exp: input.clock.now() + OAUTH_STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, input.sessionSecret).toString('base64url')}`;
}

export function verifyOAuthState(
  state: string | undefined,
  input: { sessionIat: number; sessionSecret: string; clock: Clock },
): { profileId: string; nonce: string; exp: number } | null {
  const parts = state?.split('.') ?? [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const provided = Buffer.from(parts[1], 'base64url');
  const expected = sign(parts[0], input.sessionSecret);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as OAuthStatePayload;
    if (
      typeof payload.profileId !== 'string' ||
      payload.sessionIat !== input.sessionIat ||
      typeof payload.exp !== 'number' ||
      payload.exp <= input.clock.now()
    ) {
      return null;
    }
    if (typeof payload.nonce !== 'string') {
      return null;
    }
    return { profileId: payload.profileId, nonce: payload.nonce, exp: payload.exp };
  } catch {
    return null;
  }
}

/** Remembers consumed OAuth states until they expire so each one can be redeemed only once. */
export class UsedOAuthStates {
  private readonly used = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  /** Returns false when the nonce was already consumed. */
  consume(nonce: string, exp: number): boolean {
    const now = this.clock.now();
    for (const [knownNonce, knownExp] of this.used) {
      if (knownExp <= now) {
        this.used.delete(knownNonce);
      }
    }
    if (this.used.has(nonce)) {
      return false;
    }
    this.used.set(nonce, exp);
    return true;
  }
}
