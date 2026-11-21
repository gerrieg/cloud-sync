import { useEffect, useState } from 'react';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import { getTriggerToken, rotateTriggerToken, type Profile } from '../lib/profiles-api.js';

interface TriggerTokenPanelProps {
  profile: Profile;
}

/** "Auth Setup": view or rotate the Profile's trigger token for iOS/macOS Shortcuts. */
export function TriggerTokenPanel({ profile }: TriggerTokenPanelProps) {
  const [token, setToken] = useState<string | null>(null);
  const { busy, error, run, reset } = useAsyncAction();

  useEffect(() => {
    setToken(null);
    reset();
  }, [profile.id, reset]);

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
          className={secondaryButtonClass}
          onClick={() => void run(async () => setToken(await getTriggerToken(profile.id)))}
        >
          Show trigger token
        </button>
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          onClick={() => void run(async () => setToken(await rotateTriggerToken(profile.id)))}
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
