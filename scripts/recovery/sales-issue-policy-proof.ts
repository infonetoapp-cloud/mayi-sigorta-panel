import { salesWonCorrectionReceiptSchema } from '../../src/shared/sales-won-correction';
import { canonicalizeTargetIds } from '../../src/server/mutations/grants';
import { issuePolicyReceiptSchema } from '../../src/server/sales/issue-policy';
import { computePayloadHash } from '../../src/server/mutations/canonical';

type Row = Record<string, unknown>;
export async function verifySalesIssuePolicyRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const receipts = await query(
    "SELECT * FROM operation_receipts WHERE action='sales.case.issue_policy'",
  );
  const audits = await query(
    "SELECT * FROM audit_events WHERE action='sales.case.issue_policy' AND outcome='SUCCESS'",
  );
  const count = (
    await query(`SELECT
    (SELECT count(*) FROM sales_cases WHERE context_kind='NEW_BUSINESS' AND result='WON') cases,
    (SELECT count(*) FROM sales_case_policy_results) results,
    (SELECT count(*) FROM sales_case_history WHERE event_code='CASE_WON_CORRECTED') corrections,
    (SELECT count(*) FROM sales_case_history WHERE event_code='WON') history`)
  )[0]!;
  if (
    receipts.length !== audits.length ||
    [Number(count.cases) + Number(count.corrections), count.results, count.history].some(
      (n) => n !== receipts.length,
    )
  )
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  await verifyWonCorrections(query, Number(count.corrections));
  if (!receipts.length) return;
  const links =
    await query(`SELECT w.*,CASE WHEN s.version=w.case_version THEN s.updated_at ELSE t.completed_at END updated_at,t.completed_at,t.completed_by_membership_id,
    h.actor_user_id,h.actor_membership_id,h.created_at, p.version live_policy_version,
    p.insurer_id,p.branch_id,p.gross_premium_minor,p.currency,p.start_date,p.end_date,s.branch_id case_branch,
    (SELECT count(*) FROM sales_prices sp JOIN sales_price_revisions v ON v.agency_id=sp.agency_id
      AND v.price_id=sp.id
      JOIN sales_price_events ev ON ev.agency_id=v.agency_id AND ev.case_id=sp.case_id AND ev.revision_id=v.id
      WHERE sp.agency_id=w.agency_id AND sp.case_id=w.case_id
        AND sp.insurer_id=json_extract(o.response_body,'$.policyTerms.insurerId')
        AND v.id=json_extract(o.response_body,'$.command.source.revisionId')
        AND ev.id=json_extract(o.response_body,'$.command.source.acceptanceEventId')
        AND ev.event_code='CUSTOMER_ACCEPTED' AND ev.case_version<w.case_version
        AND EXISTS(SELECT 1 FROM sales_price_events prior WHERE prior.agency_id=ev.agency_id AND prior.case_id=ev.case_id
          AND prior.revision_id=ev.revision_id AND prior.case_version<ev.case_version AND prior.event_code='SHARED')
        AND NOT EXISTS(SELECT 1 FROM sales_price_events newer WHERE newer.agency_id=ev.agency_id AND newer.case_id=ev.case_id
          AND newer.revision_id=ev.revision_id AND newer.case_version>ev.case_version AND newer.case_version<w.case_version)) matches_price
    FROM sales_case_policy_results w
    JOIN operation_receipts o ON o.agency_id=w.agency_id AND o.id=w.receipt_id
    JOIN sales_cases s ON s.agency_id=w.agency_id AND s.id=w.case_id AND s.context_kind='NEW_BUSINESS'
      AND ((s.result='WON' AND s.version=w.case_version AND s.active_task_id IS NULL AND s.current_result_id IS NULL)
       OR (s.version>w.case_version AND EXISTS(SELECT 1 FROM sales_case_history correction
         WHERE correction.agency_id=w.agency_id AND correction.case_id=w.case_id
           AND correction.case_version=w.case_version+1 AND correction.event_code='CASE_WON_CORRECTED')))
    JOIN tasks t ON t.agency_id=w.agency_id AND t.id=w.task_id AND t.kind='GENERAL' AND t.status='COMPLETED'
      AND t.customer_id=s.customer_id AND t.version=w.task_version AND t.policy_id IS NULL AND t.renewal_id IS NULL
    JOIN sales_case_tasks l ON l.agency_id=w.agency_id AND l.case_id=w.case_id AND l.task_id=t.id
    JOIN policies p ON p.agency_id=w.agency_id AND p.id=w.policy_id AND p.customer_id=s.customer_id
    JOIN sales_case_history h ON h.agency_id=w.agency_id AND h.case_id=w.case_id AND h.receipt_id=w.receipt_id
      AND h.event_code='WON' AND h.case_version=w.case_version AND h.task_id=t.id AND h.notes IS NULL AND h.reason_code IS NULL`);
  const linksByReceipt = new Map(links.map((row) => [row.receipt_id, row]));
  const auditByReceipt = new Map(audits.map((row) => [row.correlation_id, row]));
  if (
    links.length !== receipts.length ||
    linksByReceipt.size !== links.length ||
    auditByReceipt.size !== audits.length
  )
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  for (const o of receipts) {
    const { command, result, policyTerms } = issuePolicyReceiptSchema.parse(
      JSON.parse(String(o.response_body)),
    );
    const w = linksByReceipt.get(o.id);
    const a = auditByReceipt.get(o.id);
    if (
      !w ||
      !a ||
      o.status !== 'COMPLETED' ||
      o.response_status !== (result.createdPolicy ? 201 : 200) ||
      result.createdPolicy !== (command.result.kind === 'CREATE_POLICY') ||
      (command.result.kind === 'LINK_POLICY' &&
        (command.result.policyId !== result.policyId ||
          command.result.expectedPolicyVersion !== result.policyVersion)) ||
      (result.createdPolicy && result.policyVersion !== 1) ||
      (command.source.kind === 'PRICE_REVISION'
        ? w.matches_price !== 1
        : command.differenceReasonCode !== undefined) ||
      result.operationId !== o.id ||
      result.caseId !== w.case_id ||
      result.policyId !== w.policy_id ||
      result.caseVersion !== w.case_version ||
      result.caseVersion !== command.expectedCaseVersion + 1 ||
      result.taskVersion !== w.task_version ||
      result.taskVersion !== command.expectedTaskVersion + 1 ||
      result.taskId !== w.task_id ||
      result.taskId !== command.expectedTaskId ||
      result.policyVersion !== w.policy_version ||
      Number(w.live_policy_version) < result.policyVersion ||
      (w.live_policy_version === result.policyVersion &&
        (w.insurer_id !== policyTerms.insurerId ||
          w.branch_id !== w.case_branch ||
          w.gross_premium_minor !== policyTerms.amount ||
          w.currency !== policyTerms.currency ||
          w.start_date !== policyTerms.startDate ||
          w.end_date !== policyTerms.endDate)) ||
      [o.created_at, w.created_at, w.updated_at, w.completed_at, a.created_at].some(
        (v) => v !== result.closedAt,
      ) ||
      [w.completed_by_membership_id, w.actor_membership_id, a.actor_membership_id].some(
        (v) => v !== o.actor_membership_id,
      ) ||
      w.actor_user_id !== o.actor_user_id ||
      a.actor_user_id !== o.actor_user_id ||
      a.agency_id !== o.agency_id ||
      a.target_type !== 'sales_cases' ||
      a.target_id !== result.caseId ||
      a.idempotency_key !== o.idempotency_key ||
      JSON.parse(String(a.metadata_json)).responseHash !==
        (await computePayloadHash({ result, policyTerms })) ||
      o.payload_fingerprint !==
        (await computePayloadHash({ action: o.action, targetId: result.caseId, input: command }))
    )
      throw Error('OPERATIONAL_RECOVERY_INVALID');
  }
}

async function verifyWonCorrections(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
  count: number,
) {
  const action = 'sales.case.correct_won';
  const receipts = await query(
    "SELECT * FROM operation_receipts WHERE action='sales.case.correct_won'",
  );
  const audits = await query(
    "SELECT * FROM audit_events WHERE action='sales.case.correct_won' AND outcome='SUCCESS'",
  );
  const links =
    await query(`SELECT o.id, h.case_id, h.case_version, h.task_id, h.created_at, h.notes,
    t.created_at task_created_at, original.receipt_id original_receipt, original.task_id original_task,
    original.task_version original_task_version, original.policy_id original_policy, p.version live_policy_version,
    g.id grant_id, g.issued_at, g.expires_at, g.consumed_at, g.target_ids_json,
    CASE WHEN t.version=1 THEN t.due_at ELSE NULL END initial_due_at
    FROM operation_receipts o JOIN sales_case_history h ON h.receipt_id=o.id AND h.agency_id=o.agency_id
    JOIN sales_cases s ON s.agency_id=h.agency_id AND s.id=h.case_id
    JOIN sales_case_policy_results original ON original.agency_id=s.agency_id AND original.case_id=s.id
      AND original.case_version=h.case_version-1
    JOIN policies p ON p.agency_id=original.agency_id AND p.id=original.policy_id
    JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=h.task_id
      AND l.purpose='ACTIVE_CONTACT' AND l.created_at=h.created_at
    JOIN tasks t ON t.agency_id=l.agency_id AND t.id=l.task_id AND t.customer_id=s.customer_id
      AND t.kind='GENERAL' AND t.created_by_membership_id=h.actor_membership_id
      AND t.created_by_user_id=h.actor_user_id AND t.renewal_id IS NULL AND t.policy_id IS NULL
    JOIN sensitive_action_grants g ON g.consumed_operation_id=o.id AND g.agency_id=o.agency_id
      AND g.actor_user_id=o.actor_user_id AND g.actor_membership_id=o.actor_membership_id
      AND g.status='CONSUMED' AND g.assurance='SECURE_GRANT' AND g.action=o.action
      AND g.payload_hash=o.payload_fingerprint AND g.expected_target_version=original.case_version
    WHERE o.action='sales.case.correct_won' AND h.event_code='CASE_WON_CORRECTED'
      AND h.reason_code='INCORRECT_WON' AND o.actor_user_id=h.actor_user_id
      AND o.actor_membership_id=h.actor_membership_id AND s.context_kind='NEW_BUSINESS'
      AND (s.version>h.case_version OR (s.version=h.case_version AND s.result='OPEN' AND s.active_task_id=t.id))`);
  const byReceipt = new Map(links.map((link) => [link.id, link]));
  const byAudit = new Map(audits.map((audit) => [audit.correlation_id, audit]));
  if (
    [receipts.length, links.length, audits.length, byReceipt.size, byAudit.size].some(
      (n) => n !== count,
    )
  )
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  for (const receipt of receipts) {
    const { result, command, grantId } = salesWonCorrectionReceiptSchema.parse(
      JSON.parse(String(receipt.response_body)),
    );
    const link = byReceipt.get(receipt.id);
    const audit = byAudit.get(receipt.id);
    if (
      !link ||
      !audit ||
      receipt.id !== result.operationId ||
      receipt.status !== 'COMPLETED' ||
      receipt.response_status !== 200 ||
      result.caseId !== link.case_id ||
      result.caseVersion !== link.case_version ||
      result.caseVersion !== command.expectedCaseVersion + 1 ||
      result.taskId !== link.task_id ||
      command.expectedIssueReceiptId !== link.original_receipt ||
      command.expectedTaskId !== link.original_task ||
      command.expectedTaskVersion !== link.original_task_version ||
      command.expectedPolicyId !== link.original_policy ||
      command.expectedPolicyVersion > Number(link.live_policy_version) ||
      command.notes !== link.notes ||
      result.dueAt !== command.replacementDueAt ||
      result.dueAt <= result.correctedAt ||
      (link.initial_due_at !== null && link.initial_due_at !== result.dueAt) ||
      grantId !== link.grant_id ||
      link.target_ids_json !==
        canonicalizeTargetIds([result.caseId, command.expectedTaskId, command.expectedPolicyId]) ||
      String(link.issued_at) > result.correctedAt ||
      String(link.expires_at) <= result.correctedAt ||
      [
        receipt.created_at,
        link.created_at,
        link.task_created_at,
        link.consumed_at,
        audit.created_at,
      ].some((date) => date !== result.correctedAt) ||
      audit.agency_id !== receipt.agency_id ||
      audit.actor_user_id !== receipt.actor_user_id ||
      audit.actor_membership_id !== receipt.actor_membership_id ||
      audit.target_type !== 'sales_cases' ||
      audit.target_id !== result.caseId ||
      audit.idempotency_key !== receipt.idempotency_key ||
      JSON.parse(String(audit.metadata_json)).responseHash !== (await computePayloadHash(result)) ||
      receipt.payload_fingerprint !==
        (await computePayloadHash({ action, targetId: result.caseId, command }))
    )
      throw Error('OPERATIONAL_RECOVERY_INVALID');
  }
}
