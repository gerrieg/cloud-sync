import { Hono } from 'hono';
import type { ProfileOverviewDto, SyncAllResult } from '../../shared/profile.js';
import type { AppVariables } from '../app.js';
import type { AppDatabase } from '../db/index.js';
import { isActive, listProfiles, toProfileDto } from '../profiles/profile-store.js';
import type { RealtimeOrchestrator } from '../realtime/orchestrator.js';
import { countOpenErrors } from '../sync/sync-log-store.js';

export interface OverviewRouteDeps {
  readonly db: AppDatabase;
  readonly realtime: RealtimeOrchestrator;
}

/** Routes of the all-Profiles overview, mounted at `/api`. */
export function createOverviewRoutes(deps: OverviewRouteDeps): Hono<{ Variables: AppVariables }> {
  const { db, realtime } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get('/overview', (c) => {
    const openErrors = countOpenErrors(db);
    const cards: ProfileOverviewDto[] = listProfiles(db).map((profile) => ({
      profile: toProfileDto(profile),
      status: realtime.statusOf(profile),
      openErrors: openErrors.get(profile.id) ?? 0,
    }));
    return c.json(cards, 200);
  });

  routes.post('/sync-all', (c) => {
    const queued = listProfiles(db).filter(isActive).map((profile) => profile.id);
    for (const profileId of queued) {
      void realtime.requestSync(profileId, 'all');
    }
    const body: SyncAllResult = { queued };
    return c.json(body, 202);
  });

  return routes;
}
