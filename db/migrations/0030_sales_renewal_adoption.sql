-- Expand admission only. Existing Task/renewal lifecycle and immutable historical links remain authoritative.
DROP TRIGGER sales_case_tasks_guard;
--> statement-breakpoint
CREATE TRIGGER sales_case_tasks_guard BEFORE INSERT ON sales_case_tasks
WHEN NOT EXISTS(
 SELECT 1 FROM sales_cases s JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id
 WHERE s.agency_id=NEW.agency_id AND s.id=NEW.case_id AND t.id=NEW.task_id AND t.status='OPEN'
 AND ((s.context_kind='NEW_BUSINESS' AND t.kind='GENERAL' AND t.renewal_id IS NULL AND t.policy_id IS NULL)
 OR (s.context_kind='RENEWAL' AND NEW.purpose='ACTIVE_CONTACT' AND t.kind='RENEWAL_FOLLOWUP' AND t.renewal_id=s.renewal_id AND t.policy_id IS NULL
 AND EXISTS(SELECT 1 FROM renewal_opportunities r WHERE r.agency_id=s.agency_id AND r.id=s.renewal_id AND r.expiring_policy_id=s.source_policy_id AND r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED') AND r.assignee_membership_id IS t.assignee_membership_id))))
BEGIN SELECT RAISE(ABORT,'SALES_TASK_LINK_INVALID'); END;
--> statement-breakpoint
DROP TRIGGER sales_case_insert_guard;
--> statement-breakpoint
CREATE TRIGGER sales_case_insert_guard BEFORE INSERT ON sales_cases
WHEN NEW.version<>1 OR NOT EXISTS(
 SELECT 1 FROM customers c JOIN insurance_branches b ON b.agency_id=c.agency_id
 JOIN agency_memberships m ON m.agency_id=c.agency_id AND m.id=NEW.created_by_membership_id
 WHERE c.agency_id=NEW.agency_id AND c.id=NEW.customer_id AND c.archived_at IS NULL AND b.id=NEW.branch_id
 AND NEW.data_classification=b.data_classification AND m.user_id=NEW.created_by_user_id AND m.status='ACTIVE'
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
BEGIN SELECT RAISE(ABORT,'SALES_HISTORY_INVALID'); END;
--> statement-breakpoint
-- A frozen HEALTH renewal must not become readable through legacy branch-only resolvers.
CREATE TRIGGER sales_renewal_health_branch_guard BEFORE UPDATE OF data_classification ON insurance_branches
WHEN OLD.data_classification='HEALTH' AND NEW.data_classification<>'HEALTH'
 AND EXISTS(SELECT 1 FROM sales_cases s WHERE s.agency_id=OLD.agency_id AND s.branch_id=OLD.id AND s.context_kind='RENEWAL' AND s.data_classification='HEALTH')
BEGIN SELECT RAISE(ABORT,'SALES_RENEWAL_HEALTH_DOWNGRADE_FORBIDDEN'); END;
--> statement-breakpoint
CREATE TRIGGER sales_renewal_source_identity_guard BEFORE UPDATE OF customer_id,branch_id ON policies
WHEN (NEW.customer_id<>OLD.customer_id OR NEW.branch_id<>OLD.branch_id)
 AND EXISTS(SELECT 1 FROM sales_cases s WHERE s.agency_id=OLD.agency_id AND s.source_policy_id=OLD.id AND s.context_kind='RENEWAL')
BEGIN SELECT RAISE(ABORT,'SALES_RENEWAL_SOURCE_IMMUTABLE'); END;
