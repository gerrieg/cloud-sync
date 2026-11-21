import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/server/providers/rate-limiter.js';

/** A clock that only moves when the limiter sleeps. */
function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe('Rate limiter (Google People API, ~1 request per second per Profile)', () => {
  it('spaces calls at least one interval apart, in call order', async () => {
    const time = fakeTime();
    const limit = createRateLimiter(1000, time);
    const startedAt: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        limit(async () => {
          startedAt.push(time.now());
          return n;
        }),
      ),
    );

    expect(startedAt).toEqual([0, 1000, 2000]);
  });

  it('does not delay a call when enough time has passed, and keeps going after a failed call', async () => {
    const time = fakeTime();
    const limit = createRateLimiter(1000, time);
    await limit(async () => undefined);
    await time.sleep(5000);

    await expect(limit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const before = time.now();
    await limit(async () => undefined);

    expect(before).toBe(5000);
    expect(time.now()).toBe(6000);
  });
});
