import { isRateLimited } from './google-errors.js';
import { systemTime, type RateLimiterClock } from './rate-limiter.js';

export interface GoogleThrottleOptions {
  /** Pause between two calls when Google does not complain; the interval falls back to it. */
  readonly minIntervalMs?: number;
  /** The interval never grows beyond this, however often Google complains. */
  readonly maxIntervalMs?: number;
  /** How often one call is repeated after "Rate Limit Exceeded" before its error is passed on. */
  readonly maxRetries?: number;
  /** Cap of the wait before a repeat (Google: typically 32 or 64 seconds). */
  readonly maxBackoffMs?: number;
}

/** Calls without a complaint after which the interval shrinks again (halved, down to the minimum). */
const CALM_CALLS_PER_STEP = 20;

/**
 * Runs Google calls one after another, spaced by an interval that doubles whenever Google answers
 * "Rate Limit Exceeded" and halves again after a stretch of calm. Such a call waits and is repeated
 * with truncated exponential backoff (`min(2^n s + up to 1 s, maxBackoff)`, as Google asks) while the
 * calls behind it wait too, so a limited run slows down instead of failing item after item.
 */
export function createGoogleThrottle(
  options: GoogleThrottleOptions = {},
  time: RateLimiterClock = systemTime,
  random: () => number = Math.random,
) {
  const base = options.minIntervalMs ?? 500;
  const maxInterval = options.maxIntervalMs ?? 4000;
  const maxRetries = options.maxRetries ?? 6;
  const maxBackoff = options.maxBackoffMs ?? 32_000;
  let interval = base;
  let calm = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  let tail: Promise<unknown> = Promise.resolve();

  return function limit<T>(call: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt += 1) {
        const wait = lastStart + interval - time.now();
        if (wait > 0) {
          await time.sleep(wait);
        }
        lastStart = time.now();
        try {
          const result = await call();
          calm += 1;
          if (calm >= CALM_CALLS_PER_STEP) {
            calm = 0;
            interval = Math.max(base, interval / 2);
          }
          return result;
        } catch (error) {
          if (!isRateLimited(error) || attempt >= maxRetries) {
            throw error;
          }
          calm = 0;
          interval = Math.min(interval * 2, maxInterval);
          await time.sleep(Math.min(2 ** attempt * 1000 + random() * 1000, maxBackoff));
        }
      }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
}
