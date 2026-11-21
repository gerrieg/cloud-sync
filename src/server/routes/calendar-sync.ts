import { Hono, type Context } from 'hono';
import type {
  CalendarDiscovery,
  CalendarRuleCreate,
  SyncDirection,
} from '../../shared/calendar.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { updateProfile } from '../profiles/profile-store.js';
import { GoogleAuthError, type SyncProvidersFactory } from '../providers/types.js';
import { removeTrackedGoogleEvents, runCalendarSync } from '../sync/calendar-sync.js';
import { runContactSync } from '../sync/contact-sync.js';
import { listPendingApprovals, toApprovalDto } from '../sync/delete-guard.js';
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
} from '../sync/rules-store.js';
import { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Validates the options shared by rule creation and update. */
function parseRuleOptions(
  body: Record<string, unknown>,
): Parsed<Pick<RulePatch, 'direction' | 'syncWindowDays' | 'syncReminders' | 'enabled'>> {
  const value: { -readonly [K in 'direction' | 'syncWindowDays' | 'syncReminders' | 'enabled']?: RulePatch[K] } = {};

  if (body.direction !== undefined) {
    if (body.direction !== 'one_way' && body.direction !== 'bidirectional') {
      return { ok: false, error: 'direction must be "one_way" or "bidirectional"' };
    }
    value.direction = body.direction as SyncDirection;
  }
  if (body.syncWindowDays !== undefined) {
    const days = body.syncWindowDays;
    if (days !== null && !(typeof days === 'number' && Number.isInteger(days) && days > 0)) {
      return { ok: false, error: 'syncWindowDays must be a positive integer or null (all history)' };
    }
    value.syncWindowDays = days as number | null;
  }
  for (const key of ['syncReminders', 'enabled'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') {
        return { ok: false, error: `${key} must be a boolean` };
      }
      value[key] = body[key] as boolean;
    }
  }
  return { ok: true, value };
}

async function readObjectBody(c: Context<ProfileEnv>): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

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
        // `domain` narrows a run to one kind of data; without it everything is synced
        const domain = body?.domain === 'calendars' || body?.domain === 'contacts' ? body.domain : 'all';
        const force = body?.force === true;
        const calendars =
          domain === 'contacts'
            ? { dryRun, rules: [] }
            : await runCalendarSync({ db, clock, profile, appleId, providers, dryRun, force });
        const contacts =
          domain === 'calendars' ? null : await runContactSync({ db, clock, profile, providers, dryRun, force });
        if (!dryRun && (domain === 'contacts' || contacts?.status === 'error')) {
          updateProfile(db, profile.id, {
            lastSyncAt: clock.now(),
            lastSyncStatus: contacts?.status === 'error' || profile.lastSyncStatus === 'error' ? 'error' : 'ok',
          });
        }
        return c.json({ ...calendars, ...(contacts ? { contacts } : {}) }, 200);
      },
      { exclusive: true },
    );
  }

  routes.get('/:id/delete-approvals', (c) =>
    c.json(listPendingApprovals(db, c.get('profile').id).map((row) => toApprovalDto(db, row)), 200),
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

  routes.get('/:id/rules/calendars', (c) =>
    c.json(listRules(db, c.get('profile').id).map(toRuleDto), 200),
  );

  routes.post('/:id/rules/calendars', async (c) => {
    const body = await readObjectBody(c);
    if (!body) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const input = body as Partial<CalendarRuleCreate>;
    if (typeof input.appleCalendarUrl !== 'string' || typeof input.googleCalendarId !== 'string') {
      return c.json({ error: 'appleCalendarUrl and googleCalendarId are required' }, 400);
    }
    const options = parseRuleOptions(body);
    if (!options.ok) {
      return c.json({ error: options.error }, 400);
    }

    const profileId = c.get('profile').id;
    return withConnectedProviders(c, async (providers) => {
      const [apple, google] = await Promise.all([
        providers.apple.calendars.list(),
        providers.google.calendars.list(),
      ]);
      const appleCalendar = apple.find((calendar) => calendar.url === input.appleCalendarUrl);
      const googleCalendar = google.find((calendar) => calendar.id === input.googleCalendarId);
      if (!appleCalendar) {
        return c.json({ error: 'Apple calendar not found' }, 400);
      }
      if (!googleCalendar?.writable) {
        return c.json({ error: 'Google calendar not found or not writable' }, 400);
      }
      if (findRuleByPair(db, profileId, appleCalendar.url, googleCalendar.id)) {
        return c.json({ error: 'A rule for this calendar pair already exists' }, 409);
      }

      const { direction, syncWindowDays, syncReminders, enabled } = options.value;
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
      return c.json(toRuleDto(row), 201);
    });
  });

  routes.patch('/:id/rules/calendars/:ruleId', async (c) => {
    const rule = findRule(db, c.get('profile').id, c.req.param('ruleId'));
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

    const patch = options.value;
    return c.json(
      toRuleDto(
        updateRule(db, rule.id, {
          ...patch,
          ...(rule.appleReadOnly && patch.direction ? { direction: 'one_way' } : {}),
          // New options must be applied on the next run even though Apple itself did not change
          appleCtag: null,
        }),
      ),
      200,
    );
  });

  routes.delete('/:id/rules/calendars/:ruleId', async (c) => {
    const profileId = c.get('profile').id;
    const rule = findRule(db, profileId, c.req.param('ruleId'));
    if (!rule) {
      return c.json({ error: 'Rule not found' }, 404);
    }
    const cleanup = c.req.query('cleanupGoogle');
    if (cleanup !== undefined && cleanup !== 'true' && cleanup !== 'false') {
      return c.json({ error: 'cleanupGoogle must be "true" or "false"' }, 400);
    }

    // Default: keep the synced Google events; only the rule and its tracking records go away
    if (cleanup !== 'true') {
      return locks.run(profileId, async () => {
        deleteRule(db, rule.id);
        return c.body(null, 204);
      });
    }

    return withConnectedProviders(
      c,
      async (providers) => {
        try {
          await removeTrackedGoogleEvents({ db, providers, rule });
        } catch (error) {
          if (error instanceof GoogleAuthError) {
            throw error;
          }
          // Keep the rule so the remaining Google events stay tracked and the cleanup can be retried
          return c.json({ error: 'Could not remove the synced events from Google; the rule was kept' }, 502);
        }
        deleteRule(db, rule.id);
        return c.body(null, 204);
      },
      { exclusive: true },
    );
  });

  return routes;
}
