import type { SyncRunResult } from '../../shared/calendar.js';
import type {
  MailFolderDiscovery,
  MailRuleCreate,
  MailRuleDto,
  MailRuleUpdate,
  MailRunResult,
} from '../../shared/mail.js';
import { apiRequest, profilePath } from './http.js';
import { rulesApi } from './rules-api.js';

export type { MailFolderDiscovery, MailRuleCreate, MailRuleDto, MailRuleUpdate, MailRunResult };

export const mailRulesApi = rulesApi<MailRuleDto, MailRuleCreate, MailRuleUpdate, MailFolderDiscovery>('mail', 'mail-folders');

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
