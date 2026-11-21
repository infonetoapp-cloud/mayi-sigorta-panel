import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { renewalSourceJoins, renewalSourceReadGate } from './renewal-source';
import {
  salesCreateSchema,
  salesFollowupSchema,
  salesResultSchema,
  salesReceiptSchema,
  type SalesCaseDto,
  type SalesCommandResult,
} from '../../shared/sales';
export class SalesError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 409,
  ) {
    super(code);
  }
}
export const salesQuery = z.strictObject({
  customerId: z.string().min(1).max(128).optional(),
  branchId: z.string().min(1).max(128).optional(),
  context: z.enum(['NEW_BUSINESS', 'RENEWAL']).optional(),
  renewalId: z.string().min(1).max(128).optional(),
  result: z.enum(['OPEN', 'ALL']).default('OPEN'),
  cursor: z.string().max(1200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
type Ctx = AuthenticatedUserContext;
export function member(ctx: Ctx) {
  const m = ctx.memberships[0];
  if (!m || m.status !== 'ACTIVE') throw new SalesError('FORBIDDEN', 403);
  return m;
}
/** SQL rechecks current role/grants/scope, not a caller-provided authorization flag. */
export function salesGate(
  ctx: Ctx,
  write = false,
  task: false | 'read' | 'create' | 'update' = false,
  renewalAware = false,
) {
  const m = member(ctx),
    codes = [
      'customer.read',
      'quote.read',
      ...(write ? ['quote.manage'] : []),
      ...(task
        ? [
            'task.read',
            ...(task === 'create' ? ['task.create'] : task === 'update' ? ['task.update'] : []),
          ]
        : []),
    ];
  const tests = codes.map((code) => {
    const scoped = !['task.create'].includes(code);
    const assigned =
      renewalAware && code.startsWith('quote.')
        ? "(c.assignee_membership_id=m.id OR (s.context_kind='RENEWAL' AND r.assignee_membership_id=m.id))"
        : `${code.startsWith('task.') ? 't.assignee_membership_id' : 'c.assignee_membership_id'}=m.id`;
    return `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code='${code}' AND ${scoped ? `(x.scope='AGENCY' OR (x.scope='ASSIGNED' AND ${assigned}))` : `x.scope='UNSCOPED'`}))`;
  });
  if (task) tests.push("(m.type='OWNER' OR t.assignee_membership_id=m.id)");
  const health = `(b.data_classification='HEALTH'${task ? " OR s.data_classification='HEALTH'" : " OR s.data_classification='HEALTH'"})`;
  tests.push(
    `(NOT ${health} OR (EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.read' AND h.scope='UNSCOPED')${write ? " AND EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.write' AND h.scope='UNSCOPED')" : ''}))`,
  );
  return {
    sql: `m.id=? AND m.agency_id=c.agency_id AND m.user_id=? AND m.type=? AND m.permission_version=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE') AND ${tests.join(' AND ')}`,
    args: [m.id, ctx.userId, m.type, m.permissionVersion, ctx.identityId],
  };
}
const joins = `JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id JOIN agency_memberships m ON m.agency_id=s.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=s.agency_id`;
const readJoins = `${joins} ${renewalSourceJoins}`;
const columns = `s.id,s.customer_id customerId,c.display_name customerName,s.branch_id branchId,b.name branchName,s.data_classification dataClassification,s.context_kind context,CASE WHEN s.context_kind='RENEWAL' THEN r.state ELSE s.result END result,s.renewal_id renewalId,s.source_policy_id sourcePolicyId,s.cycle_date cycleDate,s.date_basis dateBasis,s.version,s.created_at createdAt,s.predecessor_case_id predecessorCaseId`;
export async function listSales(db: D1Database, ctx: Ctx, raw: unknown) {
  const active = member(ctx);
  for (const action of ['customer.read', 'quote.read']) {
    const decision = await evaluateAuthorization(db, {
      context: ctx,
      action,
      resource: { agencyId: active.agencyId, isCollection: true },
    });
    if (decision.decision !== 'ALLOW') throw new SalesError('FORBIDDEN', 403);
  }
  const q = salesQuery.parse(raw),
    m = member(ctx),
    g = salesGate(ctx, false, false, true),
    filter = await computePayloadHash({
      q: Object.fromEntries(Object.entries(q).filter(([key]) => key !== 'cursor')),
      agency: m.agencyId,
      member: m.id,
      pver: m.permissionVersion,
      user: ctx.userId,
    });
  const where = ['s.agency_id=?', g.sql, renewalSourceReadGate],
    args: unknown[] = [m.agencyId, ...g.args];
  if (q.customerId) {
    where.push('s.customer_id=?');
    args.push(q.customerId);
  }
  if (q.branchId) {
    where.push('s.branch_id=?');
    args.push(q.branchId);
  }
  if (q.context) {
    where.push('s.context_kind=?');
    args.push(q.context);
  }
  if (q.renewalId) {
    where.push('s.renewal_id=?');
    args.push(q.renewalId);
  }
  if (q.result === 'OPEN')
    where.push(
      "(s.result='OPEN' OR (s.context_kind='RENEWAL' AND r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED') AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL))",
    );
  if (q.cursor) {
    try {
      const c = z
        .tuple([z.literal(filter), z.string().datetime(), z.string().min(1).max(128)])
        .parse(JSON.parse(atob(q.cursor)));
      where.push('(s.created_at>? OR (s.created_at=? AND s.id>?))');
      args.push(c[1], c[1], c[2]);
    } catch {
      throw new SalesError('INVALID_CURSOR', 400);
    }
  }
  const rows = (
    await db.batch<SalesCaseDto>([
      db
        .prepare(
          `SELECT ${columns} FROM sales_cases s ${readJoins} WHERE ${where.join(' AND ')} ORDER BY s.created_at,s.id LIMIT ?`,
        )
        .bind(...args, q.limit + 1),
    ])
  )[0]!.results;
  const items = rows.slice(0, q.limit),
    last = items.at(-1);
  return {
    items,
    hasMore: rows.length > q.limit,
    nextCursor:
      rows.length > q.limit && last
        ? btoa(JSON.stringify([filter, last.createdAt, last.id]))
        : null,
  };
}
export async function salesDetail(db: D1Database, ctx: Ctx, id: string) {
  const m = member(ctx),
    g = salesGate(ctx, false, false, true);
  const r = (
    await db.batch<SalesCaseDto>([
      db
        .prepare(
          `SELECT ${columns} FROM sales_cases s ${readJoins} WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate}`,
        )
        .bind(m.agencyId, id, ...g.args),
    ])
  )[0]!.results[0];
  if (!r) throw new SalesError('NOT_FOUND', 404);
  return r;
}
export async function salesTask(db: D1Database, ctx: Ctx, id: string) {
  await salesDetail(db, ctx, id);
  const m = member(ctx),
    g = salesGate(ctx, false, 'read', true);
  const r = (
    await db.batch<{
      taskId: string;
      taskVersion: number;
      dueAt: string;
      assigneeMembershipId: string;
    }>([
      db
        .prepare(
          `SELECT t.id taskId,t.version taskVersion,t.due_at dueAt,t.assignee_membership_id assigneeMembershipId FROM sales_cases s ${readJoins} JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id AND ((s.context_kind='NEW_BUSINESS' AND t.id=s.active_task_id AND t.kind='GENERAL' AND EXISTS(SELECT 1 FROM sales_case_tasks l WHERE l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=t.id)) OR (s.context_kind='RENEWAL' AND t.renewal_id=r.id AND t.kind='RENEWAL_FOLLOWUP' AND t.assignee_membership_id IS r.assignee_membership_id)) WHERE s.agency_id=? AND s.id=? AND t.status='OPEN' AND (s.result='OPEN' OR (s.context_kind='RENEWAL' AND r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED') AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL)) AND ${g.sql} AND ${renewalSourceReadGate}`,
        )
        .bind(m.agencyId, id, ...g.args),
    ])
  )[0]!.results[0];
  if (!r) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  return r;
}
export async function salesOperation(db: D1Database, ctx: Ctx, id: string, operationId: string) {
  await salesDetail(db, ctx, id);
  const m = member(ctx),
    g = salesGate(ctx, false, 'read', true);
  const rows = (
    await db.batch<{ response_body: string }>([
      db
        .prepare(
          `SELECT o.response_body FROM sales_cases s ${readJoins} JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id JOIN tasks t ON t.agency_id=s.agency_id AND t.id=h.task_id JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=t.id JOIN operation_receipts o ON o.id=h.receipt_id AND o.agency_id=s.agency_id JOIN audit_events ae ON ae.agency_id=s.agency_id AND ae.correlation_id=o.id AND ae.target_id=s.id AND ae.action=o.action AND ae.outcome='SUCCESS' WHERE s.agency_id=? AND s.id=? AND o.id=? AND o.status='COMPLETED' AND o.action IN ('sales.case.create','sales.case.followup','sales.case.adopt') AND ${g.sql} AND ${renewalSourceReadGate}`,
        )
        .bind(m.agencyId, id, operationId, ...g.args),
    ])
  )[0]!.results;
  if (rows.length !== 1) throw new SalesError('NOT_FOUND', 404);
  const saved = salesReceiptSchema.parse(JSON.parse(rows[0]!.response_body));
  const result = salesResultSchema.parse(saved.result);
  if (result.caseId !== id || result.operationId !== operationId)
    throw new SalesError('REPLAY_INVALID', 500);
  return result;
}
async function parent(
  db: D1Database,
  ctx: Ctx,
  customerId: string,
  branchId: string,
  write: boolean,
) {
  const m = member(ctx),
    c = await db
      .prepare(
        'SELECT assignee_membership_id,archived_at FROM customers WHERE agency_id=? AND id=?',
      )
      .bind(m.agencyId, customerId)
      .first<{ assignee_membership_id: string; archived_at: string | null }>();
  if (!c) throw new SalesError('NOT_FOUND', 404);
  for (const action of ['customer.read', 'quote.read', ...(write ? ['quote.manage'] : [])]) {
    const r = await evaluateAuthorization(db, {
      context: ctx,
      action,
      resource: {
        agencyId: m.agencyId,
        assigneeMembershipId: c.assignee_membership_id,
        customerAssigneeMembershipId: c.assignee_membership_id,
      },
    });
    if (r.decision !== 'ALLOW') throw new SalesError('FORBIDDEN', 403);
  }
  const b = await db
    .prepare('SELECT data_classification,status FROM insurance_branches WHERE agency_id=? AND id=?')
    .bind(m.agencyId, branchId)
    .first<{ data_classification: string; status: string }>();
  if (!b) throw new SalesError('BRANCH_NOT_FOUND', 400);
  return { c, b };
}
const assertion = (
  db: D1Database,
  sql: string,
  args: unknown[],
  code = 'MEMBERSHIP_PERMISSION_NOT_FOUND',
) =>
  db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(${sql}) THEN 1 ELSE 0 END,?`,
    )
    .bind(crypto.randomUUID(), ...args, code);
export async function writeSales(
  db: D1Database,
  ctx: Ctx,
  targetId: string,
  kind: 'create' | 'followup',
  raw: unknown,
  key: string,
): Promise<{ data: SalesCommandResult; replayed: boolean }> {
  const input = kind === 'create' ? salesCreateSchema.parse(raw) : salesFollowupSchema.parse(raw),
    m = member(ctx),
    action = `sales.case.${kind}`,
    hash = await computePayloadHash({ action, targetId, input });
  const receipt = await db
    .prepare(
      'SELECT * FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
    )
    .bind(m.agencyId, ctx.userId, key)
    .first<{
      id: string;
      action: string;
      payload_fingerprint: string;
      response_body: string;
      actor_membership_id: string;
      status: string;
      response_status: number;
    }>();
  if (receipt) {
    if (receipt.action !== action || receipt.payload_fingerprint !== hash)
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    const saved = salesReceiptSchema.parse(JSON.parse(receipt.response_body));
    const data = salesResultSchema.parse(saved.result);
    if (
      receipt.actor_membership_id !== m.id ||
      receipt.status !== 'COMPLETED' ||
      receipt.response_status !== (kind === 'create' ? 201 : 200) ||
      saved.targetId !== targetId ||
      (await computePayloadHash({ action, targetId, input: saved.command })) !== hash ||
      data.operationId !== receipt.id
    )
      throw new SalesError('REPLAY_INVALID', 500);
    await salesDetail(db, ctx, data.caseId);
    // A terminal outcome removes the active pointer. Replay proves the original
    // linked Task; it must not require a still-open contact or use its successor.
    const task = await db
      .prepare(
        `SELECT t.version taskVersion FROM tasks t
      JOIN sales_case_tasks l ON l.agency_id=t.agency_id AND l.task_id=t.id
      WHERE t.agency_id=? AND l.case_id=? AND t.id=? AND t.kind='GENERAL'`,
      )
      .bind(m.agencyId, data.caseId, data.taskId)
      .first<{ taskVersion: number }>();
    if (!task || task.taskVersion < data.taskVersion) throw new SalesError('REPLAY_INVALID', 500);
    const g = salesGate(ctx, true, kind === 'create' ? 'create' : 'update');
    const proof = db
      .prepare(
        `SELECT 1 FROM sales_cases s ${joins} JOIN tasks t ON t.agency_id=s.agency_id AND t.id=? JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id AND h.receipt_id=? JOIN audit_events ae ON ae.agency_id=s.agency_id AND ae.correlation_id=? AND ae.action=? AND ae.target_id=s.id AND ae.outcome='SUCCESS' WHERE s.id=? AND ${g.sql} AND h.case_version=? AND h.task_id=t.id AND json_extract(ae.metadata_json,'$.responseHash')=?`,
      )
      .bind(
        data.taskId,
        receipt.id,
        receipt.id,
        action,
        data.caseId,
        ...g.args,
        data.caseVersion,
        await computePayloadHash(data),
      );
    if (!(await db.batch([proof]))[0]!.results.length)
      throw new SalesError('REPLAY_NOT_AUTHORIZED', 403);
    return { data, replayed: true };
  }
  let customerId = targetId,
    branchId: string,
    caseId: string,
    taskId: string,
    caseVersion = 1,
    taskVersion = 1,
    dueAt: string;
  let existing: SalesCaseDto | undefined;
  if (kind === 'create') {
    const c = salesCreateSchema.parse(input);
    branchId = c.branchId;
    dueAt = c.followup.dueAt;
    caseId = crypto.randomUUID();
    taskId = crypto.randomUUID();
  } else {
    const f = salesFollowupSchema.parse(input);
    existing = await salesDetail(db, ctx, targetId);
    if (existing.context !== 'NEW_BUSINESS') throw new SalesError('RENEWAL_USE_EXISTING_WORKFLOW');
    const task = await salesTask(db, ctx, targetId);
    if (
      existing.result !== 'OPEN' ||
      existing.version !== f.expectedCaseVersion ||
      task.taskId !== f.expectedTaskId ||
      task.taskVersion !== f.expectedTaskVersion
    )
      throw new SalesError('CONFLICT');
    customerId = existing.customerId;
    branchId = existing.branchId;
    caseId = targetId;
    taskId = task.taskId;
    caseVersion = existing.version + 1;
    taskVersion = task.taskVersion + 1;
    dueAt = f.dueAt;
  }
  const p = await parent(db, ctx, customerId, branchId, true);
  if (p.c.archived_at || (kind === 'create' && p.b.status !== 'ACTIVE'))
    throw new SalesError('PARENT_NOT_ACTIVE');
  if (kind === 'create' && !salesCreateSchema.parse(input).confirmSimilar) {
    const similar = await listSales(db, ctx, { customerId, branchId, limit: 10 });
    if (similar.items.length) throw new SalesError('SIMILAR_OPEN_CASES');
  }
  const g = salesGate(ctx, true, kind === 'create' ? 'create' : 'update'),
    now = new Date().toISOString(),
    operationId = crypto.randomUUID();
  const data: SalesCommandResult = { operationId, caseId, caseVersion, taskId, taskVersion, dueAt };
  const statements: D1PreparedStatement[] = [];
  // A proposed row is server-owned; it binds real parent records and the active creator's Task.
  const authority =
    kind === 'create'
      ? `SELECT 1 FROM (SELECT ? agency_id,? customer_id,? branch_id,? data_classification) s ${joins} JOIN (SELECT ? assignee_membership_id) t WHERE s.agency_id=? AND c.archived_at IS NULL AND b.status='ACTIVE' AND b.data_classification=? AND ${g.sql}`
      : `SELECT 1 FROM sales_cases s ${joins} JOIN tasks t ON t.agency_id=s.agency_id AND t.id=s.active_task_id WHERE s.agency_id=? AND s.id=? AND c.archived_at IS NULL AND ${g.sql}`;
  statements.push(
    assertion(
      db,
      authority,
      kind === 'create'
        ? [
            m.agencyId,
            customerId,
            branchId,
            p.b.data_classification,
            m.id,
            m.agencyId,
            p.b.data_classification,
            ...g.args,
          ]
        : [m.agencyId, caseId, ...g.args],
    ),
  );
  if (kind === 'create') {
    const c = salesCreateSchema.parse(input);
    statements.push(
      db
        .prepare(
          "INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES(?,?,?,'GENERAL','Teklif çalışması',?,?,'USER',?,?,?,?)",
        )
        .bind(taskId, m.agencyId, customerId, dueAt, m.id, ctx.userId, m.id, now, now),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO sales_cases(id,agency_id,customer_id,branch_id,data_classification,context_kind,cycle_date,date_basis,result,active_task_id,created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES(?,?,?,?,?,'NEW_BUSINESS',?,?,'OPEN',?,?,?,?,?)",
        )
        .bind(
          caseId,
          m.agencyId,
          customerId,
          branchId,
          p.b.data_classification,
          c.cycleDate,
          c.dateBasis,
          taskId,
          ctx.userId,
          m.id,
          now,
          now,
        ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO sales_case_tasks(id,agency_id,case_id,task_id,purpose,created_at) VALUES(?,?,?,?,'ACTIVE_CONTACT',?)",
        )
        .bind(crypto.randomUUID(), m.agencyId, caseId, taskId, now),
    );
  } else {
    const f = salesFollowupSchema.parse(input);
    statements.push(
      db
        .prepare(
          "UPDATE tasks SET due_at=?,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND status='OPEN' AND kind='GENERAL'",
        )
        .bind(dueAt, now, m.agencyId, taskId, f.expectedTaskVersion),
      db
        .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
        .bind(crypto.randomUUID()),
    );
    statements.push(
      db
        .prepare(
          "UPDATE sales_cases SET version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND result='OPEN' AND active_task_id=?",
        )
        .bind(now, m.agencyId, caseId, f.expectedCaseVersion, taskId),
      db
        .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
        .bind(crypto.randomUUID()),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)",
      )
      .bind(
        operationId,
        m.agencyId,
        ctx.userId,
        m.id,
        action,
        key,
        hash,
        kind === 'create' ? 201 : 200,
        JSON.stringify({ result: data, command: input, targetId }),
        now,
        now,
      ),
  );
  const follow = kind === 'followup' ? salesFollowupSchema.parse(input) : null;
  statements.push(
    db
      .prepare(
        'INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,reason_code,notes,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        m.agencyId,
        caseId,
        caseVersion,
        kind === 'create' ? 'CREATED' : 'RESCHEDULED',
        taskId,
        follow?.reasonCode ?? null,
        follow?.notes ?? null,
        ctx.userId,
        m.id,
        operationId,
        now,
      ),
  );
  const audit = buildSafeAuditRecord({
    agencyId: m.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: m.id,
    action,
    targetType: 'sales_cases',
    targetId: caseId,
    correlationId: operationId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    metadata: { responseHash: await computePayloadHash(data) },
    createdAt: now,
  });
  statements.push(
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
  );
  try {
    await db.batch(statements);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('operation_receipts') && msg.includes('UNIQUE'))
      return writeSales(db, ctx, targetId, kind, raw, key);
    if (/MEMBERSHIP_PERMISSION|LOCAL_SESSION/.test(msg)) throw new SalesError('FORBIDDEN', 403);
    if (/OPTIMISTIC|SALES_CASE_INVALID/.test(msg)) {
      if (
        await db
          .prepare(
            'SELECT id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
          )
          .bind(m.agencyId, ctx.userId, key)
          .first()
      )
        return writeSales(db, ctx, targetId, kind, raw, key);
      await parent(db, ctx, customerId, branchId, true);
      throw new SalesError('CONFLICT');
    }
    throw e;
  }
  return { data, replayed: false };
}
