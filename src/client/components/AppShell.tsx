import { useState, type ComponentProps } from 'react';
import { listOpenErrors } from '../lib/logs-api.js';
import { usePolling } from '../lib/use-polling.js';
import { approveDeletions, dismissDeletions } from '../lib/delete-approvals-api.js';
import { readOAuthRedirect } from '../lib/oauth-redirect.js';
import { useDeleteApprovals } from '../lib/use-delete-approvals.js';
import type { Profile } from '../lib/profiles-api.js';
import { useProfiles } from '../lib/use-profiles.js';
import { AppleConnection } from './AppleConnection.js';
import { CalendarSyncPanel } from './CalendarSyncPanel.js';
import { ContactSyncPanel } from './ContactSyncPanel.js';
import { DeleteGuardBanner } from './DeleteGuardBanner.js';
import { ErrorBanner } from './ErrorBanner.js';
import { ErrorsPanel } from './ErrorsPanel.js';
import { OverviewPage } from './OverviewPage.js';
import { SyncLogPanel } from './SyncLogPanel.js';
import { GoogleConnection } from './GoogleConnection.js';
import { MailSyncPanel } from './MailSyncPanel.js';
import { ProfileSettingsPanel } from './ProfileSettingsPanel.js';
import { ProfileSwitcher } from './ProfileSwitcher.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { TriggerTokenPanel } from './TriggerTokenPanel.js';

const VIEWS = ['overview', 'profile', 'errors', 'logs'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<Exclude<View, 'errors'>, string> = { overview: 'Overview', profile: 'Profile', logs: 'Sync Log' };
const ERRORS_REFRESH_INTERVAL_MS = 10_000;

/** The Google OAuth redirect (`/?profile=<id>&…`) lands on the Profile; otherwise the Overview is home. */
function readView(search: string, redirectProfileId: string | null): View {
  const requested = new URLSearchParams(search).get('view');
  return VIEWS.find((view) => view === requested) ?? (redirectProfileId ? 'profile' : 'overview');
}

interface AppShellProps {
  username: string;
  onLogout(): Promise<void>;
}

interface SelectedProfileProps {
  profile: Profile;
  outcome: ComponentProps<typeof GoogleConnection>['outcome'];
  onChange: ComponentProps<typeof ProfileSettingsPanel>['onChange'];
  onDeleted: ComponentProps<typeof ProfileSettingsPanel>['onDeleted'];
  /** A sync was started from this Profile's page: errors may have appeared or been resolved. */
  onSynced(): Promise<void>;
}

/** Everything about the selected Profile; owns its Delete Guard batches, which sync runs may add. */
function SelectedProfile({ profile, outcome, onChange, onDeleted, onSynced }: SelectedProfileProps) {
  const { approvals, refresh: refreshApprovals } = useDeleteApprovals(profile.id);
  const refresh = async () => {
    await Promise.all([refreshApprovals(), onSynced()]);
  };
  const decide = (decision: (approvalId: string) => Promise<unknown>) => async (approvalId: string) => {
    await decision(approvalId);
    await refresh();
  };

  return (
    <>
      <DeleteGuardBanner
        approvals={approvals}
        onApprove={decide(approveDeletions)}
        onDismiss={decide(dismissDeletions)}
      />
      <ProfileSettingsPanel profile={profile} onChange={onChange} onDeleted={onDeleted} />
      <AppleConnection profile={profile} onChange={onChange} />
      <GoogleConnection profile={profile} outcome={outcome} />
      <CalendarSyncPanel profile={profile} onSynced={refresh} />
      <ContactSyncPanel profile={profile} onSynced={refresh} />
      <MailSyncPanel profile={profile} onSynced={refresh} />
      <TriggerTokenPanel profile={profile} />
    </>
  );
}

export function AppShell({ username, onLogout }: AppShellProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  // Outcome of a Google OAuth redirect (`/?profile=<id>&google=<outcome>`), read once on load
  const [oauthRedirect] = useState(() => readOAuthRedirect(window.location.search));
  const { profiles, selected, selectedId, select, loadError, create, replace, remove } = useProfiles(
    oauthRedirect.profileId,
  );
  const [view, setView] = useState<View>(() => readView(window.location.search, oauthRedirect.profileId));
  const { data: openErrors, reload: reloadOpenErrors } = usePolling(listOpenErrors, ERRORS_REFRESH_INTERVAL_MS);
  const errorCount = openErrors?.length ?? 0;

  function show(next: View) {
    setView(next);
    window.history.replaceState({}, '', `/?view=${next}`);
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
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
            <span className="inline-flex h-7 items-center rounded-full bg-slate-100 px-3 text-xs font-medium text-slate-700">
              {username}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className={secondaryButtonClass}
            >
              {loggingOut ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div role="tablist" aria-label="Views" className="mb-8 flex flex-wrap gap-2 border-b border-slate-200">
          {VIEWS.map((id) => {
            const label = id === 'errors' ? `Errors (${errorCount})` : VIEW_LABEL[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => show(id)}
                className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${
                  view === id ? 'border-slate-900' : 'border-transparent hover:text-slate-800'
                } ${
                  id === 'errors' && errorCount > 0
                    ? 'text-red-700'
                    : view === id
                      ? 'text-slate-900'
                      : 'text-slate-500'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {view !== 'errors' && <ErrorBanner count={errorCount} onShow={() => show('errors')} />}
        {loadError && (
          <p role="alert" className="text-sm text-red-700">
            {loadError}
          </p>
        )}

        {view === 'overview' && (
          <OverviewPage
            onOpenProfile={(profileId) => {
              select(profileId);
              show('profile');
            }}
            onShowErrors={() => show('errors')}
          />
        )}
        {view === 'errors' && <ErrorsPanel errors={openErrors ?? []} onRetried={reloadOpenErrors} />}
        {view === 'logs' && <SyncLogPanel profiles={profiles ?? []} />}
        {view === 'profile' && profiles && !selected && (
          <section className="rounded-xl border border-slate-200 bg-white p-8 shadow-xs">
            <h1 className="text-xl font-semibold text-slate-900">Profiles</h1>
            <p className="mt-2 text-sm text-slate-600">
              No Profiles yet. Add one in the top bar to connect an Apple and a Google account.
            </p>
          </section>
        )}
        {view === 'profile' && selected && (
          <SelectedProfile
            profile={selected}
            outcome={selected.id === oauthRedirect.profileId ? oauthRedirect.outcome : null}
            onChange={replace}
            onDeleted={remove}
            onSynced={reloadOpenErrors}
          />
        )}
      </main>
    </div>
  );
}
