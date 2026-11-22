CREATE TABLE `sales_price_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`case_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`case_version` integer NOT NULL,
	`event_code` text NOT NULL,
	`occurred_at` text NOT NULL,
	`task_id` text NOT NULL,
	`task_version` integer NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`case_id`) REFERENCES `sales_cases`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`revision_id`) REFERENCES `sales_price_revisions`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`task_id`) REFERENCES `tasks`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_price_events_code" CHECK("sales_price_events"."event_code" IN ('SHARED','CUSTOMER_ACCEPTED','ACCEPTANCE_REVOKED')),
	CONSTRAINT "sales_price_events_versions" CHECK("sales_price_events"."case_version">=2 AND "sales_price_events"."task_version">=1),
	CONSTRAINT "sales_price_events_occurrence" CHECK(length("sales_price_events"."occurred_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"sales_price_events"."occurred_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"sales_price_events"."occurred_at")="sales_price_events"."occurred_at" AND "sales_price_events"."occurred_at"<="sales_price_events"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_price_events_agency_id_uq` ON `sales_price_events` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_price_events_case_version_uq` ON `sales_price_events` (`agency_id`,`case_id`,`case_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_price_events_receipt_uq` ON `sales_price_events` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `sales_price_events_revision_page` ON `sales_price_events` (`agency_id`,`revision_id`,`case_version`,`id`);--> statement-breakpoint
CREATE TRIGGER sales_price_events_insert_guard BEFORE INSERT ON sales_price_events
WHEN NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN sales_prices p ON p.agency_id=s.agency_id AND p.case_id=s.id
 JOIN sales_price_revisions v ON v.agency_id=p.agency_id AND v.price_id=p.id AND v.id=p.current_revision_id
 JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id
 JOIN agency_memberships m ON m.agency_id=s.agency_id AND m.id=NEW.actor_membership_id
 JOIN operation_receipts o ON o.id=NEW.receipt_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND s.version=NEW.case_version AND v.id=NEW.revision_id
 AND m.user_id=NEW.actor_user_id AND m.status='ACTIVE' AND c.archived_at IS NULL
 AND t.id=NEW.task_id AND t.version=NEW.task_version AND t.status='OPEN'
 AND ((s.context_kind='NEW_BUSINESS' AND s.result='OPEN' AND s.active_task_id=t.id AND t.kind='GENERAL' AND t.renewal_id IS NULL AND t.policy_id IS NULL)
 OR (s.context_kind='RENEWAL' AND t.kind='RENEWAL_FOLLOWUP' AND t.renewal_id=s.renewal_id AND t.policy_id IS NULL AND EXISTS(
 SELECT 1 FROM renewal_opportunities r JOIN policies old ON old.agency_id=r.agency_id AND old.id=r.expiring_policy_id
 WHERE r.agency_id=s.agency_id AND r.id=s.renewal_id AND r.state NOT IN ('WON','LOST','VOIDED') AND r.closed_at IS NULL
 AND r.assignee_membership_id IS t.assignee_membership_id AND old.status='ACTIVE' AND old.archived_at IS NULL)))
 AND o.agency_id=s.agency_id AND o.action='sales.price.event' AND o.status='COMPLETED' AND o.response_status=201
 AND o.actor_user_id=NEW.actor_user_id AND o.actor_membership_id=NEW.actor_membership_id AND o.created_at=NEW.created_at
 AND json_extract(o.response_body,'$.targetId')=s.id AND json_extract(o.response_body,'$.command.expectedCaseVersion')=s.version-1
 AND json_extract(o.response_body,'$.command.expectedTaskId')=t.id AND json_extract(o.response_body,'$.command.expectedTaskVersion')=t.version
 AND json_extract(o.response_body,'$.command.revisionId')=v.id AND json_extract(o.response_body,'$.command.event')=NEW.event_code
 AND json_extract(o.response_body,'$.command.occurredAt')=NEW.occurred_at
 AND json_extract(o.response_body,'$.result.eventId')=NEW.id AND json_extract(o.response_body,'$.result.caseVersion')=s.version
 AND json_extract(o.response_body,'$.result.caseId')=s.id AND json_extract(o.response_body,'$.result.operationId')=o.id
 AND json_extract(o.response_body,'$.result.revisionId')=v.id AND json_extract(o.response_body,'$.result.event')=NEW.event_code
 AND json_extract(o.response_body,'$.result.occurredAt')=NEW.occurred_at)
 OR (NEW.event_code='SHARED' AND EXISTS(SELECT 1 FROM sales_price_events e WHERE e.agency_id=NEW.agency_id AND e.revision_id=NEW.revision_id))
 OR (NEW.event_code='CUSTOMER_ACCEPTED' AND COALESCE((SELECT e.event_code FROM sales_price_events e WHERE e.agency_id=NEW.agency_id AND e.revision_id=NEW.revision_id ORDER BY e.case_version DESC LIMIT 1),'') NOT IN ('SHARED','ACCEPTANCE_REVOKED'))
 OR (NEW.event_code='ACCEPTANCE_REVOKED' AND COALESCE((SELECT e.event_code FROM sales_price_events e WHERE e.agency_id=NEW.agency_id AND e.revision_id=NEW.revision_id ORDER BY e.case_version DESC LIMIT 1),'')<>'CUSTOMER_ACCEPTED')
 OR EXISTS(SELECT 1 FROM sales_price_events e WHERE e.agency_id=NEW.agency_id AND e.revision_id=NEW.revision_id AND (e.case_version>=NEW.case_version OR e.occurred_at>NEW.occurred_at))
BEGIN SELECT RAISE(ABORT,'SALES_PRICE_EVENT_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER sales_price_events_no_update BEFORE UPDATE ON sales_price_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER sales_price_events_no_delete BEFORE DELETE ON sales_price_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
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
BEGIN SELECT RAISE(ABORT,'SALES_HISTORY_INVALID'); END;
