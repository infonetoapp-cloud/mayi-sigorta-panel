import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { istanbulToday } from '../../shared/customer-profile';
import {
  policyLifecycleRequestSchema,
  policyLifecycleReceiptSchema,
  type PolicyLifecycleContext,
  type PolicyLifecycleResult,
} from '../../shared/policy-cancellation';
import {
  activeMembership,
  loadRenewalTask,
  authorizeCurrentTarget,
  actorAuthorityAssertion,
  completePrimaryTaskStatement,
  casAssertion,
  stateHistoryInsert,
  RenewalCommandError,
  type RenewalTaskRow,
} from '../renewals/commands';

export class PolicyLifecycleError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 409,
  ) {
    super(code);
  }
}
type Kind = 'cancel' | 'void';
interface Parent {
  id: string;
  agency_id: string;
  status: 'ACTIVE' | 'CANCELLED' | 'VOIDED';
  version: number;
  start_date: string;
  end_date: string;
  archived_at: string | null;
  customer_archived_at: string | null;
  assignee_membership_id: string;
  customer_assignee: string;
  data_classification: string;
}
async function authority(
  db: D1Database,
  context: AuthenticatedUserContext,
  id: string,
  write: boolean,
) {
  const active = activeMembership(context);
  const p = await db
    .prepare(
      `SELECT p.id,p.agency_id,p.status,p.version,p.start_date,p.end_date,p.archived_at,p.assignee_membership_id,
    c.assignee_membership_id customer_assignee,c.archived_at customer_archived_at,b.data_classification
    FROM policies p JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id WHERE p.agency_id=? AND p.id=?`,
    )
    .bind(active.agencyId, id)
    .first<Parent>();
  if (!p) throw new PolicyLifecycleError('NOT_FOUND', 404);
  const resource = {
    agencyId: active.agencyId,
    assigneeMembershipId: p.assignee_membership_id,
    customerAssigneeMembershipId: p.customer_assignee,
  };
  const checks: string[] = [],
    bindings: (string | number)[] = [];
  for (const code of ['policy.read', ...(write ? ['policy.update'] : []), 'customer.read']) {
    const result = await evaluateAuthorization(db, {
      context,
      action: code,
      resource:
        code === 'customer.read'
          ? { agencyId: active.agencyId, assigneeMembershipId: p.customer_assignee }
          : resource,
    });
    if (
      result.decision !== 'ALLOW' ||
      !['AGENCY', 'ASSIGNED'].includes(result.effectiveScope ?? '')
    )
      throw new PolicyLifecycleError('FORBIDDEN', 403);
    checks.push(
      `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code=? AND x.scope=?))`,
    );
    bindings.push(code, result.effectiveScope!);
    if (result.effectiveScope === 'ASSIGNED')
      checks.push(
        code === 'customer.read'
          ? 'c.assignee_membership_id=m.id'
          : '(p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)',
      );
  }
  if (p.data_classification === 'HEALTH') {
    for (const code of ['sensitive.health.read', ...(write ? ['sensitive.health.write'] : [])]) {
      const result = await evaluateAuthorization(db, {
        context,
        action: write ? 'policy.health.update' : 'policy.health.read',
        resource,
      });
      if (result.decision !== 'ALLOW') throw new PolicyLifecycleError('FORBIDDEN', 403);
      checks.push(
        `EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code=? AND x.scope='UNSCOPED')`,
      );
      bindings.push(code);
    }
  }
  const sql = `SELECT 1 FROM policies p JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    JOIN agency_memberships m ON m.agency_id=p.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
    JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
    WHERE p.agency_id=? AND p.id=? AND m.id=? AND m.user_id=? AND m.type=? AND m.permission_version=?
      AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' AND b.data_classification=? AND ${checks.join(' AND ')}`;
  const args = [
    context.identityId,
    active.agencyId,
    id,
    active.id,
    context.userId,
    active.type,
    active.permissionVersion,
    p.data_classification,
    ...bindings,
  ];
  const assertion = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(${sql}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(crypto.randomUUID(), ...args);
  return { p, active, assertion };
}
async function targets(db: D1Database, context: AuthenticatedUserContext, p: Parent, kind: Kind) {
  const renewals = await db
    .prepare(
      'SELECT id,state,version FROM renewal_opportunities WHERE agency_id=? AND expiring_policy_id=? LIMIT 2',
    )
    .bind(p.agency_id, p.id)
    .all<{ id: string; state: string; version: number }>();
  if (renewals.results.length > 1) throw new PolicyLifecycleError('WORKFLOW_INCONSISTENT');
  const r = renewals.results[0];
  let row: RenewalTaskRow | null = null;
  if (r) {
    const tasks = await db
      .prepare(
        "SELECT id FROM tasks WHERE agency_id=? AND renewal_id=? AND kind='RENEWAL_FOLLOWUP' AND status='OPEN' LIMIT 2",
      )
      .bind(p.agency_id, r.id)
      .all<{ id: string }>();
    const open = !['WON', 'LOST', 'VOIDED'].includes(r.state);
    if ((open && tasks.results.length !== 1) || (!open && tasks.results.length))
      throw new PolicyLifecycleError('WORKFLOW_INCONSISTENT');
    if (open) {
      row = await loadRenewalTask(db, p.agency_id, r.id, tasks.results[0]!.id);
      if (!row) throw new PolicyLifecycleError('WORKFLOW_INCONSISTENT');
      await authorizeCurrentTarget(
        db,
        context,
        row,
        kind === 'cancel' ? 'renewal.close_lost' : 'renewal.void',
      );
    }
  }
  const expected = row
    ? {
        id: row.renewal_id,
        version: row.renewal_version,
        primaryTaskId: row.task_id,
        taskVersion: row.task_version,
      }
    : undefined;
  const targetSetFingerprint = await computePayloadHash({
    policyId: p.id,
    version: p.version,
    renewal: r ?? null,
    task: expected ?? null,
  });
  return { row, expected, targetSetFingerprint, renewal: r };
}
export async function policyCancellationContext(
  db: D1Database,
  context: AuthenticatedUserContext,
  id: string,
  kind: Kind = 'cancel',
): Promise<PolicyLifecycleContext> {
  const { p, active, assertion } = await authority(db, context, id, true),
    target = await targets(db, context, p, kind);
  const checks = [assertion];
  if (target.row) {
    const action = kind === 'cancel' ? 'renewal.close_lost' : 'renewal.void';
    const scopes = await authorizeCurrentTarget(db, context, target.row, action);
    checks.push(actorAuthorityAssertion(db, context, active, target.row, scopes, action));
  }
  await db.batch(checks);
  const reasons = await db
    .prepare(
      "SELECT id,code,name FROM loss_reasons WHERE agency_id=? AND status='ACTIVE' AND code IN ('VEHICLE_SOLD','PAYMENT_DIFFICULTY','CUSTOMER_REQUEST','OTHER') ORDER BY code",
    )
    .bind(p.agency_id)
    .all<{ id: string; code: string; name: string }>();
  return {
    policyId: id,
    policyVersion: p.version,
    status: p.status,
    startDate: p.start_date,
    endDate: p.end_date,
    eligible: p.status === 'ACTIVE' && !p.archived_at && !p.customer_archived_at,
    targetSetFingerprint: target.targetSetFingerprint,
    ...(target.expected ? { expectedRenewal: target.expected } : {}),
    lossReasons: reasons.results,
  };
}
export async function policyLifecycleHistory(
  db: D1Database,
  context: AuthenticatedUserContext,
  id: string,
) {
  const { p, assertion } = await authority(db, context, id, false);
  const results = await db.batch([
    assertion,
    db
      .prepare(
        `SELECT id,event_date eventDate,reason_code reasonCode,notes,created_at createdAt,'CANCELLED' status FROM policy_cancellations WHERE agency_id=? AND policy_id=?
    UNION ALL SELECT id,event_date,reason_code,notes,created_at,'VOIDED' FROM policy_void_events WHERE agency_id=? AND policy_id=? LIMIT 2`,
      )
      .bind(p.agency_id, id, p.agency_id, id),
  ]);
  return results[1]!.results;
}
export async function executePolicyLifecycle(
  db: D1Database,
  context: AuthenticatedUserContext,
  id: string,
  kind: Kind,
  raw: unknown,
  key: string,
): Promise<{ data: PolicyLifecycleResult; replayed: boolean }> {
  const input = policyLifecycleRequestSchema.parse(raw),
    action = 'policy.' + kind;
  const { p, active, assertion } = await authority(db, context, id, true);
  const fingerprint = await computePayloadHash({ action, policyId: id, input });
  const receipt = await db
    .prepare(
      'SELECT id,action,payload_fingerprint,response_body,actor_membership_id,status,response_status FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
    )
    .bind(active.agencyId, context.userId, key)
    .first<{
      id: string;
      action: string;
      payload_fingerprint: string;
      response_body: string;
      actor_membership_id: string;
      status: string;
      response_status: number;
    }>();
  const table = kind === 'cancel' ? 'policy_cancellations' : 'policy_void_events';
  if (receipt) {
    if (receipt.action !== action || receipt.payload_fingerprint !== fingerprint)
      throw new PolicyLifecycleError('IDEMPOTENCY_CONFLICT');
    const saved = policyLifecycleReceiptSchema.parse(JSON.parse(receipt.response_body));
    const data = saved.result;
    if (
      data.policyId !== id ||
      data.operationId !== receipt.id ||
      receipt.actor_membership_id !== active.id ||
      receipt.status !== 'COMPLETED' ||
      receipt.response_status !== 200 ||
      data.status !== (kind === 'cancel' ? 'CANCELLED' : 'VOIDED') ||
      (await computePayloadHash({ action, policyId: id, input: saved.command })) !== fingerprint
    )
      throw new PolicyLifecycleError('REPLAY_INVALID', 500);
    const event = await db
      .prepare(
        `SELECT id,event_date,reason_code,notes,before_version,actor_user_id,actor_membership_id,created_at FROM ${table} WHERE agency_id=? AND policy_id=? AND id=? AND receipt_id=? AND after_version=?`,
      )
      .bind(active.agencyId, id, data.eventId, receipt.id, data.policyVersion)
      .first<{
        id: string;
        event_date: string;
        reason_code: string;
        notes: string | null;
        before_version: number;
        actor_user_id: string;
        actor_membership_id: string;
        created_at: string;
      }>();
    const proof = await db
      .prepare(
        'SELECT metadata_json FROM audit_events WHERE agency_id=? AND action=? AND target_id=? AND idempotency_key=? AND actor_user_id=?',
      )
      .bind(active.agencyId, action, id, key, context.userId)
      .first<{ metadata_json: string }>();
    if (
      !event ||
      p.status !== data.status ||
      event.before_version !== saved.command.expectedPolicyVersion ||
      event.event_date !== saved.command.cancellationDate ||
      event.reason_code !== saved.command.reasonCode ||
      event.notes !== saved.command.reasonNotes ||
      event.actor_user_id !== context.userId ||
      event.actor_membership_id !== active.id ||
      !proof ||
      JSON.parse(proof.metadata_json).responseHash !== (await computePayloadHash(data))
    )
      throw new PolicyLifecycleError('REPLAY_INVALID', 500);
    const checks = [assertion];
    if (data.closedRenewalId) {
      const row = await loadRenewalTask(
        db,
        active.agencyId,
        data.closedRenewalId,
        data.completedTaskId!,
      );
      if (!row) throw new PolicyLifecycleError('REPLAY_INVALID', 500);
      const completed = await db
        .prepare(
          `SELECT 1 FROM tasks t JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id WHERE t.agency_id=? AND t.id=? AND t.status='COMPLETED' AND t.completed_at=? AND t.completed_by_membership_id=? AND t.version=? AND r.id=? AND r.state=? AND EXISTS(SELECT 1 FROM renewal_state_history h WHERE h.agency_id=r.agency_id AND h.renewal_id=r.id AND h.to_state=r.state AND h.actor_user_id=? AND h.actor_membership_id=? AND h.created_at=?)`,
        )
        .bind(
          active.agencyId,
          data.completedTaskId,
          event.created_at,
          active.id,
          saved.command.expectedRenewal!.taskVersion + 1,
          data.closedRenewalId,
          kind === 'cancel' ? 'LOST' : 'VOIDED',
          context.userId,
          active.id,
          event.created_at,
        )
        .first();
      if (!completed) throw new PolicyLifecycleError('REPLAY_INVALID', 500);
      const links = await db
        .prepare(
          `SELECT renewal_id,task_id,before_version,after_version FROM policy_lifecycle_targets WHERE agency_id=? AND ${kind === 'cancel' ? 'cancellation_id' : 'void_event_id'}=?`,
        )
        .bind(active.agencyId, data.eventId)
        .all<{
          renewal_id: string | null;
          task_id: string | null;
          before_version: number;
          after_version: number;
        }>();
      if (
        links.results.length !== 2 ||
        !links.results.some(
          (l) =>
            l.renewal_id === data.closedRenewalId &&
            l.before_version === saved.command.expectedRenewal?.version &&
            l.after_version === l.before_version + 1,
        ) ||
        !links.results.some(
          (l) =>
            l.task_id === data.completedTaskId &&
            l.before_version === saved.command.expectedRenewal?.taskVersion &&
            l.after_version === l.before_version + 1,
        )
      )
        throw new PolicyLifecycleError('REPLAY_INVALID', 500);
      const scopes = await authorizeCurrentTarget(
        db,
        context,
        row,
        kind === 'cancel' ? 'renewal.close_lost' : 'renewal.void',
      );
      checks.push(
        actorAuthorityAssertion(
          db,
          context,
          active,
          row,
          scopes,
          kind === 'cancel' ? 'renewal.close_lost' : 'renewal.void',
          'task.update',
          scopes.taskUpdate,
          false,
          false,
        ),
      );
    } else if (
      await db
        .prepare(
          `SELECT id FROM policy_lifecycle_targets WHERE agency_id=? AND ${kind === 'cancel' ? 'cancellation_id' : 'void_event_id'}=? LIMIT 1`,
        )
        .bind(active.agencyId, data.eventId)
        .first()
    )
      throw new PolicyLifecycleError('REPLAY_INVALID', 500);
    await db.batch(checks);
    return { data, replayed: true };
  }
  if (p.status !== 'ACTIVE') throw new PolicyLifecycleError('POLICY_ALREADY_TERMINAL');
  if (p.archived_at || p.customer_archived_at) throw new PolicyLifecycleError('POLICY_ARCHIVED');
  if (p.version !== input.expectedPolicyVersion)
    throw new PolicyLifecycleError('OPTIMISTIC_CONCURRENCY_CONFLICT');
  if (
    input.cancellationDate > istanbulToday() ||
    (kind === 'cancel' &&
      (input.cancellationDate < p.start_date || input.cancellationDate > p.end_date))
  )
    throw new PolicyLifecycleError('POLICY_CANCELLATION_DATE_INVALID', 400);
  const allowed =
    kind === 'cancel'
      ? ['VEHICLE_SOLD', 'PAYMENT_DIFFICULTY', 'CUSTOMER_REQUEST', 'OTHER']
      : ['DUPLICATE', 'TECHNICAL_ERROR'];
  if (!allowed.includes(input.reasonCode) || (input.reasonCode === 'OTHER' && !input.reasonNotes))
    throw new PolicyLifecycleError('CANCELLATION_REASON_INVALID', 400);
  const target = await targets(db, context, p, kind);
  if (
    target.targetSetFingerprint !== input.targetSetFingerprint ||
    JSON.stringify(target.expected) !== JSON.stringify(input.expectedRenewal)
  )
    throw new PolicyLifecycleError('TARGET_SET_CHANGED');
  let lossReason: { id: string; code: string } | null = null;
  if (target.row && kind === 'cancel') {
    if (!input.lossReasonId) throw new PolicyLifecycleError('LOSS_REASON_REQUIRED', 400);
    lossReason = await db
      .prepare("SELECT id,code FROM loss_reasons WHERE agency_id=? AND id=? AND status='ACTIVE'")
      .bind(active.agencyId, input.lossReasonId)
      .first();
    if (!lossReason || lossReason.code !== input.reasonCode)
      throw new PolicyLifecycleError('LOSS_REASON_MISMATCH', 400);
  }
  const now = new Date().toISOString(),
    operationId = crypto.randomUUID(),
    eventId = crypto.randomUUID(),
    status = kind === 'cancel' ? 'CANCELLED' : 'VOIDED';
  const data: PolicyLifecycleResult = {
    operationId,
    eventId,
    policyId: id,
    policyVersion: p.version + 1,
    status,
    closedRenewalId: target.row?.renewal_id ?? null,
    completedTaskId: target.row?.task_id ?? null,
  };
  const batch: D1PreparedStatement[] = [assertion];
  // The target set is rechecked inside the same transaction, including cron insert races.
  batch.push(
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,
    CASE WHEN (SELECT count(*) FROM renewal_opportunities WHERE agency_id=? AND expiring_policy_id=?)=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM renewal_opportunities WHERE agency_id=? AND expiring_policy_id=? AND id=? AND version=? AND state=?))
      AND (SELECT count(*) FROM tasks t JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id WHERE r.agency_id=? AND r.expiring_policy_id=? AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN')=?
    THEN 1 ELSE 0 END,'TARGET_SET_CHANGED'`,
      )
      .bind(
        crypto.randomUUID(),
        active.agencyId,
        id,
        target.renewal ? 1 : 0,
        target.renewal?.id ?? null,
        active.agencyId,
        id,
        target.renewal?.id ?? null,
        target.renewal?.version ?? 0,
        target.renewal?.state ?? null,
        active.agencyId,
        id,
        target.row ? 1 : 0,
      ),
  );
  if (target.row) {
    const row = target.row,
      terminalAction = kind === 'cancel' ? 'renewal.close_lost' : 'renewal.void';
    const scopes = await authorizeCurrentTarget(db, context, row, terminalAction);
    batch.push(actorAuthorityAssertion(db, context, active, row, scopes, terminalAction));
    if (lossReason)
      batch.push(
        db
          .prepare(
            `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 FROM loss_reasons WHERE agency_id=? AND id=? AND code=? AND status='ACTIVE') THEN 1 ELSE 0 END,'LOSS_REASON_MISMATCH'`,
          )
          .bind(crypto.randomUUID(), active.agencyId, lossReason.id, input.reasonCode),
      );
    batch.push(
      completePrimaryTaskStatement(db, active, row, now),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
    );
    batch.push(
      db
        .prepare(
          `UPDATE renewal_opportunities SET state=?,loss_reason_id=?,loss_reason_notes=?,void_reason_code=?,closed_at=?,closed_by_membership_id=?,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND closed_at IS NULL AND state NOT IN ('WON','LOST','VOIDED')`,
        )
        .bind(
          kind === 'cancel' ? 'LOST' : 'VOIDED',
          lossReason?.id ?? null,
          lossReason?.code === 'OTHER' ? input.reasonNotes : null,
          kind === 'void' ? input.reasonCode : null,
          now,
          active.id,
          now,
          active.agencyId,
          row.renewal_id,
          row.renewal_version,
        ),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
    );
    batch.push(
      stateHistoryInsert(
        db,
        context,
        active,
        row,
        kind === 'cancel' ? 'LOST' : 'VOIDED',
        kind === 'cancel' ? 'LOST' : input.reasonCode,
        now,
        {
          lossReasonId: lossReason?.id ?? null,
          lossReasonNotes: lossReason?.code === 'OTHER' ? input.reasonNotes : null,
          voidReasonCode: kind === 'void' ? input.reasonCode : null,
        },
      ),
    );
  }
  batch.push(
    db
      .prepare(
        `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body) VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?)`,
      )
      .bind(
        operationId,
        active.agencyId,
        context.userId,
        active.id,
        action,
        key,
        fingerprint,
        JSON.stringify({ result: data, command: input }),
      ),
  );
  batch.push(
    db
      .prepare(
        `INSERT INTO ${table}(id,agency_id,policy_id,before_version,after_version,event_date,reason_code,notes,loss_reason_id,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        eventId,
        active.agencyId,
        id,
        p.version,
        p.version + 1,
        input.cancellationDate,
        input.reasonCode,
        input.reasonNotes,
        lossReason?.id ?? null,
        context.userId,
        active.id,
        operationId,
        now,
      ),
  );
  batch.push(
    db
      .prepare(
        "UPDATE policies SET status=?,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND status='ACTIVE' AND archived_at IS NULL AND EXISTS(SELECT 1 FROM customers c WHERE c.agency_id=policies.agency_id AND c.id=policies.customer_id AND c.archived_at IS NULL)",
      )
      .bind(status, now, active.agencyId, id, p.version),
    casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
  );
  if (target.row) {
    for (const [column, value, version] of [
      ['renewal_id', target.row.renewal_id, target.row.renewal_version],
      ['task_id', target.row.task_id, target.row.task_version],
    ] as const) {
      batch.push(
        db
          .prepare(
            `INSERT INTO policy_lifecycle_targets(id,agency_id,cancellation_id,void_event_id,${column},before_version,after_version) VALUES(?,?,?,?,?,?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            active.agencyId,
            kind === 'cancel' ? eventId : null,
            kind === 'void' ? eventId : null,
            value,
            version,
            version + 1,
          ),
      );
    }
  }
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action,
    targetType: 'policies',
    targetId: id,
    correlationId: operationId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    metadata: { reasonCode: input.reasonCode, responseHash: await computePayloadHash(data) },
    createdAt: now,
  });
  batch.push(
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
    await db.batch(batch);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE constraint failed: operation_receipts|operation_receipts_idem_uq/.test(message))
      return executePolicyLifecycle(db, context, id, kind, raw, key);
    if (/MEMBERSHIP_PERMISSION_NOT_FOUND|LOCAL_SESSION_REVOKED/.test(message))
      throw new PolicyLifecycleError('FORBIDDEN', 403);
    if (
      /TARGET_SET_CHANGED|OPTIMISTIC_CONCURRENCY_CONFLICT|LOSS_REASON_MISMATCH|POLICY_LIFECYCLE_EVIDENCE_INVALID|POLICY_LIFECYCLE_COMMAND_REQUIRED/.test(
        message,
      )
    ) {
      // The installed shared CAS trigger collapses unknown failure codes (including
      // the request session guard) to concurrency conflict. Recheck live authority
      // before classifying it as a changed record, without granting or retrying.
      await authority(db, context, id, true);
      const committed = await db
        .prepare(
          'SELECT id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
        )
        .bind(active.agencyId, context.userId, key)
        .first();
      if (committed) return executePolicyLifecycle(db, context, id, kind, raw, key);
      throw new PolicyLifecycleError('TARGET_SET_CHANGED');
    }
    throw error;
  }
  return { data, replayed: false };
}
export { RenewalCommandError };
