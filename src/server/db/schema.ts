import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  /** When a sync run last finished without errors; unlike `lastSyncAt`, failed runs do not move it. */
  lastSuccessfulSyncAt: integer('last_successful_sync_at'),
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
    /** Days of history to sync; null means all history (calendars: since 1 January 1990). */
    syncWindowDays: integer('sync_window_days').default(30),
    syncReminders: integer('sync_reminders', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Apple collection tag seen after the last fully successful run (change-detection cursor). */
    appleCtag: text('apple_ctag'),
    /** Google delta cursor of bidirectional rules; null forces a full re-reconciliation. */
    googleSyncToken: text('google_sync_token'),
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
    /** Content hash of the Google event as last written or read; tells our own echoes from real edits. */
    googleFingerprint: text('google_fingerprint').notNull().default(''),
  },
  (table) => [uniqueIndex('synced_events_rule_href_idx').on(table.ruleId, table.appleHref)],
);

export const contactSyncRules = sqliteTable(
  'contact_sync_rules',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** UID of the Apple contact group, or `all` for the whole address book ("All Contacts"). */
    appleGroupUid: text('apple_group_uid').notNull(),
    appleGroupName: text('apple_group_name').notNull(),
    googleGroupResourceName: text('google_group_resource_name').notNull(),
    googleGroupName: text('google_group_name').notNull(),
    direction: text('direction', { enum: ['one_way', 'bidirectional'] })
      .notNull()
      .default('one_way'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    initialSyncCompletedAt: integer('initial_sync_completed_at'),
  },
  (table) => [
    uniqueIndex('contact_sync_rules_pair_idx').on(
      table.profileId,
      table.appleGroupUid,
      table.googleGroupResourceName,
    ),
  ],
);

/** Contacts are deduplicated profile-wide: one record per Apple contact, whatever groups it is in. */
export const syncedContacts = sqliteTable(
  'synced_contacts',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    appleContactUid: text('apple_contact_uid').notNull(),
    appleHref: text('apple_href').notNull(),
    appleEtag: text('apple_etag').notNull(),
    summary: text('summary').notNull(),
    googleResourceName: text('google_resource_name').notNull(),
    /** Content hash of the Google contact as last written or read (tells echoes from real edits). */
    googleFingerprint: text('google_fingerprint').notNull().default(''),
    /** Hash of the Apple photo last uploaded to Google; equal hash means nothing to upload. */
    photoHash: text('photo_hash').notNull().default(''),
    /** JSON array of the Google labels (contact group resource names) this sync put on the contact. */
    labels: text('labels').notNull().default('[]'),
  },
  (table) => [uniqueIndex('synced_contacts_profile_uid_idx').on(table.profileId, table.appleContactUid)],
);

/** Profile-wide cursors of the contact sync. */
export const contactSyncState = sqliteTable('contact_sync_state', {
  profileId: text('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  appleCtag: text('apple_ctag'),
  googleSyncToken: text('google_sync_token'),
});

export const mailSyncRules = sqliteTable(
  'mail_sync_rules',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    appleFolderPath: text('apple_folder_path').notNull(),
    appleFolderName: text('apple_folder_name').notNull(),
    /** Target Gmail label: `INBOX`, `SENT` or the name of a custom label. */
    googleLabel: text('google_label').notNull(),
    /** Days of history to import; null means everything. */
    syncWindowDays: integer('sync_window_days').default(30),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  },
  (table) => [uniqueIndex('mail_sync_rules_folder_idx').on(table.profileId, table.appleFolderPath)],
);

/** Emails are deduplicated profile-wide: one record per message, whatever folders it is in. */
export const syncedEmails = sqliteTable(
  'synced_emails',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** Normalized `Message-ID`, or a SHA-256 over Date + From + Subject + Size when there is none. */
    messageIdKey: text('message_id_key').notNull(),
    summary: text('summary').notNull(),
    googleMessageId: text('google_message_id').notNull(),
    /** JSON array of `{ folder, uid }`: where the message currently sits in synced iCloud folders. */
    locations: text('locations').notNull().default('[]'),
    /** UID in the iCloud Trash folder once the message was moved there; null otherwise. */
    trashUid: integer('trash_uid'),
    seen: integer('seen', { mode: 'boolean' }).notNull(),
    flagged: integer('flagged', { mode: 'boolean' }).notNull(),
  },
  (table) => [uniqueIndex('synced_emails_profile_key_idx').on(table.profileId, table.messageIdKey)],
);

/** UIDVALIDITY of every mail folder seen, and how far the Trash folder has been read. */
export const mailFolderState = sqliteTable(
  'mail_folder_state',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    folderPath: text('folder_path').notNull(),
    uidValidity: integer('uid_validity').notNull(),
    /** Highest UID already examined (used for the Trash folder only). */
    lastUid: integer('last_uid').notNull().default(0),
  },
  (table) => [uniqueIndex('mail_folder_state_idx').on(table.profileId, table.folderPath)],
);

/** Google Calendar `events.watch` notification channels; the token Google echoes is stored encrypted. */
export const googleWatchChannels = sqliteTable('google_watch_channels', {
  /** Our own channel id, echoed by Google in `X-Goog-Channel-ID`. */
  id: text('id').primaryKey(),
  profileId: text('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  googleCalendarId: text('google_calendar_id').notNull(),
  /** Google's id of the watched resource; needed to stop the channel. */
  resourceId: text('resource_id').notNull(),
  tokenEnc: text('token_enc').notNull(),
  /** Epoch milliseconds at which Google lets the channel lapse. */
  expiresAt: integer('expires_at').notNull(),
  /** When Google first reached the webhook through this channel; null while that is unproven. */
  confirmedAt: integer('confirmed_at'),
});

/** The sync log: carried-over changes (`info`) and items that failed to sync (`error`). */
export const syncLogs = sqliteTable(
  'sync_logs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** Id of a calendar, contact or mail Sync Rule (see `entityType`); null when not attributable to one rule. */
    ruleId: text('rule_id'),
    entityType: text('entity_type', { enum: ['calendar', 'contact', 'email'] }).notNull(),
    level: text('level', { enum: ['info', 'error'] }).notNull(),
    action: text('action'),
    /** Event UID, contact UID or message key; null for errors of a whole rule or run. */
    itemKey: text('item_key'),
    summary: text('summary').notNull(),
    message: text('message').notNull().default(''),
    /** Time of the entry; a repeated error updates it to its latest occurrence. */
    createdAt: integer('created_at').notNull(),
    /** Set when a later run succeeded for the item; null while an error is open. */
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    index('sync_logs_profile_created_idx').on(table.profileId, table.createdAt),
    index('sync_logs_created_idx').on(table.createdAt),
    index('sync_logs_open_errors_idx').on(
      table.level,
      table.resolvedAt,
      table.profileId,
      table.entityType,
      table.itemKey,
    ),
  ],
);

/** One finished run of one kind of data of a Profile (not recorded for dry runs), for the Overview. */
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    domain: text('domain', { enum: ['calendars', 'contacts', 'mail'] }).notNull(),
    startedAt: integer('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    /** `skipped`: nothing to do (e.g. no change since the last run); `error`: at least one rule or item failed. */
    status: text('status', { enum: ['ok', 'skipped', 'error'] }).notNull(),
    created: integer('created').notNull(),
    updated: integer('updated').notNull(),
    deleted: integer('deleted').notNull(),
  },
  (table) => [index('sync_runs_profile_domain_started_idx').on(table.profileId, table.domain, table.startedAt)],
);

export const pendingDeleteApprovals = sqliteTable('pending_delete_approvals', {
  id: text('id').primaryKey(),
  profileId: text('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  domain: text('domain', { enum: ['calendar', 'contacts', 'mail'] })
    .notNull()
    .default('calendar'),
  /** The Sync Rule of a calendar batch; contact and mail batches are profile-wide and have none. */
  ruleId: text('rule_id').references(() => calendarSyncRules.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'approved', 'dismissed'] })
    .notNull()
    .default('pending'),
  /** JSON array with the full planned deletion batch, exactly as it will be executed on approval. */
  items: text('items').notNull(),
  createdAt: integer('created_at').notNull(),
  resolvedAt: integer('resolved_at'),
});
