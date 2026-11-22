import { salesVoidReceiptSchema } from '../../src/shared/sales-void';
import { computePayloadHash } from '../../src/server/mutations/canonical';

type Row = Record<string, unknown>;
export async function verifySalesVoidRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const receipts = await query("SELECT * FROM operation_receipts WHERE action='sales.case.void'");
  const histories = await query("SELECT * FROM sales_case_history WHERE event_code='VOIDED'");
  const audits = await query(
    "SELECT * FROM audit_events WHERE action='sales.case.void' AND outcome='SUCCESS'",
  );
  if (receipts.length !== histories.length || receipts.length !== audits.length)
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  if (!receipts.length) return;

  const links =
    await query(`SELECT h.*,s.updated_at,t.completed_at,t.completed_by_membership_id,t.version task_version
    FROM sales_case_history h
    JOIN sales_cases s ON s.agency_id=h.agency_id AND s.id=h.case_id AND s.context_kind='NEW_BUSINESS'
      AND s.result='VOIDED' AND s.current_result_id IS NULL AND s.active_task_id IS NULL AND s.version=h.case_version
    JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=h.task_id
    JOIN tasks t ON t.agency_id=l.agency_id AND t.id=l.task_id AND t.customer_id=s.customer_id AND t.kind='GENERAL'
      AND t.status='COMPLETED' AND t.policy_id IS NULL AND t.renewal_id IS NULL
    WHERE h.event_code='VOIDED'`);
  const byReceipt = new Map(links.map((row) => [row.receipt_id, row]));
  const auditByReceipt = new Map(audits.map((row) => [row.correlation_id, row]));
  if (
    links.length !== receipts.length ||
    byReceipt.size !== receipts.length ||
    auditByReceipt.size !== receipts.length
  )
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  for (const receipt of receipts) {
    const { command, result } = salesVoidReceiptSchema.parse(
      JSON.parse(String(receipt.response_body)),
    );
    const h = byReceipt.get(receipt.id);
    const audit = auditByReceipt.get(receipt.id);
    if (
      !h ||
      !audit ||
      receipt.status !== 'COMPLETED' ||
      receipt.response_status !== 200 ||
      receipt.agency_id !== h.agency_id ||
      receipt.agency_id !== audit.agency_id ||
      result.operationId !== receipt.id ||
      result.caseId !== h.case_id ||
      result.caseVersion !== h.case_version ||
      result.caseVersion !== command.expectedCaseVersion + 1 ||
      result.taskId !== command.expectedTaskId ||
      result.taskId !== h.task_id ||
      result.taskVersion !== h.task_version ||
      result.taskVersion !== command.expectedTaskVersion + 1 ||
      h.reason_code !== command.reasonCode ||
      h.notes !== command.notes ||
      [receipt.created_at, h.created_at, h.updated_at, h.completed_at, audit.created_at].some(
        (at) => at !== result.closedAt,
      ) ||
      h.actor_user_id !== receipt.actor_user_id ||
      audit.actor_user_id !== receipt.actor_user_id ||
      [h.actor_membership_id, h.completed_by_membership_id, audit.actor_membership_id].some(
        (id) => id !== receipt.actor_membership_id,
      ) ||
      audit.target_type !== 'sales_cases' ||
      audit.target_id !== result.caseId ||
      audit.idempotency_key !== receipt.idempotency_key ||
      JSON.parse(String(audit.metadata_json)).responseHash !== (await computePayloadHash(result)) ||
      receipt.payload_fingerprint !==
        (await computePayloadHash({
          action: receipt.action,
          targetId: result.caseId,
          input: command,
        }))
    )
      throw Error('OPERATIONAL_RECOVERY_INVALID');
  }
}
