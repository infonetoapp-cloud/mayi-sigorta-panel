import { buildSafeAuditRecord } from '../audit';
import { computePayloadHash } from '../canonical';
import { IdempotencyConflictError } from '../idempotency';
import { OptimisticConcurrencyError } from '../../db/optimistic';
import type {
  RenewalTaskAssignmentDto,
  RenewalTaskReplacementCompletionDto,
} from '../../../shared/types';
import {
  TaskConstraintError,
  TaskForbiddenError,
  TaskReplayNotAuthorizedError,
  TaskValidationError,
} from '../../tasks/errors';

export interface ExecuteRenewalTaskAssignmentInput {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly permissionVersion: number;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly renewalId: string;
  readonly taskId: string;
  readonly expectedRenewalVersion: number;
  readonly expectedTaskVersion: number;
  readonly previousAssigneeMembershipId: string | null;
  readonly assigneeMembershipId: string | null;
}

export type RenewalTaskAssignmentReplayLookupInput = Pick<
  ExecuteRenewalTaskAssignmentInput,
  | 'db'
  | 'agencyId'
  | 'actorUserId'
  | 'actorMembershipId'
  | 'idempotencyKey'
  | 'payload'
  | 'renewalId'
  | 'taskId'
  | 'expectedRenewalVersion'
  | 'expectedTaskVersion'
  | 'assigneeMembershipId'
>;

export interface ExecuteRenewalTaskReplacementCompletionInput {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly permissionVersion: number;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly renewalId: string;
  readonly taskId: string;
  readonly expectedRenewalVersion: number;
  readonly expectedTaskVersion: number;
  readonly replacementTaskId: string;
  readonly replacementDueAt: string;
  readonly replacementAssigneeMembershipId: string | null;
  readonly taskUpdateScope: 'ASSIGNED' | 'AGENCY';
  readonly taskReadScope: 'ASSIGNED' | 'AGENCY';
  readonly renewalReadScope: 'ASSIGNED' | 'AGENCY';
}

export type RenewalTaskCompletionReplayLookupInput = Pick<
  ExecuteRenewalTaskReplacementCompletionInput,
  | 'db'
  | 'agencyId'
  | 'actorUserId'
  | 'actorMembershipId'
  | 'idempotencyKey'
  | 'payload'
  | 'renewalId'
  | 'taskId'
  | 'expectedRenewalVersion'
  | 'expectedTaskVersion'
  | 'replacementDueAt'
>;

const ACTION = 'renewal.task.assign';
const COMPLETION_ACTION = 'renewal.task.complete_with_replacement';

function fingerprint(input: RenewalTaskAssignmentReplayLookupInput): Promise<string> {
  return computePayloadHash({
    action: ACTION,
    target: `${input.renewalId}:${input.taskId}`,
    payload: input.payload,
    version: `${input.expectedRenewalVersion}:${input.expectedTaskVersion}`,
  });
}

function casAssertion(db: D1Database, code: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,changes(),?`,
    )
    .bind(crypto.randomUUID(), code);
}

function actorAuthorityStatement(input: ExecuteRenewalTaskAssignmentInput): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id
         JOIN agencies a ON a.id=m.agency_id
         JOIN tasks t ON t.agency_id=m.agency_id AND t.id=?
         JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
         JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
         JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
           AND t.renewal_id=? AND t.kind='RENEWAL_FOLLOWUP'
           AND EXISTS(SELECT 1 FROM auth_identities ai
             WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
           AND (b.data_classification='GENERAL' OR EXISTS(
             SELECT 1 FROM membership_permissions health_read
             WHERE health_read.membership_id=m.id
               AND health_read.permission_code='sensitive.health.read'
               AND health_read.scope='UNSCOPED'))
           AND (m.type='OWNER' OR (EXISTS(SELECT 1 FROM membership_permissions team_access WHERE team_access.membership_id=m.id AND team_access.permission_code='task.team' AND team_access.scope='UNSCOPED') AND NOT EXISTS(SELECT 1 FROM json_each('["task.read","task.assign","renewal.read","renewal.assign","policy.read","customer.read"]') required WHERE NOT EXISTS(SELECT 1 FROM membership_permissions granted WHERE granted.membership_id=m.id AND granted.permission_code=required.value AND granted.scope='AGENCY'))))
       ) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(
      crypto.randomUUID(),
      input.taskId,
      input.actorMembershipId,
      input.agencyId,
      input.actorUserId,
      input.permissionVersion,
      input.renewalId,
      input.actorIdentityId,
    );
}

function targetAssigneeStatement(input: ExecuteRenewalTaskAssignmentInput): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN ? IS NULL OR EXISTS(
         SELECT 1 FROM agency_memberships target
         JOIN users target_user ON target_user.id=target.user_id
         JOIN agencies target_agency ON target_agency.id=target.agency_id
         JOIN tasks linked_task ON linked_task.agency_id=target.agency_id AND linked_task.id=?
         JOIN renewal_opportunities linked_renewal
           ON linked_renewal.agency_id=linked_task.agency_id AND linked_renewal.id=linked_task.renewal_id
         JOIN policies linked_policy
           ON linked_policy.agency_id=linked_renewal.agency_id
             AND linked_policy.id=linked_renewal.expiring_policy_id
         JOIN insurance_branches linked_branch
           ON linked_branch.agency_id=linked_policy.agency_id AND linked_branch.id=linked_policy.branch_id
         JOIN customers linked_customer
           ON linked_customer.agency_id=linked_task.agency_id AND linked_customer.id=linked_task.customer_id
         WHERE target.id=? AND target.agency_id=? AND linked_renewal.id=?
           AND target.status='ACTIVE'
           AND target_user.status='ACTIVE' AND target_agency.status='ACTIVE'
           AND EXISTS(SELECT 1 FROM auth_identities target_identity
             WHERE target_identity.user_id=target_user.id AND target_identity.status='ACTIVE')
           AND (linked_branch.data_classification='GENERAL' OR EXISTS(
             SELECT 1 FROM membership_permissions target_health_read
             WHERE target_health_read.membership_id=target.id
               AND target_health_read.permission_code='sensitive.health.read'
               AND target_health_read.scope='UNSCOPED'))
           AND (target.type='OWNER' OR (
             EXISTS(SELECT 1 FROM membership_permissions target_task_read
               WHERE target_task_read.membership_id=target.id
                 AND target_task_read.permission_code='task.read'
                 AND target_task_read.scope IN ('AGENCY','ASSIGNED'))
             AND EXISTS(SELECT 1 FROM membership_permissions target_renewal_read
               WHERE target_renewal_read.membership_id=target.id
                 AND target_renewal_read.permission_code='renewal.read'
                 AND target_renewal_read.scope IN ('AGENCY','ASSIGNED'))
             AND EXISTS(SELECT 1 FROM membership_permissions target_customer_read
               WHERE target_customer_read.membership_id=target.id
                 AND target_customer_read.permission_code='customer.read'
                 AND (target_customer_read.scope='AGENCY' OR
                   (target_customer_read.scope='ASSIGNED'
                     AND linked_customer.assignee_membership_id=target.id)))
             AND EXISTS(SELECT 1 FROM membership_permissions target_policy_read
               WHERE target_policy_read.membership_id=target.id
                 AND target_policy_read.permission_code='policy.read'
                 AND (target_policy_read.scope='AGENCY' OR
                   (target_policy_read.scope='ASSIGNED'
                     AND (linked_policy.assignee_membership_id=target.id
                       OR linked_customer.assignee_membership_id=target.id))))
           ))
       ) THEN 1 ELSE 0 END,'BUSINESS_MUTATION_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.assigneeMembershipId,
      input.taskId,
      input.assigneeMembershipId,
      input.agencyId,
      input.renewalId,
    );
}

function assignmentReplayTargetAssertion(
  input: ExecuteRenewalTaskAssignmentInput,
  result: RenewalTaskAssignmentDto,
): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM renewal_opportunities r
         JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id
         JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         WHERE r.agency_id=? AND r.id=? AND t.id=? AND t.kind='RENEWAL_FOLLOWUP'
           AND p.archived_at IS NULL AND c.archived_at IS NULL
           AND (SELECT count(*) FROM audit_events e
             WHERE e.agency_id=r.agency_id AND e.actor_user_id=? AND e.actor_membership_id=?
               AND e.action='renewal.task.assigned' AND e.target_type='renewal_opportunities'
               AND e.target_id=r.id AND e.idempotency_key=? AND e.outcome='SUCCESS'
               AND e.created_at=?
               AND json_extract(e.metadata_json,'$.referenceId')=t.id
               AND json_extract(e.metadata_json,'$.targetVersion')=?
               AND ((? IS NULL AND json_extract(e.metadata_json,'$.activeResult')='UNASSIGNED')
                 OR (? IS NOT NULL
                   AND json_extract(e.metadata_json,'$.afterAssigneeMembershipId')=?)))=1
       ) THEN 1 ELSE 0 END,'BUSINESS_MUTATION_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.agencyId,
      input.renewalId,
      input.taskId,
      input.actorUserId,
      input.actorMembershipId,
      input.idempotencyKey.trim(),
      result.updatedAt,
      result.renewalVersion,
      result.assigneeMembershipId,
      result.assigneeMembershipId,
      result.assigneeMembershipId,
    );
}

function assignmentStatement(
  input: ExecuteRenewalTaskAssignmentInput,
  now: string,
): D1PreparedStatement {
  return input.db
    .prepare(
      `UPDATE renewal_opportunities
       SET assignee_membership_id=?,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND version=?
         AND assignee_membership_id IS ? AND closed_at IS NULL
         AND state NOT IN ('WON','LOST','VOIDED')
         AND EXISTS(SELECT 1 FROM policies p JOIN customers c
           ON c.agency_id=p.agency_id AND c.id=p.customer_id
           WHERE p.agency_id=renewal_opportunities.agency_id
             AND p.id=renewal_opportunities.expiring_policy_id
             AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL)`,
    )
    .bind(
      input.assigneeMembershipId,
      now,
      input.agencyId,
      input.renewalId,
      input.expectedRenewalVersion,
      input.previousAssigneeMembershipId,
    );
}

function taskAssignmentStatement(
  input: ExecuteRenewalTaskAssignmentInput,
  now: string,
): D1PreparedStatement {
  return input.db
    .prepare(
      `UPDATE tasks SET assignee_membership_id=?,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND renewal_id=? AND kind='RENEWAL_FOLLOWUP'
         AND status='OPEN' AND version=? AND assignee_membership_id IS ?
         AND EXISTS(SELECT 1 FROM renewal_opportunities r
           WHERE r.agency_id=tasks.agency_id AND r.id=tasks.renewal_id
             AND r.assignee_membership_id IS ? AND r.version=?)`,
    )
    .bind(
      input.assigneeMembershipId,
      now,
      input.agencyId,
      input.taskId,
      input.renewalId,
      input.expectedTaskVersion,
      input.previousAssigneeMembershipId,
      input.assigneeMembershipId,
      input.expectedRenewalVersion + 1,
    );
}

function auditStatement(
  input: ExecuteRenewalTaskAssignmentInput,
  now: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    action: 'renewal.task.assigned',
    targetType: 'renewal_opportunities',
    targetId: input.renewalId,
    correlationId: crypto.randomUUID(),
    idempotencyKey: input.idempotencyKey.trim(),
    outcome: 'SUCCESS',
    metadata: {
      beforeAssigneeMembershipId: input.previousAssigneeMembershipId,
      afterAssigneeMembershipId: input.assigneeMembershipId,
      activeResult: input.assigneeMembershipId === null ? 'UNASSIGNED' : 'ASSIGNED',
      referenceId: input.taskId,
      targetVersion: input.expectedRenewalVersion + 1,
      changedFields: ['assigneeMembershipId', 'primaryTaskAssigneeMembershipId'],
    },
    createdAt: now,
  });
  return input.db
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

function receiptStatement(
  input: ExecuteRenewalTaskAssignmentInput,
  fingerprintValue: string,
  result: RenewalTaskAssignmentDto,
  now: string,
): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO operation_receipts
       (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
        status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.agencyId,
      input.actorUserId,
      input.actorMembershipId,
      ACTION,
      input.idempotencyKey.trim(),
      fingerprintValue,
      JSON.stringify(result),
      now,
      now,
    );
}

type ReplayRecord = {
  readonly action: string;
  readonly payload_fingerprint: string;
  readonly status: string;
  readonly response_status: number | null;
  readonly response_body: string | null;
};

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseAssignmentReceipt(
  raw: unknown,
  input: RenewalTaskAssignmentReplayLookupInput,
): RenewalTaskAssignmentDto {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskReplayNotAuthorizedError();
  }
  const body = raw as Record<string, unknown>;
  const expectedKeys = [
    'renewalId',
    'taskId',
    'assigneeMembershipId',
    'renewalVersion',
    'taskVersion',
    'updatedAt',
  ];
  if (
    Object.keys(body).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(body, key)) ||
    body.renewalId !== input.renewalId ||
    body.taskId !== input.taskId ||
    body.assigneeMembershipId !== input.assigneeMembershipId ||
    body.renewalVersion !== input.expectedRenewalVersion + 1 ||
    body.taskVersion !== input.expectedTaskVersion + 1 ||
    !isCanonicalTimestamp(body.updatedAt)
  ) {
    throw new TaskReplayNotAuthorizedError();
  }
  return body as unknown as RenewalTaskAssignmentDto;
}

async function findReplay(
  input: RenewalTaskAssignmentReplayLookupInput,
  fingerprintValue: string,
): Promise<RenewalTaskAssignmentDto | null> {
  const row = await input.db
    .prepare(
      `SELECT action,payload_fingerprint,status,response_status,response_body
       FROM operation_receipts
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
    )
    .bind(input.agencyId, input.actorUserId, input.actorMembershipId, input.idempotencyKey.trim())
    .first<ReplayRecord>();
  if (!row) return null;
  if (
    row.action !== ACTION ||
    row.payload_fingerprint !== fingerprintValue ||
    row.status !== 'COMPLETED' ||
    row.response_status !== 200 ||
    typeof row.response_body !== 'string'
  ) {
    throw new IdempotencyConflictError('IDEMPOTENCY_CONFLICT');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_body);
  } catch {
    throw new TaskReplayNotAuthorizedError();
  }
  return parseAssignmentReceipt(parsed, input);
}

export async function lookupRenewalTaskAssignmentReplay(
  input: RenewalTaskAssignmentReplayLookupInput,
): Promise<RenewalTaskAssignmentDto | null> {
  if (!input.idempotencyKey.trim()) throw new TaskValidationError('IDEMPOTENCY_KEY_REQUIRED');
  return findReplay(input, await fingerprint(input));
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
  if (message.includes('MEMBERSHIP_PERMISSION_NOT_FOUND')) throw new TaskForbiddenError();
  if (message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT')) throw new OptimisticConcurrencyError(0);
  if (message.includes('operation_receipts')) {
    throw new IdempotencyConflictError('IDEMPOTENCY_CONCURRENT');
  }
  throw error;
}

async function assertActorAuthority(
  input: ExecuteRenewalTaskAssignmentInput,
  result: RenewalTaskAssignmentDto,
): Promise<void> {
  try {
    await input.db.batch([
      actorAuthorityStatement(input),
      assignmentReplayTargetAssertion(input, result),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('MEMBERSHIP_PERMISSION_NOT_FOUND') ||
      message.includes('BUSINESS_MUTATION_FAILED')
    ) {
      throw new TaskReplayNotAuthorizedError();
    }
    mapBatchError(error);
  }
}

export async function executeRenewalTaskAssignment(
  input: ExecuteRenewalTaskAssignmentInput,
): Promise<{ data: RenewalTaskAssignmentDto; replayed: boolean }> {
  const key = input.idempotencyKey.trim();
  if (!key) throw new TaskValidationError('IDEMPOTENCY_KEY_REQUIRED');
  const fingerprintValue = await fingerprint(input);
  const replay = await findReplay(input, fingerprintValue);
  if (replay) {
    await assertActorAuthority(input, replay);
    return { data: replay, replayed: true };
  }

  const now = new Date().toISOString();
  const result: RenewalTaskAssignmentDto = {
    renewalId: input.renewalId,
    taskId: input.taskId,
    assigneeMembershipId: input.assigneeMembershipId,
    renewalVersion: input.expectedRenewalVersion + 1,
    taskVersion: input.expectedTaskVersion + 1,
    updatedAt: now,
  };
  try {
    await input.db.batch([
      actorAuthorityStatement(input),
      receiptStatement(input, fingerprintValue, result, now),
      targetAssigneeStatement(input),
      assignmentStatement(input, now),
      casAssertion(input.db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      taskAssignmentStatement(input, now),
      casAssertion(input.db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      auditStatement(input, now),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await findReplay(input, fingerprintValue);
      if (raced) {
        await assertActorAuthority(input, raced);
        return { data: raced, replayed: true };
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('BUSINESS_MUTATION_FAILED')) {
      throw new TaskConstraintError('ASSIGNEE_NOT_ASSIGNABLE');
    }
    mapBatchError(error);
  }
  return { data: result, replayed: false };
}

function completionFingerprint(input: RenewalTaskCompletionReplayLookupInput): Promise<string> {
  return computePayloadHash({
    action: COMPLETION_ACTION,
    target: `${input.renewalId}:${input.taskId}`,
    payload: input.payload,
    version: `${input.expectedRenewalVersion}:${input.expectedTaskVersion}`,
  });
}

function completionAuthorityStatement(
  input: ExecuteRenewalTaskReplacementCompletionInput,
): D1PreparedStatement {
  const dependencyScopeValid =
    input.taskUpdateScope === 'ASSIGNED' || input.taskReadScope === 'AGENCY';
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id
         JOIN agencies a ON a.id=m.agency_id
         JOIN tasks t ON t.agency_id=m.agency_id AND t.id=?
         JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
         JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
         JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
           AND t.renewal_id=? AND t.kind='RENEWAL_FOLLOWUP'
           AND EXISTS(SELECT 1 FROM auth_identities ai
             WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
           AND (b.data_classification='GENERAL' OR EXISTS(
             SELECT 1 FROM membership_permissions health_read
             WHERE health_read.membership_id=m.id
               AND health_read.permission_code='sensitive.health.read'
               AND health_read.scope='UNSCOPED'))
           AND (m.type='OWNER' OR (
             EXISTS(SELECT 1 FROM membership_permissions task_update
               WHERE task_update.membership_id=m.id AND task_update.permission_code='task.update'
                 AND task_update.scope=?)
             AND EXISTS(SELECT 1 FROM membership_permissions task_read
               WHERE task_read.membership_id=m.id AND task_read.permission_code='task.read'
                 AND task_read.scope=?)
             AND EXISTS(SELECT 1 FROM membership_permissions task_create
               WHERE task_create.membership_id=m.id AND task_create.permission_code='task.create'
                 AND task_create.scope='UNSCOPED')
             AND EXISTS(SELECT 1 FROM membership_permissions renewal_read
               WHERE renewal_read.membership_id=m.id AND renewal_read.permission_code='renewal.read'
                 AND renewal_read.scope=?)
             AND EXISTS(SELECT 1 FROM membership_permissions customer_read
               WHERE customer_read.membership_id=m.id AND customer_read.permission_code='customer.read'
                 AND (customer_read.scope='AGENCY' OR
                   (customer_read.scope='ASSIGNED' AND c.assignee_membership_id=m.id)))
             AND EXISTS(SELECT 1 FROM membership_permissions policy_read
               WHERE policy_read.membership_id=m.id AND policy_read.permission_code='policy.read'
                 AND (policy_read.scope='AGENCY' OR
                   (policy_read.scope='ASSIGNED'
                     AND (p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id))))
             AND (t.assignee_membership_id=m.id OR EXISTS(SELECT 1 FROM membership_permissions team_access WHERE team_access.membership_id=m.id AND team_access.permission_code='task.team' AND team_access.scope='UNSCOPED'))
             AND ${dependencyScopeValid ? '1=1' : '1=0'}
             AND (?='AGENCY' OR t.assignee_membership_id=m.id)
             AND (?='AGENCY' OR t.assignee_membership_id=m.id)
             AND (?='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)
           ))
       ) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(
      crypto.randomUUID(),
      input.taskId,
      input.actorMembershipId,
      input.agencyId,
      input.actorUserId,
      input.permissionVersion,
      input.renewalId,
      input.actorIdentityId,
      input.taskUpdateScope,
      input.taskReadScope,
      input.renewalReadScope,
      input.taskUpdateScope,
      input.taskReadScope,
      input.renewalReadScope,
    );
}

function replacementAssigneeAssertion(
  input: ExecuteRenewalTaskReplacementCompletionInput,
): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN ? IS NULL OR EXISTS(
         SELECT 1 FROM agency_memberships target
         JOIN users target_user ON target_user.id=target.user_id
         JOIN agencies target_agency ON target_agency.id=target.agency_id
         JOIN renewal_opportunities linked_renewal
           ON linked_renewal.agency_id=target.agency_id AND linked_renewal.id=?
         JOIN policies linked_policy
           ON linked_policy.agency_id=linked_renewal.agency_id
             AND linked_policy.id=linked_renewal.expiring_policy_id
         JOIN insurance_branches linked_branch
           ON linked_branch.agency_id=linked_policy.agency_id AND linked_branch.id=linked_policy.branch_id
         JOIN customers linked_customer
           ON linked_customer.agency_id=linked_policy.agency_id AND linked_customer.id=linked_policy.customer_id
         WHERE target.id=? AND target.agency_id=? AND target.status='ACTIVE'
           AND target_user.status='ACTIVE' AND target_agency.status='ACTIVE'
           AND EXISTS(SELECT 1 FROM auth_identities target_identity
             WHERE target_identity.user_id=target_user.id AND target_identity.status='ACTIVE')
           AND (linked_branch.data_classification='GENERAL' OR EXISTS(
             SELECT 1 FROM membership_permissions target_health_read
             WHERE target_health_read.membership_id=target.id
               AND target_health_read.permission_code='sensitive.health.read'
               AND target_health_read.scope='UNSCOPED'))
           AND (target.type='OWNER' OR (
             EXISTS(SELECT 1 FROM membership_permissions target_task_read
               WHERE target_task_read.membership_id=target.id
                 AND target_task_read.permission_code='task.read'
                 AND target_task_read.scope IN ('AGENCY','ASSIGNED'))
             AND EXISTS(SELECT 1 FROM membership_permissions target_renewal_read
               WHERE target_renewal_read.membership_id=target.id
                 AND target_renewal_read.permission_code='renewal.read'
                 AND target_renewal_read.scope IN ('AGENCY','ASSIGNED'))
             AND EXISTS(SELECT 1 FROM membership_permissions target_customer_read
               WHERE target_customer_read.membership_id=target.id
                 AND target_customer_read.permission_code='customer.read'
                 AND (target_customer_read.scope='AGENCY' OR
                   (target_customer_read.scope='ASSIGNED'
                     AND linked_customer.assignee_membership_id=target.id)))
             AND EXISTS(SELECT 1 FROM membership_permissions target_policy_read
               WHERE target_policy_read.membership_id=target.id
                 AND target_policy_read.permission_code='policy.read'
                 AND (target_policy_read.scope='AGENCY' OR
                   (target_policy_read.scope='ASSIGNED'
                     AND (linked_policy.assignee_membership_id=target.id
                       OR linked_customer.assignee_membership_id=target.id))))
           ))
       ) THEN 1 ELSE 0 END,'BUSINESS_MUTATION_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.replacementAssigneeMembershipId,
      input.renewalId,
      input.replacementAssigneeMembershipId,
      input.agencyId,
    );
}

function renewalVersionAssertion(
  input: ExecuteRenewalTaskReplacementCompletionInput,
): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM renewal_opportunities r
         JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         WHERE r.agency_id=? AND r.id=? AND r.version=?
           AND r.assignee_membership_id IS ? AND r.closed_at IS NULL
           AND r.state NOT IN ('WON','LOST','VOIDED')
           AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL
       ) THEN 1 ELSE 0 END,'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
    )
    .bind(
      crypto.randomUUID(),
      input.agencyId,
      input.renewalId,
      input.expectedRenewalVersion,
      input.replacementAssigneeMembershipId,
    );
}

function completeTaskStatement(
  input: ExecuteRenewalTaskReplacementCompletionInput,
  now: string,
): D1PreparedStatement {
  return input.db
    .prepare(
      `UPDATE tasks
       SET status='COMPLETED',completed_at=?,completed_by_membership_id=?,
           version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND renewal_id=? AND kind='RENEWAL_FOLLOWUP'
         AND status='OPEN' AND version=?
         AND assignee_membership_id IS ?
         AND EXISTS(SELECT 1 FROM renewal_opportunities r
           JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
           JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
           WHERE r.agency_id=tasks.agency_id AND r.id=tasks.renewal_id
             AND r.version=? AND r.assignee_membership_id IS ? AND r.closed_at IS NULL
             AND r.state NOT IN ('WON','LOST','VOIDED')
             AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL)`,
    )
    .bind(
      now,
      input.actorMembershipId,
      now,
      input.agencyId,
      input.taskId,
      input.renewalId,
      input.expectedTaskVersion,
      input.replacementAssigneeMembershipId,
      input.expectedRenewalVersion,
      input.replacementAssigneeMembershipId,
    );
}

function insertReplacementTaskStatement(
  input: ExecuteRenewalTaskReplacementCompletionInput,
  now: string,
): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO tasks
         (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,
          actor_kind,created_by_user_id,created_by_membership_id,version,created_at,updated_at)
       SELECT ?,t.agency_id,t.customer_id,t.renewal_id,'RENEWAL_FOLLOWUP','Yenileme takibi',?,
          r.assignee_membership_id,'OPEN','USER',?,?,1,?,?
       FROM tasks t JOIN renewal_opportunities r
         ON r.agency_id=t.agency_id AND r.id=t.renewal_id
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       WHERE t.agency_id=? AND t.id=? AND t.renewal_id=? AND t.kind='RENEWAL_FOLLOWUP'
         AND t.status='COMPLETED' AND t.version=?+1
         AND t.assignee_membership_id IS r.assignee_membership_id
         AND r.version=? AND r.assignee_membership_id IS ? AND r.closed_at IS NULL
         AND r.state NOT IN ('WON','LOST','VOIDED')
         AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL`,
    )
    .bind(
      input.replacementTaskId,
      input.replacementDueAt,
      input.actorUserId,
      input.actorMembershipId,
      now,
      now,
      input.agencyId,
      input.taskId,
      input.renewalId,
      input.expectedTaskVersion,
      input.expectedRenewalVersion,
      input.replacementAssigneeMembershipId,
    );
}

function completionAuditStatement(
  input: ExecuteRenewalTaskReplacementCompletionInput,
  now: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    action: 'renewal.task.completed_with_replacement',
    targetType: 'tasks',
    targetId: input.taskId,
    correlationId: crypto.randomUUID(),
    idempotencyKey: input.idempotencyKey.trim(),
    outcome: 'SUCCESS',
    metadata: {
      referenceId: input.replacementTaskId,
      targetVersion: input.expectedTaskVersion + 1,
      changedFields: ['status', 'completedAt', 'replacementTaskId'],
    },
    createdAt: now,
  });
  return input.db
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

function replacementAuditStatement(
  input: ExecuteRenewalTaskReplacementCompletionInput,
  now: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    action: 'renewal.task.replacement_created',
    targetType: 'tasks',
    targetId: input.replacementTaskId,
    correlationId: crypto.randomUUID(),
    idempotencyKey: input.idempotencyKey.trim(),
    outcome: 'SUCCESS',
    metadata: {
      referenceId: input.taskId,
      targetVersion: 1,
      changedFields: ['created'],
    },
    createdAt: now,
  });
  return input.db
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

function completionReceiptStatement(
  input: ExecuteRenewalTaskReplacementCompletionInput,
  fingerprintValue: string,
  result: RenewalTaskReplacementCompletionDto,
  now: string,
): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO operation_receipts
       (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
        status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.agencyId,
      input.actorUserId,
      input.actorMembershipId,
      COMPLETION_ACTION,
      input.idempotencyKey.trim(),
      fingerprintValue,
      JSON.stringify(result),
      now,
      now,
    );
}

type CompletionReplayRecord = {
  readonly action: string;
  readonly payload_fingerprint: string;
  readonly status: string;
  readonly response_status: number | null;
  readonly response_body: string | null;
};

function parseCompletionReceipt(
  raw: unknown,
  input: RenewalTaskCompletionReplayLookupInput,
): RenewalTaskReplacementCompletionDto {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskReplayNotAuthorizedError();
  }
  const body = raw as Record<string, unknown>;
  const keys = [
    'renewalId',
    'completedTaskId',
    'replacementTaskId',
    'replacementDueAt',
    'completedTaskVersion',
    'replacementTaskVersion',
    'renewalVersion',
    'completedAt',
  ];
  const validTimestamp = (value: unknown) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  };
  if (
    Object.keys(body).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(body, key)) ||
    body.renewalId !== input.renewalId ||
    body.completedTaskId !== input.taskId ||
    typeof body.replacementTaskId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      body.replacementTaskId,
    ) ||
    body.replacementDueAt !== input.replacementDueAt ||
    body.completedTaskVersion !== input.expectedTaskVersion + 1 ||
    body.replacementTaskVersion !== 1 ||
    body.renewalVersion !== input.expectedRenewalVersion ||
    !validTimestamp(body.completedAt)
  ) {
    throw new TaskReplayNotAuthorizedError();
  }
  return body as unknown as RenewalTaskReplacementCompletionDto;
}

async function findCompletionReplay(
  input: RenewalTaskCompletionReplayLookupInput,
  fingerprintValue: string,
): Promise<RenewalTaskReplacementCompletionDto | null> {
  const row = await input.db
    .prepare(
      `SELECT action,payload_fingerprint,status,response_status,response_body
       FROM operation_receipts
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
    )
    .bind(input.agencyId, input.actorUserId, input.actorMembershipId, input.idempotencyKey.trim())
    .first<CompletionReplayRecord>();
  if (!row) return null;
  if (
    row.action !== COMPLETION_ACTION ||
    row.payload_fingerprint !== fingerprintValue ||
    row.status !== 'COMPLETED' ||
    row.response_status !== 200 ||
    typeof row.response_body !== 'string'
  ) {
    throw new IdempotencyConflictError('IDEMPOTENCY_CONFLICT');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_body);
  } catch {
    throw new TaskReplayNotAuthorizedError();
  }
  return parseCompletionReceipt(parsed, input);
}

export async function lookupRenewalTaskCompletionReplay(
  input: RenewalTaskCompletionReplayLookupInput,
): Promise<RenewalTaskReplacementCompletionDto | null> {
  if (!input.idempotencyKey.trim()) throw new TaskValidationError('IDEMPOTENCY_KEY_REQUIRED');
  return findCompletionReplay(input, await completionFingerprint(input));
}

function completionReplayTargetAssertion(
  input: ExecuteRenewalTaskReplacementCompletionInput,
  result: RenewalTaskReplacementCompletionDto,
): D1PreparedStatement {
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM tasks target
         JOIN tasks source ON source.agency_id=target.agency_id
           AND source.id=? AND source.renewal_id=target.renewal_id
         JOIN renewal_opportunities r ON r.agency_id=target.agency_id AND r.id=target.renewal_id
         JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         JOIN agency_memberships m ON m.id=? AND m.agency_id=target.agency_id
         JOIN users u ON u.id=m.user_id
         JOIN agencies a ON a.id=m.agency_id
         WHERE target.agency_id=? AND target.id=? AND target.renewal_id=?
           AND target.kind='RENEWAL_FOLLOWUP' AND target.actor_kind='USER'
           AND target.created_by_user_id=? AND target.created_by_membership_id=?
           AND source.kind='RENEWAL_FOLLOWUP' AND source.status='COMPLETED'
           AND (m.type='OWNER' OR (source.assignee_membership_id=m.id AND target.assignee_membership_id=m.id) OR (EXISTS(SELECT 1 FROM membership_permissions team_access WHERE team_access.membership_id=m.id AND team_access.permission_code='task.team' AND team_access.scope='UNSCOPED') AND EXISTS(SELECT 1 FROM membership_permissions team_read WHERE team_read.membership_id=m.id AND team_read.permission_code='task.read' AND team_read.scope='AGENCY') AND EXISTS(SELECT 1 FROM membership_permissions team_write WHERE team_write.membership_id=m.id AND team_write.permission_code='task.update' AND team_write.scope='AGENCY')))
          AND source.completed_at=?
           AND m.user_id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
           AND m.permission_version=?
           AND EXISTS(SELECT 1 FROM auth_identities ai
             WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
           AND p.archived_at IS NULL AND c.archived_at IS NULL
           AND (m.type='OWNER' OR (
             EXISTS(SELECT 1 FROM membership_permissions task_read
               WHERE task_read.membership_id=m.id AND task_read.permission_code='task.read'
                 AND task_read.scope=?)
             AND EXISTS(SELECT 1 FROM membership_permissions renewal_read
               WHERE renewal_read.membership_id=m.id AND renewal_read.permission_code='renewal.read'
                 AND renewal_read.scope=?)
             AND (?='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)
             AND (?='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)
           ))
           AND (SELECT count(*) FROM audit_events created_audit
             WHERE created_audit.agency_id=target.agency_id
               AND created_audit.actor_user_id=? AND created_audit.actor_membership_id=?
               AND created_audit.action='renewal.task.replacement_created'
               AND created_audit.target_type='tasks' AND created_audit.target_id=target.id
               AND created_audit.idempotency_key=? AND created_audit.outcome='SUCCESS'
               AND json_extract(created_audit.metadata_json,'$.referenceId')=source.id)=1
           AND (SELECT count(*) FROM audit_events completed_audit
             WHERE completed_audit.agency_id=source.agency_id
               AND completed_audit.actor_user_id=? AND completed_audit.actor_membership_id=?
               AND completed_audit.action='renewal.task.completed_with_replacement'
               AND completed_audit.target_type='tasks' AND completed_audit.target_id=source.id
               AND completed_audit.idempotency_key=? AND completed_audit.created_at=?
              AND completed_audit.outcome='SUCCESS'
               AND json_extract(completed_audit.metadata_json,'$.referenceId')=target.id)=1
       ) THEN 1 ELSE 0 END,'BUSINESS_MUTATION_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.taskId,
      input.actorMembershipId,
      input.agencyId,
      result.replacementTaskId,
      input.renewalId,
      input.actorUserId,
      input.actorMembershipId,
      result.completedAt,
      input.actorUserId,
      input.permissionVersion,
      input.actorIdentityId,
      input.taskReadScope,
      input.renewalReadScope,
      input.taskReadScope,
      input.renewalReadScope,
      input.actorUserId,
      input.actorMembershipId,
      input.idempotencyKey.trim(),
      input.actorUserId,
      input.actorMembershipId,
      input.idempotencyKey.trim(),
      result.completedAt,
    );
}

async function assertCompletionReplayAuthority(
  input: ExecuteRenewalTaskReplacementCompletionInput,
  result: RenewalTaskReplacementCompletionDto,
): Promise<void> {
  try {
    await input.db.batch([
      completionAuthorityStatement(input),
      completionReplayTargetAssertion(input, result),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('MEMBERSHIP_PERMISSION_NOT_FOUND') ||
      message.includes('BUSINESS_MUTATION_FAILED')
    ) {
      throw new TaskReplayNotAuthorizedError();
    }
    mapBatchError(error);
  }
}

export async function executeRenewalTaskReplacementCompletion(
  input: ExecuteRenewalTaskReplacementCompletionInput,
): Promise<{ data: RenewalTaskReplacementCompletionDto; replayed: boolean }> {
  if (!input.idempotencyKey.trim()) throw new TaskValidationError('IDEMPOTENCY_KEY_REQUIRED');
  const fingerprintValue = await completionFingerprint(input);
  const replay = await findCompletionReplay(input, fingerprintValue);
  if (replay) {
    await assertCompletionReplayAuthority(input, replay);
    return { data: replay, replayed: true };
  }

  const now = new Date().toISOString();
  const result: RenewalTaskReplacementCompletionDto = {
    renewalId: input.renewalId,
    completedTaskId: input.taskId,
    replacementTaskId: input.replacementTaskId,
    replacementDueAt: input.replacementDueAt,
    completedTaskVersion: input.expectedTaskVersion + 1,
    replacementTaskVersion: 1,
    renewalVersion: input.expectedRenewalVersion,
    completedAt: now,
  };
  try {
    await input.db.batch([
      completionAuthorityStatement(input),
      completionReceiptStatement(input, fingerprintValue, result, now),
      replacementAssigneeAssertion(input),
      renewalVersionAssertion(input),
      completeTaskStatement(input, now),
      casAssertion(input.db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      insertReplacementTaskStatement(input, now),
      casAssertion(input.db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      completionAuditStatement(input, now),
      replacementAuditStatement(input, now),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await findCompletionReplay(input, fingerprintValue);
      if (raced) {
        await assertCompletionReplayAuthority(input, raced);
        return { data: raced, replayed: true };
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('BUSINESS_MUTATION_FAILED')) {
      throw new TaskConstraintError('REPLACEMENT_ASSIGNEE_NOT_ACTIVE');
    }
    mapBatchError(error);
  }
  return { data: result, replayed: false };
}
