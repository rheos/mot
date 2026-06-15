CREATE TABLE `conversation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_conv_chat_recent` ON `conversation` (`chat_id`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_conv_session` ON `conversation` (`session_id`);