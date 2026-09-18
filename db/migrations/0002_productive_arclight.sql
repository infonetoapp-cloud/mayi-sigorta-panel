CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`idempotency_key` text,
	`outcome` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_membership_id`) REFERENCES `agency_memberships`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "audit_events_id_nonempty" CHECK(length(trim("audit_events"."id")) > 0),
	CONSTRAINT "audit_events_action_nonempty" CHECK(length(trim("audit_events"."action")) > 0),
	CONSTRAINT "audit_events_target_type_nonempty" CHECK(length(trim("audit_events"."target_type")) > 0),
	CONSTRAINT "audit_events_target_id_nonempty" CHECK(length(trim("audit_events"."target_id")) > 0),
	CONSTRAINT "audit_events_correlation_id_nonempty" CHECK(length(trim("audit_events"."correlation_id")) > 0),
	CONSTRAINT "audit_events_outcome_valid" CHECK("audit_events"."outcome" IN ('SUCCESS', 'FAILURE'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_agency_created_idx` ON `audit_events` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_created_idx` ON `audit_events` (`actor_membership_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_target_idx` ON `audit_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_events_correlation_idx` ON `audit_events` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `operation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`action` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`response_status` integer,
	`response_body` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_membership_id`) REFERENCES `agency_memberships`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "operation_receipts_id_nonempty" CHECK(length(trim("operation_receipts"."id")) > 0),
	CONSTRAINT "operation_receipts_action_nonempty" CHECK(length(trim("operation_receipts"."action")) > 0),
	CONSTRAINT "operation_receipts_key_nonempty" CHECK(length(trim("operation_receipts"."idempotency_key")) > 0),
	CONSTRAINT "operation_receipts_fingerprint_nonempty" CHECK(length(trim("operation_receipts"."payload_fingerprint")) > 0),
	CONSTRAINT "operation_receipts_status_valid" CHECK("operation_receipts"."status" IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
	CONSTRAINT "operation_receipts_timestamps_ordered" CHECK("operation_receipts"."updated_at" >= "operation_receipts"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_receipts_idem_uq` ON `operation_receipts` (`agency_id`,`actor_user_id`,`actor_membership_id`,`action`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `operation_receipts_agency_idx` ON `operation_receipts` (`agency_id`);--> statement-breakpoint
CREATE TABLE `sensitive_action_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`evidence_hash` text NOT NULL,
	`agency_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`action` text NOT NULL,
	`payload_hash` text NOT NULL,
	`target_ids_json` text NOT NULL,
	`expected_target_version` integer,
	`permission_version` integer NOT NULL,
	`assurance` text DEFAULT 'SECURE_GRANT' NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`issued_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`revoked_at` text,
	`consumed_operation_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_membership_id`) REFERENCES `agency_memberships`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "sensitive_action_grants_id_nonempty" CHECK(length(trim("sensitive_action_grants"."id")) > 0),
	CONSTRAINT "sensitive_action_grants_evidence_shape" CHECK(length("sensitive_action_grants"."evidence_hash") = 64),
	CONSTRAINT "sensitive_action_grants_action_nonempty" CHECK(length(trim("sensitive_action_grants"."action")) > 0),
	CONSTRAINT "sensitive_action_grants_payload_shape" CHECK(length("sensitive_action_grants"."payload_hash") = 64),
	CONSTRAINT "sensitive_action_grants_permission_version_positive" CHECK("sensitive_action_grants"."permission_version" > 0),
	CONSTRAINT "sensitive_action_grants_assurance_valid" CHECK("sensitive_action_grants"."assurance" = 'SECURE_GRANT'),
	CONSTRAINT "sensitive_action_grants_status_valid" CHECK("sensitive_action_grants"."status" IN ('ISSUED', 'CONSUMED', 'REVOKED')),
	CONSTRAINT "sensitive_action_grants_expiry_ordered" CHECK("sensitive_action_grants"."expires_at" > "sensitive_action_grants"."issued_at"),
	CONSTRAINT "sensitive_action_grants_ttl_valid" CHECK((strftime('%s', "sensitive_action_grants"."expires_at") - strftime('%s', "sensitive_action_grants"."issued_at")) <= 180 AND (strftime('%s', "sensitive_action_grants"."expires_at") - strftime('%s', "sensitive_action_grants"."issued_at")) >= 1),
	CONSTRAINT "sensitive_action_grants_timestamps_ordered" CHECK("sensitive_action_grants"."updated_at" >= "sensitive_action_grants"."created_at"),
	CONSTRAINT "sensitive_action_grants_lifecycle_consistent" CHECK(("sensitive_action_grants"."status" = 'ISSUED' AND "sensitive_action_grants"."consumed_at" IS NULL AND "sensitive_action_grants"."revoked_at" IS NULL AND "sensitive_action_grants"."consumed_operation_id" IS NULL)
          OR ("sensitive_action_grants"."status" = 'CONSUMED' AND "sensitive_action_grants"."consumed_at" IS NOT NULL AND "sensitive_action_grants"."revoked_at" IS NULL)
          OR ("sensitive_action_grants"."status" = 'REVOKED' AND "sensitive_action_grants"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sensitive_action_grants_evidence_uq` ON `sensitive_action_grants` (`evidence_hash`);--> statement-breakpoint
CREATE INDEX `sensitive_action_grants_lookup_idx` ON `sensitive_action_grants` (`agency_id`,`actor_membership_id`,`action`,`status`);--> statement-breakpoint
CREATE TRIGGER `audit_events_no_update`
BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete`
BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER `operation_receipts_no_row_replacement`
BEFORE INSERT ON `operation_receipts`
WHEN EXISTS (
  SELECT 1 FROM `operation_receipts`
  WHERE `id` = NEW.`id`
     OR (`agency_id` = NEW.`agency_id`
         AND `actor_user_id` = NEW.`actor_user_id`
         AND `actor_membership_id` = NEW.`actor_membership_id`
         AND `action` = NEW.`action`
         AND `idempotency_key` = NEW.`idempotency_key`)
)
BEGIN
  SELECT RAISE(ABORT, 'IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN');
END;--> statement-breakpoint
CREATE TRIGGER `operation_receipts_update_guard`
BEFORE UPDATE ON `operation_receipts`
BEGIN
  SELECT CASE
    WHEN NEW.`id` <> OLD.`id`
      OR NEW.`agency_id` <> OLD.`agency_id`
      OR NEW.`actor_user_id` <> OLD.`actor_user_id`
      OR NEW.`actor_membership_id` <> OLD.`actor_membership_id`
      OR NEW.`action` <> OLD.`action`
      OR NEW.`idempotency_key` <> OLD.`idempotency_key`
      OR NEW.`payload_fingerprint` <> OLD.`payload_fingerprint`
      THEN RAISE(ABORT, 'OPERATION_RECEIPT_IDENTITY_IMMUTABLE')
    WHEN OLD.`status` = 'COMPLETED' AND NEW.`status` <> 'COMPLETED'
      THEN RAISE(ABORT, 'OPERATION_RECEIPT_STATE_TERMINAL')
    WHEN NEW.`updated_at` < OLD.`updated_at`
      THEN RAISE(ABORT, 'TIMESTAMPS_OUT_OF_ORDER')
  END;
END;--> statement-breakpoint
CREATE TRIGGER `sensitive_action_grants_no_row_replacement`
BEFORE INSERT ON `sensitive_action_grants`
WHEN EXISTS (
  SELECT 1 FROM `sensitive_action_grants`
  WHERE `id` = NEW.`id` OR `evidence_hash` = NEW.`evidence_hash`
)
BEGIN
  SELECT RAISE(ABORT, 'SENSITIVE_GRANT_ROW_REPLACEMENT_FORBIDDEN');
END;--> statement-breakpoint
CREATE TRIGGER `sensitive_action_grants_update_guard`
BEFORE UPDATE ON `sensitive_action_grants`
BEGIN
  SELECT CASE
    WHEN NEW.`id` <> OLD.`id`
      OR NEW.`evidence_hash` <> OLD.`evidence_hash`
      OR NEW.`agency_id` <> OLD.`agency_id`
      OR NEW.`actor_user_id` <> OLD.`actor_user_id`
      OR NEW.`actor_membership_id` <> OLD.`actor_membership_id`
      OR NEW.`action` <> OLD.`action`
      OR NEW.`payload_hash` <> OLD.`payload_hash`
      OR NEW.`target_ids_json` <> OLD.`target_ids_json`
      OR (NEW.`expected_target_version` IS NOT OLD.`expected_target_version`)
      OR NEW.`permission_version` <> OLD.`permission_version`
      OR NEW.`assurance` <> OLD.`assurance`
      OR NEW.`issued_at` <> OLD.`issued_at`
      OR NEW.`expires_at` <> OLD.`expires_at`
      THEN RAISE(ABORT, 'SENSITIVE_GRANT_IDENTITY_IMMUTABLE')
    WHEN OLD.`status` = 'CONSUMED' AND NEW.`status` <> 'CONSUMED'
      THEN RAISE(ABORT, 'SENSITIVE_GRANT_STATE_TERMINAL')
    WHEN OLD.`status` = 'REVOKED' AND NEW.`status` <> 'REVOKED'
      THEN RAISE(ABORT, 'SENSITIVE_GRANT_STATE_TERMINAL')
    WHEN NEW.`updated_at` < OLD.`updated_at`
      THEN RAISE(ABORT, 'TIMESTAMPS_OUT_OF_ORDER')
  END;
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `d1_cas_assertions_guard`;--> statement-breakpoint
CREATE TRIGGER `d1_cas_assertions_guard`
BEFORE INSERT ON `d1_cas_assertions`
BEGIN
  SELECT CASE
    WHEN NEW.`expected` <> NEW.`actual` AND NEW.`failure_code` = 'MEMBERSHIP_PERMISSION_NOT_FOUND'
      THEN RAISE(ABORT, 'MEMBERSHIP_PERMISSION_NOT_FOUND')
    WHEN NEW.`expected` <> NEW.`actual` AND NEW.`failure_code` = 'SENSITIVE_GRANT_CONSUMPTION_FAILED'
      THEN RAISE(ABORT, 'SENSITIVE_GRANT_CONSUMPTION_FAILED')
    WHEN NEW.`expected` <> NEW.`actual` AND NEW.`failure_code` = 'BUSINESS_MUTATION_FAILED'
      THEN RAISE(ABORT, 'BUSINESS_MUTATION_FAILED')
    WHEN NEW.`expected` <> NEW.`actual`
      THEN RAISE(ABORT, 'OPTIMISTIC_CONCURRENCY_CONFLICT')
  END;
END;