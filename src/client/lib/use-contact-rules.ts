import { useEffect, useState } from 'react';
import {
  createContactRule,
  deleteContactRule,
  discoverContactGroups,
  listContactRules,
  updateContactRule,
  type ContactGroupDiscovery,
  type ContactRuleCreate,
  type ContactRuleDto,
  type ContactRuleUpdate,
} from './contacts-api.js';

/** Loads a Profile's contact rules and discoverable groups, and keeps them up to date. */
export function useContactRules(profileId: string) {
  const [rules, setRules] = useState<ContactRuleDto[]>([]);
  const [discovery, setDiscovery] = useState<ContactGroupDiscovery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRules([]);
    setDiscovery(null);
    setLoadError(null);
    const fail = (cause: unknown) => {
      if (active) {
        setLoadError(cause instanceof Error ? cause.message : 'Could not load contact groups');
      }
    };
    listContactRules(profileId)
      .then((loaded) => active && setRules(loaded))
      .catch(fail);
    discoverContactGroups(profileId)
      .then((found) => active && setDiscovery(found))
      .catch(fail);
    return () => {
      active = false;
    };
  }, [profileId]);

  async function add(rule: ContactRuleCreate) {
    const created = await createContactRule(profileId, rule);
    setRules((current) => [...current, created]);
  }

  async function update(ruleId: string, patch: ContactRuleUpdate) {
    const updated = await updateContactRule(profileId, ruleId, patch);
    setRules((current) => current.map((rule) => (rule.id === ruleId ? updated : rule)));
  }

  async function remove(ruleId: string, cleanupGoogle: boolean) {
    await deleteContactRule(profileId, ruleId, cleanupGoogle);
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
  }

  return { rules, discovery, loadError, add, update, remove };
}
