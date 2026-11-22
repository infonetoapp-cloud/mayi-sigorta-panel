import { literalTurkishSearch } from '../db/literal-search';
import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { evaluateAuthorization } from '../auth/authorization';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { parsePremiumMinor } from '../policies/validation';
import {
  financeCommandSchema,
  financeQuerySchema,
  type FinanceReceivable,
  type FinanceDetail,
  type FinancePage,
  type FinanceEntry,
  type FinanceRevision,
  type FinanceResult,
} from '../../shared/finance';
export class FinanceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    readonly code: string,
  ) {
    super(code);
  }
}
const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const resultSchema = z
  .object({ receivableId: key, version: z.number().int().positive(), entryId: key.nullable() })
  .strict();
const detailQuery = z
  .object({
    entriesBefore: key.optional(),
    revisionsBefore: z.coerce.number().int().positive().optional(),
    verifyEntry: key.optional(),
    verifyVersion: z.coerce.number().int().positive().optional(),
  })
  .strict();
const joins = `JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.policy_id JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id JOIN agency_memberships m ON m.agency_id=p.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;
const collected = `coalesce((SELECT sum(CASE WHEN e.kind='PAYMENT' THEN e.amount_minor ELSE -e.amount_minor END) FROM finance_entries e WHERE e.agency_id=r.agency_id AND e.receivable_id=r.id),0)`;
const columns = `r.id,r.policy_id AS policyId,r.customer_id AS customerId,c.display_name AS customerName,p.policy_number AS policyNumber,b.name AS branchName,r.amount_minor AS amountMinor,${collected} AS collectedMinor,r.currency,r.due_date AS dueDate,r.method,r.status,r.version,r.created_at AS createdAt`;
function active(ctx: AuthenticatedUserContext) {
  const m = ctx.memberships[0];
  if (!m || m.status !== 'ACTIVE') throw new FinanceError(403, 'FORBIDDEN');
  return m;
}
function gate(ctx: AuthenticatedUserContext, write = false) {
  const m = active(ctx);
  const scope = (code: string, col: string) =>
    `EXISTS(SELECT 1 FROM membership_permissions g WHERE g.membership_id=m.id AND g.permission_code='${code}' AND (g.scope='AGENCY' OR (g.scope='ASSIGNED' AND (${col}=m.id${code === 'policy.read' ? ' OR c.assignee_membership_id=m.id' : ''}))))`;
  return {
    sql: `m.id=? AND m.agency_id=? AND m.user_id=? AND m.permission_version=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE') AND (m.type='OWNER' OR (EXISTS(SELECT 1 FROM membership_permissions f WHERE f.membership_id=m.id AND f.permission_code='finance.read' AND f.scope='UNSCOPED') ${write ? "AND EXISTS(SELECT 1 FROM membership_permissions f WHERE f.membership_id=m.id AND f.permission_code='finance.manage' AND f.scope='UNSCOPED')" : ''} AND ${scope('customer.read', 'c.assignee_membership_id')} AND ${scope('policy.read', 'p.assignee_membership_id')})) AND (b.data_classification<>'HEALTH' OR EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.read' AND h.scope='UNSCOPED'))`,
    params: [m.id, m.agencyId, ctx.userId, m.permissionVersion, ctx.identityId],
  };
}
async function permission(db: D1Database, ctx: AuthenticatedUserContext, write = false) {
  const m = active(ctx);
  const r = await evaluateAuthorization(db, {
    context: ctx,
    action: write ? 'finance.manage' : 'finance.read',
    resource: { agencyId: m.agencyId, isCollection: true },
  });
  if (r.decision !== 'ALLOW') throw new FinanceError(403, 'FORBIDDEN');
}
async function canManage(db: D1Database, ctx: AuthenticatedUserContext) {
  return (
    (
      await evaluateAuthorization(db, {
        context: ctx,
        action: 'finance.manage',
        resource: { agencyId: active(ctx).agencyId, isCollection: true },
      })
    ).decision === 'ALLOW'
  );
}
export const financeToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
function monetary(n: number) {
  if (!Number.isSafeInteger(n) || n < 0) throw new FinanceError(500, 'BALANCE_INVALID');
  return n;
}
function dto(row: FinanceReceivable, today: string): FinanceReceivable {
  const balance = monetary(monetary(row.amountMinor) - monetary(row.collectedMinor));
  const remainingMinor = row.status === 'VOIDED' ? 0 : balance;
  return {
    ...row,
    remainingMinor,
    state:
      row.status === 'VOIDED'
        ? 'VOIDED'
        : remainingMinor === 0
          ? 'COLLECTED'
          : row.dueDate < today
            ? 'OVERDUE'
            : row.collectedMinor > 0
              ? 'PARTIAL'
              : 'OPEN',
  };
}
async function find(db: D1Database, ctx: AuthenticatedUserContext, id: string, write = false) {
  const g = gate(ctx, write);
  const r = await db
    .prepare(`SELECT ${columns} FROM finance_receivables r ${joins} WHERE r.id=? AND ${g.sql}`)
    .bind(id, ...g.params)
    .first<FinanceReceivable>();
  if (!r) throw new FinanceError(404, 'NOT_FOUND');
  return dto(r, financeToday());
}
export async function listFinance(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  raw: unknown,
): Promise<FinancePage> {
  await permission(db, ctx);
  const q = financeQuerySchema.parse(raw),
    today = financeToday(),
    g = gate(ctx);
  const where = [g.sql],
    params: unknown[] = [...g.params];
  if (q.view === 'OPEN') where.push(`r.status='ACTIVE' AND r.amount_minor>${collected}`);
  if (q.view === 'COLLECTED') where.push(`r.status='ACTIVE' AND r.amount_minor=${collected}`);
  if (q.due !== 'ALL') {
    where.push(
      q.due === 'OVERDUE'
        ? `r.status='ACTIVE' AND r.amount_minor>${collected} AND r.due_date<?`
        : 'r.due_date=?',
    );
    params.push(today);
  }
  if (q.policyId) {
    where.push('p.id=?');
    params.push(q.policyId);
  }
  if (q.branchId) {
    where.push('p.branch_id=?');
    params.push(q.branchId);
  }
  if (q.q) {
    const { predicate, needle } = literalTurkishSearch(
      "c.display_name||' '||p.policy_number||' '||coalesce((SELECT json_extract(v.details_json,'$.plate') FROM policy_vehicle_snapshots v WHERE v.agency_id=p.agency_id AND v.policy_id=p.id),'')",
      q.q,
    );
    where.push(predicate);
    params.push(needle);
  }
  const binding = await computePayloadHash({
    actor: ctx.userId,
    identity: ctx.identityId,
    membership: active(ctx).id,
    agency: active(ctx).agencyId,
    pver: active(ctx).permissionVersion,
    filters: { ...q, cursor: null },
  });
  const totalWhere = where.join(' AND '),
    totalParams = [...params];
  if (q.cursor) {
    try {
      const c = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          id: key,
          binding: z.string(),
          expires: z.number(),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      if (c.binding !== binding || c.expires < Date.now()) throw Error();
      where.push('(r.due_date>? OR (r.due_date=? AND r.id>?))');
      params.push(c.date, c.date, c.id);
    } catch {
      throw new FinanceError(400, 'CURSOR_INVALID');
    }
  }
  const [page, totals] = await db.batch([
    db
      .prepare(
        `SELECT ${columns} FROM finance_receivables r ${joins} WHERE ${where.join(' AND ')} ORDER BY r.due_date,r.id LIMIT ?`,
      )
      .bind(...params, q.limit + 1),
    db
      .prepare(
        `SELECT r.currency,sum(CASE WHEN r.status='ACTIVE' THEN r.amount_minor ELSE 0 END) AS amountMinor,sum(CASE WHEN r.status='ACTIVE' THEN ${collected} ELSE 0 END) AS collectedMinor,sum(CASE WHEN r.status='ACTIVE' THEN r.amount_minor-${collected} ELSE 0 END) AS remainingMinor FROM finance_receivables r ${joins} WHERE ${totalWhere} GROUP BY r.currency`,
      )
      .bind(...totalParams),
  ]);
  const rows = page!.results as unknown as FinanceReceivable[],
    items = rows.slice(0, q.limit).map((r) => dto(r, today)),
    last = items.at(-1);
  const sums = totals!.results as unknown as FinancePage['totals'];
  for (const s of sums) {
    monetary(s.amountMinor);
    monetary(s.collectedMinor);
    monetary(s.remainingMinor);
  }
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(
            JSON.stringify({
              date: last.dueDate,
              id: last.id,
              binding,
              expires: Date.now() + 900000,
            }),
          ).toString('base64url')
        : null,
    totals: sums,
    canManage: await canManage(db, ctx),
    today,
  };
}
export async function financeDetail(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  id: string,
  raw: unknown = {},
): Promise<FinanceDetail> {
  key.parse(id);
  await permission(db, ctx);
  const q = detailQuery.parse(raw),
    g = gate(ctx),
    today = financeToday();
  let before: { created_at: string; id: string } | null = null;
  if (q.entriesBefore) {
    before = await db
      .prepare(
        `SELECT e.created_at,e.id FROM finance_entries e JOIN finance_receivables r ON r.agency_id=e.agency_id AND r.id=e.receivable_id ${joins} WHERE r.id=? AND e.id=? AND ${g.sql}`,
      )
      .bind(id, q.entriesBefore, ...g.params)
      .first();
    if (!before) throw new FinanceError(400, 'CURSOR_INVALID');
  }
  const entryCols = `e.id,e.kind,e.amount_minor AS amountMinor,e.received_date AS receivedDate,e.method,e.reverses_id AS reversesId,e.reason_code AS reasonCode,e.created_at AS createdAt,EXISTS(SELECT 1 FROM finance_entries x WHERE x.agency_id=e.agency_id AND x.reverses_id=e.id) AS reversed`;
  const entryBase = `FROM finance_entries e JOIN finance_receivables r ON r.agency_id=e.agency_id AND r.id=e.receivable_id ${joins} WHERE r.id=? AND ${g.sql}`;
  const revCols =
    'v.version,v.amount_minor AS amountMinor,v.due_date AS dueDate,v.status,v.reason_code AS reasonCode,v.created_at AS createdAt';
  const revBase = `FROM finance_revisions v JOIN finance_receivables r ON r.agency_id=v.agency_id AND r.id=v.receivable_id ${joins} WHERE r.id=? AND ${g.sql}`;
  const [parent, ep, rp, ev, rv] = await db.batch([
    db
      .prepare(`SELECT ${columns} FROM finance_receivables r ${joins} WHERE r.id=? AND ${g.sql}`)
      .bind(id, ...g.params),
    db
      .prepare(
        `SELECT ${entryCols} ${entryBase}${before ? ' AND (e.created_at<? OR (e.created_at=? AND e.id<?))' : ''} ORDER BY e.created_at DESC,e.id DESC LIMIT 51`,
      )
      .bind(id, ...g.params, ...(before ? [before.created_at, before.created_at, before.id] : [])),
    db
      .prepare(
        `SELECT ${revCols} ${revBase}${q.revisionsBefore ? ' AND v.version<?' : ''} ORDER BY v.version DESC LIMIT 51`,
      )
      .bind(id, ...g.params, ...(q.revisionsBefore ? [q.revisionsBefore] : [])),
    db
      .prepare(`SELECT ${entryCols} ${entryBase} AND e.id=?`)
      .bind(id, ...g.params, q.verifyEntry ?? ''),
    db
      .prepare(`SELECT ${revCols} ${revBase} AND v.version=?`)
      .bind(id, ...g.params, q.verifyVersion ?? 0),
  ]);
  const row = parent!.results[0] as unknown as FinanceReceivable | undefined;
  if (!row) throw new FinanceError(404, 'NOT_FOUND');
  const entries = ep!.results as unknown as FinanceEntry[],
    revisions = rp!.results as unknown as FinanceRevision[];
  return {
    receivable: dto(row, today),
    entries: entries.slice(0, 50).map((e) => ({ ...e, reversed: !!e.reversed })),
    revisions: revisions.slice(0, 50),
    entriesNextCursor: entries.length > 50 ? entries[49]!.id : null,
    revisionsNextCursor: revisions.length > 50 ? revisions[49]!.version : null,
    verifiedEntry: ev!.results[0]
      ? {
          ...(ev!.results[0] as unknown as FinanceEntry),
          reversed: !!(ev!.results[0] as unknown as FinanceEntry).reversed,
        }
      : null,
    verifiedRevision: (rv!.results[0] ?? null) as unknown as FinanceRevision | null,
    canManage: await canManage(db, ctx),
    today,
  };
}
function changed(db: D1Database) {
  return db
    .prepare(
      "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),'FINANCE_VERSION_CONFLICT'",
    )
    .bind(crypto.randomUUID());
}
interface Receipt {
  action: string;
  payload_fingerprint: string;
  response_body: string;
  status: string;
  response_status: number;
}
export async function writeFinance(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  raw: unknown,
  idempotencyKey: string,
): Promise<{ data: FinanceResult; replayed: boolean }> {
  key.parse(idempotencyKey);
  const input = financeCommandSchema.parse(raw),
    m = active(ctx),
    action = 'finance.' + input.kind.toLowerCase();
  await permission(db, ctx, true);
  const fingerprint = await computePayloadHash({ action, payload: input });
  async function replay() {
    const receipt = await db
      .prepare(
        'SELECT action,payload_fingerprint,response_body,status,response_status FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?',
      )
      .bind(m.agencyId, ctx.userId, m.id, idempotencyKey)
      .first<Receipt>();
    if (!receipt) return null;
    if (
      receipt.action !== action ||
      receipt.payload_fingerprint !== fingerprint ||
      receipt.status !== 'COMPLETED' ||
      receipt.response_status !== 200
    )
      throw new FinanceError(409, 'IDEMPOTENCY_CONFLICT');
    const stored = z
      .object({ result: resultSchema, command: financeCommandSchema })
      .strict()
      .parse(JSON.parse(receipt.response_body));
    if ((await computePayloadHash({ action, payload: stored.command })) !== fingerprint)
      throw new FinanceError(409, 'RECEIPT_INVALID');
    const result = stored.result;
    if (
      result.version !== (input.kind === 'CREATE' ? 1 : input.expectedVersion + 1) ||
      (input.kind !== 'CREATE' && result.receivableId !== input.receivableId) ||
      ['COLLECT', 'REVERSE'].includes(input.kind) !== (result.entryId !== null)
    )
      throw new FinanceError(409, 'RECEIPT_INVALID');
    const r = await find(db, ctx, result.receivableId, true);
    if (input.kind === 'CREATE' && r.policyId !== input.policyId)
      throw new FinanceError(409, 'RECEIPT_INVALID');
    const proof = await db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=? AND target_id=? AND idempotency_key=? AND outcome='SUCCESS'",
      )
      .bind(m.agencyId, ctx.userId, m.id, action, result.receivableId, idempotencyKey)
      .first<{ n: number }>();
    if (proof?.n !== 1) throw new FinanceError(409, 'RECEIPT_INVALID');
    if (result.entryId) {
      const e = await db
        .prepare('SELECT id FROM finance_entries WHERE agency_id=? AND receivable_id=? AND id=?')
        .bind(m.agencyId, result.receivableId, result.entryId)
        .first();
      if (!e) throw new FinanceError(409, 'RECEIPT_INVALID');
    }
    return { data: result, replayed: true };
  }
  const old = await replay();
  if (old) return old;
  const g = gate(ctx, true),
    now = new Date().toISOString(),
    today = financeToday();
  let policyId: string,
    receivableId: string,
    currency: string,
    current: FinanceReceivable | null = null;
  if (input.kind === 'CREATE') {
    const parent = await db
      .prepare(
        `SELECT p.id,p.customer_id,p.currency FROM policies p JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id JOIN agency_memberships m ON m.agency_id=p.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id WHERE p.id=? AND p.version=? AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL AND ${g.sql}`,
      )
      .bind(input.policyId, input.expectedPolicyVersion, ...g.params)
      .first<{ id: string; customer_id: string; currency: string }>();
    if (!parent) throw new FinanceError(404, 'NOT_FOUND');
    policyId = parent.id;
    currency = parent.currency;
    receivableId = crypto.randomUUID();
  } else {
    current = await find(db, ctx, input.receivableId, true);
    if (current.status !== 'ACTIVE' || current.version !== input.expectedVersion)
      throw new FinanceError(409, 'VERSION_CONFLICT');
    policyId = current.policyId;
    currency = current.currency;
    receivableId = current.id;
  }
  let amountMinor: number | null = null;
  if ('amount' in input) {
    try {
      amountMinor = parsePremiumMinor(input.amount);
    } catch {
      throw new FinanceError(400, 'AMOUNT_INVALID');
    }
    if (amountMinor <= 0) throw new FinanceError(400, 'AMOUNT_INVALID');
  }
  if (
    input.kind === 'COLLECT' &&
    (input.receivedDate > today || amountMinor! > current!.remainingMinor)
  )
    throw new FinanceError(400, 'COLLECTION_INVALID');
  if (input.kind === 'ADJUST' && amountMinor! < current!.collectedMinor)
    throw new FinanceError(400, 'AMOUNT_BELOW_COLLECTIONS');
  if (input.kind === 'VOID' && current!.collectedMinor !== 0)
    throw new FinanceError(409, 'COLLECTIONS_EXIST');
  const entryId = input.kind === 'COLLECT' || input.kind === 'REVERSE' ? crypto.randomUUID() : null,
    result: FinanceResult = {
      receivableId,
      version: input.kind === 'CREATE' ? 1 : input.expectedVersion + 1,
      entryId,
    };
  const stmts: D1PreparedStatement[] = [];
  if (input.kind === 'CREATE')
    stmts.push(
      db
        .prepare(
          `INSERT INTO finance_receivables(id,agency_id,policy_id,customer_id,amount_minor,currency,due_date,method,status,version,created_at,updated_at) SELECT ?,p.agency_id,p.id,p.customer_id,?,p.currency,?,?,'ACTIVE',1,?,? FROM policies p WHERE p.agency_id=? AND p.id=? AND p.version=? AND p.status='ACTIVE' AND p.archived_at IS NULL`,
        )
        .bind(
          receivableId,
          amountMinor,
          input.dueDate,
          input.method,
          now,
          now,
          m.agencyId,
          policyId,
          input.expectedPolicyVersion,
        ),
      changed(db),
    );
  else
    stmts.push(
      db
        .prepare(
          `UPDATE finance_receivables SET version=version+1,updated_at=?${input.kind === 'ADJUST' ? ',amount_minor=?,due_date=?' : ''}${input.kind === 'VOID' ? ",status='VOIDED'" : ''} WHERE agency_id=? AND id=? AND version=? AND status='ACTIVE'`,
        )
        .bind(
          now,
          ...(input.kind === 'ADJUST' ? [amountMinor, input.dueDate] : []),
          m.agencyId,
          receivableId,
          input.expectedVersion,
        ),
      changed(db),
    );
  if (input.kind === 'COLLECT')
    stmts.push(
      db
        .prepare(
          "INSERT INTO finance_entries(id,agency_id,receivable_id,kind,amount_minor,received_date,method,actor_membership_id,created_at) VALUES(?,?,?,'PAYMENT',?,?,?,?,?)",
        )
        .bind(
          entryId,
          m.agencyId,
          receivableId,
          amountMinor,
          input.receivedDate,
          input.method,
          m.id,
          now,
        ),
      changed(db),
    );
  if (input.kind === 'REVERSE')
    stmts.push(
      db
        .prepare(
          "INSERT INTO finance_entries(id,agency_id,receivable_id,kind,amount_minor,received_date,method,reverses_id,reason_code,actor_membership_id,created_at) SELECT ?,e.agency_id,e.receivable_id,'REVERSAL',e.amount_minor,?,e.method,e.id,?,?,? FROM finance_entries e WHERE e.agency_id=? AND e.receivable_id=? AND e.id=? AND e.kind='PAYMENT' AND NOT EXISTS(SELECT 1 FROM finance_entries x WHERE x.agency_id=e.agency_id AND x.reverses_id=e.id)",
        )
        .bind(entryId, today, input.reasonCode, m.id, now, m.agencyId, receivableId, input.entryId),
      changed(db),
    );
  if (input.kind === 'CREATE' || input.kind === 'ADJUST' || input.kind === 'VOID')
    stmts.push(
      db
        .prepare(
          'INSERT INTO finance_revisions(id,agency_id,receivable_id,version,amount_minor,due_date,status,reason_code,actor_membership_id,created_at) SELECT ?,r.agency_id,r.id,r.version,r.amount_minor,r.due_date,r.status,?,?,? FROM finance_receivables r WHERE r.agency_id=? AND r.id=? AND r.version=?',
        )
        .bind(
          crypto.randomUUID(),
          'reasonCode' in input ? input.reasonCode : null,
          m.id,
          now,
          m.agencyId,
          receivableId,
          result.version,
        ),
      changed(db),
    );
  const authority = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 FROM finance_receivables r ${joins} WHERE r.id=? AND r.policy_id=? AND ${g.sql}${input.kind === 'CREATE' ? " AND p.version=? AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL" : ''}) THEN 1 ELSE 0 END,'FINANCE_AUTHORITY_CHANGED'`,
    )
    .bind(
      crypto.randomUUID(),
      receivableId,
      policyId,
      ...g.params,
      ...(input.kind === 'CREATE' ? [input.expectedPolicyVersion] : []),
    );
  const audit = buildSafeAuditRecord({
    id: crypto.randomUUID(),
    agencyId: m.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: m.id,
    action,
    targetType: 'finance_receivables',
    targetId: receivableId,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    outcome: 'SUCCESS',
    metadata: {
      targetVersion: result.version,
      changedFields: [input.kind],
      ...('reasonCode' in input ? { reasonCode: input.reasonCode } : {}),
    },
    createdAt: now,
  });
  const receipt = db
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
    );
  try {
    await db.batch([
      receipt,
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
  } catch (error) {
    const r = await replay();
    if (r) return r;
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('FINANCE_') ||
      message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT') ||
      message.includes('UNIQUE constraint')
    )
      throw new FinanceError(409, 'FINANCE_CONFLICT');
    throw error;
  }
  void currency;
  return { data: result, replayed: false };
}
