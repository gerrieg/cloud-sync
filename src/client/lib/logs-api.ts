import type { SyncRunResult } from '../../shared/calendar.js';
import type { LogEntityType, SyncLogDto, SyncLogQuery } from '../../shared/logs.js';
import { apiRequest as request } from './http.js';

export type { SyncLogDto };

export function listLogs(query: SyncLogQuery = {}): Promise<SyncLogDto[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return request(`/api/logs${search ? `?${search}` : ''}`);
}

/** The errors no later run has resolved yet. */
export function listOpenErrors(): Promise<SyncLogDto[]> {
  return listLogs({ level: 'error', unresolvedOnly: true, limit: 1000 });
}

const DOMAIN: Record<LogEntityType, 'calendars' | 'contacts' | 'mail'> = {
  calendar: 'calendars',
  contact: 'contacts',
  email: 'mail',
};

/** Why a finished retry did not fix anything, or null when its part of the run went through. */
function problemOf(result: SyncRunResult, entityType: LogEntityType): string | null {
  const parts =
    entityType === 'calendar' ? result.rules : [entityType === 'contact' ? result.contacts : result.mail].flatMap((part) => (part ? [part] : []));
  const failed = parts.find((part) => part.status === 'error');
  if (failed) {
    return failed.error ?? 'Sync failed';
  }
  return parts.some((part) => part.status === 'skipped' && part.reason === 'paused') ? 'The rule is paused' : null;
}

/**
 * "Retry Rule": runs the error's Sync Rule. An error that belongs to no single rule re-runs the
 * whole sync of its kind of data for the Profile instead. Resolves to the reason the retry did
 * not help (the errors of items that now work are closed by the server either way).
 */
export async function retryError(error: SyncLogDto): Promise<string | null> {
  const profile = encodeURIComponent(error.profileId);
  const domain = DOMAIN[error.entityType];
  const result = error.ruleId
    ? await request<SyncRunResult>(`/api/profiles/${profile}/rules/${domain}/${encodeURIComponent(error.ruleId)}/retry`, { method: 'POST' })
    : await request<SyncRunResult>(`/api/profiles/${profile}/sync`, { method: 'POST', body: { domain } });
  return problemOf(result, error.entityType);
}
