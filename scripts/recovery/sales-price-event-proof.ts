import { salesPriceEventReceiptSchema } from '../../src/shared/sales-price-events';
import { computePayloadHash } from '../../src/server/mutations/canonical';

type Row = Record<string, unknown>;
/** Retrospective proof: imported rows must carry the original event, Task and receipt. */
export async function verifySalesPriceEventRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
): Promise<void> {
  const reject = (): never => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  try {
    const events = await query('SELECT * FROM sales_price_events'),
      cases = await query('SELECT * FROM sales_cases'),
      prices = await query('SELECT * FROM sales_prices'),
      revisions = await query('SELECT * FROM sales_price_revisions'),
      tasks = await query('SELECT * FROM tasks'),
      links = await query('SELECT * FROM sales_case_tasks'),
      members = await query('SELECT id,agency_id,user_id FROM agency_memberships'),
      receipts = await query("SELECT * FROM operation_receipts WHERE action='sales.price.event'"),
      history = await query(
        "SELECT * FROM sales_case_history WHERE event_code IN ('PRICE_SHARED','PRICE_ACCEPTED','PRICE_ACCEPTANCE_REVOKED')",
      ),
      audits = await query(
        "SELECT * FROM audit_events WHERE action='sales.price.event' AND outcome='SUCCESS'",
      );
    const priceHistory = await query(
      "SELECT h.agency_id,h.case_id,h.case_version,json_extract(o.response_body,'$.result.revisionId') revision_id FROM sales_case_history h JOIN operation_receipts o ON o.id=h.receipt_id WHERE h.event_code IN ('PRICE_CREATED','PRICE_REVISED')",
    );
    const verified = new Set<unknown>();
    for (const e of [...events].sort((a, b) => Number(a.case_version) - Number(b.case_version))) {
      const s = cases.find((s) => s.agency_id === e.agency_id && s.id === e.case_id),
        v = revisions.find((v) => v.agency_id === e.agency_id && v.id === e.revision_id),
        p = prices.find(
          (p) => p.agency_id === e.agency_id && p.id === v?.price_id && p.case_id === e.case_id,
        ),
        t = tasks.find((t) => t.agency_id === e.agency_id && t.id === e.task_id),
        o = receipts.find((o) => o.agency_id === e.agency_id && o.id === e.receipt_id);
      if (!s || !v || !p || !t || !o || verified.has(o.id)) reject();
      const saved = salesPriceEventReceiptSchema.parse(JSON.parse(String(o!.response_body))),
        c = saved.command,
        r = saved.result;
      const earlier = events
          .filter(
            (x) =>
              x.agency_id === e.agency_id &&
              x.revision_id === e.revision_id &&
              Number(x.case_version) < Number(e.case_version),
          )
          .sort((a, b) => Number(b.case_version) - Number(a.case_version)),
        previous = earlier[0];
      const code =
        e.event_code === 'SHARED'
          ? 'PRICE_SHARED'
          : e.event_code === 'CUSTOMER_ACCEPTED'
            ? 'PRICE_ACCEPTED'
            : 'PRICE_ACCEPTANCE_REVOKED';
      const hs = history.filter(
        (h) =>
          h.agency_id === e.agency_id &&
          h.case_id === e.case_id &&
          h.case_version === e.case_version &&
          h.receipt_id === o!.id,
      );
      if (hs.length !== 1) reject();
      const h = hs[0]!;
      if (
        saved.targetId !== s!.id ||
        r.caseId !== s!.id ||
        r.operationId !== o!.id ||
        r.eventId !== e.id ||
        r.revisionId !== v!.id ||
        c.revisionId !== v!.id ||
        r.event !== e.event_code ||
        c.event !== e.event_code ||
        r.occurredAt !== e.occurred_at ||
        c.occurredAt !== e.occurred_at ||
        r.caseVersion !== e.case_version ||
        c.expectedCaseVersion + 1 !== e.case_version ||
        Number(s!.version) < r.caseVersion ||
        c.expectedTaskId !== t!.id ||
        c.expectedTaskVersion !== e.task_version ||
        Number(t!.version) < c.expectedTaskVersion ||
        t!.customer_id !== s!.customer_id ||
        t!.policy_id !== null ||
        (s!.context_kind === 'NEW_BUSINESS'
          ? t!.kind !== 'GENERAL' ||
            t!.renewal_id !== null ||
            !links.some(
              (l) => l.agency_id === s!.agency_id && l.case_id === s!.id && l.task_id === t!.id,
            )
          : t!.kind !== 'RENEWAL_FOLLOWUP' || t!.renewal_id !== s!.renewal_id) ||
        o!.status !== 'COMPLETED' ||
        o!.response_status !== 201 ||
        o!.actor_user_id !== e.actor_user_id ||
        o!.actor_membership_id !== e.actor_membership_id ||
        o!.created_at !== e.created_at ||
        o!.updated_at !== e.created_at ||
        h.event_code !== code ||
        h.task_id !== t!.id ||
        h.actor_user_id !== e.actor_user_id ||
        h.actor_membership_id !== e.actor_membership_id ||
        h.created_at !== e.created_at ||
        h.reason_code !== null ||
        h.notes !== null ||
        !members.some(
          (m) =>
            m.agency_id === e.agency_id &&
            m.id === e.actor_membership_id &&
            m.user_id === e.actor_user_id,
        ) ||
        !Number.isFinite(Date.parse(String(e.occurred_at))) ||
        new Date(String(e.occurred_at)).toISOString() !== e.occurred_at ||
        String(e.occurred_at) > String(e.created_at) ||
        String(v!.created_at) > String(e.created_at) ||
        priceHistory.filter(
          (h) =>
            h.agency_id === e.agency_id &&
            h.case_id === e.case_id &&
            h.revision_id === e.revision_id &&
            Number(h.case_version) < Number(e.case_version),
        ).length !== 1 ||
        (e.event_code === 'SHARED'
          ? !!previous
          : e.event_code === 'CUSTOMER_ACCEPTED'
            ? !previous || !['SHARED', 'ACCEPTANCE_REVOKED'].includes(String(previous.event_code))
            : e.event_code !== 'ACCEPTANCE_REVOKED' ||
              previous?.event_code !== 'CUSTOMER_ACCEPTED') ||
        (previous && String(previous.occurred_at) > String(e.occurred_at)) ||
        revisions.some(
          (x) =>
            x.agency_id === e.agency_id &&
            x.price_id === p!.id &&
            Number(x.revision_number) > Number(v!.revision_number) &&
            priceHistory.some(
              (h) =>
                h.agency_id === e.agency_id &&
                h.case_id === e.case_id &&
                h.revision_id === x.id &&
                Number(h.case_version) < Number(e.case_version),
            ),
        ) ||
        (await computePayloadHash({
          action: 'sales.price.event',
          targetId: saved.targetId,
          input: c,
        })) !== o!.payload_fingerprint
      )
        reject();
      const proof = audits.filter(
        (a) =>
          a.agency_id === e.agency_id &&
          a.target_type === 'sales_cases' &&
          a.target_id === s!.id &&
          a.correlation_id === o!.id &&
          a.idempotency_key === o!.idempotency_key &&
          a.actor_user_id === e.actor_user_id &&
          a.actor_membership_id === e.actor_membership_id &&
          a.created_at === e.created_at,
      );
      if (
        proof.length !== 1 ||
        JSON.parse(String(proof[0]!.metadata_json)).responseHash !== (await computePayloadHash(r))
      )
        reject();
      verified.add(o!.id);
    }
    if (
      verified.size !== receipts.length ||
      history.length !== events.length ||
      audits.length !== events.length
    )
      reject();
  } catch {
    reject();
  }
}
