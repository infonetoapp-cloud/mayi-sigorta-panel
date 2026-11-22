import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { salesAdoptSchema, salesResultSchema, type SalesCommandResult } from '../../shared/sales';
import { member, SalesError } from './service';

const action = 'sales.case.adopt';
type Context = AuthenticatedUserContext;
interface AdmissionRow {
  customer_id: string;
  branch_id: string;
  policy_id: string;
  end_date: string;
  data_classification: 'GENERAL' | 'HEALTH';
  renewal_version: number;
  renewal_state: string;
  renewal_assignee: string | null;
  customer_assignee: string | null;
  policy_assignee: string | null;
  task_id: string;
  task_version: number;
  task_assignee: string | null;
  task_status: string;
  due_at: string;
  policy_status: string;
  policy_archived_at: string | null;
  customer_archived_at: string | null;
}
const from = `FROM renewal_opportunities r
 JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
 JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
 JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
 JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.customer_id=c.id AND t.kind='RENEWAL_FOLLOWUP'
 JOIN agency_memberships m ON m.agency_id=r.agency_id
 JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;
const columns = `c.id customer_id,p.branch_id,p.id policy_id,p.end_date,b.data_classification,
 r.version renewal_version,r.state renewal_state,r.assignee_membership_id renewal_assignee,
 c.assignee_membership_id customer_assignee,p.assignee_membership_id policy_assignee,
 t.id task_id,t.version task_version,t.assignee_membership_id task_assignee,t.status task_status,t.due_at,
 p.status policy_status,p.archived_at policy_archived_at,c.archived_at customer_archived_at`;

/** Existing renewal/customer/policy scope resolvers, plus the hard MEMBER own-Task rule. */
function gate(ctx: Context, renewalId: string, customerId: string, taskId: string) {
  const m = member(ctx);
  const predicate: Record<string, string> = {
    'customer.read': 'c.assignee_membership_id=m.id',
    'policy.read': '(p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)',
    'renewal.read': '(r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)',
    'quote.read': '(r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)',
    'quote.manage': '(r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)',
    'task.read': 't.assignee_membership_id=m.id',
  };
  return {
    sql: `r.agency_id=? AND r.id=? AND c.id=? AND t.id=?
      AND m.id=? AND m.user_id=? AND m.type=? AND m.permission_version=?
      AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
      AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
      AND (m.type='OWNER' OR t.assignee_membership_id=m.id)
      AND ${Object.entries(predicate)
        .map(
          ([code, assigned]) =>
            `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code='${code}' AND (x.scope='AGENCY' OR (x.scope='ASSIGNED' AND ${assigned}))))`,
        )
        .join(' AND ')}
      AND ((b.data_classification<>'HEALTH' AND NOT EXISTS(SELECT 1 FROM sales_cases hs WHERE hs.agency_id=r.agency_id AND hs.renewal_id=r.id AND hs.data_classification='HEALTH'))
        OR (EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.read' AND h.scope='UNSCOPED')
          AND EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.write' AND h.scope='UNSCOPED')))`,
    args: [
      m.agencyId,
      renewalId,
      customerId,
      taskId,
      m.id,
      ctx.userId,
      m.type,
      m.permissionVersion,
      ctx.identityId,
    ],
  };
}
async function authorizedRow(
  db: D1Database,
  ctx: Context,
  customerId: string,
  renewalId: string,
  taskId: string,
) {
  const g = gate(ctx, renewalId, customerId, taskId);
  const row = (
    await db.batch<AdmissionRow>([
      db.prepare(`SELECT ${columns} ${from} WHERE ${g.sql}`).bind(...g.args),
    ])
  )[0]!.results[0];
  if (!row) throw new SalesError('NOT_FOUND', 404);
  const resource = {
    agencyId: member(ctx).agencyId,
    assigneeMembershipId: row.policy_assignee,
    customerAssigneeMembershipId: row.customer_assignee,
    renewalAssigneeMembershipId: row.renewal_assignee,
    policyAssigneeMembershipId: row.policy_assignee,
    taskAssigneeMembershipId: row.task_assignee,
    parentReadAuthorized: true,
  };
  for (const code of [
    'customer.read',
    'policy.read',
    'renewal.read',
    'quote.read',
    'quote.manage',
    'task.read',
  ]) {
    const decision = await evaluateAuthorization(db, { context: ctx, action: code, resource });
    if (decision.decision !== 'ALLOW') throw new SalesError('FORBIDDEN', 403);
  }
  return { row, g };
}
const storedReceipt = z.strictObject({
  result: salesResultSchema,
  command: salesAdoptSchema,
  targetId: z.string().min(1).max(128),
});

/** Adopt an existing primary Task. This command never writes tasks or renewal state. */
export async function adoptRenewalCase(
  db: D1Database,
  ctx: Context,
  customerId: string,
  raw: unknown,
  key: string,
): Promise<{ data: SalesCommandResult; replayed: boolean }> {
  const input = salesAdoptSchema.parse(raw),
    m = member(ctx),
    hash = await computePayloadHash({ action, targetId: customerId, input });
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
    const saved = storedReceipt.parse(JSON.parse(receipt.response_body)),
      data = saved.result;
    if (
      receipt.actor_membership_id !== m.id ||
      receipt.status !== 'COMPLETED' ||
      receipt.response_status !== 201 ||
      saved.targetId !== customerId ||
      data.operationId !== receipt.id ||
      (await computePayloadHash({ action, targetId: customerId, input: saved.command })) !== hash ||
      data.taskId !== input.expectedPrimaryTaskId ||
      data.taskVersion !== input.expectedPrimaryTaskVersion ||
      data.caseVersion !== 1
    )
      throw new SalesError('REPLAY_INVALID', 500);
    const { row, g } = await authorizedRow(db, ctx, customerId, input.renewalId, data.taskId);
    if (row.task_version < data.taskVersion) throw new SalesError('REPLAY_INVALID', 500);
    // The historical adopted Task may now be completed or replaced; it is still checked with current authority.
    const proof = await db.batch([
      db
        .prepare(
          `SELECT 1 ${from} JOIN sales_cases s ON s.agency_id=r.agency_id AND s.renewal_id=r.id
       JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=t.id AND l.purpose='ACTIVE_CONTACT'
       JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id AND h.task_id=t.id
       JOIN audit_events ae ON ae.agency_id=s.agency_id AND ae.correlation_id=h.receipt_id
       WHERE ${g.sql} AND s.id=? AND s.context_kind='RENEWAL' AND s.source_policy_id=p.id
       AND h.receipt_id=? AND h.case_version=1 AND h.event_code='ADOPTED'
       AND h.actor_user_id=? AND h.actor_membership_id=?
       AND ae.action=? AND ae.target_type='sales_cases' AND ae.target_id=s.id AND ae.outcome='SUCCESS'
       AND ae.actor_user_id=? AND ae.actor_membership_id=? AND ae.idempotency_key=?
       AND json_extract(ae.metadata_json,'$.responseHash')=?`,
        )
        .bind(
          ...g.args,
          data.caseId,
          receipt.id,
          ctx.userId,
          m.id,
          action,
          ctx.userId,
          m.id,
          key,
          await computePayloadHash(data),
        ),
    ]);
    if (proof[0]!.results.length !== 1) throw new SalesError('REPLAY_INVALID', 500);
    return { data, replayed: true };
  }
  const { row, g } = await authorizedRow(
    db,
    ctx,
    customerId,
    input.renewalId,
    input.expectedPrimaryTaskId,
  );
  if (
    row.renewal_version !== input.expectedVersion ||
    row.task_version !== input.expectedPrimaryTaskVersion ||
    ['WON', 'LOST', 'VOIDED'].includes(row.renewal_state) ||
    row.task_status !== 'OPEN' ||
    row.policy_status !== 'ACTIVE' ||
    row.policy_archived_at ||
    row.customer_archived_at ||
    row.task_assignee !== row.renewal_assignee
  )
    throw new SalesError('CONFLICT');
  if (
    await db
      .prepare('SELECT id FROM sales_cases WHERE agency_id=? AND renewal_id=?')
      .bind(m.agencyId, input.renewalId)
      .first()
  )
    throw new SalesError('RENEWAL_CASE_EXISTS');
  const now = new Date().toISOString(),
    caseId = crypto.randomUUID(),
    operationId = crypto.randomUUID();
  const data: SalesCommandResult = {
    operationId,
    caseId,
    caseVersion: 1,
    taskId: row.task_id,
    taskVersion: row.task_version,
    dueAt: row.due_at,
  };
  const statements = [
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
     SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${from} WHERE ${g.sql}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
      )
      .bind(crypto.randomUUID(), ...g.args),
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual) SELECT ?,1,CASE WHEN EXISTS(
      SELECT 1 ${from} WHERE ${g.sql} AND r.version=? AND t.version=? AND t.due_at=?
      AND r.state NOT IN ('WON','LOST','VOIDED') AND t.status='OPEN'
      AND r.assignee_membership_id IS t.assignee_membership_id
      AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL
      AND p.id=? AND p.branch_id=? AND p.end_date=? AND b.data_classification=?
      AND (SELECT count(*) FROM tasks q WHERE q.agency_id=r.agency_id AND q.renewal_id=r.id AND q.kind='RENEWAL_FOLLOWUP' AND q.status='OPEN')=1
    ) THEN 1 ELSE 0 END`,
      )
      .bind(
        crypto.randomUUID(),
        ...g.args,
        input.expectedVersion,
        input.expectedPrimaryTaskVersion,
        row.due_at,
        row.policy_id,
        row.branch_id,
        row.end_date,
        row.data_classification,
      ),
    db
      .prepare(
        `INSERT INTO sales_cases(id,agency_id,customer_id,branch_id,data_classification,context_kind,renewal_id,source_policy_id,cycle_date,date_basis,result,active_task_id,created_by_user_id,created_by_membership_id,created_at,updated_at)
     VALUES(?,?,?,?,?,'RENEWAL',?,?,?,'KNOWN_END_DATE',NULL,NULL,?,?,?,?)`,
      )
      .bind(
        caseId,
        m.agencyId,
        customerId,
        row.branch_id,
        row.data_classification,
        input.renewalId,
        row.policy_id,
        row.end_date,
        ctx.userId,
        m.id,
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO sales_case_tasks(id,agency_id,case_id,task_id,purpose,created_at) VALUES(?,?,?,?,'ACTIVE_CONTACT',?)",
      )
      .bind(crypto.randomUUID(), m.agencyId, caseId, row.task_id, now),
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
        JSON.stringify({ result: data, command: input, targetId: customerId }),
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,1,'ADOPTED',?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        m.agencyId,
        caseId,
        row.task_id,
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
    const message = String(error);
    let committed: unknown;
    try {
      committed = await db
        .prepare(
          'SELECT id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
        )
        .bind(m.agencyId, ctx.userId, key)
        .first();
    } catch (lookupError) {
      if (
        /MEMBERSHIP_PERMISSION|LOCAL_SESSION|OPTIMISTIC|SESSION|AUTHORIZATION/.test(
          String(lookupError),
        )
      )
        throw new SalesError('FORBIDDEN', 403);
      throw lookupError;
    }
    if (committed && /UNIQUE|OPTIMISTIC|SALES_CASE_INVALID/.test(message))
      return adoptRenewalCase(db, ctx, customerId, raw, key);
    if (/MEMBERSHIP_PERMISSION|LOCAL_SESSION|OPTIMISTIC/.test(message)) {
      try {
        await authorizedRow(db, ctx, customerId, input.renewalId, input.expectedPrimaryTaskId);
      } catch {
        throw new SalesError('FORBIDDEN', 403);
      }
      throw new SalesError('CONFLICT');
    }
    if (message.includes('UNIQUE') && message.includes('sales_cases'))
      throw new SalesError('RENEWAL_CASE_EXISTS');
    if (/SALES_CASE_INVALID|SALES_TASK_LINK_INVALID|SALES_HISTORY_INVALID/.test(message))
      throw new SalesError('CONFLICT');
    throw error;
  }
  return { data, replayed: false };
}
