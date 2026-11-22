import { Hono } from 'hono';
import {
  ALL_CONTACTS_GROUP,
  type ContactGroupDiscovery,
  type ContactRuleCreate,
  type ContactRuleDto,
} from '../../shared/contacts.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import type { SyncProvidersFactory } from '../providers/types.js';
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
  type ContactRuleRow,
} from '../sync/contact-rules-store.js';
import { forgetRuleLabel, invalidateContactSync, removeRuleFromGoogle } from '../sync/contact-sync.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';
import { parseRuleOptions, registerRuleRoutes, type RuleKind } from './rule-routes.js';

type ContactRuleOptions = Pick<ContactRulePatch, 'direction' | 'enabled'>;

const contactRules: RuleKind<ContactRuleRow, ContactRuleOptions, ContactRuleDto> = {
  path: 'contacts',
  cleanupFailure: 'Could not remove the synced contacts from Google; the rule was kept',
  parseOptions: (body) => parseRuleOptions(body, ['direction', 'enabled']),
  list: listContactRules,
  find: findContactRule,
  toDto: toContactRuleDto,
  validateCreate: (body) => {
    const input = body as Partial<ContactRuleCreate>;
    return typeof input.appleGroupUid !== 'string' || typeof input.googleGroupResourceName !== 'string'
      ? 'appleGroupUid and googleGroupResourceName are required'
      : null;
  },
  async create({ db, providers, profileId }, body, options) {
    const { appleGroupUid, googleGroupResourceName } = body as unknown as ContactRuleCreate;
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
      return { ok: false, status: 400, error: 'Apple contact group not found' };
    }
    if (!googleGroup) {
      return { ok: false, status: 400, error: 'Google contact group not found' };
    }
    if (findContactRuleByPair(db, profileId, appleGroupUid, googleGroup.resourceName)) {
      return { ok: false, status: 409, error: 'A rule for this group pair already exists' };
    }
    const row = insertContactRule(db, {
      profileId,
      appleGroupUid,
      appleGroupName: appleGroup.name,
      googleGroupResourceName: googleGroup.resourceName,
      googleGroupName: googleGroup.name,
      ...options,
    });
    return { ok: true, row };
  },
  update: (db, rule, patch) => updateContactRule(db, rule.id, patch),
  remove: (db, rule) => deleteContactRule(db, rule.id),
  // The sync just stops managing this rule's label (a no-op after a cleanup, which stripped it already)
  forget: (db, profileId, rule, remaining) => forgetRuleLabel(db, profileId, rule, remaining),
  removeFromGoogle: removeRuleFromGoogle,
  invalidate: (db, rule) => invalidateContactSync(db, rule.profileId),
};

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

  registerRuleRoutes(routes, contactRules, { db, locks, withConnectedProviders });

  return routes;
}
