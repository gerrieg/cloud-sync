import type {
  ContactGroupDiscovery,
  ContactRuleCreate,
  ContactRuleDto,
  ContactRuleUpdate,
  ContactRunResult,
} from '../../shared/contacts.js';
import type { SyncRunResult } from '../../shared/calendar.js';
import { apiRequest, profilePath } from './http.js';
import { rulesApi } from './rules-api.js';

export type { ContactGroupDiscovery, ContactRuleCreate, ContactRuleDto, ContactRuleUpdate, ContactRunResult };

export const contactRulesApi = rulesApi<ContactRuleDto, ContactRuleCreate, ContactRuleUpdate, ContactGroupDiscovery>(
  'contacts',
  'contact-groups',
);

async function contactsOf(run: Promise<SyncRunResult>): Promise<ContactRunResult> {
  const result = await run;
  return result.contacts ?? { status: 'skipped', reason: 'no contact rules', actions: [] };
}

export function runContactDryRun(profileId: string): Promise<ContactRunResult> {
  return contactsOf(apiRequest(`${profilePath(profileId)}/dry-run`, { method: 'POST', body: { domain: 'contacts' } }));
}

export function runContactSync(profileId: string, force: boolean): Promise<ContactRunResult> {
  return contactsOf(apiRequest(`${profilePath(profileId)}/sync`, { method: 'POST', body: { domain: 'contacts', force } }));
}
