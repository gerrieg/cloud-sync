import type { AppConfig } from '../config.js';

const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';

/** `PUBLIC_BASE_URL` when configured, otherwise the origin the request arrived on. */
export function resolveGoogleRedirectUri(config: AppConfig, requestUrl: string): string {
  const base = config.publicBaseUrl ?? new URL(requestUrl).origin;
  return `${base}${GOOGLE_CALLBACK_PATH}`;
}
