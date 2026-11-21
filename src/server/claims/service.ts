import { literalTurkishSearch } from '../db/literal-search';
import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { evaluateAuthorization } from '../auth/authorization';
import { computePayloadHash, canonicalizePayload } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import {
  claimCommandSchema,
  claimFieldsSchema,
  claimId,
  claimQuerySchema,
  claimResultSchema,
  normalizeClaimNumber,
  type ClaimRecord,
  type ClaimDetail,
  type ClaimPage,
  type ClaimHistory,
} from '../../shared/claims';
export class ClaimError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    readonly code: string,
  ) {
    super(code);
  }
}
const joins = `JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.policy_id JOIN customers c ON c.agency_id=r.agency_id AND c.id=r.customer_id AND p.customer_id=r.customer_id JOIN insurers i ON i.agency_id=r.agency_id AND i.id=r.insurer_id JOIN insurance_branches b ON b.agency_id=r.agency_id AND b.id=r.branch_id JOIN insurance_branches bp ON bp.agency_id=p.agency_id AND bp.id=p.branch_id JOIN agency_memberships m ON m.agency_id=p.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;
const columns = `r.id,r.policy_id AS policyId,r.customer_id AS customerId,r.insurer_id AS insurerId,r.branch_id AS branchId,c.display_name AS customerName,p.policy_number AS policyNumber,i.name AS insurerName,b.name AS branchName,c.reference_name AS referenceName,r.loss_date AS lossDate,r.file_number AS fileNumber,r.expert_name AS expertName,r.expert_contact AS expertContact,r.status,r.note,r.version,r.created_at AS createdAt,r.updated_at AS updatedAt,(p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL) AS parentArchived,p.start_date AS policyStartDate,p.end_date AS policyEndDate,p.status AS policyStatus`;
function active(ctx: AuthenticatedUserContext) {
  const m = ctx.memberships[0];
  if (!m || m.status !== 'ACTIVE') throw new ClaimError(403, 'FORBIDDEN');
  return m;
}
function gate(ctx: AuthenticatedUserContext, write = false, frozen = true) {
  const m = active(ctx);
  const scope = (code: string, col: string) =>
    `EXISTS(SELECT 1 FROM membership_permissions g WHERE g.membership_id=m.id AND g.permission_code='${code}' AND (g.scope='AGENCY' OR (g.scope='ASSIGNED' AND (${col}=m.id${code === 'policy.read' ? ' OR c.assignee_membership_id=m.id' : ''}))))`;
  return {
    sql: `m.id=? AND m.agency_id=? AND m.user_id=? AND m.permission_version=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE') AND (m.type='OWNER' OR (EXISTS(SELECT 1 FROM membership_permissions f WHERE f.membership_id=m.id AND f.permission_code='claim.read' AND f.scope='UNSCOPED') ${write ? "AND EXISTS(SELECT 1 FROM membership_permissions f WHERE f.membership_id=m.id AND f.permission_code='claim.manage' AND f.scope='UNSCOPED')" : ''} AND ${scope('customer.read', 'c.assignee_membership_id')} AND ${scope('policy.read', 'p.assignee_membership_id')})) AND (${frozen ? "(r.data_classification<>'HEALTH' AND b.data_classification<>'HEALTH' AND bp.data_classification<>'HEALTH')" : "b.data_classification<>'HEALTH'"} OR (EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.read' AND h.scope='UNSCOPED') ${write ? "AND EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.write' AND h.scope='UNSCOPED')" : ''}))`,
    params: [m.id, m.agencyId, ctx.userId, m.permissionVersion, ctx.identityId],
  };
}
async function permission(db: D1Database, ctx: AuthenticatedUserContext, write = false) {
  const m = active(ctx);
  const r = await evaluateAuthorization(db, {
    context: ctx,
    action: write ? 'claim.manage' : 'claim.read',
    resource: { agencyId: m.agencyId, isCollection: true },
  });
  if (r.decision !== 'ALLOW') throw new ClaimError(403, 'FORBIDDEN');
}
async function canManage(db: D1Database, ctx: AuthenticatedUserContext) {
  return (
    (
      await evaluateAuthorization(db, {
        context: ctx,
        action: 'claim.manage',
        resource: { agencyId: active(ctx).agencyId, isCollection: true },
      })
    ).decision === 'ALLOW'
  );
}
export const claimToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
type Row = ClaimRecord & { policyStartDate: string; policyEndDate: string; policyStatus: string };
function record(row: Row): ClaimRecord {
  const { policyStartDate, policyEndDate, policyStatus, ...r } = row;
  void policyStartDate;
  void policyEndDate;
  void policyStatus;
  return { ...r, parentArchived: !!r.parentArchived };
}
async function find(db: D1Database, ctx: AuthenticatedUserContext, id: string, write = false) {
  const g = gate(ctx, write);
  const r = await db
    .prepare(`SELECT ${columns} FROM claim_files r ${joins} WHERE r.id=? AND ${g.sql}`)
    .bind(id, ...g.params)
    .first<Row>();
  if (!r) throw new ClaimError(404, 'NOT_FOUND');
  return r;
}
export async function listClaims(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  raw: unknown,
): Promise<ClaimPage> {
  await permission(db, ctx);
  const q = claimQuerySchema.parse(raw),
    g = gate(ctx),
    where = [g.sql],
    args: unknown[] = [...g.params];
  if (q.status !== 'ALL') {
    where.push('r.status=?');
    args.push(q.status);
  }
  for (const [value, column, op] of [
    [q.from, 'r.loss_date', '>='],
    [q.to, 'r.loss_date', '<='],
    [q.policyId, 'r.policy_id', '='],
    [q.customerId, 'r.customer_id', '='],
    [q.branchId, 'r.branch_id', '='],
  ] as const)
    if (value) {
      where.push(`${column}${op}?`);
      args.push(value);
    }
  if (q.q) {
    const { predicate, needle } = literalTurkishSearch(
      "c.display_name||' '||p.policy_number||' '||coalesce(r.file_number,'')",
      q.q,
    );
    where.push(predicate);
    args.push(needle);
  }
  const binding = await computePayloadHash({
    actor: ctx.userId,
    identity: ctx.identityId,
    membership: active(ctx).id,
    agency: active(ctx).agencyId,
    pver: active(ctx).permissionVersion,
    filters: { ...q, cursor: null },
  });
  if (q.cursor) {
    try {
      const c = z
        .object({ date: z.string(), id: claimId, binding: z.string(), expires: z.number() })
        .strict()
        .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      if (c.binding !== binding || c.expires < Date.now()) throw Error();
      where.push('(r.loss_date<? OR (r.loss_date=? AND r.id<?))');
      args.push(c.date, c.date, c.id);
    } catch {
      throw new ClaimError(400, 'CURSOR_INVALID');
    }
  }
  const rows = (
      await db
        .prepare(
          `SELECT ${columns} FROM claim_files r ${joins} WHERE ${where.join(' AND ')} ORDER BY r.loss_date DESC,r.id DESC LIMIT ?`,
        )
        .bind(...args, q.limit + 1)
        .all<Row>()
    ).results,
    items = rows.slice(0, q.limit).map(record),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(
            JSON.stringify({
              date: last.lossDate,
              id: last.id,
              binding,
              expires: Date.now() + 900000,
            }),
          ).toString('base64url')
        : null,
    canManage: await canManage(db, ctx),
    today: claimToday(),
  };
}
const detailQuery = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    verifyVersion: z.coerce.number().int().positive().optional(),
  })
  .strict();
function history(r: { version: number; snapshot_json: string; created_at: string }): ClaimHistory {
  return {
    version: r.version,
    fields: claimFieldsSchema.parse(JSON.parse(r.snapshot_json)),
    createdAt: r.created_at,
  };
}
export async function claimDetail(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  id: string,
  raw: unknown = {},
): Promise<ClaimDetail> {
  claimId.parse(id);
  await permission(db, ctx);
  const q = detailQuery.parse(raw),
    g = gate(ctx),
    w = gate(ctx, true);
  const base = `FROM claim_history h JOIN claim_files r ON r.agency_id=h.agency_id AND r.id=h.claim_id ${joins} WHERE r.id=? AND ${g.sql}`;
  const [parent, past, verified, write] = await db.batch([
    db
      .prepare(`SELECT ${columns} FROM claim_files r ${joins} WHERE r.id=? AND ${g.sql}`)
      .bind(id, ...g.params),
    db
      .prepare(
        `SELECT h.version,h.snapshot_json,h.created_at ${base}${q.before ? ' AND h.version<?' : ''} ORDER BY h.version DESC LIMIT 51`,
      )
      .bind(id, ...g.params, ...(q.before ? [q.before] : [])),
    db
      .prepare(`SELECT h.version,h.snapshot_json,h.created_at ${base} AND h.version=?`)
      .bind(id, ...g.params, q.verifyVersion ?? 0),
    db
      .prepare(
        `SELECT r.id FROM claim_files r ${joins} WHERE r.id=? AND ${w.sql} AND p.archived_at IS NULL AND c.archived_at IS NULL AND p.status<>'VOIDED'`,
      )
      .bind(id, ...w.params),
  ]);
  const row = parent!.results[0] as unknown as Row | undefined;
  if (!row) throw new ClaimError(404, 'NOT_FOUND');
  const rows = past!.results as unknown as Parameters<typeof history>[0][];
  return {
    claim: record(row),
    history: rows.slice(0, 50).map(history),
    nextHistoryVersion: rows.length > 50 ? rows[49]!.version : null,
    verifiedHistory: verified!.results[0]
      ? history(verified!.results[0] as unknown as Parameters<typeof history>[0])
      : null,
    canManage: write!.results.length > 0 && (await canManage(db, ctx)),
    today: claimToday(),
    policyStartDate: row.policyStartDate,
    policyEndDate: row.policyEndDate,
  };
}
function changed(db: D1Database) {
  return db
    .prepare(
      "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),'OPTIMISTIC_CONCURRENCY_CONFLICT'",
    )
    .bind(crypto.randomUUID());
}
export async function writeClaim(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  raw: unknown,
  idempotencyKey: string,
) {
  claimId.parse(idempotencyKey);
  const input = claimCommandSchema.parse(raw),
    m = active(ctx),
    action = 'claim.' + input.kind.toLowerCase();
  await permission(db, ctx, true);
  const fingerprint = await computePayloadHash({ action, payload: input });
  async function replay() {
    const old = await db
      .prepare(
        'SELECT action,payload_fingerprint,status,response_status,response_body FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?',
      )
      .bind(m.agencyId, ctx.userId, m.id, idempotencyKey)
      .first<{
        action: string;
        payload_fingerprint: string;
        status: string;
        response_status: number;
        response_body: string;
      }>();
    if (!old) return null;
    if (
      old.action !== action ||
      old.payload_fingerprint !== fingerprint ||
      old.status !== 'COMPLETED' ||
      old.response_status !== 200
    )
      throw new ClaimError(409, 'IDEMPOTENCY_CONFLICT');
    const saved = z
        .object({ result: claimResultSchema, command: claimCommandSchema })
        .strict()
        .parse(JSON.parse(old.response_body)),
      r = saved.result;
    if (
      (await computePayloadHash({ action, payload: saved.command })) !== fingerprint ||
      r.version !== (input.kind === 'CREATE' ? 1 : input.expectedVersion + 1) ||
      (input.kind === 'UPDATE' && r.claimId !== input.claimId)
    )
      throw new ClaimError(409, 'RECEIPT_INVALID');
    const row = await find(db, ctx, r.claimId, true);
    if (
      input.kind === 'CREATE' &&
      (row.policyId !== input.policyId || row.customerId !== input.customerId)
    )
      throw new ClaimError(409, 'RECEIPT_INVALID');
    const h = await db
      .prepare(
        `SELECT snapshot_json FROM claim_history WHERE agency_id=? AND claim_id=? AND version=?`,
      )
      .bind(m.agencyId, r.claimId, r.version)
      .first<{ snapshot_json: string }>();
    const proof = await db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=? AND target_id=? AND idempotency_key=? AND outcome='SUCCESS'",
      )
      .bind(m.agencyId, ctx.userId, m.id, action, r.claimId, idempotencyKey)
      .first<{ n: number }>();
    if (
      !h ||
      canonicalizePayload(claimFieldsSchema.parse(JSON.parse(h.snapshot_json))) !==
        canonicalizePayload(input.fields) ||
      proof?.n !== 1
    )
      throw new ClaimError(409, 'RECEIPT_INVALID');
    return { data: r, replayed: true };
  }
  const old = await replay();
  if (old) return old;
  const g = gate(ctx, true),
    now = new Date().toISOString();
  let policyId: string,
    customerId: string,
    insurerId: string,
    branchId: string,
    classification: string,
    id: string,
    previous: Row | null = null;
  if (input.kind === 'CREATE') {
    const parentGate = gate(ctx, true, false);
    const p = await db
      .prepare(
        `SELECT p.id,p.customer_id,p.insurer_id,p.branch_id,b.data_classification,p.start_date,p.end_date FROM policies p JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id JOIN agency_memberships m ON m.agency_id=p.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id WHERE p.id=? AND p.customer_id=? AND p.version=? AND p.archived_at IS NULL AND c.archived_at IS NULL AND p.status<>'VOIDED' AND ${parentGate.sql}`,
      )
      .bind(input.policyId, input.customerId, input.expectedPolicyVersion, ...parentGate.params)
      .first<{
        id: string;
        customer_id: string;
        insurer_id: string;
        branch_id: string;
        data_classification: string;
        start_date: string;
        end_date: string;
      }>();
    if (!p) throw new ClaimError(404, 'NOT_FOUND');
    if (input.fields.lossDate < p.start_date || input.fields.lossDate > p.end_date)
      throw new ClaimError(400, 'LOSS_PERIOD_INVALID');
    policyId = p.id;
    customerId = p.customer_id;
    insurerId = p.insurer_id;
    branchId = p.branch_id;
    classification = p.data_classification;
    id = crypto.randomUUID();
  } else {
    previous = await find(db, ctx, input.claimId, true);
    if (
      previous.version !== input.expectedVersion ||
      previous.parentArchived ||
      previous.policyStatus === 'VOIDED'
    )
      throw new ClaimError(409, 'VERSION_CONFLICT');
    if (
      input.fields.lossDate !== previous.lossDate &&
      (input.fields.lossDate < previous.policyStartDate ||
        input.fields.lossDate > previous.policyEndDate)
    )
      throw new ClaimError(400, 'LOSS_PERIOD_INVALID');
    policyId = previous.policyId;
    customerId = previous.customerId;
    insurerId = previous.insurerId;
    branchId = previous.branchId;
    classification = 'GENERAL';
    id = previous.id;
  }
  if (input.fields.lossDate > claimToday()) throw new ClaimError(400, 'LOSS_DATE_FUTURE');
  const f = input.fields,
    result = { claimId: id, version: input.kind === 'CREATE' ? 1 : input.expectedVersion + 1 },
    stmts: D1PreparedStatement[] = [];
  if (input.kind === 'CREATE')
    stmts.push(
      db
        .prepare(
          'INSERT INTO claim_files(id,agency_id,policy_id,customer_id,insurer_id,branch_id,data_classification,loss_date,file_number,normalized_file_number,expert_name,expert_contact,status,note,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
        )
        .bind(
          id,
          m.agencyId,
          policyId,
          customerId,
          insurerId,
          branchId,
          classification,
          f.lossDate,
          f.fileNumber,
          normalizeClaimNumber(f.fileNumber),
          f.expertName,
          f.expertContact,
          f.status,
          f.note,
          now,
          now,
        ),
      changed(db),
    );
  else
    stmts.push(
      db
        .prepare(
          `UPDATE claim_files SET data_classification=CASE WHEN data_classification='HEALTH' OR EXISTS(SELECT 1 FROM insurance_branches b WHERE b.agency_id=claim_files.agency_id AND b.id=claim_files.branch_id AND b.data_classification='HEALTH') OR EXISTS(SELECT 1 FROM policies p JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id WHERE p.agency_id=claim_files.agency_id AND p.id=claim_files.policy_id AND b.data_classification='HEALTH') THEN 'HEALTH' ELSE 'GENERAL' END,loss_date=?,file_number=?,normalized_file_number=?,expert_name=?,expert_contact=?,status=?,note=?,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=?`,
        )
        .bind(
          f.lossDate,
          f.fileNumber,
          normalizeClaimNumber(f.fileNumber),
          f.expertName,
          f.expertContact,
          f.status,
          f.note,
          now,
          m.agencyId,
          id,
          input.expectedVersion,
        ),
      changed(db),
    );
  stmts.push(
    db
      .prepare(
        'INSERT INTO claim_history(id,agency_id,claim_id,version,snapshot_json,actor_membership_id,created_at,data_classification) SELECT ?,?,?,?,?,?,?,data_classification FROM claim_files WHERE agency_id=? AND id=?',
      )
      .bind(
        crypto.randomUUID(),
        m.agencyId,
        id,
        result.version,
        JSON.stringify(f),
        m.id,
        now,
        m.agencyId,
        id,
      ),
    changed(db),
  );
  const authority = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 FROM claim_files r ${joins} WHERE r.id=? AND r.policy_id=? AND ${g.sql} AND p.archived_at IS NULL AND c.archived_at IS NULL AND p.status<>'VOIDED' ${input.kind === 'CREATE' ? 'AND p.version=?' : previous!.lossDate !== f.lossDate ? 'AND p.start_date<=? AND p.end_date>=?' : ''}) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      id,
      policyId,
      ...g.params,
      ...(input.kind === 'CREATE'
        ? [input.expectedPolicyVersion]
        : previous!.lossDate !== f.lossDate
          ? [f.lossDate, f.lossDate]
          : []),
    );
  const audit = buildSafeAuditRecord({
    id: crypto.randomUUID(),
    agencyId: m.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: m.id,
    action,
    targetType: 'claim_files',
    targetId: id,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    outcome: 'SUCCESS',
    metadata: { targetVersion: result.version, changedFields: ['claim'] },
    createdAt: now,
  });
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          m.agencyId,
          ctx.userId,
          m.id,
          action,
          idempotencyKey,
          fingerprint,
          JSON.stringify({ result, command: input }),
          now,
          now,
        ),
      ...stmts,
      authority,
      db
        .prepare(
          'INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,idempotency_key,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          audit.id,
          audit.agencyId,
          audit.actorUserId,
          audit.actorMembershipId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.correlationId,
          audit.idempotencyKey,
          audit.outcome,
          audit.metadataJson,
          audit.createdAt,
        ),
    ]);
  } catch (e) {
    const winner = await replay();
    if (winner) return winner;
    const msg = e instanceof Error ? e.message : String(e);
    if (/CLAIM_|OPTIMISTIC_CONCURRENCY|FINAL_AUTHORITY|UNIQUE constraint/.test(msg))
      throw new ClaimError(409, 'CLAIM_CONFLICT');
    throw e;
  }
  return { data: result, replayed: false };
}
