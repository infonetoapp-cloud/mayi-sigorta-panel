import { salesReopenReceiptSchema } from '../../src/shared/sales-reopen';
import { computePayloadHash } from '../../src/server/mutations/canonical';

type Row = Record<string, unknown>;
export async function verifySalesReopenRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const receipts = await query("SELECT * FROM operation_receipts WHERE action='sales.case.reopen'");
  const audits = await query(
    "SELECT * FROM audit_events WHERE action='sales.case.reopen' AND outcome='SUCCESS'",
  );
  const history = await query(
    "SELECT * FROM sales_case_history WHERE event_code IN ('CASE_LOSS_REOPENED','CASE_NEXT_CYCLE_RECALLED')",
  );
  const revisions = new Set<unknown>(),
    successors = new Set<unknown>();
  const reject = () => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  if (
    receipts.length !== audits.length ||
    receipts.length !== history.filter((h) => h.event_code === 'CASE_LOSS_REOPENED').length
  )
    reject();
  if (!receipts.length) {
    if (history.length) reject();
    return { revisions, successors };
  }
  const roots =
    await query(`SELECT h.receipt_id,h.agency_id,s.id case_id,s.customer_id,s.version live_case_version,s.result live_case_result,
    s.current_result_id,s.active_task_id,v.id revision_id,v.case_version revision_case_version,v.task_id previous_task_id,v.followup_case_id,v.receipt_id loss_receipt_id,
    old.version previous_task_version,t.id task_id,t.version task_version,t.due_at,t.created_at,t.created_by_user_id,t.created_by_membership_id,
    NOT EXISTS(SELECT 1 FROM sales_case_history r WHERE r.agency_id=h.agency_id AND r.case_id=h.case_id AND r.task_id=t.id AND r.event_code='RESCHEDULED') unchanged_due
    FROM sales_case_history h
    JOIN operation_receipts o ON o.id=h.receipt_id AND o.agency_id=h.agency_id AND o.action='sales.case.reopen'
    JOIN sales_cases s ON s.agency_id=h.agency_id AND s.id=h.case_id AND s.context_kind='NEW_BUSINESS'
    JOIN sales_case_result_revisions v ON v.agency_id=s.agency_id AND v.case_id=s.id AND v.kind='LOST'
      AND v.id=json_extract(o.response_body,'$.result.resultRevisionId')
    JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=h.task_id AND l.purpose='ACTIVE_CONTACT'
    JOIN tasks t ON t.agency_id=l.agency_id AND t.id=l.task_id AND t.customer_id=s.customer_id
      AND t.kind='GENERAL' AND t.policy_id IS NULL AND t.renewal_id IS NULL
    JOIN sales_case_tasks prev ON prev.agency_id=s.agency_id AND prev.case_id=s.id AND prev.task_id=v.task_id
    JOIN tasks old ON old.agency_id=prev.agency_id AND old.id=prev.task_id AND old.status='COMPLETED'
    WHERE h.event_code='CASE_LOSS_REOPENED'`);
  const children = await query(`SELECT h.receipt_id,h.agency_id,s.id case_id,s.version case_version,
    s.predecessor_case_id,s.origin_result_revision_id,s.updated_at,t.id task_id,t.version task_version,t.completed_at,t.completed_by_membership_id,
    first.receipt_id origin_receipt_id
    FROM sales_case_history h
    JOIN sales_cases s ON s.agency_id=h.agency_id AND s.id=h.case_id AND s.context_kind='NEW_BUSINESS'
      AND s.result='VOIDED' AND s.version=2 AND s.current_result_id IS NULL AND s.active_task_id IS NULL
    JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=h.task_id AND l.purpose='NEXT_CYCLE'
    JOIN tasks t ON t.agency_id=l.agency_id AND t.id=l.task_id AND t.status='COMPLETED' AND t.version=2
    JOIN sales_case_history first ON first.agency_id=s.agency_id AND first.case_id=s.id
      AND first.case_version=1 AND first.task_id=t.id AND first.event_code='CREATED_NEXT_CYCLE'
    WHERE h.event_code='CASE_NEXT_CYCLE_RECALLED'
      AND NOT EXISTS(SELECT 1 FROM sales_prices p WHERE p.agency_id=s.agency_id AND p.case_id=s.id)`);
  const rootsByReceipt = new Map(roots.map((r) => [r.receipt_id, r]));
  const childrenByReceipt = new Map(children.map((r) => [r.receipt_id, r]));
  const auditByReceipt = new Map(audits.map((r) => [r.correlation_id, r]));
  const rootHistory = new Map(
    history.filter((h) => h.event_code === 'CASE_LOSS_REOPENED').map((h) => [h.receipt_id, h]),
  );
  const childHistory = new Map(
    history
      .filter((h) => h.event_code === 'CASE_NEXT_CYCLE_RECALLED')
      .map((h) => [h.receipt_id, h]),
  );
  if (
    roots.length !== receipts.length ||
    rootsByReceipt.size !== roots.length ||
    auditByReceipt.size !== audits.length ||
    childrenByReceipt.size !== children.length ||
    childHistory.size !== history.length - receipts.length ||
    children.length !== childHistory.size
  )
    reject();
  for (const o of receipts) {
    const { command, result } = salesReopenReceiptSchema.parse(JSON.parse(String(o.response_body)));
    const h = rootHistory.get(o.id),
      a = auditByReceipt.get(o.id),
      row = rootsByReceipt.get(o.id);
    if (
      !h ||
      !a ||
      !row ||
      o.status !== 'COMPLETED' ||
      o.response_status !== 200 ||
      [a.agency_id, h.agency_id, row.agency_id].some((agency) => agency !== o.agency_id) ||
      result.operationId !== o.id ||
      result.caseId !== row.case_id ||
      result.caseId !== h.case_id ||
      result.caseVersion !== h.case_version ||
      result.caseVersion !== command.expectedCaseVersion + 1 ||
      row.revision_case_version !== command.expectedCaseVersion ||
      result.resultRevisionId !== command.expectedResultRevisionId ||
      result.resultRevisionId !== row.revision_id ||
      row.current_result_id === result.resultRevisionId ||
      revisions.has(result.resultRevisionId) ||
      result.previousTaskId !== command.expectedTaskId ||
      result.previousTaskId !== row.previous_task_id ||
      result.previousTaskVersion !== command.expectedTaskVersion ||
      Number(row.previous_task_version) < result.previousTaskVersion ||
      result.taskId !== row.task_id ||
      result.taskId === result.previousTaskId ||
      Number(row.task_version) < 1 ||
      result.dueAt !== command.replacementDueAt ||
      result.dueAt <= result.reopenedAt ||
      (row.unchanged_due === 1 && result.dueAt !== row.due_at) ||
      Number(row.live_case_version) < result.caseVersion ||
      (row.live_case_version === result.caseVersion &&
        (row.live_case_result !== 'OPEN' || row.active_task_id !== result.taskId)) ||
      [o.created_at, h.created_at, a.created_at, row.created_at].some(
        (time) => time !== result.reopenedAt,
      ) ||
      [h.actor_user_id, a.actor_user_id, row.created_by_user_id].some(
        (id) => id !== o.actor_user_id,
      ) ||
      [h.actor_membership_id, a.actor_membership_id, row.created_by_membership_id].some(
        (id) => id !== o.actor_membership_id,
      ) ||
      h.reason_code !== command.reasonCode ||
      h.notes !== command.notes ||
      a.target_type !== 'sales_cases' ||
      a.target_id !== result.caseId ||
      a.idempotency_key !== o.idempotency_key ||
      JSON.parse(String(a.metadata_json)).responseHash !== (await computePayloadHash(result)) ||
      o.payload_fingerprint !==
        (await computePayloadHash({ action: o.action, targetId: result.caseId, input: command }))
    )
      throw Error('OPERATIONAL_RECOVERY_INVALID');
    revisions.add(result.resultRevisionId);
    const child = childrenByReceipt.get(o.id),
      ch = childHistory.get(o.id);
    if (result.successor) {
      if (
        !child ||
        !ch ||
        !command.expectedSuccessor ||
        successors.has(result.successor.caseId) ||
        child.agency_id !== o.agency_id ||
        ch.agency_id !== o.agency_id ||
        result.successor.caseId !== child.case_id ||
        result.successor.caseId !== command.expectedSuccessor.caseId ||
        result.successor.caseId !== row.followup_case_id ||
        result.successor.caseId !== ch.case_id ||
        result.successor.taskId !== child.task_id ||
        result.successor.taskId !== command.expectedSuccessor.taskId ||
        result.successor.taskId !== ch.task_id ||
        child.predecessor_case_id !== result.caseId ||
        child.origin_result_revision_id !== result.resultRevisionId ||
        child.origin_receipt_id !== row.loss_receipt_id ||
        command.expectedSuccessor.caseVersion !== 1 ||
        command.expectedSuccessor.taskVersion !== 1 ||
        result.successor.caseVersion !== 2 ||
        ch.case_version !== 2 ||
        result.successor.taskVersion !== 2 ||
        [child.updated_at, child.completed_at, ch.created_at].some(
          (time) => time !== result.reopenedAt,
        ) ||
        child.completed_by_membership_id !== o.actor_membership_id ||
        ch.actor_user_id !== o.actor_user_id ||
        ch.actor_membership_id !== o.actor_membership_id ||
        ch.reason_code !== null ||
        ch.notes !== null
      )
        reject();
      successors.add(result.successor.caseId);
    } else if (child || ch || command.expectedSuccessor || row.followup_case_id !== null) reject();
  }
  if (successors.size !== children.length) reject();
  return { revisions, successors };
}
