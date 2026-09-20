CREATE TABLE `agency_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`default_insurer_id` text,
	`timezone` text DEFAULT 'Europe/Istanbul' NOT NULL,
	`renewal_window_days` integer DEFAULT 30 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`default_insurer_id`) REFERENCES `insurers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "agency_settings_id_nonempty" CHECK(length(trim("agency_settings"."id")) > 0),
	CONSTRAINT "agency_settings_timezone_nonempty" CHECK(length(trim("agency_settings"."timezone")) > 0),
	CONSTRAINT "agency_settings_renewal_window_days_range" CHECK("agency_settings"."renewal_window_days" >= 1 AND "agency_settings"."renewal_window_days" <= 120),
	CONSTRAINT "agency_settings_version_positive" CHECK("agency_settings"."version" >= 1),
	CONSTRAINT "agency_settings_timestamps_ordered" CHECK("agency_settings"."updated_at" >= "agency_settings"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agency_settings_agency_id_uq` ON `agency_settings` (`agency_id`);--> statement-breakpoint
CREATE INDEX `agency_settings_default_insurer_idx` ON `agency_settings` (`agency_id`,`default_insurer_id`);--> statement-breakpoint
CREATE TABLE `insurance_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "insurance_branches_id_nonempty" CHECK(length(trim("insurance_branches"."id")) > 0),
	CONSTRAINT "insurance_branches_code_nonempty" CHECK(length(trim("insurance_branches"."code")) > 0),
	CONSTRAINT "insurance_branches_name_nonempty" CHECK(length(trim("insurance_branches"."name")) > 0),
	CONSTRAINT "insurance_branches_status_valid" CHECK("insurance_branches"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "insurance_branches_version_positive" CHECK("insurance_branches"."version" >= 1),
	CONSTRAINT "insurance_branches_timestamps_ordered" CHECK("insurance_branches"."updated_at" >= "insurance_branches"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insurance_branches_agency_id_id_uq` ON `insurance_branches` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `insurance_branches_agency_code_uq` ON `insurance_branches` (`agency_id`,`code`);--> statement-breakpoint
CREATE INDEX `insurance_branches_agency_status_idx` ON `insurance_branches` (`agency_id`,`status`);--> statement-breakpoint
CREATE TABLE `insurance_products` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`insurer_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`insurer_id`) REFERENCES `insurers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`branch_id`) REFERENCES `insurance_branches`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "insurance_products_id_nonempty" CHECK(length(trim("insurance_products"."id")) > 0),
	CONSTRAINT "insurance_products_code_nonempty" CHECK(length(trim("insurance_products"."code")) > 0),
	CONSTRAINT "insurance_products_name_nonempty" CHECK(length(trim("insurance_products"."name")) > 0),
	CONSTRAINT "insurance_products_status_valid" CHECK("insurance_products"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "insurance_products_version_positive" CHECK("insurance_products"."version" >= 1),
	CONSTRAINT "insurance_products_timestamps_ordered" CHECK("insurance_products"."updated_at" >= "insurance_products"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insurance_products_agency_id_id_uq` ON `insurance_products` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `insurance_products_agency_code_uq` ON `insurance_products` (`agency_id`,`code`);--> statement-breakpoint
CREATE INDEX `insurance_products_agency_insurer_idx` ON `insurance_products` (`agency_id`,`insurer_id`);--> statement-breakpoint
CREATE INDEX `insurance_products_agency_branch_idx` ON `insurance_products` (`agency_id`,`branch_id`);--> statement-breakpoint
CREATE INDEX `insurance_products_agency_status_idx` ON `insurance_products` (`agency_id`,`status`);--> statement-breakpoint
CREATE TABLE `insurers` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "insurers_id_nonempty" CHECK(length(trim("insurers"."id")) > 0),
	CONSTRAINT "insurers_code_nonempty" CHECK(length(trim("insurers"."code")) > 0),
	CONSTRAINT "insurers_name_nonempty" CHECK(length(trim("insurers"."name")) > 0),
	CONSTRAINT "insurers_status_valid" CHECK("insurers"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "insurers_version_positive" CHECK("insurers"."version" >= 1),
	CONSTRAINT "insurers_timestamps_ordered" CHECK("insurers"."updated_at" >= "insurers"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insurers_agency_id_id_uq` ON `insurers` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `insurers_agency_code_uq` ON `insurers` (`agency_id`,`code`);--> statement-breakpoint
CREATE INDEX `insurers_agency_status_idx` ON `insurers` (`agency_id`,`status`);--> statement-breakpoint
CREATE TABLE `loss_reasons` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "loss_reasons_id_nonempty" CHECK(length(trim("loss_reasons"."id")) > 0),
	CONSTRAINT "loss_reasons_code_nonempty" CHECK(length(trim("loss_reasons"."code")) > 0),
	CONSTRAINT "loss_reasons_name_nonempty" CHECK(length(trim("loss_reasons"."name")) > 0),
	CONSTRAINT "loss_reasons_status_valid" CHECK("loss_reasons"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "loss_reasons_version_positive" CHECK("loss_reasons"."version" >= 1),
	CONSTRAINT "loss_reasons_timestamps_ordered" CHECK("loss_reasons"."updated_at" >= "loss_reasons"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loss_reasons_agency_id_id_uq` ON `loss_reasons` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loss_reasons_agency_code_uq` ON `loss_reasons` (`agency_id`,`code`);--> statement-breakpoint
CREATE INDEX `loss_reasons_agency_status_idx` ON `loss_reasons` (`agency_id`,`status`);--> statement-breakpoint
CREATE TABLE `payment_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "payment_methods_id_nonempty" CHECK(length(trim("payment_methods"."id")) > 0),
	CONSTRAINT "payment_methods_code_nonempty" CHECK(length(trim("payment_methods"."code")) > 0),
	CONSTRAINT "payment_methods_name_nonempty" CHECK(length(trim("payment_methods"."name")) > 0),
	CONSTRAINT "payment_methods_status_valid" CHECK("payment_methods"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "payment_methods_version_positive" CHECK("payment_methods"."version" >= 1),
	CONSTRAINT "payment_methods_timestamps_ordered" CHECK("payment_methods"."updated_at" >= "payment_methods"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_methods_agency_id_id_uq` ON `payment_methods` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_methods_agency_code_uq` ON `payment_methods` (`agency_id`,`code`);--> statement-breakpoint
CREATE INDEX `payment_methods_agency_status_idx` ON `payment_methods` (`agency_id`,`status`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agency_settings_default_insurer_agency_guard`
BEFORE INSERT ON `agency_settings`
WHEN NEW.`default_insurer_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `insurers` WHERE `id` = NEW.`default_insurer_id` AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_OR_MISSING_DEFAULT_INSURER');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agency_settings_default_insurer_agency_update_guard`
BEFORE UPDATE OF `default_insurer_id`, `agency_id` ON `agency_settings`
WHEN NEW.`default_insurer_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `insurers` WHERE `id` = NEW.`default_insurer_id` AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_OR_MISSING_DEFAULT_INSURER');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agency_settings_default_insurer_active_insert_guard`
BEFORE INSERT ON `agency_settings`
WHEN NEW.`default_insurer_id` IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM `insurers`
      WHERE `id` = NEW.`default_insurer_id`
        AND `agency_id` = NEW.`agency_id`
        AND `status` = 'ACTIVE'
    )
    THEN RAISE(ABORT, 'DEFAULT_INSURER_MUST_BE_ACTIVE')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `agency_settings_default_insurer_active_update_guard`
BEFORE UPDATE OF `default_insurer_id`, `agency_id` ON `agency_settings`
WHEN NEW.`default_insurer_id` IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM `insurers`
      WHERE `id` = NEW.`default_insurer_id`
        AND `agency_id` = NEW.`agency_id`
        AND `status` = 'ACTIVE'
    )
    THEN RAISE(ABORT, 'DEFAULT_INSURER_MUST_BE_ACTIVE')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `insurers_prevent_deactivating_default_guard`
BEFORE UPDATE OF `status` ON `insurers`
WHEN NEW.`status` = 'INACTIVE' AND OLD.`status` = 'ACTIVE'
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM `agency_settings`
      WHERE `agency_id` = OLD.`agency_id` AND `default_insurer_id` = OLD.`id`
    )
    THEN RAISE(ABORT, 'CANNOT_DEACTIVATE_DEFAULT_INSURER')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `insurance_products_parent_guard`
BEFORE INSERT ON `insurance_products`
WHEN NOT EXISTS (
  SELECT 1 FROM `insurers`
  WHERE `id` = NEW.`insurer_id` AND `agency_id` = NEW.`agency_id` AND `status` = 'ACTIVE'
) OR NOT EXISTS (
  SELECT 1 FROM `insurance_branches`
  WHERE `id` = NEW.`branch_id` AND `agency_id` = NEW.`agency_id` AND `status` = 'ACTIVE'
)
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM `insurers`
      WHERE `id` = NEW.`insurer_id` AND `agency_id` = NEW.`agency_id` AND `status` = 'ACTIVE'
    )
      THEN RAISE(ABORT, 'CROSS_AGENCY_OR_MISSING_INSURER_PROHIBITED')
    ELSE
      RAISE(ABORT, 'CROSS_AGENCY_OR_MISSING_BRANCH_PROHIBITED')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `insurance_products_parent_update_guard`
BEFORE UPDATE OF `insurer_id`, `branch_id`, `agency_id` ON `insurance_products`
WHEN NOT EXISTS (
  SELECT 1 FROM `insurers`
  WHERE `id` = NEW.`insurer_id` AND `agency_id` = NEW.`agency_id` AND `status` = 'ACTIVE'
) OR NOT EXISTS (
  SELECT 1 FROM `insurance_branches`
  WHERE `id` = NEW.`branch_id` AND `agency_id` = NEW.`agency_id` AND `status` = 'ACTIVE'
)
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM `insurers`
      WHERE `id` = NEW.`insurer_id` AND `agency_id` = NEW.`agency_id` AND `status` = 'ACTIVE'
    )
      THEN RAISE(ABORT, 'CROSS_AGENCY_OR_MISSING_INSURER_PROHIBITED')
    ELSE
      RAISE(ABORT, 'CROSS_AGENCY_OR_MISSING_BRANCH_PROHIBITED')
  END;
END;