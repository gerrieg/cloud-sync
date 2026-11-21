import type { SyncRunResult } from '../../shared/calendar.js';
import type {
  MailFolderDiscovery,
  MailRuleCreate,
  MailRuleDto,
  MailRuleUpdate,
  MailRunResult,
} from '../../shared/mail.js';
import { apiRequest } from './http.js';

export type { MailFolderDiscovery, MailRuleCreate, MailRuleDto, MailRuleUpdate, MailRunResult };

const profilePath = (profileId: string) => `/api/profiles/${encodeURIComponent(profileId)}`;

export function discoverMailFolders(profileId: string): Promise<MailFolderDiscovery> {
  return apiRequest(`${profilePath(profileId)}/discover/mail-folders`);
}

export function listMailRules(profileId: string): Promise<MailRuleDto[]> {
  return apiRequest(`${profilePath(profileId)}/rules/mail`);
}

export function createMailRule(profileId: string, rule: MailRuleCreate): Promise<MailRuleDto> {
  return apiRequest(`${profilePath(profileId)}/rules/mail`, { method: 'POST', body: rule });
}

export function updateMailRule(profileId: string, ruleId: string, patch: MailRuleUpdate): Promise<MailRuleDto> {
  return apiRequest(`${profilePath(profileId)}/rules/mail/${encodeURIComponent(ruleId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/** Keeps the synced Gmail messages unless `cleanupGoogle` is explicitly true. */
export function deleteMailRule(profileId: string, ruleId: string, cleanupGoogle: boolean): Promise<void> {
  return apiRequest(
    `${profilePath(profileId)}/rules/mail/${encodeURIComponent(ruleId)}?cleanupGoogle=${cleanupGoogle}`,
    { method: 'DELETE' },
  );
}

async function mailOf(run: Promise<SyncRunResult>): Promise<MailRunResult> {
  const result = await run;
  return result.mail ?? { status: 'skipped', reason: 'no mail rules', actions: [] };
}

export function runMailDryRun(profileId: string): Promise<MailRunResult> {
  return mailOf(apiRequest(`${profilePath(profileId)}/dry-run`, { method: 'POST', body: { domain: 'mail' } }));
}

export function runMailSync(profileId: string, force: boolean): Promise<MailRunResult> {
  return mailOf(apiRequest(`${profilePath(profileId)}/sync`, { method: 'POST', body: { domain: 'mail', force } }));
}
