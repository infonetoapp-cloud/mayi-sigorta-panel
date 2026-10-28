CREATE TABLE `renewal_policy_links` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`renewal_id` text NOT NULL,
	`new_policy_id` text NOT NULL,
	`allocated_new_premium_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`supersedes_link_id` text,
	`allocation_operation_id` text NOT NULL,
	`different_policyholder_reason_code` text,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`superseded_at` text,
	`superseded_by_membership_id` text,
	`supersede_reason_code` text,
	`superseded_operation_id` text,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`new_policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`superseded_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`supersedes_link_id`) REFERENCES `renewal_policy_links`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`allocation_operation_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`superseded_operation_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_policy_links_id_nonempty" CHECK(length(trim("renewal_policy_links"."id")) > 0),
	CONSTRAINT "renewal_policy_links_allocation_safe" CHECK("renewal_policy_links"."allocated_new_premium_minor" >= 0 AND "renewal_policy_links"."allocated_new_premium_minor" <= 9007199254740991),
	CONSTRAINT "renewal_policy_links_currency_shape" CHECK(length("renewal_policy_links"."currency") = 3 AND "renewal_policy_links"."currency" = upper("renewal_policy_links"."currency")),
	CONSTRAINT "renewal_policy_links_status_valid" CHECK("renewal_policy_links"."status" IN ('ACTIVE','SUPERSEDED')),
	CONSTRAINT "renewal_policy_links_supersession_consistent" CHECK(("renewal_policy_links"."status"='ACTIVE' AND "renewal_policy_links"."superseded_at" IS NULL AND "renewal_policy_links"."superseded_by_membership_id" IS NULL AND "renewal_policy_links"."supersede_reason_code" IS NULL AND "renewal_policy_links"."superseded_operation_id" IS NULL) OR ("renewal_policy_links"."status"='SUPERSEDED' AND "renewal_policy_links"."superseded_at" IS NOT NULL AND "renewal_policy_links"."superseded_by_membership_id" IS NOT NULL AND "renewal_policy_links"."superseded_operation_id" IS NOT NULL AND "renewal_policy_links"."supersede_reason_code" IS NOT NULL AND length(trim("renewal_policy_links"."supersede_reason_code")) BETWEEN 3 AND 64 AND substr("renewal_policy_links"."supersede_reason_code",1,1) GLOB '[A-Z]' AND "renewal_policy_links"."supersede_reason_code" NOT GLOB '*[^A-Z0-9_]*')),
	CONSTRAINT "renewal_policy_links_supersedes_not_self" CHECK("renewal_policy_links"."supersedes_link_id" IS NULL OR "renewal_policy_links"."supersedes_link_id" <> "renewal_policy_links"."id"),
	CONSTRAINT "renewal_policy_links_different_customer_reason_shape" CHECK("renewal_policy_links"."different_policyholder_reason_code" IS NULL OR ("renewal_policy_links"."different_policyholder_reason_code" IS NOT NULL AND length(trim("renewal_policy_links"."different_policyholder_reason_code")) BETWEEN 3 AND 64 AND substr("renewal_policy_links"."different_policyholder_reason_code",1,1) GLOB '[A-Z]' AND "renewal_policy_links"."different_policyholder_reason_code" NOT GLOB '*[^A-Z0-9_]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_policy_links_agency_id_id_uq` ON `renewal_policy_links` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_policy_links_active_logical_uq` ON `renewal_policy_links` (`agency_id`,`renewal_id`,`new_policy_id`) WHERE "renewal_policy_links"."status"='ACTIVE';--> statement-breakpoint
CREATE INDEX `renewal_policy_links_new_policy_idx` ON `renewal_policy_links` (`agency_id`,`new_policy_id`,`status`);--> statement-breakpoint
CREATE INDEX `renewal_policy_links_renewal_idx` ON `renewal_policy_links` (`agency_id`,`renewal_id`,`status`);--> statement-breakpoint
CREATE INDEX `renewal_policy_links_operation_idx` ON `renewal_policy_links` (`agency_id`,`allocation_operation_id`);--> statement-breakpoint
CREATE INDEX `renewal_policy_links_superseded_operation_idx` ON `renewal_policy_links` (`agency_id`,`superseded_operation_id`);--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_validate_insert
BEFORE INSERT ON renewal_policy_links
BEGIN
  SELECT CASE WHEN NEW.status<>'ACTIVE' OR NEW.superseded_at IS NOT NULL
    OR NEW.superseded_by_membership_id IS NOT NULL OR NEW.supersede_reason_code IS NOT NULL
    OR NEW.superseded_operation_id IS NOT NULL
    THEN RAISE(ABORT,'RENEWAL_POLICY_LINK_INSERT_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_opportunities r
    JOIN policies old_policy ON old_policy.agency_id=r.agency_id AND old_policy.id=r.expiring_policy_id
    JOIN policies new_policy ON new_policy.agency_id=r.agency_id AND new_policy.id=NEW.new_policy_id
    WHERE r.agency_id=NEW.agency_id AND r.id=NEW.renewal_id
      AND old_policy.id<>new_policy.id
      AND new_policy.status='ACTIVE' AND new_policy.archived_at IS NULL
      AND new_policy.currency=NEW.currency
      AND ((old_policy.customer_id=new_policy.customer_id AND NEW.different_policyholder_reason_code IS NULL)
        OR (old_policy.customer_id<>new_policy.customer_id AND NEW.different_policyholder_reason_code IS NOT NULL))
  ) THEN RAISE(ABORT,'RENEWAL_POLICY_LINK_TARGET_INVALID') END;
  SELECT CASE WHEN NEW.supersedes_link_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM renewal_policy_links previous
    WHERE previous.agency_id=NEW.agency_id AND previous.id=NEW.supersedes_link_id
      AND previous.renewal_id=NEW.renewal_id AND previous.new_policy_id=NEW.new_policy_id
      AND previous.status='SUPERSEDED'
  ) THEN RAISE(ABORT,'RENEWAL_POLICY_LINK_SUPERSESSION_INVALID') END;
  SELECT CASE WHEN (
    SELECT COALESCE(sum(existing.allocated_new_premium_minor),0)
    FROM renewal_policy_links existing
    WHERE existing.agency_id=NEW.agency_id AND existing.new_policy_id=NEW.new_policy_id
      AND existing.status='ACTIVE'
  ) + NEW.allocated_new_premium_minor > (
    SELECT p.gross_premium_minor FROM policies p
    WHERE p.agency_id=NEW.agency_id AND p.id=NEW.new_policy_id
  ) THEN RAISE(ABORT,'RENEWAL_POLICY_LINK_ALLOCATION_OVERFLOW') END;
  SELECT CASE WHEN NEW.new_policy_id=(
    SELECT r.expiring_policy_id FROM renewal_opportunities r
    WHERE r.agency_id=NEW.agency_id AND r.id=NEW.renewal_id
  ) OR EXISTS (
    WITH RECURSIVE reachable(policy_id) AS (
      SELECT existing_link.new_policy_id
      FROM renewal_policy_links existing_link
      JOIN renewal_opportunities existing_renewal
        ON existing_renewal.agency_id=existing_link.agency_id
       AND existing_renewal.id=existing_link.renewal_id
      WHERE existing_link.agency_id=NEW.agency_id AND existing_link.status='ACTIVE'
        AND existing_renewal.expiring_policy_id=NEW.new_policy_id
      UNION
      SELECT next_link.new_policy_id
      FROM reachable path
      JOIN renewal_opportunities next_renewal
        ON next_renewal.agency_id=NEW.agency_id AND next_renewal.expiring_policy_id=path.policy_id
      JOIN renewal_policy_links next_link
        ON next_link.agency_id=next_renewal.agency_id AND next_link.renewal_id=next_renewal.id
       AND next_link.status='ACTIVE'
    )
    SELECT 1 FROM reachable
    WHERE policy_id=(
      SELECT r.expiring_policy_id FROM renewal_opportunities r
      WHERE r.agency_id=NEW.agency_id AND r.id=NEW.renewal_id
    )
  ) THEN RAISE(ABORT,'RENEWAL_POLICY_LINK_CYCLE') END;
END;--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_supersede_only
BEFORE UPDATE ON renewal_policy_links
WHEN NOT (
  OLD.status='ACTIVE' AND NEW.status='SUPERSEDED'
  AND NEW.id IS OLD.id AND NEW.agency_id IS OLD.agency_id
  AND NEW.renewal_id IS OLD.renewal_id AND NEW.new_policy_id IS OLD.new_policy_id
  AND NEW.allocated_new_premium_minor IS OLD.allocated_new_premium_minor
  AND NEW.currency IS OLD.currency AND NEW.supersedes_link_id IS OLD.supersedes_link_id
  AND NEW.allocation_operation_id IS OLD.allocation_operation_id
  AND NEW.different_policyholder_reason_code IS OLD.different_policyholder_reason_code
  AND NEW.created_by_membership_id IS OLD.created_by_membership_id
  AND NEW.created_at IS OLD.created_at
  AND NEW.superseded_at IS NOT NULL AND NEW.superseded_by_membership_id IS NOT NULL
  AND OLD.superseded_operation_id IS NULL AND NEW.superseded_operation_id IS NOT NULL
  AND NEW.supersede_reason_code IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_POLICY_LINK_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_no_delete
BEFORE DELETE ON renewal_policy_links
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_POLICY_LINK_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_premium_update_guard
BEFORE UPDATE OF gross_premium_minor ON policies
WHEN EXISTS (
  SELECT 1 FROM renewal_policy_links l
  WHERE l.agency_id=OLD.agency_id AND l.new_policy_id=OLD.id AND l.status='ACTIVE'
  GROUP BY l.agency_id,l.new_policy_id
  HAVING sum(l.allocated_new_premium_minor)>NEW.gross_premium_minor
)
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_POLICY_LINK_ALLOCATION_OVERFLOW');
END;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_currency_update_guard
BEFORE UPDATE OF currency ON policies
WHEN EXISTS (
  SELECT 1 FROM renewal_policy_links l
  WHERE l.agency_id=OLD.agency_id AND l.new_policy_id=OLD.id
    AND l.status='ACTIVE' AND l.currency<>NEW.currency
)
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_POLICY_LINK_CURRENCY_MISMATCH');
END;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_premium_immutable
BEFORE UPDATE OF gross_premium_minor ON policies
WHEN EXISTS (
  SELECT 1 FROM renewal_policy_links l
  JOIN renewal_opportunities r ON r.agency_id=l.agency_id AND r.id=l.renewal_id
  WHERE l.agency_id=OLD.agency_id AND l.new_policy_id=OLD.id
    AND l.status='ACTIVE' AND r.state='WON'
) AND NEW.gross_premium_minor<>COALESCE((
  SELECT sum(l.allocated_new_premium_minor)
  FROM renewal_policy_links l
  WHERE l.agency_id=OLD.agency_id AND l.new_policy_id=OLD.id AND l.status='ACTIVE'
),0)
BEGIN
  SELECT RAISE(ABORT,'WON_POLICY_PREMIUM_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_reopen_requires_correction_history
BEFORE UPDATE OF state ON renewal_opportunities
WHEN OLD.state='WON' AND NEW.state<>'WON'
BEGIN
  SELECT CASE WHEN NEW.state NOT IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
    THEN RAISE(ABORT,'WON_CORRECTION_STATE_INVALID') END;
  SELECT CASE WHEN NEW.closed_at IS NOT NULL OR NEW.closed_by_membership_id IS NOT NULL
      OR NEW.loss_reason_id IS NOT NULL OR NEW.loss_reason_notes IS NOT NULL
      OR NEW.void_reason_code IS NOT NULL
    THEN RAISE(ABORT,'WON_CORRECTION_STATE_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_state_history h
    WHERE h.agency_id=NEW.agency_id AND h.renewal_id=NEW.id
      AND h.from_state='WON' AND h.to_state=NEW.state AND h.actor_kind='USER'
      AND h.actor_user_id IS NOT NULL AND h.actor_membership_id IS NOT NULL
      AND h.reason_code='WON_CORRECTED' AND h.created_at=NEW.updated_at
  ) THEN RAISE(ABORT,'RENEWAL_WON_CORRECTION_REQUIRED') END;
END;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_policy_insert_lock
BEFORE INSERT ON renewal_policy_links
WHEN EXISTS (
  SELECT 1 FROM renewal_policy_links won_link
  JOIN renewal_opportunities won_renewal
    ON won_renewal.agency_id=won_link.agency_id AND won_renewal.id=won_link.renewal_id
  WHERE won_link.agency_id=NEW.agency_id AND won_link.new_policy_id=NEW.new_policy_id
    AND won_link.status='ACTIVE' AND won_renewal.state='WON'
)
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_WON_POLICY_LINK_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_policy_update_lock
BEFORE UPDATE OF status ON renewal_policy_links
WHEN OLD.status='ACTIVE' AND NEW.status='SUPERSEDED' AND EXISTS (
  SELECT 1 FROM renewal_policy_links won_link
  JOIN renewal_opportunities won_renewal
    ON won_renewal.agency_id=won_link.agency_id AND won_renewal.id=won_link.renewal_id
  WHERE won_link.agency_id=OLD.agency_id AND won_link.new_policy_id=OLD.new_policy_id
    AND won_link.status='ACTIVE' AND won_renewal.state='WON'
)
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_WON_POLICY_LINK_LOCKED');
END;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_insert_requires_correction
BEFORE INSERT ON renewal_policy_links
WHEN EXISTS (
  SELECT 1 FROM renewal_opportunities r
  WHERE r.agency_id=NEW.agency_id AND r.id=NEW.renewal_id AND r.state='WON'
)
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_WON_CORRECTION_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER renewal_policy_links_won_supersede_requires_correction
BEFORE UPDATE OF status ON renewal_policy_links
WHEN OLD.status='ACTIVE' AND NEW.status='SUPERSEDED' AND EXISTS (
  SELECT 1 FROM renewal_opportunities r
  WHERE r.agency_id=OLD.agency_id AND r.id=OLD.renewal_id AND r.state='WON'
)
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_WON_CORRECTION_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER renewal_won_links_required
BEFORE UPDATE OF state ON renewal_opportunities
WHEN NEW.state='WON'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_policy_links l
    WHERE l.agency_id=NEW.agency_id AND l.renewal_id=NEW.id AND l.status='ACTIVE'
  ) THEN RAISE(ABORT,'RENEWAL_WON_LINK_REQUIRED') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT l.new_policy_id
      FROM renewal_policy_links l
      WHERE l.agency_id=NEW.agency_id AND l.renewal_id=NEW.id AND l.status='ACTIVE'
    ) targets
    JOIN policies p ON p.agency_id=NEW.agency_id AND p.id=targets.new_policy_id
    WHERE COALESCE((
      SELECT sum(l.allocated_new_premium_minor)
      FROM renewal_policy_links l
      WHERE l.agency_id=NEW.agency_id AND l.new_policy_id=targets.new_policy_id AND l.status='ACTIVE'
    ),0)<>p.gross_premium_minor
  ) THEN RAISE(ABORT,'RENEWAL_WON_ALLOCATION_INCOMPLETE') END;
END;