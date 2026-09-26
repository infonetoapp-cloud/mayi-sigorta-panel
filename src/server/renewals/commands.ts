import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computeEvidenceHash, issueAndPersistSensitiveActionGrant } from '../mutations/grants';
import { evaluateAuthorization, type EffectiveScope } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { parsePolicyCreateInput } from '../policies/validation';
import {
  closeRenewalWonSchema,
  closeRenewalLostSchema,
  type CloseRenewalWonInput,
  type CloseRenewalLostInput,
  reopenRenewalSchema,
  type ReopenRenewalInput,
  type VoidRenewalInput,
  voidRenewalSchema,
  wonRenewalCorrectionGrantSchema,
  type WonRenewalCorrectionInput,
} from './validation';

const CLOSE_LOST_ACTION = 'renewal.close_lost';
const CLOSE_WON_ACTION = 'renewal.close_won';
const VOID_ACTION = 'renewal.void';
const REOPEN_ACTION = 'renewal.reopen';
const WON_CORRECTION_ACTION = 'renewal.won.correct';
type RecordScope = Extract<EffectiveScope, 'ASSIGNED' | 'AGENCY'>;
export type OpenRenewalState =
  'CONTACT_PENDING' | 'CONTACTED' | 'QUOTE_PREPARING' | 'QUOTE_SENT' | 'AWAITING_RESPONSE';

export type ActiveMembership = {
  id: string;
  agencyId: string;
  type: 'OWNER' | 'MEMBER';
  status: 'ACTIVE';
  permissionVersion: number;
};

export type RenewalTaskRow = {
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
  task_completed_by_membership_id: string | null;
};

export type ReceiptRow = {
  id: string;
  action: string;
  idempotency_key: string;
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

export interface RenewalWonLinkResult {
  readonly id: string;
  readonly newPolicyId: string;
  readonly allocatedNewPremiumMinor: number;
  readonly currency: string;
  readonly differentPolicyholderReasonCode: string | null;
}

export interface RenewalWonResult {
  readonly renewalId: string;
  readonly previousState: string;
  readonly state: 'WON';
  readonly primaryTaskId: string;
  readonly renewalVersion: number;
  readonly taskVersion: number;
  readonly closedAt: string;
  readonly createdPolicyId: string | null;
  readonly acceptedQuoteVersionId: string | null;
  readonly acceptedPolicyId: string | null;
  readonly newPolicyIds: readonly string[];
  readonly linkIds: readonly string[];
  readonly links: readonly RenewalWonLinkResult[];
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

export interface RenewalWonCorrectionResult {
  readonly renewalId: string;
  readonly previousState: 'WON';
  readonly state: OpenRenewalState;
  readonly closedTaskId: string;
  readonly closedTaskVersion: number;
  readonly terminalClosedAt: string;
  readonly primaryTaskId: string;
  readonly renewalVersion: number;
  readonly taskVersion: 1;
  readonly correctedAt: string;
  readonly correctionReasonCode: string;
  readonly supersededLinkIds: readonly string[];
  readonly preservedPolicyIds: readonly string[];
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

export function activeMembership(context: AuthenticatedUserContext): ActiveMembership {
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

export async function loadRenewalTask(
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
        t.assignee_membership_id AS task_assignee_membership_id,t.completed_at AS task_completed_at,
        t.completed_by_membership_id AS task_completed_by_membership_id
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

export function renewalResource(row: RenewalTaskRow): Record<string, unknown> {
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

export function taskResource(row: RenewalTaskRow): Record<string, unknown> {
  return {
    ...renewalResource(row),
    taskAssigneeMembershipId: row.task_assignee_membership_id,
    policyAssigneeMembershipId: row.policy_assignee_membership_id,
    parentReadAuthorized: true,
  };
}

export interface AuthorizationScopes {
  readonly customerRead: RecordScope;
  readonly policyRead: RecordScope;
  readonly renewalRead: RecordScope;
  readonly taskRead: RecordScope;
  readonly taskUpdate: RecordScope;
  readonly terminalAction: RecordScope;
}

export async function authorizeCurrentTarget(
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

export async function readReceipt(
  db: D1Database,
  active: ActiveMembership,
  actorUserId: string,
  idempotencyKey: string,
): Promise<ReceiptRow | null> {
  return db
    .prepare(
      `SELECT id,action,idempotency_key,payload_fingerprint,status,response_status,response_body
       FROM operation_receipts
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
    )
    .bind(active.agencyId, actorUserId, active.id, idempotencyKey)
    .first<ReceiptRow>();
}

export function receiptTaskId(receipt: ReceiptRow | null): string | undefined {
  if (!receipt || typeof receipt.response_body !== 'string') return undefined;
  try {
    const body = JSON.parse(receipt.response_body) as Record<string, unknown>;
    return typeof body.primaryTaskId === 'string' ? body.primaryTaskId : undefined;
  } catch {
    return undefined;
  }
}

export function isCanonicalTimestamp(value: unknown): value is string {
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

export function casAssertion(db: D1Database, failureCode: string): D1PreparedStatement {
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
  terminalAction:
    | typeof CLOSE_LOST_ACTION
    | typeof CLOSE_WON_ACTION
    | typeof VOID_ACTION
    | typeof REOPEN_ACTION
    | typeof WON_CORRECTION_ACTION,
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
  const actionGrantPermission =
    terminalAction === WON_CORRECTION_ACTION ? 'renewal.update' : terminalAction;
  const taskPermissionPredicate =
    taskPermission === 'task.create'
      ? `EXISTS (
           SELECT 1 FROM membership_permissions task_create
           WHERE task_create.membership_id=m.id
             AND task_create.permission_code='task.create' AND task_create.scope='UNSCOPED'
         )`
      : `EXISTS (
           SELECT 1 FROM membership_permissions task_update
           JOIN membership_permissions task_dependency
             ON task_dependency.membership_id=task_update.membership_id
            AND task_dependency.permission_code='task.read'
           WHERE task_update.membership_id=m.id AND task_update.permission_code='task.update'
             AND task_update.scope=? AND task_dependency.scope=?
             AND NOT (task_update.scope='AGENCY' AND task_dependency.scope='ASSIGNED')
         )`;
  const taskPermissionBindings =
    taskPermission === 'task.create' ? [] : [taskPermissionScope, scopes.taskRead];
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
      actionGrantPermission,
      scopes.terminalAction,
      scopes.renewalRead,
      scopes.customerRead,
      scopes.renewalRead,
      scopes.policyRead,
      scopes.taskRead,
      ...taskPermissionBindings,
      scopes.terminalAction,
      scopes.renewalRead,
      scopes.customerRead,
      scopes.policyRead,
      scopes.taskRead,
      taskPermissionScope,
    ],
  };
}

export function actorAuthorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
  terminalAction:
    | typeof CLOSE_LOST_ACTION
    | typeof CLOSE_WON_ACTION
    | typeof VOID_ACTION
    | typeof REOPEN_ACTION
    | typeof WON_CORRECTION_ACTION,
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

export function receiptInsert(
  db: D1Database,
  active: ActiveMembership,
  context: AuthenticatedUserContext,
  idempotencyKey: string,
  action:
    | typeof CLOSE_LOST_ACTION
    | typeof CLOSE_WON_ACTION
    | typeof VOID_ACTION
    | typeof REOPEN_ACTION
    | typeof WON_CORRECTION_ACTION,
  payloadFingerprint: string,
  result: unknown,
  receiptAt: string,
  responseStatus = 200,
  receiptId = crypto.randomUUID(),
): D1PreparedStatement {
  const body = JSON.stringify(result);
  return db
    .prepare(
      `INSERT INTO operation_receipts
         (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
          payload_fingerprint,status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)`,
    )
    .bind(
      receiptId,
      active.agencyId,
      context.userId,
      active.id,
      action,
      idempotencyKey,
      payloadFingerprint,
      responseStatus,
      body,
      receiptAt,
      receiptAt,
    );
}

export function completePrimaryTaskStatement(
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

export function stateHistoryInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  state: OpenRenewalState | 'WON' | 'LOST' | 'VOIDED',
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

export function isReceiptRace(error: unknown): boolean {
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

export async function reopenTargetState(
  db: D1Database,
  row: RenewalTaskRow,
): Promise<OpenRenewalState> {
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
export type WonPolicyTarget = {
  readonly id: string;
  readonly agency_id: string;
  readonly customer_id: string;
  readonly product_id: string;
  readonly version: number;
  readonly status: string;
  readonly archived_at: string | null;
  readonly gross_premium_minor: number;
  readonly currency: string;
  readonly assignee_membership_id: string | null;
  readonly branch_id: string;
  readonly data_classification: 'GENERAL' | 'HEALTH';
  readonly customer_assignee_membership_id: string | null;
  readonly customer_archived_at: string | null;
  readonly policyReadScope?: RecordScope;
  readonly customerReadScope?: RecordScope;
};

export type WonLinkRow = RenewalWonLinkResult & {
  readonly agency_id: string;
  readonly renewal_id: string;
  readonly allocationOperationId: string;
  readonly different_policyholder_reason_code: string | null;
  readonly customer_id: string;
};

type WonLinkQueryRow = {
  readonly id: string;
  readonly agency_id: string;
  readonly renewal_id: string;
  readonly new_policy_id: string;
  readonly allocated_new_premium_minor: number;
  readonly currency: string;
  readonly allocation_operation_id: string;
  readonly different_policyholder_reason_code: string | null;
  readonly customer_id: string;
  readonly product_id: string;
  readonly version: number;
  readonly status: string;
  readonly archived_at: string | null;
  readonly gross_premium_minor: number;
  readonly assignee_membership_id: string | null;
  readonly branch_id: string;
  readonly data_classification: 'GENERAL' | 'HEALTH';
  readonly customer_assignee_membership_id: string | null;
  readonly customer_archived_at: string | null;
};

export async function loadWonLinks(
  db: D1Database,
  agencyId: string,
  renewalId: string,
): Promise<{ readonly links: WonLinkRow[]; readonly targets: WonPolicyTarget[] }> {
  const result = await db
    .prepare(
      `SELECT l.id,l.agency_id,l.renewal_id,l.new_policy_id,
              l.allocated_new_premium_minor,l.currency,l.allocation_operation_id,
              l.different_policyholder_reason_code,
              p.customer_id,p.product_id,p.version,p.status,p.archived_at,p.gross_premium_minor,p.assignee_membership_id,
              p.branch_id,b.data_classification,c.assignee_membership_id AS customer_assignee_membership_id,
              c.archived_at AS customer_archived_at
       FROM renewal_policy_links l
       JOIN policies p ON p.agency_id=l.agency_id AND p.id=l.new_policy_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       WHERE l.agency_id=? AND l.renewal_id=? AND l.status='ACTIVE'
       ORDER BY l.new_policy_id,l.id`,
    )
    .bind(agencyId, renewalId)
    .all<WonLinkQueryRow>();
  if (!result.success) throw new RenewalCommandError('DATABASE_ERROR', 500);
  const links = result.results.map((row) => ({
    id: row.id,
    agency_id: row.agency_id,
    renewal_id: row.renewal_id,
    newPolicyId: row.new_policy_id,
    allocatedNewPremiumMinor: row.allocated_new_premium_minor,
    currency: row.currency,
    allocationOperationId: row.allocation_operation_id,
    differentPolicyholderReasonCode: row.different_policyholder_reason_code,
    different_policyholder_reason_code: row.different_policyholder_reason_code,
    customer_id: row.customer_id,
  }));
  const targets = [
    ...new Map(
      result.results.map((row) => [
        row.new_policy_id,
        {
          id: row.new_policy_id,
          agency_id: row.agency_id,
          customer_id: row.customer_id,
          product_id: row.product_id,
          version: row.version,
          status: row.status,
          archived_at: row.archived_at,
          gross_premium_minor: row.gross_premium_minor,
          currency: row.currency,
          assignee_membership_id: row.assignee_membership_id,
          branch_id: row.branch_id,
          data_classification: row.data_classification,
          customer_assignee_membership_id: row.customer_assignee_membership_id,
          customer_archived_at: row.customer_archived_at,
        },
      ]),
    ).values(),
  ];
  return { links, targets };
}

export async function loadWonPolicy(
  db: D1Database,
  agencyId: string,
  policyId: string,
): Promise<WonPolicyTarget | null> {
  return db
    .prepare(
      `SELECT p.id,p.agency_id,p.customer_id,p.product_id,p.version,p.status,p.archived_at,p.gross_premium_minor,
              p.currency,p.assignee_membership_id,p.branch_id,b.data_classification,
              c.assignee_membership_id AS customer_assignee_membership_id,
              c.archived_at AS customer_archived_at
       FROM policies p
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       WHERE p.agency_id=? AND p.id=?`,
    )
    .bind(agencyId, policyId)
    .first<WonPolicyTarget>();
}

export async function authorizeWonPolicyTargets(
  db: D1Database,
  context: AuthenticatedUserContext,
  agencyId: string,
  targets: readonly WonPolicyTarget[],
): Promise<WonPolicyTarget[]> {
  const authorized: WonPolicyTarget[] = [];
  for (const target of targets) {
    if (target.agency_id !== agencyId) throw new RenewalCommandError('NOT_FOUND', 404);
    const customerReadScope = await authorize(db, context, 'customer.read', {
      agencyId,
      assigneeMembershipId: target.customer_assignee_membership_id,
    });
    const policyReadScope = await authorize(
      db,
      context,
      target.data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
      {
        agencyId,
        assigneeMembershipId: target.assignee_membership_id,
        customerAssigneeMembershipId: target.customer_assignee_membership_id,
        branchId: target.branch_id,
      },
    );
    authorized.push({ ...target, policyReadScope, customerReadScope });
  }
  return authorized;
}

async function validateWonPolicyCatalogs(
  db: D1Database,
  agencyId: string,
  data: ReturnType<typeof parsePolicyCreateInput>,
  insurerId: string,
): Promise<'GENERAL' | 'HEALTH'> {
  const row = await db
    .prepare(
      `SELECT i.status AS insurer_status,b.status AS branch_status,b.data_classification,
              p.status AS product_status,pm.status AS payment_status,
              pm.supports_installments,pm.max_installments
       FROM insurance_products p
       JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       JOIN payment_methods pm ON pm.agency_id=p.agency_id AND pm.id=?
       WHERE p.agency_id=? AND p.id=? AND p.insurer_id=? AND p.branch_id=?`,
    )
    .bind(data.paymentMethodId, agencyId, data.productId, insurerId, data.branchId)
    .first<{
      insurer_status: string;
      branch_status: string;
      data_classification: 'GENERAL' | 'HEALTH';
      product_status: string;
      payment_status: string;
      supports_installments: number;
      max_installments: number;
    }>();
  if (
    !row ||
    [row.insurer_status, row.branch_status, row.product_status, row.payment_status].some(
      (status) => status !== 'ACTIVE',
    )
  ) {
    throw new RenewalCommandError('POLICY_CATALOG_REFERENCE_NOT_SELECTABLE', 409);
  }
  if (
    (row.supports_installments === 0 && data.installmentCount !== null) ||
    (row.supports_installments === 1 &&
      (data.installmentCount === null || data.installmentCount > row.max_installments))
  ) {
    throw new RenewalCommandError('POLICY_INSTALLMENT_INVALID', 400);
  }
  return row.data_classification;
}

export function wonPolicyReadAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  target: WonPolicyTarget,
): D1PreparedStatement {
  const policyScope = target.policyReadScope;
  const customerScope = target.customerReadScope;
  if (!policyScope || !customerScope) throw new RenewalCommandError('FORBIDDEN', 403);
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
         JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
         JOIN policies p ON p.agency_id=m.agency_id AND p.id=?
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL
           AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
           AND (m.type='OWNER' OR (
             EXISTS(SELECT 1 FROM membership_permissions pr WHERE pr.membership_id=m.id
               AND pr.permission_code='policy.read' AND pr.scope=?
               AND (?='AGENCY' OR p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id))
             AND EXISTS(SELECT 1 FROM membership_permissions cr WHERE cr.membership_id=m.id
               AND cr.permission_code='customer.read' AND cr.scope=?
               AND (?='AGENCY' OR c.assignee_membership_id=m.id))
           ))
           AND (b.data_classification<>'HEALTH' OR EXISTS(
             SELECT 1 FROM membership_permissions sh WHERE sh.membership_id=m.id
               AND sh.permission_code='sensitive.health.read' AND sh.scope='UNSCOPED'))
       ) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(
      crypto.randomUUID(),
      context.identityId,
      target.id,
      active.id,
      active.agencyId,
      context.userId,
      active.permissionVersion,
      policyScope,
      policyScope,
      customerScope,
      customerScope,
    );
}

export function wonPolicyVersionAssertion(
  db: D1Database,
  agencyId: string,
  target: WonPolicyTarget,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM policies p WHERE p.agency_id=? AND p.id=? AND p.version=?
           AND p.status='ACTIVE' AND p.archived_at IS NULL
       ) THEN 1 ELSE 0 END,'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
    )
    .bind(crypto.randomUUID(), agencyId, target.id, target.version);
}

export function wonPolicyReplayReadAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  target: WonPolicyTarget,
): D1PreparedStatement {
  const policyScope = target.policyReadScope;
  const customerScope = target.customerReadScope;
  if (!policyScope || !customerScope) throw new RenewalCommandError('FORBIDDEN', 403);
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
         JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
         JOIN policies p ON p.agency_id=m.agency_id AND p.id=?
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
           AND (m.type='OWNER' OR (
             EXISTS(SELECT 1 FROM membership_permissions pr WHERE pr.membership_id=m.id
               AND pr.permission_code='policy.read' AND pr.scope=?
               AND (?='AGENCY' OR p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id))
             AND EXISTS(SELECT 1 FROM membership_permissions cr WHERE cr.membership_id=m.id
               AND cr.permission_code='customer.read' AND cr.scope=?
               AND (?='AGENCY' OR c.assignee_membership_id=m.id))
           ))
           AND (b.data_classification<>'HEALTH' OR EXISTS(
             SELECT 1 FROM membership_permissions sh WHERE sh.membership_id=m.id
               AND sh.permission_code='sensitive.health.read' AND sh.scope='UNSCOPED'))
       ) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(
      crypto.randomUUID(),
      context.identityId,
      target.id,
      active.id,
      active.agencyId,
      context.userId,
      active.permissionVersion,
      policyScope,
      policyScope,
      customerScope,
      customerScope,
    );
}

export function wonPolicyReplayVersionAssertion(
  db: D1Database,
  agencyId: string,
  target: WonPolicyTarget,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM policies p WHERE p.agency_id=? AND p.id=? AND p.version=?
       ) THEN 1 ELSE 0 END,'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
    )
    .bind(crypto.randomUUID(), agencyId, target.id, target.version);
}

function wonPolicyCreateAuthorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  input: {
    readonly customerId: string;
    readonly customerAssigneeMembershipId: string | null;
    readonly assigneeMembershipId: string;
    readonly branchId: string;
    readonly classification: 'GENERAL' | 'HEALTH';
    readonly requiresAgencyAssign: boolean;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
         JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
         JOIN customers c ON c.agency_id=m.agency_id AND c.id=? AND c.archived_at IS NULL
         JOIN insurance_branches b ON b.agency_id=m.agency_id AND b.id=?
         JOIN agency_memberships target_assignee ON target_assignee.agency_id=m.agency_id
           AND target_assignee.id=? AND target_assignee.status='ACTIVE'
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
           AND (m.type='OWNER' OR (
             EXISTS(SELECT 1 FROM membership_permissions pc WHERE pc.membership_id=m.id
               AND pc.permission_code='policy.create' AND pc.scope='UNSCOPED')
             AND EXISTS(SELECT 1 FROM membership_permissions pr WHERE pr.membership_id=m.id
               AND pr.permission_code='policy.read' AND
                 (pr.scope='AGENCY' OR (pr.scope='ASSIGNED'
                   AND (?=m.id OR c.assignee_membership_id=m.id)))
             )
             AND EXISTS(SELECT 1 FROM membership_permissions cr WHERE cr.membership_id=m.id
               AND cr.permission_code='customer.read' AND
                 (cr.scope='AGENCY' OR (cr.scope='ASSIGNED' AND c.assignee_membership_id=m.id))
             )
             AND (?=0 OR (
               EXISTS(SELECT 1 FROM membership_permissions pa WHERE pa.membership_id=m.id
                 AND pa.permission_code='policy.assign' AND pa.scope='AGENCY')
               AND EXISTS(SELECT 1 FROM membership_permissions pr WHERE pr.membership_id=m.id
                 AND pr.permission_code='policy.read' AND pr.scope='AGENCY')
             ))
           ))
           AND (b.data_classification<>'HEALTH' OR (
             EXISTS(SELECT 1 FROM membership_permissions sr WHERE sr.membership_id=m.id
               AND sr.permission_code='sensitive.health.read' AND sr.scope='UNSCOPED')
             AND EXISTS(SELECT 1 FROM membership_permissions sw WHERE sw.membership_id=m.id
               AND sw.permission_code='sensitive.health.write' AND sw.scope='UNSCOPED')
           ))
       ) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(
      crypto.randomUUID(),
      context.identityId,
      input.customerId,
      input.branchId,
      input.assigneeMembershipId,
      active.id,
      active.agencyId,
      context.userId,
      active.permissionVersion,
      input.assigneeMembershipId,
      input.requiresAgencyAssign ? 1 : 0,
    );
}

export function closeRenewalWonStatement(
  db: D1Database,
  active: ActiveMembership,
  row: RenewalTaskRow,
  closedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE renewal_opportunities
       SET state='WON',loss_reason_id=NULL,loss_reason_notes=NULL,void_reason_code=NULL,
           closed_at=?,closed_by_membership_id=?,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND version=?
         AND state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
         AND closed_at IS NULL AND assignee_membership_id IS ?
         AND EXISTS(SELECT 1 FROM tasks t WHERE t.agency_id=renewal_opportunities.agency_id
           AND t.renewal_id=renewal_opportunities.id AND t.id=? AND t.kind='RENEWAL_FOLLOWUP'
           AND t.status='COMPLETED' AND t.version=? AND t.completed_at=?
           AND t.completed_by_membership_id=?)
         AND EXISTS(SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=renewal_opportunities.agency_id
           AND l.renewal_id=renewal_opportunities.id AND l.status='ACTIVE')`,
    )
    .bind(
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

function wonLinkInsert(
  db: D1Database,
  input: {
    readonly id: string;
    readonly agencyId: string;
    readonly renewalId: string;
    readonly policyId: string;
    readonly amount: number;
    readonly currency: string;
    readonly operationId: string;
    readonly membershipId: string;
    readonly createdAt: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO renewal_policy_links
         (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
          allocation_operation_id,created_by_membership_id,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      input.id,
      input.agencyId,
      input.renewalId,
      input.policyId,
      input.amount,
      input.currency,
      input.operationId,
      input.membershipId,
      input.createdAt,
    );
}

function wonQuoteAcceptanceAssertion(
  db: D1Database,
  agencyId: string,
  renewalId: string,
  quoteId: string,
  quoteVersionId: string,
  quoteVersion: number,
  policyId: string,
  operationId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM renewal_quotes q JOIN renewal_quote_versions v
           ON v.agency_id=q.agency_id AND v.quote_id=q.id AND v.id=?
         JOIN renewal_quote_events sent ON sent.agency_id=q.agency_id AND sent.quote_id=q.id
           AND sent.quote_version_id=v.id AND sent.event='SENT'
         JOIN renewal_opportunities r ON r.agency_id=q.agency_id AND r.id=q.renewal_id
         JOIN renewal_policy_links l ON l.agency_id=r.agency_id AND l.renewal_id=r.id
           AND l.new_policy_id=? AND l.status='ACTIVE'
         WHERE q.agency_id=? AND q.id=? AND q.renewal_id=? AND q.status='SENT'
           AND q.current_version_id=v.id AND q.version=? AND r.state='WON'
           AND NOT EXISTS(SELECT 1 FROM renewal_quote_events accepted
             WHERE accepted.agency_id=q.agency_id AND accepted.quote_id=q.id AND accepted.event='ACCEPTED')
           AND EXISTS(SELECT 1 FROM operation_receipts receipt WHERE receipt.id=?
             AND receipt.agency_id=q.agency_id AND receipt.action='renewal.close_won'
             AND receipt.status='COMPLETED')
       ) THEN 1 ELSE 0 END,'RENEWAL_QUOTE_ACCEPTANCE_CONFLICT'`,
    )
    .bind(
      crypto.randomUUID(),
      quoteVersionId,
      policyId,
      agencyId,
      quoteId,
      renewalId,
      quoteVersion,
      operationId,
    );
}

function wonQuoteAuthorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
): D1PreparedStatement {
  const healthPermission =
    row.branch_data_classification === 'HEALTH'
      ? `AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions health
          WHERE health.membership_id=m.id AND health.permission_code='policy.read'
            AND health.scope IN ('AGENCY','ASSIGNED')
            AND (health.scope='AGENCY' OR p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)))
         AND EXISTS(SELECT 1 FROM membership_permissions sensitive
          WHERE sensitive.membership_id=m.id AND sensitive.permission_code='sensitive.health.read'
            AND sensitive.scope='UNSCOPED')`
      : '';
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
         JOIN agencies a ON a.id=m.agency_id
         JOIN auth_identities identity ON identity.user_id=u.id AND identity.id=? AND identity.status='ACTIVE'
         JOIN renewal_opportunities r ON r.agency_id=m.agency_id AND r.id=?
         JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND m.permission_version=? AND u.status='ACTIVE' AND a.status='ACTIVE'
           AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions manage
             WHERE manage.membership_id=m.id AND manage.permission_code='quote.manage'
               AND manage.scope IN ('AGENCY','ASSIGNED')
               AND (manage.scope='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)))
           AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions read_permission
             WHERE read_permission.membership_id=m.id AND read_permission.permission_code='quote.read'
               AND read_permission.scope IN ('AGENCY','ASSIGNED')
               AND (read_permission.scope='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)))
           ${healthPermission}
       ) THEN 1 ELSE 0 END,'MEMBERSHIP_AUTHORIZED'`,
    )
    .bind(
      crypto.randomUUID(),
      context.identityId,
      row.renewal_id,
      active.id,
      active.agencyId,
      context.userId,
      active.permissionVersion,
    );
}

function wonQuoteAcceptanceEventInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  quoteId: string,
  quoteVersionId: string,
  policyId: string,
  operationId: string,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO renewal_quote_events
       (id,agency_id,quote_id,quote_version_id,event,operation_receipt_id,accepted_policy_id,
        actor_user_id,actor_membership_id,occurred_at)
       VALUES(?,?,?,?,'ACCEPTED',?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      active.agencyId,
      quoteId,
      quoteVersionId,
      operationId,
      policyId,
      context.userId,
      active.id,
      now,
    );
}

function wonQuoteAcceptUpdate(
  db: D1Database,
  active: ActiveMembership,
  quoteId: string,
  quoteVersionId: string,
  policyId: string,
  expectedQuoteVersion: number,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE renewal_quotes SET status='ACCEPTED',accepted_version_id=?,accepted_policy_id=?,
         version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND status='SENT' AND current_version_id=? AND version=?`,
    )
    .bind(
      quoteVersionId,
      policyId,
      now,
      active.agencyId,
      quoteId,
      quoteVersionId,
      expectedQuoteVersion,
    );
}

export function wonAuditStatement(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  action: 'policy.create' | 'renewal.closed_won',
  targetType: 'policies' | 'renewal_opportunities',
  targetId: string,
  idempotencyKey: string,
  createdAt: string,
  metadata: Record<string, unknown>,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action,
    targetType,
    targetId,
    correlationId: idempotencyKey,
    idempotencyKey,
    outcome: 'SUCCESS',
    createdAt,
    metadata,
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

function parseWonReceipt(
  receipt: ReceiptRow,
  expectedFingerprint: string,
  input: CloseRenewalWonInput,
  renewalId: string,
  taskId: string,
): RenewalWonResult {
  if (
    receipt.action !== CLOSE_WON_ACTION ||
    receipt.payload_fingerprint !== expectedFingerprint ||
    receipt.status !== 'COMPLETED' ||
    (receipt.response_status !== 200 && receipt.response_status !== 201) ||
    !receipt.response_body
  ) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(receipt.response_body);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const result = raw as Record<string, unknown>;
  const keys = [
    'renewalId',
    'previousState',
    'state',
    'primaryTaskId',
    'renewalVersion',
    'taskVersion',
    'closedAt',
    'createdPolicyId',
    'acceptedQuoteVersionId',
    'acceptedPolicyId',
    'newPolicyIds',
    'linkIds',
    'links',
  ].sort();
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(keys)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (
    result.renewalId !== renewalId ||
    result.state !== 'WON' ||
    result.primaryTaskId !== taskId ||
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(String(result.previousState)) ||
    result.renewalVersion !== input.expectedRenewalVersion + 1 ||
    result.taskVersion !== input.expectedTaskVersion + 1 ||
    !isCanonicalTimestamp(result.closedAt) ||
    result.acceptedQuoteVersionId !== (input.acceptedQuoteVersionId ?? null) ||
    (result.createdPolicyId !== null &&
      (typeof result.createdPolicyId !== 'string' || result.createdPolicyId.trim() === '')) ||
    (result.acceptedQuoteVersionId !== null &&
      (typeof result.acceptedQuoteVersionId !== 'string' ||
        result.acceptedQuoteVersionId.trim() === '')) ||
    (result.acceptedPolicyId !== null &&
      (typeof result.acceptedPolicyId !== 'string' || result.acceptedPolicyId.trim() === '')) ||
    (result.acceptedQuoteVersionId === null) !== (result.acceptedPolicyId === null) ||
    !Array.isArray(result.newPolicyIds) ||
    !Array.isArray(result.linkIds) ||
    !Array.isArray(result.links) ||
    result.links.length === 0 ||
    result.newPolicyIds.some((id) => typeof id !== 'string' || id.trim() === '') ||
    result.linkIds.some((id) => typeof id !== 'string' || id.trim() === '')
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const links = (result.links as unknown[]).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    const link = item as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(link).sort()) !==
        JSON.stringify(
          [
            'id',
            'newPolicyId',
            'allocatedNewPremiumMinor',
            'currency',
            'differentPolicyholderReasonCode',
          ].sort(),
        ) ||
      typeof link.id !== 'string' ||
      typeof link.newPolicyId !== 'string' ||
      !Number.isSafeInteger(link.allocatedNewPremiumMinor) ||
      (link.allocatedNewPremiumMinor as number) < 0 ||
      typeof link.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(link.currency) ||
      (link.differentPolicyholderReasonCode !== null &&
        (typeof link.differentPolicyholderReasonCode !== 'string' ||
          !/^[A-Z][A-Z0-9_]{2,63}$/.test(link.differentPolicyholderReasonCode)))
    ) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    return {
      id: link.id,
      newPolicyId: link.newPolicyId,
      allocatedNewPremiumMinor: link.allocatedNewPremiumMinor as number,
      currency: link.currency,
      differentPolicyholderReasonCode: link.differentPolicyholderReasonCode as string | null,
    };
  });
  const newPolicyIds = [...new Set(links.map((link) => link.newPolicyId))].sort();
  const linkIds = links.map((link) => link.id).sort();
  if (
    JSON.stringify(result.newPolicyIds) !== JSON.stringify(newPolicyIds) ||
    JSON.stringify(result.linkIds) !== JSON.stringify(linkIds) ||
    (result.acceptedPolicyId !== null && !newPolicyIds.includes(String(result.acceptedPolicyId))) ||
    (result.createdPolicyId !== null &&
      (links.length !== 1 || links[0]?.newPolicyId !== result.createdPolicyId)) ||
    receipt.response_status !== (result.createdPolicyId === null ? 200 : 201)
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const parsed: RenewalWonResult = {
    renewalId,
    previousState: result.previousState as string,
    state: 'WON',
    primaryTaskId: taskId,
    renewalVersion: result.renewalVersion as number,
    taskVersion: result.taskVersion as number,
    closedAt: result.closedAt,
    createdPolicyId: result.createdPolicyId as string | null,
    acceptedQuoteVersionId: result.acceptedQuoteVersionId as string | null,
    acceptedPolicyId: result.acceptedPolicyId as string | null,
    newPolicyIds,
    linkIds,
    links,
  };
  if (receipt.response_body !== JSON.stringify(parsed)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return parsed;
}

async function assertWonReplay(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
  receipt: ReceiptRow,
  result: RenewalWonResult,
  idempotencyKey: string,
  quoteDifferenceReasonCode: string | undefined,
  targets: readonly WonPolicyTarget[],
): Promise<void> {
  const authority = actorAuthorityPredicate(
    context,
    active,
    row,
    scopes,
    CLOSE_WON_ACTION,
    'task.update',
    scopes.taskUpdate,
    false,
  );
  const linkValues = result.links.map(() => '(?,?,?,?,?)').join(',');
  const policyReadChecks = targets.map((target) => {
    const policyScope = target.policyReadScope;
    const customerScope = target.customerReadScope;
    if (!policyScope || !customerScope) throw new RenewalCommandError('FORBIDDEN', 403);
    return `EXISTS(SELECT 1 FROM policies p JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
      JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
      WHERE p.agency_id=m.agency_id AND p.id=? AND
        (m.type='OWNER' OR (
          EXISTS(SELECT 1 FROM membership_permissions pr WHERE pr.membership_id=m.id
            AND pr.permission_code='policy.read' AND pr.scope='${policyScope}'
            AND ('${policyScope}'='AGENCY' OR p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id))
          AND EXISTS(SELECT 1 FROM membership_permissions cr WHERE cr.membership_id=m.id
            AND cr.permission_code='customer.read' AND cr.scope='${customerScope}'
            AND ('${customerScope}'='AGENCY' OR c.assignee_membership_id=m.id))
        ))
        AND (b.data_classification<>'HEALTH' OR EXISTS(
          SELECT 1 FROM membership_permissions sh WHERE sh.membership_id=m.id
            AND sh.permission_code='sensitive.health.read' AND sh.scope='UNSCOPED')))`;
  });
  const proof = await db
    .prepare(
      `WITH expected_links(id,new_policy_id,amount,currency,different_reason) AS (
         VALUES ${linkValues}
       )
       SELECT CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END AS authority_count,
         (SELECT count(*) FROM operation_receipts r WHERE r.id=? AND r.agency_id=?
           AND r.actor_user_id=? AND r.actor_membership_id=? AND r.action=?
           AND r.idempotency_key=? AND r.payload_fingerprint=? AND r.status='COMPLETED'
           AND r.response_status=? AND r.response_body=?) AS receipt_count,
         (SELECT count(*) FROM tasks t WHERE t.agency_id=? AND t.id=? AND t.renewal_id=?
           AND t.kind='RENEWAL_FOLLOWUP' AND t.status='COMPLETED' AND t.version=?
           AND t.completed_at=? AND t.completed_by_membership_id=?) AS task_count,
         (SELECT count(*) FROM renewal_state_history h WHERE h.agency_id=? AND h.renewal_id=?
           AND h.from_state=? AND h.to_state='WON' AND h.actor_kind='USER' AND h.actor_user_id=?
           AND h.actor_membership_id=? AND h.reason_code='WON' AND h.created_at=?) AS history_count,
         (SELECT count(*) FROM audit_events a WHERE a.agency_id=? AND a.actor_user_id=?
           AND a.actor_membership_id=? AND a.action='renewal.closed_won'
           AND a.target_type='renewal_opportunities' AND a.target_id=? AND a.idempotency_key=?
           AND a.outcome='SUCCESS' AND a.created_at=?
           AND json_extract(a.metadata_json,'$.quoteDifferenceReasonCode') IS ?) AS won_audit_count,
         (SELECT count(*) FROM expected_links e JOIN renewal_policy_links l
           ON l.agency_id=? AND l.renewal_id=? AND l.id=e.id AND l.new_policy_id=e.new_policy_id
            AND l.allocated_new_premium_minor=e.amount AND l.currency=e.currency
            AND l.different_policyholder_reason_code IS e.different_reason
            AND l.status IN ('ACTIVE','SUPERSEDED')) AS link_count,
         (SELECT count(*) FROM audit_events a WHERE a.agency_id=? AND a.actor_user_id=?
           AND a.actor_membership_id=? AND a.action='policy.create' AND a.target_type='policies'
           AND a.target_id=? AND a.idempotency_key=? AND a.outcome='SUCCESS') AS policy_audit_count,
         CASE WHEN ${policyReadChecks.length ? policyReadChecks.map((check) => `(${check})`).join(' AND ') : '0'}
           THEN 1 ELSE 0 END AS policy_authority_count,
         (SELECT count(*) FROM renewal_quote_events e JOIN renewal_quotes q
           ON q.agency_id=e.agency_id AND q.id=e.quote_id
          WHERE e.agency_id=? AND e.event='ACCEPTED'
            AND e.quote_version_id IS ? AND e.accepted_policy_id IS ?
            AND e.operation_receipt_id=? AND q.status='ACCEPTED'
            AND q.accepted_version_id=e.quote_version_id AND q.accepted_policy_id=e.accepted_policy_id) AS quote_acceptance_count
       FROM agency_memberships m JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
       WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
         AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
         AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')`,
    )
    .bind(
      ...result.links.flatMap((link) => [
        link.id,
        link.newPolicyId,
        link.allocatedNewPremiumMinor,
        link.currency,
        link.differentPolicyholderReasonCode,
      ]),
      ...authority.bindings,
      receipt.id,
      active.agencyId,
      context.userId,
      active.id,
      CLOSE_WON_ACTION,
      idempotencyKey,
      receipt.payload_fingerprint,
      receipt.response_status,
      receipt.response_body,
      active.agencyId,
      result.primaryTaskId,
      result.renewalId,
      result.taskVersion,
      result.closedAt,
      active.id,
      active.agencyId,
      result.renewalId,
      result.previousState,
      context.userId,
      active.id,
      result.closedAt,
      active.agencyId,
      context.userId,
      active.id,
      result.renewalId,
      idempotencyKey,
      result.closedAt,
      quoteDifferenceReasonCode ?? null,
      active.agencyId,
      result.renewalId,
      active.agencyId,
      context.userId,
      active.id,
      result.createdPolicyId ?? '',
      idempotencyKey,
      ...targets.map((target) => target.id),
      active.agencyId,
      result.acceptedQuoteVersionId,
      result.acceptedPolicyId,
      receipt.id,
      active.id,
      active.agencyId,
      context.userId,
      active.permissionVersion,
      context.identityId,
    )
    .first<{
      authority_count: number;
      receipt_count: number;
      task_count: number;
      history_count: number;
      won_audit_count: number;
      link_count: number;
      policy_audit_count: number;
      policy_authority_count: number;
      quote_acceptance_count: number;
    }>();
  if (
    proof?.authority_count !== 1 ||
    proof.receipt_count !== 1 ||
    proof.task_count !== 1 ||
    proof.history_count !== 1 ||
    proof.won_audit_count !== 1 ||
    proof.link_count !== result.links.length ||
    proof.policy_audit_count !== (result.createdPolicyId ? 1 : 0) ||
    proof.policy_authority_count !== 1 ||
    proof.quote_acceptance_count !== (result.acceptedQuoteVersionId ? 1 : 0)
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

function mapWonBatchError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('RENEWAL_WON_CORRECTION_REQUIRED')) {
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  }
  if (
    message.includes('RENEWAL_WON_LINK_REQUIRED') ||
    message.includes('RENEWAL_WON_ALLOCATION_INCOMPLETE') ||
    message.includes('RENEWAL_POLICY_LINK_ALLOCATION_OVERFLOW') ||
    message.includes('RENEWAL_POLICY_LINK_TARGET_INVALID')
  ) {
    throw new RenewalCommandError('WON_ALLOCATION_INVALID', 409);
  }
  if (
    message.includes('POLICY_IDENTITY') ||
    message.includes('policies.agency_id') ||
    message.includes('POLICY_UNIQUE')
  ) {
    throw new RenewalCommandError('POLICY_IDENTITY_CONFLICT', 409);
  }
  mapBatchError(error);
}

export async function closeRenewalWon(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawIdempotencyKey: string,
): Promise<{ data: RenewalWonResult; replayed: boolean; status: 200 | 201 }> {
  const active = activeMembership(context);
  const input = closeRenewalWonSchema.parse(rawInput);
  const idempotencyKey = rawIdempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  }
  const fingerprint = await computePayloadHash({
    action: CLOSE_WON_ACTION,
    target: renewalId,
    payload: input,
    version: {
      expectedRenewalVersion: input.expectedRenewalVersion,
      expectedTaskVersion: input.expectedTaskVersion,
    },
  });
  const receipt = await readReceipt(db, active, context.userId, idempotencyKey);
  let receiptRenewalId: string | null = null;
  if (receipt?.response_body) {
    try {
      const value = JSON.parse(receipt.response_body) as Record<string, unknown>;
      receiptRenewalId = typeof value.renewalId === 'string' ? value.renewalId : null;
    } catch {
      receiptRenewalId = null;
    }
  }
  const sameTarget = receiptRenewalId === renewalId;
  const row = await loadRenewalTask(db, active.agencyId, renewalId);
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  let scopes: AuthorizationScopes;
  try {
    scopes = await authorizeCurrentTarget(db, context, row, CLOSE_WON_ACTION);
  } catch (error) {
    if (receipt) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    throw error;
  }
  if (receipt) {
    if (receipt.action !== CLOSE_WON_ACTION || !sameTarget) {
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    }
    const originalTaskId = receiptTaskId(receipt);
    if (!originalTaskId) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    const result = parseWonReceipt(receipt, fingerprint, input, renewalId, originalTaskId);
    const originalLinks = await db
      .prepare(
        `SELECT l.id,l.new_policy_id,l.allocated_new_premium_minor,l.currency,
                l.different_policyholder_reason_code,l.allocation_operation_id,l.status,
                allocation.action AS allocation_action,allocation.status AS allocation_status,
                allocation.response_status AS allocation_response_status,
                allocation.actor_membership_id AS allocation_actor_membership_id,
                l.created_by_membership_id
         FROM renewal_policy_links l
         JOIN operation_receipts allocation
           ON allocation.id=l.allocation_operation_id AND allocation.agency_id=l.agency_id
         WHERE l.agency_id=? AND l.renewal_id=?
           AND l.status IN ('ACTIVE','SUPERSEDED')
           AND l.id IN (${result.linkIds.map(() => '?').join(',')})`,
      )
      .bind(active.agencyId, renewalId, ...result.linkIds)
      .all<{
        id: string;
        new_policy_id: string;
        allocated_new_premium_minor: number;
        currency: string;
        different_policyholder_reason_code: string | null;
        allocation_operation_id: string;
        status: 'ACTIVE' | 'SUPERSEDED';
        allocation_action: string;
        allocation_status: string;
        allocation_response_status: number | null;
        allocation_actor_membership_id: string;
        created_by_membership_id: string;
      }>();
    const linkById = new Map(originalLinks.results.map((link) => [link.id, link]));
    if (
      originalLinks.results.length !== result.links.length ||
      result.links.some((link) => {
        const persisted = linkById.get(link.id);
        if (!persisted) return true;
        const allocationEvidenceValid =
          persisted.allocation_actor_membership_id === persisted.created_by_membership_id &&
          (input.result.kind === 'EXISTING_LINKS'
            ? persisted.allocation_action === 'renewal.policy_links.allocate' &&
              persisted.allocation_status === 'COMPLETED' &&
              persisted.allocation_response_status === 201
            : persisted.allocation_operation_id === receipt.id &&
              persisted.allocation_action === CLOSE_WON_ACTION &&
              persisted.allocation_status === 'COMPLETED' &&
              persisted.allocation_response_status === receipt.response_status);
        return (
          !allocationEvidenceValid ||
          persisted.new_policy_id !== link.newPolicyId ||
          persisted.allocated_new_premium_minor !== link.allocatedNewPremiumMinor ||
          persisted.currency !== link.currency ||
          persisted.different_policyholder_reason_code !== link.differentPolicyholderReasonCode
        );
      })
    ) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    const rawTargets = await Promise.all(
      result.newPolicyIds.map((policyId) => loadWonPolicy(db, active.agencyId, policyId)),
    );
    if (rawTargets.some((target) => target === null))
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    const targets = await authorizeWonPolicyTargets(
      db,
      context,
      active.agencyId,
      rawTargets.filter((target): target is WonPolicyTarget => target !== null),
    );
    if (result.createdPolicyId) {
      const created = targets.find((target) => target.id === result.createdPolicyId);
      if (!created) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
      await authorize(
        db,
        context,
        created.data_classification === 'HEALTH' ? 'policy.health.create' : 'policy.create',
        {
          agencyId: active.agencyId,
          isCreate: true,
          assigneeMembershipId: created.assignee_membership_id,
          customerAssigneeMembershipId: created.customer_assignee_membership_id,
          branchId: created.branch_id,
        },
      );
    }
    await assertWonReplay(
      db,
      context,
      active,
      row,
      scopes,
      receipt,
      result,
      idempotencyKey,
      input.quoteDifferenceReasonCode,
      targets,
    );
    return { data: result, replayed: true, status: 200 };
  }

  if (
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(row.renewal_state) ||
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

  const current = await loadWonLinks(db, active.agencyId, renewalId);
  let createdPolicyId: string | null = null;
  let policyIdForInsert: string | null = null;
  let allocationForInsert: { readonly amount: number; readonly currency: string } | null = null;
  let policyCreateData: ReturnType<typeof parsePolicyCreateInput> | null = null;
  let insurerId: string | null = null;
  let assigneeId: string | null = null;
  let policyClassification: 'GENERAL' | 'HEALTH' | null = null;
  let targets: WonPolicyTarget[];
  let links = current.links.map((link) => ({
    id: link.id,
    newPolicyId: link.newPolicyId,
    allocatedNewPremiumMinor: link.allocatedNewPremiumMinor,
    currency: link.currency,
    differentPolicyholderReasonCode: link.differentPolicyholderReasonCode,
  }));

  if (input.result.kind === 'CREATE_POLICY') {
    if (current.links.length !== 0)
      throw new RenewalCommandError('RENEWAL_POLICY_LINK_CONFLICT', 409);
    try {
      policyCreateData = parsePolicyCreateInput(input.result.policy);
    } catch {
      throw new RenewalCommandError('VALIDATION_ERROR', 400);
    }
    if (policyCreateData.customerId !== row.customer_id || policyCreateData.status !== 'ACTIVE') {
      throw new RenewalCommandError('WON_POLICY_TARGET_INVALID', 409);
    }
    insurerId =
      policyCreateData.insurerId ??
      (
        await db
          .prepare('SELECT default_insurer_id FROM agency_settings WHERE agency_id=?')
          .bind(active.agencyId)
          .first<{ default_insurer_id: string | null }>()
      )?.default_insurer_id ??
      null;
    if (!insurerId) throw new RenewalCommandError('DEFAULT_INSURER_REQUIRED', 409);
    assigneeId = policyCreateData.assigneeMembershipId ?? active.id;
    if (assigneeId !== active.id) {
      const assignScope = await authorize(db, context, 'policy.assign', {
        agencyId: active.agencyId,
        assigneeMembershipId: active.id,
        customerAssigneeMembershipId: row.customer_assignee_membership_id,
      });
      if (assignScope !== 'AGENCY') throw new RenewalCommandError('FORBIDDEN', 403);
    }
    const assignTarget = await db
      .prepare("SELECT id FROM agency_memberships WHERE agency_id=? AND id=? AND status='ACTIVE'")
      .bind(active.agencyId, assigneeId)
      .first();
    if (!assignTarget) throw new RenewalCommandError('POLICY_ASSIGNEE_NOT_ACTIVE', 409);
    policyClassification = await validateWonPolicyCatalogs(
      db,
      active.agencyId,
      policyCreateData,
      insurerId,
    );
    await authorize(
      db,
      context,
      policyClassification === 'HEALTH' ? 'policy.health.create' : 'policy.create',
      {
        agencyId: active.agencyId,
        isCreate: true,
        assigneeMembershipId: assigneeId,
        customerAssigneeMembershipId: row.customer_assignee_membership_id,
        branchId: policyCreateData.branchId,
      },
    );
    const policyReadScope = await authorize(
      db,
      context,
      policyClassification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
      {
        agencyId: active.agencyId,
        assigneeMembershipId: assigneeId,
        customerAssigneeMembershipId: row.customer_assignee_membership_id,
        branchId: policyCreateData.branchId,
      },
    );
    const customerReadScope = await authorize(db, context, 'customer.read', {
      agencyId: active.agencyId,
      assigneeMembershipId: row.customer_assignee_membership_id,
    });
    const newPolicyId = crypto.randomUUID();
    const newLinkId = crypto.randomUUID();
    createdPolicyId = newPolicyId;
    policyIdForInsert = newPolicyId;
    allocationForInsert = {
      amount: policyCreateData.grossPremiumMinor,
      currency: policyCreateData.currency,
    };
    targets = [
      {
        id: newPolicyId,
        agency_id: active.agencyId,
        customer_id: policyCreateData.customerId,
        product_id: policyCreateData.productId,
        version: 1,
        status: 'ACTIVE',
        archived_at: null,
        gross_premium_minor: policyCreateData.grossPremiumMinor,
        currency: policyCreateData.currency,
        assignee_membership_id: assigneeId,
        branch_id: policyCreateData.branchId,
        data_classification: policyClassification,
        customer_assignee_membership_id: row.customer_assignee_membership_id,
        customer_archived_at: null,
        policyReadScope,
        customerReadScope,
      },
    ];
    links = [
      {
        id: newLinkId,
        newPolicyId,
        allocatedNewPremiumMinor: policyCreateData.grossPremiumMinor,
        currency: policyCreateData.currency,
        differentPolicyholderReasonCode: null,
      },
    ];
  } else if (input.result.kind === 'LINK_POLICY') {
    if (current.links.length !== 0)
      throw new RenewalCommandError('RENEWAL_POLICY_LINK_CONFLICT', 409);
    const target = await loadWonPolicy(db, active.agencyId, input.result.newPolicyId);
    if (!target) throw new RenewalCommandError('NOT_FOUND', 404);
    if (
      target.customer_id !== row.customer_id ||
      target.version !== input.result.expectedPolicyVersion ||
      target.status !== 'ACTIVE' ||
      target.archived_at !== null ||
      target.currency !== input.result.currency
    ) {
      throw new RenewalCommandError('WON_POLICY_TARGET_INVALID', 409);
    }
    const authorizedTargets = await authorizeWonPolicyTargets(db, context, active.agencyId, [
      target,
    ]);
    const total = await db
      .prepare(
        `SELECT COALESCE(sum(allocated_new_premium_minor),0) AS allocated
         FROM renewal_policy_links WHERE agency_id=? AND new_policy_id=? AND status='ACTIVE'`,
      )
      .bind(active.agencyId, target.id)
      .first<{ allocated: number }>();
    if (
      !total ||
      total.allocated + input.result.allocatedNewPremiumMinor !== target.gross_premium_minor
    ) {
      throw new RenewalCommandError('WON_ALLOCATION_INCOMPLETE', 409);
    }
    policyIdForInsert = target.id;
    allocationForInsert = {
      amount: input.result.allocatedNewPremiumMinor,
      currency: input.result.currency,
    };
    targets = authorizedTargets;
    links = [
      {
        id: crypto.randomUUID(),
        newPolicyId: target.id,
        allocatedNewPremiumMinor: input.result.allocatedNewPremiumMinor,
        currency: input.result.currency,
        differentPolicyholderReasonCode: null,
      },
    ];
  } else if (current.links.length === 0) {
    throw new RenewalCommandError('WON_POLICY_LINK_REQUIRED', 409);
  } else {
    targets = await authorizeWonPolicyTargets(db, context, active.agencyId, current.targets);
  }

  if (
    targets.some(
      (target) =>
        target.status !== 'ACTIVE' ||
        target.archived_at !== null ||
        target.customer_archived_at !== null,
    )
  ) {
    throw new RenewalCommandError('WON_POLICY_TARGET_INVALID', 409);
  }
  const ownerRequired = targets.some((target) => target.customer_id !== row.customer_id);
  if (ownerRequired && active.type !== 'OWNER') {
    throw new RenewalCommandError('OWNER_REVIEW_REQUIRED', 403);
  }
  for (const link of links) {
    const target = targets.find((item) => item.id === link.newPolicyId);
    if (
      !target ||
      target.currency !== link.currency ||
      (target.customer_id !== row.customer_id && !link.differentPolicyholderReasonCode) ||
      (target.customer_id === row.customer_id && link.differentPolicyholderReasonCode !== null)
    ) {
      throw new RenewalCommandError('WON_POLICY_TARGET_INVALID', 409);
    }
  }
  const ids = new Set<string>();
  for (const link of links) {
    const pair = `${renewalId}\u0000${link.newPolicyId}`;
    if (ids.has(pair)) throw new RenewalCommandError('WON_POLICY_LINK_DUPLICATE', 409);
    ids.add(pair);
  }

  let acceptedQuote: {
    readonly id: string;
    readonly version: number;
    readonly policyId: string;
  } | null = null;
  if (input.acceptedQuoteVersionId) {
    if (links.length !== 1) throw new RenewalCommandError('QUOTE_POLICY_LINK_AMBIGUOUS', 409);
    const quotePermission = await evaluateAuthorization(db, {
      context,
      action: 'quote.manage',
      resource: renewalResource(row),
    });
    if (quotePermission.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
    const quote = await db
      .prepare(
        `SELECT q.id,q.version,q.current_version_id,v.valid_until,
                v.product_id,v.gross_premium_minor,v.currency
         FROM renewal_quotes q JOIN renewal_quote_versions v
           ON v.agency_id=q.agency_id AND v.quote_id=q.id
         JOIN renewal_quote_events sent ON sent.agency_id=q.agency_id AND sent.quote_id=q.id
           AND sent.quote_version_id=v.id AND sent.event='SENT'
         WHERE q.agency_id=? AND q.renewal_id=? AND q.status='SENT'
           AND q.current_version_id=v.id AND v.id=?
           AND NOT EXISTS(SELECT 1 FROM renewal_quote_events accepted
             WHERE accepted.agency_id=q.agency_id AND accepted.quote_id=q.id AND accepted.event='ACCEPTED')`,
      )
      .bind(active.agencyId, renewalId, input.acceptedQuoteVersionId)
      .first<{
        id: string;
        version: number;
        current_version_id: string;
        valid_until: string;
        product_id: string;
        gross_premium_minor: number;
        currency: string;
      }>();
    if (!quote) throw new RenewalCommandError('QUOTE_ACCEPTANCE_INVALID', 409);
    if (Date.parse(quote.valid_until) <= Date.now())
      throw new RenewalCommandError('QUOTE_EXPIRED', 409);
    const acceptedPolicyTarget = targets.find((target) => target.id === links[0]!.newPolicyId);
    if (!acceptedPolicyTarget) throw new RenewalCommandError('QUOTE_ACCEPTANCE_INVALID', 409);
    const differsFromQuote =
      acceptedPolicyTarget.product_id !== quote.product_id ||
      acceptedPolicyTarget.gross_premium_minor !== quote.gross_premium_minor ||
      acceptedPolicyTarget.currency !== quote.currency;
    if (differsFromQuote && !input.quoteDifferenceReasonCode) {
      throw new RenewalCommandError('QUOTE_DIFFERENCE_REASON_REQUIRED', 400);
    }
    if (!differsFromQuote && input.quoteDifferenceReasonCode) {
      throw new RenewalCommandError('QUOTE_DIFFERENCE_REASON_UNEXPECTED', 400);
    }
    acceptedQuote = {
      id: quote.id,
      version: quote.version,
      policyId: links[0]!.newPolicyId,
    };
  } else if (input.quoteDifferenceReasonCode) {
    throw new RenewalCommandError('QUOTE_DIFFERENCE_REASON_UNEXPECTED', 400);
  }

  const closedAt = new Date().toISOString();
  const responseStatus: 200 | 201 = createdPolicyId ? 201 : 200;
  const receiptId = crypto.randomUUID();
  const result: RenewalWonResult = {
    renewalId,
    previousState: row.renewal_state,
    state: 'WON',
    primaryTaskId: row.task_id,
    renewalVersion: row.renewal_version + 1,
    taskVersion: row.task_version + 1,
    closedAt,
    createdPolicyId,
    acceptedQuoteVersionId: acceptedQuote ? input.acceptedQuoteVersionId! : null,
    acceptedPolicyId: acceptedQuote?.policyId ?? null,
    newPolicyIds: [...new Set(links.map((link) => link.newPolicyId))].sort(),
    linkIds: links.map((link) => link.id).sort(),
    links: [...links].sort((a, b) => a.newPolicyId.localeCompare(b.newPolicyId)),
  };
  try {
    const statements: D1PreparedStatement[] = [
      actorAuthorityAssertion(db, context, active, row, scopes, CLOSE_WON_ACTION),
    ];
    if (policyCreateData && insurerId && assigneeId && policyClassification) {
      statements.push(
        wonPolicyCreateAuthorityAssertion(db, context, active, {
          customerId: policyCreateData.customerId,
          customerAssigneeMembershipId: row.customer_assignee_membership_id,
          assigneeMembershipId: assigneeId,
          branchId: policyCreateData.branchId,
          classification: policyClassification,
          requiresAgencyAssign: assigneeId !== active.id,
        }),
      );
    }
    statements.push(
      receiptInsert(
        db,
        active,
        context,
        idempotencyKey,
        CLOSE_WON_ACTION,
        fingerprint,
        result,
        closedAt,
        responseStatus,
        receiptId,
      ),
    );
    if (policyCreateData && insurerId && assigneeId) {
      statements.push(
        db
          .prepare(
            `INSERT INTO policies
             (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
              assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
              gross_premium_minor,currency,installment_count,status,identity_variant,
              identity_variant_reason,version,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',0,NULL,1,?,?)`,
          )
          .bind(
            createdPolicyId,
            active.agencyId,
            policyCreateData.customerId,
            insurerId,
            policyCreateData.productId,
            policyCreateData.branchId,
            policyCreateData.paymentMethodId,
            assigneeId,
            policyCreateData.policyNumber,
            policyCreateData.normalizedPolicyNumber,
            policyCreateData.startDate,
            policyCreateData.endDate,
            policyCreateData.grossPremiumMinor,
            policyCreateData.currency,
            policyCreateData.installmentCount,
            closedAt,
            closedAt,
          ),
        casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      );
    }
    for (const target of targets) {
      statements.push(
        wonPolicyReadAssertion(db, context, active, target),
        wonPolicyVersionAssertion(db, active.agencyId, target),
      );
    }
    if (policyIdForInsert && allocationForInsert) {
      const link = links[0]!;
      statements.push(
        wonLinkInsert(db, {
          id: link.id,
          agencyId: active.agencyId,
          renewalId,
          policyId: policyIdForInsert,
          amount: allocationForInsert.amount,
          currency: allocationForInsert.currency,
          operationId: receiptId,
          membershipId: active.id,
          createdAt: closedAt,
        }),
        casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      );
    }
    statements.push(
      completePrimaryTaskStatement(db, active, row, closedAt),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      closeRenewalWonStatement(db, active, row, closedAt),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      stateHistoryInsert(db, context, active, row, 'WON', 'WON', closedAt),
    );
    if (acceptedQuote && input.acceptedQuoteVersionId) {
      statements.push(
        wonQuoteAuthorityAssertion(db, context, active, row),
        wonQuoteAcceptanceAssertion(
          db,
          active.agencyId,
          renewalId,
          acceptedQuote.id,
          input.acceptedQuoteVersionId,
          acceptedQuote.version,
          acceptedQuote.policyId,
          receiptId,
        ),
        wonQuoteAcceptanceEventInsert(
          db,
          context,
          active,
          acceptedQuote.id,
          input.acceptedQuoteVersionId,
          acceptedQuote.policyId,
          receiptId,
          closedAt,
        ),
        casAssertion(db, 'RENEWAL_QUOTE_ACCEPTANCE_CONFLICT'),
        wonQuoteAcceptUpdate(
          db,
          active,
          acceptedQuote.id,
          input.acceptedQuoteVersionId,
          acceptedQuote.policyId,
          acceptedQuote.version,
          closedAt,
        ),
        casAssertion(db, 'RENEWAL_QUOTE_ACCEPTANCE_CONFLICT'),
      );
    }
    if (createdPolicyId) {
      statements.push(
        wonAuditStatement(
          db,
          context,
          active,
          'policy.create',
          'policies',
          createdPolicyId,
          idempotencyKey,
          closedAt,
          { changedFields: ['policy_created_from_renewal'] },
        ),
      );
    }
    statements.push(
      wonAuditStatement(
        db,
        context,
        active,
        'renewal.closed_won',
        'renewal_opportunities',
        renewalId,
        idempotencyKey,
        closedAt,
        {
          reasonCode: 'WON',
          changedFields: [
            'state',
            'closed_at',
            'primary_task_status',
            'policy_links',
            ...(input.quoteDifferenceReasonCode ? ['quote_difference'] : []),
          ],
          ...(input.quoteDifferenceReasonCode
            ? { quoteDifferenceReasonCode: input.quoteDifferenceReasonCode }
            : {}),
        },
      ),
    );
    await db.batch(statements);
  } catch (error) {
    if (isReceiptRace(error)) {
      const racedReceipt = await readReceipt(db, active, context.userId, idempotencyKey);
      if (racedReceipt) {
        if (racedReceipt.action !== CLOSE_WON_ACTION) {
          throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
        }
        const racedRow = await loadRenewalTask(
          db,
          active.agencyId,
          renewalId,
          receiptTaskId(racedReceipt),
        );
        if (!racedRow) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
        const racedScopes = await authorizeCurrentTarget(db, context, racedRow, CLOSE_WON_ACTION);
        const replay = parseWonReceipt(
          racedReceipt,
          fingerprint,
          input,
          renewalId,
          racedRow.task_id,
        );
        const racedLinks = await loadWonLinks(db, active.agencyId, renewalId);
        const authorizedTargets = await authorizeWonPolicyTargets(
          db,
          context,
          active.agencyId,
          racedLinks.targets,
        );
        await assertWonReplay(
          db,
          context,
          active,
          racedRow,
          racedScopes,
          racedReceipt,
          replay,
          idempotencyKey,
          input.quoteDifferenceReasonCode,
          authorizedTargets,
        );
        return { data: replay, replayed: true, status: 200 };
      }
    }
    mapWonBatchError(error);
  }
  return { data: result, replayed: false, status: responseStatus };
}

export type WonCorrectionBaseInput = ReturnType<typeof wonRenewalCorrectionGrantSchema.parse>;

export function wonCorrectionPayload(
  row: RenewalTaskRow,
  input: WonCorrectionBaseInput,
  links: readonly WonLinkRow[],
  targets: readonly WonPolicyTarget[],
): Record<string, unknown> {
  return {
    expectedRenewalVersion: input.expectedRenewalVersion,
    expectedTaskVersion: input.expectedTaskVersion,
    replacementDueAt: input.replacementDueAt,
    correctionReasonCode: input.correctionReasonCode,
    primaryTaskId: row.task_id,
    terminalClosedAt: row.renewal_closed_at,
    links: links.map((link) => ({
      id: link.id,
      newPolicyId: link.newPolicyId,
      allocatedNewPremiumMinor: link.allocatedNewPremiumMinor,
      currency: link.currency,
      allocationOperationId: link.allocationOperationId,
      differentPolicyholderReasonCode: link.differentPolicyholderReasonCode,
    })),
    policyVersions: targets.map((target) => ({ id: target.id, version: target.version })),
  };
}

export function validateWonCorrectionState(
  row: RenewalTaskRow,
  input: WonCorrectionBaseInput,
): void {
  if (
    row.renewal_state !== 'WON' ||
    row.renewal_closed_at === null ||
    row.renewal_closed_by_membership_id === null ||
    row.task_status !== 'COMPLETED' ||
    row.task_completed_at !== row.renewal_closed_at ||
    row.task_completed_by_membership_id !== row.renewal_closed_by_membership_id ||
    row.task_assignee_membership_id !== row.renewal_assignee_membership_id
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
}

export async function authorizeWonCorrectionReadScope(
  db: D1Database,
  context: AuthenticatedUserContext,
  row: RenewalTaskRow,
): Promise<AuthorizationScopes> {
  const parent = renewalResource(row);
  const customerRead = await authorize(db, context, 'customer.read', {
    agencyId: row.agency_id,
    assigneeMembershipId: row.customer_assignee_membership_id,
  });
  const policyRead = await authorize(
    db,
    context,
    row.branch_data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
    policyResource(row),
  );
  const renewalRead = await authorize(db, context, 'renewal.read', parent);
  const task = taskResource(row);
  const taskRead = await authorize(db, context, 'task.read', task);
  const taskCreate = await evaluateAuthorization(db, {
    context,
    action: 'task.create',
    resource: task,
  });
  const correctionScope = await authorize(db, context, 'renewal.update', parent);
  if (
    customerRead !== 'AGENCY' ||
    policyRead !== 'AGENCY' ||
    renewalRead !== 'AGENCY' ||
    taskRead !== 'AGENCY' ||
    taskCreate.decision !== 'ALLOW' ||
    correctionScope !== 'AGENCY'
  ) {
    throw new RenewalCommandError('FORBIDDEN', 403);
  }
  return {
    customerRead,
    policyRead,
    renewalRead,
    taskRead,
    // task.create is UNSCOPED; this legacy field carries the independently authorized task.read scope.
    taskUpdate: taskRead,
    terminalAction: correctionScope,
  };
}

async function deterministicWonCorrectionGrantToken(
  grantSecret: string,
  agencyId: string,
  context: AuthenticatedUserContext,
  membershipId: string,
  renewalId: string,
  idempotencyKey: string,
): Promise<string> {
  if (grantSecret.length < 32) throw new RenewalCommandError('GRANT_KEY_UNAVAILABLE', 500);
  const bindingHash = await computePayloadHash({
    purpose: 'renewal.won.correct.grant',
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: membershipId,
    renewalId,
    idempotencyKey,
  });
  const encoder = new TextEncoder();
  const masterKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(grantSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const evidenceKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('mayi-sigorta-v1'),
      info: encoder.encode('renewal-won-correction/grant-evidence'),
    },
    masterKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    evidenceKey,
    encoder.encode(`grant-evidence-v1\u0000${bindingHash}`),
  );
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function issueRenewalWonCorrectionGrant(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawIdempotencyKey: string,
  grantSecret: string,
): Promise<{
  readonly grantId: string;
  readonly grantEvidenceToken: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
}> {
  if (context.assurance !== 'SECURE')
    throw new RenewalCommandError('SECURE_ASSURANCE_REQUIRED', 403);
  const active = activeMembership(context);
  const input = wonRenewalCorrectionGrantSchema.parse(rawInput);
  if (!isCanonicalTimestamp(input.replacementDueAt)) {
    throw new RenewalCommandError('REOPEN_DUE_AT_INVALID', 400);
  }
  const key = rawIdempotencyKey.trim();
  if (!key || key.length > 128) throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  const row = await loadRenewalTask(db, active.agencyId, renewalId);
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  validateWonCorrectionState(row, input);
  await authorizeWonCorrectionReadScope(db, context, row);
  const currentLinks = await loadWonLinks(db, active.agencyId, renewalId);
  if (currentLinks.links.length === 0)
    throw new RenewalCommandError('WON_POLICY_LINK_REQUIRED', 409);
  const targets = await authorizeWonPolicyTargets(
    db,
    context,
    active.agencyId,
    currentLinks.targets,
  );
  if (
    targets.some(
      (target) => target.policyReadScope !== 'AGENCY' || target.customerReadScope !== 'AGENCY',
    )
  ) {
    throw new RenewalCommandError('FORBIDDEN', 403);
  }
  if (
    targets.some((target) => target.customer_id !== row.customer_id) ||
    currentLinks.links.some((link) => link.different_policyholder_reason_code !== null)
  ) {
    if (active.type !== 'OWNER') throw new RenewalCommandError('OWNER_REVIEW_REQUIRED', 403);
  }
  const payload = wonCorrectionPayload(row, input, currentLinks.links, targets);
  const payloadHash = await computePayloadHash(payload);
  const token = await deterministicWonCorrectionGrantToken(
    grantSecret,
    active.agencyId,
    context,
    active.id,
    renewalId,
    key,
  );
  const evidenceHash = await computeEvidenceHash(token);
  const existing = await db
    .prepare(
      `SELECT id,expires_at,status,agency_id,actor_user_id,actor_membership_id,action,
              payload_hash,target_ids_json,expected_target_version,permission_version,
              assurance,revoked_at
       FROM sensitive_action_grants WHERE evidence_hash=?`,
    )
    .bind(evidenceHash)
    .first<{
      id: string;
      expires_at: string;
      status: string;
      agency_id: string;
      actor_user_id: string;
      actor_membership_id: string;
      action: string;
      payload_hash: string;
      target_ids_json: string;
      expected_target_version: number | null;
      permission_version: number;
      assurance: string;
      revoked_at: string | null;
    }>();
  if (existing) {
    const valid = await db
      .prepare('SELECT CASE WHEN julianday(?)>julianday(?) THEN 1 ELSE 0 END AS valid')
      .bind(existing.expires_at, new Date().toISOString())
      .first<{ valid: number }>();
    if (
      existing.status !== 'ISSUED' ||
      existing.revoked_at !== null ||
      existing.agency_id !== active.agencyId ||
      existing.actor_user_id !== context.userId ||
      existing.actor_membership_id !== active.id ||
      existing.action !== WON_CORRECTION_ACTION ||
      existing.payload_hash !== payloadHash ||
      existing.target_ids_json !== JSON.stringify([renewalId]) ||
      existing.expected_target_version !== input.expectedRenewalVersion ||
      existing.permission_version !== active.permissionVersion ||
      existing.assurance !== 'SECURE_GRANT' ||
      valid?.valid !== 1
    ) {
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    }
    return {
      grantId: existing.id,
      grantEvidenceToken: token,
      expiresAt: existing.expires_at,
      replayed: true,
    };
  }
  try {
    const issued = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId: active.agencyId,
      action: WON_CORRECTION_ACTION,
      payloadHash,
      targetIds: [renewalId],
      expectedTargetVersion: input.expectedRenewalVersion,
      evidenceToken: token,
    });
    return {
      grantId: issued.grantRecord.id,
      grantEvidenceToken: issued.grantToken,
      expiresAt: issued.grantRecord.expiresAt,
      replayed: false,
    };
  } catch (error) {
    const raced = await db
      .prepare(
        `SELECT id,expires_at,status,agency_id,actor_user_id,actor_membership_id,action,
                payload_hash,target_ids_json,expected_target_version,permission_version,
                assurance,revoked_at FROM sensitive_action_grants WHERE evidence_hash=?`,
      )
      .bind(evidenceHash)
      .first<{ id: string; expires_at: string; status: string; payload_hash: string }>();
    if (raced?.status === 'ISSUED' && raced.payload_hash === payloadHash) {
      return {
        grantId: raced.id,
        grantEvidenceToken: token,
        expiresAt: raced.expires_at,
        replayed: true,
      };
    }
    if (error instanceof Error && /ACTIVE_|MEMBERSHIP_PERMISSION_STALE/.test(error.message)) {
      throw new RenewalCommandError('FORBIDDEN', 403);
    }
    throw error;
  }
}

export function parseWonCorrectionReceipt(
  receipt: ReceiptRow,
  fingerprintValue: string,
  input: WonRenewalCorrectionInput,
  renewalId: string,
): RenewalWonCorrectionResult {
  if (
    receipt.action !== WON_CORRECTION_ACTION ||
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 200 ||
    receipt.payload_fingerprint !== fingerprintValue ||
    typeof receipt.response_body !== 'string'
  ) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(receipt.response_body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('INVALID_RECEIPT');
    }
    result = parsed as Record<string, unknown>;
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
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
    'correctedAt',
    'correctionReasonCode',
    'supersededLinkIds',
    'preservedPolicyIds',
  ];
  const sortedUniqueIds = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    [...value].sort().every((entry, index) => entry === value[index]) &&
    new Set(value).size === value.length;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(result, key)) ||
    result.renewalId !== renewalId ||
    result.previousState !== 'WON' ||
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(String(result.state)) ||
    typeof result.closedTaskId !== 'string' ||
    result.closedTaskId.length === 0 ||
    result.closedTaskVersion !== input.expectedTaskVersion ||
    result.renewalVersion !== input.expectedRenewalVersion + 1 ||
    result.taskVersion !== 1 ||
    !isCanonicalTimestamp(result.terminalClosedAt) ||
    !isCanonicalTimestamp(result.correctedAt) ||
    result.correctionReasonCode !== input.correctionReasonCode ||
    typeof result.primaryTaskId !== 'string' ||
    result.primaryTaskId.length === 0 ||
    !sortedUniqueIds(result.supersededLinkIds) ||
    !sortedUniqueIds(result.preservedPolicyIds)
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return result as unknown as RenewalWonCorrectionResult;
}

function wonCorrectionAuthorityPredicate(
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
): LiveAuthorityPredicate {
  return actorAuthorityPredicate(
    context,
    active,
    row,
    scopes,
    WON_CORRECTION_ACTION,
    'task.create',
    scopes.taskUpdate,
  );
}

export function wonCorrectionAuthorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  scopes: AuthorizationScopes,
): D1PreparedStatement {
  const authority = wonCorrectionAuthorityPredicate(context, active, row, scopes);
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(crypto.randomUUID(), ...authority.bindings);
}

export function wonCorrectionGrantConsumption(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  renewalId: string,
  input: WonRenewalCorrectionInput,
  payloadHash: string,
  evidenceHash: string,
  operationId: string,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sensitive_action_grants
       SET status='CONSUMED',consumed_at=?,consumed_operation_id=?,updated_at=?
       WHERE evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=?
         AND action=? AND payload_hash=? AND target_ids_json=? AND expected_target_version=?
         AND permission_version=? AND assurance='SECURE_GRANT' AND status='ISSUED'
         AND consumed_at IS NULL AND revoked_at IS NULL AND julianday(expires_at)>julianday(?)`,
    )
    .bind(
      now,
      operationId,
      now,
      evidenceHash,
      active.agencyId,
      context.userId,
      active.id,
      WON_CORRECTION_ACTION,
      payloadHash,
      JSON.stringify([renewalId]),
      input.expectedRenewalVersion,
      active.permissionVersion,
      now,
    );
}

export function wonCorrectionLinkSnapshotAssertion(
  db: D1Database,
  agencyId: string,
  renewalId: string,
  links: readonly WonLinkRow[],
): D1PreparedStatement {
  const expected = links
    .map(
      () =>
        '(l.id=? AND l.new_policy_id=? AND l.allocated_new_premium_minor=? AND l.currency=? AND l.allocation_operation_id=? AND l.different_policyholder_reason_code IS ?)',
    )
    .join(' OR ');
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN
         (SELECT count(*) FROM renewal_policy_links l WHERE l.agency_id=? AND l.renewal_id=? AND l.status='ACTIVE')=?
         AND NOT EXISTS(SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=?
           AND l.renewal_id=? AND l.status='ACTIVE' AND NOT (${expected}))
       THEN 1 ELSE 0 END,'RENEWAL_POLICY_LINK_CONFLICT'`,
    )
    .bind(
      crypto.randomUUID(),
      agencyId,
      renewalId,
      links.length,
      agencyId,
      renewalId,
      ...links.flatMap((link) => [
        link.id,
        link.newPolicyId,
        link.allocatedNewPremiumMinor,
        link.currency,
        link.allocationOperationId,
        link.differentPolicyholderReasonCode,
      ]),
    );
}

export function reopenWonRenewalStatement(
  db: D1Database,
  active: ActiveMembership,
  row: RenewalTaskRow,
  input: WonRenewalCorrectionInput,
  state: OpenRenewalState,
  correctedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE renewal_opportunities
       SET state=?,loss_reason_id=NULL,loss_reason_notes=NULL,void_reason_code=NULL,
           closed_at=NULL,closed_by_membership_id=NULL,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND state='WON' AND version=? AND closed_at=?
         AND closed_by_membership_id=? AND assignee_membership_id IS ?
         AND EXISTS(SELECT 1 FROM tasks t WHERE t.agency_id=renewal_opportunities.agency_id
           AND t.renewal_id=renewal_opportunities.id AND t.id=? AND t.kind='RENEWAL_FOLLOWUP'
           AND t.status='COMPLETED' AND t.version=? AND t.completed_at=renewal_opportunities.closed_at
           AND t.completed_by_membership_id=renewal_opportunities.closed_by_membership_id
           AND t.assignee_membership_id IS renewal_opportunities.assignee_membership_id)`,
    )
    .bind(
      state,
      correctedAt,
      active.agencyId,
      row.renewal_id,
      input.expectedRenewalVersion,
      row.renewal_closed_at,
      row.renewal_closed_by_membership_id,
      row.renewal_assignee_membership_id,
      row.task_id,
      input.expectedTaskVersion,
    );
}

export function wonCorrectionPrimaryTaskInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  result: RenewalWonCorrectionResult,
  input: WonRenewalCorrectionInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tasks
         (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
          status,actor_kind,created_by_user_id,created_by_membership_id,version,created_at,updated_at)
       SELECT ?,r.agency_id,c.id,r.id,'RENEWAL_FOLLOWUP','Yenileme takibi',?,r.assignee_membership_id,
          'OPEN','USER',?,?,1,?,?
       FROM renewal_opportunities r JOIN policies p
         ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
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
      result.correctedAt,
      result.correctedAt,
      active.agencyId,
      row.renewal_id,
      result.state,
      result.renewalVersion,
      row.renewal_assignee_membership_id,
    );
}

export function wonCorrectionAuditInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  result: RenewalWonCorrectionResult,
  idempotencyKey: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action: 'renewal.won.corrected',
    targetType: 'renewal_opportunities',
    targetId: result.renewalId,
    correlationId: idempotencyKey,
    idempotencyKey,
    outcome: 'SUCCESS',
    createdAt: result.correctedAt,
    metadata: {
      reasonCode: 'WON_CORRECTED',
      entityCode: result.correctionReasonCode,
      referenceId: result.primaryTaskId,
      changedFields: ['state', 'closed_at', 'primary_task', 'policy_link_status'],
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
