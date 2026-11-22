import type { DomainOverviewDto, OverviewDomain, ProfileOverviewDto } from '../../shared/profile.js';
import { formatAgo, formatDuration } from '../lib/format.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { StatusBadges } from './StatusBadges.js';
import { TimeStamp } from './TimeStamp.js';

const DOMAIN_LABEL: Record<OverviewDomain, string> = { calendars: 'Calendars', contacts: 'Contacts', mail: 'Mail' };
const DIRECTION_ARROW = { one_way: '→', bidirectional: '⇄', mixed: '→ / ⇄' } as const;

/** `+3 ~1 −0`: created, updated, deleted. */
function Changes({ created, updated, deleted }: { created: number; updated: number; deleted: number }) {
  const quiet = 'text-slate-300';
  return (
    <span
      aria-label={`${created} created, ${updated} updated, ${deleted} deleted`}
      className="inline-flex items-center gap-2 font-mono text-xs tabular-nums"
    >
      <span className={created ? 'text-emerald-700' : quiet}>+{created}</span>
      <span className={updated ? 'text-sky-700' : quiet}>~{updated}</span>
      <span className={deleted ? 'text-amber-700' : quiet}>−{deleted}</span>
    </span>
  );
}

function Dot({ tone }: { tone: 'ok' | 'error' | 'off' | 'running' }) {
  const color = { ok: 'bg-emerald-500', error: 'bg-red-500', off: 'bg-slate-300', running: 'animate-pulse bg-sky-500' }[tone];
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
}

function DomainLane({ domain, paused, now }: { domain: DomainOverviewDto; paused: boolean; now: number }) {
  const { rulesEnabled, rulesTotal, direction, tracked, running, lastRun, last24h } = domain;
  const off = paused || rulesEnabled === 0;
  const label = DOMAIN_LABEL[domain.domain];
  return (
    <section aria-label={label} className={`p-4 ${off ? 'bg-slate-50/60 text-slate-400' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{label}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${off ? 'bg-slate-200 text-slate-500' : 'bg-emerald-100 text-emerald-800'}`}>
          {paused ? 'paused' : rulesTotal === 0 ? 'no rules' : rulesEnabled === 0 ? `0/${rulesTotal} rules on` : `${rulesEnabled}/${rulesTotal} rules on`}
        </span>
      </div>
      <div className="my-3 flex items-center gap-2 text-xs">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">Apple</span>
        <span aria-label={direction === 'bidirectional' ? 'both ways' : 'Apple to Google'} className="text-base leading-none text-slate-500">
          {DIRECTION_ARROW[direction ?? 'one_way']}
        </span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">Google</span>
        <span className="ml-auto text-slate-500">{tracked.toLocaleString()} linked</span>
      </div>
      {running ? (
        <div role="status">
          <div className="h-2 overflow-hidden rounded-full bg-sky-100">
            <div className="h-2 w-1/3 animate-pulse rounded-full bg-sky-500" />
          </div>
          <p className="mt-1 text-xs text-sky-700">Syncing…</p>
        </div>
      ) : lastRun ? (
        <>
          <div className="flex items-center gap-2">
            <Dot tone={lastRun.status === 'error' ? 'error' : off ? 'off' : 'ok'} />
            {lastRun.status === 'error' ? (
              <span className="text-xs font-medium text-red-700">failed</span>
            ) : lastRun.status === 'skipped' ? (
              <span className="text-xs text-slate-500">no changes</span>
            ) : (
              <Changes created={lastRun.created} updated={lastRun.updated} deleted={lastRun.deleted} />
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Last run <TimeStamp at={lastRun.at} relative={formatAgo(lastRun.at, now)} /> · took {formatDuration(lastRun.durationMs)}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span>Last 24 h</span>
            <Changes created={last24h.created} updated={last24h.updated} deleted={last24h.deleted} />
            {last24h.failedRuns > 0 && (
              <span className="font-medium text-red-700">
                {last24h.failedRuns} failed {last24h.failedRuns === 1 ? 'run' : 'runs'}
              </span>
            )}
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-500">{off ? 'Not syncing' : 'No run yet'}</p>
      )}
    </section>
  );
}

interface ProfileOverviewCardProps {
  card: ProfileOverviewDto;
  now: number;
  onOpen(): void;
  onShowErrors(): void;
}

/** One Profile: per kind of data what is enabled, how the last run went and what the last 24 hours carried over. */
export function ProfileOverviewCard({ card, now, onOpen, onShowErrors }: ProfileOverviewCardProps) {
  const { profile, status, openErrors, domains } = card;
  const syncing = domains.some((domain) => domain.running);
  return (
    <article
      aria-label={profile.name}
      className={`overflow-hidden rounded-xl border bg-white shadow-xs ${openErrors > 0 ? 'border-red-300' : 'border-slate-200'} ${profile.enabled ? '' : 'opacity-70'}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-5 py-3">
        <div className="flex items-center gap-2">
          <Dot tone={!profile.enabled ? 'off' : syncing ? 'running' : openErrors > 0 ? 'error' : 'ok'} />
          <h2 className="text-lg font-semibold text-slate-900">{profile.name}</h2>
          {!profile.enabled && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">Paused</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
          <p>
            Last successful sync:{' '}
            {profile.lastSuccessfulSyncAt === null ? (
              'never'
            ) : (
              <TimeStamp at={profile.lastSuccessfulSyncAt} relative={formatAgo(profile.lastSuccessfulSyncAt, now)} />
            )}
          </p>
          <button type="button" onClick={onOpen} className={secondaryButtonClass}>
            Open
          </button>
        </div>
      </header>
      <div className="grid divide-y divide-slate-100 md:grid-cols-3 md:divide-x md:divide-y-0">
        {domains.map((domain) => (
          <DomainLane key={domain.domain} domain={domain} paused={!profile.enabled} now={now} />
        ))}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-2.5">
        <div className="flex flex-wrap gap-2">
          <StatusBadges status={status} />
        </div>
        {openErrors > 0 ? (
          <button type="button" onClick={onShowErrors} className="text-sm font-medium text-red-700 underline">
            {openErrors} open {openErrors === 1 ? 'error' : 'errors'}
          </button>
        ) : (
          <span className="text-sm text-slate-500">No open errors</span>
        )}
      </footer>
    </article>
  );
}
