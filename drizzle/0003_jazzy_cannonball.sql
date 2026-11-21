CREATE TABLE `pending_delete_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`items` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_id`) REFERENCES `calendar_sync_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `calendar_sync_rules` ADD `google_sync_token` text;--> statement-breakpoint
ALTER TABLE `synced_events` ADD `google_fingerprint` text DEFAULT '' NOT NULL;