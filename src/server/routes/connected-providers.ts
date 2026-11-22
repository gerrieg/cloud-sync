import type { Context } from 'hono';
import type { ProfileRow } from '../profiles/profile-store.js';
import type { SyncProviders } from '../providers/types.js';
import { ProfileRunner, type ProfileRunnerDeps } from '../sync/profile-runner.js';
import type { ProfileEnv } from './profile-context.js';

export type ConnectedProvidersDeps = ProfileRunnerDeps;

/**
 * Runs `work` with the Profile's providers. Answers 409 when an account is not connected or Google
 * asks for a re-authentication (see `ProfileRunner`). `exclusive` work runs under the Profile's
 * lock, so it never overlaps another run for the same Profile.
 */
export function createConnectedProviders(deps: ConnectedProvidersDeps) {
  const runner = new ProfileRunner(deps);

  return async function withConnectedProviders(
    c: Context<ProfileEnv>,
    work: (providers: SyncProviders, profile: ProfileRow, appleId: string) => Promise<Response>,
    options: { exclusive?: boolean } = {},
  ): Promise<Response> {
    const outcome = await runner.run(c.get('profile'), work, options);
    switch (outcome.status) {
      case 'done':
        return outcome.value;
      case 'not_connected':
        return c.json({ error: 'Connect both the Apple and the Google account first' }, 409);
      case 'reauth_required':
        return c.json({ error: 'Google authorization expired; please re-authenticate', reauthRequired: true }, 409);
    }
  };
}
