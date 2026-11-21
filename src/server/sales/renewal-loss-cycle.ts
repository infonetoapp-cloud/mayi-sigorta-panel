import { closeRenewalLostSchema } from '../renewals/validation';
import type { AuthenticatedUserContext } from '../auth/identity';
import { RenewalCommandError, type RenewalLostResult } from '../renewals/commands';
import type { CloseRenewalLostInput } from '../renewals/validation';
import { member, salesGate } from './service';
import { salesLossResultSchema, type SalesLossResult } from '../../shared/sales-loss';
import { istanbulToday } from '../../shared/customer-profile';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
const joins = `FROM sales_cases s JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
 JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id
 JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id AND p.customer_id=c.id AND p.branch_id=b.id AND p.id=s.source_policy_id
 JOIN tasks t ON t.agency_id=s.agency_id AND t.renewal_id=r.id AND t.customer_id=c.id AND t.kind='RENEWAL_FOLLOWUP'
 JOIN agency_memberships m ON m.agency_id=s.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;
const createGate = `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions mp WHERE mp.membership_id=m.id AND mp.permission_code='task.create' AND mp.scope='UNSCOPED'))`;
type Ctx = AuthenticatedUserContext;
type Input = CloseRenewalLostInput;
const assertChange = (db: D1Database) =>
  db
    .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
    .bind(crypto.randomUUID());
/** Prepared effects only: the renewal command owns and executes the sole batch. */
export async function prepareRenewalLossCycle(
  db: D1Database,
  ctx: Ctx,
  renewalId: string,
  input: Input,
  closedAt: string,
) {
  const cycle = input.salesCycle;
  if (!cycle) throw new RenewalCommandError('VALIDATION_ERROR', 400);
  const m = member(ctx),
    g = salesGate(ctx, true, 'update', true),
    next = cycle.nextCycle;
  const where = `s.agency_id=? AND s.id=? AND r.id=? AND t.id=? AND s.context_kind='RENEWAL' AND ${g.sql}`;
  const args = [m.agencyId, cycle.caseId, renewalId, input.expectedPrimaryTaskId, ...g.args];
  const row = (
    await db.batch<{
      customerId: string;
      branchId: string;
      classification: string;
      cycleDate: string | null;
      version: number;
      currentResult: string | null;
      canCreate: number;
      branchStatus: string;
    }>([
      db
        .prepare(
          `SELECT c.id customerId,b.id branchId,CASE WHEN s.data_classification='HEALTH' OR b.data_classification='HEALTH' THEN 'HEALTH' ELSE 'GENERAL' END classification,
  s.cycle_date cycleDate,s.version,s.current_result_id currentResult,CASE WHEN ${createGate} THEN 1 ELSE 0 END canCreate,b.status branchStatus ${joins} WHERE ${where}`,
        )
        .bind(...args),
    ])
  )[0]!.results[0];
  if (!row) throw new RenewalCommandError('SALES_CASE_NOT_ACCESSIBLE', 404);
  if (row.version !== cycle.expectedCaseVersion || row.currentResult)
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  if (next.mode === 'FOLLOW_UP') {
    if (!row.canCreate) throw new RenewalCommandError('FORBIDDEN', 403);
    if (row.branchStatus !== 'ACTIVE')
      throw new RenewalCommandError('RENEWAL_PARENT_NOT_ACTIVE', 409);
    if (
      next.dueAt <= closedAt ||
      (next.cycleDate &&
        (next.cycleDate < istanbulToday() || (row.cycleDate && next.cycleDate <= row.cycleDate)))
    )
      throw new RenewalCommandError('NEXT_CYCLE_DATE_INVALID', 400);
  }
  const operationId = crypto.randomUUID(),
    revisionId = crypto.randomUUID(),
    childId = next.mode === 'FOLLOW_UP' ? crypto.randomUUID() : null,
    newTaskId = childId ? crypto.randomUUID() : null;
  const result = salesLossResultSchema.parse({
    operationId,
    caseId: cycle.caseId,
    caseVersion: cycle.expectedCaseVersion + 1,
    resultRevisionId: revisionId,
    taskId: input.expectedPrimaryTaskId,
    taskVersion: input.expectedTaskVersion + 1,
    closedAt,
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
  const authority = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${joins} WHERE ${where}${next.mode === 'FOLLOW_UP' ? ` AND ${createGate}` : ''}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(crypto.randomUUID(), ...args);
  const revision = db
    .prepare(
      "INSERT INTO sales_case_result_revisions(id,agency_id,case_id,result_no,kind,case_version,task_id,task_version,loss_reason_id,notes,followup_case_id,exception_code,receipt_id,actor_user_id,actor_membership_id,created_at) VALUES(?,?,?,(SELECT COALESCE(MAX(result_no),0)+1 FROM sales_case_result_revisions WHERE agency_id=? AND case_id=?),'LOST',?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      revisionId,
      m.agencyId,
      cycle.caseId,
      m.agencyId,
      cycle.caseId,
      result.caseVersion,
      input.expectedPrimaryTaskId,
      result.taskVersion,
      input.lossReasonId,
      cycle.notes,
      childId,
      next.mode === 'NO_FOLLOW_UP' ? next.exceptionCode : null,
      operationId,
      ctx.userId,
      m.id,
      closedAt,
    );
  const finish: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE sales_cases SET current_result_id=?,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND context_kind='RENEWAL' AND result IS NULL AND current_result_id IS NULL AND EXISTS(SELECT 1 ${joins} WHERE ${where} AND r.state='LOST' AND r.version=? AND r.closed_at=? AND t.status='COMPLETED' AND t.version=? ${next.mode === 'FOLLOW_UP' ? `AND ${createGate} AND b.status='ACTIVE'` : ''})`,
      )
      .bind(
        revisionId,
        closedAt,
        m.agencyId,
        cycle.caseId,
        cycle.expectedCaseVersion,
        ...args,
        input.expectedRenewalVersion + 1,
        closedAt,
        input.expectedTaskVersion + 1,
      ),
    assertChange(db),
  ];
  if (next.mode === 'FOLLOW_UP')
    finish.push(
      db
        .prepare(
          "INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES(?,?,?,'GENERAL','Sonraki dönem teklif takibi',?,?,'USER',?,?,?,?)",
        )
        .bind(
          newTaskId,
          m.agencyId,
          row.customerId,
          next.dueAt,
          m.id,
          ctx.userId,
          m.id,
          closedAt,
          closedAt,
        ),
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
          cycle.caseId,
          revisionId,
          ctx.userId,
          m.id,
          closedAt,
          closedAt,
        ),
      db
        .prepare(
          "INSERT INTO sales_case_tasks(id,agency_id,case_id,task_id,purpose,created_at) VALUES(?,?,?,?,'NEXT_CYCLE',?)",
        )
        .bind(crypto.randomUUID(), m.agencyId, childId, newTaskId, closedAt),
    );
  finish.push(
    db
      .prepare(
        "INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,reason_code,notes,actor_user_id,actor_membership_id,receipt_id,created_at) SELECT ?,?,?,?,'LOST',?,code,?,?,?,?,? FROM loss_reasons WHERE agency_id=? AND id=? AND status='ACTIVE'",
      )
      .bind(
        crypto.randomUUID(),
        m.agencyId,
        cycle.caseId,
        result.caseVersion,
        input.expectedPrimaryTaskId,
        cycle.notes,
        ctx.userId,
        m.id,
        operationId,
        closedAt,
        m.agencyId,
        input.lossReasonId,
      ),
    assertChange(db),
  );
  if (childId)
    finish.push(
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
          closedAt,
        ),
    );
  return { result, authority, revision, finish };
}
export async function renewalCycleAudit(
  db: D1Database,
  ctx: Ctx,
  result: SalesLossResult,
  key: string,
) {
  const m = member(ctx),
    a = buildSafeAuditRecord({
      agencyId: m.agencyId,
      actorUserId: ctx.userId,
      actorMembershipId: m.id,
      action: 'sales.renewal.close_lost_cycle',
      targetType: 'sales_cases',
      targetId: result.caseId,
      correlationId: result.operationId,
      idempotencyKey: key,
      outcome: 'SUCCESS',
      metadata: { responseHash: await computePayloadHash(result) },
      createdAt: result.closedAt,
    });
  return db
    .prepare(
      'INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,idempotency_key,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      a.id,
      a.agencyId,
      a.actorUserId,
      a.actorMembershipId,
      a.action,
      a.targetType,
      a.targetId,
      a.correlationId,
      a.idempotencyKey,
      a.outcome,
      a.metadataJson,
      a.createdAt,
    );
}
/** Exact mutation replay is still authorized by the renewal command first. */
export async function assertRenewalLossCycleReplay(
  db: D1Database,
  ctx: Ctx,
  input: Input,
  result: RenewalLostResult,
  key: string,
  write = true,
) {
  const cycle = input.salesCycle,
    r = result.salesCycle;
  if (!cycle || !r) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const m = member(ctx),
    g = salesGate(ctx, write, write ? 'update' : 'read', true);
  const proof = (
    await db.batch<{ response_body: string; responseHash: string; fingerprint: string }>([
      db
        .prepare(
          `SELECT o.response_body,o.payload_fingerprint fingerprint,json_extract(ae.metadata_json,'$.responseHash') responseHash ${joins}
 JOIN sales_case_result_revisions v ON v.agency_id=s.agency_id AND v.case_id=s.id AND v.id=? AND v.task_id=t.id
 JOIN operation_receipts o ON o.id=v.receipt_id AND o.agency_id=s.agency_id AND o.action='renewal.close_lost' AND o.status='COMPLETED' AND o.response_status=200
 JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id AND h.receipt_id=o.id AND h.case_version=v.case_version AND h.event_code='LOST'
 JOIN loss_reasons l ON l.agency_id=v.agency_id AND l.id=v.loss_reason_id
 JOIN audit_events ae ON ae.agency_id=s.agency_id AND ae.correlation_id=o.id AND ae.action='sales.renewal.close_lost_cycle' AND ae.target_type='sales_cases' AND ae.target_id=s.id AND ae.outcome='SUCCESS'
 WHERE s.agency_id=? AND s.id=? AND r.id=? AND t.id=? AND s.context_kind='RENEWAL' AND s.result IS NULL AND ${g.sql}
 AND (s.current_result_id=v.id OR EXISTS(SELECT 1 FROM sales_case_history rh JOIN operation_receipts ro ON ro.id=rh.receipt_id
 WHERE rh.agency_id=s.agency_id AND rh.case_id=s.id AND rh.event_code='LOSS_REOPENED'
 AND ro.action='renewal.reopen' AND json_extract(ro.response_body,'$.salesCycle.resultRevisionId')=v.id))
 ${write && cycle.nextCycle.mode === 'FOLLOW_UP' ? `AND ${createGate}` : ''}
 AND (m.type='OWNER' OR (EXISTS(SELECT 1 FROM membership_permissions q WHERE q.membership_id=m.id AND q.permission_code='renewal.read' AND (q.scope='AGENCY' OR (q.scope='ASSIGNED' AND (r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)))) AND EXISTS(SELECT 1 FROM membership_permissions q WHERE q.membership_id=m.id AND q.permission_code='policy.read' AND (q.scope='AGENCY' OR (q.scope='ASSIGNED' AND (p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id))))))
 AND t.completed_at=v.created_at AND t.status='COMPLETED' AND t.version>=v.task_version
 AND o.id=? AND (?=0 OR (o.actor_user_id=? AND o.actor_membership_id=?)) AND o.idempotency_key=?
 AND v.kind='LOST' AND v.case_version=? AND v.task_version=? AND v.loss_reason_id=? AND v.notes IS ? AND v.followup_case_id IS ? AND v.exception_code IS ? AND v.created_at=?
 AND v.actor_user_id=o.actor_user_id AND v.actor_membership_id=o.actor_membership_id AND h.actor_user_id=o.actor_user_id AND h.actor_membership_id=o.actor_membership_id
 AND h.task_id=t.id AND h.reason_code=l.code AND h.notes IS v.notes AND h.created_at=v.created_at AND ae.actor_user_id=o.actor_user_id AND ae.actor_membership_id=o.actor_membership_id AND ae.idempotency_key=o.idempotency_key`,
        )
        .bind(
          r.resultRevisionId,
          m.agencyId,
          cycle.caseId,
          result.renewalId,
          result.primaryTaskId,
          ...g.args,
          r.operationId,
          write ? 1 : 0,
          ctx.userId,
          m.id,
          key,
          r.caseVersion,
          r.taskVersion,
          input.lossReasonId,
          cycle.notes,
          r.followup?.caseId ?? null,
          cycle.nextCycle.mode === 'NO_FOLLOW_UP' ? cycle.nextCycle.exceptionCode : null,
          r.closedAt,
        ),
    ])
  )[0]!.results;
  if (proof.length !== 1 || proof[0]!.responseHash !== (await computePayloadHash(r)))
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const saved = JSON.parse(String(proof[0]!.response_body));
  const expectedFingerprint = await computePayloadHash({
    action: 'renewal.close_lost',
    target: result.renewalId,
    payload: input,
    version: {
      expectedRenewalVersion: input.expectedRenewalVersion,
      expectedTaskVersion: input.expectedTaskVersion,
    },
  });
  if (proof[0]!.fingerprint !== expectedFingerprint)
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  if (
    (await computePayloadHash(saved.cycleCommand)) !== (await computePayloadHash(input)) ||
    (await computePayloadHash(saved.salesCycle)) !== (await computePayloadHash(r))
  )
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  if (r.followup) {
    const childGate = salesGate(ctx, false, 'read'),
      f = r.followup;
    const child = (
      await db.batch([
        db
          .prepare(
            `SELECT 1 FROM sales_cases s JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id JOIN tasks t ON t.agency_id=s.agency_id AND t.customer_id=c.id AND t.id=? AND t.kind='GENERAL' JOIN sales_case_tasks link ON link.agency_id=s.agency_id AND link.case_id=s.id AND link.task_id=t.id AND link.purpose='NEXT_CYCLE' JOIN agency_memberships m ON m.agency_id=s.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id AND h.case_version=1 AND h.event_code='CREATED_NEXT_CYCLE' AND h.receipt_id=? AND h.task_id=t.id WHERE s.agency_id=? AND s.id=? AND s.predecessor_case_id=? AND s.origin_result_revision_id=? AND s.cycle_date IS ? AND s.date_basis=? AND ${childGate.sql}`,
          )
          .bind(
            f.taskId,
            r.operationId,
            m.agencyId,
            f.caseId,
            cycle.caseId,
            r.resultRevisionId,
            f.cycleDate,
            f.dateBasis,
            ...childGate.args,
          ),
      ])
    )[0]!.results;
    if (child.length !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

/** Private exact GET: no write or task.create grant is invented for reading history. */
export async function readRenewalLossCycleOperation(
  db: D1Database,
  ctx: Ctx,
  caseId: string,
  operationId: string,
) {
  const m = member(ctx),
    o = await db
      .prepare(
        "SELECT response_body,idempotency_key FROM operation_receipts WHERE agency_id=? AND id=? AND action='renewal.close_lost' AND status='COMPLETED' AND response_status=200",
      )
      .bind(m.agencyId, operationId)
      .first<{ response_body: string; idempotency_key: string }>();
  if (!o) throw new RenewalCommandError('NOT_FOUND', 404);
  let input: Input, result: RenewalLostResult;
  try {
    const saved = JSON.parse(o.response_body);
    input = closeRenewalLostSchema.parse(saved.cycleCommand);
    const cycle = salesLossResultSchema.parse(saved.salesCycle);
    if (
      cycle.caseId !== caseId ||
      cycle.operationId !== operationId ||
      !input.salesCycle ||
      input.salesCycle.caseId !== caseId ||
      saved.primaryTaskId !== input.expectedPrimaryTaskId ||
      saved.lossReasonId !== input.lossReasonId ||
      saved.renewalVersion !== input.expectedRenewalVersion + 1 ||
      saved.taskVersion !== input.expectedTaskVersion + 1 ||
      saved.state !== 'LOST' ||
      saved.closedAt !== cycle.closedAt
    )
      throw Error('INVALID');
    result = saved;
  } catch {
    throw new RenewalCommandError('NOT_FOUND', 404);
  }
  await assertRenewalLossCycleReplay(db, ctx, input, result, o.idempotency_key, false);
  return result.salesCycle!;
}
