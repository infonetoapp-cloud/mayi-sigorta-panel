import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { evaluateAuthorization } from '../auth/authorization';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import {
  generalRescheduleSchema,
  generalCompleteSchema,
  generalAssignSchema,
  generalTaskCommandResultSchema,
  generalTaskReceiptSchema,
} from '../../shared/task-general';

export class GeneralTaskError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 409,
  ) {
    super(code);
  }
}
type Ctx = AuthenticatedUserContext;
type Kind = 'reschedule' | 'complete' | 'assign';
type Result = z.infer<typeof generalTaskCommandResultSchema>;
interface Row {
  taskId: string;
  taskVersion: number;
  title: string;
  customerId: string;
  customerName: string;
  policyId: string | null;
  caseId: string | null;
  dueAt: string;
  assigneeMembershipId: string | null;
  status: 'OPEN' | 'COMPLETED';
  customerArchivedAt: string | null;
  policyArchivedAt: string | null;
  customerAssignee: string | null;
  policyAssignee: string | null;
  caseResult: string | null;
  caseActiveTask: string | null;
  health: number;
  canUpdate: number;
  canAssign: number;
}
function membership(ctx: Ctx) {
  const m = ctx.memberships[0];
  if (!m || m.status !== 'ACTIVE') throw new GeneralTaskError('FORBIDDEN', 403);
  return m;
}
const scope = (alias: string, code: string, assigned: string) =>
  `(${alias}.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=${alias}.id AND x.permission_code='${code}' AND (x.scope='AGENCY' OR (x.scope='ASSIGNED' AND (${assigned})))))`;
const health = `(coalesce(s.data_classification,'GENERAL')='HEALTH' OR coalesce(b.data_classification,'GENERAL')='HEALTH' OR coalesce(pb.data_classification,'GENERAL')='HEALTH')`;
const sensitive = (alias: string, write = false) =>
  `(NOT ${health} OR (EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=${alias}.id AND h.permission_code='sensitive.health.read' AND h.scope='UNSCOPED')${write ? ` AND EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=${alias}.id AND h.permission_code='sensitive.health.write' AND h.scope='UNSCOPED')` : ''}))`;
const joins = `FROM tasks t JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
 JOIN agency_memberships m ON m.agency_id=t.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
 LEFT JOIN policies p ON p.agency_id=t.agency_id AND p.id=t.policy_id
 LEFT JOIN insurance_branches pb ON pb.agency_id=p.agency_id AND pb.id=p.branch_id
 LEFT JOIN sales_case_tasks l ON l.agency_id=t.agency_id AND l.task_id=t.id
 LEFT JOIN sales_cases s ON s.agency_id=l.agency_id AND s.id=l.case_id
 LEFT JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id`;
function readGate(ctx: Ctx, taskId: string) {
  const m = membership(ctx);
  return {
    sql: `t.agency_id=? AND t.id=? AND t.kind='GENERAL' AND t.renewal_id IS NULL
      AND m.id=? AND m.user_id=? AND m.type=? AND m.permission_version=?
      AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
      AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
      AND (m.type='OWNER' OR t.assignee_membership_id=m.id)
      AND ${scope('m', 'task.read', 't.assignee_membership_id=m.id')}
      AND ${scope('m', 'customer.read', 'c.assignee_membership_id=m.id')}
      AND (p.id IS NULL OR ${scope('m', 'policy.read', 'p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id')})
      AND (s.id IS NULL OR ${scope('m', 'quote.read', 'c.assignee_membership_id=m.id')}) AND ${sensitive('m')}`,
    args: [m.agencyId, taskId, m.id, ctx.userId, m.type, m.permissionVersion, ctx.identityId],
  };
}
const updateGate = `${scope('m', 'task.update', 't.assignee_membership_id=m.id')} AND ${sensitive('m', true)}`;
const assignGate = `m.type='OWNER' AND ${sensitive('m', true)}`;
async function load(db: D1Database, ctx: Ctx, taskId: string) {
  const g = readGate(ctx, taskId);
  const rows = await db.batch<Row>([
    db
      .prepare(
        `SELECT t.id taskId,t.version taskVersion,t.title,t.customer_id customerId,c.display_name customerName,
     t.policy_id policyId,s.id caseId,t.due_at dueAt,t.assignee_membership_id assigneeMembershipId,t.status,
     c.archived_at customerArchivedAt,p.archived_at policyArchivedAt,c.assignee_membership_id customerAssignee,
     p.assignee_membership_id policyAssignee,s.result caseResult,s.active_task_id caseActiveTask,
     CASE WHEN ${health} THEN 1 ELSE 0 END health,
     CASE WHEN ${updateGate} THEN 1 ELSE 0 END canUpdate,CASE WHEN ${assignGate} THEN 1 ELSE 0 END canAssign
     ${joins} WHERE ${g.sql}`,
      )
      .bind(...g.args),
  ]);
  const row = rows[0]!.results[0];
  if (!row) throw new GeneralTaskError('NOT_FOUND', 404);
  return { row, g };
}
async function authorize(db: D1Database, ctx: Ctx, row: Row, kind?: Kind) {
  const common = {
    agencyId: membership(ctx).agencyId,
    customerAssigneeMembershipId: row.customerAssignee,
  };
  const permissions: [string, Record<string, unknown>][] = [
    ['customer.read', { ...common, assigneeMembershipId: row.customerAssignee }],
    [
      'task.read',
      {
        ...common,
        taskAssigneeMembershipId: row.assigneeMembershipId,
        policyAssigneeMembershipId: row.policyAssignee,
        parentReadAuthorized: true,
        isCollection: true,
      },
    ],
  ];
  if (row.policyId)
    permissions.push(['policy.read', { ...common, assigneeMembershipId: row.policyAssignee }]);
  if (row.caseId) permissions.push(['quote.read', common]);
  if (kind)
    permissions.push([
      kind === 'assign' ? 'task.assign' : 'task.update',
      {
        ...common,
        taskAssigneeMembershipId: row.assigneeMembershipId,
        policyAssigneeMembershipId: row.policyAssignee,
        parentReadAuthorized: true,
        isCollection: true,
      },
    ]);
  for (const [action, resource] of permissions) {
    const decision = await evaluateAuthorization(db, { context: ctx, action, resource });
    if (
      decision.decision !== 'ALLOW' ||
      (kind === 'assign' && action === 'task.assign' && decision.effectiveScope !== 'AGENCY')
    )
      throw new GeneralTaskError('FORBIDDEN', 403);
  }
  if (kind === 'assign' && membership(ctx).type !== 'OWNER')
    throw new GeneralTaskError('FORBIDDEN', 403);
}
export async function readGeneralTask(db: D1Database, ctx: Ctx, taskId: string) {
  const { row } = await load(db, ctx, taskId);
  await authorize(db, ctx, row);
  const writable = row.status === 'OPEN' && !row.customerArchivedAt;
  let allowedUpdate = !!row.canUpdate,
    allowedAssign = !!row.canAssign;
  if (allowedUpdate) {
    try {
      await authorize(db, ctx, row, 'reschedule');
    } catch (error) {
      if (!(error instanceof GeneralTaskError) || error.code !== 'FORBIDDEN') throw error;
      allowedUpdate = false;
    }
  }
  if (allowedAssign) {
    try {
      await authorize(db, ctx, row, 'assign');
    } catch (error) {
      if (!(error instanceof GeneralTaskError) || error.code !== 'FORBIDDEN') throw error;
      allowedAssign = false;
    }
  }
  return {
    kind: 'GENERAL' as const,
    taskId: row.taskId,
    taskVersion: row.taskVersion,
    title: row.title,
    customerId: row.customerId,
    customerName: row.customerName,
    policyId: row.policyId,
    caseId: row.caseId,
    dueAt: row.dueAt,
    assigneeMembershipId: row.assigneeMembershipId,
    status: row.status,
    canReschedule: writable && !row.caseId && allowedUpdate,
    canComplete: writable && !row.caseId && allowedUpdate,
    canAssign:
      writable &&
      allowedAssign &&
      (!row.caseId || (row.caseResult === 'OPEN' && row.caseActiveTask === row.taskId)),
  };
}
function targetGate(alias = 'target') {
  return `${alias}.agency_id=t.agency_id AND ${alias}.status='ACTIVE' AND tu.status='ACTIVE'
    AND EXISTS(SELECT 1 FROM auth_identities ti WHERE ti.user_id=tu.id AND ti.status='ACTIVE')
    AND ${scope(alias, 'task.read', '1=1')}
    AND ${scope(alias, 'customer.read', `c.assignee_membership_id=${alias}.id`)}
    AND (p.id IS NULL OR ${scope(alias, 'policy.read', `p.assignee_membership_id=${alias}.id OR c.assignee_membership_id=${alias}.id`)})
    AND (s.id IS NULL OR ${scope(alias, 'quote.read', `c.assignee_membership_id=${alias}.id`)})
    AND ${sensitive(alias)}`;
}
const optionsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1200).optional(),
});
export async function generalTaskAssignmentOptions(
  db: D1Database,
  ctx: Ctx,
  taskId: string,
  raw: unknown = {},
) {
  const { row, g } = await load(db, ctx, taskId);
  await authorize(db, ctx, row, 'assign');
  if (!row.canAssign) throw new GeneralTaskError('FORBIDDEN', 403);
  if (
    row.status !== 'OPEN' ||
    row.customerArchivedAt ||
    (row.caseId && (row.caseResult !== 'OPEN' || row.caseActiveTask !== row.taskId))
  )
    throw new GeneralTaskError('CONFLICT');
  const q = optionsQuery.parse(raw),
    m = membership(ctx),
    binding = await computePayloadHash({
      taskId,
      taskVersion: row.taskVersion,
      member: m.id,
      user: ctx.userId,
      pver: m.permissionVersion,
      agency: m.agencyId,
      customerId: row.customerId,
      customerAssignee: row.customerAssignee,
      policyId: row.policyId,
      policyAssignee: row.policyAssignee,
      caseId: row.caseId,
      health: row.health,
      limit: q.limit,
    });
  let last = '';
  if (q.cursor) {
    try {
      const parsed = z
        .tuple([z.literal(binding), z.string().min(1).max(128)])
        .parse(JSON.parse(atob(q.cursor)));
      last = parsed[1];
    } catch {
      throw new GeneralTaskError('INVALID_CURSOR', 400);
    }
  }
  const result = await db.batch<{ membershipId: string; displayName: string }>([
    db
      .prepare(
        `SELECT target.id membershipId,coalesce(nullif(trim(tu.display_name),''),target.invitation_email) displayName
     ${joins} JOIN agency_memberships target ON target.agency_id=t.agency_id JOIN users tu ON tu.id=target.user_id
     WHERE ${g.sql} AND ${assignGate} AND ${targetGate()} AND target.id>? ORDER BY target.id LIMIT ?`,
      )
      .bind(...g.args, last, q.limit + 1),
  ]);
  const memberships = result[0]!.results.slice(0, q.limit),
    hasMore = result[0]!.results.length > q.limit;
  return {
    memberships,
    hasMore,
    nextCursor: hasMore ? btoa(JSON.stringify([binding, memberships.at(-1)!.membershipId])) : null,
  };
}
async function proof(db: D1Database, ctx: Ctx, taskId: string, operationId: string) {
  const { row, g } = await load(db, ctx, taskId);
  await authorize(db, ctx, row);
  const results = await db.batch<{
    response_body: string;
    payload_fingerprint: string;
    action: string;
    idempotency_key: string;
    actor_user_id: string;
    actor_membership_id: string;
    response_status: number;
    responseHash: string;
  }>([
    db
      .prepare(
        `SELECT o.response_body,o.payload_fingerprint,o.action,o.idempotency_key,o.actor_user_id,o.actor_membership_id,o.response_status,json_extract(ae.metadata_json,'$.responseHash') responseHash
     ${joins} JOIN operation_receipts o ON o.agency_id=t.agency_id
     JOIN audit_events ae ON ae.agency_id=o.agency_id AND ae.correlation_id=o.id AND ae.action=o.action AND ae.target_type='tasks' AND ae.target_id=t.id
       AND ae.actor_user_id=o.actor_user_id AND ae.actor_membership_id=o.actor_membership_id AND ae.idempotency_key=o.idempotency_key AND ae.outcome='SUCCESS'
     WHERE ${g.sql} AND o.id=? AND o.status='COMPLETED' AND o.action IN ('task.general.reschedule','task.general.complete','task.general.assign')
     AND json_extract(o.response_body,'$.targetId')=t.id`,
      )
      .bind(...g.args, operationId),
  ]);
  if (results[0]!.results.length !== 1) throw new GeneralTaskError('NOT_FOUND', 404);
  const o = results[0]!.results[0]!,
    saved = generalTaskReceiptSchema.parse(JSON.parse(o.response_body)),
    r = saved.result;
  const operationKind = o.action.slice('task.general.'.length);
  const command = (
    operationKind === 'reschedule'
      ? generalRescheduleSchema
      : operationKind === 'complete'
        ? generalCompleteSchema
        : generalAssignSchema
  ).parse(saved.command);
  if (
    r.operationId !== operationId ||
    r.taskId !== taskId ||
    saved.targetId !== taskId ||
    o.response_status !== 200 ||
    r.taskVersion !== saved.command.expectedTaskVersion + 1 ||
    row.taskVersion < r.taskVersion ||
    (operationKind === 'complete' ? r.status !== 'COMPLETED' : r.status !== 'OPEN') ||
    ('dueAt' in command && r.dueAt !== command.dueAt) ||
    ('assigneeMembershipId' in command &&
      r.assigneeMembershipId !== command.assigneeMembershipId) ||
    (await computePayloadHash(r)) !== o.responseHash ||
    (await computePayloadHash({ action: o.action, targetId: taskId, input: saved.command })) !==
      o.payload_fingerprint
  )
    throw new GeneralTaskError('REPLAY_INVALID', 500);
  return { row, o, saved };
}
export async function generalTaskOperation(
  db: D1Database,
  ctx: Ctx,
  taskId: string,
  operationId: string,
) {
  return (await proof(db, ctx, taskId, operationId)).saved.result;
}
export async function writeGeneralTask(
  db: D1Database,
  ctx: Ctx,
  taskId: string,
  kind: Kind,
  raw: unknown,
  key: string,
): Promise<{ data: Result; replayed: boolean }> {
  const input = (
      kind === 'reschedule'
        ? generalRescheduleSchema
        : kind === 'complete'
          ? generalCompleteSchema
          : generalAssignSchema
    ).parse(raw),
    m = membership(ctx),
    action = `task.general.${kind}`,
    hash = await computePayloadHash({ action, targetId: taskId, input });
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
      throw new GeneralTaskError('IDEMPOTENCY_CONFLICT');
    const p = await proof(db, ctx, taskId, receipt.id);
    if (
      receipt.actor_membership_id !== m.id ||
      p.o.actor_user_id !== ctx.userId ||
      p.o.actor_membership_id !== m.id
    )
      throw new GeneralTaskError('REPLAY_INVALID', 500);
    await authorize(db, ctx, p.row, kind);
    const current = await db.batch([
      db
        .prepare(
          `SELECT 1 ${joins} WHERE ${readGate(ctx, taskId).sql} AND ${kind === 'assign' ? assignGate : updateGate}`,
        )
        .bind(...readGate(ctx, taskId).args),
    ]);
    if (!current[0]!.results.length) throw new GeneralTaskError('FORBIDDEN', 403);
    return { data: p.saved.result, replayed: true };
  }
  const { row, g } = await load(db, ctx, taskId);
  if (kind !== 'assign' && row.caseId) throw new GeneralTaskError('CASE_ACTION_REQUIRED');
  await authorize(db, ctx, row, kind);
  if (
    row.status !== 'OPEN' ||
    row.taskVersion !== input.expectedTaskVersion ||
    row.customerArchivedAt ||
    (row.caseId && (row.caseResult !== 'OPEN' || row.caseActiveTask !== taskId))
  )
    throw new GeneralTaskError('CONFLICT');
  if (kind === 'assign' ? !row.canAssign : !row.canUpdate)
    throw new GeneralTaskError('FORBIDDEN', 403);
  const dueAt = 'dueAt' in input ? input.dueAt : row.dueAt,
    assignee =
      'assigneeMembershipId' in input ? input.assigneeMembershipId : row.assigneeMembershipId,
    status = kind === 'complete' ? 'COMPLETED' : 'OPEN',
    now = new Date().toISOString(),
    operationId = crypto.randomUUID();
  const data = generalTaskCommandResultSchema.parse({
    operationId,
    taskId,
    taskVersion: input.expectedTaskVersion + 1,
    dueAt,
    assigneeMembershipId: assignee,
    status,
  });
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${joins} WHERE ${g.sql} AND ${kind === 'assign' ? assignGate : updateGate}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
      )
      .bind(crypto.randomUUID(), ...g.args),
  ];
  if (kind === 'assign')
    statements.push(
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${joins}
     JOIN agency_memberships target ON target.agency_id=t.agency_id JOIN users tu ON tu.id=target.user_id
     WHERE ${g.sql} AND target.id=? AND ${targetGate()}) THEN 1 ELSE 0 END,'BUSINESS_MUTATION_FAILED'`,
        )
        .bind(crypto.randomUUID(), ...g.args, assignee),
    );
  const shape =
    kind === 'assign'
      ? "(s.id IS NULL OR (s.result='OPEN' AND s.active_task_id=t.id))"
      : 's.id IS NULL';
  statements.push(
    db
      .prepare(
        `UPDATE tasks SET due_at=?,assignee_membership_id=?,status=?,completed_at=?,completed_by_membership_id=?,version=version+1,updated_at=?
     WHERE agency_id=? AND id=? AND version=? AND kind='GENERAL' AND renewal_id IS NULL AND status='OPEN'
     AND EXISTS(SELECT 1 ${joins} WHERE ${g.sql} AND t.version=? AND t.due_at=? AND t.assignee_membership_id IS ?
       AND c.archived_at IS NULL AND ${shape})`,
      )
      .bind(
        dueAt,
        assignee,
        status,
        kind === 'complete' ? now : null,
        kind === 'complete' ? m.id : null,
        now,
        m.agencyId,
        taskId,
        input.expectedTaskVersion,
        ...g.args,
        input.expectedTaskVersion,
        row.dueAt,
        row.assigneeMembershipId,
      ),
    db
      .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
      .bind(crypto.randomUUID()),
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
        JSON.stringify({ result: data, command: input, targetId: taskId }),
        now,
        now,
      ),
  );
  const audit = buildSafeAuditRecord({
    agencyId: m.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: m.id,
    action,
    targetType: 'tasks',
    targetId: taskId,
    correlationId: operationId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    metadata: {
      responseHash: await computePayloadHash(data),
      reasonCode: input.reasonCode,
      targetVersion: data.taskVersion,
      changedFields:
        kind === 'assign'
          ? ['assigneeMembershipId']
          : kind === 'complete'
            ? ['status', 'completedAt']
            : ['dueAt'],
    },
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
    if (/MEMBERSHIP_PERMISSION|LOCAL_SESSION/.test(msg))
      throw new GeneralTaskError('FORBIDDEN', 403);
    if (/UNIQUE|OPTIMISTIC|BUSINESS_MUTATION/.test(msg)) {
      try {
        const live = await load(db, ctx, taskId);
        await authorize(db, ctx, live.row, kind);
        if (kind === 'assign' ? !live.row.canAssign : !live.row.canUpdate)
          throw new GeneralTaskError('FORBIDDEN', 403);
      } catch {
        throw new GeneralTaskError('FORBIDDEN', 403);
      }
      const committed = await db
        .prepare(
          'SELECT id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
        )
        .bind(m.agencyId, ctx.userId, key)
        .first();
      if (committed) return writeGeneralTask(db, ctx, taskId, kind, raw, key);
      throw new GeneralTaskError('CONFLICT');
    }
    throw error;
  }
  return { data, replayed: false };
}
