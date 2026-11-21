import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { totpState } from '../db/schema.js';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const MAX_FAILED_TOTP_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export type TotpVerificationResult =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: 'invalid_totp' }
  | {
      readonly ok: false;
      readonly reason: 'locked';
      readonly lockedUntil: number;
      readonly retryAfterSeconds: number;
    };

const SIX_DIGIT_CODE_PATTERN = /^\d{6}$/;

export function verifyAndClaimTotp(params: {
  db: AppDatabase;
  totpSecret: string;
  totpCode: string;
  clock: Clock;
}): TotpVerificationResult {
  const { db, totpSecret, totpCode, clock } = params;
  const now = clock.now();
  const currentStep = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

  let delta: number | null = null;
  if (SIX_DIGIT_CODE_PATTERN.test(totpCode)) {
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(totpSecret),
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD_SECONDS,
    });
    delta = totp.validate({ token: totpCode, window: TOTP_WINDOW, timestamp: now });
  }

  return db.transaction(
    (tx): TotpVerificationResult => {
      const row = tx.select().from(totpState).where(eq(totpState.id, 1)).get();

      const currentFailed = row?.failedAttempts ?? 0;
      const currentLockedUntil = row?.lockedUntil ?? null;

      if (currentLockedUntil !== null && currentLockedUntil > now) {
        return {
          ok: false,
          reason: 'locked',
          lockedUntil: currentLockedUntil,
          retryAfterSeconds: Math.max(1, Math.ceil((currentLockedUntil - now) / 1000)),
        };
      }

      if (delta !== null) {
        const matchedStep = currentStep + delta;
        const claimResult = tx
          .update(totpState)
          .set({
            lastStep: matchedStep,
            failedAttempts: 0,
            lockedUntil: null,
          })
          .where(
            and(
              eq(totpState.id, 1),
              or(isNull(totpState.lastStep), lt(totpState.lastStep, matchedStep)),
              or(isNull(totpState.lockedUntil), lte(totpState.lockedUntil, now)),
            ),
          )
          .run();

        if (claimResult.changes === 1) {
          return { ok: true, step: matchedStep };
        }
      }

      const baseFailed =
        currentLockedUntil !== null && currentLockedUntil <= now ? 0 : currentFailed;
      const nextFailed = baseFailed + 1;

      if (nextFailed >= MAX_FAILED_TOTP_ATTEMPTS) {
        const lockedUntil = now + LOCKOUT_DURATION_MS;
        tx.update(totpState)
          .set({ failedAttempts: nextFailed, lockedUntil })
          .where(eq(totpState.id, 1))
          .run();

        return {
          ok: false,
          reason: 'locked',
          lockedUntil,
          retryAfterSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000),
        };
      }

      tx.update(totpState)
        .set({ failedAttempts: nextFailed, lockedUntil: null })
        .where(eq(totpState.id, 1))
        .run();

      return { ok: false, reason: 'invalid_totp' };
    },
    { behavior: 'immediate' },
  );
}
