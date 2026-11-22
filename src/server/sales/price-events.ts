import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { member, salesGate, SalesError } from './service';
import { renewalSourceJoins, renewalSourceReadGate } from './renewal-source';
import {
  salesPriceEventCommandSchema,
  salesPriceEventResultSchema,
  salesPriceEventReceiptSchema,
} from '../../shared/sales-price-events';

type Ctx = AuthenticatedUserContext;
type EventCode = 'SHARED' | 'CUSTOMER_ACCEPTED' | 'ACCEPTANCE_REVOKED';
type Result = z.infer<typeof salesPriceEventResultSchema>;
const action = 'sales.price.event';
const joins = `FROM sales_cases s JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
 JOIN agency_memberships m ON m.agency_id=s.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
 ${renewalSourceJoins}`;
const writable = `c.archived_at IS NULL AND ((s.context_kind='NEW_BUSINESS' AND s.result='OPEN') OR
 (s.context_kind='RENEWAL' AND r.state NOT IN ('WON','LOST','VOIDED') AND r.closed_at IS NULL AND p.status='ACTIVE' AND p.archived_at IS NULL))`;
const currentTask = `t.status='OPEN' AND ((s.context_kind='NEW_BUSINESS' AND t.kind='GENERAL' AND t.id=s.active_task_id AND t.renewal_id IS NULL AND t.policy_id IS NULL
 AND EXISTS(SELECT 1 FROM sales_case_tasks l WHERE l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=t.id))
 OR(s.context_kind='RENEWAL' AND t.kind='RENEWAL_FOLLOWUP' AND t.renewal_id=r.id AND t.assignee_membership_id IS r.assignee_membership_id))`;
const historicalTask = `((s.context_kind='NEW_BUSINESS' AND t.kind='GENERAL' AND t.renewal_id IS NULL AND t.policy_id IS NULL
 AND EXISTS(SELECT 1 FROM sales_case_tasks l WHERE l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=t.id))
 OR(s.context_kind='RENEWAL' AND t.kind='RENEWAL_FOLLOWUP' AND t.renewal_id=r.id))`;
const interactionGate = `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x
 JOIN membership_permissions dependency ON dependency.membership_id=x.membership_id AND dependency.permission_code='interaction.read'
 WHERE x.membership_id=m.id AND x.permission_code='interaction.create' AND (dependency.scope='AGENCY' OR dependency.scope=x.scope)
 AND(x.scope='AGENCY' OR(x.scope='ASSIGNED' AND(c.assignee_membership_id=m.id OR(s.context_kind='RENEWAL' AND r.assignee_membership_id=m.id))))))`;
interface RevisionRow {
  caseVersion: number;
  currentRevisionId: string;
  priceId: string;
  context: 'NEW_BUSINESS' | 'RENEWAL';
  writable: number;
}
interface TaskRow extends RevisionRow {
  taskId: string;
  taskVersion: number;
  interactionAllowed: number;
}
function gate(ctx: Ctx, write = false, task = false, event?: EventCode) {
  const g = salesGate(ctx, write, task ? 'read' : false, true);
  return {
    ...g,
    sql: `${g.sql} AND ${renewalSourceReadGate}${event && event !== 'SHARED' ? ` AND ${interactionGate}` : ''}`,
  };
}
async function revision(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  revisionId: string,
  write = false,
) {
  const g = gate(ctx, write),
    m = member(ctx);
  const row = (
    await db.batch<RevisionRow>([
      db
        .prepare(
          `SELECT s.version caseVersion,s.context_kind context,sp.id priceId,sp.current_revision_id currentRevisionId,CASE WHEN ${writable} THEN 1 ELSE 0 END writable
     ${joins} JOIN sales_prices sp ON sp.agency_id=s.agency_id AND sp.case_id=s.id
     JOIN sales_price_revisions v ON v.agency_id=sp.agency_id AND v.price_id=sp.id
     WHERE s.agency_id=? AND s.id=? AND v.id=? AND ${g.sql}`,
        )
        .bind(m.agencyId, caseId, revisionId, ...g.args),
    ])
  )[0]!.results[0];
  if (!row) throw new SalesError('NOT_FOUND', 404);
  return { row, g, m };
}
async function taskRevision(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  revisionId: string,
  options: { write: boolean; taskId?: string; historical?: boolean; event?: EventCode },
) {
  const g = gate(ctx, options.write, true, options.event),
    m = member(ctx),
    args: unknown[] = [m.agencyId, caseId, revisionId, ...g.args];
  if (options.taskId) args.push(options.taskId);
  const rows = (
    await db.batch<TaskRow>([
      db
        .prepare(
          `SELECT s.version caseVersion,s.context_kind context,sp.id priceId,sp.current_revision_id currentRevisionId,
      CASE WHEN ${writable} THEN 1 ELSE 0 END writable,t.id taskId,t.version taskVersion,CASE WHEN ${interactionGate} THEN 1 ELSE 0 END interactionAllowed
     ${joins} JOIN sales_prices sp ON sp.agency_id=s.agency_id AND sp.case_id=s.id
     JOIN sales_price_revisions v ON v.agency_id=sp.agency_id AND v.price_id=sp.id
     JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id
     WHERE s.agency_id=? AND s.id=? AND v.id=? AND ${g.sql} ${options.taskId ? 'AND t.id=?' : ''}
      AND ${options.historical ? historicalTask : currentTask} LIMIT 2`,
        )
        .bind(...args),
    ])
  )[0]!.results;
  if (rows.length !== 1) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  return { row: rows[0]!, g, m };
}
interface EventRow {
  eventId: string;
  revisionId: string;
  event: EventCode;
  occurredAt: string;
  createdAt: string;
  caseVersion: number;
}
const eventColumns = `e.id eventId,e.revision_id revisionId,e.event_code event,e.occurred_at occurredAt,e.created_at createdAt,e.case_version caseVersion`;
async function latest(db: D1Database, agencyId: string, caseId: string, revisionId: string) {
  return db
    .prepare(
      'SELECT event_code,occurred_at,case_version FROM sales_price_events WHERE agency_id=? AND case_id=? AND revision_id=? ORDER BY case_version DESC LIMIT 1',
    )
    .bind(agencyId, caseId, revisionId)
    .first<{ event_code: EventCode; occurred_at: string; case_version: number }>();
}
function allowed(last: EventCode | null): EventCode[] {
  return last === null
    ? ['SHARED']
    : last === 'SHARED' || last === 'ACCEPTANCE_REVOKED'
      ? ['CUSTOMER_ACCEPTED']
      : ['ACCEPTANCE_REVOKED'];
}
export async function readSalesPriceEventContext(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  revisionId: string,
) {
  const { row, m } = await taskRevision(db, ctx, caseId, revisionId, { write: true });
  if (!row.writable || row.currentRevisionId !== revisionId) throw new SalesError('CONFLICT');
  const previous = await latest(db, m.agencyId, caseId, revisionId);
  return {
    taskId: row.taskId,
    taskVersion: row.taskVersion,
    caseVersion: row.caseVersion,
    revisionId,
    allowedEvents: allowed(previous?.event_code ?? null).filter(
      (e) => e === 'SHARED' || row.interactionAllowed === 1,
    ),
  };
}
const querySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1600).optional(),
});
export async function readSalesPriceEvents(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  revisionId: string,
  raw: unknown = {},
) {
  const { g, m } = await revision(db, ctx, caseId, revisionId),
    q = querySchema.parse(raw),
    binding = await computePayloadHash({
      agency: m.agencyId,
      member: m.id,
      user: ctx.userId,
      pver: m.permissionVersion,
      caseId,
      revisionId,
      limit: q.limit,
    });
  let version: number | null = null;
  if (q.cursor) {
    try {
      version = z
        .tuple([z.literal(binding), z.number().int().positive().safe()])
        .parse(JSON.parse(atob(q.cursor)))[1];
    } catch {
      throw new SalesError('INVALID_CURSOR', 400);
    }
  }
  const args: unknown[] = [m.agencyId, caseId, revisionId, ...g.args];
  if (version !== null) args.push(version);
  const rows = (
    await db.batch<EventRow>([
      db
        .prepare(
          `SELECT ${eventColumns} ${joins} JOIN sales_price_events e ON e.agency_id=s.agency_id AND e.case_id=s.id
     WHERE s.agency_id=? AND s.id=? AND e.revision_id=? AND ${g.sql} ${version !== null ? 'AND e.case_version<?' : ''} ORDER BY e.case_version DESC LIMIT ?`,
        )
        .bind(...args, q.limit + 1),
    ])
  )[0]!.results;
  const events = rows.slice(0, q.limit),
    hasMore = rows.length > q.limit;
  return {
    events,
    hasMore,
    nextCursor: hasMore ? btoa(JSON.stringify([binding, events.at(-1)!.caseVersion])) : null,
  };
}
async function operation(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  operationId: string,
  write = false,
) {
  const m = member(ctx);
  const record = await db
    .prepare(
      "SELECT response_body FROM operation_receipts WHERE agency_id=? AND id=? AND action=? AND status='COMPLETED'",
    )
    .bind(m.agencyId, operationId, action)
    .first<{ response_body: string }>();
  if (!record) throw new SalesError('NOT_FOUND', 404);
  const saved = salesPriceEventReceiptSchema.parse(JSON.parse(record.response_body)),
    r = saved.result,
    c = saved.command;
  if (
    saved.targetId !== caseId ||
    r.caseId !== caseId ||
    r.operationId !== operationId ||
    r.caseVersion !== c.expectedCaseVersion + 1 ||
    r.revisionId !== c.revisionId ||
    r.event !== c.event ||
    r.occurredAt !== c.occurredAt
  )
    throw new SalesError('REPLAY_INVALID', 500);
  const { row, g } = await taskRevision(db, ctx, caseId, c.revisionId, {
    write,
    taskId: c.expectedTaskId,
    historical: true,
    event: write ? c.event : undefined,
  });
  if (row.taskVersion < c.expectedTaskVersion) throw new SalesError('REPLAY_INVALID', 500);
  const proof = (
    await db.batch<{
      fingerprint: string;
      responseHash: string;
      actorUserId: string;
      actorMembershipId: string;
    }>([
      db
        .prepare(
          `SELECT o.payload_fingerprint fingerprint,json_extract(ae.metadata_json,'$.responseHash') responseHash,o.actor_user_id actorUserId,o.actor_membership_id actorMembershipId
     ${joins} JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id
     JOIN sales_price_events e ON e.agency_id=s.agency_id AND e.case_id=s.id AND e.task_id=t.id
     JOIN operation_receipts o ON o.agency_id=e.agency_id AND o.id=e.receipt_id
     JOIN sales_case_history h ON h.agency_id=e.agency_id AND h.case_id=e.case_id AND h.receipt_id=o.id AND h.case_version=e.case_version AND h.task_id=t.id
     JOIN audit_events ae ON ae.agency_id=o.agency_id AND ae.correlation_id=o.id AND ae.action=o.action AND ae.target_type='sales_cases' AND ae.target_id=s.id
       AND ae.actor_user_id=o.actor_user_id AND ae.actor_membership_id=o.actor_membership_id AND ae.idempotency_key=o.idempotency_key AND ae.outcome='SUCCESS'
     WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${historicalTask} AND o.id=? AND o.action=? AND o.status='COMPLETED' AND o.response_status=201
       AND e.id=? AND e.revision_id=? AND e.case_version=? AND e.event_code=? AND e.occurred_at=? AND e.task_id=? AND e.task_version=?
       AND h.event_code=? AND h.actor_user_id=o.actor_user_id AND h.actor_membership_id=o.actor_membership_id
       AND e.actor_user_id=o.actor_user_id AND e.actor_membership_id=o.actor_membership_id`,
        )
        .bind(
          m.agencyId,
          caseId,
          ...g.args,
          operationId,
          action,
          r.eventId,
          r.revisionId,
          r.caseVersion,
          r.event,
          r.occurredAt,
          c.expectedTaskId,
          c.expectedTaskVersion,
          historyCode(r.event),
        ),
    ])
  )[0]!.results;
  if (
    proof.length !== 1 ||
    proof[0]!.responseHash !== (await computePayloadHash(r)) ||
    proof[0]!.fingerprint !== (await computePayloadHash({ action, targetId: caseId, input: c }))
  )
    throw new SalesError('REPLAY_INVALID', 500);
  return { saved, proof: proof[0]! };
}
function historyCode(e: EventCode) {
  return e === 'SHARED'
    ? 'PRICE_SHARED'
    : e === 'CUSTOMER_ACCEPTED'
      ? 'PRICE_ACCEPTED'
      : 'PRICE_ACCEPTANCE_REVOKED';
}
export async function readSalesPriceEventOperation(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  operationId: string,
) {
  return (await operation(db, ctx, caseId, operationId)).saved.result;
}
export async function writeSalesPriceEvent(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  raw: unknown,
  key: string,
): Promise<{ data: Result; replayed: boolean }> {
  const input = salesPriceEventCommandSchema.parse(raw),
    m = member(ctx),
    hash = await computePayloadHash({ action, targetId: caseId, input });
  const receipt = await db
    .prepare(
      'SELECT id,action,payload_fingerprint,actor_membership_id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
    )
    .bind(m.agencyId, ctx.userId, key)
    .first<{
      id: string;
      action: string;
      payload_fingerprint: string;
      actor_membership_id: string;
    }>();
  if (receipt) {
    if (receipt.action !== action || receipt.payload_fingerprint !== hash)
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    const prior = await operation(db, ctx, caseId, receipt.id, true);
    if (
      receipt.actor_membership_id !== m.id ||
      prior.proof.actorUserId !== ctx.userId ||
      prior.proof.actorMembershipId !== m.id
    )
      throw new SalesError('REPLAY_INVALID', 500);
    return { data: prior.saved.result, replayed: true };
  }
  const { row, g } = await taskRevision(db, ctx, caseId, input.revisionId, {
    write: true,
    taskId: input.expectedTaskId,
    event: input.event,
  });
  if (
    !row.writable ||
    row.currentRevisionId !== input.revisionId ||
    row.caseVersion !== input.expectedCaseVersion ||
    row.taskVersion !== input.expectedTaskVersion
  )
    throw new SalesError('CONFLICT');
  const now = new Date().toISOString();
  if (input.occurredAt > now) throw new SalesError('EVENT_DATE_INVALID', 400);
  const previous = await latest(db, m.agencyId, caseId, input.revisionId);
  if (
    !allowed(previous?.event_code ?? null).includes(input.event) ||
    (previous && input.occurredAt < previous.occurred_at)
  )
    throw new SalesError('EVENT_STATE_CONFLICT');
  const operationId = crypto.randomUUID(),
    eventId = crypto.randomUUID(),
    data = salesPriceEventResultSchema.parse({
      operationId,
      caseId,
      caseVersion: input.expectedCaseVersion + 1,
      eventId,
      revisionId: input.revisionId,
      event: input.event,
      occurredAt: input.occurredAt,
    });
  const source = `${joins} JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id
    JOIN sales_prices sp ON sp.agency_id=s.agency_id AND sp.case_id=s.id AND sp.current_revision_id=?`;
  const authority = `s.agency_id=? AND s.id=? AND t.id=? AND ${g.sql}`;
  const parameters = [input.revisionId, m.agencyId, caseId, input.expectedTaskId, ...g.args];
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${source} WHERE ${authority}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
      )
      .bind(crypto.randomUUID(), ...parameters),
    db
      .prepare(
        `UPDATE sales_cases SET version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND EXISTS(
     SELECT 1 ${source} WHERE ${authority} AND ${writable} AND ${currentTask} AND s.version=? AND t.version=?
      AND coalesce((SELECT event_code FROM sales_price_events previous WHERE previous.agency_id=s.agency_id AND previous.case_id=s.id AND previous.revision_id=? ORDER BY case_version DESC LIMIT 1),'NONE')=?
      AND coalesce((SELECT occurred_at FROM sales_price_events previous WHERE previous.agency_id=s.agency_id AND previous.case_id=s.id AND previous.revision_id=? ORDER BY case_version DESC LIMIT 1),'')<=?)`,
      )
      .bind(
        now,
        m.agencyId,
        caseId,
        input.expectedCaseVersion,
        ...parameters,
        input.expectedCaseVersion,
        input.expectedTaskVersion,
        input.revisionId,
        previous?.event_code ?? 'NONE',
        input.revisionId,
        input.occurredAt,
      ),
    db
      .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
      .bind(crypto.randomUUID()),
    db
      .prepare(
        "INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'COMPLETED',201,?,?,?)",
      )
      .bind(
        operationId,
        m.agencyId,
        ctx.userId,
        m.id,
        action,
        key,
        hash,
        JSON.stringify({ result: data, command: input, targetId: caseId }),
        now,
        now,
      ),
    db
      .prepare(
        'INSERT INTO sales_price_events(id,agency_id,case_id,revision_id,case_version,event_code,occurred_at,task_id,task_version,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        eventId,
        m.agencyId,
        caseId,
        input.revisionId,
        data.caseVersion,
        input.event,
        input.occurredAt,
        input.expectedTaskId,
        input.expectedTaskVersion,
        ctx.userId,
        m.id,
        operationId,
        now,
      ),
    db
      .prepare(
        'INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        m.agencyId,
        caseId,
        data.caseVersion,
        historyCode(input.event),
        input.expectedTaskId,
        ctx.userId,
        m.id,
        operationId,
        now,
      ),
  ];
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
  } catch (error) {
    const msg = String(error);
    if (/MEMBERSHIP_PERMISSION|LOCAL_SESSION/.test(msg)) throw new SalesError('FORBIDDEN', 403);
    if (/UNIQUE|OPTIMISTIC|SALES_PRICE_EVENT|SALES_CASE_INVALID/.test(msg)) {
      try {
        await taskRevision(db, ctx, caseId, input.revisionId, {
          write: true,
          taskId: input.expectedTaskId,
          historical: true,
          event: input.event,
        });
      } catch {
        throw new SalesError('FORBIDDEN', 403);
      }
      const committed = await db
        .prepare(
          'SELECT id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
        )
        .bind(m.agencyId, ctx.userId, key)
        .first();
      if (committed) return writeSalesPriceEvent(db, ctx, caseId, raw, key);
      throw new SalesError('CONFLICT');
    }
    throw error;
  }
  return { data, replayed: false };
}
