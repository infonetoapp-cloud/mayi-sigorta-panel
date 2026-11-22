DROP TRIGGER sales_case_origin_insert_guard;
--> statement-breakpoint
CREATE TRIGGER sales_case_origin_insert_guard BEFORE INSERT ON sales_cases
WHEN NEW.current_result_id IS NOT NULL OR ((NEW.predecessor_case_id IS NULL)<>(NEW.origin_result_revision_id IS NULL))
 OR (NEW.predecessor_case_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM sales_cases old JOIN sales_case_result_revisions r ON r.agency_id=old.agency_id AND r.case_id=old.id AND r.id=old.current_result_id
 JOIN operation_receipts o ON o.id=r.receipt_id
 WHERE old.agency_id=NEW.agency_id AND old.id=NEW.predecessor_case_id AND r.id=NEW.origin_result_revision_id AND r.kind='LOST' AND ((old.context_kind='NEW_BUSINESS' AND old.result='LOST') OR (old.context_kind='RENEWAL' AND old.result IS NULL AND EXISTS(SELECT 1 FROM renewal_opportunities rr WHERE rr.agency_id=old.agency_id AND rr.id=old.renewal_id AND rr.state='LOST')))
 AND NEW.context_kind='NEW_BUSINESS' AND NEW.result='OPEN' AND r.followup_case_id=NEW.id
 AND old.customer_id=NEW.customer_id AND old.branch_id=NEW.branch_id AND NEW.data_classification=CASE WHEN old.data_classification='HEALTH' OR (SELECT data_classification FROM insurance_branches WHERE agency_id=NEW.agency_id AND id=NEW.branch_id)='HEALTH' THEN 'HEALTH' ELSE 'GENERAL' END
 AND NEW.cycle_date IS json_extract(o.response_body,CASE WHEN o.action='renewal.close_lost' THEN '$.cycleCommand.salesCycle.nextCycle.cycleDate' ELSE '$.command.nextCycle.cycleDate' END) AND NEW.date_basis=json_extract(o.response_body,CASE WHEN o.action='renewal.close_lost' THEN '$.cycleCommand.salesCycle.nextCycle.dateBasis' ELSE '$.command.nextCycle.dateBasis' END)
 AND NEW.created_by_user_id=r.actor_user_id AND NEW.created_by_membership_id=r.actor_membership_id AND NEW.created_at=r.created_at
 AND NEW.active_task_id=json_extract(o.response_body,CASE WHEN o.action='renewal.close_lost' THEN '$.salesCycle.followup.taskId' ELSE '$.result.followup.taskId' END)
 AND EXISTS(SELECT 1 FROM tasks t WHERE t.agency_id=NEW.agency_id AND t.id=NEW.active_task_id AND t.due_at=json_extract(o.response_body,CASE WHEN o.action='renewal.close_lost' THEN '$.cycleCommand.salesCycle.nextCycle.dueAt' ELSE '$.command.nextCycle.dueAt' END) AND t.created_at=r.created_at)))
BEGIN SELECT RAISE(ABORT,'SALES_CYCLE_ORIGIN_INVALID'); END;
--> statement-breakpoint
DROP TRIGGER sales_case_result_pointer_guard;
--> statement-breakpoint
CREATE TRIGGER sales_case_result_pointer_guard BEFORE UPDATE ON sales_cases
WHEN NEW.predecessor_case_id IS NOT OLD.predecessor_case_id OR NEW.origin_result_revision_id IS NOT OLD.origin_result_revision_id
 OR (NEW.current_result_id IS NOT OLD.current_result_id AND NOT EXISTS(
 SELECT 1 FROM sales_case_result_revisions r WHERE r.agency_id=NEW.agency_id AND r.case_id=NEW.id AND r.id=NEW.current_result_id
 AND r.kind='LOST' AND OLD.current_result_id IS NULL AND NEW.active_task_id IS NULL AND r.case_version=NEW.version
 AND ((OLD.context_kind='NEW_BUSINESS' AND OLD.result='OPEN' AND NEW.result='LOST' AND r.task_id=OLD.active_task_id)
 OR (OLD.context_kind='RENEWAL' AND OLD.result IS NULL AND NEW.result IS NULL AND EXISTS(SELECT 1 FROM renewal_opportunities rr JOIN tasks t ON t.agency_id=rr.agency_id AND t.renewal_id=rr.id AND t.id=r.task_id WHERE rr.agency_id=OLD.agency_id AND rr.id=OLD.renewal_id AND rr.state='LOST' AND rr.closed_at=r.created_at AND t.status='COMPLETED' AND t.version=r.task_version)))))
 OR (NEW.result IS NOT OLD.result AND (NEW.current_result_id IS NULL OR NEW.result<>'LOST'))
BEGIN SELECT RAISE(ABORT,'SALES_RESULT_POINTER_INVALID'); END;
--> statement-breakpoint
DROP TRIGGER sales_result_insert_guard;
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

 AND NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN renewal_opportunities rr ON rr.agency_id=s.agency_id AND rr.id=s.renewal_id
 JOIN policies p ON p.agency_id=s.agency_id AND p.id=s.source_policy_id AND p.id=rr.expiring_policy_id AND p.customer_id=s.customer_id AND p.branch_id=s.branch_id
 JOIN tasks t ON t.agency_id=s.agency_id AND t.renewal_id=rr.id AND t.customer_id=s.customer_id AND t.kind='RENEWAL_FOLLOWUP'
 JOIN loss_reasons l ON l.agency_id=s.agency_id AND l.id=NEW.loss_reason_id AND l.status='ACTIVE'
 JOIN operation_receipts o ON o.id=NEW.receipt_id JOIN agency_memberships m ON m.agency_id=s.agency_id AND m.id=NEW.actor_membership_id
 WHERE ((((((s.agency_id=NEW.agency_id) AND (s.id=NEW.case_id)) AND ((s.context_kind='RENEWAL') AND ((s.result IS NULL) AND (s.current_result_id IS NULL)))) AND (((rr.state NOT IN ('WON','LOST','VOIDED')) AND (rr.closed_at IS NULL)) AND ((t.status='OPEN') AND ((t.assignee_membership_id IS rr.assignee_membership_id) AND (NEW.case_version=s.version+1))))) AND ((((NEW.task_id=t.id) AND (NEW.task_version=t.version+1)) AND ((m.user_id=NEW.actor_user_id) AND ((m.status='ACTIVE') AND (o.agency_id=s.agency_id)))) AND (((o.action='renewal.close_lost') AND ((o.status='COMPLETED') AND (o.response_status=200))) AND ((o.actor_user_id=NEW.actor_user_id) AND ((o.actor_membership_id=NEW.actor_membership_id) AND (o.created_at=NEW.created_at)))))) AND (((((json_extract(o.response_body,'$.renewalId')=rr.id) AND (json_extract(o.response_body,'$.cycleCommand.expectedRenewalVersion')=rr.version)) AND ((json_extract(o.response_body,'$.renewalVersion')=rr.version+1) AND ((json_extract(o.response_body,'$.state')='LOST') AND (json_extract(o.response_body,'$.primaryTaskId')=t.id)))) AND (((json_extract(o.response_body,'$.taskVersion')=NEW.task_version) AND ((json_extract(o.response_body,'$.lossReasonId')=l.id) AND (json_extract(o.response_body,'$.cycleCommand.lossReasonId')=l.id))) AND ((json_extract(o.response_body,'$.cycleCommand.expectedPrimaryTaskId')=t.id) AND ((json_extract(o.response_body,'$.cycleCommand.expectedTaskVersion')=t.version) AND (json_extract(o.response_body,'$.cycleCommand.salesCycle.caseId')=s.id))))) AND ((((json_extract(o.response_body,'$.cycleCommand.salesCycle.expectedCaseVersion')=s.version) AND (json_extract(o.response_body,'$.cycleCommand.salesCycle.notes') IS NEW.notes)) AND ((json_extract(o.response_body,'$.salesCycle.operationId')=o.id) AND ((json_extract(o.response_body,'$.salesCycle.resultRevisionId')=NEW.id) AND (json_extract(o.response_body,'$.salesCycle.caseId')=s.id)))) AND (((json_extract(o.response_body,'$.salesCycle.caseVersion')=NEW.case_version) AND ((json_extract(o.response_body,'$.salesCycle.taskId')=t.id) AND (json_extract(o.response_body,'$.salesCycle.taskVersion')=NEW.task_version))) AND ((json_extract(o.response_body,'$.salesCycle.closedAt')=NEW.created_at) AND ((json_extract(o.response_body,'$.closedAt')=NEW.created_at) AND (((NEW.followup_case_id IS NOT NULL AND NEW.exception_code IS NULL AND json_extract(o.response_body,'$.cycleCommand.salesCycle.nextCycle.mode')='FOLLOW_UP'
 AND NOT EXISTS(SELECT 1 FROM sales_cases oldchild WHERE oldchild.id=NEW.followup_case_id)
 AND json_extract(o.response_body,'$.salesCycle.followup.caseId')=NEW.followup_case_id AND json_extract(o.response_body,'$.salesCycle.followup.caseVersion')=1 AND json_extract(o.response_body,'$.salesCycle.followup.taskVersion')=1
 AND json_extract(o.response_body,'$.cycleCommand.salesCycle.nextCycle.dueAt')=json_extract(o.response_body,'$.salesCycle.followup.dueAt') AND json_extract(o.response_body,'$.salesCycle.followup.dueAt')>NEW.created_at
 AND json_extract(o.response_body,'$.cycleCommand.salesCycle.nextCycle.cycleDate') IS json_extract(o.response_body,'$.salesCycle.followup.cycleDate') AND json_extract(o.response_body,'$.cycleCommand.salesCycle.nextCycle.dateBasis')=json_extract(o.response_body,'$.salesCycle.followup.dateBasis'))
 OR (NEW.followup_case_id IS NULL AND NEW.notes IS NOT NULL AND json_extract(o.response_body,'$.cycleCommand.salesCycle.nextCycle.mode')='NO_FOLLOW_UP'
 AND NEW.exception_code=json_extract(o.response_body,'$.cycleCommand.salesCycle.nextCycle.exceptionCode') AND json_extract(o.response_body,'$.salesCycle.followup') IS NULL))))))))))
BEGIN SELECT RAISE(ABORT,'SALES_RESULT_INVALID'); END;
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
 WHERE r.agency_id=NEW.agency_id AND r.receipt_id=NEW.receipt_id AND o.action IN ('sales.case.close_lost','renewal.close_lost') AND o.status='COMPLETED' AND o.response_status=200
 AND r.actor_user_id=NEW.actor_user_id AND r.actor_membership_id=NEW.actor_membership_id AND r.created_at=NEW.created_at
 AND ((NEW.case_id=r.case_id AND NEW.case_version=r.case_version AND NEW.event_code='LOST' AND NEW.task_id=r.task_id AND NEW.reason_code=(SELECT code FROM loss_reasons WHERE agency_id=r.agency_id AND id=r.loss_reason_id) AND NEW.notes IS r.notes AND s.current_result_id=r.id AND ((s.context_kind='NEW_BUSINESS' AND s.result='LOST') OR (s.context_kind='RENEWAL' AND s.result IS NULL AND EXISTS(SELECT 1 FROM renewal_opportunities rr WHERE rr.agency_id=s.agency_id AND rr.id=s.renewal_id AND rr.state='LOST'))))
 OR (NEW.case_id=r.followup_case_id AND NEW.case_version=1 AND NEW.event_code='CREATED_NEXT_CYCLE' AND NEW.notes IS NULL AND NEW.reason_code IS NULL
 AND EXISTS(SELECT 1 FROM sales_cases child JOIN sales_case_tasks link ON link.agency_id=child.agency_id AND link.case_id=child.id AND link.task_id=child.active_task_id AND link.purpose='NEXT_CYCLE'
 WHERE child.agency_id=r.agency_id AND child.id=r.followup_case_id AND child.origin_result_revision_id=r.id AND child.predecessor_case_id=r.case_id AND NEW.task_id=child.active_task_id))))
BEGIN SELECT RAISE(ABORT,'SALES_HISTORY_INVALID'); END;
--> statement-breakpoint
-- Reopening a linked cycle must recall its successor in the same command.
-- Until that command is implemented, fail closed instead of leaving two open jobs.
CREATE TRIGGER renewal_sales_cycle_reopen_guard BEFORE UPDATE ON renewal_opportunities
WHEN OLD.state='LOST' AND NEW.state NOT IN ('LOST','WON','VOIDED') AND EXISTS(
 SELECT 1 FROM sales_cases s WHERE s.agency_id=OLD.agency_id AND s.renewal_id=OLD.id AND s.current_result_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'SALES_CYCLE_REOPEN_REQUIRED'); END;
