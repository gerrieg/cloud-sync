import { useEffect, useState } from 'react';
import {
  createMailRule,
  deleteMailRule,
  discoverMailFolders,
  listMailRules,
  updateMailRule,
  type MailFolderDiscovery,
  type MailRuleCreate,
  type MailRuleDto,
  type MailRuleUpdate,
} from './mail-api.js';

/** Loads a Profile's mail rules and discoverable folders, and keeps them up to date. */
export function useMailRules(profileId: string) {
  const [rules, setRules] = useState<MailRuleDto[]>([]);
  const [discovery, setDiscovery] = useState<MailFolderDiscovery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRules([]);
    setDiscovery(null);
    setLoadError(null);
    const fail = (cause: unknown) => {
      if (active) {
        setLoadError(cause instanceof Error ? cause.message : 'Could not load mail folders');
      }
    };
    listMailRules(profileId)
      .then((loaded) => active && setRules(loaded))
      .catch(fail);
    discoverMailFolders(profileId)
      .then((found) => active && setDiscovery(found))
      .catch(fail);
    return () => {
      active = false;
    };
  }, [profileId]);

  async function add(rule: MailRuleCreate) {
    const created = await createMailRule(profileId, rule);
    setRules((current) => [...current, created]);
  }

  async function update(ruleId: string, patch: MailRuleUpdate) {
    const updated = await updateMailRule(profileId, ruleId, patch);
    setRules((current) => current.map((rule) => (rule.id === ruleId ? updated : rule)));
  }

  async function remove(ruleId: string, cleanupGoogle: boolean) {
    await deleteMailRule(profileId, ruleId, cleanupGoogle);
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
  }

  return { rules, discovery, loadError, add, update, remove };
}
