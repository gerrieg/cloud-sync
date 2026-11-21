export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemTime: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Runs calls one after another, starting each at least `minIntervalMs` after the previous one. */
export function createRateLimiter(minIntervalMs: number, time: RateLimiterClock = systemTime) {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  return function limit<T>(call: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = lastStart + minIntervalMs - time.now();
      if (wait > 0) {
        await time.sleep(wait);
      }
      lastStart = time.now();
      return call();
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
}
