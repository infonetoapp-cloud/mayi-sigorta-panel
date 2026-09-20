CREATE TABLE IF NOT EXISTS `external_customer_references` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`source_namespace` text NOT NULL,
	`external_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "ext_cust_refs_id_nonempty" CHECK(length(trim("external_customer_references"."id")) > 0),
	CONSTRAINT "ext_cust_refs_source_namespace_nonempty" CHECK(length(trim("external_customer_references"."source_namespace")) > 0),
	CONSTRAINT "ext_cust_refs_external_key_nonempty" CHECK(length(trim("external_customer_references"."external_key")) > 0),
	CONSTRAINT "ext_cust_refs_timestamps_ordered" CHECK("external_customer_references"."updated_at" >= "external_customer_references"."created_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ext_cust_refs_agency_source_key_uq` ON `external_customer_references` (`agency_id`,`source_namespace`,`external_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ext_cust_refs_agency_customer_idx` ON `external_customer_references` (`agency_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ext_cust_refs_agency_source_key_idx` ON `external_customer_references` (`agency_id`,`source_namespace`,`external_key`);--> statement-breakpoint
ALTER TABLE `customers` ADD `identity_type` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `identity_ciphertext` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `identity_iv` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `identity_tag` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `identity_search_hash` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `identity_key_version` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_agency_identity_search_hash_idx` ON `customers` (`agency_id`,`identity_search_hash`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `ext_cust_refs_parent_guard`
BEFORE INSERT ON `external_customer_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `customers`
  WHERE `id` = NEW.`customer_id`
    AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_CUSTOMER_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `ext_cust_refs_parent_update_guard`
BEFORE UPDATE ON `external_customer_references`
WHEN NOT EXISTS (
  SELECT 1 FROM `customers`
  WHERE `id` = NEW.`customer_id`
    AND `agency_id` = NEW.`agency_id`
)
BEGIN
  SELECT RAISE(ABORT, 'CROSS_AGENCY_CUSTOMER_PROHIBITED');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `customers_identity_type_guard`
BEFORE INSERT ON `customers`
WHEN (
  (NEW.`identity_type` IS NOT NULL AND NEW.`identity_type` NOT IN ('TCKN', 'VKN'))
  OR (NEW.`identity_type` IS NOT NULL AND (
    (NEW.`type` = 'INDIVIDUAL' AND NEW.`identity_type` <> 'TCKN') OR
    (NEW.`type` = 'COMPANY' AND NEW.`identity_type` <> 'VKN')
  ))
  OR (
    (NEW.`identity_type` IS NULL AND (NEW.`identity_ciphertext` IS NOT NULL OR NEW.`identity_iv` IS NOT NULL OR NEW.`identity_tag` IS NOT NULL OR NEW.`identity_search_hash` IS NOT NULL OR NEW.`identity_key_version` IS NOT NULL))
    OR
    (NEW.`identity_type` IS NOT NULL AND (NEW.`identity_ciphertext` IS NULL OR NEW.`identity_iv` IS NULL OR NEW.`identity_tag` IS NULL OR NEW.`identity_search_hash` IS NULL OR NEW.`identity_key_version` IS NULL))
  )
  OR (NEW.`identity_type` IS NOT NULL AND NEW.`identity_key_version` <= 0)
)
BEGIN
  SELECT CASE
    WHEN NEW.`identity_type` IS NOT NULL AND (
      (NEW.`type` = 'INDIVIDUAL' AND NEW.`identity_type` <> 'TCKN') OR
      (NEW.`type` = 'COMPANY' AND NEW.`identity_type` <> 'VKN')
    ) THEN RAISE(ABORT, 'INVALID_CUSTOMER_IDENTITY_TYPE')
    WHEN NEW.`identity_type` IS NOT NULL AND NEW.`identity_key_version` <= 0
      THEN RAISE(ABORT, 'INVALID_KEY_VERSION')
    ELSE RAISE(ABORT, 'CUSTOMER_IDENTITY_ENVELOPE_INCOMPLETE')
  END;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `customers_identity_type_update_guard`
BEFORE UPDATE ON `customers`
WHEN (
  (NEW.`identity_type` IS NOT NULL AND NEW.`identity_type` NOT IN ('TCKN', 'VKN'))
  OR (NEW.`identity_type` IS NOT NULL AND (
    (NEW.`type` = 'INDIVIDUAL' AND NEW.`identity_type` <> 'TCKN') OR
    (NEW.`type` = 'COMPANY' AND NEW.`identity_type` <> 'VKN')
  ))
  OR (
    (NEW.`identity_type` IS NULL AND (NEW.`identity_ciphertext` IS NOT NULL OR NEW.`identity_iv` IS NOT NULL OR NEW.`identity_tag` IS NOT NULL OR NEW.`identity_search_hash` IS NOT NULL OR NEW.`identity_key_version` IS NOT NULL))
    OR
    (NEW.`identity_type` IS NOT NULL AND (NEW.`identity_ciphertext` IS NULL OR NEW.`identity_iv` IS NULL OR NEW.`identity_tag` IS NULL OR NEW.`identity_search_hash` IS NULL OR NEW.`identity_key_version` IS NULL))
  )
  OR (NEW.`identity_type` IS NOT NULL AND NEW.`identity_key_version` <= 0)
)
BEGIN
  SELECT CASE
    WHEN NEW.`identity_type` IS NOT NULL AND (
      (NEW.`type` = 'INDIVIDUAL' AND NEW.`identity_type` <> 'TCKN') OR
      (NEW.`type` = 'COMPANY' AND NEW.`identity_type` <> 'VKN')
    ) THEN RAISE(ABORT, 'INVALID_CUSTOMER_IDENTITY_TYPE')
    WHEN NEW.`identity_type` IS NOT NULL AND NEW.`identity_key_version` <= 0
      THEN RAISE(ABORT, 'INVALID_KEY_VERSION')
    ELSE RAISE(ABORT, 'CUSTOMER_IDENTITY_ENVELOPE_INCOMPLETE')
  END;
END;