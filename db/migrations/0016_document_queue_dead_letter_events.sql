CREATE TABLE `document_queue_dead_letter_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`queue_name` text NOT NULL,
	`job_id` text,
	`job_generation` integer,
	`document_version_id` text,
	`input_sha256` text,
	`reason_code` text NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "document_queue_dead_letter_events_id_nonempty" CHECK(length(trim("document_queue_dead_letter_events"."id"))>0),
	CONSTRAINT "document_queue_dead_letter_events_message_id_safe" CHECK(length(trim("document_queue_dead_letter_events"."message_id")) BETWEEN 1 AND 128 AND instr("document_queue_dead_letter_events"."message_id", char(10))=0 AND instr("document_queue_dead_letter_events"."message_id", char(13))=0),
	CONSTRAINT "document_queue_dead_letter_events_queue_valid" CHECK("document_queue_dead_letter_events"."queue_name" IN ('mayisigorta-document-scan-dead-letter','mayisigorta-document-scan-dead-letter-overflow','mayisigorta-document-scan-dead-letter-terminal')),
	CONSTRAINT "document_queue_dead_letter_events_reason_valid" CHECK("document_queue_dead_letter_events"."reason_code" IN ('QUEUE_DELIVERY_EXHAUSTED','INVALID_QUEUE_MESSAGE')),
	CONSTRAINT "document_queue_dead_letter_events_job_binding_consistent" CHECK(("document_queue_dead_letter_events"."job_id" IS NULL AND "document_queue_dead_letter_events"."job_generation" IS NULL AND "document_queue_dead_letter_events"."document_version_id" IS NULL AND "document_queue_dead_letter_events"."input_sha256" IS NULL)
        OR ("document_queue_dead_letter_events"."job_id" IS NOT NULL AND length(trim("document_queue_dead_letter_events"."job_id"))>0 AND "document_queue_dead_letter_events"."job_generation">=1 AND "document_queue_dead_letter_events"."document_version_id" IS NOT NULL AND length(trim("document_queue_dead_letter_events"."document_version_id"))>0 AND "document_queue_dead_letter_events"."input_sha256" IS NOT NULL)),
	CONSTRAINT "document_queue_dead_letter_events_sha256_shape" CHECK("document_queue_dead_letter_events"."input_sha256" IS NULL OR (length("document_queue_dead_letter_events"."input_sha256")=64 AND "document_queue_dead_letter_events"."input_sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "document_queue_dead_letter_events_timestamp_valid" CHECK(length("document_queue_dead_letter_events"."received_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_queue_dead_letter_events"."received_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_queue_dead_letter_events"."received_at")="document_queue_dead_letter_events"."received_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_queue_dead_letter_events_queue_message_uq` ON `document_queue_dead_letter_events` (`queue_name`,`message_id`);--> statement-breakpoint
CREATE INDEX `document_queue_dead_letter_events_received_idx` ON `document_queue_dead_letter_events` (`received_at`,`reason_code`);--> statement-breakpoint
CREATE TRIGGER document_queue_dead_letter_events_immutable_update
BEFORE UPDATE ON document_queue_dead_letter_events
BEGIN
  SELECT RAISE(ABORT,'DOCUMENT_QUEUE_DEAD_LETTER_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER document_queue_dead_letter_events_immutable_delete
BEFORE DELETE ON document_queue_dead_letter_events
BEGIN
  SELECT RAISE(ABORT,'DOCUMENT_QUEUE_DEAD_LETTER_IMMUTABLE');
END;