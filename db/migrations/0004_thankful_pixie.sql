CREATE UNIQUE INDEX IF NOT EXISTS `agency_memberships_agency_id_id_uq` ON `agency_memberships` (`agency_id`,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`type` text NOT NULL,
	`display_name` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`company_title` text,
	`email` text,
	`phone` text,
	`address` text,
	`assignee_membership_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`, `assignee_membership_id`) REFERENCES `agency_memberships`(`agency_id`, `id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "customers_id_nonempty" CHECK(length(trim("customers"."id")) > 0),
	CONSTRAINT "customers_type_valid" CHECK("customers"."type" IN ('INDIVIDUAL', 'COMPANY')),
	CONSTRAINT "customers_display_name_nonempty" CHECK(length(trim("customers"."display_name")) > 0),
	CONSTRAINT "customers_version_positive" CHECK("customers"."version" >= 1),
	CONSTRAINT "customers_timestamps_ordered" CHECK("customers"."updated_at" >= "customers"."created_at"),
	CONSTRAINT "customers_type_fields_valid" CHECK(("customers"."type" = 'INDIVIDUAL' AND "customers"."company_title" IS NULL)
          OR ("customers"."type" = 'COMPANY' AND "customers"."first_name" IS NULL AND "customers"."last_name" IS NULL)),
	CONSTRAINT "customers_email_shape" CHECK("customers"."email" IS NULL OR (length(trim("customers"."email")) > 3 AND instr("customers"."email", '@') > 1)),
	CONSTRAINT "customers_phone_shape" CHECK("customers"."phone" IS NULL OR length(trim("customers"."phone")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `customers_agency_id_id_uq` ON `customers` (`agency_id`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_agency_type_idx` ON `customers` (`agency_id`,`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_agency_assignee_idx` ON `customers` (`agency_id`,`assignee_membership_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_agency_created_idx` ON `customers` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_agency_display_name_idx` ON `customers` (`agency_id`,`display_name`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `customers_cross_agency_assignee_guard`
BEFORE INSERT ON `customers`
WHEN NOT EXISTS (
  SELECT 1 FROM `agency_memberships`
  WHERE `id` = NEW.`assignee_membership_id`
    AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_ASSIGNEE_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `customers_cross_agency_assignee_update_guard`
BEFORE UPDATE ON `customers`
WHEN NOT EXISTS (
  SELECT 1 FROM `agency_memberships`
  WHERE `id` = NEW.`assignee_membership_id`
    AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_ASSIGNEE_PROHIBITED');
END;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `company_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`role` text,
	`email` text,
	`phone` text,
	`is_primary` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`, `customer_id`) REFERENCES `customers`(`agency_id`, `id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "company_contacts_id_nonempty" CHECK(length(trim("company_contacts"."id")) > 0),
	CONSTRAINT "company_contacts_first_name_nonempty" CHECK(length(trim("company_contacts"."first_name")) > 0),
	CONSTRAINT "company_contacts_last_name_nonempty" CHECK(length(trim("company_contacts"."last_name")) > 0),
	CONSTRAINT "company_contacts_is_primary_valid" CHECK("company_contacts"."is_primary" IN (0, 1)),
	CONSTRAINT "company_contacts_status_valid" CHECK("company_contacts"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "company_contacts_version_positive" CHECK("company_contacts"."version" >= 1),
	CONSTRAINT "company_contacts_timestamps_ordered" CHECK("company_contacts"."updated_at" >= "company_contacts"."created_at"),
	CONSTRAINT "company_contacts_email_shape" CHECK("company_contacts"."email" IS NULL OR (length(trim("company_contacts"."email")) > 3 AND instr("company_contacts"."email", '@') > 1)),
	CONSTRAINT "company_contacts_phone_shape" CHECK("company_contacts"."phone" IS NULL OR length(trim("company_contacts"."phone")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `company_contacts_active_primary_uq` ON `company_contacts` (`agency_id`,`customer_id`) WHERE "company_contacts"."is_primary" = 1 AND "company_contacts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `company_contacts_agency_customer_idx` ON `company_contacts` (`agency_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `company_contacts_customer_status_idx` ON `company_contacts` (`customer_id`,`status`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `company_contacts_parent_guard`
BEFORE INSERT ON `company_contacts`
WHEN NOT EXISTS (
  SELECT 1 FROM `customers`
  WHERE `id` = NEW.`customer_id`
    AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_PARENT_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `company_contacts_parent_update_guard`
BEFORE UPDATE ON `company_contacts`
WHEN NOT EXISTS (
  SELECT 1 FROM `customers`
  WHERE `id` = NEW.`customer_id`
    AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_PARENT_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `company_contacts_individual_guard`
BEFORE INSERT ON `company_contacts`
WHEN EXISTS (
  SELECT 1 FROM `customers`
  WHERE `id` = NEW.`customer_id`
    AND `type` = 'INDIVIDUAL'
)
BEGIN
  SELECT RAISE(ABORT, 'INDIVIDUAL_CONTACT_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `company_contacts_individual_update_guard`
BEFORE UPDATE ON `company_contacts`
WHEN EXISTS (
  SELECT 1 FROM `customers`
  WHERE `id` = NEW.`customer_id`
    AND `type` = 'INDIVIDUAL'
)
BEGIN
  SELECT RAISE(ABORT, 'INDIVIDUAL_CONTACT_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `company_contacts_primary_guard`
BEFORE INSERT ON `company_contacts`
WHEN NEW.`is_primary` = 1 AND NEW.`status` = 'ACTIVE' AND EXISTS (
  SELECT 1 FROM `company_contacts`
  WHERE `customer_id` = NEW.`customer_id`
    AND `agency_id` = NEW.`agency_id`
    AND `is_primary` = 1
    AND `status` = 'ACTIVE'
    AND `id` <> NEW.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'MULTIPLE_ACTIVE_PRIMARY_CONTACTS_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `company_contacts_primary_update_guard`
BEFORE UPDATE ON `company_contacts`
WHEN NEW.`is_primary` = 1 AND NEW.`status` = 'ACTIVE' AND EXISTS (
  SELECT 1 FROM `company_contacts`
  WHERE `customer_id` = NEW.`customer_id`
    AND `agency_id` = NEW.`agency_id`
    AND `is_primary` = 1
    AND `status` = 'ACTIVE'
    AND `id` <> NEW.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'MULTIPLE_ACTIVE_PRIMARY_CONTACTS_PROHIBITED');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `d1_cas_assertions_guard`;--> statement-breakpoint
CREATE TRIGGER `d1_cas_assertions_guard`
BEFORE INSERT ON `d1_cas_assertions`
BEGIN
  SELECT CASE
    WHEN NEW.`expected` <> NEW.`actual` AND NEW.`failure_code` = 'FINAL_AUTHORITY_RECHECK_FAILED'
      THEN RAISE(ABORT, 'FINAL_AUTHORITY_RECHECK_FAILED')
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