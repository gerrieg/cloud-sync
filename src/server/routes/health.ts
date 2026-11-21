import type Database from 'better-sqlite3';
import { Hono } from 'hono';

export function createHealthRoutes(sqlite: Database.Database): Hono {
  const health = new Hono();

  health.get('/', (c) => {
    try {
      const row = sqlite.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      if (!row || row.ok !== 1) {
        return c.json({ status: 'error', database: 'error' }, 503);
      }
      return c.json({ status: 'ok', database: 'ok' }, 200);
    } catch {
      return c.json({ status: 'error', database: 'error' }, 503);
    }
  });

  return health;
}
