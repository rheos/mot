CREATE TABLE `app_secret` (
	`id` integer PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `classification_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`signal_fingerprint` text NOT NULL,
	`ministry_out` text NOT NULL,
	`ticket_type_out` text NOT NULL,
	`severity_out` text NOT NULL,
	`confidence` real NOT NULL,
	`action` text NOT NULL,
	`ticket_id` text,
	`model_version` text NOT NULL,
	`prompt_hash` text,
	`corrected_ministry` text,
	`corrected_severity` text,
	`corrected_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `comment` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`ministry` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`severity` text NOT NULL,
	`ticket_type` text NOT NULL,
	`provenance` text NOT NULL,
	`source_ref` text,
	`dedup_key` text,
	`body` text NOT NULL,
	`private` integer DEFAULT false NOT NULL,
	`needs_review` integer DEFAULT false NOT NULL,
	`event_count` integer DEFAULT 1 NOT NULL,
	`snoozed_until` text,
	`blocked_note` text,
	`linked_ticket_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`linked_ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ticket_dedup_key` ON `ticket` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `idx_ticket_triage` ON `ticket` (`status`,`severity`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_ticket_snooze` ON `ticket` (`status`,`snoozed_until`);