import { useEffect, useState, type FormEvent } from 'react';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import { deleteProfile, updateProfile, type Profile } from '../lib/profiles-api.js';

interface ProfileSettingsPanelProps {
  profile: Profile;
  onChange(profile: Profile): void;
  onDeleted(id: string): void;
}

/** Name, paused/active state and deletion of the selected Profile. */
export function ProfileSettingsPanel({ profile, onChange, onDeleted }: ProfileSettingsPanelProps) {
  const [name, setName] = useState(profile.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { busy, error, run, reset } = useAsyncAction();

  useEffect(() => {
    setName(profile.name);
    setConfirmingDelete(false);
    reset();
  }, [profile.id, profile.name, reset]);

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
            className={secondaryButtonClass}
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
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={secondaryButtonClass} onClick={() => setConfirmingDelete(true)}>
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
        <button type="submit" disabled={busy} className={secondaryButtonClass}>
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
