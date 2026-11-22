CREATE TABLE `sales_price_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`price_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`terms_note` text,
	`offered_start_date` text,
	`offered_end_date` text,
	`created_by_user_id` text NOT NULL,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`price_id`) REFERENCES `sales_prices`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_price_revisions_number" CHECK("sales_price_revisions"."revision_number">=1),
	CONSTRAINT "sales_price_revisions_amount" CHECK("sales_price_revisions"."amount_minor">=0 AND "sales_price_revisions"."amount_minor"<=9007199254740991),
	CONSTRAINT "sales_price_revisions_currency" CHECK(length("sales_price_revisions"."currency")=3 AND "sales_price_revisions"."currency" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "sales_price_revisions_note" CHECK("sales_price_revisions"."terms_note" IS NULL OR length("sales_price_revisions"."terms_note") BETWEEN 1 AND 1000),
	CONSTRAINT "sales_price_revisions_period" CHECK(("sales_price_revisions"."offered_start_date" IS NULL AND "sales_price_revisions"."offered_end_date" IS NULL) OR ("sales_price_revisions"."offered_start_date" IS NOT NULL AND "sales_price_revisions"."offered_end_date" IS NOT NULL AND length("sales_price_revisions"."offered_start_date")=10 AND date("sales_price_revisions"."offered_start_date") IS NOT NULL AND date("sales_price_revisions"."offered_start_date")="sales_price_revisions"."offered_start_date" AND length("sales_price_revisions"."offered_end_date")=10 AND date("sales_price_revisions"."offered_end_date") IS NOT NULL AND date("sales_price_revisions"."offered_end_date")="sales_price_revisions"."offered_end_date" AND "sales_price_revisions"."offered_end_date">="sales_price_revisions"."offered_start_date"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_price_revisions_agency_id_uq` ON `sales_price_revisions` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_price_revisions_pointer_uq` ON `sales_price_revisions` (`agency_id`,`price_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_price_revisions_number_uq` ON `sales_price_revisions` (`agency_id`,`price_id`,`revision_number`);--> statement-breakpoint
CREATE TABLE `sales_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`case_id` text NOT NULL,
	`insurer_id` text NOT NULL,
	`current_revision_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`case_id`) REFERENCES `sales_cases`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`insurer_id`) REFERENCES `insurers`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`id`,`current_revision_id`) REFERENCES `sales_price_revisions`(`agency_id`,`price_id`,`id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "sales_prices_version" CHECK("sales_prices"."version">=1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_prices_agency_id_uq` ON `sales_prices` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_prices_company_uq` ON `sales_prices` (`agency_id`,`case_id`,`insurer_id`);--> statement-breakpoint
CREATE INDEX `sales_prices_case_page` ON `sales_prices` (`agency_id`,`case_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER sales_prices_insert_guard BEFORE INSERT ON sales_prices
WHEN NEW.version<>1 OR NOT EXISTS(SELECT 1 FROM sales_cases s JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN insurers i ON i.agency_id=s.agency_id AND i.id=NEW.insurer_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND c.archived_at IS NULL AND i.status='ACTIVE'
 AND ((s.context_kind='NEW_BUSINESS' AND s.result='OPEN') OR (s.context_kind='RENEWAL' AND EXISTS(
 SELECT 1 FROM renewal_opportunities r JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
 WHERE r.agency_id=s.agency_id AND r.id=s.renewal_id AND r.state NOT IN ('WON','LOST','VOIDED') AND r.closed_at IS NULL AND p.status='ACTIVE' AND p.archived_at IS NULL))))
BEGIN SELECT RAISE(ABORT,'SALES_PRICE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_prices_update_guard BEFORE UPDATE ON sales_prices
WHEN NEW.id<>OLD.id OR NEW.agency_id<>OLD.agency_id OR NEW.case_id<>OLD.case_id OR NEW.insurer_id<>OLD.insurer_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR NEW.current_revision_id=OLD.current_revision_id OR NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND c.archived_at IS NULL
 AND ((s.context_kind='NEW_BUSINESS' AND s.result='OPEN') OR (s.context_kind='RENEWAL' AND EXISTS(
 SELECT 1 FROM renewal_opportunities r JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
 WHERE r.agency_id=s.agency_id AND r.id=s.renewal_id AND r.state NOT IN ('WON','LOST','VOIDED') AND r.closed_at IS NULL AND p.status='ACTIVE' AND p.archived_at IS NULL))))
BEGIN SELECT RAISE(ABORT,'SALES_PRICE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_prices_no_delete BEFORE DELETE ON sales_prices BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_price_revisions_insert_guard BEFORE INSERT ON sales_price_revisions
WHEN NOT EXISTS(SELECT 1 FROM sales_prices p JOIN agency_memberships m ON m.agency_id=p.agency_id AND m.id=NEW.created_by_membership_id
 WHERE p.agency_id=NEW.agency_id AND p.id=NEW.price_id AND p.current_revision_id=NEW.id AND p.version=NEW.revision_number
 AND m.user_id=NEW.created_by_user_id AND m.status='ACTIVE')
BEGIN SELECT RAISE(ABORT,'SALES_PRICE_REVISION_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_price_revisions_no_update BEFORE UPDATE ON sales_price_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_price_revisions_no_delete BEFORE DELETE ON sales_price_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
DROP TRIGGER sales_case_history_guard;
--> statement-breakpoint
CREATE TRIGGER sales_case_history_guard BEFORE INSERT ON sales_case_history
WHEN NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=NEW.task_id
 JOIN tasks t ON t.agency_id=s.agency_id AND t.id=l.task_id JOIN operation_receipts o ON o.id=NEW.receipt_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND s.version=NEW.case_version
 AND o.agency_id=s.agency_id AND o.actor_user_id=NEW.actor_user_id AND o.actor_membership_id=NEW.actor_membership_id AND o.status='COMPLETED'
 AND json_extract(o.response_body,'$.result.caseId')=s.id AND json_extract(o.response_body,'$.result.caseVersion')=s.version
 AND json_extract(o.response_body,'$.result.taskId')=t.id AND json_extract(o.response_body,'$.result.taskVersion')=t.version AND json_extract(o.response_body,'$.result.dueAt')=t.due_at
 AND ((s.context_kind='NEW_BUSINESS' AND s.active_task_id=t.id AND o.action IN ('sales.case.create','sales.case.followup'))
 OR (s.context_kind='RENEWAL' AND s.version=1 AND NEW.event_code='ADOPTED' AND NEW.reason_code IS NULL AND NEW.notes IS NULL AND o.action='sales.case.adopt' AND o.response_status=201
 AND json_extract(o.response_body,'$.command.context')='RENEWAL' AND json_extract(o.response_body,'$.command.renewalId')=s.renewal_id
 AND json_extract(o.response_body,'$.targetId')=s.customer_id AND json_extract(o.response_body,'$.command.expectedPrimaryTaskId')=t.id AND json_extract(o.response_body,'$.command.expectedPrimaryTaskVersion')=t.version
 AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN' AND t.renewal_id=s.renewal_id
 AND EXISTS(SELECT 1 FROM renewal_opportunities r WHERE r.agency_id=s.agency_id AND r.id=s.renewal_id AND r.version=json_extract(o.response_body,'$.command.expectedVersion') AND r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED') AND r.assignee_membership_id IS t.assignee_membership_id))))
 AND NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN sales_prices p ON p.agency_id=s.agency_id AND p.case_id=s.id
 JOIN sales_price_revisions v ON v.agency_id=p.agency_id AND v.price_id=p.id AND v.id=p.current_revision_id
 JOIN operation_receipts o ON o.id=NEW.receipt_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND s.version=NEW.case_version
 AND NEW.task_id IS NULL AND NEW.reason_code IS NULL AND NEW.notes IS NULL
 AND o.agency_id=s.agency_id AND o.status='COMPLETED' AND o.actor_user_id=NEW.actor_user_id AND o.actor_membership_id=NEW.actor_membership_id
 AND json_extract(o.response_body,'$.targetId')=s.id AND json_extract(o.response_body,'$.result.operationId')=o.id
 AND json_extract(o.response_body,'$.result.caseId')=s.id AND json_extract(o.response_body,'$.result.caseVersion')=s.version
 AND json_extract(o.response_body,'$.command.expectedCaseVersion')=s.version-1
 AND json_extract(o.response_body,'$.result.priceId')=p.id AND json_extract(o.response_body,'$.result.priceVersion')=p.version
 AND json_extract(o.response_body,'$.result.revisionId')=v.id AND json_extract(o.response_body,'$.result.revisionNumber')=v.revision_number
 AND v.created_by_user_id=NEW.actor_user_id AND v.created_by_membership_id=NEW.actor_membership_id AND v.created_at=NEW.created_at
 AND ((o.action='sales.price.create' AND o.response_status=201 AND NEW.event_code='PRICE_CREATED' AND p.version=1 AND v.revision_number=1 AND json_extract(o.response_body,'$.priceId') IS NULL)
 OR (o.action='sales.price.revise' AND o.response_status=200 AND NEW.event_code='PRICE_REVISED' AND json_extract(o.response_body,'$.priceId')=p.id AND json_extract(o.response_body,'$.command.expectedPriceVersion')=p.version-1)))
BEGIN SELECT RAISE(ABORT,'SALES_HISTORY_INVALID'); END;
