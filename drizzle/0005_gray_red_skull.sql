CREATE TABLE `mail_folder_state` (
	`profile_id` text NOT NULL,
	`folder_path` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`last_uid` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_folder_state_idx` ON `mail_folder_state` (`profile_id`,`folder_path`);--> statement-breakpoint
CREATE TABLE `mail_sync_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`apple_folder_path` text NOT NULL,
	`apple_folder_name` text NOT NULL,
	`google_label` text NOT NULL,
	`sync_window_days` integer DEFAULT 30,
	`delete_behavior` text DEFAULT 'trash' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_sync_rules_folder_idx` ON `mail_sync_rules` (`profile_id`,`apple_folder_path`);--> statement-breakpoint
CREATE TABLE `synced_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`message_id_key` text NOT NULL,
	`summary` text NOT NULL,
	`google_message_id` text NOT NULL,
	`locations` text DEFAULT '[]' NOT NULL,
	`trash_uid` integer,
	`seen` integer NOT NULL,
	`flagged` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `synced_emails_profile_key_idx` ON `synced_emails` (`profile_id`,`message_id_key`);