import { z } from 'zod';
import {
  claimFieldsSchema,
  claimCommandSchema,
  claimResultSchema,
  normalizeClaimNumber,
} from '../../src/shared/claims';
import { computePayloadHash, canonicalizePayload } from '../../src/server/mutations/canonical';
type Row = Record<string, unknown>;
export async function verifyClaimRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const reject = (): never => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  const rows = await query('SELECT * FROM claim_files'),
    history = await query('SELECT * FROM claim_history'),
    receipts = await query(
      "SELECT * FROM operation_receipts WHERE action IN ('claim.create','claim.update')",
    ),
    audits = await query(
      "SELECT * FROM audit_events WHERE action IN ('claim.create','claim.update') AND outcome='SUCCESS'",
    );
  const fields = (r: Row) =>
    claimFieldsSchema.parse({
      lossDate: r.loss_date,
      fileNumber: r.file_number,
      expertName: r.expert_name,
      expertContact: r.expert_contact,
      status: r.status,
      note: r.note,
    });
  const identity = (r: Row) => String(r.agency_id) + '/' + String(r.claim_id ?? r.id),
    verified = new Set<string>();
  for (const r of rows) {
    const f = fields(r);
    z.number().int().positive().safe().parse(r.version);
    z.enum(['GENERAL', 'HEALTH']).parse(r.data_classification);
    z.string().datetime().parse(r.created_at);
    z.string().datetime().parse(r.updated_at);
    if (normalizeClaimNumber(f.fileNumber) !== r.normalized_file_number) reject();
    const hs = history
      .filter((h) => h.agency_id === r.agency_id && h.claim_id === r.id)
      .sort((a, b) => Number(a.version) - Number(b.version));
    if (hs.length !== r.version) reject();
    let health = false;
    for (const [index, h] of hs.entries()) {
      z.enum(['GENERAL', 'HEALTH']).parse(h.data_classification);
      z.string().datetime().parse(h.created_at);
      claimFieldsSchema.parse(JSON.parse(String(h.snapshot_json)));
      if (h.version !== index + 1 || (health && h.data_classification !== 'HEALTH')) reject();
      health = health || h.data_classification === 'HEALTH';
    }
    const last = hs.at(-1);
    if (
      !last ||
      last.created_at !== r.updated_at ||
      hs[0]?.created_at !== r.created_at ||
      last.data_classification !== r.data_classification ||
      canonicalizePayload(claimFieldsSchema.parse(JSON.parse(String(last.snapshot_json)))) !==
        canonicalizePayload(f)
    )
      reject();
  }
  for (const h of history)
    if (!rows.some((r) => r.agency_id === h.agency_id && r.id === h.claim_id)) reject();
  for (const o of receipts) {
    const saved = z
        .object({ result: claimResultSchema, command: claimCommandSchema })
        .strict()
        .parse(JSON.parse(String(o.response_body))),
      r = saved.result,
      c = saved.command;
    if (
      o.action !== 'claim.' + c.kind.toLowerCase() ||
      o.status !== 'COMPLETED' ||
      o.response_status !== 200 ||
      (await computePayloadHash({ action: o.action, payload: c })) !== o.payload_fingerprint ||
      r.version !== (c.kind === 'CREATE' ? 1 : c.expectedVersion + 1)
    )
      reject();
    const parent = rows.find((p) => p.agency_id === o.agency_id && p.id === r.claimId),
      h = history.find(
        (h) => h.agency_id === o.agency_id && h.claim_id === r.claimId && h.version === r.version,
      );
    if (
      !parent ||
      !h ||
      h.actor_membership_id !== o.actor_membership_id ||
      h.created_at !== o.created_at ||
      canonicalizePayload(claimFieldsSchema.parse(JSON.parse(String(h.snapshot_json)))) !==
        canonicalizePayload(c.fields) ||
      (c.kind === 'CREATE'
        ? parent.policy_id !== c.policyId || parent.customer_id !== c.customerId
        : parent.id !== c.claimId)
    )
      reject();
    const as = audits.filter(
      (a) =>
        a.agency_id === o.agency_id &&
        a.actor_user_id === o.actor_user_id &&
        a.actor_membership_id === o.actor_membership_id &&
        a.idempotency_key === o.idempotency_key &&
        a.action === o.action &&
        a.target_type === 'claim_files' &&
        a.target_id === r.claimId &&
        JSON.parse(String(a.metadata_json)).targetVersion === r.version,
    );
    if (as.length !== 1) reject();
    const k = String(o.agency_id) + '/' + r.claimId + '/' + r.version;
    if (verified.has(k)) reject();
    verified.add(k);
  }
  for (const h of history) if (!verified.has(identity(h) + '/' + h.version)) reject();
  if (audits.length !== receipts.length) reject();
  if (
    (
      await query(
        'SELECT r.id FROM claim_files r LEFT JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.policy_id WHERE p.id IS NULL OR p.customer_id<>r.customer_id LIMIT 1',
      )
    ).length
  )
    reject();
}
