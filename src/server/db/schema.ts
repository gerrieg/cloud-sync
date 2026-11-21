import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';

export const totpState = sqliteTable('totp_state', {
  id: integer('id').primaryKey(),
  lastStep: integer('last_step'),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until'),
});
