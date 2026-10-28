CREATE TABLE `policy_amendments` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`external_reference` text NOT NULL,
	`effective_date` text NOT NULL,
	`description` text NOT NULL,
	`premium_difference_minor` integer,
	`currency` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "policy_amendments_id_nonempty" CHECK(length(trim("policy_amendments"."id")) > 0),
	CONSTRAINT "policy_amendments_external_reference_nonempty" CHECK(length(trim("policy_amendments"."external_reference")) > 0),
	CONSTRAINT "policy_amendments_description_nonempty" CHECK(length(trim("policy_amendments"."description")) > 0),
	CONSTRAINT "policy_amendments_date_shape" CHECK("policy_amendments"."effective_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "policy_amendments_premium_safe" CHECK("policy_amendments"."premium_difference_minor" IS NULL OR ("policy_amendments"."premium_difference_minor" >= -9007199254740991 AND "policy_amendments"."premium_difference_minor" <= 9007199254740991)),
	CONSTRAINT "policy_amendments_money_consistent" CHECK(("policy_amendments"."premium_difference_minor" IS NULL AND "policy_amendments"."currency" IS NULL) OR ("policy_amendments"."premium_difference_minor" IS NOT NULL AND length("policy_amendments"."currency")=3 AND "policy_amendments"."currency"=upper("policy_amendments"."currency")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_amendments_agency_id_id_uq` ON `policy_amendments` (`agency_id`,`id`);--> statement-breakpoint
CREATE INDEX `policy_amendments_policy_date_idx` ON `policy_amendments` (`agency_id`,`policy_id`,`effective_date`);--> statement-breakpoint
CREATE TABLE `policy_external_references` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`source_namespace` text NOT NULL,
	`external_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "policy_external_references_id_nonempty" CHECK(length(trim("policy_external_references"."id")) > 0),
	CONSTRAINT "policy_external_references_namespace_nonempty" CHECK(length(trim("policy_external_references"."source_namespace")) > 0),
	CONSTRAINT "policy_external_references_key_nonempty" CHECK(length(trim("policy_external_references"."external_key")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_external_references_agency_id_id_uq` ON `policy_external_references` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_external_references_namespace_key_uq` ON `policy_external_references` (`agency_id`,`source_namespace`,`external_key`);--> statement-breakpoint
CREATE INDEX `policy_external_references_policy_idx` ON `policy_external_references` (`agency_id`,`policy_id`);--> statement-breakpoint
CREATE TABLE `policy_parties` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deactivated_at` text,
	`deactivated_by_membership_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`deactivated_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "policy_parties_id_nonempty" CHECK(length(trim("policy_parties"."id")) > 0),
	CONSTRAINT "policy_parties_role_valid" CHECK("policy_parties"."role" IN ('INSURED', 'BENEFICIARY')),
	CONSTRAINT "policy_parties_status_valid" CHECK("policy_parties"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "policy_parties_version_positive" CHECK("policy_parties"."version" >= 1),
	CONSTRAINT "policy_parties_lifecycle_consistent" CHECK(("policy_parties"."status"='ACTIVE' AND "policy_parties"."deactivated_at" IS NULL AND "policy_parties"."deactivated_by_membership_id" IS NULL) OR ("policy_parties"."status"='INACTIVE' AND "policy_parties"."deactivated_at" IS NOT NULL AND "policy_parties"."deactivated_by_membership_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_parties_agency_id_id_uq` ON `policy_parties` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_parties_active_relation_uq` ON `policy_parties` (`agency_id`,`policy_id`,`customer_id`,`role`) WHERE "policy_parties"."status"='ACTIVE';--> statement-breakpoint
CREATE INDEX `policy_parties_policy_idx` ON `policy_parties` (`agency_id`,`policy_id`,`status`);--> statement-breakpoint
ALTER TABLE `customers` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `archived_by_membership_id` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `archive_reason_code` text;--> statement-breakpoint
CREATE TRIGGER `policy_parties_archived_customer_guard_insert`
BEFORE INSERT ON `policy_parties`
WHEN EXISTS (
  SELECT 1 FROM customers c
  WHERE c.agency_id=NEW.agency_id AND c.id=NEW.customer_id AND c.archived_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'CUSTOMER_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `policy_parties_archived_parent_guard_insert`
BEFORE INSERT ON `policy_parties`
WHEN EXISTS (
  SELECT 1 FROM policies p
  WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.archived_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'POLICY_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `policy_parties_archived_parent_guard_update`
BEFORE UPDATE OF agency_id,policy_id,customer_id ON `policy_parties`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM policies p
    WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.archived_at IS NOT NULL
  ) THEN RAISE(ABORT, 'POLICY_ARCHIVED') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM customers c
    WHERE c.agency_id=NEW.agency_id AND c.id=NEW.customer_id AND c.archived_at IS NOT NULL
  ) THEN RAISE(ABORT, 'CUSTOMER_ARCHIVED') END;
END;--> statement-breakpoint
CREATE TRIGGER `policy_amendments_archived_parent_guard_insert`
BEFORE INSERT ON `policy_amendments`
WHEN EXISTS (
  SELECT 1 FROM policies p
  WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.archived_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'POLICY_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `policy_amendments_archived_parent_guard_update`
BEFORE UPDATE OF agency_id,policy_id ON `policy_amendments`
WHEN EXISTS (
  SELECT 1 FROM policies p
  WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.archived_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'POLICY_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `policy_external_references_archived_parent_guard_insert`
BEFORE INSERT ON `policy_external_references`
WHEN EXISTS (
  SELECT 1 FROM policies p
  WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.archived_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'POLICY_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `policy_external_references_archived_parent_guard_update`
BEFORE UPDATE OF agency_id,policy_id ON `policy_external_references`
WHEN EXISTS (
  SELECT 1 FROM policies p
  WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.archived_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'POLICY_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `customers_archive_guard_insert`
BEFORE INSERT ON `customers`
WHEN NOT ((NEW.archived_at IS NULL AND NEW.archived_by_membership_id IS NULL AND NEW.archive_reason_code IS NULL)
  OR (NEW.archived_at IS NOT NULL AND NEW.archived_by_membership_id IS NOT NULL
    AND NEW.archive_reason_code IS NOT NULL
    AND NEW.archive_reason_code GLOB '[A-Z]*'
    AND NEW.archive_reason_code NOT GLOB '*[^A-Z0-9_]*'
    AND length(NEW.archive_reason_code) BETWEEN 3 AND 64
    AND EXISTS (SELECT 1 FROM agency_memberships m WHERE m.agency_id=NEW.agency_id AND m.id=NEW.archived_by_membership_id)))
BEGIN SELECT RAISE(ABORT, 'CUSTOMER_ARCHIVE_STATE_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER `customers_archive_guard_update`
BEFORE UPDATE OF agency_id,archived_at,archived_by_membership_id,archive_reason_code ON `customers`
BEGIN
  SELECT CASE WHEN NOT ((NEW.archived_at IS NULL AND NEW.archived_by_membership_id IS NULL AND NEW.archive_reason_code IS NULL)
    OR (NEW.archived_at IS NOT NULL AND NEW.archived_by_membership_id IS NOT NULL
      AND NEW.archive_reason_code IS NOT NULL
      AND NEW.archive_reason_code GLOB '[A-Z]*'
    AND NEW.archive_reason_code NOT GLOB '*[^A-Z0-9_]*'
    AND length(NEW.archive_reason_code) BETWEEN 3 AND 64
      AND EXISTS (SELECT 1 FROM agency_memberships m WHERE m.agency_id=NEW.agency_id AND m.id=NEW.archived_by_membership_id)))
    THEN RAISE(ABORT, 'CUSTOMER_ARCHIVE_STATE_INVALID') END;
  SELECT CASE WHEN NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM policies p WHERE p.agency_id=NEW.agency_id AND p.customer_id=NEW.id AND p.archived_at IS NULL
  ) THEN RAISE(ABORT, 'OPEN_DEPENDENCIES') END;
  SELECT CASE WHEN NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM policy_parties pp
    JOIN policies p ON p.agency_id=pp.agency_id AND p.id=pp.policy_id
    WHERE pp.agency_id=NEW.agency_id AND pp.customer_id=NEW.id
      AND pp.status='ACTIVE' AND p.archived_at IS NULL
  ) THEN RAISE(ABORT, 'OPEN_DEPENDENCIES') END;
END;--> statement-breakpoint
CREATE TRIGGER `policies_archived_customer_guard_insert`
BEFORE INSERT ON `policies`
WHEN EXISTS (SELECT 1 FROM customers c WHERE c.agency_id=NEW.agency_id AND c.id=NEW.customer_id AND c.archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'CUSTOMER_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `policies_archived_customer_guard_update`
BEFORE UPDATE OF customer_id,agency_id,archived_at,archived_by_membership_id,archive_reason ON `policies`
WHEN EXISTS (SELECT 1 FROM customers c WHERE c.agency_id=NEW.agency_id AND c.id=NEW.customer_id AND c.archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'CUSTOMER_ARCHIVED'); END;--> statement-breakpoint
CREATE TRIGGER `policies_archive_reason_code_guard_insert`
BEFORE INSERT ON `policies`
WHEN NEW.archived_at IS NOT NULL AND NOT (
  NEW.archive_reason IS NOT NULL
  AND NEW.archive_reason GLOB '[A-Z]*'
  AND NEW.archive_reason NOT GLOB '*[^A-Z0-9_]*'
  AND length(NEW.archive_reason) BETWEEN 3 AND 64
)
BEGIN SELECT RAISE(ABORT, 'POLICY_ARCHIVE_REASON_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER `policies_archive_reason_code_guard`
BEFORE UPDATE OF archived_at,archived_by_membership_id,archive_reason ON `policies`
WHEN NEW.archived_at IS NOT NULL AND NOT (
  NEW.archive_reason IS NOT NULL
  AND NEW.archive_reason GLOB '[A-Z]*'
  AND NEW.archive_reason NOT GLOB '*[^A-Z0-9_]*'
  AND length(NEW.archive_reason) BETWEEN 3 AND 64
)
BEGIN SELECT RAISE(ABORT, 'POLICY_ARCHIVE_REASON_INVALID'); END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `d1_cas_assertions_guard`;--> statement-breakpoint
CREATE TRIGGER `d1_cas_assertions_guard`
BEFORE INSERT ON `d1_cas_assertions`
BEGIN
  SELECT CASE
    WHEN NEW.`expected` <> NEW.`actual` AND NEW.`failure_code` = 'FINAL_AUTHORITY_RECHECK_FAILED'
      THEN RAISE(ABORT, 'FINAL_AUTHORITY_RECHECK_FAILED')
    WHEN NEW.`expected` <> NEW.`actual` AND NEW.`failure_code` = 'ASSIGNEE_NOT_ACTIVE'
      THEN RAISE(ABORT, 'ASSIGNEE_NOT_ACTIVE')
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