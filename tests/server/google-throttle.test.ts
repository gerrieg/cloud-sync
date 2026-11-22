import { describe, expect, it } from 'vitest';
import { isRateLimited } from '../../src/server/providers/google-errors.js';
import { createGoogleThrottle } from '../../src/server/providers/google-throttle.js';

/** A clock that only moves when the throttle sleeps. */
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

const failure = (status: number, reason?: string, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { response: { status, data: reason ? { error: { errors: [{ reason }] } } : undefined } });
const rateLimited = () => failure(403, 'rateLimitExceeded', 'Rate Limit Exceeded');

describe('recognising "Rate Limit Exceeded"', () => {
  it('knows a 429 and a 403 with a rate limit reason or message', () => {
    expect(isRateLimited(failure(429))).toBe(true);
    expect(isRateLimited(failure(403, 'rateLimitExceeded'))).toBe(true);
    expect(isRateLimited(failure(403, 'userRateLimitExceeded'))).toBe(true);
    expect(isRateLimited(failure(403, undefined, 'Rate Limit Exceeded'))).toBe(true);
    expect(isRateLimited(Object.assign(new Error('x'), { response: { status: 403 }, errors: [{ reason: 'rateLimitExceeded' }] }))).toBe(true);
  });

  it('does not take other failures for it, including the usage limits of the day', () => {
    expect(isRateLimited(failure(403, 'quotaExceeded', 'Calendar usage limits exceeded.'))).toBe(false);
    expect(isRateLimited(failure(403, 'forbidden'))).toBe(false);
    expect(isRateLimited(failure(404))).toBe(false);
    expect(isRateLimited(failure(500))).toBe(false);
    expect(isRateLimited(new Error('Rate Limit Exceeded'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe('the Google throttle (Calendar API)', () => {
  it('spaces calls at least one interval apart, in call order', async () => {
    const time = fakeTime();
    const limit = createGoogleThrottle({ minIntervalMs: 500 }, time, () => 0);
    const startedAt: number[] = [];

    await Promise.all([1, 2, 3].map((n) => limit(async () => (startedAt.push(time.now()), n))));

    expect(startedAt).toEqual([0, 500, 1000]);
  });

  it('waits and repeats a rate-limited call with exponential backoff instead of failing it', async () => {
    const time = fakeTime();
    const limit = createGoogleThrottle({ minIntervalMs: 500 }, time, () => 0);
    let attempts = 0;

    const result = await limit(async () => {
      attempts += 1;
      if (attempts <= 3) {
        throw rateLimited();
      }
      return 'created';
    });

    expect(result).toBe('created');
    expect(attempts).toBe(4);
    // 1 s, 2 s and 4 s of backoff (the jitter is zero here), each also longer than the interval
    expect(time.sleeps.filter((ms) => ms >= 1000)).toEqual([1000, 2000, 4000]);
  });

  it('adds up to one second of jitter and caps the wait', async () => {
    const time = fakeTime();
    const limit = createGoogleThrottle({ maxBackoffMs: 3000, maxRetries: 4 }, time, () => 0.5);
    let attempts = 0;

    await limit(async () => {
      attempts += 1;
      if (attempts <= 3) {
        throw failure(429);
      }
    });

    // 1.5 s, 2.5 s, then 4.5 s capped at 3 s
    expect(time.sleeps.filter((ms) => ms >= 1500)).toEqual([1500, 2500, 3000]);
  });

  it('passes the error on after the last retry, and never repeats other failures', async () => {
    const time = fakeTime();
    const limit = createGoogleThrottle({ maxRetries: 2 }, time, () => 0);
    let attempts = 0;

    await expect(limit(async () => { attempts += 1; throw rateLimited(); })).rejects.toMatchObject({ message: 'Rate Limit Exceeded' });
    expect(attempts).toBe(3);

    attempts = 0;
    await expect(limit(async () => { attempts += 1; throw failure(404); })).rejects.toMatchObject({ response: { status: 404 } });
    expect(attempts).toBe(1);
  });

  it('lets the calls behind a limited one wait for it', async () => {
    const time = fakeTime();
    const limit = createGoogleThrottle({ minIntervalMs: 500 }, time, () => 0);
    const order: string[] = [];
    let first = 0;

    await Promise.all([
      limit(async () => {
        first += 1;
        order.push(`first#${first}`);
        if (first === 1) {
          throw rateLimited();
        }
      }),
      limit(async () => void order.push('second')),
    ]);

    expect(order).toEqual(['first#1', 'first#2', 'second']);
  });

  it('slows down after a complaint and speeds up again after a stretch of calm', async () => {
    const time = fakeTime();
    const limit = createGoogleThrottle({ minIntervalMs: 500, maxIntervalMs: 2000 }, time, () => 0);
    const gap = async () => {
      const before = time.now();
      await limit(async () => undefined);
      return time.now() - before;
    };
    await limit(async () => undefined);

    let complained = false;
    await limit(async () => {
      if (!complained) {
        complained = true;
        throw rateLimited();
      }
    });
    // The interval doubled to one second
    expect(await gap()).toBe(1000);

    // 20 calm calls halve it, back to the minimum
    for (let i = 0; i < 20; i += 1) {
      await limit(async () => undefined);
    }
    expect(await gap()).toBe(500);
  });
});
