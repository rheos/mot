CREATE TABLE `memory_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`label_norm` text NOT NULL,
	`properties` text NOT NULL,
	`chat_id` text NOT NULL,
	`source_turn_id` integer NOT NULL,
	`source_session_id` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text NOT NULL,
	`ts` text NOT NULL,
	`superseded_by` integer,
	`conflict_flag` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`source_turn_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_digest` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`summary` text NOT NULL,
	`ts` text NOT NULL,
	`topics` text,
	`entity_draft` text,
	`procedural_raw` text,
	`parse_error` integer DEFAULT false NOT NULL,
	`turn_count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memory_lookup` ON `memory_items` (`type`,`label_norm`,`superseded_by`);--> statement-breakpoint
CREATE INDEX `idx_memory_chat_active` ON `memory_items` (`chat_id`,`superseded_by`,`conflict_flag`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_digest_session_id_unique` ON `session_digest` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_digest_chat_ts` ON `session_digest` (`chat_id`,`ts`);