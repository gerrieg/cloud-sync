import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { findProfile, toProvidersContext, updateProfile, type ProfileRow } from '../profiles/profile-store.js';
import {
  GOOGLE_INVALID_GRANT,
  GoogleAuthError,
  type SyncProviders,
  type SyncProvidersFactory,
} from '../providers/types.js';
import type { ProfileLocks } from './profile-locks.js';

/**
 * A dead Google authorization is recorded on the Profile, which then waits for its re-authorization.
 * Returns whether `error` was one; any other error is none of this rule's business.
 */
export function flagGoogleReauth(db: AppDatabase, profileId: string, error: unknown): boolean {
  if (error instanceof GoogleAuthError && error.code === GOOGLE_INVALID_GRANT) {
    updateProfile(db, profileId, { googleReauthRequired: true });
    return true;
  }
  return false;
}

export type ProfileRunOutcome<T> =
  | { readonly status: 'done'; readonly value: T }
  /** The Apple or the Google account of the Profile is not connected (yet). */
  | { readonly status: 'not_connected' }
  /** Google rejected the stored authorization; the Profile is now flagged for re-authentication. */
  | { readonly status: 'reauth_required' };

export interface ProfileRunnerDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

/**
 * Acts for a Profile with its connected accounts: whoever wants to (an HTTP request, a background
 * trigger) hands over its work and gets the providers, or learns that the Profile cannot be acted
 * for. Everything the work throws other than a dead Google authorization is the caller's to handle.
 */
export class ProfileRunner {
  constructor(private readonly deps: ProfileRunnerDeps) {}

  /**
   * `exclusive` work runs under the Profile's lock, so it never overlaps another run for the same
   * Profile; leave it off when the caller already holds the lock.
   */
  async run<T>(
    profile: ProfileRow,
    work: (providers: SyncProviders, profile: ProfileRow, appleId: string) => Promise<T>,
    options: { readonly exclusive?: boolean } = {},
  ): Promise<ProfileRunOutcome<T>> {
    const { config, db, locks, createSyncProviders } = this.deps;
    const run = async (): Promise<ProfileRunOutcome<T>> => {
      // Re-read: the Profile may have changed while this run waited for the lock
      const current = findProfile(db, profile.id) ?? profile;
      const context = toProvidersContext(current, config.encryptionKey);
      if (!context.apple || !context.googleTokens) {
        return { status: 'not_connected' };
      }
      try {
        return { status: 'done', value: await work(createSyncProviders(context), current, context.apple.appleId) };
      } catch (error) {
        if (flagGoogleReauth(db, current.id, error)) {
          return { status: 'reauth_required' };
        }
        throw error;
      }
    };
    return options.exclusive ? locks.run(profile.id, run) : run();
  }
}
