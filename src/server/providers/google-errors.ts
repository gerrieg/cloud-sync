import { GOOGLE_INVALID_GRANT, GoogleAuthError } from './types.js';

export function httpStatus(error: unknown): number | undefined {
  const status = (error as { code?: unknown; response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Google refuses the stored authorization (or the code to get one): it is dead and must be renewed. */
export function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const responseError = (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
  return responseError === GOOGLE_INVALID_GRANT || (error instanceof Error && error.message.includes(GOOGLE_INVALID_GRANT));
}

/**
 * Maps what a failed Google call threw to the typed errors of the SyncProviders seam: a dead
 * authorization becomes a `GoogleAuthError`, and a status in `notFound.statuses` becomes
 * `notFound.error()`. Anything else comes back unchanged.
 */
export function translateGoogleError(
  error: unknown,
  notFound?: { readonly statuses: readonly number[]; readonly error: () => Error },
): unknown {
  if (isInvalidGrant(error)) {
    return new GoogleAuthError(GOOGLE_INVALID_GRANT, error instanceof Error ? error.message : undefined);
  }
  const status = httpStatus(error);
  if (notFound && status !== undefined && notFound.statuses.includes(status)) {
    return notFound.error();
  }
  return error;
}
