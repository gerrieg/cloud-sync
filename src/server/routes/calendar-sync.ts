import { Hono, type Context } from 'hono';
import type { CalendarDiscovery, CalendarRuleCreate, CalendarRuleDto } from '../../shared/calendar.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import type { SyncProvidersFactory } from '../providers/types.js';
import { invalidateCalendarRule, removeTrackedGoogleEvents } from '../sync/calendar-sync.js';
import { listPendingBatches } from '../sync/delete-approvals.js';
import { runProfileSync } from '../sync/profile-sync.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import {
  findRule,
  deleteRule,
  findRuleByPair,
  insertRule,
  listRules,
  toRuleDto,
  updateRule,
  type RulePatch,
  type RuleRow,
} from '../sync/rules-store.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';
import { parseRuleOptions, readObjectBody, registerRuleRoutes, type RuleKind } from './rule-routes.js';

type CalendarRulePatch = Pick<RulePatch, 'direction' | 'syncWindowDays' | 'syncReminders' | 'enabled'>;

const calendarRules: RuleKind<RuleRow, CalendarRulePatch, CalendarRuleDto> = {
  path: 'calendars',
  cleanupFailure: 'Could not remove the synced events from Google; the rule was kept',
  parseOptions: (body) => parseRuleOptions(body, ['direction', 'syncWindowDays', 'syncReminders', 'enabled']),
  list: listRules,
  find: findRule,
  toDto: toRuleDto,
  validateCreate: (body) => {
    const input = body as Partial<CalendarRuleCreate>;
    return typeof input.appleCalendarUrl !== 'string' || typeof input.googleCalendarId !== 'string'
      ? 'appleCalendarUrl and googleCalendarId are required'
      : null;
  },
  async create({ db, providers, profileId }, body, options) {
    const input = body as Partial<CalendarRuleCreate>;
    const [apple, google] = await Promise.all([providers.apple.calendars.list(), providers.google.calendars.list()]);
    const appleCalendar = apple.find((calendar) => calendar.url === input.appleCalendarUrl);
    const googleCalendar = google.find((calendar) => calendar.id === input.googleCalendarId);
    if (!appleCalendar) {
      return { ok: false, status: 400, error: 'Apple calendar not found' };
    }
    if (!googleCalendar?.writable) {
      return { ok: false, status: 400, error: 'Google calendar not found or not writable' };
    }
    if (findRuleByPair(db, profileId, appleCalendar.url, googleCalendar.id)) {
      return { ok: false, status: 409, error: 'A rule for this calendar pair already exists' };
    }
    const { direction, syncWindowDays, syncReminders, enabled } = options;
    const row = insertRule(db, {
      profileId,
      appleCalendarUrl: appleCalendar.url,
      appleCalendarName: appleCalendar.name,
      appleReadOnly: appleCalendar.readOnly,
      googleCalendarId: googleCalendar.id,
      googleCalendarName: googleCalendar.name,
      // Read-only and subscribed Apple calendars can never receive Google changes
      direction: appleCalendar.readOnly ? 'one_way' : (direction ?? 'one_way'),
      ...(syncWindowDays !== undefined ? { syncWindowDays } : {}),
      ...(syncReminders !== undefined ? { syncReminders } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    return { ok: true, row };
  },
  update: (db, rule, patch) =>
    updateRule(db, rule.id, { ...patch, ...(rule.appleReadOnly && patch.direction ? { direction: 'one_way' } : {}) }),
  remove: (db, rule) => deleteRule(db, rule.id),
  // The synced events stay in Google; the rule's tracking records go with the rule
  forget: () => undefined,
  removeFromGoogle: ({ db, providers, rule }) => removeTrackedGoogleEvents({ db, providers, rule }),
  invalidate: invalidateCalendarRule,
};

export interface CalendarRouteDeps {
  readonly config: AppConfig;
  readonly db: AppDatabase;
  readonly clock: Clock;
  readonly locks: ProfileLocks;
  readonly createSyncProviders: SyncProvidersFactory;
}

export function createCalendarRoutes(deps: CalendarRouteDeps): Hono<ProfileEnv> {
  const { config, db, clock, locks, createSyncProviders } = deps;
  const routes = new Hono<ProfileEnv>();

  const withConnectedProviders = createConnectedProviders({ config, db, locks, createSyncProviders });

  async function runSync(c: Context<ProfileEnv>, dryRun: boolean): Promise<Response> {
    const body = await readObjectBody(c);
    return withConnectedProviders(
      c,
      async (providers, profile, appleId) => {
        if (!dryRun && !profile.enabled) {
          return c.json({ error: 'This Profile is paused' }, 409);
        }
        const domain =
          body?.domain === 'calendars' || body?.domain === 'contacts' || body?.domain === 'mail' ? body.domain : 'all';
        const result = await runProfileSync({
          db,
          clock,
          profile,
          appleId,
          providers,
          domain,
          dryRun,
          force: body?.force === true,
        });
        return c.json(result, 200);
      },
      { exclusive: true },
    );
  }

  routes.get('/:id/delete-approvals', (c) =>
    c.json(listPendingBatches(db, c.get('profile').id), 200),
  );

  routes.post('/:id/sync', (c) => runSync(c, false));
  routes.post('/:id/dry-run', (c) => runSync(c, true));

  routes.get('/:id/discover/calendars', (c) =>
    withConnectedProviders(c, async (providers) => {
      const [apple, google] = await Promise.all([
        providers.apple.calendars.list(),
        providers.google.calendars.list(),
      ]);
      const body: CalendarDiscovery = {
        apple: apple.map(({ url, name, readOnly, subscribed }) => ({ url, name, readOnly, subscribed })),
        google,
      };
      return c.json(body, 200);
    }),
  );

  registerRuleRoutes(routes, calendarRules, { db, clock, locks, withConnectedProviders });

  return routes;
}
