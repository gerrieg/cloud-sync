import type {
  CalendarDiscovery,
  CalendarRuleCreate,
  CalendarRuleDto,
  CalendarRuleUpdate,
  SyncRunResult,
} from '../../shared/calendar.js';
import { apiRequest, profilePath } from './http.js';
import { rulesApi } from './rules-api.js';

export type { CalendarDiscovery, CalendarRuleCreate, CalendarRuleDto, CalendarRuleUpdate, SyncRunResult };

export const calendarRulesApi = rulesApi<CalendarRuleDto, CalendarRuleCreate, CalendarRuleUpdate, CalendarDiscovery>(
  'calendars',
  'calendars',
);

export function runDryRun(profileId: string): Promise<SyncRunResult> {
  return apiRequest(`${profilePath(profileId)}/dry-run`, { method: 'POST', body: { domain: 'calendars' } });
}

export function runSync(profileId: string, force: boolean): Promise<SyncRunResult> {
  return apiRequest(`${profilePath(profileId)}/sync`, { method: 'POST', body: { domain: 'calendars', force } });
}
