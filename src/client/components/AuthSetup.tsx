import { useEffect, useState } from 'react';
import { getTriggerToken, rotateTriggerToken, type Profile } from '../lib/profiles-api.js';

interface AuthSetupProps {
  profile: Profile;
}

const buttonClass =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

export function AuthSetup({ profile }: AuthSetupProps) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(null);
    setError(null);
  }, [profile.id]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setToken(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">Auth Setup</h2>
      <p className="mt-1 text-sm text-slate-600">
        The trigger token lets an iOS/macOS Shortcut start a sync for this Profile only. Rotating it
        invalidates the previous token.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          className={buttonClass}
          onClick={() => void run(() => getTriggerToken(profile.id))}
        >
          Show trigger token
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass}
          onClick={() => void run(() => rotateTriggerToken(profile.id))}
        >
          Rotate token
        </button>
      </div>

      {token && (
        <code className="mt-4 block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-800">
          {token}
        </code>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
