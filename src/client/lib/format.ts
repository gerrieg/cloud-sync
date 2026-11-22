const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** `3 min ago`, `2 h ago`, `5 d ago`; `just now` for under a minute. */
export function formatAgo(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  }
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}

/** `0.4 s`, `12 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  if (ms < MINUTE_MS) {
    return `${Math.round(ms / 1000)} s`;
  }
  return `${Math.floor(ms / MINUTE_MS)} min ${Math.round((ms % MINUTE_MS) / 1000)} s`;
}
