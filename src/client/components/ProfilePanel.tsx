import { useEffect, useState, type FormEvent } from 'react';
import { deleteProfile, updateProfile, type Profile } from '../lib/profiles-api.js';

interface ProfilePanelProps {
  profile: Profile;
  onChange(profile: Profile): void;
  onDeleted(id: string): void;
}

const buttonClass =
  'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

export function ProfilePanel({ profile, onChange, onDeleted }: ProfilePanelProps) {
  const [name, setName] = useState(profile.name);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(profile.name);
    setConfirmingDelete(false);
    setError(null);
  }, [profile.id, profile.name]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  function handleRename(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.name) {
      return;
    }
    void run(async () => onChange(await updateProfile(profile.id, { name: trimmed })));
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">{profile.name}</h1>
          {!profile.enabled && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
              Paused
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() =>
              void run(async () => onChange(await updateProfile(profile.id, { enabled: !profile.enabled })))
            }
          >
            {profile.enabled ? 'Pause' : 'Activate'}
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                disabled={busy}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                onClick={() =>
                  void run(async () => {
                    await deleteProfile(profile.id);
                    onDeleted(profile.id);
                  })
                }
              >
                Confirm delete
              </button>
              <button type="button" className={buttonClass} onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={buttonClass} onClick={() => setConfirmingDelete(true)}>
              Delete Profile
            </button>
          )}
        </div>
      </div>

      <form onSubmit={handleRename} className="mt-5 flex items-end gap-2">
        <label className="text-sm text-slate-700">
          Profile name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            className="mt-1 block w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <button type="submit" disabled={busy} className={buttonClass}>
          Rename
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
