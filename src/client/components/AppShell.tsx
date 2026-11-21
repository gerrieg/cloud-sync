import { useState } from 'react';

interface AppShellProps {
  username: string;
  onLogout(): Promise<void>;
}

export function AppShell({ username, onLogout }: AppShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);

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
        <section className="rounded-xl border border-slate-200 bg-white p-8 shadow-xs">
          <h1 className="text-xl font-semibold text-slate-900">Profiles</h1>
          <p className="mt-2 text-sm text-slate-600">
            Signed in as administrator. No Profiles are configured yet.
          </p>
        </section>
      </main>
    </div>
  );
}
