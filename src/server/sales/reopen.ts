import type { AuthenticatedUserContext as Context } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import {
  salesReopenContextSchema,
  salesReopenReceiptSchema,
  salesReopenSchema,
  type SalesReopenResult,
} from '../../shared/sales-reopen';
import { readSalesLossOperation } from './loss';
import { newBusinessTaskQuery } from './new-business-task';
import { member, SalesError } from './service';

const action = 'sales.case.reopen';
const taskCreate = `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions mp
  WHERE mp.membership_id=m.id AND mp.permission_code='task.create' AND mp.scope='UNSCOPED'))`;
const lost = `s.result='LOST' AND s.active_task_id IS NULL AND t.status='COMPLETED'
  AND c.archived_at IS NULL AND b.status='ACTIVE' AND s.current_result_id=? AND s.version=?
  AND t.version=? AND ${taskCreate}`;
const untouched = `s.result='OPEN' AND s.current_result_id IS NULL AND s.version=1 AND s.active_task_id=t.id
  AND t.status='OPEN' AND t.version=1 AND t.assignee_membership_id=m.id AND c.archived_at IS NULL
  AND s.predecessor_case_id=? AND s.origin_result_revision_id=?
  AND NOT EXISTS(SELECT 1 FROM sales_prices sp WHERE sp.agency_id=s.agency_id AND sp.case_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM sales_case_history h WHERE h.agency_id=s.agency_id AND h.case_id=s.id AND h.case_version>1)`;

interface Root {
  caseVersion: number;
  resultRevisionId: string;
  taskId: string;
  taskVersion: number;
  receiptId: string;
  customerId: string;
}
type Receipt = {
  id: string;
  action: string;
  fingerprint: string;
  body: string;
  membershipId: string;
  createdAt: string;
  status: string;
  responseStatus: number;
};

function readReceipt(db: D1Database, ctx: Context, key: string) {
  return db
    .prepare(
      `SELECT id,action,payload_fingerprint fingerprint,response_body body,actor_membership_id membershipId,
    created_at createdAt,status,response_status responseStatus FROM operation_receipts
    WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?`,
    )
    .bind(member(ctx).agencyId, ctx.userId, key)
    .first<Receipt>();
}

async function readEligibleReopen(db: D1Database, ctx: Context, caseId: string) {
  const r = await db
    .prepare(
      `SELECT s.version caseVersion, v.id resultRevisionId,v.task_id taskId,
    t.version taskVersion,v.receipt_id receiptId,s.customer_id customerId
    FROM sales_cases s JOIN sales_case_result_revisions v ON v.id=s.current_result_id AND v.agency_id=s.agency_id AND v.case_id=s.id
    JOIN tasks t ON t.agency_id=v.agency_id AND t.id=v.task_id
    WHERE s.agency_id=? AND s.id=? AND s.context_kind='NEW_BUSINESS' AND s.result='LOST' AND v.kind='LOST'
    AND v.case_version=s.version`,
    )
    .bind(member(ctx).agencyId, caseId)
    .first<Root>();
  if (!r) throw new SalesError('REOPEN_NOT_AVAILABLE', 404);
  const q = newBusinessTaskQuery(ctx, caseId, r.taskId);
  const authority = await db
    .prepare(`SELECT s.id ${q.sql} AND ${lost}`)
    .bind(...q.args, r.resultRevisionId, r.caseVersion, r.taskVersion)
    .first();
  if (!authority) throw new SalesError('REOPEN_NOT_AVAILABLE', 404);
  const original = await readSalesLossOperation(db, ctx, caseId, r.receiptId);
  if (original.saved.result.resultRevisionId !== r.resultRevisionId)
    throw new SalesError('REOPEN_NOT_AVAILABLE', 404);
  const child = original.saved.result.followup;
  const next = child ? newBusinessTaskQuery(ctx, child.caseId, child.taskId) : null;
  const successor =
    child && next
      ? await db
          .prepare(
            `SELECT s.id caseId,s.version caseVersion,t.id taskId,t.version taskVersion,t.due_at dueAt
      ${next.sql} AND ${untouched}`,
          )
          .bind(...next.args, caseId, r.resultRevisionId)
          .first<{
            caseId: string;
            caseVersion: number;
            taskId: string;
            taskVersion: number;
            dueAt: string;
          }>()
      : null;
  if (child && !successor) throw new SalesError('NEXT_CYCLE_ALREADY_WORKED');
  return { r, q, next, successor };
}

export async function readSalesReopenContext(db: D1Database, ctx: Context, caseId: string) {
  const { r, successor } = await readEligibleReopen(db, ctx, caseId);
  const { receiptId: _receipt, customerId: _customer, ...context } = r;
  return salesReopenContextSchema.parse({ caseId, ...context, successor });
}

async function verifyReopen(
  db: D1Database,
  ctx: Context,
  caseId: string,
  key: string,
  receipt: Receipt,
) {
  const actor = member(ctx);
  if (
    receipt.action !== action ||
    receipt.membershipId !== actor.id ||
    receipt.status !== 'COMPLETED' ||
    receipt.responseStatus !== 200
  )
    throw new SalesError('OPERATION_NOT_FOUND', 404);
  const { command, result } = salesReopenReceiptSchema.parse(JSON.parse(receipt.body));
  if (
    result.operationId !== receipt.id ||
    result.caseId !== caseId ||
    result.reopenedAt !== receipt.createdAt ||
    result.resultRevisionId !== command.expectedResultRevisionId ||
    result.caseVersion !== command.expectedCaseVersion + 1 ||
    result.previousTaskId !== command.expectedTaskId ||
    result.previousTaskVersion !== command.expectedTaskVersion ||
    result.taskId === result.previousTaskId ||
    result.dueAt !== command.replacementDueAt ||
    (command.expectedSuccessor
      ? result.successor?.caseId !== command.expectedSuccessor.caseId ||
        result.successor?.taskId !== command.expectedSuccessor.taskId ||
        result.successor.caseVersion !== 2 ||
        result.successor.taskVersion !== 2
      : result.successor !== null) ||
    receipt.fingerprint !== (await computePayloadHash({ action, targetId: caseId, input: command }))
  )
    throw new SalesError('OPERATION_NOT_FOUND', 404);
  const q = newBusinessTaskQuery(ctx, caseId, result.taskId);
  const history = await db
    .prepare(
      `SELECT s.id ${q.sql} AND ${taskCreate} AND s.version>=? AND s.current_result_id IS NOT ?
    AND t.version>=1 AND t.created_at=? AND t.created_by_user_id=u.id AND t.created_by_membership_id=m.id
    AND EXISTS(SELECT 1 FROM sales_case_history h JOIN sales_case_result_revisions v
      ON v.agency_id=h.agency_id AND v.case_id=h.case_id AND v.id=?
      WHERE h.agency_id=s.agency_id AND h.case_id=s.id AND h.case_version=? AND h.task_id=t.id
      AND h.event_code='CASE_LOSS_REOPENED' AND h.receipt_id=? AND h.reason_code=? AND h.notes=?
      AND h.actor_user_id=u.id AND h.actor_membership_id=m.id AND h.created_at=t.created_at
      AND v.kind='LOST' AND v.task_id=? AND v.case_version=h.case_version-1 AND v.followup_case_id IS ?)
    AND EXISTS(SELECT 1 FROM audit_events ev WHERE ev.agency_id=s.agency_id AND ev.correlation_id=?
      AND ev.target_type='sales_cases' AND ev.target_id=s.id AND ev.actor_user_id=u.id AND ev.actor_membership_id=m.id
      AND ev.action=? AND ev.idempotency_key=? AND ev.created_at=t.created_at AND ev.outcome='SUCCESS'
      AND json_extract(ev.metadata_json,'$.responseHash')=?)`,
    )
    .bind(
      ...q.args,
      result.caseVersion,
      result.resultRevisionId,
      result.reopenedAt,
      result.resultRevisionId,
      result.caseVersion,
      receipt.id,
      command.reasonCode,
      command.notes,
      result.previousTaskId,
      result.successor?.caseId ?? null,
      receipt.id,
      action,
      key,
      await computePayloadHash(result),
    )
    .first();
  if (!history) throw new SalesError('OPERATION_NOT_FOUND', 404);
  if (result.successor) {
    const child = newBusinessTaskQuery(ctx, result.successor.caseId, result.successor.taskId);
    const proof = await db
      .prepare(
        `SELECT s.id ${child.sql}
      AND s.result='VOIDED' AND s.version=2 AND t.status='COMPLETED' AND t.version=2 AND t.completed_at=?
      AND t.completed_by_membership_id=m.id AND s.predecessor_case_id=? AND s.origin_result_revision_id=?
      AND EXISTS(SELECT 1 FROM sales_case_history h WHERE h.agency_id=s.agency_id AND h.case_id=s.id
        AND h.task_id=t.id AND h.receipt_id=? AND h.case_version=2 AND h.event_code='CASE_NEXT_CYCLE_RECALLED')`,
      )
      .bind(...child.args, result.reopenedAt, caseId, result.resultRevisionId, receipt.id)
      .first();
    if (!proof) throw new SalesError('OPERATION_NOT_FOUND', 404);
  }
  return result;
}

export async function readSalesReopenOperation(
  db: D1Database,
  ctx: Context,
  caseId: string,
  key: string,
) {
  const saved = await readReceipt(db, ctx, key);
  if (!saved) throw new SalesError('OPERATION_NOT_FOUND', 404);
  return verifyReopen(db, ctx, caseId, key, saved);
}

export async function reopenSalesCase(
  db: D1Database,
  ctx: Context,
  caseId: string,
  raw: unknown,
  key: string,
): Promise<{ data: SalesReopenResult; replayed: boolean }> {
  const input = salesReopenSchema.parse(raw);
  const actor = member(ctx);
  const fingerprint = await computePayloadHash({ action, targetId: caseId, input });
  const replay = async (saved: Receipt) => {
    if (saved.action !== action || saved.fingerprint !== fingerprint)
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    return { data: await verifyReopen(db, ctx, caseId, key, saved), replayed: true };
  };
  const saved = await readReceipt(db, ctx, key);
  if (saved) return replay(saved);
  let current;
  try {
    current = await readEligibleReopen(db, ctx, caseId);
  } catch (error) {
    const raced = await readReceipt(db, ctx, key);
    if (raced) return replay(raced);
    throw error;
  }
  const { r, q, next, successor } = current;
  const expected = input.expectedSuccessor;
  if (
    r.caseVersion !== input.expectedCaseVersion ||
    r.resultRevisionId !== input.expectedResultRevisionId ||
    r.taskId !== input.expectedTaskId ||
    r.taskVersion !== input.expectedTaskVersion ||
    (successor
      ? !expected ||
        successor.caseId !== expected.caseId ||
        successor.taskId !== expected.taskId ||
        successor.caseVersion !== expected.caseVersion ||
        successor.taskVersion !== expected.taskVersion
      : expected !== null)
  )
    throw new SalesError('CONFLICT');
  const now = new Date().toISOString();
  if (input.replacementDueAt <= now) throw new SalesError('REOPEN_DATE_INVALID', 400);
  const data: SalesReopenResult = {
    operationId: crypto.randomUUID(),
    caseId,
    caseVersion: r.caseVersion + 1,
    resultRevisionId: r.resultRevisionId,
    previousTaskId: r.taskId,
    previousTaskVersion: r.taskVersion,
    taskId: crypto.randomUUID(),
    taskVersion: 1,
    dueAt: input.replacementDueAt,
    reopenedAt: now,
    successor: successor
      ? { caseId: successor.caseId, caseVersion: 2, taskId: successor.taskId, taskVersion: 2 }
      : null,
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
    createdAt: now,
  });
  const assert = (sql: string, args: unknown[], code: string) =>
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
      SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${sql}) THEN 1 ELSE 0 END,?`,
      )
      .bind(crypto.randomUUID(), ...args, code);
  try {
    await db.batch([
      assert(`${q.sql} AND ${taskCreate}`, q.args, 'MEMBERSHIP_PERMISSION_NOT_FOUND'),
      assert(
        `${q.sql} AND ${lost}`,
        [...q.args, r.resultRevisionId, r.caseVersion, r.taskVersion],
        'OPTIMISTIC_CONCURRENCY_CONFLICT',
      ),
      ...(next
        ? [
            assert(
              `${next.sql} AND t.assignee_membership_id=m.id`,
              next.args,
              'MEMBERSHIP_PERMISSION_NOT_FOUND',
            ),
            assert(
              `${next.sql} AND ${untouched}`,
              [...next.args, caseId, r.resultRevisionId],
              'OPTIMISTIC_CONCURRENCY_CONFLICT',
            ),
          ]
        : []),
      db
        .prepare(
          `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
        status,response_status,response_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
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
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,
        created_by_user_id,created_by_membership_id,created_at,updated_at) VALUES(?,?,?,'GENERAL','Teklif çalışması',?,?,'USER',?,?,?,?)`,
        )
        .bind(
          data.taskId,
          actor.agencyId,
          r.customerId,
          data.dueAt,
          actor.id,
          ctx.userId,
          actor.id,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO sales_case_tasks(id,agency_id,case_id,task_id,purpose,created_at) VALUES(?,?,?,?,'ACTIVE_CONTACT',?)`,
        )
        .bind(crypto.randomUUID(), actor.agencyId, caseId, data.taskId, now),
      db
        .prepare(
          `INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,reason_code,notes,
        actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,'CASE_LOSS_REOPENED',?,?,?,?,?,?,?)`,
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
          now,
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
    const raced = await readReceipt(db, ctx, key);
    if (raced) return replay(raced);
    throw new SalesError('CONFLICT');
  }
  return { data, replayed: false };
}
