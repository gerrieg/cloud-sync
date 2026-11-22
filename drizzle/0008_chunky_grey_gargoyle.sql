CREATE TABLE `sync_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`rule_id` text,
	`entity_type` text NOT NULL,
	`level` text NOT NULL,
	`action` text,
	`item_key` text,
	`summary` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_logs_profile_created_idx` ON `sync_logs` (`profile_id`,`created_at`);