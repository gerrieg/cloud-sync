import { useEffect, useState } from 'react';
import {
  createProfile,
  listProfiles,
  type Profile,
} from '../lib/profiles-api.js';
import { AppleConnection } from './AppleConnection.js';
import { AuthSetup } from './AuthSetup.js';
import { GoogleConnection, type GoogleFlash } from './GoogleConnection.js';
import { ProfilePanel } from './ProfilePanel.js';
import { ProfileSwitcher } from './ProfileSwitcher.js';

interface AppShellProps {
  username: string;
  onLogout(): Promise<void>;
}

export function AppShell({ username, onLogout }: AppShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Outcome of a Google OAuth redirect (`/?profile=<id>&google=<outcome>`), read once on load
  const [oauthRedirect] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('google');
    const flash: GoogleFlash =
      outcome === 'connected' || outcome === 'invalid_grant' || outcome === 'error' ? outcome : null;
    return { profileId: params.get('profile'), flash };
  });

  useEffect(() => {
    let active = true;
    listProfiles()
      .then((loaded) => {
        if (!active) {
          return;
        }
        setProfiles(loaded);
        setSelectedId(loaded.find((p) => p.id === oauthRedirect.profileId)?.id ?? loaded[0]?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (active) {
          setLoadError(cause instanceof Error ? cause.message : 'Could not load Profiles');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const selected = profiles?.find((p) => p.id === selectedId) ?? null;

  async function handleCreate(name: string) {
    const created = await createProfile(name);
    setProfiles((current) => [...(current ?? []), created]);
    setSelectedId(created.id);
  }

  function handleChanged(updated: Profile) {
    setProfiles((current) => (current ?? []).map((p) => (p.id === updated.id ? updated : p)));
  }

  function handleDeleted(id: string) {
    const remaining = (profiles ?? []).filter((p) => p.id !== id);
    setProfiles(remaining);
    setSelectedId(remaining[0]?.id ?? null);
  }

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
                onSelect={setSelectedId}
                onCreate={handleCreate}
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
            <ProfilePanel profile={selected} onChange={handleChanged} onDeleted={handleDeleted} />
            <AppleConnection profile={selected} onChange={handleChanged} />
            <GoogleConnection
              profile={selected}
              flash={selected.id === oauthRedirect.profileId ? oauthRedirect.flash : null}
            />
            <AuthSetup profile={selected} />
          </>
        )}
      </main>
    </div>
  );
}
