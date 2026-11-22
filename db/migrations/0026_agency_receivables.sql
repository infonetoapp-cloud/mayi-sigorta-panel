CREATE TABLE `finance_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`receivable_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`received_date` text NOT NULL,
	`method` text NOT NULL,
	`reverses_id` text,
	`reason_code` text,
	`actor_membership_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`receivable_id`) REFERENCES `finance_receivables`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "finance_entry_amount" CHECK("finance_entries"."amount_minor">0 AND "finance_entries"."amount_minor"<=9007199254740991),
	CONSTRAINT "finance_entry_kind" CHECK(("finance_entries"."kind"='PAYMENT' AND "finance_entries"."reverses_id" IS NULL AND "finance_entries"."reason_code" IS NULL) OR ("finance_entries"."kind"='REVERSAL' AND "finance_entries"."reverses_id" IS NOT NULL AND "finance_entries"."reason_code" IS NOT NULL)),
	CONSTRAINT "finance_entry_method" CHECK("finance_entries"."method" IN ('CASH','BANK','CARD')),
	CONSTRAINT "finance_entry_date" CHECK(length("finance_entries"."received_date")=10 AND date("finance_entries"."received_date",'+0 days')="finance_entries"."received_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_entries_agency_id_uq` ON `finance_entries` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_entries_reversal_uq` ON `finance_entries` (`agency_id`,`reverses_id`);--> statement-breakpoint
CREATE INDEX `finance_entries_receivable_idx` ON `finance_entries` (`agency_id`,`receivable_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `finance_receivables` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`due_date` text NOT NULL,
	`method` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "finance_receivable_amount" CHECK("finance_receivables"."amount_minor">0 AND "finance_receivables"."amount_minor"<=9007199254740991),
	CONSTRAINT "finance_receivable_currency" CHECK(length("finance_receivables"."currency")=3 AND "finance_receivables"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "finance_receivable_date" CHECK(length("finance_receivables"."due_date")=10 AND date("finance_receivables"."due_date",'+0 days')="finance_receivables"."due_date"),
	CONSTRAINT "finance_receivable_method" CHECK("finance_receivables"."method" IN ('DEFERRED','CASH','BANK','CARD')),
	CONSTRAINT "finance_receivable_state" CHECK("finance_receivables"."status" IN ('ACTIVE','VOIDED') AND "finance_receivables"."version">=1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_receivables_agency_id_uq` ON `finance_receivables` (`agency_id`,`id`);--> statement-breakpoint
CREATE INDEX `finance_receivables_due_idx` ON `finance_receivables` (`agency_id`,`due_date`,`id`);--> statement-breakpoint
CREATE INDEX `finance_receivables_policy_idx` ON `finance_receivables` (`agency_id`,`policy_id`);--> statement-breakpoint
CREATE TABLE `finance_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`receivable_id` text NOT NULL,
	`version` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`due_date` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`actor_membership_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`receivable_id`) REFERENCES `finance_receivables`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_revisions_version_uq` ON `finance_revisions` (`agency_id`,`receivable_id`,`version`);--> statement-breakpoint
CREATE TRIGGER finance_receivable_insert_guard BEFORE INSERT ON finance_receivables BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM policies p WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.customer_id=NEW.customer_id AND p.currency=NEW.currency) OR typeof(NEW.amount_minor)<>'integer' OR date(NEW.due_date,'+0 days') IS NULL THEN RAISE(ABORT,'FINANCE_PARENT_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER finance_receivable_update_guard BEFORE UPDATE ON finance_receivables BEGIN
 SELECT CASE WHEN NEW.agency_id<>OLD.agency_id OR NEW.id<>OLD.id OR NEW.policy_id<>OLD.policy_id OR NEW.customer_id<>OLD.customer_id OR NEW.currency<>OLD.currency OR NEW.method<>OLD.method OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR OLD.status='VOIDED' OR typeof(NEW.amount_minor)<>'integer' OR date(NEW.due_date,'+0 days') IS NULL THEN RAISE(ABORT,'FINANCE_RECEIVABLE_IMMUTABLE') END;
 SELECT CASE WHEN NEW.amount_minor<(SELECT coalesce(sum(CASE WHEN e.kind='PAYMENT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM finance_entries e WHERE e.agency_id=OLD.agency_id AND e.receivable_id=OLD.id) OR (NEW.status='VOIDED' AND (SELECT coalesce(sum(CASE WHEN e.kind='PAYMENT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM finance_entries e WHERE e.agency_id=OLD.agency_id AND e.receivable_id=OLD.id)<>0) THEN RAISE(ABORT,'FINANCE_BALANCE_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER finance_receivable_no_delete BEFORE DELETE ON finance_receivables BEGIN SELECT RAISE(ABORT,'FINANCE_HISTORY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER finance_entry_insert_guard BEFORE INSERT ON finance_entries BEGIN
 SELECT CASE WHEN typeof(NEW.amount_minor)<>'integer' OR date(NEW.received_date,'+0 days') IS NULL OR (NEW.reason_code IS NOT NULL AND NEW.reason_code NOT IN ('DATA_ERROR','DUE_DATE_CHANGED','DUPLICATE','CUSTOMER_AGREED','OTHER')) OR NOT EXISTS(SELECT 1 FROM finance_receivables r WHERE r.agency_id=NEW.agency_id AND r.id=NEW.receivable_id AND r.status='ACTIVE') THEN RAISE(ABORT,'FINANCE_ENTRY_INVALID') END;
 SELECT CASE WHEN NEW.kind='REVERSAL' AND NOT EXISTS(SELECT 1 FROM finance_entries e WHERE e.agency_id=NEW.agency_id AND e.id=NEW.reverses_id AND e.receivable_id=NEW.receivable_id AND e.kind='PAYMENT' AND e.amount_minor=NEW.amount_minor AND e.method=NEW.method) THEN RAISE(ABORT,'FINANCE_REVERSAL_INVALID') END;
 SELECT CASE WHEN (SELECT coalesce(sum(CASE WHEN e.kind='PAYMENT' THEN e.amount_minor ELSE -e.amount_minor END),0) FROM finance_entries e WHERE e.agency_id=NEW.agency_id AND e.receivable_id=NEW.receivable_id)+(CASE WHEN NEW.kind='PAYMENT' THEN NEW.amount_minor ELSE -NEW.amount_minor END) NOT BETWEEN 0 AND (SELECT amount_minor FROM finance_receivables WHERE agency_id=NEW.agency_id AND id=NEW.receivable_id) THEN RAISE(ABORT,'FINANCE_BALANCE_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER finance_entry_no_update BEFORE UPDATE ON finance_entries BEGIN SELECT RAISE(ABORT,'FINANCE_HISTORY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER finance_entry_no_delete BEFORE DELETE ON finance_entries BEGIN SELECT RAISE(ABORT,'FINANCE_HISTORY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER finance_revision_insert_guard BEFORE INSERT ON finance_revisions BEGIN
 SELECT CASE WHEN (NEW.version=1 AND NEW.reason_code IS NOT NULL) OR (NEW.version>1 AND (NEW.reason_code IS NULL OR NEW.reason_code NOT IN ('DATA_ERROR','DUE_DATE_CHANGED','DUPLICATE','CUSTOMER_AGREED','OTHER'))) OR NOT EXISTS(SELECT 1 FROM finance_receivables r WHERE r.agency_id=NEW.agency_id AND r.id=NEW.receivable_id AND r.version=NEW.version AND r.amount_minor=NEW.amount_minor AND r.due_date=NEW.due_date AND r.status=NEW.status) THEN RAISE(ABORT,'FINANCE_REVISION_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER finance_revision_no_update BEFORE UPDATE ON finance_revisions BEGIN SELECT RAISE(ABORT,'FINANCE_HISTORY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER finance_revision_no_delete BEFORE DELETE ON finance_revisions BEGIN SELECT RAISE(ABORT,'FINANCE_HISTORY_IMMUTABLE'); END;
