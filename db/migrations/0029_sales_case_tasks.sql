CREATE TABLE `sales_case_history` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`case_id` text NOT NULL,
	`case_version` integer NOT NULL,
	`event_code` text NOT NULL,
	`task_id` text,
	`reason_code` text,
	`notes` text,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`case_id`) REFERENCES `sales_cases`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`task_id`) REFERENCES `tasks`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_case_history_version" CHECK("sales_case_history"."case_version">=1),
	CONSTRAINT "sales_case_history_notes" CHECK("sales_case_history"."notes" IS NULL OR length("sales_case_history"."notes") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_history_event_uq` ON `sales_case_history` (`agency_id`,`case_id`,`case_version`,`event_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_history_receipt_uq` ON `sales_case_history` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `sales_case_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`case_id` text NOT NULL,
	`task_id` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`case_id`) REFERENCES `sales_cases`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`task_id`) REFERENCES `tasks`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_case_tasks_purpose" CHECK("sales_case_tasks"."purpose" IN ('ACTIVE_CONTACT','NEXT_CYCLE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_tasks_relation_uq` ON `sales_case_tasks` (`agency_id`,`case_id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_tasks_task_uq` ON `sales_case_tasks` (`agency_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `sales_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`data_classification` text NOT NULL,
	`context_kind` text NOT NULL,
	`renewal_id` text,
	`source_policy_id` text,
	`cycle_date` text,
	`date_basis` text NOT NULL,
	`result` text,
	`active_task_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`branch_id`) REFERENCES `insurance_branches`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`source_policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`id`,`active_task_id`) REFERENCES `sales_case_tasks`(`agency_id`,`case_id`,`task_id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "sales_cases_context" CHECK(("sales_cases"."context_kind"='NEW_BUSINESS' AND "sales_cases"."renewal_id" IS NULL AND "sales_cases"."result" IN ('OPEN','WON','LOST','VOIDED')) OR ("sales_cases"."context_kind"='RENEWAL' AND "sales_cases"."renewal_id" IS NOT NULL AND "sales_cases"."result" IS NULL AND "sales_cases"."active_task_id" IS NULL)),
	CONSTRAINT "sales_cases_active_task" CHECK(("sales_cases"."context_kind"='NEW_BUSINESS' AND "sales_cases"."result"='OPEN' AND "sales_cases"."active_task_id" IS NOT NULL) OR (NOT ("sales_cases"."context_kind"='NEW_BUSINESS' AND "sales_cases"."result"='OPEN') AND "sales_cases"."active_task_id" IS NULL)),
	CONSTRAINT "sales_cases_class" CHECK("sales_cases"."data_classification" IN ('GENERAL','HEALTH')),
	CONSTRAINT "sales_cases_version" CHECK("sales_cases"."version">=1),
	CONSTRAINT "sales_cases_date_basis" CHECK("sales_cases"."date_basis" IN ('KNOWN_END_DATE','MANUAL') AND ("sales_cases"."date_basis"<>'KNOWN_END_DATE' OR "sales_cases"."cycle_date" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_cases_agency_id_uq` ON `sales_cases` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_cases_renewal_uq` ON `sales_cases` (`agency_id`,`renewal_id`);--> statement-breakpoint
CREATE INDEX `sales_cases_customer_page` ON `sales_cases` (`agency_id`,`customer_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER sales_case_tasks_guard BEFORE INSERT ON sales_case_tasks
WHEN NOT EXISTS(SELECT 1 FROM sales_cases s JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND s.context_kind='NEW_BUSINESS' AND t.id=NEW.task_id AND t.kind='GENERAL' AND t.renewal_id IS NULL AND t.policy_id IS NULL AND t.status='OPEN')
BEGIN SELECT RAISE(ABORT,'SALES_TASK_LINK_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_insert_guard BEFORE INSERT ON sales_cases
WHEN NEW.context_kind<>'NEW_BUSINESS' OR NEW.result<>'OPEN' OR NEW.version<>1 OR NOT EXISTS(
 SELECT 1 FROM customers c JOIN insurance_branches b ON b.agency_id=c.agency_id
 JOIN tasks t ON t.agency_id=c.agency_id AND t.customer_id=c.id
 JOIN agency_memberships m ON m.agency_id=c.agency_id AND m.id=NEW.created_by_membership_id
 WHERE c.agency_id=NEW.agency_id AND c.id=NEW.customer_id AND c.archived_at IS NULL AND b.id=NEW.branch_id AND b.status='ACTIVE'
 AND NEW.data_classification=b.data_classification AND t.id=NEW.active_task_id AND t.kind='GENERAL' AND t.status='OPEN' AND t.policy_id IS NULL AND t.renewal_id IS NULL AND m.user_id=NEW.created_by_user_id AND m.status='ACTIVE' AND t.assignee_membership_id=m.id)
 OR (NEW.cycle_date IS NOT NULL AND (length(NEW.cycle_date)<>10 OR date(NEW.cycle_date) IS NULL OR date(NEW.cycle_date)<>NEW.cycle_date))
BEGIN SELECT RAISE(ABORT,'SALES_CASE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_update_guard BEFORE UPDATE ON sales_cases
WHEN NEW.agency_id<>OLD.agency_id OR NEW.id<>OLD.id OR NEW.customer_id<>OLD.customer_id OR NEW.branch_id<>OLD.branch_id OR NEW.context_kind<>OLD.context_kind OR NEW.renewal_id IS NOT OLD.renewal_id OR NEW.source_policy_id IS NOT OLD.source_policy_id OR NEW.created_by_user_id<>OLD.created_by_user_id OR NEW.created_by_membership_id<>OLD.created_by_membership_id OR NEW.created_at<>OLD.created_at OR (OLD.data_classification='HEALTH' AND NEW.data_classification<>'HEALTH') OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'SALES_CASE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_history_guard BEFORE INSERT ON sales_case_history
WHEN NOT EXISTS(SELECT 1 FROM sales_cases s JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=s.active_task_id JOIN operation_receipts o ON o.id=NEW.receipt_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND s.version=NEW.case_version AND s.active_task_id=NEW.task_id AND o.agency_id=s.agency_id AND o.actor_user_id=NEW.actor_user_id AND o.actor_membership_id=NEW.actor_membership_id AND o.status='COMPLETED' AND o.action IN ('sales.case.create','sales.case.followup') AND json_extract(o.response_body,'$.result.caseId')=s.id AND json_extract(o.response_body,'$.result.caseVersion')=s.version)
BEGIN SELECT RAISE(ABORT,'SALES_HISTORY_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_history_no_update BEFORE UPDATE ON sales_case_history BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_history_no_delete BEFORE DELETE ON sales_case_history BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_tasks_no_update BEFORE UPDATE ON sales_case_tasks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_tasks_no_delete BEFORE DELETE ON sales_case_tasks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_customer_archive_guard BEFORE UPDATE OF archived_at ON customers
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND EXISTS(SELECT 1 FROM sales_cases s WHERE s.agency_id=OLD.agency_id AND s.customer_id=OLD.id AND s.result='OPEN')
BEGIN SELECT RAISE(ABORT,'OPEN_DEPENDENCIES'); END;
--> statement-breakpoint
CREATE TRIGGER sales_linked_task_completion_guard BEFORE UPDATE OF status ON tasks
WHEN NEW.status<>OLD.status AND EXISTS(SELECT 1 FROM sales_cases s WHERE s.agency_id=OLD.agency_id AND s.active_task_id=OLD.id AND s.result='OPEN')
BEGIN SELECT RAISE(ABORT,'SALES_CASE_OUTCOME_REQUIRED'); END;
