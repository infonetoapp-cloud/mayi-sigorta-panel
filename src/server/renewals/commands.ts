import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { evaluateAuthorization, type EffectiveScope } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import {
  closeRenewalLostSchema,
  type CloseRenewalLostInput,
  reopenRenewalSchema,
  type ReopenRenewalInput,
  type VoidRenewalInput,
  voidRenewalSchema,
} from './validation';

const CLOSE_LOST_ACTION = 'renewal.close_lost';
const VOID_ACTION = 'renewal.void';
const REOPEN_ACTION = 'renewal.reopen';
type RecordScope = Extract<EffectiveScope, 'ASSIGNED' | 'AGENCY'>;
type OpenRenewalState =
  'CONTACT_PENDING' | 'CONTACTED' | 'QUOTE_PREPARING' | 'QUOTE_SENT' | 'AWAITING_RESPONSE';

type ActiveMembership = {
  id: string;
  agencyId: string;
  type: 'OWNER' | 'MEMBER';
  status: 'ACTIVE';
  permissionVersion: number;
};

type RenewalTaskRow = {
  agency_id: string;
  renewal_id: string;
  renewal_state: string;
  renewal_version: number;
  renewal_assignee_membership_id: string | null;
  renewal_closed_at: string | null;
  renewal_closed_by_membership_id: string | null;
  policy_id: string;
  policy_status: string;
  policy_archived_at: string | null;
  policy_assignee_membership_id: string | null;
  branch_data_classification: 'GENERAL' | 'HEALTH';
  customer_id: string;
  customer_archived_at: string | null;
  customer_assignee_membership_id: string;
  task_id: string;
  task_kind: 'RENEWAL_FOLLOWUP';
  task_status: 'OPEN' | 'COMPLETED';
  task_version: number;
  task_assignee_membership_id: string | null;
  task_completed_at: string | null;
};

type ReceiptRow = {
  action: string;
  payload_fingerprint: string;
  status: string;
  response_status: number | null;
  response_body: string | null;
};

export interface RenewalLostResult {
  readonly renewalId: string;
  readonly previousState: string;
  readonly state: 'LOST';
  readonly lossReasonId: string;
  readonly primaryTaskId: string;
  readonly renewalVersion: number;
  readonly taskVersion: number;
  readonly closedAt: string;
}

export interface RenewalVoidResult {
  readonly renewalId: string;
  readonly previousState: string;
  readonly state: 'VOIDED';
  readonly voidReasonCode: string;
  readonly primaryTaskId: string;
  readonly renewalVersion: number;
  readonly taskVersion: number;
  readonly closedAt: string;
}

export interface RenewalReopenResult {
  readonly renewalId: string;
  readonly previousState: 'LOST' | 'VOIDED';
  readonly state: OpenRenewalState;
  readonly closedTaskId: string;
  readonly closedTaskVersion: number;
  readonly terminalClosedAt: string;
  readonly primaryTaskId: string;
  readonly renewalVersion: number;
  readonly taskVersion: 1;
  readonly reopenedAt: string;
}

export class RenewalCommandError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 500;

  constructor(code: string, status: 400 | 403 | 404 | 409 | 500 = 409) {
    super(code);
    this.name = 'RenewalCommandError';
    this.code = code;
    this.status = status;
  }
}

function activeMembership(context: AuthenticatedUserContext): ActiveMembership {
  const active = context.memberships[0];
  if (!active || active.status !== 'ACTIVE') throw new RenewalCommandError('FORBIDDEN', 403);
  return active as ActiveMembership;
}

function requireScope(scope: EffectiveScope | null | undefined): RecordScope {
  if (scope !== 'ASSIGNED' && scope !== 'AGENCY') {
    throw new RenewalCommandError('FORBIDDEN', 403);
  }
  return scope;
}

async function authorize(
  db: D1Database,
  context: AuthenticatedUserContext,
  action: string,
  resource: Record<string, unknown>,
): Promise<RecordScope> {
  const result = await evaluateAuthorization(db, { context, action, resource });
  if (result.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
  return requireScope(result.effectiveScope);
}

async function loadRenewalTask(
  db: D1Database,
  agencyId: string,
  renewalId: string,
  taskId?: string,
): Promise<RenewalTaskRow | null> {
  const taskPredicate = taskId ? 'AND t.id=?' : '';
  const order = taskId
    ? ''
    : "ORDER BY CASE WHEN t.status='OPEN' THEN 0 ELSE 1 END,t.updated_at DESC,t.id DESC";
  const statement = db.prepare(
    `SELECT r.agency_id,r.id AS renewal_id,r.state AS renewal_state,r.version AS renewal_version,
        r.assignee_membership_id AS renewal_assignee_membership_id,r.closed_at AS renewal_closed_at,
        r.closed_by_membership_id AS renewal_closed_by_membership_id,
        p.id AS policy_id,p.status AS policy_status,p.archived_at AS policy_archived_at,
        p.assignee_membership_id AS policy_assignee_membership_id,
        b.data_classification AS branch_data_classification,
        c.id AS customer_id,c.archived_at AS customer_archived_at,
        c.assignee_membership_id AS customer_assignee_membership_id,
        t.id AS task_id,t.kind AS task_kind,t.status AS task_status,t.version AS task_version,
        t.assignee_membership_id AS task_assignee_membership_id,t.completed_at AS task_completed_at
     FROM renewal_opportunities r
     JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
     JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
     JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
     JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id
       AND t.customer_id=c.id AND t.kind='RENEWAL_FOLLOWUP'
     WHERE r.agency_id=? AND r.id=? ${taskPredicate}
     ${order}
     LIMIT 1`,
  );
  return (
    taskId ? statement.bind(agencyId, renewalId, taskId) : statement.bind(agencyId, renewalId)
  ).first<RenewalTaskRow>();
}

function renewalResource(row: RenewalTaskRow): Record<string, unknown> {
  return {
    agencyId: row.agency_id,
    renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
    customerAssigneeMembershipId: row.customer_assignee_membership_id,
  };
}

function policyResource(row: RenewalTaskRow): Record<string, unknown> {
  return {
    agencyId: row.agency_id,
    assigneeMembershipId: row.policy_assignee_membership_id,
    customerAssigneeMembershipId: row.customer_assignee_membership_id,
  };
}

function taskResource(row: RenewalTaskRow): Record<string, unknown> {
  return {
    ...renewalResource(row),
    taskAssigneeMembershipId: row.task_assignee_membership_id,
    policyAssigneeMembershipId: row.policy_assignee_membership_id,
    parentReadAuthorized: true,
  };
}

interface AuthorizationScopes {
  readonly customerRead: RecordScope;
  readonly policyRead: RecordScope;
  readonly renewalRead: RecordScope;
  readonly taskRead: RecordScope;
  readonly taskUpdate: RecordScope;
  readonly terminalAction: RecordScope;
}

async function authorizeCurrentTarget(
  db: D1Database,
  context: AuthenticatedUserContext,
  row: RenewalTaskRow,
  terminalAction = CLOSE_LOST_ACTION,
): Promise<AuthorizationScopes> {
  const parent = renewalResource(row);
  const policy = policyResource(row);
  const customer = {
    agencyId: row.agency_id,
    assigneeMembershipId: row.customer_assignee_membership_id,
  };
  const customerRead = await authorize(db, context, 'customer.read', customer);
  const policyRead = await authorize(
    db,
    context,
    row.branch_data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
    policy,
  );
  const renewalRead = await authorize(db, context, 'renewal.read', parent);
  const task = taskResource(row);
  const taskRead = await authorize(db, context, 'task.read', task);
  const taskUpdate = await authorize(db, context, 'task.update', task);
  const actionScope = await authorize(db, context, terminalAction, parent);
  return {
    customerRead,
    policyRead,
    renewalRead,
    taskRead,
    taskUpdate,
    terminalAction: actionScope,
  };
}

interface ReopenAuthorizationScopes {
  readonly customerRead: RecordScope;
  readonly policyRead: RecordScope;
  readonly renewalRead: RecordScope;
  readonly taskRead: RecordScope;
  readonly taskCreate: RecordScope;
  readonly reopen: RecordScope;
}

async function authorizeReopenTarget(
  db: D1Database,
  context: AuthenticatedUserContext,
  row: RenewalTaskRow,
): Promise<ReopenAuthorizationScopes> {
  const parent = renewalResource(row);
  const policy = policyResource(row);
  const customerRead = await authorize(db, context, 'customer.read', {
    agencyId: row.agency_id,
    assigneeMembershipId: row.customer_assignee_membership_id,
  });
  const policyRead = await authorize(
    db,
    context,
    row.branch_data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
    policy,
  );
  const renewalRead = await authorize(db, context, 'renewal.read', parent);
  const task = taskResource(row);
  const taskRead = await authorize(db, context, 'task.read', task);
  const taskCreate = await authorize(db, context, 'task.create', task);
  const reopen = await authorize(db, context, REOPEN_ACTION, parent);
  return { customerRead, policyRead, renewalRead, taskRead, taskCreate, reopen };
}

async function readReceipt(
  db: D1Database,
  active: ActiveMembership,
  actorUserId: string,
  idempotencyKey: string,
): Promise<ReceiptRow | null> {
  return db
    .prepare(
      `SELECT action,payload_fingerprint,status,response_status,response_body
       FROM operation_receipts
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
    )
    .bind(active.agencyId, actorUserId, active.id, idempotencyKey)
    .first<ReceiptRow>();
}

function receiptTaskId(receipt: ReceiptRow | null): string | undefined {
  if (!receipt || typeof receipt.response_body !== 'string') return undefined;
  try {
    const body = JSON.parse(receipt.response_body) as Record<string, unknown>;
    return typeof body.primaryTaskId === 'string' ? body.primaryTaskId : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseLostReceipt(
  raw: string | null,
  input: CloseRenewalLostInput,
  renewalId: string,
  taskId: string,
): RenewalLostResult {
  if (!raw) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const result = body as Record<string, unknown>;
  const keys = [
    'renewalId',
    'previousState',
    'state',
    'lossReasonId',
    'primaryTaskId',
    'renewalVersion',
    'taskVersion',
    'closedAt',
  ];
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(result, key)) ||
    result.renewalId !== renewalId ||
    result.primaryTaskId !== taskId ||
    result.state !== 'LOST' ||
    result.lossReasonId !== input.lossReasonId ||
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(String(result.previousState)) ||
    result.renewalVersion !== input.expectedRenewalVersion + 1 ||
    result.taskVersion !== input.expectedTaskVersion + 1 ||
    !isCanonicalTimestamp(result.closedAt)
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return result as unknown as RenewalLostResult;
}

async function fingerprint(renewalId: string, input: CloseRenewalLostInput): Promise<string> {
  return computePayloadHash({
    action: CLOSE_LOST_ACTION,
    target: renewalId,
    payload: input,
    version: {
      expectedRenewalVersion: input.expectedRenewalVersion,
      expectedTaskVersion: input.expectedTaskVersion,
    },
  });
}

function casAssertion(db: D1Database, failureCode: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,changes(),?`,
    )
    .bind(crypto.randomUUID(), failureCode);
}

interface LiveAuthorityPredicate {
  readonly sql: string;
  readonly bindings: readonly (string | number)[];
}

function actorAuthorityPredicate(
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
  terminalAction: typeof CLOSE_LOST_ACTION | typeof VOID_ACTION | typeof REOPEN_ACTION,
  taskPermission: 'task.update' | 'task.create' = 'task.update',
  taskPermissionScope: RecordScope = scopes.taskUpdate,
  requireActiveParents = true,
  requireAssignmentConsistency = true,
): LiveAuthorityPredicate {
  const parentLifecyclePredicate = requireActiveParents
    ? "AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL"
    : '';
  const assignmentConsistencyPredicate = requireAssignmentConsistency
    ? 'AND r.assignee_membership_id IS t.assignee_membership_id'
    : '';
  const taskPermissionPredicate =
    taskPermission === 'task.create'
      ? `EXISTS (
           SELECT 1 FROM membership_permissions task_create
           WHERE task_create.membership_id=m.id
             AND task_create.permission_code='task.create' AND task_create.scope='UNSCOPED'
         ) AND ?=?`
      : `EXISTS (
           SELECT 1 FROM membership_permissions task_update
           JOIN membership_permissions task_dependency
             ON task_dependency.membership_id=task_update.membership_id
            AND task_dependency.permission_code='task.read'
           WHERE task_update.membership_id=m.id AND task_update.permission_code='task.update'
             AND task_update.scope=? AND task_dependency.scope=?
             AND NOT (task_update.scope='AGENCY' AND task_dependency.scope='ASSIGNED')
         )`;
  return {
    sql: `SELECT 1 FROM agency_memberships m
          JOIN users u ON u.id=m.user_id
          JOIN agencies a ON a.id=m.agency_id
          JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
          JOIN renewal_opportunities r ON r.agency_id=m.agency_id AND r.id=?
          JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.id=?
          JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
          JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
          JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id AND c.id=t.customer_id
          WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
            AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
            ${assignmentConsistencyPredicate}
            AND t.kind='RENEWAL_FOLLOWUP'
            ${parentLifecyclePredicate}
            AND (b.data_classification<>'HEALTH' OR EXISTS(
              SELECT 1 FROM membership_permissions health
              WHERE health.membership_id=m.id
                AND health.permission_code='sensitive.health.read' AND health.scope='UNSCOPED'
            ))
            AND (m.type='OWNER' OR (
              EXISTS (
                SELECT 1 FROM membership_permissions action_grant
                JOIN membership_permissions renewal_dependency
                  ON renewal_dependency.membership_id=action_grant.membership_id
                 AND renewal_dependency.permission_code='renewal.read'
                WHERE action_grant.membership_id=m.id AND action_grant.permission_code=?
                  AND action_grant.scope=? AND renewal_dependency.scope=?
                  AND NOT (action_grant.scope='AGENCY' AND renewal_dependency.scope='ASSIGNED')
              )
              AND EXISTS(SELECT 1 FROM membership_permissions x
                WHERE x.membership_id=m.id AND x.permission_code='customer.read' AND x.scope=?)
              AND EXISTS(SELECT 1 FROM membership_permissions x
                WHERE x.membership_id=m.id AND x.permission_code='renewal.read' AND x.scope=?)
              AND EXISTS(SELECT 1 FROM membership_permissions x
                WHERE x.membership_id=m.id AND x.permission_code='policy.read' AND x.scope=?)
              AND EXISTS(SELECT 1 FROM membership_permissions x
                WHERE x.membership_id=m.id AND x.permission_code='task.read' AND x.scope=?)
              AND (${taskPermissionPredicate})
              AND (?='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)
              AND (?='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)
              AND (?='AGENCY' OR c.assignee_membership_id=m.id)
              AND (?='AGENCY' OR p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)
              AND (?='AGENCY' OR t.assignee_membership_id=m.id)
              AND (?='AGENCY' OR t.assignee_membership_id=m.id)
            ))`,
    bindings: [
      context.identityId,
      row.renewal_id,
      row.task_id,
      active.id,
      active.agencyId,
      context.userId,
      active.permissionVersion,
      terminalAction,
      scopes.terminalAction,
      scopes.renewalRead,
      scopes.customerRead,
      scopes.renewalRead,
      scopes.policyRead,
      scopes.taskRead,
      taskPermissionScope,
      scopes.taskRead,
      scopes.terminalAction,
      scopes.renewalRead,
      scopes.customerRead,
      scopes.policyRead,
      scopes.taskRead,
      taskPermissionScope,
    ],
  };
}

function actorAuthorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
  terminalAction: typeof CLOSE_LOST_ACTION | typeof VOID_ACTION | typeof REOPEN_ACTION,
  taskPermission: 'task.update' | 'task.create' = 'task.update',
  taskPermissionScope: RecordScope = scopes.taskUpdate,
  requireActiveParents = true,
  requireAssignmentConsistency = true,
): D1PreparedStatement {
  const authority = actorAuthorityPredicate(
    context,
    active,
    row,
    scopes,
    terminalAction,
    taskPermission,
    taskPermissionScope,
    requireActiveParents,
    requireAssignmentConsistency,
  );
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(crypto.randomUUID(), ...authority.bindings);
}

function lossReasonAssertion(
  db: D1Database,
  active: ActiveMembership,
  input: CloseRenewalLostInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM loss_reasons
         WHERE agency_id=? AND id=? AND status='ACTIVE'
           AND ((code='OTHER' AND ? IS NOT NULL) OR (code<>'OTHER' AND ? IS NULL))
       ) THEN 1 ELSE 0 END,'BUSINESS_MUTATION_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      active.agencyId,
      input.lossReasonId,
      input.lossReasonNotes,
      input.lossReasonNotes,
    );
}

function receiptInsert(
  db: D1Database,
  active: ActiveMembership,
  context: AuthenticatedUserContext,
  idempotencyKey: string,
  action: typeof CLOSE_LOST_ACTION | typeof VOID_ACTION | typeof REOPEN_ACTION,
  payloadFingerprint: string,
  result: unknown,
  receiptAt: string,
): D1PreparedStatement {
  const body = JSON.stringify(result);
  return db
    .prepare(
      `INSERT INTO operation_receipts
         (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
          payload_fingerprint,status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      active.agencyId,
      context.userId,
      active.id,
      action,
      idempotencyKey,
      payloadFingerprint,
      body,
      receiptAt,
      receiptAt,
    );
}

function completePrimaryTaskStatement(
  db: D1Database,
  active: ActiveMembership,
  row: RenewalTaskRow,
  closedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tasks SET status='COMPLETED',completed_at=?,completed_by_membership_id=?,
          version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND renewal_id=? AND kind='RENEWAL_FOLLOWUP'
         AND status='OPEN' AND version=? AND assignee_membership_id IS ?
         AND EXISTS(
           SELECT 1 FROM renewal_opportunities r
           WHERE r.agency_id=tasks.agency_id AND r.id=tasks.renewal_id
             AND r.state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
             AND r.closed_at IS NULL AND r.version=?
             AND r.assignee_membership_id IS tasks.assignee_membership_id
         )`,
    )
    .bind(
      closedAt,
      active.id,
      closedAt,
      active.agencyId,
      row.task_id,
      row.renewal_id,
      row.task_version,
      row.task_assignee_membership_id,
      row.renewal_version,
    );
}

function closeRenewalStatement(
  db: D1Database,
  active: ActiveMembership,
  row: RenewalTaskRow,
  input: CloseRenewalLostInput,
  closedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE renewal_opportunities
       SET state='LOST',loss_reason_id=?,loss_reason_notes=?,void_reason_code=NULL,
           closed_at=?,closed_by_membership_id=?,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND version=?
         AND state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE') AND closed_at IS NULL
         AND assignee_membership_id IS ?
         AND EXISTS(
           SELECT 1 FROM tasks t
           WHERE t.agency_id=renewal_opportunities.agency_id AND t.renewal_id=renewal_opportunities.id
             AND t.id=? AND t.kind='RENEWAL_FOLLOWUP' AND t.status='COMPLETED'
             AND t.version=? AND t.completed_at=? AND t.completed_by_membership_id=?
         )
         AND EXISTS(SELECT 1 FROM loss_reasons l
           WHERE l.agency_id=renewal_opportunities.agency_id AND l.id=? AND l.status='ACTIVE'
             AND ((l.code='OTHER' AND ? IS NOT NULL) OR (l.code<>'OTHER' AND ? IS NULL)))`,
    )
    .bind(
      input.lossReasonId,
      input.lossReasonNotes,
      closedAt,
      active.id,
      closedAt,
      active.agencyId,
      row.renewal_id,
      row.renewal_version,
      row.renewal_assignee_membership_id,
      row.task_id,
      row.task_version + 1,
      closedAt,
      active.id,
      input.lossReasonId,
      input.lossReasonNotes,
      input.lossReasonNotes,
    );
}

function stateHistoryInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  state: OpenRenewalState | 'LOST' | 'VOIDED',
  reasonCode: string,
  closedAt: string,
  evidence: {
    readonly lossReasonId: string | null;
    readonly lossReasonNotes: string | null;
    readonly voidReasonCode: string | null;
  } = { lossReasonId: null, lossReasonNotes: null, voidReasonCode: null },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
          actor_membership_id,reason_code,created_at,loss_reason_id,loss_reason_notes,void_reason_code)
       VALUES(?,?,?,?,?,'USER',?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      active.agencyId,
      row.renewal_id,
      row.renewal_state,
      state,
      context.userId,
      active.id,
      reasonCode,
      closedAt,
      evidence.lossReasonId,
      evidence.lossReasonNotes,
      evidence.voidReasonCode,
    );
}

function auditInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  input: CloseRenewalLostInput,
  idempotencyKey: string,
  closedAt: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action: 'renewal.closed_lost',
    targetType: 'renewal_opportunities',
    targetId: row.renewal_id,
    correlationId: idempotencyKey,
    idempotencyKey,
    outcome: 'SUCCESS',
    createdAt: closedAt,
    metadata: {
      reasonCode: 'LOST',
      lossReasonId: input.lossReasonId,
      changedFields: ['state', 'loss_reason_id', 'closed_at', 'primary_task_status'],
    },
  });
  return db
    .prepare(
      `INSERT INTO audit_events
         (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
          correlation_id,idempotency_key,outcome,metadata_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    );
}

async function assertLostReplay(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
  input: CloseRenewalLostInput,
  result: RenewalLostResult,
  idempotencyKey: string,
): Promise<void> {
  const authority = actorAuthorityPredicate(
    context,
    active,
    row,
    scopes,
    CLOSE_LOST_ACTION,
    'task.update',
    scopes.taskUpdate,
    false,
    false,
  );
  const proof = await db
    .prepare(
      `SELECT CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END AS authority_count,
         (SELECT count(*) FROM tasks t
          WHERE t.agency_id=? AND t.id=? AND t.renewal_id=? AND t.kind='RENEWAL_FOLLOWUP'
            AND t.status='COMPLETED' AND t.completed_at=? AND t.completed_by_membership_id=?
            AND t.version=?) AS task_count,
         (SELECT count(*) FROM renewal_state_history h
          WHERE h.agency_id=? AND h.renewal_id=? AND h.from_state=? AND h.to_state='LOST'
            AND h.actor_user_id=? AND h.actor_membership_id=? AND h.reason_code='LOST'
            AND h.created_at=? AND h.loss_reason_id=? AND h.loss_reason_notes IS ?
            AND h.void_reason_code IS NULL) AS history_count,
         (SELECT count(*) FROM audit_events a
          WHERE a.agency_id=? AND a.actor_user_id=? AND a.actor_membership_id=?
            AND a.action='renewal.closed_lost' AND a.target_type='renewal_opportunities'
            AND a.target_id=? AND a.idempotency_key=? AND a.outcome='SUCCESS'
            AND a.created_at=? AND json_extract(a.metadata_json,'$.lossReasonId')=?) AS audit_count`,
    )
    .bind(
      ...authority.bindings,
      active.agencyId,
      result.primaryTaskId,
      result.renewalId,
      result.closedAt,
      active.id,
      result.taskVersion,
      active.agencyId,
      result.renewalId,
      result.previousState,
      context.userId,
      active.id,
      result.closedAt,
      input.lossReasonId,
      input.lossReasonNotes,
      active.agencyId,
      context.userId,
      active.id,
      result.renewalId,
      idempotencyKey,
      result.closedAt,
      result.lossReasonId,
    )
    .first<{
      authority_count: number;
      task_count: number;
      history_count: number;
      audit_count: number;
    }>();
  if (
    !proof ||
    proof.authority_count !== 1 ||
    proof.task_count !== 1 ||
    proof.history_count < 1 ||
    proof.audit_count !== 1
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

function parseReceiptResult(
  receipt: ReceiptRow,
  expectedFingerprint: string,
  input: CloseRenewalLostInput,
  renewalId: string,
  taskId: string,
): RenewalLostResult {
  if (
    receipt.action !== CLOSE_LOST_ACTION ||
    receipt.payload_fingerprint !== expectedFingerprint ||
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 200
  ) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  return parseLostReceipt(receipt.response_body, input, renewalId, taskId);
}

function isReceiptRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('operation_receipts_idem_uq') ||
    message.includes('UNIQUE constraint failed: operation_receipts') ||
    message.includes('IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN')
  );
}

function mapBatchError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MEMBERSHIP_PERMISSION_NOT_FOUND')) {
    throw new RenewalCommandError('FORBIDDEN', 403);
  }
  if (message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT')) {
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  }
  if (message.includes('BUSINESS_MUTATION_FAILED')) {
    throw new RenewalCommandError('LOSS_REASON_NOT_ACTIVE', 409);
  }
  if (message.includes('operation_receipts')) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  throw error;
}

export async function closeRenewalLost(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawIdempotencyKey: string,
): Promise<{ data: RenewalLostResult; replayed: boolean }> {
  const active = activeMembership(context);
  const input = closeRenewalLostSchema.parse(rawInput);
  const idempotencyKey = rawIdempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  }
  const payloadFingerprint = await fingerprint(renewalId, input);
  const receipt = await readReceipt(db, active, context.userId, idempotencyKey);
  const receiptRenewalId = (() => {
    if (!receipt?.response_body) return null;
    try {
      const body = JSON.parse(receipt.response_body) as Record<string, unknown>;
      return typeof body.renewalId === 'string' ? body.renewalId : null;
    } catch {
      return null;
    }
  })();
  const isSameReceiptTarget = receiptRenewalId === renewalId;
  const targetTaskId = isSameReceiptTarget ? receiptTaskId(receipt) : undefined;
  const row = await loadRenewalTask(db, active.agencyId, renewalId, targetTaskId);
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  let scopes: AuthorizationScopes;
  try {
    scopes = await authorizeCurrentTarget(db, context, row);
  } catch (error) {
    if (receipt) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    throw error;
  }

  if (receipt) {
    if (receipt.action !== CLOSE_LOST_ACTION || !isSameReceiptTarget) {
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    }
    const result = parseReceiptResult(receipt, payloadFingerprint, input, renewalId, row.task_id);
    await assertLostReplay(db, context, active, row, scopes, input, result, idempotencyKey);
    return { data: result, replayed: true };
  }

  if (
    row.renewal_state === 'WON' ||
    row.renewal_state === 'LOST' ||
    row.renewal_state === 'VOIDED' ||
    row.renewal_closed_at !== null ||
    row.task_status !== 'OPEN'
  ) {
    throw new RenewalCommandError('RENEWAL_STATE_CONFLICT', 409);
  }
  if (
    row.renewal_version !== input.expectedRenewalVersion ||
    row.task_version !== input.expectedTaskVersion
  ) {
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  }
  if (
    row.policy_status !== 'ACTIVE' ||
    row.policy_archived_at !== null ||
    row.customer_archived_at !== null
  ) {
    throw new RenewalCommandError('RENEWAL_PARENT_NOT_ACTIVE', 409);
  }

  const reason = await db
    .prepare('SELECT code,status FROM loss_reasons WHERE agency_id=? AND id=?')
    .bind(active.agencyId, input.lossReasonId)
    .first<{ code: string; status: string }>();
  if (!reason || reason.status !== 'ACTIVE') {
    throw new RenewalCommandError('LOSS_REASON_NOT_ACTIVE', 409);
  }
  if ((reason.code === 'OTHER') !== (input.lossReasonNotes !== null)) {
    throw new RenewalCommandError('LOSS_REASON_NOTES_INVALID', 400);
  }

  const closedAt = new Date().toISOString();
  const result: RenewalLostResult = {
    renewalId,
    previousState: row.renewal_state,
    state: 'LOST',
    lossReasonId: input.lossReasonId,
    primaryTaskId: row.task_id,
    renewalVersion: row.renewal_version + 1,
    taskVersion: row.task_version + 1,
    closedAt,
  };
  try {
    await db.batch([
      actorAuthorityAssertion(db, context, active, row, scopes, CLOSE_LOST_ACTION),
      lossReasonAssertion(db, active, input),
      receiptInsert(
        db,
        active,
        context,
        idempotencyKey,
        CLOSE_LOST_ACTION,
        payloadFingerprint,
        result,
        result.closedAt,
      ),
      completePrimaryTaskStatement(db, active, row, closedAt),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      closeRenewalStatement(db, active, row, input, closedAt),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      stateHistoryInsert(db, context, active, row, 'LOST', 'LOST', closedAt, {
        lossReasonId: input.lossReasonId,
        lossReasonNotes: input.lossReasonNotes,
        voidReasonCode: null,
      }),
      auditInsert(db, context, active, row, input, idempotencyKey, closedAt),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const racedReceipt = await readReceipt(db, active, context.userId, idempotencyKey);
      if (racedReceipt) {
        const racedTaskId = receiptTaskId(racedReceipt);
        const racedRow = await loadRenewalTask(db, active.agencyId, renewalId, racedTaskId);
        if (!racedRow) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
        let racedScopes: AuthorizationScopes;
        try {
          racedScopes = await authorizeCurrentTarget(db, context, racedRow);
        } catch {
          throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
        }
        const replay = parseReceiptResult(
          racedReceipt,
          payloadFingerprint,
          input,
          renewalId,
          racedRow.task_id,
        );
        await assertLostReplay(
          db,
          context,
          active,
          racedRow,
          racedScopes,
          input,
          replay,
          idempotencyKey,
        );
        return { data: replay, replayed: true };
      }
    }
    mapBatchError(error);
  }
  return { data: result, replayed: false };
}

function voidFingerprint(renewalId: string, input: VoidRenewalInput): Promise<string> {
  return computePayloadHash({
    action: VOID_ACTION,
    target: renewalId,
    payload: input,
    version: {
      expectedRenewalVersion: input.expectedRenewalVersion,
      expectedTaskVersion: input.expectedTaskVersion,
    },
  });
}

function parseVoidReceipt(
  raw: string | null,
  input: VoidRenewalInput,
  renewalId: string,
  taskId: string,
): RenewalVoidResult {
  if (!raw) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const result = parsed as Record<string, unknown>;
  const keys = [
    'renewalId',
    'previousState',
    'state',
    'voidReasonCode',
    'primaryTaskId',
    'renewalVersion',
    'taskVersion',
    'closedAt',
  ];
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(result, key)) ||
    result.renewalId !== renewalId ||
    result.primaryTaskId !== taskId ||
    result.state !== 'VOIDED' ||
    result.voidReasonCode !== input.voidReasonCode ||
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(String(result.previousState)) ||
    result.renewalVersion !== input.expectedRenewalVersion + 1 ||
    result.taskVersion !== input.expectedTaskVersion + 1 ||
    !isCanonicalTimestamp(result.closedAt)
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return result as unknown as RenewalVoidResult;
}

function parseVoidReceiptResult(
  receipt: ReceiptRow,
  expectedFingerprint: string,
  input: VoidRenewalInput,
  renewalId: string,
  taskId: string,
): RenewalVoidResult {
  if (
    receipt.action !== VOID_ACTION ||
    receipt.payload_fingerprint !== expectedFingerprint ||
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 200
  ) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  return parseVoidReceipt(receipt.response_body, input, renewalId, taskId);
}

function voidRenewalStatement(
  db: D1Database,
  active: ActiveMembership,
  row: RenewalTaskRow,
  input: VoidRenewalInput,
  closedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE renewal_opportunities
       SET state='VOIDED',loss_reason_id=NULL,loss_reason_notes=NULL,void_reason_code=?,
           closed_at=?,closed_by_membership_id=?,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND version=?
         AND state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
         AND closed_at IS NULL AND assignee_membership_id IS ?
         AND EXISTS(
           SELECT 1 FROM tasks t
           WHERE t.agency_id=renewal_opportunities.agency_id AND t.renewal_id=renewal_opportunities.id
             AND t.id=? AND t.kind='RENEWAL_FOLLOWUP' AND t.status='COMPLETED'
             AND t.version=? AND t.completed_at=? AND t.completed_by_membership_id=?
         )`,
    )
    .bind(
      input.voidReasonCode,
      closedAt,
      active.id,
      closedAt,
      active.agencyId,
      row.renewal_id,
      row.renewal_version,
      row.renewal_assignee_membership_id,
      row.task_id,
      row.task_version + 1,
      closedAt,
      active.id,
    );
}

function voidAuditInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  input: VoidRenewalInput,
  idempotencyKey: string,
  closedAt: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action: 'renewal.voided',
    targetType: 'renewal_opportunities',
    targetId: row.renewal_id,
    correlationId: idempotencyKey,
    idempotencyKey,
    outcome: 'SUCCESS',
    createdAt: closedAt,
    metadata: {
      reasonCode: input.voidReasonCode,
      changedFields: ['state', 'void_reason_code', 'closed_at', 'primary_task_status'],
    },
  });
  return db
    .prepare(
      `INSERT INTO audit_events
         (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
          correlation_id,idempotency_key,outcome,metadata_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    );
}

async function assertVoidReplay(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
  result: RenewalVoidResult,
  idempotencyKey: string,
): Promise<void> {
  const authority = actorAuthorityPredicate(
    context,
    active,
    row,
    scopes,
    VOID_ACTION,
    'task.update',
    scopes.taskUpdate,
    false,
    false,
  );
  const proof = await db
    .prepare(
      `SELECT CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END AS authority_count,
         (SELECT count(*) FROM tasks t
          WHERE t.agency_id=? AND t.id=? AND t.renewal_id=? AND t.kind='RENEWAL_FOLLOWUP'
            AND t.status='COMPLETED' AND t.completed_at=? AND t.completed_by_membership_id=?
            AND t.version=?) AS task_count,
         (SELECT count(*) FROM renewal_state_history h
          WHERE h.agency_id=? AND h.renewal_id=? AND h.from_state=? AND h.to_state='VOIDED'
            AND h.actor_user_id=? AND h.actor_membership_id=? AND h.reason_code=?
            AND h.created_at=? AND h.void_reason_code=?
            AND h.loss_reason_id IS NULL AND h.loss_reason_notes IS NULL) AS history_count,
         (SELECT count(*) FROM audit_events a
          WHERE a.agency_id=? AND a.actor_user_id=? AND a.actor_membership_id=?
            AND a.action='renewal.voided' AND a.target_type='renewal_opportunities'
            AND a.target_id=? AND a.idempotency_key=? AND a.outcome='SUCCESS'
            AND a.created_at=? AND json_extract(a.metadata_json,'$.reasonCode')=?) AS audit_count`,
    )
    .bind(
      ...authority.bindings,
      active.agencyId,
      result.primaryTaskId,
      result.renewalId,
      result.closedAt,
      active.id,
      result.taskVersion,
      active.agencyId,
      result.renewalId,
      result.previousState,
      context.userId,
      active.id,
      result.voidReasonCode,
      result.closedAt,
      result.voidReasonCode,
      active.agencyId,
      context.userId,
      active.id,
      result.renewalId,
      idempotencyKey,
      result.closedAt,
      result.voidReasonCode,
    )
    .first<{
      authority_count: number;
      task_count: number;
      history_count: number;
      audit_count: number;
    }>();
  if (
    !proof ||
    proof.authority_count !== 1 ||
    proof.task_count !== 1 ||
    proof.history_count < 1 ||
    proof.audit_count !== 1
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

export async function voidRenewal(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawIdempotencyKey: string,
): Promise<{ data: RenewalVoidResult; replayed: boolean }> {
  const active = activeMembership(context);
  const input = voidRenewalSchema.parse(rawInput);
  const idempotencyKey = rawIdempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  }
  const payloadFingerprint = await voidFingerprint(renewalId, input);
  const receipt = await readReceipt(db, active, context.userId, idempotencyKey);
  const receiptRenewalId = (() => {
    if (!receipt?.response_body) return null;
    try {
      const body = JSON.parse(receipt.response_body) as Record<string, unknown>;
      return typeof body.renewalId === 'string' ? body.renewalId : null;
    } catch {
      return null;
    }
  })();
  const isSameReceiptTarget = receiptRenewalId === renewalId;
  const targetTaskId = isSameReceiptTarget ? receiptTaskId(receipt) : undefined;
  const row = await loadRenewalTask(db, active.agencyId, renewalId, targetTaskId);
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  let scopes: AuthorizationScopes;
  try {
    scopes = await authorizeCurrentTarget(db, context, row, VOID_ACTION);
  } catch (error) {
    if (receipt) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    throw error;
  }

  if (receipt) {
    if (receipt.action !== VOID_ACTION || !isSameReceiptTarget) {
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    }
    const result = parseVoidReceiptResult(
      receipt,
      payloadFingerprint,
      input,
      renewalId,
      row.task_id,
    );
    await assertVoidReplay(db, context, active, row, scopes, result, idempotencyKey);
    return { data: result, replayed: true };
  }

  if (
    row.renewal_state === 'WON' ||
    row.renewal_state === 'LOST' ||
    row.renewal_state === 'VOIDED' ||
    row.renewal_closed_at !== null ||
    row.task_status !== 'OPEN'
  ) {
    throw new RenewalCommandError('RENEWAL_STATE_CONFLICT', 409);
  }
  if (
    row.renewal_version !== input.expectedRenewalVersion ||
    row.task_version !== input.expectedTaskVersion
  ) {
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  }
  if (
    row.policy_status !== 'ACTIVE' ||
    row.policy_archived_at !== null ||
    row.customer_archived_at !== null
  ) {
    throw new RenewalCommandError('RENEWAL_PARENT_NOT_ACTIVE', 409);
  }

  const closedAt = new Date().toISOString();
  const result: RenewalVoidResult = {
    renewalId,
    previousState: row.renewal_state,
    state: 'VOIDED',
    voidReasonCode: input.voidReasonCode,
    primaryTaskId: row.task_id,
    renewalVersion: row.renewal_version + 1,
    taskVersion: row.task_version + 1,
    closedAt,
  };
  try {
    await db.batch([
      actorAuthorityAssertion(db, context, active, row, scopes, VOID_ACTION),
      receiptInsert(
        db,
        active,
        context,
        idempotencyKey,
        VOID_ACTION,
        payloadFingerprint,
        result,
        result.closedAt,
      ),
      completePrimaryTaskStatement(db, active, row, closedAt),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      voidRenewalStatement(db, active, row, input, closedAt),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      stateHistoryInsert(db, context, active, row, 'VOIDED', input.voidReasonCode, closedAt, {
        lossReasonId: null,
        lossReasonNotes: null,
        voidReasonCode: input.voidReasonCode,
      }),
      voidAuditInsert(db, context, active, row, input, idempotencyKey, closedAt),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const racedReceipt = await readReceipt(db, active, context.userId, idempotencyKey);
      if (racedReceipt) {
        const racedTaskId = receiptTaskId(racedReceipt);
        const racedRow = await loadRenewalTask(db, active.agencyId, renewalId, racedTaskId);
        if (!racedRow) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
        let racedScopes: AuthorizationScopes;
        try {
          racedScopes = await authorizeCurrentTarget(db, context, racedRow, VOID_ACTION);
        } catch {
          throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
        }
        const replay = parseVoidReceiptResult(
          racedReceipt,
          payloadFingerprint,
          input,
          renewalId,
          racedRow.task_id,
        );
        await assertVoidReplay(db, context, active, racedRow, racedScopes, replay, idempotencyKey);
        return { data: replay, replayed: true };
      }
    }
    mapBatchError(error);
  }
  return { data: result, replayed: false };
}

function reopenFingerprint(renewalId: string, input: ReopenRenewalInput): Promise<string> {
  return computePayloadHash({
    action: REOPEN_ACTION,
    target: renewalId,
    payload: input,
    version: {
      expectedRenewalVersion: input.expectedRenewalVersion,
      expectedTaskVersion: input.expectedTaskVersion,
    },
  });
}

function parseReopenReceipt(
  raw: string | null,
  input: ReopenRenewalInput,
  renewalId: string,
  primaryTaskId: string,
): RenewalReopenResult {
  if (!raw) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const result = parsed as Record<string, unknown>;
  const keys = [
    'renewalId',
    'previousState',
    'state',
    'closedTaskId',
    'closedTaskVersion',
    'terminalClosedAt',
    'primaryTaskId',
    'renewalVersion',
    'taskVersion',
    'reopenedAt',
  ];
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(result, key)) ||
    result.renewalId !== renewalId ||
    result.primaryTaskId !== primaryTaskId ||
    (result.previousState !== 'LOST' && result.previousState !== 'VOIDED') ||
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(String(result.state)) ||
    typeof result.closedTaskId !== 'string' ||
    result.closedTaskId.trim() === '' ||
    result.closedTaskVersion !== input.expectedTaskVersion ||
    result.renewalVersion !== input.expectedRenewalVersion + 1 ||
    result.taskVersion !== 1 ||
    !isCanonicalTimestamp(result.terminalClosedAt) ||
    !isCanonicalTimestamp(result.reopenedAt)
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return result as unknown as RenewalReopenResult;
}

async function reopenTargetState(db: D1Database, row: RenewalTaskRow): Promise<OpenRenewalState> {
  const result = await db
    .prepare(
      `SELECT from_state FROM renewal_state_history
       WHERE agency_id=? AND renewal_id=? AND to_state=?
         AND from_state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
       ORDER BY rowid DESC LIMIT 1`,
    )
    .bind(row.agency_id, row.renewal_id, row.renewal_state)
    .first<{ from_state: string | null }>();
  if (
    !result ||
    result.from_state === null ||
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(result.from_state)
  ) {
    throw new RenewalCommandError('REOPEN_SOURCE_STATE_MISSING', 409);
  }
  return result.from_state as OpenRenewalState;
}

function reopenRenewalStatement(
  db: D1Database,
  row: RenewalTaskRow,
  input: ReopenRenewalInput,
  reopenedState: OpenRenewalState,
  reopenedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE renewal_opportunities
       SET state=?,loss_reason_id=NULL,loss_reason_notes=NULL,void_reason_code=NULL,
           closed_at=NULL,closed_by_membership_id=NULL,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND state=? AND version=?
         AND closed_at=? AND closed_by_membership_id=?
         AND assignee_membership_id IS ?
         AND EXISTS(
           SELECT 1 FROM tasks t
           WHERE t.agency_id=renewal_opportunities.agency_id AND t.renewal_id=renewal_opportunities.id
             AND t.id=? AND t.kind='RENEWAL_FOLLOWUP' AND t.status='COMPLETED'
             AND t.version=? AND t.completed_at=renewal_opportunities.closed_at
             AND t.completed_by_membership_id=renewal_opportunities.closed_by_membership_id
             AND t.assignee_membership_id IS renewal_opportunities.assignee_membership_id
         )`,
    )
    .bind(
      reopenedState,
      reopenedAt,
      row.agency_id,
      row.renewal_id,
      row.renewal_state,
      row.renewal_version,
      row.renewal_closed_at,
      row.renewal_closed_by_membership_id,
      row.renewal_assignee_membership_id,
      row.task_id,
      input.expectedTaskVersion,
    );
}

function replacementPrimaryTaskInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  result: RenewalReopenResult,
  input: ReopenRenewalInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tasks
         (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
          status,actor_kind,created_by_user_id,created_by_membership_id,version,created_at,updated_at)
       SELECT ?,r.agency_id,c.id,r.id,'RENEWAL_FOLLOWUP','Yenileme takibi',?,r.assignee_membership_id,
          'OPEN','USER',?,?,1,?,?
       FROM renewal_opportunities r
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       WHERE r.agency_id=? AND r.id=? AND r.state=? AND r.version=? AND r.closed_at IS NULL
         AND r.assignee_membership_id IS ? AND p.status='ACTIVE' AND p.archived_at IS NULL
         AND c.archived_at IS NULL`,
    )
    .bind(
      result.primaryTaskId,
      input.replacementDueAt,
      context.userId,
      active.id,
      result.reopenedAt,
      result.reopenedAt,
      active.agencyId,
      row.renewal_id,
      result.state,
      result.renewalVersion,
      row.renewal_assignee_membership_id,
    );
}

function reopenAuditInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  result: RenewalReopenResult,
  input: ReopenRenewalInput,
  idempotencyKey: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action: 'renewal.reopened',
    targetType: 'renewal_opportunities',
    targetId: result.renewalId,
    correlationId: idempotencyKey,
    idempotencyKey,
    outcome: 'SUCCESS',
    createdAt: result.reopenedAt,
    metadata: {
      reasonCode: input.reopenReasonCode,
      referenceId: result.primaryTaskId,
      entityCode: result.state,
      changedFields: ['state', 'closed_at', 'loss_reason_id', 'void_reason_code', 'primary_task'],
    },
  });
  return db
    .prepare(
      `INSERT INTO audit_events
         (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
          correlation_id,idempotency_key,outcome,metadata_json,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    );
}

async function assertReopenReplay(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
  input: ReopenRenewalInput,
  result: RenewalReopenResult,
  idempotencyKey: string,
): Promise<void> {
  const authority = actorAuthorityPredicate(
    context,
    active,
    row,
    scopes,
    REOPEN_ACTION,
    'task.create',
    scopes.taskUpdate,
    false,
    false,
  );
  const proof = await db
    .prepare(
      `SELECT CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END AS authority_count,
         (SELECT count(*) FROM tasks t
          WHERE t.agency_id=? AND t.id=? AND t.renewal_id=? AND t.kind='RENEWAL_FOLLOWUP'
            AND t.actor_kind='USER' AND t.created_by_user_id=? AND t.created_by_membership_id=?
            AND t.due_at=? AND t.created_at=?) AS new_task_count,
         (SELECT count(*) FROM tasks t
          WHERE t.agency_id=? AND t.id=? AND t.renewal_id=? AND t.kind='RENEWAL_FOLLOWUP'
            AND t.status='COMPLETED' AND t.version=? AND t.completed_at=?
            AND t.completed_by_membership_id=?) AS closed_task_count,
         (SELECT count(*) FROM renewal_state_history h
          WHERE h.agency_id=? AND h.renewal_id=? AND h.from_state=? AND h.to_state=?
            AND h.actor_user_id=? AND h.actor_membership_id=? AND h.reason_code='REOPEN'
            AND h.created_at=? AND h.loss_reason_id IS NULL AND h.loss_reason_notes IS NULL
            AND h.void_reason_code IS NULL) AS history_count,
         (SELECT count(*) FROM audit_events a
          WHERE a.agency_id=? AND a.actor_user_id=? AND a.actor_membership_id=?
            AND a.action='renewal.reopened' AND a.target_type='renewal_opportunities'
            AND a.target_id=? AND a.idempotency_key=? AND a.outcome='SUCCESS'
            AND a.created_at=? AND json_extract(a.metadata_json,'$.reasonCode')=?
            AND json_extract(a.metadata_json,'$.referenceId')=?) AS audit_count`,
    )
    .bind(
      ...authority.bindings,
      active.agencyId,
      result.primaryTaskId,
      result.renewalId,
      context.userId,
      active.id,
      input.replacementDueAt,
      result.reopenedAt,
      active.agencyId,
      result.closedTaskId,
      result.renewalId,
      result.closedTaskVersion,
      result.terminalClosedAt,
      active.id,
      active.agencyId,
      result.renewalId,
      result.previousState,
      result.state,
      context.userId,
      active.id,
      result.reopenedAt,
      active.agencyId,
      context.userId,
      active.id,
      result.renewalId,
      idempotencyKey,
      result.reopenedAt,
      input.reopenReasonCode,
      result.primaryTaskId,
    )
    .first<{
      authority_count: number;
      new_task_count: number;
      closed_task_count: number;
      history_count: number;
      audit_count: number;
    }>();
  if (
    !proof ||
    proof.authority_count !== 1 ||
    proof.new_task_count !== 1 ||
    proof.closed_task_count !== 1 ||
    proof.history_count < 1 ||
    proof.audit_count !== 1
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

function parseReopenReceiptResult(
  receipt: ReceiptRow,
  expectedFingerprint: string,
  input: ReopenRenewalInput,
  renewalId: string,
  primaryTaskId: string,
): RenewalReopenResult {
  if (
    receipt.action !== REOPEN_ACTION ||
    receipt.payload_fingerprint !== expectedFingerprint ||
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 200
  ) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  return parseReopenReceipt(receipt.response_body, input, renewalId, primaryTaskId);
}

export async function reopenRenewal(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawIdempotencyKey: string,
): Promise<{ data: RenewalReopenResult; replayed: boolean }> {
  const active = activeMembership(context);
  const input = reopenRenewalSchema.parse(rawInput);
  if (!isCanonicalTimestamp(input.replacementDueAt)) {
    throw new RenewalCommandError('REOPEN_DUE_AT_INVALID', 400);
  }
  const idempotencyKey = rawIdempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  }
  const payloadFingerprint = await reopenFingerprint(renewalId, input);
  const receipt = await readReceipt(db, active, context.userId, idempotencyKey);
  const receiptRenewalId = (() => {
    if (!receipt?.response_body) return null;
    try {
      const body = JSON.parse(receipt.response_body) as Record<string, unknown>;
      return typeof body.renewalId === 'string' ? body.renewalId : null;
    } catch {
      return null;
    }
  })();
  const isSameReceiptTarget = receiptRenewalId === renewalId;
  const targetTaskId = isSameReceiptTarget ? receiptTaskId(receipt) : undefined;
  const row = await loadRenewalTask(db, active.agencyId, renewalId, targetTaskId);
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  let reopenScopes: ReopenAuthorizationScopes;
  try {
    reopenScopes = await authorizeReopenTarget(db, context, row);
  } catch (error) {
    if (receipt) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    throw error;
  }
  const authorityScopes: AuthorizationScopes = {
    customerRead: reopenScopes.customerRead,
    policyRead: reopenScopes.policyRead,
    renewalRead: reopenScopes.renewalRead,
    taskRead: reopenScopes.taskRead,
    taskUpdate: reopenScopes.taskCreate,
    terminalAction: reopenScopes.reopen,
  };

  if (receipt) {
    if (receipt.action !== REOPEN_ACTION || !isSameReceiptTarget) {
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    }
    const result = parseReopenReceiptResult(
      receipt,
      payloadFingerprint,
      input,
      renewalId,
      row.task_id,
    );
    await assertReopenReplay(
      db,
      context,
      active,
      row,
      authorityScopes,
      input,
      result,
      idempotencyKey,
    );
    return { data: result, replayed: true };
  }

  if (row.renewal_state === 'WON') {
    throw new RenewalCommandError('REOPEN_WON_REQUIRES_SECURE_CORRECTION', 409);
  }
  if (
    (row.renewal_state !== 'LOST' && row.renewal_state !== 'VOIDED') ||
    row.renewal_closed_at === null ||
    row.renewal_closed_by_membership_id === null ||
    row.task_status !== 'COMPLETED'
  ) {
    throw new RenewalCommandError('RENEWAL_STATE_CONFLICT', 409);
  }
  if (
    row.renewal_version !== input.expectedRenewalVersion ||
    row.task_version !== input.expectedTaskVersion
  ) {
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  }
  if (
    row.policy_status !== 'ACTIVE' ||
    row.policy_archived_at !== null ||
    row.customer_archived_at !== null
  ) {
    throw new RenewalCommandError('RENEWAL_PARENT_NOT_ACTIVE', 409);
  }
  if (
    row.task_completed_at === null ||
    row.task_completed_at !== row.renewal_closed_at ||
    row.task_assignee_membership_id !== row.renewal_assignee_membership_id
  ) {
    throw new RenewalCommandError('RENEWAL_TERMINAL_TASK_INVALID', 409);
  }
  if (row.renewal_assignee_membership_id !== null) {
    const assignee = await db
      .prepare('SELECT status FROM agency_memberships WHERE agency_id=? AND id=?')
      .bind(active.agencyId, row.renewal_assignee_membership_id)
      .first<{ status: string }>();
    if (!assignee || assignee.status !== 'ACTIVE') {
      throw new RenewalCommandError('REOPEN_ASSIGNEE_INACTIVE', 409);
    }
  }
  const reopenedState = await reopenTargetState(db, row);
  const reopenedAt = new Date().toISOString();
  const result: RenewalReopenResult = {
    renewalId,
    previousState: row.renewal_state as 'LOST' | 'VOIDED',
    state: reopenedState,
    closedTaskId: row.task_id,
    closedTaskVersion: row.task_version,
    terminalClosedAt: row.renewal_closed_at,
    primaryTaskId: crypto.randomUUID(),
    renewalVersion: row.renewal_version + 1,
    taskVersion: 1,
    reopenedAt,
  };

  try {
    await db.batch([
      actorAuthorityAssertion(
        db,
        context,
        active,
        row,
        authorityScopes,
        REOPEN_ACTION,
        'task.create',
        authorityScopes.taskUpdate,
      ),
      receiptInsert(
        db,
        active,
        context,
        idempotencyKey,
        REOPEN_ACTION,
        payloadFingerprint,
        result,
        result.reopenedAt,
      ),
      reopenRenewalStatement(db, row, input, reopenedState, reopenedAt),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      stateHistoryInsert(db, context, active, row, reopenedState, 'REOPEN', reopenedAt),
      replacementPrimaryTaskInsert(db, context, active, row, result, input),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      reopenAuditInsert(db, context, active, result, input, idempotencyKey),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const racedReceipt = await readReceipt(db, active, context.userId, idempotencyKey);
      if (racedReceipt) {
        const racedTaskId = receiptTaskId(racedReceipt);
        const racedRow = await loadRenewalTask(db, active.agencyId, renewalId, racedTaskId);
        if (!racedRow) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
        let racedReopenScopes: ReopenAuthorizationScopes;
        try {
          racedReopenScopes = await authorizeReopenTarget(db, context, racedRow);
        } catch {
          throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
        }
        const racedAuthorityScopes: AuthorizationScopes = {
          customerRead: racedReopenScopes.customerRead,
          policyRead: racedReopenScopes.policyRead,
          renewalRead: racedReopenScopes.renewalRead,
          taskRead: racedReopenScopes.taskRead,
          taskUpdate: racedReopenScopes.taskCreate,
          terminalAction: racedReopenScopes.reopen,
        };
        const replay = parseReopenReceiptResult(
          racedReceipt,
          payloadFingerprint,
          input,
          renewalId,
          racedRow.task_id,
        );
        await assertReopenReplay(
          db,
          context,
          active,
          racedRow,
          racedAuthorityScopes,
          input,
          replay,
          idempotencyKey,
        );
        return { data: replay, replayed: true };
      }
    }
    mapBatchError(error);
  }
  return { data: result, replayed: false };
}
