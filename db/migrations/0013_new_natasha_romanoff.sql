CREATE TABLE `renewal_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`renewal_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`company_contact_id` text,
	`outcome` text NOT NULL,
	`channel` text NOT NULL,
	`note` text,
	`occurred_at` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`company_contact_id`) REFERENCES `company_contacts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_interactions_id_nonempty" CHECK(length(trim("renewal_interactions"."id"))>0),
	CONSTRAINT "renewal_interactions_outcome_valid" CHECK("renewal_interactions"."outcome" IN ('CONTACT_CONFIRMED','ATTEMPT_NO_RESPONSE','WHATSAPP_OPENED','NOTE')),
	CONSTRAINT "renewal_interactions_note_consistent" CHECK(("renewal_interactions"."outcome"='NOTE' AND "renewal_interactions"."note" IS NOT NULL AND length(trim("renewal_interactions"."note")) BETWEEN 1 AND 1000 AND "renewal_interactions"."channel"='OTHER') OR ("renewal_interactions"."outcome"<>'NOTE' AND "renewal_interactions"."note" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_interactions_agency_id_id_uq` ON `renewal_interactions` (`agency_id`,`id`);--> statement-breakpoint
CREATE INDEX `renewal_interactions_renewal_time_idx` ON `renewal_interactions` (`agency_id`,`renewal_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `renewal_quote_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`quote_version_id` text NOT NULL,
	`event` text NOT NULL,
	`operation_receipt_id` text NOT NULL,
	`accepted_policy_id` text,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`quote_id`) REFERENCES `renewal_quotes`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`quote_id`,`quote_version_id`) REFERENCES `renewal_quote_versions`(`agency_id`,`quote_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`operation_receipt_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`accepted_policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_quote_events_id_nonempty" CHECK(length(trim("renewal_quote_events"."id"))>0),
	CONSTRAINT "renewal_quote_events_acceptance_policy" CHECK(("renewal_quote_events"."event"='ACCEPTED' AND "renewal_quote_events"."accepted_policy_id" IS NOT NULL) OR ("renewal_quote_events"."event"<>'ACCEPTED' AND "renewal_quote_events"."accepted_policy_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_quote_events_agency_id_id_uq` ON `renewal_quote_events` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_quote_events_version_event_uq` ON `renewal_quote_events` (`agency_id`,`quote_version_id`,`event`);--> statement-breakpoint
CREATE INDEX `renewal_quote_events_quote_idx` ON `renewal_quote_events` (`agency_id`,`quote_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `renewal_quote_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`quote_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`insurer_id` text NOT NULL,
	`product_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`payment_method_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`valid_until` text NOT NULL,
	`gross_premium_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`installment_count` integer,
	`terms_summary` text,
	`created_by_user_id` text NOT NULL,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`quote_id`) REFERENCES `renewal_quotes`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`insurer_id`) REFERENCES `insurers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`product_id`) REFERENCES `insurance_products`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`branch_id`) REFERENCES `insurance_branches`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`payment_method_id`) REFERENCES `payment_methods`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_quote_versions_id_nonempty" CHECK(length(trim("renewal_quote_versions"."id")) > 0),
	CONSTRAINT "renewal_quote_versions_number_positive" CHECK("renewal_quote_versions"."version_number" >= 1),
	CONSTRAINT "renewal_quote_versions_premium_safe" CHECK("renewal_quote_versions"."gross_premium_minor" >= 0 AND "renewal_quote_versions"."gross_premium_minor" <= 9007199254740991),
	CONSTRAINT "renewal_quote_versions_currency_shape" CHECK(length("renewal_quote_versions"."currency")=3 AND "renewal_quote_versions"."currency"=upper("renewal_quote_versions"."currency")),
	CONSTRAINT "renewal_quote_versions_date_shape" CHECK("renewal_quote_versions"."start_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "renewal_quote_versions"."end_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "renewal_quote_versions"."end_date">"renewal_quote_versions"."start_date"),
	CONSTRAINT "renewal_quote_versions_installment_count" CHECK("renewal_quote_versions"."installment_count" IS NULL OR "renewal_quote_versions"."installment_count" BETWEEN 2 AND 36),
	CONSTRAINT "renewal_quote_versions_terms_length" CHECK("renewal_quote_versions"."terms_summary" IS NULL OR length("renewal_quote_versions"."terms_summary")<=1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_quote_versions_agency_id_id_uq` ON `renewal_quote_versions` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_quote_versions_quote_number_uq` ON `renewal_quote_versions` (`agency_id`,`quote_id`,`version_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_quote_versions_quote_id_uq` ON `renewal_quote_versions` (`agency_id`,`quote_id`,`id`);--> statement-breakpoint
CREATE INDEX `renewal_quote_versions_policy_idx` ON `renewal_quote_versions` (`agency_id`,`product_id`,`insurer_id`);--> statement-breakpoint
CREATE TABLE `renewal_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`renewal_id` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`current_version_id` text,
	`accepted_version_id` text,
	`accepted_policy_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`accepted_policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_quotes_id_nonempty" CHECK(length(trim("renewal_quotes"."id")) > 0),
	CONSTRAINT "renewal_quotes_status_valid" CHECK("renewal_quotes"."status" IN ('DRAFT','READY','SENT','ACCEPTED','REJECTED','EXPIRED')),
	CONSTRAINT "renewal_quotes_version_positive" CHECK("renewal_quotes"."version" >= 1),
	CONSTRAINT "renewal_quotes_acceptance_consistent" CHECK(("renewal_quotes"."status"='ACCEPTED' AND "renewal_quotes"."accepted_version_id" IS NOT NULL AND "renewal_quotes"."accepted_policy_id" IS NOT NULL) OR ("renewal_quotes"."status"<>'ACCEPTED' AND "renewal_quotes"."accepted_version_id" IS NULL AND "renewal_quotes"."accepted_policy_id" IS NULL)),
	CONSTRAINT "renewal_quotes_timestamps_ordered" CHECK("renewal_quotes"."updated_at" >= "renewal_quotes"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_quotes_agency_id_id_uq` ON `renewal_quotes` (`agency_id`,`id`);--> statement-breakpoint
CREATE INDEX `renewal_quotes_renewal_status_idx` ON `renewal_quotes` (`agency_id`,`renewal_id`,`status`);--> statement-breakpoint
CREATE TRIGGER renewal_quote_versions_validate_insert
BEFORE INSERT ON renewal_quote_versions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_quotes q
    WHERE q.agency_id=NEW.agency_id AND q.id=NEW.quote_id
      AND q.status<>'ACCEPTED'
      AND NEW.version_number=COALESCE((
        SELECT max(v.version_number)+1 FROM renewal_quote_versions v
        WHERE v.agency_id=NEW.agency_id AND v.quote_id=NEW.quote_id
      ),1)
  ) THEN RAISE(ABORT,'RENEWAL_QUOTE_VERSION_INVALID') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM insurance_products product
    JOIN insurers insurer ON insurer.agency_id=product.agency_id AND insurer.id=product.insurer_id
    JOIN insurance_branches branch ON branch.agency_id=product.agency_id AND branch.id=product.branch_id
    JOIN payment_methods payment ON payment.agency_id=NEW.agency_id AND payment.id=NEW.payment_method_id
    WHERE product.agency_id=NEW.agency_id AND product.id=NEW.product_id
      AND product.insurer_id=NEW.insurer_id AND product.branch_id=NEW.branch_id
      AND product.status='ACTIVE' AND insurer.status='ACTIVE' AND branch.status='ACTIVE'
      AND payment.status='ACTIVE'
      AND (NEW.installment_count IS NULL OR
        (payment.supports_installments=1 AND NEW.installment_count BETWEEN 2 AND payment.max_installments))
  ) THEN RAISE(ABORT,'RENEWAL_QUOTE_CATALOG_INVALID') END;
END;--> statement-breakpoint
CREATE TRIGGER renewal_quote_versions_immutable_update
BEFORE UPDATE ON renewal_quote_versions
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_QUOTE_VERSION_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_quote_versions_immutable_delete
BEFORE DELETE ON renewal_quote_versions
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_QUOTE_VERSION_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_quote_events_validate_insert
BEFORE INSERT ON renewal_quote_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_quotes q JOIN renewal_quote_versions v
      ON v.agency_id=q.agency_id AND v.quote_id=q.id
    WHERE q.agency_id=NEW.agency_id AND q.id=NEW.quote_id
      AND v.id=NEW.quote_version_id
      AND ((NEW.event='SENT' AND q.status IN ('DRAFT','READY') AND q.current_version_id=v.id
            AND EXISTS(SELECT 1 FROM operation_receipts r WHERE r.id=NEW.operation_receipt_id
              AND r.agency_id=NEW.agency_id AND r.action='renewal.quote.send'
              AND r.status='COMPLETED' AND r.response_status IN (200,201)))
        OR (NEW.event='ACCEPTED' AND q.status='SENT'
            AND EXISTS(SELECT 1 FROM renewal_quote_events sent WHERE sent.agency_id=NEW.agency_id
              AND sent.quote_id=q.id AND sent.quote_version_id=v.id AND sent.event='SENT')
            AND EXISTS(SELECT 1 FROM renewal_quotes accepted
              JOIN renewal_opportunities renewal ON renewal.agency_id=accepted.agency_id
                AND renewal.id=accepted.renewal_id
              JOIN renewal_policy_links link ON link.agency_id=renewal.agency_id
                AND link.renewal_id=renewal.id AND link.new_policy_id=NEW.accepted_policy_id
                AND link.status='ACTIVE'
              WHERE accepted.agency_id=q.agency_id AND accepted.id=q.id AND renewal.state='WON')
            AND EXISTS(SELECT 1 FROM operation_receipts r WHERE r.id=NEW.operation_receipt_id
              AND r.agency_id=NEW.agency_id AND r.action='renewal.close_won'
              AND r.status='COMPLETED' AND r.response_status IN (200,201)))
        OR (NEW.event='REJECTED' AND q.status IN ('SENT','READY'))
        OR (NEW.event='EXPIRED' AND q.status IN ('SENT','READY')))
  ) THEN RAISE(ABORT,'RENEWAL_QUOTE_EVENT_INVALID') END;
END;--> statement-breakpoint
CREATE TRIGGER renewal_quote_events_immutable_update
BEFORE UPDATE ON renewal_quote_events
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_QUOTE_EVENT_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_quote_events_immutable_delete
BEFORE DELETE ON renewal_quote_events
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_QUOTE_EVENT_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_quotes_current_version_guard
BEFORE UPDATE OF current_version_id ON renewal_quotes
WHEN NEW.current_version_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_quote_versions v
    WHERE v.agency_id=NEW.agency_id AND v.quote_id=NEW.id AND v.id=NEW.current_version_id
  ) THEN RAISE(ABORT,'RENEWAL_QUOTE_VERSION_INVALID') END;
END;--> statement-breakpoint
CREATE TRIGGER renewal_quotes_status_evidence_guard
BEFORE UPDATE OF status,accepted_version_id,accepted_policy_id ON renewal_quotes
BEGIN
  SELECT CASE WHEN NEW.status='SENT' AND NOT EXISTS (
    SELECT 1 FROM renewal_quote_events e WHERE e.agency_id=NEW.agency_id AND e.quote_id=NEW.id
      AND e.quote_version_id=NEW.current_version_id AND e.event='SENT'
  ) THEN RAISE(ABORT,'RENEWAL_QUOTE_SEND_EVIDENCE_REQUIRED') END;
  SELECT CASE WHEN NEW.status='ACCEPTED' AND NOT EXISTS (
    SELECT 1 FROM renewal_quote_events e WHERE e.agency_id=NEW.agency_id AND e.quote_id=NEW.id
      AND e.quote_version_id=NEW.accepted_version_id AND e.accepted_policy_id=NEW.accepted_policy_id
      AND e.event='ACCEPTED'
  ) THEN RAISE(ABORT,'RENEWAL_QUOTE_ACCEPTANCE_EVIDENCE_REQUIRED') END;
END;--> statement-breakpoint
CREATE TRIGGER renewal_interactions_validate_insert
BEFORE INSERT ON renewal_interactions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_opportunities renewal
    JOIN policies source_policy ON source_policy.agency_id=renewal.agency_id
      AND source_policy.id=renewal.expiring_policy_id
    JOIN customers customer ON customer.agency_id=source_policy.agency_id
      AND customer.id=source_policy.customer_id
    WHERE renewal.agency_id=NEW.agency_id AND renewal.id=NEW.renewal_id
      AND customer.id=NEW.customer_id AND customer.archived_at IS NULL
  ) THEN RAISE(ABORT,'RENEWAL_INTERACTION_TARGET_INVALID') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM customers customer
    WHERE customer.agency_id=NEW.agency_id AND customer.id=NEW.customer_id
      AND ((customer.type='COMPANY' AND (NEW.company_contact_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM company_contacts contact WHERE contact.agency_id=NEW.agency_id
          AND contact.id=NEW.company_contact_id AND contact.customer_id=NEW.customer_id
          AND contact.status='ACTIVE')))
        OR (customer.type='INDIVIDUAL' AND NEW.company_contact_id IS NOT NULL))
  ) THEN RAISE(ABORT,'RENEWAL_INTERACTION_COMPANY_CONTACT_INVALID') END;
END;--> statement-breakpoint
CREATE TRIGGER renewal_interactions_immutable_update
BEFORE UPDATE ON renewal_interactions
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_INTERACTION_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_interactions_immutable_delete
BEFORE DELETE ON renewal_interactions
BEGIN
  SELECT RAISE(ABORT,'RENEWAL_INTERACTION_IMMUTABLE');
END;