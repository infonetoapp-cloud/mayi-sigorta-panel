CREATE TABLE `agencies` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`bootstrap_completed_at` text,
	`activated_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "agencies_id_nonempty" CHECK(length(trim("agencies"."id")) > 0),
	CONSTRAINT "agencies_status_valid" CHECK("agencies"."status" IN ('PROVISIONING', 'ACTIVE')),
	CONSTRAINT "agencies_version_positive" CHECK("agencies"."version" >= 1),
	CONSTRAINT "agencies_timestamps_ordered" CHECK("agencies"."updated_at" >= "agencies"."created_at"),
	CONSTRAINT "agencies_lifecycle_consistent" CHECK(("agencies"."status" = 'PROVISIONING' AND "agencies"."bootstrap_completed_at" IS NULL AND "agencies"."activated_at" IS NULL)
          OR ("agencies"."status" = 'ACTIVE' AND "agencies"."bootstrap_completed_at" IS NOT NULL AND "agencies"."activated_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `agency_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`permission_version` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`invitation_email` text NOT NULL,
	`invitation_expires_at` text NOT NULL,
	`invitation_renewed_at` text,
	`activated_at` text,
	`suspended_at` text,
	`inactivated_at` text,
	`last_operation_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "agency_memberships_id_nonempty" CHECK(length(trim("agency_memberships"."id")) > 0),
	CONSTRAINT "agency_memberships_type_valid" CHECK("agency_memberships"."type" IN ('OWNER', 'MEMBER')),
	CONSTRAINT "agency_memberships_status_valid" CHECK("agency_memberships"."status" IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE')),
	CONSTRAINT "agency_memberships_version_positive" CHECK("agency_memberships"."version" >= 1),
	CONSTRAINT "agency_memberships_permission_version_positive" CHECK("agency_memberships"."permission_version" >= 1),
	CONSTRAINT "agency_memberships_invitation_email_shape" CHECK(length(trim("agency_memberships"."invitation_email")) > 3 AND instr("agency_memberships"."invitation_email", '@') > 1),
	CONSTRAINT "agency_memberships_invitation_expiry_ordered" CHECK("agency_memberships"."invitation_expires_at" > "agency_memberships"."created_at"),
	CONSTRAINT "agency_memberships_timestamps_ordered" CHECK("agency_memberships"."updated_at" >= "agency_memberships"."created_at"),
	CONSTRAINT "agency_memberships_lifecycle_consistent" CHECK(("agency_memberships"."status" = 'INVITED')
          OR ("agency_memberships"."status" = 'ACTIVE' AND "agency_memberships"."activated_at" IS NOT NULL)
          OR ("agency_memberships"."status" = 'SUSPENDED' AND "agency_memberships"."activated_at" IS NOT NULL AND "agency_memberships"."suspended_at" IS NOT NULL)
          OR ("agency_memberships"."status" = 'INACTIVE' AND "agency_memberships"."inactivated_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agency_memberships_agency_user_uq` ON `agency_memberships` (`agency_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `agency_memberships_owner_lookup_idx` ON `agency_memberships` (`agency_id`,`type`,`status`);--> statement-breakpoint
CREATE INDEX `agency_memberships_user_status_idx` ON `agency_memberships` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `auth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`verified_email` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`bound_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`revoked_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "auth_identities_id_nonempty" CHECK(length(trim("auth_identities"."id")) > 0),
	CONSTRAINT "auth_identities_issuer_nonempty" CHECK(length(trim("auth_identities"."issuer")) > 0),
	CONSTRAINT "auth_identities_subject_nonempty" CHECK(length(trim("auth_identities"."subject")) > 0),
	CONSTRAINT "auth_identities_verified_email_shape" CHECK(length(trim("auth_identities"."verified_email")) > 3 AND instr("auth_identities"."verified_email", '@') > 1),
	CONSTRAINT "auth_identities_status_valid" CHECK("auth_identities"."status" IN ('ACTIVE', 'REVOKED')),
	CONSTRAINT "auth_identities_version_positive" CHECK("auth_identities"."version" >= 1),
	CONSTRAINT "auth_identities_timestamps_ordered" CHECK("auth_identities"."updated_at" >= "auth_identities"."created_at"),
	CONSTRAINT "auth_identities_lifecycle_consistent" CHECK(("auth_identities"."status" = 'ACTIVE' AND "auth_identities"."revoked_at" IS NULL)
          OR ("auth_identities"."status" = 'REVOKED' AND "auth_identities"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_identities_issuer_subject_uq` ON `auth_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `auth_identities_user_status_idx` ON `auth_identities` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'INACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "users_id_nonempty" CHECK(length(trim("users"."id")) > 0),
	CONSTRAINT "users_status_valid" CHECK("users"."status" IN ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "users_version_positive" CHECK("users"."version" >= 1),
	CONSTRAINT "users_timestamps_ordered" CHECK("users"."updated_at" >= "users"."created_at")
);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);
--> statement-breakpoint
CREATE TRIGGER `agencies_no_active_insert`
BEFORE INSERT ON `agencies`
WHEN NEW.`status` = 'ACTIVE'
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_AGENCY_REQUIRES_EFFECTIVE_OWNER');
END;
--> statement-breakpoint
CREATE TRIGGER `agencies_update_guard`
BEFORE UPDATE ON `agencies`
BEGIN
  SELECT CASE
    WHEN NEW.`id` <> OLD.`id`
      THEN RAISE(ABORT, 'AGENCY_ID_IMMUTABLE')
    WHEN NEW.`version` <> OLD.`version` + 1
      THEN RAISE(ABORT, 'STALE_AGENCY_VERSION')
    WHEN OLD.`status` = 'ACTIVE' AND NEW.`status` <> 'ACTIVE'
      THEN RAISE(ABORT, 'ACTIVE_AGENCY_CANNOT_RETURN_TO_PROVISIONING')
    WHEN OLD.`status` = 'PROVISIONING' AND NEW.`status` = 'ACTIVE' AND NOT EXISTS (
      SELECT 1
      FROM `agency_memberships` AS membership
      JOIN `users` AS owner_user ON owner_user.`id` = membership.`user_id`
      WHERE membership.`agency_id` = OLD.`id`
        AND membership.`type` = 'OWNER'
        AND membership.`status` = 'ACTIVE'
        AND owner_user.`status` = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM `auth_identities` AS identity
          WHERE identity.`user_id` = owner_user.`id` AND identity.`status` = 'ACTIVE'
        )
    ) THEN RAISE(ABORT, 'ACTIVE_AGENCY_REQUIRES_EFFECTIVE_OWNER')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `agencies_no_delete`
BEFORE DELETE ON `agencies`
BEGIN
  SELECT RAISE(ABORT, 'AGENCY_HARD_DELETE_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `users_update_guard`
BEFORE UPDATE ON `users`
BEGIN
  SELECT CASE
    WHEN NEW.`id` <> OLD.`id`
      THEN RAISE(ABORT, 'USER_ID_IMMUTABLE')
    WHEN NEW.`version` <> OLD.`version` + 1
      THEN RAISE(ABORT, 'STALE_USER_VERSION')
    WHEN OLD.`status` = 'ACTIVE' AND NEW.`status` = 'INACTIVE' AND EXISTS (
      SELECT 1
      FROM `agency_memberships` AS membership
      JOIN `agencies` AS agency ON agency.`id` = membership.`agency_id`
      WHERE membership.`user_id` = OLD.`id`
        AND membership.`type` = 'OWNER'
        AND membership.`status` = 'ACTIVE'
        AND agency.`status` = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM `auth_identities` AS identity
          WHERE identity.`user_id` = OLD.`id` AND identity.`status` = 'ACTIVE'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM `agency_memberships` AS other_membership
          JOIN `users` AS other_user ON other_user.`id` = other_membership.`user_id`
          WHERE other_membership.`agency_id` = membership.`agency_id`
            AND other_membership.`id` <> membership.`id`
            AND other_membership.`type` = 'OWNER'
            AND other_membership.`status` = 'ACTIVE'
            AND other_user.`status` = 'ACTIVE'
            AND EXISTS (
              SELECT 1 FROM `auth_identities` AS other_identity
              WHERE other_identity.`user_id` = other_user.`id`
                AND other_identity.`status` = 'ACTIVE'
            )
        )
    ) THEN RAISE(ABORT, 'LAST_EFFECTIVE_OWNER_REQUIRED')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `users_no_delete`
BEFORE DELETE ON `users`
BEGIN
  SELECT RAISE(ABORT, 'USER_HARD_DELETE_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `users_after_insert_owner_assertion`
AFTER INSERT ON `users`
WHEN EXISTS (
  SELECT 1 FROM `agencies` AS agency
  WHERE agency.`status` = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1
      FROM `agency_memberships` AS membership
      JOIN `users` AS owner_user ON owner_user.`id` = membership.`user_id`
      WHERE membership.`agency_id` = agency.`id`
        AND membership.`type` = 'OWNER'
        AND membership.`status` = 'ACTIVE'
        AND owner_user.`status` = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM `auth_identities` AS identity
          WHERE identity.`user_id` = owner_user.`id` AND identity.`status` = 'ACTIVE'
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'LAST_EFFECTIVE_OWNER_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_update_guard`
BEFORE UPDATE ON `auth_identities`
BEGIN
  SELECT CASE
    WHEN NEW.`id` <> OLD.`id`
      OR NEW.`user_id` <> OLD.`user_id`
      OR NEW.`issuer` <> OLD.`issuer`
      OR NEW.`subject` <> OLD.`subject`
      THEN RAISE(ABORT, 'AUTH_IDENTITY_BINDING_IMMUTABLE')
    WHEN NEW.`version` <> OLD.`version` + 1
      THEN RAISE(ABORT, 'STALE_AUTH_IDENTITY_VERSION')
    WHEN OLD.`status` = 'ACTIVE' AND NEW.`status` = 'REVOKED'
      AND NOT EXISTS (
        SELECT 1 FROM `auth_identities` AS other_identity
        WHERE other_identity.`user_id` = OLD.`user_id`
          AND other_identity.`id` <> OLD.`id`
          AND other_identity.`status` = 'ACTIVE'
      )
      AND EXISTS (
        SELECT 1
        FROM `agency_memberships` AS membership
        JOIN `agencies` AS agency ON agency.`id` = membership.`agency_id`
        JOIN `users` AS owner_user ON owner_user.`id` = membership.`user_id`
        WHERE membership.`user_id` = OLD.`user_id`
          AND membership.`type` = 'OWNER'
          AND membership.`status` = 'ACTIVE'
          AND agency.`status` = 'ACTIVE'
          AND owner_user.`status` = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1
            FROM `agency_memberships` AS other_membership
            JOIN `users` AS other_user ON other_user.`id` = other_membership.`user_id`
            WHERE other_membership.`agency_id` = membership.`agency_id`
              AND other_membership.`id` <> membership.`id`
              AND other_membership.`type` = 'OWNER'
              AND other_membership.`status` = 'ACTIVE'
              AND other_user.`status` = 'ACTIVE'
              AND EXISTS (
                SELECT 1 FROM `auth_identities` AS effective_identity
                WHERE effective_identity.`user_id` = other_user.`id`
                  AND effective_identity.`status` = 'ACTIVE'
              )
          )
      ) THEN RAISE(ABORT, 'LAST_EFFECTIVE_OWNER_REQUIRED')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_no_delete`
BEFORE DELETE ON `auth_identities`
BEGIN
  SELECT RAISE(ABORT, 'AUTH_IDENTITY_HARD_DELETE_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_after_insert_owner_assertion`
AFTER INSERT ON `auth_identities`
WHEN EXISTS (
  SELECT 1 FROM `agencies` AS agency
  WHERE agency.`status` = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1
      FROM `agency_memberships` AS membership
      JOIN `users` AS owner_user ON owner_user.`id` = membership.`user_id`
      WHERE membership.`agency_id` = agency.`id`
        AND membership.`type` = 'OWNER'
        AND membership.`status` = 'ACTIVE'
        AND owner_user.`status` = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM `auth_identities` AS identity
          WHERE identity.`user_id` = owner_user.`id` AND identity.`status` = 'ACTIVE'
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'LAST_EFFECTIVE_OWNER_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `agency_memberships_provisioning_insert_guard`
BEFORE INSERT ON `agency_memberships`
WHEN (SELECT `status` FROM `agencies` WHERE `id` = NEW.`agency_id`) = 'PROVISIONING'
BEGIN
  SELECT CASE
    WHEN NEW.`type` <> 'OWNER' OR NEW.`status` <> 'INVITED'
      THEN RAISE(ABORT, 'PROVISIONING_REQUIRES_INVITED_OWNER')
    WHEN EXISTS (
      SELECT 1 FROM `agency_memberships` WHERE `agency_id` = NEW.`agency_id`
    ) THEN RAISE(ABORT, 'BOOTSTRAP_MEMBERSHIP_ALREADY_EXISTS')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `agency_memberships_update_guard`
BEFORE UPDATE ON `agency_memberships`
BEGIN
  SELECT CASE
    WHEN NEW.`id` <> OLD.`id`
      OR NEW.`agency_id` <> OLD.`agency_id`
      OR NEW.`user_id` <> OLD.`user_id`
      THEN RAISE(ABORT, 'MEMBERSHIP_IDENTITY_IMMUTABLE')
    WHEN NEW.`version` <> OLD.`version` + 1
      THEN RAISE(ABORT, 'STALE_MEMBERSHIP_VERSION')
    WHEN NEW.`permission_version` < OLD.`permission_version`
      OR NEW.`permission_version` > OLD.`permission_version` + 1
      THEN RAISE(ABORT, 'INVALID_PERMISSION_VERSION')
    WHEN (NEW.`type` <> OLD.`type` OR NEW.`status` <> OLD.`status`)
      AND NEW.`permission_version` <> OLD.`permission_version` + 1
      THEN RAISE(ABORT, 'AUTHORIZATION_VERSION_REQUIRED')
    WHEN OLD.`type` = 'OWNER' AND OLD.`status` = 'ACTIVE'
      AND (NEW.`type` <> 'OWNER' OR NEW.`status` <> 'ACTIVE')
      AND (SELECT `status` FROM `agencies` WHERE `id` = OLD.`agency_id`) = 'ACTIVE'
      AND (SELECT `status` FROM `users` WHERE `id` = OLD.`user_id`) = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM `auth_identities`
        WHERE `user_id` = OLD.`user_id` AND `status` = 'ACTIVE'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM `agency_memberships` AS other_membership
        JOIN `users` AS other_user ON other_user.`id` = other_membership.`user_id`
        WHERE other_membership.`agency_id` = OLD.`agency_id`
          AND other_membership.`id` <> OLD.`id`
          AND other_membership.`type` = 'OWNER'
          AND other_membership.`status` = 'ACTIVE'
          AND other_user.`status` = 'ACTIVE'
          AND EXISTS (
            SELECT 1 FROM `auth_identities` AS other_identity
            WHERE other_identity.`user_id` = other_user.`id`
              AND other_identity.`status` = 'ACTIVE'
          )
      ) THEN RAISE(ABORT, 'LAST_EFFECTIVE_OWNER_REQUIRED')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `agency_memberships_no_delete`
BEFORE DELETE ON `agency_memberships`
BEGIN
  SELECT RAISE(ABORT, 'MEMBERSHIP_HARD_DELETE_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `agency_memberships_after_insert_owner_assertion`
AFTER INSERT ON `agency_memberships`
WHEN EXISTS (
  SELECT 1 FROM `agencies` AS agency
  WHERE agency.`status` = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1
      FROM `agency_memberships` AS membership
      JOIN `users` AS owner_user ON owner_user.`id` = membership.`user_id`
      WHERE membership.`agency_id` = agency.`id`
        AND membership.`type` = 'OWNER'
        AND membership.`status` = 'ACTIVE'
        AND owner_user.`status` = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM `auth_identities` AS identity
          WHERE identity.`user_id` = owner_user.`id` AND identity.`status` = 'ACTIVE'
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'LAST_EFFECTIVE_OWNER_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `agencies_no_row_replacement`
BEFORE INSERT ON `agencies`
WHEN EXISTS (SELECT 1 FROM `agencies` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'AGENCY_ROW_REPLACEMENT_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `users_no_row_replacement`
BEFORE INSERT ON `users`
WHEN EXISTS (SELECT 1 FROM `users` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'USER_ROW_REPLACEMENT_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_identities_no_row_replacement`
BEFORE INSERT ON `auth_identities`
WHEN EXISTS (
  SELECT 1 FROM `auth_identities`
  WHERE `id` = NEW.`id`
     OR (`issuer` = NEW.`issuer` AND `subject` = NEW.`subject`)
)
BEGIN
  SELECT RAISE(ABORT, 'AUTH_IDENTITY_ROW_REPLACEMENT_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `agency_memberships_no_row_replacement`
BEFORE INSERT ON `agency_memberships`
WHEN EXISTS (
  SELECT 1 FROM `agency_memberships`
  WHERE `id` = NEW.`id`
     OR (`agency_id` = NEW.`agency_id` AND `user_id` = NEW.`user_id`)
)
BEGIN
  SELECT RAISE(ABORT, 'MEMBERSHIP_ROW_REPLACEMENT_FORBIDDEN');
END;