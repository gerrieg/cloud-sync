import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

export const calendarSyncRules = sqliteTable(
  'calendar_sync_rules',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    appleCalendarUrl: text('apple_calendar_url').notNull(),
    appleCalendarName: text('apple_calendar_name').notNull(),
    appleReadOnly: integer('apple_read_only', { mode: 'boolean' }).notNull().default(false),
    googleCalendarId: text('google_calendar_id').notNull(),
    googleCalendarName: text('google_calendar_name').notNull(),
    direction: text('direction', { enum: ['one_way', 'bidirectional'] })
      .notNull()
      .default('one_way'),
    /** Days of history to sync; null means all history. */
    syncWindowDays: integer('sync_window_days').default(30),
    syncReminders: integer('sync_reminders', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Apple collection tag seen after the last fully successful run (change-detection cursor). */
    appleCtag: text('apple_ctag'),
    initialSyncCompletedAt: integer('initial_sync_completed_at'),
  },
  (table) => [
    uniqueIndex('calendar_sync_rules_pair_idx').on(
      table.profileId,
      table.appleCalendarUrl,
      table.googleCalendarId,
    ),
  ],
);

export const syncedEvents = sqliteTable(
  'synced_events',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id')
      .notNull()
      .references(() => calendarSyncRules.id, { onDelete: 'cascade' }),
    appleHref: text('apple_href').notNull(),
    appleUid: text('apple_uid').notNull(),
    appleEtag: text('apple_etag').notNull(),
    summary: text('summary').notNull(),
    googleEventId: text('google_event_id').notNull(),
    /** Google ids of overridden occurrences, keyed by the original start of the occurrence. */
    googleExceptionIds: text('google_exception_ids').notNull().default('{}'),
    foreignInvitation: integer('foreign_invitation', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [uniqueIndex('synced_events_rule_href_idx').on(table.ruleId, table.appleHref)],
);
