import { computePayloadHash } from '../canonical';
import { buildSafeAuditRecord } from '../audit';
import { IdempotencyConflictError } from '../idempotency';
import { OptimisticConcurrencyError } from '../../db/optimistic';
import { PolicyAuthorizationRaceError, PolicyConstraintError } from './policy-errors';

export type PolicyRelationshipCommand =
  | {
      readonly kind: 'policy.vehicle.set';
      readonly policyId: string;
      readonly customerId: string;
      readonly expectedVersion: number;
      readonly vehicleId: string | null;
      readonly vehicleVersion: number | null;
    }
  | {
      readonly kind: 'policy_party.create';
      readonly policyId: string;
      readonly expectedVersion: number;
      readonly partyId: string;
      readonly customerId: string;
      readonly role: 'INSURED' | 'BENEFICIARY';
    }
  | {
      readonly kind: 'policy_party.deactivate';
      readonly policyId: string;
      readonly partyId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'policy_amendment.create';
      readonly policyId: string;
      readonly expectedVersion: number;
      readonly amendmentId: string;
      readonly externalReference: string;
      readonly effectiveDate: string;
      readonly description: string;
      readonly premiumDifferenceMinor: number | null;
      readonly currency: string | null;
    }
  | {
      readonly kind: 'policy_external_reference.create';
      readonly policyId: string;
      readonly expectedVersion: number;
      readonly referenceId: string;
      readonly sourceNamespace: string;
      readonly externalKey: string;
    }
  | {
      readonly kind: 'policy.archive';
      readonly policyId: string;
      readonly expectedVersion: number;
      readonly reasonCode: string;
    };

type Input = {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly permissionVersion: number;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly command: PolicyRelationshipCommand;
  readonly result: unknown | ((now: string) => unknown);
  readonly status: number;
};

function actionFor(command: PolicyRelationshipCommand): string {
  return command.kind;
}

function permissionFor(command: PolicyRelationshipCommand): string {
  return command.kind === 'policy.archive' ? 'policy.archive' : 'policy.update';
}

function auditEventFor(command: PolicyRelationshipCommand): string {
  switch (command.kind) {
    case 'policy.vehicle.set':
      return 'policy.vehicle.updated';
    case 'policy_party.create':
      return 'policy_party.created';
    case 'policy_party.deactivate':
      return 'policy_party.deactivated';
    case 'policy_amendment.create':
      return 'policy_amendment.created';
    case 'policy_external_reference.create':
      return 'policy_external_reference.created';
    case 'policy.archive':
      return 'policy.archived';
  }
}

function targetFor(command: PolicyRelationshipCommand): { type: string; id: string } {
  switch (command.kind) {
    case 'policy.vehicle.set':
      return { type: 'policy_vehicle_snapshots', id: command.policyId };
    case 'policy_party.create':
    case 'policy_party.deactivate':
      return { type: 'policy_parties', id: command.partyId };
    case 'policy_amendment.create':
      return { type: 'policy_amendments', id: command.amendmentId };
    case 'policy_external_reference.create':
      return { type: 'policy_external_references', id: command.referenceId };
    case 'policy.archive':
      return { type: 'policies', id: command.policyId };
  }
}

function expectedVersion(command: PolicyRelationshipCommand): number {
  return command.expectedVersion;
}

function fingerprintTarget(command: PolicyRelationshipCommand): string {
  return command.kind === 'policy_party.deactivate'
    ? `${command.policyId}:${command.partyId}`
    : command.policyId;
}

function createsPolicyChild(command: PolicyRelationshipCommand): boolean {
  return (
    command.kind === 'policy_party.create' ||
    command.kind === 'policy_amendment.create' ||
    command.kind === 'policy_external_reference.create' ||
    command.kind === 'policy.vehicle.set'
  );
}

function parentVersionStatement(input: Input, now: string): D1PreparedStatement {
  return input.db
    .prepare(
      `UPDATE policies SET version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND version=? AND archived_at IS NULL
         ${
           input.command.kind === 'policy.vehicle.set'
             ? `AND EXISTS(
           SELECT 1 FROM customers c JOIN insurance_branches b ON b.agency_id=policies.agency_id AND b.id=policies.branch_id
           WHERE c.agency_id=policies.agency_id AND c.id=policies.customer_id
             AND c.archived_at IS NULL AND b.supports_vehicle_details=1)`
             : ''
         }`,
    )
    .bind(now, input.agencyId, input.command.policyId, input.command.expectedVersion);
}

function scopeSql(permissionCode: string): string {
  return `EXISTS(
    SELECT 1 FROM membership_permissions mp
    WHERE mp.membership_id=m.id AND mp.permission_code='${permissionCode}'
      AND (mp.scope='AGENCY' OR (mp.scope='ASSIGNED' AND
        (p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)))
  )`;
}

function dependencyScopeSql(permissionCode: string): string {
  return `EXISTS(
    SELECT 1 FROM membership_permissions direct_permission
    JOIN membership_permissions dependency_permission
      ON dependency_permission.membership_id=direct_permission.membership_id
      AND dependency_permission.permission_code='policy.read'
    WHERE direct_permission.membership_id=m.id
      AND direct_permission.permission_code='${permissionCode}'
      AND (direct_permission.scope='ASSIGNED' OR dependency_permission.scope='AGENCY')
  )`;
}

function targetCustomerReadSql(customerId: string): string {
  return `EXISTS(
    SELECT 1 FROM membership_permissions customer_permission
    WHERE customer_permission.membership_id=m.id
      AND customer_permission.permission_code='customer.read'
      AND (customer_permission.scope='AGENCY' OR (customer_permission.scope='ASSIGNED' AND EXISTS(
        SELECT 1 FROM customers target_customer
        WHERE target_customer.agency_id=m.agency_id
          AND target_customer.id='${customerId.replaceAll("'", "''")}'
          AND target_customer.assignee_membership_id=m.id
      )))
  )`;
}

function authorityStatement(input: Input): D1PreparedStatement {
  const required = permissionFor(input.command);
  const targetCustomerRead =
    input.command.kind === 'policy_party.create' || input.command.kind === 'policy.vehicle.set'
      ? ` AND ${targetCustomerReadSql(input.command.customerId)}`
      : '';
  const activeParent = input.command.kind === 'policy.archive' ? '' : ' AND p.archived_at IS NULL';
  return input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id
         JOIN agencies a ON a.id=m.agency_id
         JOIN policies p ON p.agency_id=m.agency_id AND p.id=?
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
           AND EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
           ${activeParent}
           AND (m.type='OWNER' OR (m.type='MEMBER' AND ${scopeSql(required)} AND ${scopeSql('policy.read')} AND ${dependencyScopeSql(required)}${targetCustomerRead}))
           AND (b.data_classification<>'HEALTH' OR (
             EXISTS(SELECT 1 FROM membership_permissions sr WHERE sr.membership_id=m.id AND sr.permission_code='sensitive.health.read' AND sr.scope='UNSCOPED')
             AND EXISTS(SELECT 1 FROM membership_permissions sw WHERE sw.membership_id=m.id AND sw.permission_code='sensitive.health.write' AND sw.scope='UNSCOPED')
           ))
       ) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      input.command.policyId,
      input.actorMembershipId,
      input.agencyId,
      input.actorUserId,
      input.permissionVersion,
      input.actorIdentityId,
    );
}

function businessStatement(input: Input, now: string): D1PreparedStatement {
  const command = input.command;
  switch (command.kind) {
    case 'policy.vehicle.set':
      return command.vehicleId === null
        ? input.db
            .prepare('DELETE FROM policy_vehicle_snapshots WHERE agency_id=? AND policy_id=?')
            .bind(input.agencyId, command.policyId)
        : input.db
            .prepare(
              `INSERT INTO policy_vehicle_snapshots(policy_id,agency_id,customer_id,vehicle_id,vehicle_version,details_json,created_at,updated_at)
          SELECT ?,v.agency_id,v.customer_id,v.id,v.version,v.details_json,?,? FROM customer_vehicles v JOIN customers c ON c.agency_id=v.agency_id AND c.id=v.customer_id
          JOIN policies p ON p.agency_id=v.agency_id AND p.customer_id=v.customer_id AND p.id=?
          WHERE v.agency_id=? AND v.customer_id=? AND v.id=? AND v.version=? AND v.status='ACTIVE' AND c.archived_at IS NULL
          ON CONFLICT(policy_id) DO UPDATE SET customer_id=excluded.customer_id,vehicle_id=excluded.vehicle_id,vehicle_version=excluded.vehicle_version,details_json=excluded.details_json,updated_at=excluded.updated_at`,
            )
            .bind(
              command.policyId,
              now,
              now,
              command.policyId,
              input.agencyId,
              command.customerId,
              command.vehicleId,
              command.vehicleVersion,
            );
    case 'policy_party.create':
      return input.db
        .prepare(
          `INSERT INTO policy_parties
           (id,agency_id,policy_id,customer_id,role,status,version,created_at,updated_at)
           VALUES(?,?,?,?,?,'ACTIVE',1,?,?)`,
        )
        .bind(
          command.partyId,
          input.agencyId,
          command.policyId,
          command.customerId,
          command.role,
          now,
          now,
        );
    case 'policy_party.deactivate':
      return input.db
        .prepare(
          `UPDATE policy_parties
           SET status='INACTIVE',version=version+1,deactivated_at=?,deactivated_by_membership_id=?,updated_at=?
           WHERE agency_id=? AND policy_id=? AND id=? AND version=? AND status='ACTIVE'`,
        )
        .bind(
          now,
          input.actorMembershipId,
          now,
          input.agencyId,
          command.policyId,
          command.partyId,
          command.expectedVersion,
        );
    case 'policy_amendment.create':
      return input.db
        .prepare(
          `INSERT INTO policy_amendments
           (id,agency_id,policy_id,external_reference,effective_date,description,premium_difference_minor,currency,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          command.amendmentId,
          input.agencyId,
          command.policyId,
          command.externalReference,
          command.effectiveDate,
          command.description,
          command.premiumDifferenceMinor,
          command.currency,
          now,
        );
    case 'policy_external_reference.create':
      return input.db
        .prepare(
          `INSERT INTO policy_external_references
           (id,agency_id,policy_id,source_namespace,external_key,created_at)
           VALUES(?,?,?,?,?,?)`,
        )
        .bind(
          command.referenceId,
          input.agencyId,
          command.policyId,
          command.sourceNamespace,
          command.externalKey,
          now,
        );
    case 'policy.archive':
      return input.db
        .prepare(
          `UPDATE policies
           SET archived_at=?,archived_by_membership_id=?,archive_reason=?,version=version+1,updated_at=?
           WHERE agency_id=? AND id=? AND version=? AND archived_at IS NULL`,
        )
        .bind(
          now,
          input.actorMembershipId,
          command.reasonCode,
          now,
          input.agencyId,
          command.policyId,
          command.expectedVersion,
        );
  }
}

function auditMetadata(command: PolicyRelationshipCommand): Record<string, unknown> {
  switch (command.kind) {
    case 'policy.vehicle.set':
      return { customerId: command.customerId };
    case 'policy_party.create':
      return { customerId: command.customerId, safeCode: command.role };
    case 'policy_party.deactivate':
      return { changedFields: ['status', 'deactivatedAt'] };
    case 'policy_amendment.create':
      return { changedFields: ['effectiveDate', 'premiumDifferenceMinor', 'currency'] };
    case 'policy_external_reference.create':
      return { changedFields: ['sourceNamespace', 'externalKey'] };
    case 'policy.archive':
      return { reasonCode: command.reasonCode, changedFields: ['archivedAt'] };
  }
}

function auditStatement(input: Input, now: string): D1PreparedStatement {
  const target = targetFor(input.command);
  const audit = buildSafeAuditRecord({
    id: crypto.randomUUID(),
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    action: auditEventFor(input.command),
    targetType: target.type,
    targetId: target.id,
    correlationId: crypto.randomUUID(),
    idempotencyKey: input.idempotencyKey.trim(),
    outcome: 'SUCCESS',
    metadata: auditMetadata(input.command),
    createdAt: now,
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

type ReplayInput = Pick<
  Input,
  'db' | 'agencyId' | 'actorUserId' | 'actorMembershipId' | 'idempotencyKey'
>;

async function replay(input: ReplayInput, action: string, fingerprint: string) {
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
      response_status: number | null;
      response_body: string | null;
    }>();
  if (!row) return null;
  if (
    row.action !== action ||
    row.payload_fingerprint !== fingerprint ||
    row.status !== 'COMPLETED' ||
    row.response_status === null ||
    row.response_body === null
  ) {
    throw new IdempotencyConflictError('IDEMPOTENCY_CONFLICT');
  }
  return { body: JSON.parse(row.response_body), status: row.response_status, replayed: true };
}

export async function findPolicyRelationshipReplay(
  input: ReplayInput & {
    readonly action: string;
    readonly target: string;
    readonly payload: unknown;
    readonly version: number;
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

function isReceiptRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('operation_receipts_idem_uq') ||
    message.includes('UNIQUE constraint failed: operation_receipts') ||
    message.includes('IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN')
  );
}

function mapError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('FINAL_AUTHORITY_RECHECK_FAILED')) throw new PolicyAuthorizationRaceError();
  if (message.includes('POLICY_OPEN_DEPENDENCIES'))
    throw new PolicyConstraintError('OPEN_DEPENDENCIES');
  if (message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT')) throw new OptimisticConcurrencyError(0);
  if (
    message.includes('policy_external_references_namespace_key_uq') ||
    message.includes(
      'policy_external_references.agency_id, policy_external_references.source_namespace',
    )
  )
    throw new PolicyConstraintError('DUPLICATE_EXTERNAL_REFERENCE');
  if (
    message.includes('policy_parties_active_relation_uq') ||
    message.includes('policy_parties.agency_id, policy_parties.policy_id')
  )
    throw new PolicyConstraintError('DUPLICATE_POLICY_PARTY');
  if (message.includes('operation_receipts'))
    throw new IdempotencyConflictError('IDEMPOTENCY_CONCURRENT');
  throw error;
}

async function assertCurrentAuthority(input: Input) {
  try {
    await input.db.batch([authorityStatement(input)]);
  } catch (error) {
    mapError(error);
  }
}

export async function executePolicyRelationshipCommand(input: Input): Promise<{
  body: unknown;
  status: number;
  replayed: boolean;
}> {
  const key = input.idempotencyKey.trim();
  if (!key) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  const action = actionFor(input.command);
  const fingerprint = await computePayloadHash({
    action,
    target: fingerprintTarget(input.command),
    payload: input.payload,
    version: expectedVersion(input.command),
  });
  const completed = await replay(input, action, fingerprint);
  if (completed) {
    await assertCurrentAuthority(input);
    return completed;
  }

  const now = new Date().toISOString();
  const body = typeof input.result === 'function' ? input.result(now) : input.result;
  const receipt = input.db
    .prepare(
      `INSERT INTO operation_receipts
       (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.agencyId,
      input.actorUserId,
      input.actorMembershipId,
      action,
      key,
      fingerprint,
      input.status,
      JSON.stringify(body),
      now,
      now,
    );
  const changed = input.db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,changes(),'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
    )
    .bind(crypto.randomUUID());
  try {
    const parentCas = createsPolicyChild(input.command)
      ? [
          parentVersionStatement(input, now),
          input.db
            .prepare(
              `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
               SELECT ?,1,changes(),'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
            )
            .bind(crypto.randomUUID()),
        ]
      : [];
    await input.db.batch([
      authorityStatement(input),
      receipt,
      ...parentCas,
      businessStatement(input, now),
      changed,
      auditStatement(input, now),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await replay(input, action, fingerprint);
      if (raced) {
        await assertCurrentAuthority(input);
        return raced;
      }
    }
    mapError(error);
  }
  return { body, status: input.status, replayed: false };
}
