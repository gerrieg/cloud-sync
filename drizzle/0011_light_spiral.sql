CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`domain` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`deleted` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_profile_domain_started_idx` ON `sync_runs` (`profile_id`,`domain`,`started_at`);