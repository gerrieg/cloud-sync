CREATE TABLE `totp_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_step` integer,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer
);
