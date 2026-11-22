import { useState } from 'react';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import { getOverview, syncAll } from '../lib/overview-api.js';
import { usePolling } from '../lib/use-polling.js';
import { StatusBadges } from './StatusBadges.js';
import { TimeStamp } from './TimeStamp.js';

const REFRESH_INTERVAL_MS = 5_000;

interface OverviewPageProps {
  onOpenProfile(profileId: string): void;
  onShowErrors(): void;
}

/** The overview page: one card per Profile with its last successful sync, live status and open errors. */
export function OverviewPage({ onOpenProfile, onShowErrors }: OverviewPageProps) {
  const { data: cards, error: loadError, reload } = usePolling(getOverview, REFRESH_INTERVAL_MS);
  const [queued, setQueued] = useState<number | null>(null);
  const { busy, error, run } = useAsyncAction();

  function handleSyncAll() {
    void run(async () => {
      const result = await syncAll();
      setQueued(result.queued.length);
      await reload();
    }, 'Could not start the sync');
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Overview</h1>
        <div className="flex items-center gap-3">
          {queued !== null && (
            <span role="status" className="text-sm text-slate-600">
              Sync queued for {queued} {queued === 1 ? 'Profile' : 'Profiles'}
            </span>
          )}
          <button type="button" disabled={busy} onClick={handleSyncAll} className={secondaryButtonClass}>
            Sync All
          </button>
        </div>
      </div>

      {(loadError || error) && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error ?? loadError}
        </p>
      )}
      {cards && cards.length === 0 && (
        <p className="mt-6 text-sm text-slate-600">No Profiles yet. Add one in the top bar to connect an Apple and a Google account.</p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {(cards ?? []).map(({ profile, status, openErrors }) => (
          <article
            key={profile.id}
            aria-label={profile.name}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">{profile.name}</h2>
              {!profile.enabled && (
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">Paused</span>
              )}
            </div>
            <p className="mt-3 text-sm text-slate-700">
              Last successful sync:{' '}
              {profile.lastSuccessfulSyncAt === null ? 'never' : <TimeStamp at={profile.lastSuccessfulSyncAt} />}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <StatusBadges status={status} />
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              {openErrors > 0 ? (
                <button type="button" onClick={onShowErrors} className="text-sm font-medium text-red-700 underline">
                  {openErrors} open {openErrors === 1 ? 'error' : 'errors'}
                </button>
              ) : (
                <span className="text-sm text-slate-500">No open errors</span>
              )}
              <button type="button" onClick={() => onOpenProfile(profile.id)} className={secondaryButtonClass}>
                Open
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
