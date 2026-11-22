CREATE TABLE `google_watch_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`google_calendar_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`token_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
