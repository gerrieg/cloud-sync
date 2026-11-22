import { useEffect, useState } from 'react';
import type { RulesApi } from './rules-api.js';

/** Loads a Profile's Sync Rules of one kind and its discoverable containers, and keeps them up to date. */
export function useRules<Dto extends { readonly id: string }, Create, Update, Discovery>(
  api: RulesApi<Dto, Create, Update, Discovery>,
  profileId: string,
  loadErrorMessage: string,
) {
  const [rules, setRules] = useState<Dto[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRules([]);
    setDiscovery(null);
    setLoadError(null);
    const fail = (cause: unknown) => {
      if (active) {
        setLoadError(cause instanceof Error ? cause.message : loadErrorMessage);
      }
    };
    api
      .list(profileId)
      .then((loaded) => active && setRules(loaded))
      .catch(fail);
    api
      .discover(profileId)
      .then((found) => active && setDiscovery(found))
      .catch(fail);
    return () => {
      active = false;
    };
  }, [api, profileId, loadErrorMessage]);

  async function add(rule: Create) {
    const created = await api.create(profileId, rule);
    setRules((current) => [...current, created]);
  }

  async function update(ruleId: string, patch: Update) {
    const updated = await api.update(profileId, ruleId, patch);
    setRules((current) => current.map((rule) => (rule.id === ruleId ? updated : rule)));
  }

  async function remove(ruleId: string, cleanupGoogle: boolean) {
    await api.remove(profileId, ruleId, cleanupGoogle);
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
  }

  return { rules, discovery, loadError, add, update, remove };
}
