import { z } from 'zod';
import { computePayloadHash } from '../../src/server/mutations/canonical';
import { parsePremiumMinor } from '../../src/server/policies/validation';
import { financeCommandSchema } from '../../src/shared/finance';
// Recovery-only semantic checks: imported triggers cannot validate older rows.
type Row = Record<string, unknown>;
export async function verifyFinanceRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const id = z.string().min(1).max(128),
    money = z.number().int().safe().positive(),
    reason = z.enum(['DATA_ERROR', 'DUE_DATE_CHANGED', 'DUPLICATE', 'CUSTOMER_AGREED', 'OTHER']);
  const date = z
    .string()
    .refine(
      (v) =>
        /^\d{4}-\d{2}-\d{2}$/.test(v) &&
        v.slice(0, 4) !== '0000' &&
        Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
        new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v,
    );
  const base = {
    id,
    agency_id: id,
    receivable_id: id,
    actor_membership_id: id,
    created_at: z.string().datetime(),
  };
  const rs = z.object({
    id,
    agency_id: id,
    policy_id: id,
    customer_id: id,
    amount_minor: money,
    currency: z.string().regex(/^[A-Z]{3}$/),
    due_date: date,
    method: z.enum(['DEFERRED', 'CASH', 'BANK', 'CARD']),
    status: z.enum(['ACTIVE', 'VOIDED']),
    version: z.number().int().safe().positive(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  });
  const es = z.object({
    ...base,
    kind: z.enum(['PAYMENT', 'REVERSAL']),
    amount_minor: money,
    received_date: date,
    method: z.enum(['CASH', 'BANK', 'CARD']),
    reverses_id: id.nullable(),
    reason_code: reason.nullable(),
  });
  const vs = z.object({
    ...base,
    version: z.number().int().safe().positive(),
    amount_minor: money,
    due_date: date,
    status: z.enum(['ACTIVE', 'VOIDED']),
    reason_code: reason.nullable(),
  });
  const receivables = (await query('SELECT * FROM finance_receivables')).map((r) => rs.parse(r)),
    entries = (await query('SELECT * FROM finance_entries')).map((r) => es.parse(r)),
    revisions = (await query('SELECT * FROM finance_revisions')).map((r) => vs.parse(r));
  const reject = () => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };

  for (const row of await query(
    "SELECT * FROM operation_receipts WHERE action IN ('finance.create','finance.collect','finance.reverse','finance.adjust','finance.void')",
  )) {
    const saved = z
      .object({
        result: z
          .object({
            receivableId: id,
            version: z.number().int().positive(),
            entryId: id.nullable(),
          })
          .strict(),
        command: financeCommandSchema,
      })
      .strict()
      .parse(JSON.parse(String(row.response_body)));
    const { result: r, command: c } = saved;
    if (
      row.action !== 'finance.' + c.kind.toLowerCase() ||
      (await computePayloadHash({ action: row.action, payload: c })) !== row.payload_fingerprint ||
      r.version !== (c.kind === 'CREATE' ? 1 : c.expectedVersion + 1)
    )
      reject();
    const parent = receivables.find(
      (p) => p.id === r.receivableId && p.agency_id === row.agency_id,
    );
    if (
      !parent ||
      r.version > parent.version ||
      (c.kind === 'CREATE' ? parent.policy_id !== c.policyId : parent.id !== c.receivableId)
    )
      reject();
    if (c.kind === 'COLLECT' || c.kind === 'REVERSE') {
      const e = entries.find(
        (e) =>
          e.id === r.entryId && e.agency_id === row.agency_id && e.receivable_id === r.receivableId,
      );
      if (
        !e ||
        e.actor_membership_id !== row.actor_membership_id ||
        (c.kind === 'COLLECT'
          ? e.kind !== 'PAYMENT' ||
            BigInt(e.amount_minor) !== BigInt(parsePremiumMinor(c.amount)) ||
            e.received_date !== c.receivedDate ||
            e.method !== c.method
          : e.kind !== 'REVERSAL' || e.reverses_id !== c.entryId || e.reason_code !== c.reasonCode)
      )
        reject();
    } else {
      const v = revisions.find(
        (v) =>
          v.agency_id === row.agency_id &&
          v.receivable_id === r.receivableId &&
          v.version === r.version,
      );
      if (
        r.entryId !== null ||
        !v ||
        v.actor_membership_id !== row.actor_membership_id ||
        (c.kind === 'VOID'
          ? v.status !== 'VOIDED'
          : v.status !== 'ACTIVE' ||
            v.due_date !== c.dueDate ||
            BigInt(v.amount_minor) !== BigInt(parsePremiumMinor(c.amount))) ||
        ('reasonCode' in c && v.reason_code !== c.reasonCode)
      )
        reject();
    }
  }

  for (const e of entries) {
    if (!receivables.some((r) => r.agency_id === e.agency_id && r.id === e.receivable_id)) reject();
    if (e.kind === 'PAYMENT') {
      if (e.reverses_id !== null || e.reason_code !== null) reject();
    } else {
      const old = entries.find(
        (o) =>
          o.id === e.reverses_id &&
          o.agency_id === e.agency_id &&
          o.receivable_id === e.receivable_id &&
          o.kind === 'PAYMENT',
      );
      if (
        !old ||
        old.amount_minor !== e.amount_minor ||
        old.method !== e.method ||
        e.reason_code === null ||
        entries.filter((o) => o.agency_id === e.agency_id && o.reverses_id === e.reverses_id)
          .length !== 1
      )
        reject();
    }
  }
  for (const r of receivables) {
    const payments = entries.filter((e) => e.agency_id === r.agency_id && e.receivable_id === r.id),
      history = revisions
        .filter((v) => v.agency_id === r.agency_id && v.receivable_id === r.id)
        .sort((a, b) => a.version - b.version);
    const net = payments.reduce(
        (n, e) => n + (e.kind === 'PAYMENT' ? BigInt(e.amount_minor) : -BigInt(e.amount_minor)),
        0n,
      ),
      last = history.at(-1);
    if (
      net < 0n ||
      net > BigInt(r.amount_minor) ||
      (r.status === 'VOIDED' && net !== 0n) ||
      history[0]?.version !== 1 ||
      !last ||
      last.version > r.version ||
      last.amount_minor !== r.amount_minor ||
      last.due_date !== r.due_date ||
      last.status !== r.status ||
      r.version !== history.length + payments.length
    )
      reject();
    for (const v of history)
      if (v.version === 1 ? v.reason_code !== null : v.reason_code === null) reject();
  }
  for (const v of revisions)
    if (!receivables.some((r) => r.agency_id === v.agency_id && r.id === v.receivable_id)) reject();
  if (
    (
      await query(`SELECT a.id FROM audit_events a LEFT JOIN operation_receipts o ON o.agency_id=a.agency_id AND o.actor_user_id=a.actor_user_id AND o.actor_membership_id=a.actor_membership_id AND o.idempotency_key=a.idempotency_key
 WHERE a.action IN ('finance.create','finance.collect','finance.reverse','finance.adjust','finance.void') AND a.outcome='SUCCESS' AND (o.id IS NULL OR o.status<>'COMPLETED' OR o.response_status<>200 OR o.action<>a.action OR a.target_type<>'finance_receivables' OR json_extract(o.response_body,'$.result.receivableId')<>a.target_id OR json_extract(o.response_body,'$.result.version')<>json_extract(a.metadata_json,'$.targetVersion')) LIMIT 1`)
    ).length
  )
    reject();
  if (
    (
      await query(
        `SELECT r.id FROM finance_receivables r WHERE (SELECT count(*) FROM audit_events a WHERE a.agency_id=r.agency_id AND a.target_id=r.id AND a.target_type='finance_receivables' AND a.action IN ('finance.create','finance.collect','finance.reverse','finance.adjust','finance.void') AND a.outcome='SUCCESS')<>r.version LIMIT 1`,
      )
    ).length
  )
    reject();
}
