CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`apple_id` text,
	`apple_app_password_enc` text,
	`google_tokens_enc` text,
	`google_reauth_required` integer DEFAULT false NOT NULL,
	`trigger_token_enc` text NOT NULL,
	`last_sync_at` integer,
	`last_sync_status` text
);
