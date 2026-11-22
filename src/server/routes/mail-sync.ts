import { Hono } from 'hono';
import {
  resolveGoogleLabel,
  type MailFolderDiscovery,
  type MailRuleCreate,
  type MailRuleDto,
} from '../../shared/mail.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import type { AppleMailFolder } from '../providers/mail-types.js';
import type { SyncProviders, SyncProvidersFactory } from '../providers/types.js';
import {
  deleteMailRule,
  findMailRule,
  findMailRuleByFolder,
  insertMailRule,
  listMailRules,
  toMailRuleDto,
  updateMailRule,
  type MailRulePatch,
  type MailRuleRow,
} from '../sync/mail-rules-store.js';
import { forgetRuleFolder, removeRuleFromGoogle } from '../sync/mail-sync.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';
import { parseRuleOptions, registerRuleRoutes, type RuleKind } from './rule-routes.js';

/** Drafts and Junk are never synced by default; the Trash folder is only watched for deletions. */
const EXCLUDED_USES = new Set(['drafts', 'junk', 'trash']);

async function selectableFolders(providers: SyncProviders): Promise<AppleMailFolder[]> {
  return (await providers.apple.mail.listFolders()).filter(
    (folder) => folder.selectable && !(folder.use !== null && EXCLUDED_USES.has(folder.use)),
  );
}

const mailRules: RuleKind<MailRuleRow, MailRulePatch, MailRuleDto> = {
  path: 'mail',
  cleanupFailure: 'Could not remove the synced emails from Gmail; the rule was kept',
  parseOptions: (body) => parseRuleOptions(body, ['syncWindowDays', 'deleteBehavior', 'enabled']),
  list: listMailRules,
  find: findMailRule,
  toDto: toMailRuleDto,
  validateCreate: (body) =>
    typeof (body as Partial<MailRuleCreate>).appleFolderPath !== 'string' ? 'appleFolderPath is required' : null,
  async create({ db, providers, profileId }, body, options) {
    const { appleFolderPath } = body as unknown as MailRuleCreate;
    const folder = (await selectableFolders(providers)).find((candidate) => candidate.path === appleFolderPath);
    if (!folder) {
      return { ok: false, status: 400, error: 'Apple mail folder not found or not selectable' };
    }
    if (findMailRuleByFolder(db, profileId, folder.path)) {
      return { ok: false, status: 409, error: 'A rule for this mail folder already exists' };
    }
    const row = insertMailRule(db, {
      profileId,
      appleFolderPath: folder.path,
      appleFolderName: folder.name,
      googleLabel: resolveGoogleLabel(folder),
      ...options,
    });
    return { ok: true, row };
  },
  update: (db, rule, patch) => updateMailRule(db, rule.id, patch),
  remove: (db, rule) => deleteMailRule(db, rule.id),
  // The sync just stops managing this folder; its folder state goes too
  forget: (db, profileId, rule) => forgetRuleFolder(db, profileId, rule),
  removeFromGoogle: removeRuleFromGoogle,
  // Mail has no "Apple did not change" shortcut that a changed rule could hide behind
  invalidate: () => undefined,
};

export interface MailRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

export function createMailRoutes(deps: MailRouteDeps): Hono<ProfileEnv> {
  const { db, locks } = deps;
  const withConnectedProviders = createConnectedProviders(deps);
  const routes = new Hono<ProfileEnv>();

  routes.get('/:id/discover/mail-folders', (c) =>
    withConnectedProviders(c, async (providers) => {
      const body: MailFolderDiscovery = {
        folders: (await selectableFolders(providers)).map((folder) => ({
          path: folder.path,
          name: folder.name,
          googleLabel: resolveGoogleLabel(folder),
        })),
      };
      return c.json(body, 200);
    }),
  );

  registerRuleRoutes(routes, mailRules, { db, locks, withConnectedProviders });

  return routes;
}
