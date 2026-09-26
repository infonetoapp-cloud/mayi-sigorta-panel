import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import {
  canonicalizeTargetIds,
  computeEvidenceHash,
  issueAndPersistSensitiveActionGrant,
} from '../mutations/grants';
import { computePayloadHash } from '../mutations/canonical';
import { activeMembership, readReceipt, RenewalCommandError } from './commands';
import type { ActiveMembership } from './commands';

const OPERATION_ACTION = 'renewal.won.premium.correct';
const GRANT_ACTION = 'renewal.won.correct';

const positiveVersion = z.number().int().min(1).max(1_000_000_000);
const entityId = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());

export const correctWonPolicyPremiumSchema = z
  .object({
    expectedPolicyVersion: positiveVersion,
    correctedPremiumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    allocations: z
      .array(
        z
          .object({
            linkId: entityId,
            expectedRenewalVersion: positiveVersion,
            allocatedPremiumMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .superRefine((items, context) => {
        const ids = new Set<string>();
        items.forEach((item, index) => {
          if (ids.has(item.linkId)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'linkId'],
              message: 'DUPLICATE_LINK',
            });
          }
          ids.add(item.linkId);
        });
      }),
  })
  .strict();

export type CorrectWonPolicyPremiumInput = z.infer<typeof correctWonPolicyPremiumSchema>;

interface PolicyRow {
  readonly id: string;
  readonly agency_id: string;
  readonly customer_id: string;
  readonly branch_id: string;
  readonly insurer_id: string;
  readonly product_id: string;
  readonly payment_method_id: string;
  readonly version: number;
  readonly gross_premium_minor: number;
  readonly currency: string;
  readonly status: string;
  readonly archived_at: string | null;
  readonly assignee_membership_id: string | null;
  readonly customer_assignee_membership_id: string | null;
  readonly branch_data_classification: string;
}

interface LinkRow {
  readonly id: string;
  readonly renewal_id: string;
  readonly new_policy_id: string;
  readonly allocated_new_premium_minor: number;
  readonly currency: string;
  readonly different_policyholder_reason_code: string | null;
  readonly created_by_membership_id: string;
  readonly allocation_operation_id: string;
  readonly renewal_state: string;
  readonly renewal_version: number;
  readonly renewal_assignee_membership_id: string | null;
  readonly customer_assignee_membership_id: string | null;
  readonly customer_id: string;
}

interface CorrectionSnapshot {
  readonly policy: PolicyRow;
  readonly links: readonly LinkRow[];
  readonly renewalIds: readonly string[];
  readonly targetIdsJson: string;
  readonly payloadHash: string;
}

export interface CorrectWonPolicyPremiumResult {
  readonly operationId: string;
  readonly policyId: string;
  readonly previousPolicyVersion: number;
  readonly policyVersion: number;
  readonly previousPremiumMinor: number;
  readonly correctedPremiumMinor: number;
  readonly currency: string;
  readonly reasonCode: string;
  readonly links: readonly {
    readonly supersededLinkId: string;
    readonly newLinkId: string;
    readonly renewalId: string;
    readonly allocatedPremiumMinor: number;
  }[];
}

function idempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  return value;
}

function casAssertion(
  db: D1Database,
  code: string,
  predicate: string,
  bindings: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN ${predicate} THEN 1 ELSE 0 END,?`,
    )
    .bind(crypto.randomUUID(), ...bindings, code);
}

function changesAssertion(db: D1Database, code: string): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), code);
}

async function loadPolicy(db: D1Database, agencyId: string, policyId: string): Promise<PolicyRow> {
  const policy = await db
    .prepare(
      `SELECT p.id,p.agency_id,p.customer_id,p.branch_id,p.insurer_id,p.product_id,p.payment_method_id,
              p.version,p.gross_premium_minor,p.currency,p.status,p.archived_at,
              p.assignee_membership_id,c.assignee_membership_id AS customer_assignee_membership_id,
              b.data_classification AS branch_data_classification
       FROM policies p
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       WHERE p.agency_id=? AND p.id=?`,
    )
    .bind(agencyId, policyId)
    .first<PolicyRow>();
  if (!policy) throw new RenewalCommandError('NOT_FOUND', 404);
  if (policy.status !== 'ACTIVE' || policy.archived_at !== null)
    throw new RenewalCommandError('WON_POLICY_NOT_ACTIVE', 409);
  return policy;
}

async function authorizePolicy(
  db: D1Database,
  context: AuthenticatedUserContext,
  policy: PolicyRow,
  mode: 'WRITE' | 'READ',
): Promise<void> {
  const action = mode === 'WRITE' ? 'policy.update' : 'policy.read';
  const result = await evaluateAuthorization(db, {
    context,
    action,
    resource: {
      agencyId: policy.agency_id,
      id: policy.id,
      assigneeMembershipId: policy.assignee_membership_id,
      customerAssigneeMembershipId: policy.customer_assignee_membership_id,
      branchId: policy.branch_id,
    },
  });
  if (result.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
  if (policy.branch_data_classification === 'HEALTH') {
    const health = await evaluateAuthorization(db, {
      context,
      action: mode === 'WRITE' ? 'policy.health.update' : 'policy.health.read',
      resource: {
        agencyId: policy.agency_id,
        assigneeMembershipId: policy.assignee_membership_id,
        customerAssigneeMembershipId: policy.customer_assignee_membership_id,
        branchId: policy.branch_id,
      },
    });
    if (health.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
  }
}

async function authorizeRenewal(
  db: D1Database,
  context: AuthenticatedUserContext,
  agencyId: string,
  row: Pick<
    LinkRow,
    'renewal_id' | 'renewal_assignee_membership_id' | 'customer_assignee_membership_id'
  >,
  binding?: {
    evidence: string;
    payload: unknown;
    targetIds: readonly string[];
    expectedTargetVersion: number;
  },
): Promise<void> {
  const result = await evaluateAuthorization(db, {
    context,
    action: binding ? GRANT_ACTION : 'renewal.read',
    resource: {
      agencyId,
      id: row.renewal_id,
      renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
      customerAssigneeMembershipId: row.customer_assignee_membership_id,
    },
    ...(binding ? { secureGrantBinding: binding } : {}),
  });
  if (result.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
}

async function loadSnapshot(
  db: D1Database,
  active: ActiveMembership,
  policy: PolicyRow,
  input: CorrectWonPolicyPremiumInput,
): Promise<CorrectionSnapshot> {
  if (policy.version !== input.expectedPolicyVersion)
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  const links = await db
    .prepare(
      `SELECT link.id,link.renewal_id,link.new_policy_id,link.allocated_new_premium_minor,
              link.currency,link.different_policyholder_reason_code,link.created_by_membership_id,
              link.allocation_operation_id,renewal.state AS renewal_state,renewal.version AS renewal_version,
              renewal.assignee_membership_id AS renewal_assignee_membership_id,
              customer.assignee_membership_id AS customer_assignee_membership_id,
              customer.id AS customer_id
       FROM renewal_policy_links link
       JOIN renewal_opportunities renewal
         ON renewal.agency_id=link.agency_id AND renewal.id=link.renewal_id
       JOIN policies old_policy
         ON old_policy.agency_id=renewal.agency_id AND old_policy.id=renewal.expiring_policy_id
       JOIN customers customer
         ON customer.agency_id=old_policy.agency_id AND customer.id=old_policy.customer_id
       WHERE link.agency_id=? AND link.new_policy_id=? AND link.status='ACTIVE'
       ORDER BY link.renewal_id,link.id`,
    )
    .bind(active.agencyId, policy.id)
    .all<LinkRow>();
  if (
    !links.success ||
    links.results.length !== input.allocations.length ||
    links.results.length === 0
  )
    throw new RenewalCommandError('WON_POLICY_ALLOCATION_SET_CHANGED', 409);
  const byId = new Map(links.results.map((link) => [link.id, link]));
  const normalizedAllocations = [...input.allocations].sort((a, b) =>
    a.linkId.localeCompare(b.linkId),
  );
  let oldTotal = 0;
  let newTotal = 0;
  for (const allocation of normalizedAllocations) {
    const link = byId.get(allocation.linkId);
    if (!link || link.new_policy_id !== policy.id || link.renewal_state !== 'WON')
      throw new RenewalCommandError('WON_POLICY_ALLOCATION_SET_CHANGED', 409);
    if (link.renewal_version !== allocation.expectedRenewalVersion)
      throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
    if (link.currency !== policy.currency)
      throw new RenewalCommandError('POLICY_LINK_CURRENCY_MISMATCH', 409);
    oldTotal += link.allocated_new_premium_minor;
    newTotal += allocation.allocatedPremiumMinor;
    if (!Number.isSafeInteger(oldTotal) || !Number.isSafeInteger(newTotal))
      throw new RenewalCommandError('PREMIUM_ALLOCATION_OVERFLOW', 409);
  }
  if (oldTotal !== policy.gross_premium_minor || newTotal !== input.correctedPremiumMinor) {
    throw new RenewalCommandError('WON_POLICY_ALLOCATION_TOTAL_INVALID', 409);
  }
  if (
    policy.gross_premium_minor === input.correctedPremiumMinor &&
    normalizedAllocations.every(
      (allocation) =>
        allocation.allocatedPremiumMinor ===
        byId.get(allocation.linkId)?.allocated_new_premium_minor,
    )
  )
    throw new RenewalCommandError('NO_CHANGE', 409);
  const renewalIds = [...new Set(links.results.map((link) => link.renewal_id))].sort();
  const targetIdsJson = canonicalizeTargetIds([policy.id, ...renewalIds]);
  const payloadHash = await computePayloadHash({
    action: OPERATION_ACTION,
    policyId: policy.id,
    input: {
      expectedPolicyVersion: input.expectedPolicyVersion,
      correctedPremiumMinor: input.correctedPremiumMinor,
      reasonCode: input.reasonCode,
      allocations: normalizedAllocations,
    },
    activeLinks: links.results.map((link) => ({
      id: link.id,
      renewalId: link.renewal_id,
      policyId: link.new_policy_id,
      allocatedPremiumMinor: link.allocated_new_premium_minor,
      currency: link.currency,
      differentPolicyholderReasonCode: link.different_policyholder_reason_code,
      renewalVersion: link.renewal_version,
    })),
  });
  return { policy, links: links.results, renewalIds, targetIdsJson, payloadHash };
}

function resultFromReceipt(receipt: {
  response_body: string | null;
}): CorrectWonPolicyPremiumResult {
  let result: unknown;
  try {
    result = JSON.parse(receipt.response_body ?? 'null');
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const value = result as CorrectWonPolicyPremiumResult;
  if (
    !Array.isArray(value.links) ||
    value.links.length === 0 ||
    typeof value.operationId !== 'string' ||
    typeof value.policyId !== 'string' ||
    typeof value.previousPremiumMinor !== 'number' ||
    typeof value.correctedPremiumMinor !== 'number' ||
    typeof value.reasonCode !== 'string'
  )
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  return value;
}

async function proveReplay(
  db: D1Database,
  active: ActiveMembership,
  receipt: {
    id: string;
    idempotency_key: string;
    response_body: string | null;
    payload_fingerprint: string;
  },
  result: CorrectWonPolicyPremiumResult,
  fingerprint: string,
): Promise<void> {
  if (receipt.payload_fingerprint !== fingerprint || result.operationId !== receipt.id)
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  const proof = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM renewal_won_policy_premium_corrections correction
          WHERE correction.id=? AND correction.agency_id=? AND correction.policy_id=?
            AND correction.expected_policy_version=? AND correction.previous_premium_minor=?
            AND correction.corrected_premium_minor=? AND correction.reason_code=?) AS correction_count,
         (SELECT count(*) FROM renewal_won_policy_premium_correction_links map
          JOIN renewal_policy_links old_link ON old_link.agency_id=map.agency_id AND old_link.id=map.old_link_id
          JOIN renewal_policy_links new_link ON new_link.agency_id=map.agency_id AND new_link.id=map.new_link_id
          WHERE map.agency_id=? AND map.operation_id=? AND map.policy_id=?
            AND old_link.status='SUPERSEDED' AND old_link.superseded_operation_id=?
            AND old_link.supersede_reason_code='WON_PREMIUM_CORRECTED'
            AND new_link.allocation_operation_id=? AND new_link.supersedes_link_id=old_link.id
            AND map.allocated_premium_minor=new_link.allocated_new_premium_minor
            AND map.currency=new_link.currency) AS links_count,
         (SELECT count(*) FROM audit_events audit WHERE audit.agency_id=? AND audit.idempotency_key=?
            AND audit.action='renewal.won.premium.corrected' AND audit.target_id=?) AS audit_count,
         (SELECT count(*) FROM operation_receipts receipt WHERE receipt.id=? AND receipt.agency_id=?
            AND receipt.actor_membership_id=? AND receipt.action=? AND receipt.status='COMPLETED'
            AND receipt.response_status=200 AND receipt.payload_fingerprint=?
            AND receipt.response_body=?) AS receipt_count`,
    )
    .bind(
      receipt.id,
      active.agencyId,
      result.policyId,
      result.previousPolicyVersion,
      result.previousPremiumMinor,
      result.correctedPremiumMinor,
      result.reasonCode,
      active.agencyId,
      receipt.id,
      result.policyId,
      receipt.id,
      receipt.id,
      active.agencyId,
      receipt.idempotency_key,
      result.policyId,
      receipt.id,
      active.agencyId,
      active.id,
      OPERATION_ACTION,
      fingerprint,
      JSON.stringify(result),
    )
    .first<{
      correction_count: number;
      links_count: number;
      audit_count: number;
      receipt_count: number;
    }>();
  if (
    proof?.correction_count !== 1 ||
    proof.links_count !== result.links.length ||
    proof.audit_count !== 1 ||
    proof.receipt_count !== 1
  )
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
}

function grantConsumeStatement(
  db: D1Database,
  grantId: string,
  evidenceHash: string,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  snapshot: CorrectionSnapshot,
  operationId: string,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sensitive_action_grants
       SET status='CONSUMED',consumed_at=?,consumed_operation_id=?,updated_at=?
       WHERE id=? AND evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=?
         AND action=? AND payload_hash=? AND target_ids_json=? AND expected_target_version=?
         AND permission_version=? AND assurance='SECURE_GRANT' AND status='ISSUED'
         AND consumed_at IS NULL AND revoked_at IS NULL AND issued_at<=? AND expires_at>?`,
    )
    .bind(
      now,
      operationId,
      now,
      grantId,
      evidenceHash,
      active.agencyId,
      context.userId,
      active.id,
      GRANT_ACTION,
      snapshot.payloadHash,
      snapshot.targetIdsJson,
      snapshot.policy.version,
      active.permissionVersion,
      now,
      now,
    );
}

function membershipAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  snapshot: CorrectionSnapshot,
): D1PreparedStatement {
  const expectedRenewals = snapshot.links.map(
    (link) =>
      `EXISTS(SELECT 1 FROM renewal_opportunities r JOIN customers c ON c.agency_id=r.agency_id
          AND c.id=(SELECT p.customer_id FROM policies p WHERE p.agency_id=r.agency_id AND p.id=r.expiring_policy_id)
        WHERE r.agency_id='${snapshot.policy.agency_id}' AND r.id='${link.renewal_id}'
          AND r.version=${link.renewal_version} AND r.state='WON'
          AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions permission
            WHERE permission.membership_id=m.id AND permission.permission_code='renewal.update'
              AND permission.scope IN ('AGENCY','ASSIGNED')
              AND (permission.scope='AGENCY' OR r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id))))`,
  );
  const policyWrite = `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions permission
    WHERE permission.membership_id=m.id AND permission.permission_code='policy.update'
      AND permission.scope IN ('AGENCY','ASSIGNED')
      AND (permission.scope='AGENCY' OR p.assignee_membership_id=m.id OR customer.assignee_membership_id=m.id)))`;
  const healthPermission =
    snapshot.policy.branch_data_classification === 'HEALTH'
      ? `AND EXISTS(SELECT 1 FROM membership_permissions sensitive_read
          WHERE sensitive_read.membership_id=m.id
            AND sensitive_read.permission_code='sensitive.health.read'
            AND sensitive_read.scope='UNSCOPED')
         AND EXISTS(SELECT 1 FROM membership_permissions sensitive_write
          WHERE sensitive_write.membership_id=m.id
            AND sensitive_write.permission_code='sensitive.health.write'
            AND sensitive_write.scope='UNSCOPED')`
      : '';
  return casAssertion(
    db,
    'MEMBERSHIP_AUTHORIZED',
    `EXISTS(SELECT 1 FROM agency_memberships m
      JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
      JOIN auth_identities identity ON identity.user_id=u.id AND identity.id='${context.identityId}' AND identity.status='ACTIVE'
      JOIN policies p ON p.agency_id=m.agency_id AND p.id='${snapshot.policy.id}'
      JOIN customers customer ON customer.agency_id=p.agency_id AND customer.id=p.customer_id
      WHERE m.id='${active.id}' AND m.agency_id='${active.agencyId}' AND m.user_id='${context.userId}'
        AND m.status='ACTIVE' AND m.permission_version=${active.permissionVersion}
        AND u.status='ACTIVE' AND a.status='ACTIVE' AND ${policyWrite} ${healthPermission}
        AND ${expectedRenewals.join(' AND ')})`,
    [],
  );
}

async function replayAuthorization(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  result: CorrectWonPolicyPremiumResult,
): Promise<void> {
  const policy = await loadPolicy(db, active.agencyId, result.policyId);
  await authorizePolicy(db, context, policy, 'READ');
  for (const renewalId of [...new Set(result.links.map((link) => link.renewalId))]) {
    const row = await db
      .prepare(
        `SELECT r.id AS renewal_id,r.assignee_membership_id AS renewal_assignee_membership_id,
                c.assignee_membership_id AS customer_assignee_membership_id
         FROM renewal_opportunities r JOIN policies old_policy
           ON old_policy.agency_id=r.agency_id AND old_policy.id=r.expiring_policy_id
         JOIN customers c ON c.agency_id=old_policy.agency_id AND c.id=old_policy.customer_id
         WHERE r.agency_id=? AND r.id=?`,
      )
      .bind(active.agencyId, renewalId)
      .first<
        Pick<
          LinkRow,
          'renewal_id' | 'renewal_assignee_membership_id' | 'customer_assignee_membership_id'
        >
      >();
    if (!row) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    const authorization = await evaluateAuthorization(db, {
      context,
      action: 'renewal.read',
      resource: {
        agencyId: active.agencyId,
        id: renewalId,
        renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
        customerAssigneeMembershipId: row.customer_assignee_membership_id,
      },
    });
    if (authorization.decision !== 'ALLOW')
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

export async function correctWonPolicyPremium(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
  rawInput: unknown,
  rawIdempotencyKey: string,
  options: { readonly grantTtlSeconds?: number } = {},
): Promise<{ data: CorrectWonPolicyPremiumResult; replayed: boolean; status: 200 }> {
  const input = correctWonPolicyPremiumSchema.parse(rawInput);
  const key = idempotencyKey(rawIdempotencyKey);
  if (context.assurance !== 'SECURE')
    throw new RenewalCommandError('SECURE_ASSURANCE_REQUIRED', 403);
  const active = activeMembership(context);
  const normalizedInput = {
    expectedPolicyVersion: input.expectedPolicyVersion,
    correctedPremiumMinor: input.correctedPremiumMinor,
    reasonCode: input.reasonCode,
    allocations: [...input.allocations].sort((a, b) => a.linkId.localeCompare(b.linkId)),
  };
  const fingerprint = await computePayloadHash({
    operation: OPERATION_ACTION,
    policyId,
    input: normalizedInput,
  });
  const existing = await readReceipt(db, active, context.userId, key);
  if (existing) {
    if (existing.action !== OPERATION_ACTION || existing.payload_fingerprint !== fingerprint)
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    const result = resultFromReceipt(existing);
    await proveReplay(db, active, existing, result, fingerprint);
    if (result.policyId !== policyId) throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    await replayAuthorization(db, context, active, result);
    return { data: result, replayed: true, status: 200 };
  }
  const policy = await loadPolicy(db, active.agencyId, policyId);
  await authorizePolicy(db, context, policy, 'WRITE');
  const snapshot = await loadSnapshot(db, active, policy, input);
  const payload = {
    action: OPERATION_ACTION,
    policyId,
    input: normalizedInput,
    activeLinks: snapshot.links.map((link) => ({
      id: link.id,
      renewalId: link.renewal_id,
      policyId: link.new_policy_id,
      allocatedPremiumMinor: link.allocated_new_premium_minor,
      currency: link.currency,
      differentPolicyholderReasonCode: link.different_policyholder_reason_code,
      renewalVersion: link.renewal_version,
    })),
  };
  const payloadHash = await computePayloadHash(payload);
  if (payloadHash !== snapshot.payloadHash) throw new RenewalCommandError('DATABASE_ERROR', 500);
  const grant = await issueAndPersistSensitiveActionGrant(db, context, {
    agencyId: active.agencyId,
    action: GRANT_ACTION,
    payloadHash,
    targetIds: [policyId, ...snapshot.renewalIds],
    expectedTargetVersion: input.expectedPolicyVersion,
    ttlSeconds: options.grantTtlSeconds,
  });
  const binding = {
    evidence: grant.grantToken,
    payload,
    targetIds: [policyId, ...snapshot.renewalIds],
    expectedTargetVersion: input.expectedPolicyVersion,
  };
  for (const link of snapshot.links) {
    await authorizeRenewal(db, context, active.agencyId, link, binding);
  }
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const allocationByLinkId = new Map(
    input.allocations.map((allocation) => [allocation.linkId, allocation]),
  );
  const result: CorrectWonPolicyPremiumResult = {
    operationId,
    policyId,
    previousPolicyVersion: policy.version,
    policyVersion: policy.version + 1,
    previousPremiumMinor: policy.gross_premium_minor,
    correctedPremiumMinor: input.correctedPremiumMinor,
    currency: policy.currency,
    reasonCode: input.reasonCode,
    links: snapshot.links.map((link) => ({
      supersededLinkId: link.id,
      newLinkId: crypto.randomUUID(),
      renewalId: link.renewal_id,
      allocatedPremiumMinor: allocationByLinkId.get(link.id)!.allocatedPremiumMinor,
    })),
  };
  const receipt = db
    .prepare(
      `INSERT INTO operation_receipts
       (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
        status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
    )
    .bind(
      operationId,
      active.agencyId,
      context.userId,
      active.id,
      OPERATION_ACTION,
      key,
      fingerprint,
      JSON.stringify(result),
      now,
      now,
    );
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action: 'renewal.won.premium.corrected',
    targetType: 'policies',
    targetId: policyId,
    correlationId: key,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    createdAt: now,
    metadata: {
      reasonCode: input.reasonCode,
      previousPremiumMinor: policy.gross_premium_minor,
      correctedPremiumMinor: input.correctedPremiumMinor,
      currency: policy.currency,
      correctedLinkCount: result.links.length,
    },
  });
  const statements: D1PreparedStatement[] = [
    membershipAssertion(db, context, active, snapshot),
    grantConsumeStatement(
      db,
      grant.grantRecord.id,
      await computeEvidenceHash(grant.grantToken),
      context,
      active,
      snapshot,
      operationId,
      now,
    ),
    changesAssertion(db, 'SECURE_GRANT_INVALID'),
    receipt,
    db
      .prepare(
        `INSERT INTO renewal_won_policy_premium_corrections
         (id,agency_id,policy_id,actor_membership_id,expected_policy_version,previous_premium_minor,
          corrected_premium_minor,reason_code,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        operationId,
        active.agencyId,
        policyId,
        active.id,
        policy.version,
        policy.gross_premium_minor,
        input.correctedPremiumMinor,
        input.reasonCode,
        now,
      ),
    changesAssertion(db, 'WON_PREMIUM_CORRECTION_INVALID'),
  ];
  for (const item of result.links) {
    const old = snapshot.links.find((link) => link.id === item.supersededLinkId)!;
    statements.push(
      db
        .prepare(
          `INSERT INTO renewal_won_policy_premium_correction_links
           (id,agency_id,operation_id,old_link_id,new_link_id,renewal_id,policy_id,
            allocated_premium_minor,currency,different_policyholder_reason_code)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          active.agencyId,
          operationId,
          item.supersededLinkId,
          item.newLinkId,
          item.renewalId,
          policyId,
          item.allocatedPremiumMinor,
          policy.currency,
          old.different_policyholder_reason_code,
        ),
      changesAssertion(db, 'WON_PREMIUM_CORRECTION_LINK_PLAN_INVALID'),
      db
        .prepare(
          `UPDATE renewal_policy_links
           SET status='SUPERSEDED',superseded_at=?,superseded_by_membership_id=?,
               supersede_reason_code='WON_PREMIUM_CORRECTED',superseded_operation_id=?
           WHERE agency_id=? AND id=? AND status='ACTIVE' AND new_policy_id=?`,
        )
        .bind(now, active.id, operationId, active.agencyId, item.supersededLinkId, policyId),
      changesAssertion(db, 'WON_POLICY_ALLOCATION_SET_CHANGED'),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE policies SET gross_premium_minor=?,version=version+1,updated_at=?
         WHERE agency_id=? AND id=? AND version=? AND gross_premium_minor=? AND currency=? AND status='ACTIVE'`,
      )
      .bind(
        input.correctedPremiumMinor,
        now,
        active.agencyId,
        policyId,
        input.expectedPolicyVersion,
        policy.gross_premium_minor,
        policy.currency,
      ),
    changesAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
  );
  for (const item of result.links) {
    const old = snapshot.links.find((link) => link.id === item.supersededLinkId)!;
    statements.push(
      db
        .prepare(
          `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,supersedes_link_id,
            allocation_operation_id,different_policyholder_reason_code,created_by_membership_id,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          item.newLinkId,
          active.agencyId,
          item.renewalId,
          policyId,
          item.allocatedPremiumMinor,
          policy.currency,
          item.supersededLinkId,
          operationId,
          old.different_policyholder_reason_code,
          active.id,
          now,
        ),
      changesAssertion(db, 'WON_PREMIUM_CORRECTION_LINK_PLAN_INVALID'),
    );
  }
  const expectedLinkIds = result.links.map((link) => link.newLinkId);
  const checks = expectedLinkIds.map(
    () =>
      "EXISTS(SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=? AND l.id=? AND l.status='ACTIVE' AND l.new_policy_id=?)",
  );
  statements.push(
    casAssertion(
      db,
      'WON_PREMIUM_CORRECTION_INCOMPLETE',
      `(SELECT COALESCE(sum(l.allocated_new_premium_minor),0) FROM renewal_policy_links l
        WHERE l.agency_id='${active.agencyId}' AND l.new_policy_id='${policyId}' AND l.status='ACTIVE')=${input.correctedPremiumMinor}
       AND (SELECT count(*) FROM renewal_won_policy_premium_correction_links map
        WHERE map.agency_id='${active.agencyId}' AND map.operation_id='${operationId}')=${result.links.length}
       AND (SELECT count(*) FROM renewal_policy_links old_link
        WHERE old_link.agency_id='${active.agencyId}' AND old_link.new_policy_id='${policyId}'
          AND old_link.superseded_operation_id='${operationId}' AND old_link.status='SUPERSEDED')=${result.links.length}
       AND ${checks.join(' AND ')}`,
      expectedLinkIds.flatMap((linkId) => [active.agencyId, linkId, policyId]),
    ),
    db
      .prepare(
        `INSERT INTO audit_events
         (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,
          idempotency_key,outcome,metadata_json,created_at)
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
      ),
    changesAssertion(db, 'WON_PREMIUM_CORRECTION_AUDIT_FAILED'),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/MEMBERSHIP_AUTHORIZED|SECURE_GRANT_INVALID/.test(message))
      throw new RenewalCommandError('FORBIDDEN', 403);
    if (
      /OPTIMISTIC_CONCURRENCY_CONFLICT|ALLOCATION_SET_CHANGED|LINK_PLAN|TOTAL_INVALID|NO_CHANGE/.test(
        message,
      )
    )
      throw new RenewalCommandError(message, 409);
    throw new RenewalCommandError('DATABASE_ERROR', 500);
  }
  return { data: result, replayed: false, status: 200 };
}
