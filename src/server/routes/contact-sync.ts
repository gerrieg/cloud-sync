import { Hono, type Context } from 'hono';
import {
  ALL_CONTACTS_GROUP,
  type ContactGroupDiscovery,
  type ContactRuleCreate,
} from '../../shared/contacts.js';
import type { SyncDirection } from '../../shared/calendar.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { GoogleAuthError, type SyncProvidersFactory } from '../providers/types.js';
import { readAddressBook } from '../sync/address-book.js';
import {
  deleteContactRule,
  findContactRule,
  findContactRuleByPair,
  insertContactRule,
  listContactRules,
  toContactRuleDto,
  updateContactRule,
  type ContactRulePatch,
} from '../sync/contact-rules-store.js';
import { forgetRuleLabel, removeRuleFromGoogle } from '../sync/contact-sync.js';
import { setContactCursor } from '../sync/contact-store.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Validates the options shared by rule creation and update. */
function parseRuleOptions(body: Record<string, unknown>): Parsed<Pick<ContactRulePatch, 'direction' | 'enabled'>> {
  const value: { -readonly [K in 'direction' | 'enabled']?: ContactRulePatch[K] } = {};
  if (body.direction !== undefined) {
    if (body.direction !== 'one_way' && body.direction !== 'bidirectional') {
      return { ok: false, error: 'direction must be "one_way" or "bidirectional"' };
    }
    value.direction = body.direction as SyncDirection;
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

export interface ContactRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

export function createContactRoutes(deps: ContactRouteDeps): Hono<ProfileEnv> {
  const { db, locks } = deps;
  const withConnectedProviders = createConnectedProviders(deps);
  const routes = new Hono<ProfileEnv>();

  routes.get('/:id/discover/contact-groups', (c) =>
    withConnectedProviders(c, async (providers) => {
      const [book, google] = await Promise.all([
        providers.apple.contacts.list(),
        providers.google.contacts.listGroups(),
      ]);
      const body: ContactGroupDiscovery = {
        apple: [
          { uid: ALL_CONTACTS_GROUP, name: 'All Contacts' },
          ...[...readAddressBook(book).groups.values()].map(({ card }) => ({ uid: card.uid, name: card.name })),
        ],
        google,
      };
      return c.json(body, 200);
    }),
  );

  routes.get('/:id/rules/contacts', (c) =>
    c.json(listContactRules(db, c.get('profile').id).map(toContactRuleDto), 200),
  );

  routes.post('/:id/rules/contacts', async (c) => {
    const body = await readObjectBody(c);
    if (!body) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const input = body as Partial<ContactRuleCreate>;
    if (typeof input.appleGroupUid !== 'string' || typeof input.googleGroupResourceName !== 'string') {
      return c.json({ error: 'appleGroupUid and googleGroupResourceName are required' }, 400);
    }
    const options = parseRuleOptions(body);
    if (!options.ok) {
      return c.json({ error: options.error }, 400);
    }
    const { appleGroupUid, googleGroupResourceName } = input;

    const profileId = c.get('profile').id;
    return withConnectedProviders(c, async (providers) => {
      const [book, googleGroups] = await Promise.all([
        providers.apple.contacts.list(),
        providers.google.contacts.listGroups(),
      ]);
      const appleGroup =
        appleGroupUid === ALL_CONTACTS_GROUP
          ? { uid: ALL_CONTACTS_GROUP, name: 'All Contacts' }
          : readAddressBook(book).groups.get(appleGroupUid)?.card;
      const googleGroup = googleGroups.find((group) => group.resourceName === googleGroupResourceName);
      if (!appleGroup) {
        return c.json({ error: 'Apple contact group not found' }, 400);
      }
      if (!googleGroup) {
        return c.json({ error: 'Google contact group not found' }, 400);
      }
      if (findContactRuleByPair(db, profileId, appleGroupUid, googleGroup.resourceName)) {
        return c.json({ error: 'A rule for this group pair already exists' }, 409);
      }
      const row = insertContactRule(db, {
        profileId,
        appleGroupUid,
        appleGroupName: appleGroup.name,
        googleGroupResourceName: googleGroup.resourceName,
        googleGroupName: googleGroup.name,
        ...options.value,
      });
      setContactCursor(db, profileId, { appleCtag: null });
      return c.json(toContactRuleDto(row), 201);
    });
  });

  routes.patch('/:id/rules/contacts/:ruleId', async (c) => {
    const rule = findContactRule(db, c.get('profile').id, c.req.param('ruleId'));
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
    const updated = updateContactRule(db, rule.id, options.value);
    // New options must be applied on the next run even though Apple itself did not change
    setContactCursor(db, rule.profileId, { appleCtag: null });
    return c.json(toContactRuleDto(updated), 200);
  });

  routes.delete('/:id/rules/contacts/:ruleId', async (c) => {
    const profileId = c.get('profile').id;
    const rule = findContactRule(db, profileId, c.req.param('ruleId'));
    if (!rule) {
      return c.json({ error: 'Rule not found' }, 404);
    }
    const cleanup = c.req.query('cleanupGoogle');
    if (cleanup !== undefined && cleanup !== 'true' && cleanup !== 'false') {
      return c.json({ error: 'cleanupGoogle must be "true" or "false"' }, 400);
    }
    const finish = () => {
      deleteContactRule(db, rule.id);
      setContactCursor(db, profileId, { appleCtag: null });
      return c.body(null, 204);
    };
    const remaining = () => listContactRules(db, profileId).filter((other) => other.id !== rule.id);

    // Default: keep the synced Google contacts; the sync just stops managing this rule's label
    if (cleanup !== 'true') {
      return locks.run(profileId, async () => {
        forgetRuleLabel(db, profileId, rule, remaining());
        return finish();
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
          return c.json({ error: 'Could not remove the synced contacts from Google; the rule was kept' }, 502);
        }
        return finish();
      },
      { exclusive: true },
    );
  });

  return routes;
}
