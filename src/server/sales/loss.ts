import { member, salesGate, SalesError, salesDetail } from './service';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { istanbulToday } from '../../shared/customer-profile';
import {
  salesLossCommandSchema,
  salesLossReceiptSchema,
  salesLossResultSchema,
  type SalesLossResult,
} from '../../shared/sales-loss';
const action = 'sales.case.close_lost';
const joins = `FROM sales_cases s JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=s.customer_id
 JOIN agency_memberships m ON m.agency_id=s.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;
const linked = `s.context_kind='NEW_BUSINESS' AND t.kind='GENERAL' AND t.policy_id IS NULL AND t.renewal_id IS NULL
 AND EXISTS(SELECT 1 FROM sales_case_tasks l WHERE l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=t.id)`;
const createGate = `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions mp WHERE mp.membership_id=m.id AND mp.permission_code='task.create' AND mp.scope='UNSCOPED'))`;
type Ctx = AuthenticatedUserContext;
interface Source {
  caseVersion: number;
  customerId: string;
  branchId: string;
  classification: 'GENERAL' | 'HEALTH';
  cycleDate: string | null;
  result: string;
  activeTaskId: string | null;
  taskId: string;
  taskVersion: number;
  taskStatus: string;
  branchStatus: string;
  archived: string | null;
  canCreate: number;
}
async function source(db: D1Database, ctx: Ctx, caseId: string, taskId?: string, write = false) {
  const m = member(ctx),
    g = salesGate(ctx, write, write ? 'update' : 'read');
  const rows = (
    await db.batch<Source>([
      db
        .prepare(
          `SELECT s.version caseVersion,s.customer_id customerId,s.branch_id branchId,
 CASE WHEN s.data_classification='HEALTH' OR b.data_classification='HEALTH' THEN 'HEALTH' ELSE 'GENERAL' END classification,
 s.cycle_date cycleDate,s.result,s.active_task_id activeTaskId,t.id taskId,t.version taskVersion,t.status taskStatus,b.status branchStatus,c.archived_at archived,
 CASE WHEN ${createGate} THEN 1 ELSE 0 END canCreate ${joins}
 WHERE s.agency_id=? AND s.id=? AND ${linked} AND ${g.sql} AND t.id=${taskId ? '?' : 's.active_task_id'} LIMIT 2`,
        )
        .bind(m.agencyId, caseId, ...g.args, ...(taskId ? [taskId] : [])),
    ])
  )[0]!.results;
  if (rows.length !== 1) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  return { row: rows[0]!, m, g };
}
export async function salesLossContext(db: D1Database, ctx: Ctx, caseId: string) {
  const { row, m } = await source(db, ctx, caseId, undefined, true);
  if (row.result !== 'OPEN' || row.taskStatus !== 'OPEN' || row.archived)
    throw new SalesError('CONFLICT');
  const reasons = (
    await db
      .prepare(
        "SELECT id,name,code FROM loss_reasons WHERE agency_id=? AND status='ACTIVE' ORDER BY name,id LIMIT 1001",
      )
      .bind(m.agencyId)
      .all()
  ).results;
  if (reasons.length > 1000) throw new SalesError('CATALOG_LIMIT', 400);
  const settings = await db
    .prepare('SELECT renewal_window_days days FROM agency_settings WHERE agency_id=?')
    .bind(m.agencyId)
    .first<{ days: number }>();
  return {
    caseId,
    caseVersion: row.caseVersion,
    taskId: row.taskId,
    taskVersion: row.taskVersion,
    cycleDate: row.cycleDate,
    renewalWindowDays: settings?.days ?? 30,
    canCreateFollowup: row.canCreate === 1 && row.branchStatus === 'ACTIVE',
    lossReasons: reasons,
  };
}
/** Public outcome omits private Task identities and the receipt command. */
export async function salesLossSummary(db: D1Database, ctx: Ctx, caseId: string) {
  await salesDetail(db, ctx, caseId);
  const m = member(ctx),
    g = salesGate(ctx);
  return (
    (
      await db.batch([
        db
          .prepare(
            `SELECT r.id resultRevisionId,l.name reason,l.code reasonCode,r.notes,r.created_at closedAt,r.followup_case_id followupCaseId,r.exception_code exceptionCode
 FROM sales_cases s JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
 JOIN agency_memberships m ON m.agency_id=s.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
 JOIN sales_case_result_revisions r ON r.agency_id=s.agency_id AND r.case_id=s.id AND r.id=s.current_result_id JOIN loss_reasons l ON l.agency_id=r.agency_id AND l.id=r.loss_reason_id
 WHERE s.agency_id=? AND s.id=? AND r.kind='LOST' AND ${g.sql}`,
          )
          .bind(m.agencyId, caseId, ...g.args),
      ])
    )[0]!.results[0] ?? null
  );
}
export async function readSalesLossOperation(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  operationId: string,
  write = false,
) {
  const m = member(ctx);
  const receipt = await db
    .prepare(
      "SELECT response_body,payload_fingerprint,actor_user_id,actor_membership_id FROM operation_receipts WHERE agency_id=? AND id=? AND action=? AND status='COMPLETED' AND response_status=200",
    )
    .bind(m.agencyId, operationId, action)
    .first<{
      response_body: string;
      payload_fingerprint: string;
      actor_user_id: string;
      actor_membership_id: string;
    }>();
  if (!receipt) throw new SalesError('NOT_FOUND', 404);
  const saved = salesLossReceiptSchema.parse(JSON.parse(receipt.response_body)),
    r = saved.result,
    c = saved.command;
  if (
    saved.targetId !== caseId ||
    r.caseId !== caseId ||
    r.operationId !== operationId ||
    r.caseVersion !== c.expectedCaseVersion + 1 ||
    r.taskId !== c.expectedTaskId ||
    r.taskVersion !== c.expectedTaskVersion + 1
  )
    throw new SalesError('REPLAY_INVALID', 500);
  const { row, g } = await source(db, ctx, caseId, r.taskId, write);
  if (write && c.nextCycle.mode === 'FOLLOW_UP' && !row.canCreate)
    throw new SalesError('FORBIDDEN', 403);
  if (
    row.caseVersion < r.caseVersion ||
    row.taskVersion < r.taskVersion ||
    row.taskStatus !== 'COMPLETED'
  )
    throw new SalesError('REPLAY_INVALID', 500);
  const proof = (
    await db.batch<{ fingerprint: string; responseHash: string }>([
      db
        .prepare(
          `SELECT o.payload_fingerprint fingerprint,json_extract(ae.metadata_json,'$.responseHash') responseHash ${joins}
 JOIN sales_case_result_revisions rev ON rev.agency_id=s.agency_id AND rev.case_id=s.id AND rev.task_id=t.id
 JOIN operation_receipts o ON o.id=rev.receipt_id
 JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id AND h.receipt_id=o.id AND h.case_version=rev.case_version AND h.event_code='LOST'
 JOIN audit_events ae ON ae.agency_id=s.agency_id AND ae.correlation_id=o.id AND ae.action=o.action AND ae.target_type='sales_cases' AND ae.target_id=s.id AND ae.outcome='SUCCESS'
 WHERE s.agency_id=? AND s.id=? AND t.id=? AND ${linked} AND ${g.sql} AND rev.id=? AND rev.kind='LOST' AND rev.receipt_id=? AND rev.case_version=? AND rev.task_version=?
 AND rev.loss_reason_id=? AND rev.notes IS ? AND rev.followup_case_id IS ? AND rev.exception_code IS ? AND rev.created_at=?
 AND rev.actor_user_id=o.actor_user_id AND rev.actor_membership_id=o.actor_membership_id AND h.actor_user_id=o.actor_user_id AND h.actor_membership_id=o.actor_membership_id
 AND h.task_id=t.id AND h.notes IS rev.notes AND h.created_at=rev.created_at AND ae.actor_user_id=o.actor_user_id AND ae.actor_membership_id=o.actor_membership_id AND ae.idempotency_key=o.idempotency_key`,
        )
        .bind(
          m.agencyId,
          caseId,
          r.taskId,
          ...g.args,
          r.resultRevisionId,
          operationId,
          r.caseVersion,
          r.taskVersion,
          c.lossReasonId,
          c.notes,
          r.followup?.caseId ?? null,
          c.nextCycle.mode === 'NO_FOLLOW_UP' ? c.nextCycle.exceptionCode : null,
          r.closedAt,
        ),
    ])
  )[0]!.results;
  if (
    proof.length !== 1 ||
    proof[0]!.fingerprint !== (await computePayloadHash({ action, targetId: caseId, input: c })) ||
    proof[0]!.responseHash !== (await computePayloadHash(r))
  )
    throw new SalesError('REPLAY_INVALID', 500);
  if (r.followup) {
    const child = await source(db, ctx, r.followup.caseId, r.followup.taskId, false);
    if (child.row.taskVersion < 1) throw new SalesError('REPLAY_INVALID', 500);
    const h = await db
      .prepare(
        `SELECT 1 FROM sales_cases child JOIN sales_case_tasks link ON link.agency_id=child.agency_id AND link.case_id=child.id AND link.task_id=? AND link.purpose='NEXT_CYCLE'
   JOIN sales_case_history h ON h.agency_id=child.agency_id AND h.case_id=child.id AND h.case_version=1 AND h.receipt_id=? AND h.event_code='CREATED_NEXT_CYCLE' AND h.task_id=link.task_id
   WHERE child.agency_id=? AND child.id=? AND child.predecessor_case_id=? AND child.origin_result_revision_id=? AND child.cycle_date IS ? AND child.date_basis=?`,
      )
      .bind(
        r.followup.taskId,
        operationId,
        m.agencyId,
        r.followup.caseId,
        caseId,
        r.resultRevisionId,
        r.followup.cycleDate,
        r.followup.dateBasis,
      )
      .first();
    if (!h) throw new SalesError('REPLAY_INVALID', 500);
  }
  return {
    saved,
    actorUserId: receipt.actor_user_id,
    actorMembershipId: receipt.actor_membership_id,
  };
}
export async function closeSalesLost(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  raw: unknown,
  key: string,
): Promise<{ data: SalesLossResult; replayed: boolean }> {
  const input = salesLossCommandSchema.parse(raw),
    m = member(ctx),
    hash = await computePayloadHash({ action, targetId: caseId, input });
  const prior = await db
    .prepare(
      'SELECT id,action,payload_fingerprint FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
    )
    .bind(m.agencyId, ctx.userId, key)
    .first<{ id: string; action: string; payload_fingerprint: string }>();
  if (prior) {
    if (prior.action !== action || prior.payload_fingerprint !== hash)
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    const saved = await readSalesLossOperation(db, ctx, caseId, prior.id, true);
    if (saved.actorUserId !== ctx.userId || saved.actorMembershipId !== m.id)
      throw new SalesError('FORBIDDEN', 403);
    return { data: saved.saved.result, replayed: true };
  }
  const { row, g } = await source(db, ctx, caseId, input.expectedTaskId, true),
    next = input.nextCycle,
    now = new Date().toISOString();
  if (
    row.result !== 'OPEN' ||
    row.taskStatus !== 'OPEN' ||
    row.activeTaskId !== input.expectedTaskId ||
    row.caseVersion !== input.expectedCaseVersion ||
    row.taskVersion !== input.expectedTaskVersion ||
    row.archived
  )
    throw new SalesError('CONFLICT');
  if (next.mode === 'FOLLOW_UP') {
    if (!row.canCreate) throw new SalesError('FORBIDDEN', 403);
    if (row.branchStatus !== 'ACTIVE') throw new SalesError('PARENT_NOT_ACTIVE');
    if (
      next.dueAt <= now ||
      (next.cycleDate &&
        (next.cycleDate < istanbulToday() || (row.cycleDate && next.cycleDate <= row.cycleDate)))
    )
      throw new SalesError('NEXT_CYCLE_DATE_INVALID', 400);
  }
  const reason = await db
    .prepare("SELECT code FROM loss_reasons WHERE agency_id=? AND id=? AND status='ACTIVE'")
    .bind(m.agencyId, input.lossReasonId)
    .first<{ code: string }>();
  if (!reason) throw new SalesError('LOSS_REASON_INVALID', 400);
  const operationId = crypto.randomUUID(),
    revisionId = crypto.randomUUID(),
    childId = next.mode === 'FOLLOW_UP' ? crypto.randomUUID() : null,
    newTaskId = childId ? crypto.randomUUID() : null;
  const data = salesLossResultSchema.parse({
    operationId,
    caseId,
    caseVersion: input.expectedCaseVersion + 1,
    resultRevisionId: revisionId,
    taskId: row.taskId,
    taskVersion: row.taskVersion + 1,
    closedAt: now,
    followup:
      next.mode === 'FOLLOW_UP'
        ? {
            caseId: childId,
            caseVersion: 1,
            taskId: newTaskId,
            taskVersion: 1,
            dueAt: next.dueAt,
            cycleDate: next.cycleDate,
            dateBasis: next.dateBasis,
          }
        : null,
  });
  const authority = `s.agency_id=? AND s.id=? AND t.id=? AND ${linked} AND ${g.sql}${next.mode === 'FOLLOW_UP' ? ` AND ${createGate}` : ''}`;
  const args = [m.agencyId, caseId, row.taskId, ...g.args];
  const changed = () =>
    db
      .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
      .bind(crypto.randomUUID());
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${joins} WHERE ${authority}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
      )
      .bind(crypto.randomUUID(), ...args),
    db
      .prepare(
        "INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)",
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
        `INSERT INTO sales_case_result_revisions(id,agency_id,case_id,result_no,kind,case_version,task_id,task_version,loss_reason_id,notes,followup_case_id,exception_code,receipt_id,actor_user_id,actor_membership_id,created_at)
         VALUES(?,?,?,(SELECT COALESCE(MAX(result_no),0)+1 FROM sales_case_result_revisions WHERE agency_id=? AND case_id=?),'LOST',?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        revisionId,
        m.agencyId,
        caseId,
        m.agencyId,
        caseId,
        data.caseVersion,
        row.taskId,
        data.taskVersion,
        input.lossReasonId,
        input.notes,
        childId,
        next.mode === 'NO_FOLLOW_UP' ? next.exceptionCode : null,
        operationId,
        ctx.userId,
        m.id,
        now,
      ),
    db
      .prepare(
        `UPDATE sales_cases SET result='LOST',active_task_id=NULL,current_result_id=?,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND result='OPEN' AND active_task_id=? AND EXISTS(SELECT 1 ${joins} WHERE ${authority} AND s.current_result_id IS NULL AND c.archived_at IS NULL AND t.status='OPEN' AND t.version=? ${next.mode === 'FOLLOW_UP' ? "AND b.status='ACTIVE'" : ''})`,
      )
      .bind(
        revisionId,
        now,
        m.agencyId,
        caseId,
        input.expectedCaseVersion,
        row.taskId,
        ...args,
        input.expectedTaskVersion,
      ),
    changed(),
    db
      .prepare(
        "UPDATE tasks SET status='COMPLETED',completed_at=?,completed_by_membership_id=?,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND status='OPEN' AND kind='GENERAL' AND policy_id IS NULL AND renewal_id IS NULL",
      )
      .bind(now, m.id, now, m.agencyId, row.taskId, row.taskVersion),
    changed(),
  ];
  if (next.mode === 'FOLLOW_UP')
    statements.push(
      db
        .prepare(
          "INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES(?,?,?,'GENERAL','Sonraki dönem teklif takibi',?,?,'USER',?,?,?,?)",
        )
        .bind(newTaskId, m.agencyId, row.customerId, next.dueAt, m.id, ctx.userId, m.id, now, now),
      db
        .prepare(
          "INSERT INTO sales_cases(id,agency_id,customer_id,branch_id,data_classification,context_kind,cycle_date,date_basis,result,active_task_id,predecessor_case_id,origin_result_revision_id,created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES(?,?,?,?,?,'NEW_BUSINESS',?,?,'OPEN',?,?,?,?,?,?,?)",
        )
        .bind(
          childId,
          m.agencyId,
          row.customerId,
          row.branchId,
          row.classification,
          next.cycleDate,
          next.dateBasis,
          newTaskId,
          caseId,
          revisionId,
          ctx.userId,
          m.id,
          now,
          now,
        ),
      db
        .prepare(
          "INSERT INTO sales_case_tasks(id,agency_id,case_id,task_id,purpose,created_at) VALUES(?,?,?,?,'NEXT_CYCLE',?)",
        )
        .bind(crypto.randomUUID(), m.agencyId, childId, newTaskId, now),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,reason_code,notes,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,'LOST',?,?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        m.agencyId,
        caseId,
        data.caseVersion,
        row.taskId,
        reason.code,
        input.notes,
        ctx.userId,
        m.id,
        operationId,
        now,
      ),
  );
  if (data.followup)
    statements.push(
      db
        .prepare(
          "INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,1,'CREATED_NEXT_CYCLE',?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          m.agencyId,
          childId,
          newTaskId,
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
  } catch (error) {
    const msg = String(error);
    if (/MEMBERSHIP_PERMISSION|LOCAL_SESSION/.test(msg)) throw new SalesError('FORBIDDEN', 403);
    if (/UNIQUE|OPTIMISTIC|SALES_RESULT|SALES_CASE|SALES_CYCLE/.test(msg)) {
      // D1 may surface a later guard from the failed batch. Classify a revoked
      // final authority as forbidden while preserving a normal CAS conflict.
      try {
        const current = await source(db, ctx, caseId, input.expectedTaskId, true);
        if (next.mode === 'FOLLOW_UP' && !current.row.canCreate)
          throw new SalesError('FORBIDDEN', 403);
      } catch {
        throw new SalesError('FORBIDDEN', 403);
      }
      const committed = await db
        .prepare(
          'SELECT id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
        )
        .bind(m.agencyId, ctx.userId, key)
        .first();
      if (committed) return closeSalesLost(db, ctx, caseId, raw, key);
      throw new SalesError('CONFLICT');
    }
    throw error;
  }
  return { data, replayed: false };
}
