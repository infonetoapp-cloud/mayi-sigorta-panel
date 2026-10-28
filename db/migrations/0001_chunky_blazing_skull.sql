CREATE TABLE `d1_cas_assertions` (
	`id` text PRIMARY KEY NOT NULL,
	`expected` integer NOT NULL,
	`actual` integer NOT NULL,
	`failure_code` text DEFAULT 'OPTIMISTIC_CONCURRENCY_CONFLICT' NOT NULL,
	CONSTRAINT "d1_cas_assertions_id_nonempty" CHECK(length(trim("d1_cas_assertions"."id")) > 0),
	CONSTRAINT "d1_cas_assertions_failure_code_nonempty" CHECK(length(trim("d1_cas_assertions"."failure_code")) > 0)
);
--> statement-breakpoint
CREATE TABLE `membership_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`membership_id` text NOT NULL,
	`permission_code` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`membership_id`) REFERENCES `agency_memberships`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "membership_permissions_id_nonempty" CHECK(length(trim("membership_permissions"."id")) > 0),
	CONSTRAINT "membership_permissions_code_nonempty" CHECK(length(trim("membership_permissions"."permission_code")) > 0),
	CONSTRAINT "membership_permissions_scope_valid" CHECK("membership_permissions"."scope" IN ('UNSCOPED', 'ASSIGNED', 'AGENCY')),
	CONSTRAINT "membership_permissions_timestamps_ordered" CHECK("membership_permissions"."updated_at" >= "membership_permissions"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_permissions_membership_code_uq` ON `membership_permissions` (`membership_id`,`permission_code`);--> statement-breakpoint
CREATE INDEX `membership_permissions_membership_idx` ON `membership_permissions` (`membership_id`);--> statement-breakpoint
CREATE TRIGGER `d1_cas_assertions_guard`
BEFORE INSERT ON `d1_cas_assertions`
BEGIN
  SELECT CASE
    WHEN NEW.`expected` <> NEW.`actual` AND NEW.`failure_code` = 'MEMBERSHIP_PERMISSION_NOT_FOUND'
      THEN RAISE(ABORT, 'MEMBERSHIP_PERMISSION_NOT_FOUND')
    WHEN NEW.`expected` <> NEW.`actual`
      THEN RAISE(ABORT, 'OPTIMISTIC_CONCURRENCY_CONFLICT')
  END;
END;--> statement-breakpoint
CREATE TRIGGER `d1_cas_assertions_cleanup`
AFTER INSERT ON `d1_cas_assertions`
BEGIN
  DELETE FROM `d1_cas_assertions` WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `membership_permissions_no_row_replacement`
BEFORE INSERT ON `membership_permissions`
WHEN EXISTS (
  SELECT 1 FROM `membership_permissions`
  WHERE `id` = NEW.`id`
     OR (`membership_id` = NEW.`membership_id` AND `permission_code` = NEW.`permission_code`)
)
BEGIN
  SELECT RAISE(ABORT, 'MEMBERSHIP_PERMISSION_ROW_REPLACEMENT_FORBIDDEN');
END;--> statement-breakpoint
CREATE TRIGGER `membership_permissions_update_guard`
BEFORE UPDATE ON `membership_permissions`
BEGIN
  SELECT CASE
    WHEN NEW.`id` <> OLD.`id`
      OR NEW.`membership_id` <> OLD.`membership_id`
      OR NEW.`permission_code` <> OLD.`permission_code`
      THEN RAISE(ABORT, 'MEMBERSHIP_PERMISSION_IDENTITY_IMMUTABLE')
    WHEN NEW.`updated_at` < OLD.`updated_at`
      THEN RAISE(ABORT, 'TIMESTAMPS_OUT_OF_ORDER')
  END;
END;