import { useState } from 'react';
import { LOG_ENTITY_TYPES, LOG_LEVELS, type LogEntityType, type LogLevel } from '../../shared/logs.js';
import { ENTITY_TYPE_LABEL, LEVEL_LABEL } from '../lib/log-labels.js';
import { listLogs } from '../lib/logs-api.js';
import type { Profile } from '../lib/profiles-api.js';
import { usePolling } from '../lib/use-polling.js';
import { TimeStamp } from './TimeStamp.js';

const REFRESH_INTERVAL_MS = 5_000;
const selectClass = 'mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm';

/** The live, filterable sync log across all Profiles. */
export function SyncLogPanel({ profiles }: { profiles: readonly Profile[] }) {
  const [profileId, setProfileId] = useState('');
  const [entityType, setEntityType] = useState<LogEntityType | ''>('');
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);
  const { data: entries, error } = usePolling(
    () =>
      listLogs({
        ...(profileId ? { profileId } : {}),
        ...(entityType ? { entityType } : {}),
        ...(level ? { level } : {}),
        ...(unresolvedOnly ? { unresolvedOnly: true } : {}),
      }),
    REFRESH_INTERVAL_MS,
    [profileId, entityType, level, unresolvedOnly],
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h1 className="text-xl font-semibold text-slate-900">Sync Log</h1>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-sm text-slate-700">
          Profile filter
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)} className={selectClass}>
            <option value="">All Profiles</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-700">
          Type
          <select value={entityType} onChange={(event) => setEntityType(event.target.value as LogEntityType | '')} className={selectClass}>
            <option value="">All types</option>
            {LOG_ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {ENTITY_TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-700">
          Level
          <select value={level} onChange={(event) => setLevel(event.target.value as LogLevel | '')} className={selectClass}>
            <option value="">All levels</option>
            {LOG_LEVELS.map((value) => (
              <option key={value} value={value}>
                {LEVEL_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" checked={unresolvedOnly} onChange={(event) => setUnresolvedOnly(event.target.checked)} />
          Unresolved errors only
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
      {entries && entries.length === 0 && <p className="mt-6 text-sm text-slate-600">No log entries.</p>}
      {entries && entries.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table aria-label="Sync log" className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Profile</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Level</th>
                <th className="py-2 pr-4 font-medium">Rule</th>
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-4 text-slate-500">
                    <TimeStamp at={entry.createdAt} />
                  </td>
                  <td className="py-2 pr-4">{entry.profileName}</td>
                  <td className="py-2 pr-4">{ENTITY_TYPE_LABEL[entry.entityType]}</td>
                  <td className={`py-2 pr-4 ${entry.level === 'error' ? 'text-red-700' : 'text-slate-700'}`}>
                    {LEVEL_LABEL[entry.level]}
                    {entry.level === 'error' && entry.resolvedAt !== null ? ' (resolved)' : ''}
                  </td>
                  <td className="py-2 pr-4">{entry.ruleName ?? '—'}</td>
                  <td className="py-2 pr-4">
                    {entry.action && <span className="text-slate-500">{entry.action}: </span>}
                    <span>{entry.summary}</span>
                  </td>
                  <td className="py-2">{entry.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
