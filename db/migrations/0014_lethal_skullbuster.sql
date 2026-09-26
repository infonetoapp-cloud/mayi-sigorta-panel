CREATE TABLE `renewal_won_policy_premium_correction_links` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`old_link_id` text NOT NULL,
	`new_link_id` text NOT NULL,
	`renewal_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`allocated_premium_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`different_policyholder_reason_code` text,
	FOREIGN KEY (`agency_id`,`operation_id`) REFERENCES `renewal_won_policy_premium_corrections`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`old_link_id`) REFERENCES `renewal_policy_links`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_won_policy_premium_correction_links_amount_safe" CHECK("renewal_won_policy_premium_correction_links"."allocated_premium_minor">=0 AND "renewal_won_policy_premium_correction_links"."allocated_premium_minor"<=9007199254740991),
	CONSTRAINT "renewal_won_policy_premium_correction_links_currency_shape" CHECK(length("renewal_won_policy_premium_correction_links"."currency")=3 AND "renewal_won_policy_premium_correction_links"."currency"=upper("renewal_won_policy_premium_correction_links"."currency"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_won_policy_premium_correction_links_agency_id_id_uq` ON `renewal_won_policy_premium_correction_links` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_won_policy_premium_correction_links_operation_old_uq` ON `renewal_won_policy_premium_correction_links` (`operation_id`,`old_link_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_won_policy_premium_correction_links_operation_new_uq` ON `renewal_won_policy_premium_correction_links` (`operation_id`,`new_link_id`);--> statement-breakpoint
CREATE TABLE `renewal_won_policy_premium_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`expected_policy_version` integer NOT NULL,
	`previous_premium_minor` integer NOT NULL,
	`corrected_premium_minor` integer NOT NULL,
	`reason_code` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `operation_receipts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_won_policy_premium_corrections_version_positive" CHECK("renewal_won_policy_premium_corrections"."expected_policy_version">=1),
	CONSTRAINT "renewal_won_policy_premium_corrections_amounts_safe" CHECK("renewal_won_policy_premium_corrections"."previous_premium_minor">=0 AND "renewal_won_policy_premium_corrections"."previous_premium_minor"<=9007199254740991 AND "renewal_won_policy_premium_corrections"."corrected_premium_minor">=0 AND "renewal_won_policy_premium_corrections"."corrected_premium_minor"<=9007199254740991),
	CONSTRAINT "renewal_won_policy_premium_corrections_reason_shape" CHECK(length(trim("renewal_won_policy_premium_corrections"."reason_code")) BETWEEN 3 AND 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_won_policy_premium_corrections_agency_id_id_uq` ON `renewal_won_policy_premium_corrections` (`agency_id`,`id`);--> statement-breakpoint
CREATE INDEX `renewal_won_policy_premium_corrections_policy_idx` ON `renewal_won_policy_premium_corrections` (`agency_id`,`policy_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER renewal_won_policy_premium_corrections_insert_guard
BEFORE INSERT ON renewal_won_policy_premium_corrections
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operation_receipts receipt
    JOIN policies policy ON policy.agency_id=NEW.agency_id AND policy.id=NEW.policy_id
    WHERE receipt.id=NEW.id AND receipt.agency_id=NEW.agency_id
      AND receipt.action='renewal.won.premium.correct' AND receipt.status='COMPLETED'
      AND receipt.response_status=200 AND policy.version=NEW.expected_policy_version
      AND policy.gross_premium_minor=NEW.previous_premium_minor
  ) THEN RAISE(ABORT,'WON_PREMIUM_CORRECTION_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_policy_links link
    JOIN renewal_opportunities renewal
      ON renewal.agency_id=link.agency_id AND renewal.id=link.renewal_id
    WHERE link.agency_id=NEW.agency_id AND link.new_policy_id=NEW.policy_id
      AND link.status='ACTIVE' AND renewal.state='WON'
  ) OR EXISTS (
    SELECT 1 FROM renewal_policy_links link
    LEFT JOIN renewal_opportunities renewal
      ON renewal.agency_id=link.agency_id AND renewal.id=link.renewal_id
    WHERE link.agency_id=NEW.agency_id AND link.new_policy_id=NEW.policy_id
      AND link.status='ACTIVE' AND COALESCE(renewal.state,'')<>'WON'
  ) THEN RAISE(ABORT,'WON_PREMIUM_CORRECTION_TARGET_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_policy_premium_correction_links_insert_guard
BEFORE INSERT ON renewal_won_policy_premium_correction_links
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_won_policy_premium_corrections correction
    JOIN renewal_policy_links old_link
      ON old_link.agency_id=correction.agency_id AND old_link.id=NEW.old_link_id
    JOIN renewal_opportunities renewal
      ON renewal.agency_id=old_link.agency_id AND renewal.id=old_link.renewal_id
    JOIN policies policy ON policy.agency_id=correction.agency_id AND policy.id=correction.policy_id
    WHERE correction.id=NEW.operation_id AND correction.agency_id=NEW.agency_id
      AND correction.policy_id=NEW.policy_id AND old_link.new_policy_id=NEW.policy_id
      AND old_link.renewal_id=NEW.renewal_id AND old_link.status='ACTIVE'
      AND renewal.state='WON' AND policy.currency=NEW.currency
      AND old_link.currency=NEW.currency
      AND old_link.different_policyholder_reason_code IS NEW.different_policyholder_reason_code
      AND NEW.new_link_id<>NEW.old_link_id
  ) THEN RAISE(ABORT,'WON_PREMIUM_CORRECTION_LINK_PLAN_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_policy_premium_corrections_immutable_update
BEFORE UPDATE ON renewal_won_policy_premium_corrections
BEGIN SELECT RAISE(ABORT,'WON_PREMIUM_CORRECTION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_policy_premium_corrections_immutable_delete
BEFORE DELETE ON renewal_won_policy_premium_corrections
BEGIN SELECT RAISE(ABORT,'WON_PREMIUM_CORRECTION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_policy_premium_correction_links_immutable_update
BEFORE UPDATE ON renewal_won_policy_premium_correction_links
BEGIN SELECT RAISE(ABORT,'WON_PREMIUM_CORRECTION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_policy_premium_correction_links_immutable_delete
BEFORE DELETE ON renewal_won_policy_premium_correction_links
BEGIN SELECT RAISE(ABORT,'WON_PREMIUM_CORRECTION_IMMUTABLE'); END;
--> statement-breakpoint
DROP TRIGGER renewal_policy_links_won_policy_update_lock;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_policy_update_lock
BEFORE UPDATE OF status ON renewal_policy_links
WHEN OLD.status='ACTIVE' AND NEW.status='SUPERSEDED' AND EXISTS (
  SELECT 1 FROM renewal_policy_links won_link
  JOIN renewal_opportunities won_renewal
    ON won_renewal.agency_id=won_link.agency_id AND won_renewal.id=won_link.renewal_id
  WHERE won_link.agency_id=OLD.agency_id AND won_link.new_policy_id=OLD.new_policy_id
    AND won_link.status='ACTIVE' AND won_renewal.state='WON'
) AND NOT EXISTS (
  SELECT 1 FROM renewal_won_policy_premium_correction_links correction_link
  JOIN renewal_won_policy_premium_corrections correction
    ON correction.id=correction_link.operation_id AND correction.agency_id=correction_link.agency_id
  WHERE correction_link.agency_id=OLD.agency_id AND correction_link.old_link_id=OLD.id
    AND correction.policy_id=OLD.new_policy_id AND NEW.superseded_operation_id=correction.id
)
BEGIN SELECT RAISE(ABORT,'RENEWAL_WON_POLICY_LINK_LOCKED'); END;
--> statement-breakpoint
DROP TRIGGER renewal_policy_links_won_policy_insert_lock;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_policy_insert_lock
BEFORE INSERT ON renewal_policy_links
WHEN EXISTS (
  SELECT 1 FROM renewal_policy_links won_link
  JOIN renewal_opportunities won_renewal
    ON won_renewal.agency_id=won_link.agency_id AND won_renewal.id=won_link.renewal_id
  WHERE won_link.agency_id=NEW.agency_id AND won_link.new_policy_id=NEW.new_policy_id
    AND won_link.status='ACTIVE' AND won_renewal.state='WON'
) AND NOT EXISTS (
  SELECT 1 FROM renewal_won_policy_premium_correction_links correction_link
  JOIN renewal_won_policy_premium_corrections correction
    ON correction.id=correction_link.operation_id AND correction.agency_id=correction_link.agency_id
  WHERE correction_link.agency_id=NEW.agency_id AND correction_link.new_link_id=NEW.id
    AND correction_link.renewal_id=NEW.renewal_id
    AND correction_link.policy_id=NEW.new_policy_id
    AND correction_link.allocated_premium_minor=NEW.allocated_new_premium_minor
    AND correction_link.currency=NEW.currency
    AND correction_link.different_policyholder_reason_code IS NEW.different_policyholder_reason_code
    AND correction.id=NEW.allocation_operation_id
    AND correction_link.old_link_id=NEW.supersedes_link_id
)
BEGIN SELECT RAISE(ABORT,'RENEWAL_WON_POLICY_LINK_LOCKED'); END;
--> statement-breakpoint
DROP TRIGGER renewal_policy_links_won_insert_requires_correction;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_insert_requires_correction
BEFORE INSERT ON renewal_policy_links
WHEN EXISTS (
  SELECT 1 FROM renewal_opportunities renewal
  WHERE renewal.agency_id=NEW.agency_id AND renewal.id=NEW.renewal_id AND renewal.state='WON'
) AND NOT EXISTS (
  SELECT 1 FROM renewal_won_policy_premium_correction_links correction_link
  JOIN renewal_won_policy_premium_corrections correction
    ON correction.id=correction_link.operation_id AND correction.agency_id=correction_link.agency_id
  WHERE correction_link.agency_id=NEW.agency_id AND correction_link.new_link_id=NEW.id
    AND correction_link.new_link_id=NEW.id AND correction_link.renewal_id=NEW.renewal_id
    AND correction_link.policy_id=NEW.new_policy_id
    AND correction_link.allocated_premium_minor=NEW.allocated_new_premium_minor
    AND correction_link.currency=NEW.currency
    AND correction_link.different_policyholder_reason_code IS NEW.different_policyholder_reason_code
    AND correction.id=NEW.allocation_operation_id
    AND correction_link.old_link_id=NEW.supersedes_link_id
)
BEGIN SELECT RAISE(ABORT,'RENEWAL_WON_CORRECTION_REQUIRED'); END;
--> statement-breakpoint
DROP TRIGGER renewal_policy_links_won_supersede_requires_correction;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_supersede_requires_correction
BEFORE UPDATE OF status ON renewal_policy_links
WHEN OLD.status='ACTIVE' AND NEW.status='SUPERSEDED' AND EXISTS (
  SELECT 1 FROM renewal_opportunities renewal
  WHERE renewal.agency_id=OLD.agency_id AND renewal.id=OLD.renewal_id AND renewal.state='WON'
) AND NOT EXISTS (
  SELECT 1 FROM renewal_won_policy_premium_correction_links correction_link
  JOIN renewal_won_policy_premium_corrections correction
    ON correction.id=correction_link.operation_id AND correction.agency_id=correction_link.agency_id
  WHERE correction_link.agency_id=OLD.agency_id AND correction_link.old_link_id=OLD.id
    AND correction_link.old_link_id=OLD.id AND correction.id=NEW.superseded_operation_id
)
BEGIN SELECT RAISE(ABORT,'RENEWAL_WON_CORRECTION_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_policy_premium_correction_guard
BEFORE UPDATE OF gross_premium_minor ON policies
WHEN NEW.gross_premium_minor<>OLD.gross_premium_minor AND EXISTS (
  SELECT 1 FROM renewal_policy_links link
  JOIN renewal_opportunities renewal
    ON renewal.agency_id=link.agency_id AND renewal.id=link.renewal_id
  WHERE link.agency_id=OLD.agency_id AND link.new_policy_id=OLD.id AND renewal.state='WON'
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_won_policy_premium_corrections correction
    JOIN operation_receipts receipt ON receipt.id=correction.id
    WHERE correction.agency_id=OLD.agency_id AND correction.policy_id=OLD.id
      AND correction.expected_policy_version=OLD.version
      AND correction.previous_premium_minor=OLD.gross_premium_minor
      AND correction.corrected_premium_minor=NEW.gross_premium_minor
      AND receipt.action='renewal.won.premium.correct' AND receipt.status='COMPLETED'
      AND receipt.response_status=200
      AND NEW.version=OLD.version+1
      AND (SELECT count(*) FROM renewal_won_policy_premium_correction_links plan
           WHERE plan.operation_id=correction.id AND plan.agency_id=OLD.agency_id)
          =(SELECT count(*) FROM renewal_policy_links old_link
            WHERE old_link.agency_id=OLD.agency_id AND old_link.new_policy_id=OLD.id
              AND old_link.status='SUPERSEDED' AND old_link.superseded_operation_id=correction.id)
      AND (SELECT COALESCE(sum(plan.allocated_premium_minor),0)
           FROM renewal_won_policy_premium_correction_links plan
           WHERE plan.operation_id=correction.id AND plan.agency_id=OLD.agency_id)
          =NEW.gross_premium_minor
  ) THEN RAISE(ABORT,'WON_POLICY_PREMIUM_CORRECTION_REQUIRED') END;
END;