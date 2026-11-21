CREATE TABLE `contact_sync_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`apple_group_uid` text NOT NULL,
	`apple_group_name` text NOT NULL,
	`google_group_resource_name` text NOT NULL,
	`google_group_name` text NOT NULL,
	`direction` text DEFAULT 'one_way' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`initial_sync_completed_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_sync_rules_pair_idx` ON `contact_sync_rules` (`profile_id`,`apple_group_uid`,`google_group_resource_name`);--> statement-breakpoint
CREATE TABLE `contact_sync_state` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`apple_ctag` text,
	`google_sync_token` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `synced_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`apple_contact_uid` text NOT NULL,
	`apple_href` text NOT NULL,
	`apple_etag` text NOT NULL,
	`summary` text NOT NULL,
	`google_resource_name` text NOT NULL,
	`google_fingerprint` text DEFAULT '' NOT NULL,
	`photo_hash` text DEFAULT '' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `synced_contacts_profile_uid_idx` ON `synced_contacts` (`profile_id`,`apple_contact_uid`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_delete_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`domain` text DEFAULT 'calendar' NOT NULL,
	`rule_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`items` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_id`) REFERENCES `calendar_sync_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_pending_delete_approvals`("id", "profile_id", "domain", "rule_id", "status", "items", "created_at", "resolved_at") SELECT "id", "profile_id", 'calendar', "rule_id", "status", "items", "created_at", "resolved_at" FROM `pending_delete_approvals`;--> statement-breakpoint
DROP TABLE `pending_delete_approvals`;--> statement-breakpoint
ALTER TABLE `__new_pending_delete_approvals` RENAME TO `pending_delete_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;