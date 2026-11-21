CREATE TABLE `sales_case_result_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`case_id` text NOT NULL,
	`result_no` integer NOT NULL,
	`kind` text NOT NULL,
	`case_version` integer NOT NULL,
	`task_id` text NOT NULL,
	`task_version` integer NOT NULL,
	`loss_reason_id` text NOT NULL,
	`notes` text,
	`followup_case_id` text,
	`exception_code` text,
	`receipt_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`case_id`) REFERENCES `sales_cases`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`task_id`) REFERENCES `tasks`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`loss_reason_id`) REFERENCES `loss_reasons`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`followup_case_id`) REFERENCES `sales_cases`(`id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY (`receipt_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_case_results_kind" CHECK("sales_case_result_revisions"."kind" IN ('LOST','WON','VOIDED','REOPENED','WON_CORRECTED')),
	CONSTRAINT "sales_case_results_versions" CHECK("sales_case_result_revisions"."result_no">=1 AND "sales_case_result_revisions"."case_version">=2 AND "sales_case_result_revisions"."task_version">=2),
	CONSTRAINT "sales_case_results_notes" CHECK("sales_case_result_revisions"."notes" IS NULL OR length("sales_case_result_revisions"."notes") BETWEEN 1 AND 500),
	CONSTRAINT "sales_case_results_followup" CHECK(("sales_case_result_revisions"."followup_case_id" IS NOT NULL AND "sales_case_result_revisions"."exception_code" IS NULL) OR ("sales_case_result_revisions"."followup_case_id" IS NULL AND "sales_case_result_revisions"."exception_code" IS NOT NULL AND "sales_case_result_revisions"."exception_code" IN ('NO_FURTHER_CONTACT','DUPLICATE','TECHNICAL_ERROR') AND "sales_case_result_revisions"."notes" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_results_agency_id_uq` ON `sales_case_result_revisions` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_results_number_uq` ON `sales_case_result_revisions` (`agency_id`,`case_id`,`result_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_results_receipt_uq` ON `sales_case_result_revisions` (`receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_results_followup_uq` ON `sales_case_result_revisions` (`agency_id`,`followup_case_id`);--> statement-breakpoint
DROP INDEX `sales_case_history_receipt_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `sales_case_history_receipt_uq` ON `sales_case_history` (`receipt_id`,`case_id`);--> statement-breakpoint
ALTER TABLE `sales_cases` ADD `current_result_id` text REFERENCES sales_case_result_revisions(id) DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE `sales_cases` ADD `predecessor_case_id` text REFERENCES sales_cases(id) DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE `sales_cases` ADD `origin_result_revision_id` text REFERENCES sales_case_result_revisions(id) DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX `sales_cases_origin_uq` ON `sales_cases` (`agency_id`,`predecessor_case_id`,`origin_result_revision_id`);
--> statement-breakpoint
DROP TRIGGER sales_case_insert_guard;
--> statement-breakpoint
CREATE TRIGGER sales_case_insert_guard BEFORE INSERT ON sales_cases
WHEN NEW.version<>1 OR NOT EXISTS(
 SELECT 1 FROM customers c JOIN insurance_branches b ON b.agency_id=c.agency_id
 JOIN agency_memberships m ON m.agency_id=c.agency_id AND m.id=NEW.created_by_membership_id
 WHERE c.agency_id=NEW.agency_id AND c.id=NEW.customer_id AND c.archived_at IS NULL AND b.id=NEW.branch_id
 AND (NEW.data_classification=b.data_classification OR (NEW.data_classification='HEALTH' AND EXISTS(SELECT 1 FROM sales_cases old WHERE old.agency_id=NEW.agency_id AND old.id=NEW.predecessor_case_id AND old.data_classification='HEALTH'))) AND m.user_id=NEW.created_by_user_id AND m.status='ACTIVE'
 AND ((NEW.context_kind='NEW_BUSINESS' AND NEW.result='OPEN' AND NEW.source_policy_id IS NULL AND b.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM tasks t WHERE t.agency_id=c.agency_id AND t.customer_id=c.id AND t.id=NEW.active_task_id AND t.kind='GENERAL' AND t.status='OPEN' AND t.policy_id IS NULL AND t.renewal_id IS NULL AND t.assignee_membership_id=m.id))
 OR (NEW.context_kind='RENEWAL' AND NEW.result IS NULL AND NEW.active_task_id IS NULL AND NEW.date_basis='KNOWN_END_DATE'
 AND EXISTS(SELECT 1 FROM renewal_opportunities r JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
 JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id
 WHERE r.agency_id=c.agency_id AND r.id=NEW.renewal_id AND p.id=NEW.source_policy_id AND p.customer_id=c.id AND p.branch_id=b.id AND p.end_date=NEW.cycle_date
 AND p.status='ACTIVE' AND p.archived_at IS NULL AND r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED')
 AND t.customer_id=c.id AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN' AND t.assignee_membership_id IS r.assignee_membership_id))))
 OR (NEW.cycle_date IS NOT NULL AND (length(NEW.cycle_date)<>10 OR date(NEW.cycle_date) IS NULL OR date(NEW.cycle_date)<>NEW.cycle_date))
BEGIN SELECT RAISE(ABORT,'SALES_CASE_INVALID'); END;

--> statement-breakpoint
CREATE TRIGGER sales_case_origin_insert_guard BEFORE INSERT ON sales_cases
WHEN NEW.current_result_id IS NOT NULL OR ((NEW.predecessor_case_id IS NULL)<>(NEW.origin_result_revision_id IS NULL))
 OR (NEW.predecessor_case_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM sales_cases old JOIN sales_case_result_revisions r ON r.agency_id=old.agency_id AND r.case_id=old.id AND r.id=old.current_result_id
 JOIN operation_receipts o ON o.id=r.receipt_id
 WHERE old.agency_id=NEW.agency_id AND old.id=NEW.predecessor_case_id AND r.id=NEW.origin_result_revision_id AND r.kind='LOST' AND old.result='LOST'
 AND old.context_kind='NEW_BUSINESS' AND NEW.context_kind='NEW_BUSINESS' AND NEW.result='OPEN' AND r.followup_case_id=NEW.id
 AND old.customer_id=NEW.customer_id AND old.branch_id=NEW.branch_id AND NEW.data_classification=CASE WHEN old.data_classification='HEALTH' OR (SELECT data_classification FROM insurance_branches WHERE agency_id=NEW.agency_id AND id=NEW.branch_id)='HEALTH' THEN 'HEALTH' ELSE 'GENERAL' END
 AND NEW.cycle_date IS json_extract(o.response_body,'$.command.nextCycle.cycleDate') AND NEW.date_basis=json_extract(o.response_body,'$.command.nextCycle.dateBasis')
 AND NEW.created_by_user_id=r.actor_user_id AND NEW.created_by_membership_id=r.actor_membership_id AND NEW.created_at=r.created_at
 AND NEW.active_task_id=json_extract(o.response_body,'$.result.followup.taskId')
 AND EXISTS(SELECT 1 FROM tasks t WHERE t.agency_id=NEW.agency_id AND t.id=NEW.active_task_id AND t.due_at=json_extract(o.response_body,'$.command.nextCycle.dueAt') AND t.created_at=r.created_at)))
BEGIN SELECT RAISE(ABORT,'SALES_CYCLE_ORIGIN_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_case_result_pointer_guard BEFORE UPDATE ON sales_cases
WHEN NEW.predecessor_case_id IS NOT OLD.predecessor_case_id OR NEW.origin_result_revision_id IS NOT OLD.origin_result_revision_id
 OR (NEW.current_result_id IS NOT OLD.current_result_id AND NOT EXISTS(
 SELECT 1 FROM sales_case_result_revisions r WHERE r.agency_id=NEW.agency_id AND r.case_id=NEW.id AND r.id=NEW.current_result_id
 AND r.kind='LOST' AND OLD.context_kind='NEW_BUSINESS' AND OLD.result='OPEN' AND OLD.current_result_id IS NULL AND NEW.result='LOST' AND NEW.active_task_id IS NULL AND r.case_version=NEW.version AND r.task_id=OLD.active_task_id))
 OR (NEW.result IS NOT OLD.result AND (NEW.current_result_id IS NULL OR NEW.result<>'LOST'))
BEGIN SELECT RAISE(ABORT,'SALES_RESULT_POINTER_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_result_insert_guard BEFORE INSERT ON sales_case_result_revisions
WHEN NEW.kind<>'LOST' OR NEW.result_no<>1 OR NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN tasks t ON t.agency_id=s.agency_id AND t.id=s.active_task_id
 JOIN loss_reasons l ON l.agency_id=s.agency_id AND l.id=NEW.loss_reason_id AND l.status='ACTIVE'
 JOIN operation_receipts o ON o.id=NEW.receipt_id JOIN agency_memberships m ON m.agency_id=s.agency_id AND m.id=NEW.actor_membership_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND s.context_kind='NEW_BUSINESS' AND s.result='OPEN' AND s.current_result_id IS NULL
 AND NEW.case_version=s.version+1 AND NEW.task_id=t.id AND NEW.task_version=t.version+1 AND t.status='OPEN' AND t.kind='GENERAL' AND t.policy_id IS NULL AND t.renewal_id IS NULL AND t.customer_id=s.customer_id
 AND m.user_id=NEW.actor_user_id AND m.status='ACTIVE' AND o.agency_id=s.agency_id AND o.action='sales.case.close_lost' AND o.status='COMPLETED' AND o.response_status=200
 AND o.actor_user_id=NEW.actor_user_id AND o.actor_membership_id=NEW.actor_membership_id AND o.created_at=NEW.created_at
 AND json_extract(o.response_body,'$.targetId')=s.id AND json_extract(o.response_body,'$.command.expectedCaseVersion')=s.version
 AND json_extract(o.response_body,'$.command.expectedTaskId')=t.id AND json_extract(o.response_body,'$.command.expectedTaskVersion')=t.version
 AND json_extract(o.response_body,'$.command.lossReasonId')=l.id AND json_extract(o.response_body,'$.command.notes') IS NEW.notes
 AND json_extract(o.response_body,'$.result.operationId')=o.id AND json_extract(o.response_body,'$.result.caseId')=s.id AND json_extract(o.response_body,'$.result.caseVersion')=NEW.case_version
 AND json_extract(o.response_body,'$.result.resultRevisionId')=NEW.id AND json_extract(o.response_body,'$.result.taskId')=t.id AND json_extract(o.response_body,'$.result.taskVersion')=NEW.task_version
 AND json_extract(o.response_body,'$.result.closedAt')=NEW.created_at
 AND ((NEW.followup_case_id IS NOT NULL AND NEW.exception_code IS NULL AND json_extract(o.response_body,'$.command.nextCycle.mode')='FOLLOW_UP'
 AND json_extract(o.response_body,'$.result.followup.caseId')=NEW.followup_case_id AND json_extract(o.response_body,'$.result.followup.caseVersion')=1 AND json_extract(o.response_body,'$.result.followup.taskVersion')=1
 AND json_extract(o.response_body,'$.command.nextCycle.dueAt')=json_extract(o.response_body,'$.result.followup.dueAt') AND json_extract(o.response_body,'$.command.nextCycle.dueAt')>NEW.created_at)
 OR (NEW.followup_case_id IS NULL AND NEW.notes IS NOT NULL AND json_extract(o.response_body,'$.command.nextCycle.mode')='NO_FOLLOW_UP'
 AND NEW.exception_code=json_extract(o.response_body,'$.command.nextCycle.exceptionCode') AND json_extract(o.response_body,'$.result.followup') IS NULL)))
BEGIN SELECT RAISE(ABORT,'SALES_RESULT_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_results_no_update BEFORE UPDATE ON sales_case_result_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_results_no_delete BEFORE DELETE ON sales_case_result_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;

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
 AND NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN sales_price_events e ON e.agency_id=s.agency_id AND e.case_id=s.id AND e.case_version=s.version
 JOIN operation_receipts o ON o.id=e.receipt_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND s.version=NEW.case_version AND e.receipt_id=NEW.receipt_id
 AND NEW.task_id=e.task_id AND NEW.reason_code IS NULL AND NEW.notes IS NULL
 AND NEW.event_code=CASE e.event_code WHEN 'SHARED' THEN 'PRICE_SHARED' WHEN 'CUSTOMER_ACCEPTED' THEN 'PRICE_ACCEPTED' ELSE 'PRICE_ACCEPTANCE_REVOKED' END
 AND o.status='COMPLETED' AND o.action='sales.price.event' AND o.response_status=201 AND o.agency_id=s.agency_id
 AND o.actor_user_id=NEW.actor_user_id AND o.actor_membership_id=NEW.actor_membership_id AND e.actor_user_id=NEW.actor_user_id AND e.actor_membership_id=NEW.actor_membership_id
 AND e.created_at=NEW.created_at AND json_extract(o.response_body,'$.targetId')=s.id
 AND json_extract(o.response_body,'$.result.operationId')=o.id AND json_extract(o.response_body,'$.result.caseId')=s.id
 AND json_extract(o.response_body,'$.result.caseVersion')=s.version AND json_extract(o.response_body,'$.result.eventId')=e.id
 AND json_extract(o.response_body,'$.result.revisionId')=e.revision_id AND json_extract(o.response_body,'$.result.event')=e.event_code
 AND json_extract(o.response_body,'$.result.occurredAt')=e.occurred_at)
 AND NOT EXISTS(
 SELECT 1 FROM sales_case_result_revisions r JOIN operation_receipts o ON o.id=r.receipt_id JOIN sales_cases s ON s.agency_id=r.agency_id AND s.id=r.case_id
 WHERE r.agency_id=NEW.agency_id AND r.receipt_id=NEW.receipt_id AND o.action='sales.case.close_lost' AND o.status='COMPLETED' AND o.response_status=200
 AND r.actor_user_id=NEW.actor_user_id AND r.actor_membership_id=NEW.actor_membership_id AND r.created_at=NEW.created_at
 AND ((NEW.case_id=r.case_id AND NEW.case_version=r.case_version AND NEW.event_code='LOST' AND NEW.task_id=r.task_id AND NEW.reason_code=(SELECT code FROM loss_reasons WHERE agency_id=r.agency_id AND id=r.loss_reason_id) AND NEW.notes IS r.notes AND s.current_result_id=r.id AND s.result='LOST')
 OR (NEW.case_id=r.followup_case_id AND NEW.case_version=1 AND NEW.event_code='CREATED_NEXT_CYCLE' AND NEW.notes IS NULL AND NEW.reason_code IS NULL
 AND EXISTS(SELECT 1 FROM sales_cases child JOIN sales_case_tasks link ON link.agency_id=child.agency_id AND link.case_id=child.id AND link.task_id=child.active_task_id AND link.purpose='NEXT_CYCLE'
 WHERE child.agency_id=r.agency_id AND child.id=r.followup_case_id AND child.origin_result_revision_id=r.id AND child.predecessor_case_id=r.case_id AND NEW.task_id=child.active_task_id))))
BEGIN SELECT RAISE(ABORT,'SALES_HISTORY_INVALID'); END;
