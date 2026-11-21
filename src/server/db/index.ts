import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseContext {
  readonly sqlite: Database.Database;
  readonly db: AppDatabase;
  close(): void;
}

const DEFAULT_MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle',
);

export function createDatabase(
  databasePath: string,
  options?: { migrationsFolder?: string },
): DatabaseContext {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const sqlite = new Database(databasePath);
  if (databasePath !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  const migrationsFolder = options?.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  migrate(db, { migrationsFolder });

  // Ensure singleton totp_state row exists for atomic single-use / lockout updates
  sqlite
    .prepare('INSERT OR IGNORE INTO totp_state (id, failed_attempts) VALUES (1, 0)')
    .run();

  return {
    sqlite,
    db,
    close() {
      if (sqlite.open) {
        sqlite.close();
      }
    },
  };
}
