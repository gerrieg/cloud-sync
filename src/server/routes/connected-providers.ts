import type { Context } from 'hono';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { findProfile, toProvidersContext, updateProfile, type ProfileRow } from '../profiles/profile-store.js';
import {
  GOOGLE_INVALID_GRANT,
  GoogleAuthError,
  type SyncProviders,
  type SyncProvidersFactory,
} from '../providers/types.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import type { ProfileEnv } from './profile-context.js';

export interface ConnectedProvidersDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

/**
 * Runs `work` with the Profile's providers. Answers 409 when an account is not connected, and
 * flags the Profile for re-authentication when Google reports `invalid_grant`. `exclusive` work
 * runs under the Profile's lock, so it never overlaps another run for the same Profile.
 */
export function createConnectedProviders(deps: ConnectedProvidersDeps) {
  const { config, db, locks, createSyncProviders } = deps;

  return async function withConnectedProviders(
    c: Context<ProfileEnv>,
    work: (providers: SyncProviders, profile: ProfileRow, appleId: string) => Promise<Response>,
    options: { exclusive?: boolean } = {},
  ): Promise<Response> {
    const run = async (): Promise<Response> => {
      // Re-read: the Profile may have changed while this request waited for the lock
      const profile = findProfile(db, c.get('profile').id) ?? c.get('profile');
      const context = toProvidersContext(profile, config.encryptionKey);
      if (!context.apple || !context.googleTokens) {
        return c.json({ error: 'Connect both the Apple and the Google account first' }, 409);
      }
      try {
        return await work(createSyncProviders(context), profile, context.apple.appleId);
      } catch (error) {
        if (error instanceof GoogleAuthError && error.code === GOOGLE_INVALID_GRANT) {
          updateProfile(db, profile.id, { googleReauthRequired: true });
          return c.json(
            { error: 'Google authorization expired; please re-authenticate', reauthRequired: true },
            409,
          );
        }
        throw error;
      }
    };
    return options.exclusive ? locks.run(c.get('profile').id, run) : run();
  };
}
