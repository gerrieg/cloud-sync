import type { Context, Hono } from 'hono';
import type { SyncDirection } from '../../shared/calendar.js';
import type { AppDatabase } from '../db/index.js';
import { GoogleAuthError, type SyncProviders } from '../providers/types.js';
import type { ProfileLocks } from '../sync/profile-locks.js';
import { dropOpenErrors } from '../sync/sync-log-store.js';
import type { createConnectedProviders } from './connected-providers.js';
import type { ProfileEnv } from './profile-context.js';

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export async function readObjectBody(c: Context<ProfileEnv>): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** The options a Sync Rule of any kind can carry, with what a request may set them to. */
interface RuleOptionValues {
  readonly direction: SyncDirection;
  /** Days of history; null means all of it. */
  readonly syncWindowDays: number | null;
  readonly syncReminders: boolean;
  readonly deleteBehavior: 'trash' | 'delete';
  readonly enabled: boolean;
}

/** Each check returns the valid value, or an error message when the value is none. */
const optionChecks: { readonly [K in keyof RuleOptionValues]: (value: unknown) => RuleOptionValues[K] | { error: string } } = {
  direction: (value) =>
    value === 'one_way' || value === 'bidirectional' ? value : { error: 'direction must be "one_way" or "bidirectional"' },
  syncWindowDays: (value) =>
    value === null || (typeof value === 'number' && Number.isInteger(value) && value > 0)
      ? value
      : { error: 'syncWindowDays must be a positive integer or null (all history)' },
  syncReminders: (value) => (typeof value === 'boolean' ? value : { error: 'syncReminders must be a boolean' }),
  deleteBehavior: (value) =>
    value === 'trash' || value === 'delete' ? value : { error: 'deleteBehavior must be "trash" or "delete"' },
  enabled: (value) => (typeof value === 'boolean' ? value : { error: 'enabled must be a boolean' }),
};

/**
 * Validates the options of a rule creation or update request: of the `accepted` options, those the
 * body carries must be valid (checked in the order given); the others stay unset.
 */
export function parseRuleOptions<K extends keyof RuleOptionValues>(
  body: Record<string, unknown>,
  accepted: readonly K[],
): Parsed<{ [P in K]?: RuleOptionValues[P] }> {
  const value: { [P in K]?: RuleOptionValues[P] } = {};
  for (const key of accepted) {
    if (body[key] === undefined) {
      continue;
    }
    const checked = optionChecks[key](body[key]);
    if (typeof checked === 'object' && checked !== null && 'error' in checked) {
      return { ok: false, error: checked.error };
    }
    value[key] = checked as RuleOptionValues[K];
  }
  return { ok: true, value };
}

type CreateResult<Row> =
  | { readonly ok: true; readonly row: Row }
  | { readonly ok: false; readonly status: 400 | 409; readonly error: string };

/** What differs between the Sync Rules of calendars, contacts and mail; the lifecycle is shared. */
export interface RuleKind<Row extends { readonly id: string; readonly profileId: string }, Patch, Dto> {
  /** The path segment of the kind: `/:id/rules/<path>`. */
  readonly path: string;
  /** The message of the 502 when the rule's data could not be removed from Google. */
  readonly cleanupFailure: string;
  readonly parseOptions: (body: Record<string, unknown>) => Parsed<Patch>;
  readonly list: (db: AppDatabase, profileId: string) => Row[];
  readonly find: (db: AppDatabase, profileId: string, ruleId: string) => Row | undefined;
  readonly toDto: (row: Row) => Dto;
  /** The error message when `body` lacks what no rule of this kind can be created without. */
  readonly validateCreate: (body: Record<string, unknown>) => string | null;
  /** Looks the containers up on both sides and, when they are fine, inserts the rule. */
  readonly create: (
    env: { readonly db: AppDatabase; readonly providers: SyncProviders; readonly profileId: string },
    body: Record<string, unknown>,
    options: Patch,
  ) => Promise<CreateResult<Row>>;
  readonly update: (db: AppDatabase, rule: Row, patch: Patch) => Row;
  readonly remove: (db: AppDatabase, rule: Row) => void;
  /** The sync stops managing the rule's container; what it has synced stays in Google. */
  readonly forget: (db: AppDatabase, profileId: string, rule: Row, remaining: Row[]) => void;
  /** Cleanup opt-in: removes what the rule synced from Google. Safe to retry. */
  readonly removeFromGoogle: (env: {
    readonly db: AppDatabase;
    readonly providers: SyncProviders;
    readonly profileId: string;
    readonly rule: Row;
    readonly remaining: Row[];
  }) => Promise<void>;
  /**
   * Called after a rule was created, changed or removed: makes the next run look at everything
   * again, as an unchanged Apple side must not hide a changed rule. `rule` may no longer exist.
   */
  readonly invalidate: (db: AppDatabase, rule: Row) => void;
}

/**
 * `/:id/rules/<path>`: list, create, update and delete the Sync Rules of one kind. Deleting keeps
 * what was synced in Google unless `cleanupGoogle=true`, which removes it first and keeps the rule
 * when that fails.
 */
export function registerRuleRoutes<Row extends { readonly id: string; readonly profileId: string }, Patch, Dto>(
  routes: Hono<ProfileEnv>,
  kind: RuleKind<Row, Patch, Dto>,
  deps: {
    readonly db: AppDatabase;
    readonly locks: ProfileLocks;
    readonly withConnectedProviders: ReturnType<typeof createConnectedProviders>;
  },
): void {
  const { db, locks, withConnectedProviders } = deps;
  const path = `/:id/rules/${kind.path}`;

  routes.get(path, (c) => c.json(kind.list(db, c.get('profile').id).map(kind.toDto), 200));

  routes.post(path, async (c) => {
    const body = await readObjectBody(c);
    if (!body) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const invalid = kind.validateCreate(body);
    if (invalid) {
      return c.json({ error: invalid }, 400);
    }
    const options = kind.parseOptions(body);
    if (!options.ok) {
      return c.json({ error: options.error }, 400);
    }
    const profileId = c.get('profile').id;
    return withConnectedProviders(c, async (providers) => {
      const created = await kind.create({ db, providers, profileId }, body, options.value);
      if (!created.ok) {
        return c.json({ error: created.error }, created.status);
      }
      kind.invalidate(db, created.row);
      return c.json(kind.toDto(created.row), 201);
    });
  });

  routes.patch(`${path}/:ruleId`, async (c) => {
    const rule = kind.find(db, c.get('profile').id, c.req.param('ruleId'));
    if (!rule) {
      return c.json({ error: 'Rule not found' }, 404);
    }
    const body = await readObjectBody(c);
    if (!body) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const options = kind.parseOptions(body);
    if (!options.ok) {
      return c.json({ error: options.error }, 400);
    }
    const updated = kind.update(db, rule, options.value);
    kind.invalidate(db, updated);
    return c.json(kind.toDto(updated), 200);
  });

  routes.delete(`${path}/:ruleId`, async (c) => {
    const profileId = c.get('profile').id;
    const rule = kind.find(db, profileId, c.req.param('ruleId'));
    if (!rule) {
      return c.json({ error: 'Rule not found' }, 404);
    }
    const cleanup = c.req.query('cleanupGoogle');
    if (cleanup !== undefined && cleanup !== 'true' && cleanup !== 'false') {
      return c.json({ error: 'cleanupGoogle must be "true" or "false"' }, 400);
    }
    const remaining = () => kind.list(db, profileId).filter((other) => other.id !== rule.id);
    const finish = () => {
      kind.forget(db, profileId, rule, remaining());
      kind.remove(db, rule);
      dropOpenErrors(db, rule.id);
      kind.invalidate(db, rule);
      return c.body(null, 204);
    };

    if (cleanup !== 'true') {
      return locks.run(profileId, async () => finish());
    }
    return withConnectedProviders(
      c,
      async (providers) => {
        try {
          await kind.removeFromGoogle({ db, providers, profileId, rule, remaining: remaining() });
        } catch (error) {
          if (error instanceof GoogleAuthError) {
            throw error;
          }
          // Keep the rule so what is left in Google stays tracked and the cleanup can be retried
          return c.json({ error: kind.cleanupFailure }, 502);
        }
        return finish();
      },
      { exclusive: true },
    );
  });
}
