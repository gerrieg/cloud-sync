import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const totpState = sqliteTable('totp_state', {
  id: integer('id').primaryKey(),
  lastStep: integer('last_step'),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until'),
});

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  appleId: text('apple_id'),
  appleAppPasswordEnc: text('apple_app_password_enc'),
  googleTokensEnc: text('google_tokens_enc'),
  googleReauthRequired: integer('google_reauth_required', { mode: 'boolean' })
    .notNull()
    .default(false),
  triggerTokenEnc: text('trigger_token_enc').notNull(),
  lastSyncAt: integer('last_sync_at'),
  lastSyncStatus: text('last_sync_status'),
});
