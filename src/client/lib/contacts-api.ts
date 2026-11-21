import type {
  ContactGroupDiscovery,
  ContactRuleCreate,
  ContactRuleDto,
  ContactRuleUpdate,
  ContactRunResult,
} from '../../shared/contacts.js';
import type { SyncRunResult } from '../../shared/calendar.js';
import { apiRequest } from './http.js';

export type { ContactGroupDiscovery, ContactRuleCreate, ContactRuleDto, ContactRuleUpdate, ContactRunResult };

const profilePath = (profileId: string) => `/api/profiles/${encodeURIComponent(profileId)}`;

export function discoverContactGroups(profileId: string): Promise<ContactGroupDiscovery> {
  return apiRequest(`${profilePath(profileId)}/discover/contact-groups`);
}

export function listContactRules(profileId: string): Promise<ContactRuleDto[]> {
  return apiRequest(`${profilePath(profileId)}/rules/contacts`);
}

export function createContactRule(profileId: string, rule: ContactRuleCreate): Promise<ContactRuleDto> {
  return apiRequest(`${profilePath(profileId)}/rules/contacts`, { method: 'POST', body: rule });
}

export function updateContactRule(profileId: string, ruleId: string, patch: ContactRuleUpdate): Promise<ContactRuleDto> {
  return apiRequest(`${profilePath(profileId)}/rules/contacts/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/** Keeps the synced Google contacts unless `cleanupGoogle` is explicitly true. */
export function deleteContactRule(profileId: string, ruleId: string, cleanupGoogle: boolean): Promise<void> {
  return apiRequest(
    `${profilePath(profileId)}/rules/contacts/${encodeURIComponent(ruleId)}?cleanupGoogle=${cleanupGoogle}`,
    { method: 'DELETE' },
  );
}

async function contactsOf(run: Promise<SyncRunResult>): Promise<ContactRunResult> {
  const result = await run;
  return result.contacts ?? { status: 'skipped', reason: 'no contact rules', actions: [] };
}

export function runContactDryRun(profileId: string): Promise<ContactRunResult> {
  return contactsOf(apiRequest(`${profilePath(profileId)}/dry-run`, { method: 'POST', body: { domain: 'contacts' } }));
}

export function runContactSync(profileId: string, force: boolean): Promise<ContactRunResult & { dryRun: false }> {
  return contactsOf(
    apiRequest(`${profilePath(profileId)}/sync`, { method: 'POST', body: { domain: 'contacts', force } }),
  ) as Promise<ContactRunResult & { dryRun: false }>;
}
