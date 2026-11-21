import type { AuthenticatedUserContext as Context } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import {
  salesVoidCommandSchema,
  salesVoidReceiptSchema,
  type SalesVoidResult,
} from '../../shared/sales-void';
import { member, SalesError } from './service';
import {
  newBusinessTaskQuery,
  openNewBusinessTask,
  readNewBusinessTask,
} from './new-business-task';

const action = 'sales.case.void';
type Receipt = {
  id: string;
  action: string;
  payload_fingerprint: string;
  response_body: string;
  actor_membership_id: string;
  response_status: number;
  status: string;
  created_at: string;
};

async function receiptFor(db: D1Database, ctx: Context, key: string) {
  return db
    .prepare(
      `SELECT id,action,payload_fingerprint,response_body,actor_membership_id,response_status,status,created_at
    FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?`,
    )
    .bind(member(ctx).agencyId, ctx.userId, key)
    .first<Receipt>();
}

async function verifyVoid(
  db: D1Database,
  ctx: Context,
  caseId: string,
  key: string,
  receipt: Receipt,
) {
  const actor = member(ctx);
  if (
    receipt.action !== action ||
    receipt.actor_membership_id !== actor.id ||
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 200
  )
    throw new SalesError('OPERATION_NOT_FOUND', 404);
  const { command, result } = salesVoidReceiptSchema.parse(JSON.parse(receipt.response_body));
  if (
    result.caseId !== caseId ||
    result.operationId !== receipt.id ||
    result.closedAt !== receipt.created_at ||
    result.caseVersion !== command.expectedCaseVersion + 1 ||
    result.taskId !== command.expectedTaskId ||
    result.taskVersion !== command.expectedTaskVersion + 1 ||
    receipt.payload_fingerprint !==
      (await computePayloadHash({ action, targetId: caseId, input: command }))
  )
    throw new SalesError('OPERATION_NOT_FOUND', 404);

  const q = newBusinessTaskQuery(ctx, caseId, result.taskId);
  const proof = await db
    .prepare(
      `SELECT s.id ${q.sql}
    AND s.result='VOIDED' AND s.active_task_id IS NULL AND s.current_result_id IS NULL AND s.version=?
    AND s.updated_at=? AND t.status='COMPLETED' AND t.version=? AND t.completed_at=?
    AND t.completed_by_membership_id=m.id
    AND EXISTS(SELECT 1 FROM sales_case_history h WHERE h.agency_id=s.agency_id AND h.case_id=s.id
      AND h.case_version=s.version AND h.task_id=t.id AND h.event_code='VOIDED' AND h.receipt_id=?
      AND h.reason_code=? AND h.notes=? AND h.actor_user_id=u.id AND h.actor_membership_id=m.id AND h.created_at=t.completed_at)
    AND EXISTS(SELECT 1 FROM audit_events ev WHERE ev.agency_id=s.agency_id AND ev.correlation_id=?
      AND ev.idempotency_key=? AND ev.actor_user_id=u.id AND ev.actor_membership_id=m.id
      AND ev.action=? AND ev.target_type='sales_cases' AND ev.target_id=s.id AND ev.outcome='SUCCESS'
      AND ev.created_at=t.completed_at AND json_extract(ev.metadata_json,'$.responseHash')=?)`,
    )
    .bind(
      ...q.args,
      result.caseVersion,
      result.closedAt,
      result.taskVersion,
      result.closedAt,
      receipt.id,
      command.reasonCode,
      command.notes,
      receipt.id,
      key,
      action,
      await computePayloadHash(result),
    )
    .first();
  if (!proof) throw new SalesError('OPERATION_NOT_FOUND', 404);
  return result;
}

export async function readSalesVoidOperation(
  db: D1Database,
  ctx: Context,
  caseId: string,
  key: string,
) {
  const receipt = await receiptFor(db, ctx, key);
  if (!receipt) throw new SalesError('OPERATION_NOT_FOUND', 404);
  return verifyVoid(db, ctx, caseId, key, receipt);
}

export async function readSalesVoidContext(db: D1Database, ctx: Context, caseId: string) {
  const row = await readNewBusinessTask(db, newBusinessTaskQuery(ctx, caseId));
  if (!row.open) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  return { caseId, caseVersion: row.caseVersion, taskId: row.taskId, taskVersion: row.taskVersion };
}

export async function voidSalesCase(
  db: D1Database,
  ctx: Context,
  caseId: string,
  raw: unknown,
  key: string,
): Promise<{ data: SalesVoidResult; replayed: boolean }> {
  const input = salesVoidCommandSchema.parse(raw);
  const actor = member(ctx);
  const q = newBusinessTaskQuery(ctx, caseId, input.expectedTaskId);
  const fingerprint = await computePayloadHash({ action, targetId: caseId, input });
  const replay = async (found: Receipt) => {
    if (found.action !== action || found.payload_fingerprint !== fingerprint)
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    return { data: await verifyVoid(db, ctx, caseId, key, found), replayed: true };
  };
  const prior = await receiptFor(db, ctx, key);
  if (prior) return replay(prior);
  const row = await readNewBusinessTask(db, q);
  if (
    !row.open ||
    row.caseVersion !== input.expectedCaseVersion ||
    row.taskVersion !== input.expectedTaskVersion
  )
    throw new SalesError('CONFLICT');
  const data: SalesVoidResult = {
    operationId: crypto.randomUUID(),
    caseId,
    caseVersion: row.caseVersion + 1,
    taskId: input.expectedTaskId,
    taskVersion: row.taskVersion + 1,
    closedAt: new Date().toISOString(),
  };
  const audit = buildSafeAuditRecord({
    agencyId: actor.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: actor.id,
    action,
    targetType: 'sales_cases',
    targetId: caseId,
    correlationId: data.operationId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    metadata: { responseHash: await computePayloadHash(data) },
    createdAt: data.closedAt,
  });
  const assert = (where: string, args: unknown[], code: string) =>
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
      SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${where}) THEN 1 ELSE 0 END,?`,
      )
      .bind(crypto.randomUUID(), ...args, code);
  try {
    await db.batch([
      assert(q.sql, q.args, 'MEMBERSHIP_PERMISSION_NOT_FOUND'),
      assert(
        `${q.sql} AND ${openNewBusinessTask} AND s.version=? AND t.version=?`,
        [...q.args, row.caseVersion, row.taskVersion],
        'OPTIMISTIC_CONCURRENCY_CONFLICT',
      ),
      db
        .prepare(
          `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
        payload_fingerprint,status,response_status,response_body,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
        )
        .bind(
          data.operationId,
          actor.agencyId,
          ctx.userId,
          actor.id,
          action,
          key,
          fingerprint,
          JSON.stringify({ command: input, result: data }),
          data.closedAt,
          data.closedAt,
        ),
      // The history trigger applies both versioned updates before this statement can succeed.
      db
        .prepare(
          `INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,reason_code,
        notes,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,'VOIDED',?,?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor.agencyId,
          caseId,
          data.caseVersion,
          data.taskId,
          input.reasonCode,
          input.notes,
          ctx.userId,
          actor.id,
          data.operationId,
          data.closedAt,
        ),
      db
        .prepare(
          `INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
        correlation_id,idempotency_key,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    const message = String(error);
    if (/MEMBERSHIP_PERMISSION/.test(message)) throw new SalesError('FORBIDDEN', 403);
    if (
      !/UNIQUE|OPTIMISTIC_CONCURRENCY_CONFLICT|SALES_HISTORY_INVALID|SALES_RESULT_POINTER_INVALID/.test(
        message,
      )
    )
      throw error;
    const raced = await receiptFor(db, ctx, key);
    if (raced) return replay(raced);
    throw new SalesError('CONFLICT');
  }
  return { data, replayed: false };
}
