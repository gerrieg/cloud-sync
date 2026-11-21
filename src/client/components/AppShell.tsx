import { useState } from 'react';
import { readOAuthRedirect } from '../lib/oauth-redirect.js';
import { useProfiles } from '../lib/use-profiles.js';
import { AppleConnection } from './AppleConnection.js';
import { GoogleConnection } from './GoogleConnection.js';
import { ProfileSettingsPanel } from './ProfileSettingsPanel.js';
import { ProfileSwitcher } from './ProfileSwitcher.js';
import { TriggerTokenPanel } from './TriggerTokenPanel.js';

interface AppShellProps {
  username: string;
  onLogout(): Promise<void>;
}

export function AppShell({ username, onLogout }: AppShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  // Outcome of a Google OAuth redirect (`/?profile=<id>&google=<outcome>`), read once on load
  const [oauthRedirect] = useState(() => readOAuthRedirect(window.location.search));
  const { profiles, selected, selectedId, select, loadError, create, replace, remove } = useProfiles(
    oauthRedirect.profileId,
  );

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold tracking-tight text-slate-900">Cloud Sync</span>
            {profiles && (
              <ProfileSwitcher
                profiles={profiles}
                selectedId={selectedId}
                onSelect={select}
                onCreate={create}
              />
            )}
          </div>

          <div className="flex items-center gap-4">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              {username}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loggingOut ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {loadError && (
          <p role="alert" className="text-sm text-red-700">
            {loadError}
          </p>
        )}
        {profiles && !selected && (
          <section className="rounded-xl border border-slate-200 bg-white p-8 shadow-xs">
            <h1 className="text-xl font-semibold text-slate-900">Profiles</h1>
            <p className="mt-2 text-sm text-slate-600">
              No Profiles yet. Add one in the top bar to connect an Apple and a Google account.
            </p>
          </section>
        )}
        {selected && (
          <>
            <ProfileSettingsPanel profile={selected} onChange={replace} onDeleted={remove} />
            <AppleConnection profile={selected} onChange={replace} />
            <GoogleConnection
              profile={selected}
              outcome={selected.id === oauthRedirect.profileId ? oauthRedirect.outcome : null}
            />
            <TriggerTokenPanel profile={selected} />
          </>
        )}
      </main>
    </div>
  );
}
