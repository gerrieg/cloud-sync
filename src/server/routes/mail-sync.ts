import { Hono, type Context } from 'hono';
import {
  resolveGoogleLabel,
  type MailFolderDiscovery,
  type MailRuleCreate,
} from '../../shared/mail.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import type { AppleMailFolder } from '../providers/mail-types.js';
import { GoogleAuthError, type SyncProviders, type SyncProvidersFactory } from '../providers/types.js';
import {
  deleteMailRule,
  findMailRule,
  findMailRuleByFolder,
  insertMailRule,
  listMailRules,
  toMailRuleDto,
  updateMailRule,
  type MailRulePatch,
} from '../sync/mail-rules-store.js';
import { forgetRuleFolder, removeRuleFromGoogle } from '../sync/mail-sync.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { dropOpenErrors } from '../sync/sync-log-store.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Validates the options shared by rule creation and update. */
function parseRuleOptions(body: Record<string, unknown>): Parsed<MailRulePatch> {
  const value: { -readonly [K in keyof MailRulePatch]?: MailRulePatch[K] } = {};
  if (body.syncWindowDays !== undefined) {
    const days = body.syncWindowDays;
    if (days !== null && !(typeof days === 'number' && Number.isInteger(days) && days > 0)) {
      return { ok: false, error: 'syncWindowDays must be a positive integer or null (all history)' };
    }
    value.syncWindowDays = days as number | null;
  }
  if (body.deleteBehavior !== undefined) {
    if (body.deleteBehavior !== 'trash' && body.deleteBehavior !== 'delete') {
      return { ok: false, error: 'deleteBehavior must be "trash" or "delete"' };
    }
    value.deleteBehavior = body.deleteBehavior;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean' };
    }
    value.enabled = body.enabled;
  }
  return { ok: true, value };
}

async function readObjectBody(c: Context<ProfileEnv>): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** Drafts and Junk are never synced by default; the Trash folder is only watched for deletions. */
const EXCLUDED_USES = new Set(['drafts', 'junk', 'trash']);

async function selectableFolders(providers: SyncProviders): Promise<AppleMailFolder[]> {
  return (await providers.apple.mail.listFolders()).filter(
    (folder) => folder.selectable && !(folder.use !== null && EXCLUDED_USES.has(folder.use)),
  );
}

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

  routes.get('/:id/rules/mail', (c) => c.json(listMailRules(db, c.get('profile').id).map(toMailRuleDto), 200));

  routes.post('/:id/rules/mail', async (c) => {
    const body = await readObjectBody(c);
    if (!body) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const input = body as Partial<MailRuleCreate>;
    if (typeof input.appleFolderPath !== 'string') {
      return c.json({ error: 'appleFolderPath is required' }, 400);
    }
    const options = parseRuleOptions(body);
    if (!options.ok) {
      return c.json({ error: options.error }, 400);
    }
    const { appleFolderPath } = input;

    const profileId = c.get('profile').id;
    return withConnectedProviders(c, async (providers) => {
      const folder = (await selectableFolders(providers)).find((candidate) => candidate.path === appleFolderPath);
      if (!folder) {
        return c.json({ error: 'Apple mail folder not found or not selectable' }, 400);
      }
      if (findMailRuleByFolder(db, profileId, folder.path)) {
        return c.json({ error: 'A rule for this mail folder already exists' }, 409);
      }
      const row = insertMailRule(db, {
        profileId,
        appleFolderPath: folder.path,
        appleFolderName: folder.name,
        googleLabel: resolveGoogleLabel(folder),
        ...options.value,
      });
      return c.json(toMailRuleDto(row), 201);
    });
  });

  routes.patch('/:id/rules/mail/:ruleId', async (c) => {
    const rule = findMailRule(db, c.get('profile').id, c.req.param('ruleId'));
    if (!rule) {
      return c.json({ error: 'Rule not found' }, 404);
    }
    const body = await readObjectBody(c);
    if (!body) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const options = parseRuleOptions(body);
    if (!options.ok) {
      return c.json({ error: options.error }, 400);
    }
    return c.json(toMailRuleDto(updateMailRule(db, rule.id, options.value)), 200);
  });

  routes.delete('/:id/rules/mail/:ruleId', async (c) => {
    const profileId = c.get('profile').id;
    const rule = findMailRule(db, profileId, c.req.param('ruleId'));
    if (!rule) {
      return c.json({ error: 'Rule not found' }, 404);
    }
    const cleanup = c.req.query('cleanupGoogle');
    if (cleanup !== undefined && cleanup !== 'true' && cleanup !== 'false') {
      return c.json({ error: 'cleanupGoogle must be "true" or "false"' }, 400);
    }
    const remaining = () => listMailRules(db, profileId).filter((other) => other.id !== rule.id);

    // Default: keep the synced Gmail messages; the sync just stops managing this folder
    if (cleanup !== 'true') {
      return locks.run(profileId, async () => {
        forgetRuleFolder(db, profileId, rule);
        deleteMailRule(db, rule.id);
        dropOpenErrors(db, rule.id);
        return c.body(null, 204);
      });
    }
    return withConnectedProviders(
      c,
      async (providers) => {
        try {
          await removeRuleFromGoogle({ db, providers, profileId, rule, remaining: remaining() });
        } catch (error) {
          if (error instanceof GoogleAuthError) {
            throw error;
          }
          // Keep the rule so the cleanup can be retried
          return c.json({ error: 'Could not remove the synced emails from Gmail; the rule was kept' }, 502);
        }
        forgetRuleFolder(db, profileId, rule);
        deleteMailRule(db, rule.id);
        dropOpenErrors(db, rule.id);
        return c.body(null, 204);
      },
      { exclusive: true },
    );
  });

  return routes;
}
