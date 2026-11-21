/** Full-page navigation (e.g. to Google's consent screen); isolated so tests can observe it. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
