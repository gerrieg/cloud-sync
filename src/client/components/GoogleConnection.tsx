import { useState } from 'react';
import { redirectTo } from '../lib/navigation.js';
import { getGoogleAuthUrl, type Profile } from '../lib/profiles-api.js';

export type GoogleFlash = 'connected' | 'invalid_grant' | 'error' | null;

interface GoogleConnectionProps {
  profile: Profile;
  flash: GoogleFlash;
}

export function GoogleConnection({ profile, flash }: GoogleConnectionProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsReauth = profile.googleReauthRequired || flash === 'invalid_grant';

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      redirectTo(await getGoogleAuthUrl(profile.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start Google sign-in');
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">Google</h2>

      {needsReauth && (
        <p role="alert" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Google rejected the stored authorization (invalid_grant). Please re-authenticate this Profile
          so syncing can resume.
        </p>
      )}
      {flash === 'error' && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          Could not connect Google. Authorization was denied or failed; please try again.
        </p>
      )}
      {flash === 'connected' && (
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
        onClick={() => void handleConnect()}
        className="mt-4 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
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
