ALTER TABLE `renewal_generation_cursors` ADD `continuation_json` text;
--> statement-breakpoint
ALTER TABLE `renewal_generation_cursors` ADD `last_attempt_order` integer DEFAULT 0 NOT NULL;