import { calendarRulesApi } from './calendar-api.js';
import { useRules } from './use-rules.js';

/** Loads a Profile's calendar rules and discoverable calendars, and keeps them up to date. */
export function useCalendarRules(profileId: string) {
  return useRules(calendarRulesApi, profileId, 'Could not load calendars');
}
