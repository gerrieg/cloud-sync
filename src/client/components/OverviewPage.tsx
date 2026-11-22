import { useState } from 'react';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import { getOverview, syncAll } from '../lib/overview-api.js';
import { usePolling } from '../lib/use-polling.js';
import { ProfileOverviewCard } from './ProfileOverviewCard.js';

const REFRESH_INTERVAL_MS = 5_000;

interface OverviewPageProps {
  onOpenProfile(profileId: string): void;
  onShowErrors(): void;
}

/** The overview page: one card per Profile with what is enabled, how the last runs went, live status and open errors. */
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

      <div className="mt-6 space-y-5">
        {(cards ?? []).map((card) => (
          <ProfileOverviewCard
            key={card.profile.id}
            card={card}
            now={Date.now()}
            onOpen={() => onOpenProfile(card.profile.id)}
            onShowErrors={onShowErrors}
          />
        ))}
      </div>
    </section>
  );
}
