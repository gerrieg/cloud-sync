import { useEffect, useState } from 'react';
import {
  createCalendarRule,
  deleteCalendarRule,
  discoverCalendars,
  listCalendarRules,
  updateCalendarRule,
  type CalendarDiscovery,
  type CalendarRuleCreate,
  type CalendarRuleDto,
  type CalendarRuleUpdate,
} from './calendar-api.js';

/** Loads a Profile's calendar rules and discoverable calendars, and keeps them up to date. */
export function useCalendarRules(profileId: string) {
  const [rules, setRules] = useState<CalendarRuleDto[]>([]);
  const [discovery, setDiscovery] = useState<CalendarDiscovery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRules([]);
    setDiscovery(null);
    setLoadError(null);
    const fail = (cause: unknown) => {
      if (active) {
        setLoadError(cause instanceof Error ? cause.message : 'Could not load calendars');
      }
    };
    listCalendarRules(profileId)
      .then((loaded) => active && setRules(loaded))
      .catch(fail);
    discoverCalendars(profileId)
      .then((found) => active && setDiscovery(found))
      .catch(fail);
    return () => {
      active = false;
    };
  }, [profileId]);

  async function add(rule: CalendarRuleCreate) {
    const created = await createCalendarRule(profileId, rule);
    setRules((current) => [...current, created]);
  }

  async function update(ruleId: string, patch: CalendarRuleUpdate) {
    const updated = await updateCalendarRule(profileId, ruleId, patch);
    setRules((current) => current.map((rule) => (rule.id === ruleId ? updated : rule)));
  }

  async function remove(ruleId: string, cleanupGoogle: boolean) {
    await deleteCalendarRule(profileId, ruleId, cleanupGoogle);
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
  }

  return { rules, discovery, loadError, add, update, remove };
}
