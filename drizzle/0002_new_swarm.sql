CREATE TABLE `calendar_sync_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`apple_calendar_url` text NOT NULL,
	`apple_calendar_name` text NOT NULL,
	`apple_read_only` integer DEFAULT false NOT NULL,
	`google_calendar_id` text NOT NULL,
	`google_calendar_name` text NOT NULL,
	`direction` text DEFAULT 'one_way' NOT NULL,
	`sync_window_days` integer DEFAULT 30,
	`sync_reminders` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`apple_ctag` text,
	`initial_sync_completed_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_sync_rules_pair_idx` ON `calendar_sync_rules` (`profile_id`,`apple_calendar_url`,`google_calendar_id`);--> statement-breakpoint
CREATE TABLE `synced_events` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`apple_href` text NOT NULL,
	`apple_uid` text NOT NULL,
	`apple_etag` text NOT NULL,
	`summary` text NOT NULL,
	`google_event_id` text NOT NULL,
	`google_exception_ids` text DEFAULT '{}' NOT NULL,
	`foreign_invitation` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `calendar_sync_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `synced_events_rule_href_idx` ON `synced_events` (`rule_id`,`apple_href`);