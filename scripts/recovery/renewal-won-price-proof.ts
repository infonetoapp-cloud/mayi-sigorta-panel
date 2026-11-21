import { acceptedPriceEvidenceSchema } from '../../src/server/renewals/validation';
import { computePayloadHash } from '../../src/server/mutations/canonical';

type Row = Record<string, unknown>;
export async function verifyRenewalWonPriceRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const receipts = await query(
    "SELECT * FROM operation_receipts WHERE action='renewal.close_won' AND json_type(response_body,'$.acceptedPriceEvidence') IS NOT NULL",
  );
  const audits = await query(
    "SELECT * FROM audit_events WHERE action='sales.price.policy_linked' AND outcome='SUCCESS'",
  );
  if (receipts.length !== audits.length) throw Error('OPERATIONAL_RECOVERY_INVALID');
  const rows = receipts.length
    ? await query(`SELECT s.id case_id,s.agency_id,r.id renewal_id,t.id task_id,t.version task_version,t.completed_at,t.completed_by_membership_id,
   sp.id price_id,sp.insurer_id,v.id revision_id,e.id event_id,e.case_version event_version,s.version case_version,
   l.new_policy_id,l.allocation_operation_id,l.status link_status,p.customer_id,p.branch_id,p.insurer_id policy_insurer,s.customer_id case_customer,s.branch_id case_branch
   FROM operation_receipts o
   JOIN sales_cases s ON s.agency_id=o.agency_id AND s.id=json_extract(o.response_body,'$.acceptedPriceEvidence.caseId')
   JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id AND r.expiring_policy_id=s.source_policy_id
   JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.customer_id=s.customer_id AND t.kind='RENEWAL_FOLLOWUP' AND t.status='COMPLETED'
    AND t.id=json_extract(o.response_body,'$.primaryTaskId')
   JOIN sales_prices sp ON sp.agency_id=s.agency_id AND sp.case_id=s.id
   JOIN sales_price_revisions v ON v.agency_id=sp.agency_id AND v.price_id=sp.id
    AND v.id=json_extract(o.response_body,'$.acceptedPriceEvidence.revisionId')
   JOIN sales_price_events e ON e.agency_id=v.agency_id AND e.revision_id=v.id AND e.case_id=s.id AND e.event_code='CUSTOMER_ACCEPTED'
    AND e.id=json_extract(o.response_body,'$.acceptedPriceEvidence.acceptanceEventId')
   JOIN renewal_policy_links l ON l.agency_id=r.agency_id AND l.renewal_id=r.id AND l.allocation_operation_id=o.id
   JOIN policies p ON p.agency_id=l.agency_id AND p.id=l.new_policy_id
   WHERE s.context_kind='RENEWAL' AND o.action='renewal.close_won'
   AND json_type(o.response_body,'$.acceptedPriceEvidence')='object'
   AND EXISTS (SELECT 1 FROM sales_price_events shared WHERE shared.agency_id=e.agency_id
     AND shared.case_id=e.case_id AND shared.revision_id=e.revision_id
     AND shared.event_code='SHARED' AND shared.case_version<e.case_version)
   AND NOT EXISTS (SELECT 1 FROM sales_price_events newer WHERE newer.agency_id=e.agency_id
     AND newer.case_id=e.case_id AND newer.revision_id=e.revision_id AND newer.case_version>e.case_version
     AND newer.case_version<=json_extract(o.response_body,'$.acceptedPriceEvidence.expectedCaseVersion'))`)
    : [];
  for (const receipt of receipts) {
    const body = JSON.parse(String(receipt.response_body)),
      source = acceptedPriceEvidenceSchema.parse(body.acceptedPriceEvidence);
    const evidence = rows.filter(
      (row) =>
        row.agency_id === receipt.agency_id &&
        row.allocation_operation_id === receipt.id &&
        row.case_id === source.caseId &&
        row.renewal_id === body.renewalId &&
        row.task_id === body.primaryTaskId &&
        row.revision_id === source.revisionId &&
        row.event_id === source.acceptanceEventId,
    );
    const row = evidence[0],
      proof = audits.filter(
        (a) =>
          a.agency_id === receipt.agency_id &&
          a.correlation_id === receipt.id &&
          a.target_type === 'renewal_opportunities' &&
          a.target_id === body.renewalId &&
          a.actor_user_id === receipt.actor_user_id &&
          a.actor_membership_id === receipt.actor_membership_id &&
          a.idempotency_key === receipt.idempotency_key &&
          a.created_at === body.closedAt,
      );
    if (
      !row ||
      evidence.length !== 1 ||
      proof.length !== 1 ||
      receipt.status !== 'COMPLETED' ||
      body.state !== 'WON' ||
      receipt.response_status !== (body.createdPolicyId === null ? 200 : 201) ||
      body.closedAt !== receipt.created_at ||
      body.acceptedQuoteVersionId !== null ||
      body.acceptedPolicyId !== null ||
      !Array.isArray(body.newPolicyIds) ||
      body.newPolicyIds.length !== 1 ||
      body.newPolicyIds[0] !== source.policyId ||
      row.new_policy_id !== source.policyId ||
      !['ACTIVE', 'SUPERSEDED'].includes(String(row.link_status)) ||
      row.customer_id !== row.case_customer ||
      row.branch_id !== row.case_branch ||
      row.policy_insurer !== row.insurer_id ||
      row.completed_at !== body.closedAt ||
      row.completed_by_membership_id !== receipt.actor_membership_id ||
      row.task_version !== body.taskVersion ||
      Number(row.event_version) > source.expectedCaseVersion ||
      Number(row.case_version) < source.expectedCaseVersion ||
      JSON.parse(String(proof[0]!.metadata_json)).responseHash !== (await computePayloadHash(body))
    )
      throw Error('OPERATIONAL_RECOVERY_INVALID');
  }
}
