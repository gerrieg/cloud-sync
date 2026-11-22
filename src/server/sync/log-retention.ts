import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { AppDatabase } from '../db/index.js';
import { syncLogs } from '../db/schema.js';

const DAY_MS = 86_400_000;
const INFO_RETENTION_DAYS = 14;
const ERROR_RETENTION_DAYS = 30;
/** The most lines of the sync log one Profile may keep. */
const MAX_LOG_ROWS_PER_PROFILE = 10_000;

/**
 * Removes expired sync log lines (info after 14 days, errors after 30) and then trims every
 * Profile that still exceeds the row cap. The cap drops the oldest lines first and open errors last.
 */
export function pruneSyncLogs(db: AppDatabase, clock: Clock): void {
  const now = clock.now();
  db.delete(syncLogs)
    .where(
      or(
        and(eq(syncLogs.level, 'info'), lt(syncLogs.createdAt, now - INFO_RETENTION_DAYS * DAY_MS)),
        and(eq(syncLogs.level, 'error'), lt(syncLogs.createdAt, now - ERROR_RETENTION_DAYS * DAY_MS)),
      ),
    )
    .run();

  const crowded = db
    .select({ profileId: syncLogs.profileId, count: sql<number>`count(*)` })
    .from(syncLogs)
    .groupBy(syncLogs.profileId)
    .having(sql`count(*) > ${MAX_LOG_ROWS_PER_PROFILE}`)
    .all();
  for (const { profileId, count } of crowded) {
    db.run(sql`
      DELETE FROM sync_logs WHERE id IN (
        SELECT id FROM sync_logs WHERE profile_id = ${profileId}
        ORDER BY (level = 'error' AND resolved_at IS NULL), created_at, rowid
        LIMIT ${count - MAX_LOG_ROWS_PER_PROFILE}
      )
    `);
  }
}
