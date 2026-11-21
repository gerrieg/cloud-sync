import type {
  CalendarDiscovery,
  CalendarRuleCreate,
  CalendarRuleDto,
  CalendarRuleUpdate,
  SyncRunResult,
} from '../../shared/calendar.js';
import { apiRequest } from './http.js';

export type { CalendarDiscovery, CalendarRuleCreate, CalendarRuleDto, CalendarRuleUpdate, SyncRunResult };

const profilePath = (profileId: string) => `/api/profiles/${encodeURIComponent(profileId)}`;

export function discoverCalendars(profileId: string): Promise<CalendarDiscovery> {
  return apiRequest(`${profilePath(profileId)}/discover/calendars`);
}

export function listCalendarRules(profileId: string): Promise<CalendarRuleDto[]> {
  return apiRequest(`${profilePath(profileId)}/rules/calendars`);
}

export function createCalendarRule(profileId: string, rule: CalendarRuleCreate): Promise<CalendarRuleDto> {
  return apiRequest(`${profilePath(profileId)}/rules/calendars`, { method: 'POST', body: rule });
}

export function updateCalendarRule(
  profileId: string,
  ruleId: string,
  patch: CalendarRuleUpdate,
): Promise<CalendarRuleDto> {
  return apiRequest(`${profilePath(profileId)}/rules/calendars/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/** Keeps the synced Google events unless `cleanupGoogle` is explicitly true. */
export function deleteCalendarRule(profileId: string, ruleId: string, cleanupGoogle: boolean): Promise<void> {
  return apiRequest(
    `${profilePath(profileId)}/rules/calendars/${encodeURIComponent(ruleId)}?cleanupGoogle=${cleanupGoogle}`,
    { method: 'DELETE' },
  );
}

export function runDryRun(profileId: string): Promise<SyncRunResult> {
  return apiRequest(`${profilePath(profileId)}/dry-run`, { method: 'POST', body: {} });
}

export function runSync(profileId: string, force: boolean): Promise<SyncRunResult> {
  return apiRequest(`${profilePath(profileId)}/sync`, { method: 'POST', body: { force } });
}
