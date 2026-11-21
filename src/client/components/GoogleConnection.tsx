import type { GoogleLinkOutcome } from '../../shared/profile.js';
import { redirectTo } from '../lib/navigation.js';
import { getGoogleAuthUrl, type Profile } from '../lib/profiles-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';

interface GoogleConnectionProps {
  profile: Profile;
  /** Outcome of the OAuth redirect that brought the admin back to this Profile, if any. */
  outcome: GoogleLinkOutcome | null;
}

export function GoogleConnection({ profile, outcome }: GoogleConnectionProps) {
  const { busy, error, run } = useAsyncAction();

  const needsReauth = profile.googleReauthRequired || outcome === 'invalid_grant';

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">Google</h2>

      {needsReauth && (
        <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Google rejected the stored authorization (invalid_grant). Please re-authenticate this Profile
          so syncing can resume.
        </p>
      )}
      {outcome === 'error' && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          Could not connect Google. Authorization was denied or failed; please try again.
        </p>
      )}
      {outcome === 'connected' && (
        <p role="status" className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
          Google account connected.
        </p>
      )}

      <p className="mt-2 text-sm text-slate-600">
        {profile.googleConnected ? 'Google account connected.' : 'Google account not connected.'}
      </p>

      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => redirectTo(await getGoogleAuthUrl(profile.id)), 'Could not start Google sign-in')
        }
        className={`mt-4 ${secondaryButtonClass}`}
      >
        {profile.googleConnected || needsReauth ? 'Reconnect Google' : 'Connect Google'}
      </button>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
