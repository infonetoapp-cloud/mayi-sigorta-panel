import { computePayloadHash } from '../canonical';
import { computeEvidenceHash, canonicalizeTargetIds } from '../grants';
import { buildSafeAuditRecord } from '../audit';
import { IdempotencyConflictError } from '../idempotency';
import { OptimisticConcurrencyError } from '../../db/optimistic';
import { PolicyAuthorizationRaceError, PolicyConstraintError } from './policy-errors';

export { PolicyAuthorizationRaceError, PolicyConstraintError } from './policy-errors';

type ScopeResource = {
  readonly assigneeMembershipId: string;
  readonly customerAssigneeMembershipId: string;
  readonly branchId: string;
};

type PolicyUpdateChanges = {
  readonly policyNumber?: string;
  readonly normalizedPolicyNumber?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly grossPremiumMinor?: number;
  readonly currency?: string;
  readonly installmentCount?: number | null;
  readonly status?: 'ACTIVE' | 'CANCELLED' | 'VOIDED';
  readonly insurerId?: string;
  readonly productId?: string;
  readonly branchId?: string;
  readonly paymentMethodId?: string;
};

type Command =
  | {
      kind: 'create';
      policyId: string;
      customerId: string;
      requiresAgencyAssign: boolean;
      values: readonly unknown[];
      resource: ScopeResource;
    }
  | {
      kind: 'update';
      policyId: string;
      expectedVersion: number;
      changes: PolicyUpdateChanges;
      resource: ScopeResource;
    }
  | {
      kind: 'assign';
      policyId: string;
      expectedVersion: number;
      assigneeMembershipId: string;
      resource: ScopeResource;
    };

type BaseInput = {
  db: D1Database;
  agencyId: string;
  actorUserId: string;
  actorMembershipId: string;
  actorIdentityId: string;
  permissionVersion: number;
  idempotencyKey: string;
  payload: unknown;
};

async function replay(input: BaseInput, action: string, fingerprint: string) {
  const row = await input.db
    .prepare(
      `SELECT action,payload_fingerprint,status,response_status,response_body
      FROM operation_receipts
      WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
    )
    .bind(input.agencyId, input.actorUserId, input.actorMembershipId, input.idempotencyKey.trim())
    .first<{
      action: string;
      payload_fingerprint: string;
      status: string;
      response_status: number;
      response_body: string;
    }>();
  if (!row) return null;
  if (
    row.action !== action ||
    row.payload_fingerprint !== fingerprint ||
    row.status !== 'COMPLETED'
  ) {
    throw new IdempotencyConflictError('IDEMPOTENCY_CONFLICT');
  }
  return {
    body: JSON.parse(row.response_body) as unknown,
    status: row.response_status,
    replayed: true,
  };
}

export async function findPolicyCommandReplay(
  input: BaseInput & {
    readonly action: string;
    readonly target: string;
    readonly version: number | null;
  },
) {
  const fingerprint = await computePayloadHash({
    action: input.action,
    target: input.target,
    payload: input.payload,
    version: input.version,
  });
  return replay(input, input.action, fingerprint);
}

function auditStatement(
  input: BaseInput,
  action: string,
  targetId: string,
  changedFields: readonly string[],
  responseHash?: string,
) {
  const audit = buildSafeAuditRecord({
    id: crypto.randomUUID(),
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    action,
    targetType: 'policies',
    targetId,
    correlationId: crypto.randomUUID(),
    idempotencyKey: input.idempotencyKey.trim(),
    outcome: 'SUCCESS',
    metadata: {
      changedFields: [...changedFields],
      ...(responseHash ? { responseHash } : {}),
    },
  });
  return input.db
    .prepare(
      `INSERT INTO audit_events
    (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,idempotency_key,outcome,metadata_json,created_at)
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

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assignedResourceClause(command: Command): string {
  if (command.kind === 'create') {
    return `(${sqlLiteral(command.resource.assigneeMembershipId)}=m.id OR EXISTS(
      SELECT 1 FROM customers c WHERE c.agency_id=m.agency_id AND c.id=${sqlLiteral(command.customerId)} AND c.assignee_membership_id=m.id))`;
  }
  return `EXISTS(SELECT 1 FROM policies px JOIN customers cx ON cx.agency_id=px.agency_id AND cx.id=px.customer_id
    WHERE px.agency_id=m.agency_id AND px.id=${sqlLiteral(command.policyId)}
      AND (px.assignee_membership_id=m.id OR cx.assignee_membership_id=m.id))`;
}

function permissionClause(code: string, command: Command, agencyOnly = false): string {
  const scope = agencyOnly
    ? `p.scope='AGENCY'`
    : `(p.scope='AGENCY' OR (p.scope='ASSIGNED' AND ${assignedResourceClause(command)}))`;
  return `EXISTS(SELECT 1 FROM membership_permissions p WHERE p.membership_id=m.id AND p.permission_code='${code}' AND ${scope})`;
}

function dependencyScopeClause(code: string): string {
  return `EXISTS(SELECT 1 FROM membership_permissions direct_permission
    JOIN membership_permissions dependency_permission
      ON dependency_permission.membership_id=direct_permission.membership_id
      AND dependency_permission.permission_code='policy.read'
    WHERE direct_permission.membership_id=m.id
      AND direct_permission.permission_code='${code}'
      AND (direct_permission.scope='ASSIGNED' OR dependency_permission.scope='AGENCY'))`;
}

function customerReadClause(command: Extract<Command, { kind: 'create' }>): string {
  return `EXISTS(SELECT 1 FROM membership_permissions cp
    WHERE cp.membership_id=m.id AND cp.permission_code='customer.read'
      AND (cp.scope='AGENCY' OR (cp.scope='ASSIGNED' AND EXISTS(
        SELECT 1 FROM customers c WHERE c.agency_id=m.agency_id
          AND c.id=${sqlLiteral(command.customerId)} AND c.assignee_membership_id=m.id))))`;
}

function healthPredicate(command: Command): string {
  const targetBranch = `EXISTS(SELECT 1 FROM insurance_branches hb
    WHERE hb.agency_id=m.agency_id AND hb.id=${sqlLiteral(command.resource.branchId)}
      AND hb.data_classification='HEALTH')`;
  if (command.kind === 'create') return targetBranch;
  return `(${targetBranch} OR EXISTS(SELECT 1 FROM policies hp
    JOIN insurance_branches hb ON hb.agency_id=hp.agency_id AND hb.id=hp.branch_id
    WHERE hp.agency_id=m.agency_id AND hp.id=${sqlLiteral(command.policyId)}
      AND hb.data_classification='HEALTH'))`;
}

function authorityStatement(input: BaseInput, command: Command, action: string) {
  const direct =
    action === 'policy.create'
      ? `EXISTS(SELECT 1 FROM membership_permissions p WHERE p.membership_id=m.id AND p.permission_code='policy.create' AND p.scope='UNSCOPED')`
      : permissionClause(action, command, action === 'policy.assign');
  const read = permissionClause('policy.read', command);
  const dependencyScope = action === 'policy.create' ? '' : ` AND ${dependencyScopeClause(action)}`;
  const assign =
    command.kind === 'create' && command.requiresAgencyAssign
      ? ` AND ${permissionClause('policy.assign', command, true)} AND ${dependencyScopeClause('policy.assign')}`
      : '';
  const customerRead = command.kind === 'create' ? ` AND ${customerReadClause(command)}` : '';
  const health = healthPredicate(command);
  const sensitive = ` AND (NOT ${health} OR (
    EXISTS(SELECT 1 FROM membership_permissions s WHERE s.membership_id=m.id AND s.permission_code='sensitive.health.read' AND s.scope='UNSCOPED')
    ${action === 'policy.create' || action === 'policy.update' ? `AND EXISTS(SELECT 1 FROM membership_permissions s WHERE s.membership_id=m.id AND s.permission_code='sensitive.health.write' AND s.scope='UNSCOPED')` : ''}
  ))`;
  const authority = `(m.type='OWNER' OR (m.type='MEMBER' AND ${direct} AND ${read}${dependencyScope}${assign}${customerRead}))${sensitive}`;
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN EXISTS(
      SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
      WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
        AND m.permission_version=?
        AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
        AND ${authority}
    ) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorMembershipId,
      input.agencyId,
      input.actorUserId,
      input.permissionVersion,
      input.actorIdentityId,
    );
}

export async function assertPolicyCreateReplayAuthority(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly permissionVersion: number;
  readonly targetPolicyId: string;
  readonly customerId: string;
  readonly branchId: string;
  readonly originallyHealthClassified: boolean;
}): Promise<void> {
  const assertion = input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id
         JOIN agencies a ON a.id=m.agency_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=?
           AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
           AND m.permission_version=?
           AND EXISTS(SELECT 1 FROM auth_identities ai
             WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
           AND EXISTS(SELECT 1 FROM policies target_policy
             JOIN customers target_customer
               ON target_customer.agency_id=target_policy.agency_id
               AND target_customer.id=target_policy.customer_id
             WHERE target_policy.agency_id=m.agency_id AND target_policy.id=?
               AND target_policy.customer_id=? AND target_customer.id=?)
           AND (
             m.type='OWNER'
             OR (m.type='MEMBER'
               AND EXISTS(SELECT 1 FROM membership_permissions create_permission
                 WHERE create_permission.membership_id=m.id
                   AND create_permission.permission_code='policy.create'
                   AND create_permission.scope='UNSCOPED')
               AND EXISTS(SELECT 1 FROM membership_permissions policy_permission
                 WHERE policy_permission.membership_id=m.id
                   AND policy_permission.permission_code='policy.read'
                   AND (policy_permission.scope='AGENCY' OR (
                     policy_permission.scope='ASSIGNED' AND EXISTS(
                       SELECT 1 FROM policies scoped_policy
                       JOIN customers scoped_customer
                         ON scoped_customer.agency_id=scoped_policy.agency_id
                         AND scoped_customer.id=scoped_policy.customer_id
                       WHERE scoped_policy.agency_id=m.agency_id
                         AND scoped_policy.id=? AND scoped_policy.customer_id=?
                         AND (scoped_policy.assignee_membership_id=m.id
                           OR scoped_customer.assignee_membership_id=m.id)
                     )
                   )))
               AND EXISTS(SELECT 1 FROM membership_permissions customer_permission
                 WHERE customer_permission.membership_id=m.id
                   AND customer_permission.permission_code='customer.read'
                   AND (customer_permission.scope='AGENCY' OR (
                     customer_permission.scope='ASSIGNED' AND EXISTS(
                       SELECT 1 FROM customers scoped_customer
                       WHERE scoped_customer.agency_id=m.agency_id
                         AND scoped_customer.id=?
                         AND scoped_customer.assignee_membership_id=m.id
                     )
                   )))
             )
           )
           AND (
             (?=0 AND NOT EXISTS(SELECT 1 FROM insurance_branches requested_branch
                 WHERE requested_branch.agency_id=m.agency_id AND requested_branch.id=?
                   AND requested_branch.data_classification='HEALTH')
               AND NOT EXISTS(SELECT 1 FROM policies current_policy
                 JOIN insurance_branches current_branch
                   ON current_branch.agency_id=current_policy.agency_id
                   AND current_branch.id=current_policy.branch_id
                 WHERE current_policy.agency_id=m.agency_id
                   AND current_policy.id=? AND current_branch.data_classification='HEALTH'))
              OR EXISTS(SELECT 1 FROM membership_permissions health_read
                WHERE health_read.membership_id=m.id
                  AND health_read.permission_code='sensitive.health.read'
                  AND health_read.scope='UNSCOPED'))
           AND (
             (?=0 AND NOT EXISTS(SELECT 1 FROM insurance_branches requested_branch
                 WHERE requested_branch.agency_id=m.agency_id AND requested_branch.id=?
                   AND requested_branch.data_classification='HEALTH'))
             OR EXISTS(SELECT 1 FROM membership_permissions health_write
               WHERE health_write.membership_id=m.id
                 AND health_write.permission_code='sensitive.health.write'
                 AND health_write.scope='UNSCOPED')
           )
       ) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorMembershipId,
      input.agencyId,
      input.actorUserId,
      input.permissionVersion,
      input.actorIdentityId,
      input.targetPolicyId,
      input.customerId,
      input.customerId,
      input.targetPolicyId,
      input.customerId,
      input.customerId,
      input.originallyHealthClassified ? 1 : 0,
      input.branchId,
      input.targetPolicyId,
      input.originallyHealthClassified ? 1 : 0,
      input.branchId,
    );
  try {
    await input.db.batch([assertion]);
  } catch (error) {
    mapBatchError(error);
  }
}

function activeAssigneeStatement(input: BaseInput, assigneeMembershipId: string) {
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN EXISTS(
      SELECT 1 FROM agency_memberships m
      JOIN users u ON u.id=m.user_id
      JOIN agencies a ON a.id=m.agency_id
      WHERE m.id=? AND m.agency_id=?
        AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
    ) THEN 1 ELSE 0 END,'ASSIGNEE_NOT_ACTIVE'`,
    )
    .bind(crypto.randomUUID(), assigneeMembershipId, input.agencyId);
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
  if (message.includes('FINAL_AUTHORITY_RECHECK_FAILED')) throw new PolicyAuthorizationRaceError();
  if (message.includes('ASSIGNEE_NOT_ACTIVE'))
    throw new PolicyConstraintError('ASSIGNEE_NOT_ACTIVE');
  if (message.includes('POLICY_OPEN_DEPENDENCIES'))
    throw new PolicyConstraintError('OPEN_DEPENDENCIES');
  if (message.includes('RENEWAL_POLICY_LINK_ALLOCATION_OVERFLOW'))
    throw new PolicyConstraintError('RENEWAL_POLICY_LINK_ALLOCATION_CONFLICT');
  if (message.includes('RENEWAL_POLICY_LINK_CURRENCY_MISMATCH'))
    throw new PolicyConstraintError('RENEWAL_POLICY_LINK_CURRENCY_CONFLICT');
  if (message.includes('WON_POLICY_PREMIUM_IMMUTABLE'))
    throw new PolicyConstraintError('RENEWAL_WON_PREMIUM_IMMUTABLE');
  if (message.includes('RENEWAL_WON_CORRECTION_REQUIRED'))
    throw new PolicyConstraintError('RENEWAL_WON_CORRECTION_REQUIRED');
  if (message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT')) throw new OptimisticConcurrencyError(0);
  if (message.includes('SENSITIVE_ACTION_GRANT_INVALID'))
    throw new PolicyConstraintError('SENSITIVE_ACTION_GRANT_INVALID');
  if (message.includes('operation_receipts'))
    throw new IdempotencyConflictError('IDEMPOTENCY_CONCURRENT');
  if (
    message.includes('policies_candidate_uq') ||
    message.includes('policies.agency_id, policies.insurer_id')
  ) {
    throw new PolicyConstraintError('DUPLICATE_POLICY_CANDIDATE');
  }
  if (message.includes('POLICY_CATALOG_REFERENCE_NOT_SELECTABLE'))
    throw new PolicyConstraintError('CATALOG_REFERENCE_NOT_SELECTABLE');
  if (message.includes('POLICY_INSTALLMENT_SEMANTICS_INVALID'))
    throw new PolicyConstraintError('INSTALLMENT_COUNT_INVALID');
  throw error;
}

async function assertCurrentAuthority(input: BaseInput, command: Command, action: string) {
  try {
    await input.db.batch([authorityStatement(input, command, action)]);
  } catch (error) {
    mapBatchError(error);
  }
}

export async function executePolicyCommand(
  input: BaseInput & { command: Command; result: unknown; status: number },
): Promise<{ body: unknown; status: number; replayed: boolean }> {
  if (!input.idempotencyKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  const action =
    input.command.kind === 'create'
      ? 'policy.create'
      : input.command.kind === 'assign'
        ? 'policy.assign'
        : 'policy.update';
  const target = input.command.kind === 'create' ? 'new-policy' : input.command.policyId;
  const version = 'expectedVersion' in input.command ? input.command.expectedVersion : null;
  const fingerprint = await computePayloadHash({ action, target, payload: input.payload, version });
  const old = await replay(input, action, fingerprint);
  if (old) {
    await assertCurrentAuthority(input, input.command, action);
    return old;
  }

  const now = new Date().toISOString();
  const body =
    typeof input.result === 'function'
      ? (input.result as (now: string) => unknown)(now)
      : input.result;
  let business: D1PreparedStatement;
  if (input.command.kind === 'create') {
    business = input.db
      .prepare(
        `INSERT INTO policies
      (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,
       policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,installment_count,status,
       identity_variant,identity_variant_reason,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,1,?,?)`,
      )
      .bind(input.command.policyId, input.agencyId, ...input.command.values, now, now);
  } else if (input.command.kind === 'assign') {
    business = input.db
      .prepare(
        `UPDATE policies SET assignee_membership_id=?,version=version+1,updated_at=?
      WHERE id=? AND agency_id=? AND version=? AND archived_at IS NULL`,
      )
      .bind(
        input.command.assigneeMembershipId,
        now,
        input.command.policyId,
        input.agencyId,
        input.command.expectedVersion,
      );
  } else {
    const command = input.command;
    const columns: ReadonlyArray<readonly [keyof PolicyUpdateChanges, string]> = [
      ['policyNumber', 'policy_number'],
      ['normalizedPolicyNumber', 'normalized_policy_number'],
      ['startDate', 'start_date'],
      ['endDate', 'end_date'],
      ['grossPremiumMinor', 'gross_premium_minor'],
      ['currency', 'currency'],
      ['installmentCount', 'installment_count'],
      ['status', 'status'],
      ['insurerId', 'insurer_id'],
      ['productId', 'product_id'],
      ['branchId', 'branch_id'],
      ['paymentMethodId', 'payment_method_id'],
    ];
    const selected = columns.filter(([key]) => key in command.changes);
    if (selected.length === 0) throw new PolicyConstraintError('POLICY_UPDATE_EMPTY');
    business = input.db
      .prepare(
        `UPDATE policies SET ${selected.map(([, column]) => `${column}=?`).join(',')},version=version+1,updated_at=?
      WHERE id=? AND agency_id=? AND version=? AND archived_at IS NULL`,
      )
      .bind(
        ...selected.map(([key]) => command.changes[key]),
        now,
        command.policyId,
        input.agencyId,
        command.expectedVersion,
      );
  }
  const receipt = input.db
    .prepare(
      `INSERT INTO operation_receipts
    (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body)
    VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.agencyId,
      input.actorUserId,
      input.actorMembershipId,
      action,
      input.idempotencyKey.trim(),
      fingerprint,
      input.status,
      JSON.stringify(body),
    );
  const changed = input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,changes(),'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
    )
    .bind(crypto.randomUUID());
  try {
    const responseHash =
      input.command.kind === 'create'
        ? await computePayloadHash({
            action,
            target: input.command.policyId,
            result: body,
          })
        : undefined;
    const targetAssigneeId =
      input.command.kind === 'assign'
        ? input.command.assigneeMembershipId
        : input.command.kind === 'create'
          ? input.command.resource.assigneeMembershipId
          : null;
    const targetAssertion = targetAssigneeId
      ? [activeAssigneeStatement(input, targetAssigneeId)]
      : [];
    await input.db.batch([
      authorityStatement(input, input.command, action),
      ...targetAssertion,
      receipt,
      business,
      changed,
      auditStatement(input, action, input.command.policyId, [input.command.kind], responseHash),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const completed = await replay(input, action, fingerprint);
      if (completed) {
        await assertCurrentAuthority(input, input.command, action);
        return completed;
      }
    }
    mapBatchError(error);
  }
  return { body, status: input.status, replayed: false };
}

export async function findPolicyVariantReplay(
  input: BaseInput & { sourcePolicyId: string; expectedVersion: number; reason: string },
) {
  const action = 'policy.identity_variant.create';
  const payload = { expectedVersion: input.expectedVersion, reason: input.reason };
  const fingerprint = await computePayloadHash({
    action,
    target: input.sourcePolicyId,
    payload,
    version: input.expectedVersion,
  });
  const completed = await replay(input, action, fingerprint);
  if (!completed) return null;
  const replayPolicyId =
    typeof completed.body === 'object' &&
    completed.body !== null &&
    'id' in completed.body &&
    typeof completed.body.id === 'string'
      ? completed.body.id
      : null;
  if (!replayPolicyId) throw new PolicyAuthorizationRaceError();
  const authority = await input.db
    .prepare(
      `SELECT CASE WHEN EXISTS(
      SELECT 1 FROM agency_memberships m
      JOIN users u ON u.id=m.user_id
      JOIN agencies a ON a.id=m.agency_id
      WHERE m.id=? AND m.agency_id=? AND m.user_id=?
        AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
        AND m.permission_version=?
        AND EXISTS(SELECT 1 FROM auth_identities ai
          WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
        AND EXISTS(SELECT 1 FROM policies p WHERE p.id=? AND p.agency_id=m.agency_id)
        AND (m.type='OWNER' OR (m.type='MEMBER'
          AND EXISTS(SELECT 1 FROM membership_permissions p
            WHERE p.membership_id=m.id AND p.permission_code='policy.update' AND p.scope='AGENCY')
          AND EXISTS(SELECT 1 FROM membership_permissions p
            WHERE p.membership_id=m.id AND p.permission_code='policy.read' AND p.scope='AGENCY')))
        AND (NOT EXISTS(SELECT 1 FROM policies hp
          JOIN insurance_branches hb ON hb.agency_id=hp.agency_id AND hb.id=hp.branch_id
          WHERE hp.agency_id=m.agency_id AND hp.id=? AND hb.data_classification='HEALTH')
          OR (EXISTS(SELECT 1 FROM membership_permissions s
                WHERE s.membership_id=m.id AND s.permission_code='sensitive.health.read' AND s.scope='UNSCOPED')
            AND EXISTS(SELECT 1 FROM membership_permissions s
                WHERE s.membership_id=m.id AND s.permission_code='sensitive.health.write' AND s.scope='UNSCOPED')))
    ) THEN 1 ELSE 0 END allowed`,
    )
    .bind(
      input.actorMembershipId,
      input.agencyId,
      input.actorUserId,
      input.permissionVersion,
      input.actorIdentityId,
      replayPolicyId,
      replayPolicyId,
    )
    .first<{ allowed: number }>();
  if (authority?.allowed !== 1) throw new PolicyAuthorizationRaceError();
  return completed;
}

export async function executePolicyVariantCommand(
  input: BaseInput & {
    sourcePolicyId: string;
    expectedVersion: number;
    reason: string;
    grantToken: string;
    result: (id: string, variant: number, now: string) => unknown;
  },
) {
  if (!input.idempotencyKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  const action = 'policy.identity_variant.create';
  const payload = { expectedVersion: input.expectedVersion, reason: input.reason };
  const fingerprint = await computePayloadHash({
    action,
    target: input.sourcePolicyId,
    payload,
    version: input.expectedVersion,
  });
  const old = await findPolicyVariantReplay(input);
  if (old) return old;

  const payloadHash = await computePayloadHash(payload);
  const evidenceHash = await computeEvidenceHash(input.grantToken);
  const targets = canonicalizeTargetIds([input.sourcePolicyId]);
  const source = await input.db
    .prepare(`SELECT * FROM policies WHERE agency_id=? AND id=? AND version=?`)
    .bind(input.agencyId, input.sourcePolicyId, input.expectedVersion)
    .first<Record<string, unknown>>();
  if (!source) throw new OptimisticConcurrencyError(0);
  const maximum = await input.db
    .prepare(
      `SELECT max(identity_variant) v FROM policies
    WHERE agency_id=? AND insurer_id=? AND normalized_policy_number=? AND end_date=?`,
    )
    .bind(input.agencyId, source.insurer_id, source.normalized_policy_number, source.end_date)
    .first<{ v: number }>();
  const variant = (maximum?.v ?? 0) + 1;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const body = input.result(id, variant, now);

  const authority = input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN EXISTS(
      SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
      WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
        AND m.permission_version=?
        AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
        AND (m.type='OWNER' OR (m.type='MEMBER'
          AND EXISTS(SELECT 1 FROM membership_permissions p WHERE p.membership_id=m.id AND p.permission_code='policy.update' AND p.scope='AGENCY')
          AND EXISTS(SELECT 1 FROM membership_permissions p WHERE p.membership_id=m.id AND p.permission_code='policy.read' AND p.scope='AGENCY')))
        AND (NOT EXISTS(SELECT 1 FROM policies hp
          JOIN insurance_branches hb ON hb.agency_id=hp.agency_id AND hb.id=hp.branch_id
          WHERE hp.agency_id=m.agency_id AND hp.id=? AND hb.data_classification='HEALTH')
          OR (EXISTS(SELECT 1 FROM membership_permissions s WHERE s.membership_id=m.id AND s.permission_code='sensitive.health.read' AND s.scope='UNSCOPED')
            AND EXISTS(SELECT 1 FROM membership_permissions s WHERE s.membership_id=m.id AND s.permission_code='sensitive.health.write' AND s.scope='UNSCOPED')))
    ) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorMembershipId,
      input.agencyId,
      input.actorUserId,
      input.permissionVersion,
      input.actorIdentityId,
      input.sourcePolicyId,
    );
  const consume = input.db
    .prepare(
      `UPDATE sensitive_action_grants SET status='CONSUMED',consumed_at=?,consumed_operation_id=?,updated_at=?
    WHERE evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=? AND payload_hash=?
      AND target_ids_json=? AND expected_target_version=? AND permission_version=? AND assurance='SECURE_GRANT'
      AND status='ISSUED' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`,
    )
    .bind(
      now,
      input.idempotencyKey.trim(),
      now,
      evidenceHash,
      input.agencyId,
      input.actorUserId,
      input.actorMembershipId,
      action,
      payloadHash,
      targets,
      input.expectedVersion,
      input.permissionVersion,
      now,
    );
  const consumed = input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,changes(),'SENSITIVE_ACTION_GRANT_INVALID'`,
    )
    .bind(crypto.randomUUID());
  const receipt = input.db
    .prepare(
      `INSERT INTO operation_receipts
    (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body)
    VALUES(?,?,?,?,?,?,?,'COMPLETED',201,?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.agencyId,
      input.actorUserId,
      input.actorMembershipId,
      action,
      input.idempotencyKey.trim(),
      fingerprint,
      JSON.stringify(body),
    );
  const insert = input.db
    .prepare(
      `INSERT INTO policies
    (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,
     policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,installment_count,status,
     identity_variant,identity_variant_reason,version,created_at,updated_at)
    SELECT ?,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,
      policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,installment_count,status,
      ?,?,1,?,? FROM policies WHERE agency_id=? AND id=? AND version=?`,
    )
    .bind(
      id,
      variant,
      input.reason,
      now,
      now,
      input.agencyId,
      input.sourcePolicyId,
      input.expectedVersion,
    );
  const inserted = input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,changes(),'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
    )
    .bind(crypto.randomUUID());
  try {
    await input.db.batch([
      authority,
      consume,
      consumed,
      receipt,
      insert,
      inserted,
      auditStatement(input, action, id, ['identityVariant']),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const completed = await findPolicyVariantReplay(input);
      if (completed) return completed;
    }
    mapBatchError(error);
  }
  return { body, status: 201, replayed: false };
}
