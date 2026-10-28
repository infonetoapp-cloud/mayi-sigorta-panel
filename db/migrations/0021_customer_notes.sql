CREATE TABLE `customer_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`content` text NOT NULL,
	`author_user_id` text NOT NULL,
	`author_membership_id` text NOT NULL,
	`author_name` text,
	`operation_receipt_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`operation_receipt_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`author_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "customer_notes_id_nonempty" CHECK(length(trim("customer_notes"."id"))>0),
	CONSTRAINT "customer_notes_content_bounded" CHECK(length("customer_notes"."content") BETWEEN 1 AND 2000 AND length(trim("customer_notes"."content"))>0 AND instr("customer_notes"."content",char(0))=0),
	CONSTRAINT "customer_notes_author_name_bounded" CHECK("customer_notes"."author_name" IS NULL OR length("customer_notes"."author_name") BETWEEN 1 AND 200),
	CONSTRAINT "customer_notes_timestamp_valid" CHECK(length("customer_notes"."created_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"customer_notes"."created_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"customer_notes"."created_at")="customer_notes"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_notes_receipt_uq` ON `customer_notes` (`operation_receipt_id`);--> statement-breakpoint
CREATE INDEX `customer_notes_customer_time_idx` ON `customer_notes` (`agency_id`,`customer_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER customer_notes_validate_insert BEFORE INSERT ON customer_notes
WHEN NOT EXISTS (
  SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
  JOIN operation_receipts receipt ON receipt.id=NEW.operation_receipt_id
  WHERE m.id=NEW.author_membership_id AND m.user_id=NEW.author_user_id AND m.agency_id=NEW.agency_id
    AND NEW.author_name IS nullif(trim(u.display_name),'')
    AND receipt.agency_id=NEW.agency_id AND receipt.actor_user_id=NEW.author_user_id
    AND receipt.actor_membership_id=NEW.author_membership_id AND receipt.action='customer.note.create'
    AND receipt.status='COMPLETED' AND receipt.response_status=201
    AND receipt.created_at=NEW.created_at AND json_extract(receipt.response_body,'$.id')=NEW.id
)
BEGIN SELECT RAISE(ABORT,'CUSTOMER_NOTE_BINDING_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER customer_notes_immutable_update BEFORE UPDATE ON customer_notes
BEGIN SELECT RAISE(ABORT,'CUSTOMER_NOTE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER customer_notes_immutable_delete BEFORE DELETE ON customer_notes
BEGIN SELECT RAISE(ABORT,'CUSTOMER_NOTE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER customer_notes_no_replacement BEFORE INSERT ON customer_notes
WHEN EXISTS(SELECT 1 FROM customer_notes WHERE id=NEW.id OR operation_receipt_id=NEW.operation_receipt_id)
BEGIN SELECT RAISE(ABORT,'CUSTOMER_NOTE_IMMUTABLE'); END;