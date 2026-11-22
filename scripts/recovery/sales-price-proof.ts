import {
  salesPriceReceiptSchema,
  salesPriceCreateSchema,
  salesPriceReviseSchema,
} from '../../src/shared/sales-prices';
import { computePayloadHash } from '../../src/server/mutations/canonical';
type Row = Record<string, unknown>;

/** No price or acceptance history is invented for older full QuoteVersions. */
export async function verifySalesPriceRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
): Promise<void> {
  const reject = (): never => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  try {
    const prices = await query('SELECT * FROM sales_prices'),
      revisions = await query('SELECT * FROM sales_price_revisions'),
      cases = await query('SELECT * FROM sales_cases'),
      insurers = await query('SELECT id,agency_id FROM insurers'),
      members = await query('SELECT id,agency_id,user_id FROM agency_memberships'),
      receipts = await query(
        "SELECT * FROM operation_receipts WHERE action IN ('sales.price.create','sales.price.revise')",
      ),
      audits = await query(
        "SELECT * FROM audit_events WHERE action IN ('sales.price.create','sales.price.revise') AND outcome='SUCCESS'",
      ),
      history = await query(
        "SELECT * FROM sales_case_history WHERE event_code IN ('PRICE_CREATED','PRICE_REVISED')",
      );
    const verified = new Set<unknown>(),
      companies = new Set<string>();
    for (const p of prices) {
      const company = `${String(p.agency_id)}:${String(p.case_id)}:${String(p.insurer_id)}`;
      const rs = revisions
        .filter((r) => r.agency_id === p.agency_id && r.price_id === p.id)
        .sort((a, b) => Number(a.revision_number) - Number(b.revision_number));
      if (
        !cases.some((s) => s.agency_id === p.agency_id && s.id === p.case_id) ||
        !insurers.some((i) => i.agency_id === p.agency_id && i.id === p.insurer_id) ||
        companies.has(company) ||
        rs.length !== p.version ||
        !rs.length ||
        rs.at(-1)!.id !== p.current_revision_id ||
        p.created_at !== rs[0]!.created_at ||
        p.updated_at !== rs.at(-1)!.created_at
      )
        reject();
      companies.add(company);
      for (const [index, r] of rs.entries()) {
        const hs = history.filter(
          (h) =>
            h.agency_id === p.agency_id &&
            h.case_id === p.case_id &&
            receipts.some(
              (o) =>
                o.id === h.receipt_id &&
                JSON.parse(String(o.response_body)).result?.revisionId === r.id,
            ),
        );
        if (hs.length !== 1) reject();
        const h = hs[0]!,
          o = receipts.find((o) => o.id === h.receipt_id && o.agency_id === p.agency_id);
        if (!o || verified.has(o.id)) reject();
        const saved = salesPriceReceiptSchema.parse(JSON.parse(String(o!.response_body))),
          result = saved.result,
          creation = index === 0,
          command = creation
            ? salesPriceCreateSchema.parse(saved.command)
            : salesPriceReviseSchema.parse(saved.command);
        if (
          r.revision_number !== index + 1 ||
          result.revisionNumber !== r.revision_number ||
          result.priceVersion !== r.revision_number ||
          result.revisionId !== r.id ||
          result.priceId !== p.id ||
          result.caseId !== p.case_id ||
          result.operationId !== o!.id ||
          saved.targetId !== p.case_id ||
          saved.priceId !== (creation ? null : p.id) ||
          h.case_version !== result.caseVersion ||
          command.expectedCaseVersion !== Number(h.case_version) - 1 ||
          h.task_id !== null ||
          h.reason_code !== null ||
          h.notes !== null ||
          h.event_code !== (creation ? 'PRICE_CREATED' : 'PRICE_REVISED') ||
          o!.action !== (creation ? 'sales.price.create' : 'sales.price.revise') ||
          o!.status !== 'COMPLETED' ||
          o!.response_status !== (creation ? 201 : 200) ||
          o!.actor_user_id !== h.actor_user_id ||
          o!.actor_membership_id !== h.actor_membership_id ||
          o!.created_at !== h.created_at ||
          r.created_by_user_id !== h.actor_user_id ||
          r.created_by_membership_id !== h.actor_membership_id ||
          r.created_at !== h.created_at ||
          !members.some(
            (m) =>
              m.agency_id === p.agency_id &&
              m.id === h.actor_membership_id &&
              m.user_id === h.actor_user_id,
          ) ||
          r.amount_minor !== command.amountMinor ||
          r.currency !== command.currency ||
          r.terms_note !== command.termsNote ||
          r.offered_start_date !== (command.offeredPeriod?.startDate ?? null) ||
          r.offered_end_date !== (command.offeredPeriod?.endDate ?? null) ||
          (creation
            ? salesPriceCreateSchema.parse(command).insurerId !== p.insurer_id
            : salesPriceReviseSchema.parse(command).expectedPriceVersion !== index) ||
          (await computePayloadHash({
            action: o!.action,
            targetId: saved.targetId,
            priceId: saved.priceId,
            input: saved.command,
          })) !== o!.payload_fingerprint
        )
          reject();
        const proof = audits.filter(
          (a) =>
            a.agency_id === p.agency_id &&
            a.action === o!.action &&
            a.target_type === 'sales_cases' &&
            a.target_id === p.case_id &&
            a.correlation_id === o!.id &&
            a.idempotency_key === o!.idempotency_key &&
            a.actor_user_id === h.actor_user_id &&
            a.actor_membership_id === h.actor_membership_id &&
            a.created_at === h.created_at,
        );
        if (
          proof.length !== 1 ||
          JSON.parse(String(proof[0]!.metadata_json)).responseHash !==
            (await computePayloadHash(result))
        )
          reject();
        verified.add(o!.id);
      }
    }
    if (
      verified.size !== receipts.length ||
      receipts.length !== revisions.length ||
      history.length !== receipts.length ||
      audits.length !== receipts.length
    )
      reject();
  } catch {
    reject();
  }
}
