ALTER TABLE `insurance_branches` ADD `data_classification` text DEFAULT 'GENERAL' NOT NULL CHECK (`data_classification` IN ('GENERAL', 'HEALTH'));--> statement-breakpoint
ALTER TABLE `payment_methods` ADD `supports_installments` integer DEFAULT 0 NOT NULL CHECK (`supports_installments` IN (0, 1));--> statement-breakpoint
ALTER TABLE `payment_methods` ADD `max_installments` integer DEFAULT 12 NOT NULL CHECK (`max_installments` >= 2 AND `max_installments` <= 36);--> statement-breakpoint
CREATE UNIQUE INDEX `insurance_products_policy_relation_uq` ON `insurance_products` (`agency_id`,`id`,`insurer_id`,`branch_id`);--> statement-breakpoint
CREATE TABLE `policies` (
  `id` text PRIMARY KEY NOT NULL,
  `agency_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `insurer_id` text NOT NULL,
  `product_id` text NOT NULL,
  `branch_id` text NOT NULL,
  `payment_method_id` text NOT NULL,
  `assignee_membership_id` text NOT NULL,
  `policy_number` text NOT NULL,
  `normalized_policy_number` text NOT NULL,
  `start_date` text NOT NULL,
  `end_date` text NOT NULL,
  `gross_premium_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `installment_count` integer,
  `status` text DEFAULT 'ACTIVE' NOT NULL,
  `identity_variant` integer DEFAULT 0 NOT NULL,
  `identity_variant_reason` text,
  `archived_at` text,
  `archived_by_membership_id` text,
  `archive_reason` text,
  `version` integer DEFAULT 1 NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
  FOREIGN KEY (`agency_id`,`insurer_id`) REFERENCES `insurers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
  FOREIGN KEY (`agency_id`,`branch_id`) REFERENCES `insurance_branches`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
  FOREIGN KEY (`agency_id`,`payment_method_id`) REFERENCES `payment_methods`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
  FOREIGN KEY (`agency_id`,`assignee_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
  FOREIGN KEY (`agency_id`,`archived_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
  FOREIGN KEY (`agency_id`,`product_id`,`insurer_id`,`branch_id`) REFERENCES `insurance_products`(`agency_id`,`id`,`insurer_id`,`branch_id`) ON UPDATE restrict ON DELETE restrict,
  CONSTRAINT `policies_id_nonempty` CHECK(length(trim(`id`)) > 0),
  CONSTRAINT `policies_number_nonempty` CHECK(length(trim(`policy_number`)) > 0),
  CONSTRAINT `policies_normalized_number_nonempty` CHECK(length(`normalized_policy_number`) > 0),
  CONSTRAINT `policies_date_shape` CHECK(`start_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND `end_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT `policies_period_ordered` CHECK(`start_date` <= `end_date`),
  CONSTRAINT `policies_premium_safe` CHECK(`gross_premium_minor` >= 0 AND `gross_premium_minor` <= 9007199254740991),
  CONSTRAINT `policies_currency_shape` CHECK(length(`currency`) = 3 AND `currency` = upper(`currency`)),
  CONSTRAINT `policies_status_valid` CHECK(`status` IN ('ACTIVE', 'CANCELLED', 'VOIDED')),
  CONSTRAINT `policies_identity_variant_nonnegative` CHECK(`identity_variant` >= 0),
  CONSTRAINT `policies_identity_variant_reason_consistent` CHECK((`identity_variant` = 0 AND `identity_variant_reason` IS NULL) OR (`identity_variant` > 0 AND length(trim(`identity_variant_reason`)) >= 3)),
  CONSTRAINT `policies_installment_range` CHECK(`installment_count` IS NULL OR (`installment_count` >= 2 AND `installment_count` <= 36)),
  CONSTRAINT `policies_archive_consistent` CHECK((`archived_at` IS NULL AND `archived_by_membership_id` IS NULL AND `archive_reason` IS NULL) OR (`archived_at` IS NOT NULL AND `archived_by_membership_id` IS NOT NULL AND length(trim(`archive_reason`)) > 0)),
  CONSTRAINT `policies_version_positive` CHECK(`version` >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX `policies_agency_id_id_uq` ON `policies` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policies_candidate_uq` ON `policies` (`agency_id`,`insurer_id`,`normalized_policy_number`,`end_date`,`identity_variant`);--> statement-breakpoint
CREATE INDEX `policies_agency_end_id_idx` ON `policies` (`agency_id`,`end_date`,`id`);--> statement-breakpoint
CREATE INDEX `policies_agency_customer_end_idx` ON `policies` (`agency_id`,`customer_id`,`end_date`);--> statement-breakpoint
CREATE INDEX `policies_agency_assignee_idx` ON `policies` (`agency_id`,`assignee_membership_id`);--> statement-breakpoint
CREATE TRIGGER `policies_active_catalog_guard_insert`
BEFORE INSERT ON `policies`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM insurance_products p
    JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    JOIN payment_methods pm ON pm.agency_id=p.agency_id AND pm.id=NEW.payment_method_id
    WHERE p.agency_id=NEW.agency_id AND p.id=NEW.product_id AND p.insurer_id=NEW.insurer_id
      AND p.branch_id=NEW.branch_id AND p.status='ACTIVE' AND i.status='ACTIVE'
      AND b.status='ACTIVE' AND pm.status='ACTIVE'
  ) THEN RAISE(ABORT, 'POLICY_CATALOG_REFERENCE_NOT_SELECTABLE') END;
END;--> statement-breakpoint
CREATE TRIGGER `policies_active_catalog_guard_update`
BEFORE UPDATE OF insurer_id,product_id,branch_id,payment_method_id ON `policies`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM insurance_products p
    JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    JOIN payment_methods pm ON pm.agency_id=p.agency_id AND pm.id=NEW.payment_method_id
    WHERE p.agency_id=NEW.agency_id AND p.id=NEW.product_id AND p.insurer_id=NEW.insurer_id
      AND p.branch_id=NEW.branch_id AND p.status='ACTIVE' AND i.status='ACTIVE'
      AND b.status='ACTIVE' AND pm.status='ACTIVE'
  ) THEN RAISE(ABORT, 'POLICY_CATALOG_REFERENCE_NOT_SELECTABLE') END;
END;--> statement-breakpoint
CREATE TRIGGER `policies_installment_guard_insert`
BEFORE INSERT ON `policies`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payment_methods pm WHERE pm.agency_id=NEW.agency_id AND pm.id=NEW.payment_method_id
      AND ((pm.supports_installments=0 AND NEW.installment_count IS NULL)
        OR (pm.supports_installments=1 AND NEW.installment_count BETWEEN 2 AND pm.max_installments))
  ) THEN RAISE(ABORT, 'POLICY_INSTALLMENT_SEMANTICS_INVALID') END;
END;--> statement-breakpoint
CREATE TRIGGER `policies_installment_guard_update`
BEFORE UPDATE OF payment_method_id, installment_count ON `policies`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payment_methods pm WHERE pm.agency_id=NEW.agency_id AND pm.id=NEW.payment_method_id
      AND ((pm.supports_installments=0 AND NEW.installment_count IS NULL)
        OR (pm.supports_installments=1 AND NEW.installment_count BETWEEN 2 AND pm.max_installments))
  ) THEN RAISE(ABORT, 'POLICY_INSTALLMENT_SEMANTICS_INVALID') END;
END;
