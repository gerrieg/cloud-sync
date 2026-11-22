import { Hono } from 'hono';
import {
  LOG_ENTITY_TYPES,
  LOG_LEVELS,
  type LogEntityType,
  type LogLevel,
  type SyncLogDto,
  type SyncLogQuery,
} from '../../shared/logs.js';
import type { AppVariables } from '../app.js';
import type { AppDatabase } from '../db/index.js';
import { listProfiles } from '../profiles/profile-store.js';
import { loadRuleLabels } from '../sync/rule-labels.js';
import { listSyncLogs, MAX_LOG_LIMIT, type SyncLogRow } from '../sync/sync-log-store.js';

export interface LogRouteDeps {
  readonly db: AppDatabase;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function parseQuery(params: URLSearchParams): Parsed<SyncLogQuery> {
  const value: { -readonly [K in keyof SyncLogQuery]?: SyncLogQuery[K] } = {};
  const profileId = params.get('profileId');
  if (profileId) {
    value.profileId = profileId;
  }
  const entityType = params.get('entityType');
  if (entityType !== null) {
    if (!(LOG_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      return { ok: false, error: 'entityType must be "calendar", "contact" or "email"' };
    }
    value.entityType = entityType as LogEntityType;
  }
  const level = params.get('level');
  if (level !== null) {
    if (!(LOG_LEVELS as readonly string[]).includes(level)) {
      return { ok: false, error: 'level must be "info" or "error"' };
    }
    value.level = level as LogLevel;
  }
  const unresolvedOnly = params.get('unresolvedOnly');
  if (unresolvedOnly !== null) {
    if (unresolvedOnly !== 'true' && unresolvedOnly !== 'false') {
      return { ok: false, error: 'unresolvedOnly must be "true" or "false"' };
    }
    value.unresolvedOnly = unresolvedOnly === 'true';
  }
  const limit = params.get('limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LOG_LIMIT) {
      return { ok: false, error: `limit must be an integer between 1 and ${MAX_LOG_LIMIT}` };
    }
    value.limit = parsed;
  }
  return { ok: true, value };
}

/** `GET /api/logs`: the sync log across all Profiles, newest first. */
export function createLogRoutes(deps: LogRouteDeps): Hono<{ Variables: AppVariables }> {
  const { db } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get('/', (c) => {
    const query = parseQuery(new URL(c.req.url).searchParams);
    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    const profileNames = new Map(listProfiles(db).map((profile) => [profile.id, profile.name]));
    const ruleLabels = loadRuleLabels(db);
    const toDto = (row: SyncLogRow): SyncLogDto => ({
      id: row.id,
      profileId: row.profileId,
      profileName: profileNames.get(row.profileId) ?? '',
      ruleId: row.ruleId,
      ruleName: row.ruleId ? (ruleLabels.get(row.ruleId) ?? null) : null,
      entityType: row.entityType,
      level: row.level,
      action: row.action,
      itemKey: row.itemKey,
      summary: row.summary,
      message: row.message,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    });
    return c.json(listSyncLogs(db, query.value).map(toDto), 200);
  });

  return routes;
}
