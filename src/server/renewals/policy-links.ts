import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import { canonicalizeTargetIds, computeEvidenceHash } from '../mutations/grants';
import { RenewalCommandError } from './commands';
import {
  allocateRenewalPolicyLinksCommandSchema,
  allocateRenewalPolicyLinksGrantSchema,
  type AllocateRenewalPolicyLinksCommandInput,
  type AllocateRenewalPolicyLinksInput,
} from './validation';

const LINK_ACTION = 'renewal.policy_links.allocate';
const LINK_GRANT_ACTION = 'renewal.policy_links.allocate.grant';
const LINK_GRANT_AUDIT_ACTION = 'renewal.policy_links.grant_issued';
const OPEN_STATES = [
  'CONTACT_PENDING',
  'CONTACTED',
  'QUOTE_PREPARING',
  'QUOTE_SENT',
  'AWAITING_RESPONSE',
] as const;
const MAX_LINKS_PER_OPERATION = 20;
const MAX_PRIOR_LINKS_PER_OPERATION = 50;
const MAX_SECURE_GRANT_TTL_MS = 180_000;

type MembershipType = 'OWNER' | 'MEMBER';
type TargetKind = 'renewal' | 'policy' | 'customer';

interface ActiveMembership {
  readonly id: string;
  readonly agencyId: string;
  readonly type: MembershipType;
  readonly permissionVersion: number;
}

interface TargetRef {
  readonly kind: TargetKind;
  readonly id: string;
}

interface RenewalRow {
  readonly id: string;
  readonly agency_id: string;
  readonly version: number;
  readonly state: string;
  readonly closed_at: string | null;
  readonly expiring_policy_id: string;
  readonly renewal_assignee_membership_id: string | null;
  readonly old_customer_id: string;
  readonly old_policy_assignee_membership_id: string | null;
  readonly old_branch_id: string;
  readonly old_customer_assignee_membership_id: string | null;
  readonly old_customer_archived_at: string | null;
}

interface PolicyRow {
  readonly id: string;
  readonly agency_id: string;
  readonly customer_id: string;
  readonly version: number;
  readonly status: string;
  readonly archived_at: string | null;
  readonly currency: string;
  readonly gross_premium_minor: number;
  readonly assignee_membership_id: string | null;
  readonly branch_id: string;
  readonly data_classification: 'GENERAL' | 'HEALTH';
  readonly customer_assignee_membership_id: string | null;
  readonly customer_archived_at: string | null;
}

interface CustomerRow {
  readonly id: string;
  readonly agency_id: string;
  readonly assignee_membership_id: string | null;
  readonly archived_at: string | null;
}

interface PreviousLinkRow {
  readonly id: string;
  readonly agency_id: string;
  readonly renewal_id: string;
  readonly new_policy_id: string;
  readonly allocated_new_premium_minor: number;
  readonly currency: string;
  readonly allocation_operation_id: string;
  readonly different_policyholder_reason_code: string | null;
}

interface NormalizedLink {
  readonly renewalId: string;
  readonly expectedRenewalVersion: number;
  readonly newPolicyId: string;
  readonly expectedPolicyVersion: number;
  readonly allocatedNewPremiumMinor: number;
  readonly currency: string;
  readonly differentPolicyholderReasonCode: string | null;
}

interface GroupSnapshot {
  readonly agencyId: string;
  readonly membership: ActiveMembership;
  readonly links: readonly NormalizedLink[];
  readonly renewals: ReadonlyMap<string, RenewalRow>;
  readonly policies: ReadonlyMap<string, PolicyRow>;
  readonly customers: ReadonlyMap<string, CustomerRow>;
  readonly previousLinks: readonly PreviousLinkRow[];
  readonly targets: readonly TargetRef[];
  readonly targetIdsJson: string;
  readonly ownerRequired: boolean;
  readonly reasonCode: string;
}

interface ReceiptRow {
  readonly id: string;
  readonly agency_id: string;
  readonly actor_user_id: string;
  readonly actor_membership_id: string;
  readonly action: string;
  readonly idempotency_key: string;
  readonly payload_fingerprint: string;
  readonly status: string;
  readonly response_status: number | null;
  readonly response_body: string | null;
}

interface GrantRow {
  readonly id: string;
  readonly evidence_hash: string;
  readonly agency_id: string;
  readonly actor_user_id: string;
  readonly actor_membership_id: string;
  readonly action: string;
  readonly payload_hash: string;
  readonly target_ids_json: string;
  readonly expected_target_version: number | null;
  readonly permission_version: number;
  readonly assurance: string;
  readonly status: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
}

interface AllocationLinkResult {
  readonly id: string;
  readonly renewalId: string;
  readonly newPolicyId: string;
  readonly allocatedNewPremiumMinor: number;
  readonly currency: string;
  readonly differentPolicyholderReasonCode: string | null;
}

interface AllocationResult {
  readonly operationId: string;
  readonly reasonCode: string;
  readonly ownerRequired: boolean;
  readonly authorizedTargets: readonly TargetRef[];
  readonly links: readonly AllocationLinkResult[];
  readonly supersededLinkIds: readonly string[];
}

function forbidden(code = 'FORBIDDEN'): RenewalCommandError {
  return new RenewalCommandError(code, 403);
}

function notFound(): RenewalCommandError {
  return new RenewalCommandError('RENEWAL_OR_POLICY_NOT_FOUND', 404);
}

function conflict(code = 'RENEWAL_POLICY_LINK_CONFLICT'): RenewalCommandError {
  return new RenewalCommandError(code, 409);
}

function requireSecureContext(context: AuthenticatedUserContext): void {
  if (context.assurance !== 'SECURE') throw forbidden('SECURE_ASSURANCE_REQUIRED');
  if (
    typeof context.userId !== 'string' ||
    context.userId.length === 0 ||
    typeof context.identityId !== 'string' ||
    context.identityId.length === 0
  ) {
    throw forbidden('AUTHENTICATED_IDENTITY_REQUIRED');
  }
}

function membershipForAgency(
  context: AuthenticatedUserContext,
  agencyId: string,
): ActiveMembership {
  const matching = (context.memberships ?? []).filter(
    (membership) => membership.agencyId === agencyId && membership.status === 'ACTIVE',
  );
  if (matching.length !== 1) throw notFound();
  const membership = matching[0];
  if (!membership) throw notFound();
  if (
    (membership.type !== 'OWNER' && membership.type !== 'MEMBER') ||
    !Number.isSafeInteger(membership.permissionVersion) ||
    membership.permissionVersion < 1
  ) {
    throw forbidden('CORRUPT_MEMBERSHIP_DATA');
  }
  return {
    id: membership.id,
    agencyId,
    type: membership.type,
    permissionVersion: membership.permissionVersion,
  };
}

function normalizeLinks(links: AllocateRenewalPolicyLinksInput['links']): NormalizedLink[] {
  return links
    .map((link) => ({
      renewalId: link.renewalId,
      expectedRenewalVersion: link.expectedRenewalVersion,
      newPolicyId: link.newPolicyId,
      expectedPolicyVersion: link.expectedPolicyVersion,
      allocatedNewPremiumMinor: link.allocatedNewPremiumMinor,
      currency: link.currency,
      differentPolicyholderReasonCode: link.differentPolicyholderReasonCode ?? null,
    }))
    .sort(
      (left, right) =>
        left.renewalId.localeCompare(right.renewalId) ||
        left.newPolicyId.localeCompare(right.newPolicyId),
    );
}

function targetKey(target: TargetRef): string {
  return `${target.kind}\u0000${target.id}`;
}

function sortedTargets(targets: readonly TargetRef[]): TargetRef[] {
  const unique = new Map<string, TargetRef>();
  for (const target of targets) unique.set(targetKey(target), target);
  return [...unique.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

function targetIdsJson(targets: readonly TargetRef[]): string {
  const ids = targets.map((target) => target.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new RenewalCommandError('TARGET_KIND_COLLISION', 400);
  try {
    return canonicalizeTargetIds(ids);
  } catch {
    throw new RenewalCommandError('INVALID_TARGET_SET', 400);
  }
}

async function deriveGrantEvidenceToken(
  grantSecret: string,
  binding: Readonly<Record<string, unknown>>,
): Promise<string> {
  if (grantSecret.length < 32) throw new RenewalCommandError('GRANT_KEY_UNAVAILABLE', 500);
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
      info: encoder.encode('renewal-policy-links/grant-evidence'),
    },
    masterKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const payloadHash = await computePayloadHash(binding);
  const signed = await crypto.subtle.sign(
    'HMAC',
    evidenceKey,
    encoder.encode(`grant-evidence-v1\u0000${payloadHash}`),
  );
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function mapLinkBatchError(error: unknown): never {
  const message = String(error instanceof Error ? error.message : error).toUpperCase();
  if (
    message.includes('FINAL_AUTHORITY_RECHECK_FAILED') ||
    message.includes('MEMBERSHIP_PERMISSION_NOT_FOUND') ||
    message.includes('SENSITIVE_ACTION_GRANT_INVALID') ||
    message.includes('SENSITIVE_GRANT_CONSUMPTION_FAILED')
  ) {
    throw forbidden('FORBIDDEN');
  }
  if (
    message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT') ||
    message.includes('RENEWAL_STATE_CONFLICT') ||
    message.includes('RENEWAL_POLICY_LINK_ALLOCATION_OVERFLOW') ||
    message.includes('RENEWAL_POLICY_LINK_TARGET_INVALID') ||
    message.includes('RENEWAL_POLICY_LINK_CYCLE') ||
    message.includes('RENEWAL_POLICY_LINK_SUPERSESSION_INVALID') ||
    message.includes('RENEWAL_WON_POLICY_LINK_LOCKED') ||
    message.includes('RENEWAL_WON_ALLOCATION_INCOMPLETE')
  ) {
    throw conflict();
  }
  if (
    message.includes('OPERATION_RECEIPTS') ||
    message.includes('IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN')
  ) {
    throw conflict('IDEMPOTENCY_KEY_REUSED');
  }
  throw error;
}

async function readReceipt(
  db: D1Database,
  agencyId: string,
  userId: string,
  membershipId: string,
  action: string,
  idempotencyKey: string,
): Promise<ReceiptRow | null> {
  return db
    .prepare(
      `SELECT id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
              payload_fingerprint,status,response_status,response_body
       FROM operation_receipts
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=?
         AND action=? AND idempotency_key=?`,
    )
    .bind(agencyId, userId, membershipId, action, idempotencyKey)
    .first<ReceiptRow>();
}

async function readReceiptForKey(
  db: D1Database,
  agencyId: string,
  userId: string,
  membershipId: string,
  idempotencyKey: string,
): Promise<ReceiptRow | null> {
  return db
    .prepare(
      `SELECT id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
              payload_fingerprint,status,response_status,response_body
       FROM operation_receipts
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
    )
    .bind(agencyId, userId, membershipId, idempotencyKey)
    .first<ReceiptRow>();
}

async function assertKeyActionAvailable(
  db: D1Database,
  agencyId: string,
  userId: string,
  membershipId: string,
  action: string,
  idempotencyKey: string,
): Promise<void> {
  const existing = await readReceiptForKey(db, agencyId, userId, membershipId, idempotencyKey);
  if (existing && existing.action !== action) throw conflict('IDEMPOTENCY_KEY_REUSED');
}

async function readAgencyForRenewal(db: D1Database, renewalId: string): Promise<string> {
  const row = await db
    .prepare('SELECT agency_id FROM renewal_opportunities WHERE id=?')
    .bind(renewalId)
    .first<{ agency_id: unknown }>();
  if (!row || typeof row.agency_id !== 'string' || row.agency_id.trim().length === 0) {
    throw notFound();
  }
  return row.agency_id;
}

async function loadRenewal(
  db: D1Database,
  agencyId: string,
  renewalId: string,
): Promise<RenewalRow | null> {
  return db
    .prepare(
      `SELECT r.id,r.agency_id,r.version,r.state,r.closed_at,r.expiring_policy_id,
              r.assignee_membership_id AS renewal_assignee_membership_id,
              old_policy.customer_id AS old_customer_id,
              old_policy.assignee_membership_id AS old_policy_assignee_membership_id,
              old_policy.branch_id AS old_branch_id,
              old_customer.assignee_membership_id AS old_customer_assignee_membership_id,
              old_customer.archived_at AS old_customer_archived_at
       FROM renewal_opportunities r
       JOIN policies old_policy ON old_policy.agency_id=r.agency_id AND old_policy.id=r.expiring_policy_id
       JOIN customers old_customer ON old_customer.agency_id=old_policy.agency_id
          AND old_customer.id=old_policy.customer_id
       WHERE r.agency_id=? AND r.id=?`,
    )
    .bind(agencyId, renewalId)
    .first<RenewalRow>();
}

async function loadPreviousLinks(
  db: D1Database,
  agencyId: string,
  renewalIds: readonly string[],
): Promise<PreviousLinkRow[]> {
  if (renewalIds.length === 0) return [];
  const placeholders = renewalIds.map(() => '?').join(',');
  const result = await db
    .prepare(
      `SELECT id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
              allocation_operation_id,different_policyholder_reason_code
       FROM renewal_policy_links
       WHERE agency_id=? AND status='ACTIVE' AND renewal_id IN (${placeholders})
       ORDER BY renewal_id,new_policy_id,id`,
    )
    .bind(agencyId, ...renewalIds)
    .all<PreviousLinkRow>();
  if (!result.success) throw new RenewalCommandError('DATABASE_ERROR', 500);
  return result.results;
}

async function loadPolicy(
  db: D1Database,
  agencyId: string,
  policyId: string,
): Promise<PolicyRow | null> {
  return db
    .prepare(
      `SELECT p.id,p.agency_id,p.customer_id,p.version,p.status,p.archived_at,p.currency,
              p.gross_premium_minor,p.assignee_membership_id,p.branch_id,
              b.data_classification,c.assignee_membership_id AS customer_assignee_membership_id,
              c.archived_at AS customer_archived_at
       FROM policies p
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       WHERE p.agency_id=? AND p.id=?`,
    )
    .bind(agencyId, policyId)
    .first<PolicyRow>();
}

async function loadCustomer(
  db: D1Database,
  agencyId: string,
  customerId: string,
): Promise<CustomerRow | null> {
  return db
    .prepare(
      'SELECT id,agency_id,assignee_membership_id,archived_at FROM customers WHERE agency_id=? AND id=?',
    )
    .bind(agencyId, customerId)
    .first<CustomerRow>();
}

async function authorizeGroupTargets(
  db: D1Database,
  context: AuthenticatedUserContext,
  snapshot: GroupSnapshot,
): Promise<void> {
  for (const renewal of snapshot.renewals.values()) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: 'renewal.update',
      resource: {
        agencyId: renewal.agency_id,
        renewalAssigneeMembershipId: renewal.renewal_assignee_membership_id,
        customerAssigneeMembershipId: renewal.old_customer_assignee_membership_id,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY') {
      throw forbidden(decision.code);
    }
  }
  for (const customer of snapshot.customers.values()) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: 'customer.read',
      resource: {
        agencyId: customer.agency_id,
        assigneeMembershipId: customer.assignee_membership_id,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY') {
      throw forbidden(decision.code);
    }
  }
  for (const policy of snapshot.policies.values()) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: policy.data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
      resource: {
        agencyId: policy.agency_id,
        assigneeMembershipId: policy.assignee_membership_id,
        customerAssigneeMembershipId: policy.customer_assignee_membership_id,
        branchId: policy.branch_id,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY') {
      throw forbidden(decision.code);
    }
  }
  if (snapshot.ownerRequired && snapshot.membership.type !== 'OWNER') {
    throw forbidden('OWNER_REVIEW_REQUIRED');
  }
}

function validateFreshGroupSnapshot(snapshot: GroupSnapshot): void {
  if (snapshot.previousLinks.length > MAX_PRIOR_LINKS_PER_OPERATION) {
    throw new RenewalCommandError('TOO_MANY_POLICY_LINKS', 409);
  }
  if ([...snapshot.customers.values()].some((customer) => customer.archived_at !== null)) {
    throw conflict('CUSTOMER_NOT_ACTIVE');
  }
  for (const link of snapshot.links) {
    const renewal = snapshot.renewals.get(link.renewalId);
    const policy = snapshot.policies.get(link.newPolicyId);
    if (!renewal || !policy) throw notFound();
    if (
      renewal.version !== link.expectedRenewalVersion ||
      !OPEN_STATES.includes(renewal.state as (typeof OPEN_STATES)[number]) ||
      renewal.closed_at !== null
    ) {
      throw new RenewalCommandError(
        `RENEWAL_STATE_CONFLICT:${JSON.stringify({
          renewalId: renewal.id,
          actualVersion: renewal.version,
          expectedVersion: link.expectedRenewalVersion,
          actualState: renewal.state,
          closedAt: renewal.closed_at,
        })}`,
        409,
      );
    }
    if (policy.version !== link.expectedPolicyVersion) throw conflict('POLICY_VERSION_CONFLICT');
    if (policy.status !== 'ACTIVE' || policy.archived_at !== null) {
      throw conflict('POLICY_NOT_ACTIVE');
    }
    if (policy.currency !== link.currency) throw conflict('POLICY_CURRENCY_MISMATCH');
    const renewalCustomer = snapshot.customers.get(renewal.old_customer_id);
    const newPolicyCustomer = snapshot.customers.get(policy.customer_id);
    if (
      !renewalCustomer ||
      !newPolicyCustomer ||
      renewalCustomer.archived_at !== null ||
      newPolicyCustomer.archived_at !== null
    ) {
      throw conflict('CUSTOMER_NOT_ACTIVE');
    }
    const differentCustomer = renewal.old_customer_id !== policy.customer_id;
    if (differentCustomer && !link.differentPolicyholderReasonCode) {
      throw new RenewalCommandError('POLICYHOLDER_REASON_REQUIRED', 400);
    }
    if (!differentCustomer && link.differentPolicyholderReasonCode !== null) {
      throw new RenewalCommandError('UNEXPECTED_POLICYHOLDER_REASON', 400);
    }
  }
}

async function loadGroupSnapshot(
  db: D1Database,
  context: AuthenticatedUserContext,
  input: AllocateRenewalPolicyLinksInput,
): Promise<GroupSnapshot> {
  requireSecureContext(context);
  const links = normalizeLinks(input.links);
  if (links.length > MAX_LINKS_PER_OPERATION) {
    throw new RenewalCommandError('TOO_MANY_POLICY_LINKS', 400);
  }
  const firstLink = links[0];
  if (!firstLink) throw new RenewalCommandError('VALIDATION_ERROR', 400);
  const agencyId = await readAgencyForRenewal(db, firstLink.renewalId);
  const membership = membershipForAgency(context, agencyId);
  const renewalIds = [...new Set(links.map((link) => link.renewalId))].sort();
  const renewalRows = await Promise.all(
    renewalIds.map((renewalId) => loadRenewal(db, agencyId, renewalId)),
  );
  if (renewalRows.some((row) => row === null)) throw notFound();
  const renewals = new Map(
    renewalRows.filter((row): row is RenewalRow => row !== null).map((row) => [row.id, row]),
  );
  const otherAgency = [...renewals.values()].some((row) => row.agency_id !== agencyId);
  if (otherAgency) throw notFound();

  const previousLinks = await loadPreviousLinks(db, agencyId, renewalIds);
  const policyIds = [
    ...new Set([
      ...[...renewals.values()].map((row) => row.expiring_policy_id),
      ...links.map((link) => link.newPolicyId),
      ...previousLinks.map((link) => link.new_policy_id),
    ]),
  ].sort();
  const policyRows = await Promise.all(
    policyIds.map((policyId) => loadPolicy(db, agencyId, policyId)),
  );
  if (policyRows.some((row) => row === null)) throw notFound();
  const policies = new Map(
    policyRows.filter((row): row is PolicyRow => row !== null).map((row) => [row.id, row]),
  );
  const customerIds = [
    ...new Set([...policies.values()].map((policy) => policy.customer_id)),
  ].sort();
  const customerRows = await Promise.all(
    customerIds.map((customerId) => loadCustomer(db, agencyId, customerId)),
  );
  if (customerRows.some((row) => row === null)) throw notFound();
  const customers = new Map(
    customerRows.filter((row): row is CustomerRow => row !== null).map((row) => [row.id, row]),
  );

  let ownerRequired = false;
  for (const link of links) {
    const renewal = renewals.get(link.renewalId);
    const policy = policies.get(link.newPolicyId);
    if (!renewal || !policy) throw notFound();
    if (renewal.agency_id !== agencyId || policy.agency_id !== agencyId) throw notFound();
    if (
      renewal.old_customer_id !== policy.customer_id ||
      link.differentPolicyholderReasonCode !== null
    ) {
      ownerRequired = true;
    }
  }
  for (const previous of previousLinks) {
    if (previous.different_policyholder_reason_code !== null) ownerRequired = true;
    const renewal = renewals.get(previous.renewal_id);
    const sourcePolicy = renewal ? policies.get(renewal.expiring_policy_id) : null;
    const linkedPolicy = policies.get(previous.new_policy_id);
    if (!sourcePolicy || !linkedPolicy || sourcePolicy.customer_id !== linkedPolicy.customer_id) {
      ownerRequired = true;
    }
  }

  const targets = sortedTargets([
    ...renewalIds.map((id): TargetRef => ({ kind: 'renewal', id })),
    ...policyIds.map((id): TargetRef => ({ kind: 'policy', id })),
    ...customerIds.map((id): TargetRef => ({ kind: 'customer', id })),
  ]);
  const targetIds = targetIdsJson(targets);
  return {
    agencyId,
    membership,
    links,
    renewals,
    policies,
    customers,
    previousLinks,
    targets,
    targetIdsJson: targetIds,
    ownerRequired,
    reasonCode: input.reasonCode,
  };
}

function grantPayload(snapshot: GroupSnapshot): Record<string, unknown> {
  return {
    reasonCode: snapshot.reasonCode,
    links: snapshot.links,
    previousLinks: snapshot.previousLinks.map((link) => ({
      id: link.id,
      renewalId: link.renewal_id,
      newPolicyId: link.new_policy_id,
      allocatedNewPremiumMinor: link.allocated_new_premium_minor,
      currency: link.currency,
      allocationOperationId: link.allocation_operation_id,
      differentPolicyholderReasonCode: link.different_policyholder_reason_code,
    })),
    authorizedTargets: snapshot.targets,
    ownerRequired: snapshot.ownerRequired,
  };
}

function operationFingerprint(
  agencyId: string,
  input: AllocateRenewalPolicyLinksInput,
): Promise<string> {
  return computePayloadHash({
    action: LINK_ACTION,
    agencyId,
    reasonCode: input.reasonCode,
    links: normalizeLinks(input.links),
  });
}

function grantRequestFingerprint(
  agencyId: string,
  input: AllocateRenewalPolicyLinksInput,
): Promise<string> {
  return computePayloadHash({
    action: LINK_GRANT_ACTION,
    agencyId,
    reasonCode: input.reasonCode,
    links: normalizeLinks(input.links),
  });
}

function auditInsert(
  db: D1Database,
  input: {
    agencyId: string;
    actorUserId: string;
    actorMembershipId: string;
    action: string;
    targetType: string;
    targetId: string;
    idempotencyKey: string;
    createdAt: string;
    reasonCode: string;
    changedCount: number;
  },
): D1PreparedStatement {
  const record = buildSafeAuditRecord({
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId: input.targetId,
    idempotencyKey: input.idempotencyKey,
    outcome: 'SUCCESS',
    createdAt: input.createdAt,
    metadata: {
      reasonCode: input.reasonCode,
      referenceId: input.targetId,
      changedFieldCount: input.changedCount,
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
      record.id,
      record.agencyId,
      record.actorUserId,
      record.actorMembershipId,
      record.action,
      record.targetType,
      record.targetId,
      record.correlationId,
      record.idempotencyKey,
      record.outcome,
      record.metadataJson,
      record.createdAt,
    );
}

async function permissionSetSnapshot(db: D1Database, membershipId: string): Promise<string> {
  const result = await db
    .prepare(
      `SELECT permission_code,scope FROM membership_permissions
       WHERE membership_id=? ORDER BY permission_code,scope`,
    )
    .bind(membershipId)
    .all<{ permission_code: unknown; scope: unknown }>();
  if (!result.success) throw new RenewalCommandError('DATABASE_ERROR', 500);
  const rows: Array<[string, string]> = [];
  for (const row of result.results) {
    const permissionCode = row?.permission_code;
    const scope = row?.scope;
    if (typeof permissionCode !== 'string' || typeof scope !== 'string') {
      throw forbidden('MEMBERSHIP_PERMISSION_SET_INVALID');
    }
    rows.push([permissionCode, scope]);
  }
  return JSON.stringify(rows);
}

async function authorizeWithStablePermissionSet(
  db: D1Database,
  membershipId: string,
  authorize: () => Promise<void>,
): Promise<string> {
  const before = await permissionSetSnapshot(db, membershipId);
  await authorize();
  const after = await permissionSetSnapshot(db, membershipId);
  if (before !== after) throw forbidden('MEMBERSHIP_PERMISSION_SET_CHANGED');
  return after;
}

function liveAuthorityPredicate(
  context: AuthenticatedUserContext,
  membership: ActiveMembership,
  targets: readonly TargetRef[],
  ownerRequired: boolean,
  permissionSet: string,
): { sql: string; bindings: unknown[] } {
  const targetExists = targets
    .map((target) => {
      const table =
        target.kind === 'renewal'
          ? 'renewal_opportunities'
          : target.kind === 'policy'
            ? 'policies'
            : 'customers';
      return `AND EXISTS(SELECT 1 FROM ${table} current_target WHERE current_target.agency_id=m.agency_id AND current_target.id=?)`;
    })
    .join('\n');
  const policyIds = targets.filter((target) => target.kind === 'policy').map((target) => target.id);
  const healthPredicate =
    policyIds.length === 0
      ? ''
      : `AND (
          NOT EXISTS (
            SELECT 1 FROM policies hp
            JOIN insurance_branches hb ON hb.agency_id=hp.agency_id AND hb.id=hp.branch_id
            WHERE hp.agency_id=m.agency_id AND hp.id IN (${policyIds.map(() => '?').join(',')})
              AND hb.data_classification='HEALTH'
          )
          OR EXISTS (
            SELECT 1 FROM membership_permissions sensitive
            WHERE sensitive.membership_id=m.id AND sensitive.permission_code='sensitive.health.read'
              AND sensitive.scope='UNSCOPED'
          )
        )`;
  const sql = `SELECT 1 FROM agency_memberships m
    JOIN users u ON u.id=m.user_id
    JOIN agencies a ON a.id=m.agency_id
    JOIN auth_identities ai ON ai.user_id=u.id
    WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.type=? AND m.status='ACTIVE'
      AND m.permission_version=? AND u.status='ACTIVE' AND a.status='ACTIVE'
      AND ai.id=? AND ai.status='ACTIVE'
      AND (?=0 OR m.type='OWNER')
      AND (m.type='OWNER' OR (
        EXISTS(SELECT 1 FROM membership_permissions pu WHERE pu.membership_id=m.id AND pu.permission_code='renewal.update' AND pu.scope='AGENCY')
        AND EXISTS(SELECT 1 FROM membership_permissions pr WHERE pr.membership_id=m.id AND pr.permission_code='renewal.read' AND pr.scope='AGENCY')
        AND EXISTS(SELECT 1 FROM membership_permissions pp WHERE pp.membership_id=m.id AND pp.permission_code='policy.read' AND pp.scope='AGENCY')
        AND EXISTS(SELECT 1 FROM membership_permissions pc WHERE pc.membership_id=m.id AND pc.permission_code='customer.read' AND pc.scope='AGENCY')
      ))
      AND COALESCE((
        SELECT json_group_array(json_array(gr.permission_code,gr.scope))
        FROM (
          SELECT permission_code,scope FROM membership_permissions
          WHERE membership_id=m.id ORDER BY permission_code,scope
        ) gr
      ),'[]')=?
      ${healthPredicate}
      ${targetExists}`;
  return {
    sql,
    bindings: [
      membership.id,
      membership.agencyId,
      context.userId,
      membership.type,
      membership.permissionVersion,
      context.identityId,
      ownerRequired ? 1 : 0,
      permissionSet,
      ...policyIds,
      ...targets.map((target) => target.id),
    ],
  };
}

function liveAuthorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembership,
  targets: readonly TargetRef[],
  ownerRequired: boolean,
  permissionSet: string,
): D1PreparedStatement {
  const predicate = liveAuthorityPredicate(
    context,
    membership,
    targets,
    ownerRequired,
    permissionSet,
  );
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(${predicate.sql}) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(crypto.randomUUID(), ...predicate.bindings);
}

function groupCasStatements(db: D1Database, snapshot: GroupSnapshot): D1PreparedStatement[] {
  const renewalEntries = [...snapshot.renewals.values()];
  const renewalRowsCheck = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN count(*)=? THEN 1 ELSE 0 END,'RENEWAL_STATE_CONFLICT'
       FROM renewal_opportunities r
       WHERE r.agency_id=? AND r.state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
         AND r.closed_at IS NULL AND (${renewalEntries.map(() => '(r.id=? AND r.version=?)').join(' OR ')})`,
    )
    .bind(
      crypto.randomUUID(),
      renewalEntries.length,
      snapshot.agencyId,
      ...renewalEntries.flatMap((row) => [row.id, row.version]),
    );
  const policyTargets = snapshot.links.map((link) => snapshot.policies.get(link.newPolicyId)!);
  const uniquePolicies = [...new Map(policyTargets.map((row) => [row.id, row])).values()];
  const policiesCheck = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN count(*)=? THEN 1 ELSE 0 END,'POLICY_VERSION_CONFLICT'
       FROM policies p
       WHERE p.agency_id=? AND p.status='ACTIVE' AND p.archived_at IS NULL
         AND (${uniquePolicies.map(() => '(p.id=? AND p.version=?)').join(' OR ')})`,
    )
    .bind(
      crypto.randomUUID(),
      uniquePolicies.length,
      snapshot.agencyId,
      ...uniquePolicies.flatMap((row) => [row.id, row.version]),
    );
  const renewalIdPlaceholders = renewalEntries.map(() => '?').join(',');
  const expectedLinkPredicate = snapshot.previousLinks.length
    ? snapshot.previousLinks
        .map(
          () =>
            `(l.id=? AND l.renewal_id=? AND l.new_policy_id=? AND l.allocated_new_premium_minor=? AND l.currency=? AND l.allocation_operation_id=?)`,
        )
        .join(' OR ')
    : '0';
  const linksCheck = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN
         (SELECT count(*) FROM renewal_policy_links l WHERE l.agency_id=? AND l.status='ACTIVE'
           AND l.renewal_id IN (${renewalIdPlaceholders}))=?
         AND NOT EXISTS (
           SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=? AND l.status='ACTIVE'
             AND l.renewal_id IN (${renewalIdPlaceholders}) AND NOT (${expectedLinkPredicate})
         )
       THEN 1 ELSE 0 END,'RENEWAL_POLICY_LINK_CONFLICT'`,
    )
    .bind(
      crypto.randomUUID(),
      snapshot.agencyId,
      ...renewalEntries.map((row) => row.id),
      snapshot.previousLinks.length,
      snapshot.agencyId,
      ...renewalEntries.map((row) => row.id),
      ...snapshot.previousLinks.flatMap((link) => [
        link.id,
        link.renewal_id,
        link.new_policy_id,
        link.allocated_new_premium_minor,
        link.currency,
        link.allocation_operation_id,
      ]),
    );
  const customerEntries = [...snapshot.customers.values()];
  const customersCheck = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN count(*)=? THEN 1 ELSE 0 END,'POLICY_LINK_PARENT_ARCHIVED'
       FROM customers c
       WHERE c.agency_id=? AND c.archived_at IS NULL
         AND c.id IN (${customerEntries.map(() => '?').join(',')})`,
    )
    .bind(
      crypto.randomUUID(),
      customerEntries.length,
      snapshot.agencyId,
      ...customerEntries.map((row) => row.id),
    );
  return [renewalRowsCheck, policiesCheck, linksCheck, customersCheck];
}

function requireIdempotencyKey(value: string): string {
  if (!value || value !== value.trim() || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new RenewalCommandError('VALIDATION_ERROR', 400);
  }
  return value;
}

function normalizeTargetRefs(raw: unknown): TargetRef[] {
  if (!Array.isArray(raw)) throw new RenewalCommandError('RECEIPT_INVALID', 404);
  const refs: TargetRef[] = [];
  const allowed = new Set<TargetKind>(['renewal', 'policy', 'customer']);
  for (const value of raw) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('kind' in value) ||
      !('id' in value)
    ) {
      throw new RenewalCommandError('RECEIPT_INVALID', 404);
    }
    const row = value as { kind: unknown; id: unknown };
    if (
      typeof row.kind !== 'string' ||
      !allowed.has(row.kind as TargetKind) ||
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      row.id !== row.id.trim()
    ) {
      throw new RenewalCommandError('RECEIPT_INVALID', 404);
    }
    refs.push({ kind: row.kind as TargetKind, id: row.id });
  }
  const sorted = sortedTargets(refs);
  if (sorted.length !== refs.length) throw new RenewalCommandError('RECEIPT_INVALID', 404);
  try {
    targetIdsJson(sorted);
  } catch {
    throw new RenewalCommandError('RECEIPT_INVALID', 404);
  }
  return sorted;
}

async function loadTargetsByRefs(
  db: D1Database,
  agencyId: string,
  refs: readonly TargetRef[],
): Promise<{
  renewals: Map<string, RenewalRow>;
  policies: Map<string, PolicyRow>;
  customers: Map<string, CustomerRow>;
}> {
  const renewals = new Map<string, RenewalRow>();
  const policies = new Map<string, PolicyRow>();
  const customers = new Map<string, CustomerRow>();
  for (const ref of refs) {
    if (ref.kind === 'renewal' && !renewals.has(ref.id)) {
      const row = await loadRenewal(db, agencyId, ref.id);
      if (!row || row.agency_id !== agencyId) throw notFound();
      renewals.set(ref.id, row);
    } else if (ref.kind === 'policy' && !policies.has(ref.id)) {
      const row = await loadPolicy(db, agencyId, ref.id);
      if (!row || row.agency_id !== agencyId) throw notFound();
      policies.set(ref.id, row);
    } else if (ref.kind === 'customer' && !customers.has(ref.id)) {
      const row = await loadCustomer(db, agencyId, ref.id);
      if (!row || row.agency_id !== agencyId) throw notFound();
      customers.set(ref.id, row);
    }
  }
  return { renewals, policies, customers };
}

async function authorizeTargetRows(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembership,
  refs: readonly TargetRef[],
  rows: Awaited<ReturnType<typeof loadTargetsByRefs>>,
  ownerRequired: boolean,
): Promise<void> {
  if (ownerRequired && membership.type !== 'OWNER') throw forbidden('OWNER_REVIEW_REQUIRED');
  for (const renewal of rows.renewals.values()) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: 'renewal.update',
      resource: {
        agencyId: renewal.agency_id,
        renewalAssigneeMembershipId: renewal.renewal_assignee_membership_id,
        customerAssigneeMembershipId: renewal.old_customer_assignee_membership_id,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY') {
      throw forbidden(decision.code);
    }
  }
  for (const customer of rows.customers.values()) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: 'customer.read',
      resource: {
        agencyId: customer.agency_id,
        assigneeMembershipId: customer.assignee_membership_id,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY') {
      throw forbidden(decision.code);
    }
  }
  for (const policy of rows.policies.values()) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: policy.data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
      resource: {
        agencyId: policy.agency_id,
        assigneeMembershipId: policy.assignee_membership_id,
        customerAssigneeMembershipId: policy.customer_assignee_membership_id,
        branchId: policy.branch_id,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY') {
      throw forbidden(decision.code);
    }
  }
  if (refs.length === 0) throw new RenewalCommandError('RECEIPT_INVALID', 404);
}

function grantIssuanceTimeAssertion(
  db: D1Database,
  issuedAt: string,
  expiresAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN
         ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND (julianday(?)-julianday(?))<=180.001/86400.0
       THEN 1 ELSE 0 END,'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
    )
    .bind(crypto.randomUUID(), issuedAt, expiresAt, expiresAt, issuedAt);
}

function operationReceiptStatement(
  db: D1Database,
  record: {
    readonly id: string;
    readonly agencyId: string;
    readonly actorUserId: string;
    readonly actorMembershipId: string;
    readonly action: string;
    readonly idempotencyKey: string;
    readonly payloadFingerprint: string;
    readonly responseBody: string;
    readonly createdAt: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operation_receipts
       (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
        status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',201,?,?,?)`,
    )
    .bind(
      record.id,
      record.agencyId,
      record.actorUserId,
      record.actorMembershipId,
      record.action,
      record.idempotencyKey,
      record.payloadFingerprint,
      record.responseBody,
      record.createdAt,
      record.createdAt,
    );
}

async function grantResultFromReceipt(
  receipt: ReceiptRow,
  expectedFingerprint: string,
  grantSecret: string,
): Promise<{
  readonly grantId: string;
  readonly grantEvidenceToken: string;
  readonly expiresAt: string;
  readonly payloadHash: string;
  readonly targetIdsJson: string;
  readonly targetRefs: TargetRef[];
  readonly ownerRequired: boolean;
}> {
  if (
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 201 ||
    receipt.payload_fingerprint !== expectedFingerprint ||
    !receipt.response_body
  ) {
    throw conflict('IDEMPOTENCY_CONFLICT');
  }
  let value: unknown;
  try {
    value = JSON.parse(receipt.response_body);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    'grantId',
    'expiresAt',
    'payloadHash',
    'targetIdsJson',
    'authorizedTargets',
    'ownerRequired',
    'permissionVersion',
  ].sort();
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (
    typeof row.grantId !== 'string' ||
    typeof row.expiresAt !== 'string' ||
    new Date(row.expiresAt).toISOString() !== row.expiresAt ||
    typeof row.payloadHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.payloadHash) ||
    typeof row.targetIdsJson !== 'string' ||
    typeof row.ownerRequired !== 'boolean' ||
    typeof row.permissionVersion !== 'number' ||
    !Number.isSafeInteger(row.permissionVersion) ||
    row.permissionVersion < 1
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const targetRefs = normalizeTargetRefs(row.authorizedTargets);
  if (JSON.stringify([...targetRefs.map((target) => target.id)].sort()) !== row.targetIdsJson) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const persistedData = {
    grantId: row.grantId,
    expiresAt: row.expiresAt,
    payloadHash: row.payloadHash,
    targetIdsJson: row.targetIdsJson,
    authorizedTargets: targetRefs,
    ownerRequired: row.ownerRequired,
    permissionVersion: row.permissionVersion,
  };
  if (receipt.response_body !== JSON.stringify(persistedData)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const grantEvidenceToken = await deriveGrantEvidenceToken(grantSecret, {
    purpose: 'renewal.policy_links.allocate',
    agencyId: receipt.agency_id,
    actorUserId: receipt.actor_user_id,
    actorMembershipId: receipt.actor_membership_id,
    action: LINK_ACTION,
    idempotencyKey: receipt.idempotency_key,
    expectedTargetVersion: null,
    ...persistedData,
  });
  return {
    grantId: row.grantId,
    grantEvidenceToken,
    expiresAt: row.expiresAt,
    payloadHash: row.payloadHash,
    targetIdsJson: row.targetIdsJson,
    targetRefs,
    ownerRequired: row.ownerRequired,
  };
}

function grantReplayProofStatement(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembership,
  targets: readonly TargetRef[],
  ownerRequired: boolean,
  permissionSet: string,
  grant: Awaited<ReturnType<typeof grantResultFromReceipt>>,
  evidenceHash: string,
  receipt: ReceiptRow,
  now: string,
): D1PreparedStatement {
  const authority = liveAuthorityPredicate(
    context,
    membership,
    targets,
    ownerRequired,
    permissionSet,
  );
  return db
    .prepare(
      `SELECT
         CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END AS authority_count,
         (SELECT count(*) FROM operation_receipts r
          WHERE r.id=? AND r.agency_id=? AND r.actor_user_id=? AND r.actor_membership_id=?
            AND r.action=? AND r.idempotency_key=? AND r.payload_fingerprint=?
            AND r.status='COMPLETED' AND r.response_status=201) AS receipt_count,
         (SELECT count(*) FROM sensitive_action_grants g
          WHERE g.id=? AND g.evidence_hash=? AND g.agency_id=? AND g.actor_user_id=?
            AND g.actor_membership_id=? AND g.action=? AND g.payload_hash=?
            AND g.target_ids_json=? AND g.expected_target_version IS NULL
            AND g.permission_version=? AND g.assurance='SECURE_GRANT'
            AND g.status='ISSUED' AND g.consumed_at IS NULL AND g.revoked_at IS NULL
            AND g.expires_at>?) AS grant_count,
         (SELECT count(*) FROM audit_events a
          WHERE a.agency_id=? AND a.actor_user_id=? AND a.actor_membership_id=?
            AND a.action=? AND a.target_type='renewal_policy_link_grant'
            AND a.target_id=? AND a.idempotency_key=? AND a.outcome='SUCCESS') AS audit_count`,
    )
    .bind(
      ...authority.bindings,
      receipt.id,
      receipt.agency_id,
      receipt.actor_user_id,
      receipt.actor_membership_id,
      receipt.action,
      receipt.idempotency_key,
      receipt.payload_fingerprint,
      grant.grantId,
      evidenceHash,
      membership.agencyId,
      context.userId,
      membership.id,
      LINK_ACTION,
      grant.payloadHash,
      grant.targetIdsJson,
      membership.permissionVersion,
      now,
      membership.agencyId,
      context.userId,
      membership.id,
      LINK_GRANT_AUDIT_ACTION,
      grant.grantId,
      receipt.idempotency_key,
    );
}

async function replayGrantReceipt(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembership,
  receipt: ReceiptRow,
  expectedFingerprint: string,
  grantSecret: string,
): Promise<{ data: Awaited<ReturnType<typeof grantResultFromReceipt>>; replayed: true }> {
  const grant = await grantResultFromReceipt(receipt, expectedFingerprint, grantSecret);
  if (
    receipt.agency_id !== membership.agencyId ||
    receipt.actor_user_id !== context.userId ||
    receipt.actor_membership_id !== membership.id ||
    receipt.action !== LINK_GRANT_ACTION
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const targets = await loadTargetsByRefs(db, membership.agencyId, grant.targetRefs);
  const permissionSet = await authorizeWithStablePermissionSet(db, membership.id, () =>
    authorizeTargetRows(db, context, membership, grant.targetRefs, targets, grant.ownerRequired),
  );
  const now = new Date().toISOString();
  const evidenceHash = await computeEvidenceHash(grant.grantEvidenceToken);
  const proofResult = await grantReplayProofStatement(
    db,
    context,
    membership,
    grant.targetRefs,
    grant.ownerRequired,
    permissionSet,
    grant,
    evidenceHash,
    receipt,
    now,
  ).first<{
    authority_count: number;
    receipt_count: number;
    grant_count: number;
    audit_count: number;
  }>();
  if (
    proofResult?.authority_count !== 1 ||
    proofResult.receipt_count !== 1 ||
    proofResult.grant_count !== 1 ||
    proofResult.audit_count !== 1
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return { data: grant, replayed: true };
}

export async function issueRenewalPolicyLinksGrant(
  context: AuthenticatedUserContext,
  db: D1Database,
  raw: unknown,
  rawIdempotencyKey: string,
  grantSecret: string,
  options: { readonly grantTtlMs?: number } = {},
): Promise<{ data: Awaited<ReturnType<typeof grantResultFromReceipt>>; replayed: boolean }> {
  requireSecureContext(context);
  if (typeof grantSecret !== 'string' || grantSecret.length < 32) {
    throw new RenewalCommandError('GRANT_KEY_UNAVAILABLE', 500);
  }
  const parsed = allocateRenewalPolicyLinksGrantSchema.parse(raw);
  const key = requireIdempotencyKey(rawIdempotencyKey);
  const firstLink = parsed.links[0];
  if (!firstLink) throw new RenewalCommandError('VALIDATION_ERROR', 400);
  const agencyId = await readAgencyForRenewal(db, firstLink.renewalId);
  const membership = membershipForAgency(context, agencyId);
  const fingerprint = await grantRequestFingerprint(agencyId, parsed);
  const oldReceipt = await readReceipt(
    db,
    agencyId,
    context.userId,
    membership.id,
    LINK_GRANT_ACTION,
    key,
  );
  if (oldReceipt) {
    if (oldReceipt.payload_fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
    const replay = await replayGrantReceipt(
      db,
      context,
      membership,
      oldReceipt,
      fingerprint,
      grantSecret,
    );
    return { data: replay.data, replayed: true };
  }
  await assertKeyActionAvailable(
    db,
    agencyId,
    context.userId,
    membership.id,
    LINK_GRANT_ACTION,
    key,
  );
  const snapshot = await loadGroupSnapshot(db, context, parsed);
  const permissionSet = await authorizeWithStablePermissionSet(db, membership.id, () =>
    authorizeGroupTargets(db, context, snapshot),
  );
  validateFreshGroupSnapshot(snapshot);
  const grantPayloadValue = grantPayload(snapshot);
  const payloadHash = await computePayloadHash(grantPayloadValue);
  const grantId = crypto.randomUUID();
  const receiptId = crypto.randomUUID();
  const now = new Date().toISOString();
  const grantTtlMs = options.grantTtlMs ?? MAX_SECURE_GRANT_TTL_MS;
  if (
    !Number.isSafeInteger(grantTtlMs) ||
    grantTtlMs <= 0 ||
    grantTtlMs > MAX_SECURE_GRANT_TTL_MS
  ) {
    throw new RenewalCommandError('INVALID_GRANT_TTL', 400);
  }
  const expiresAt = new Date(Date.parse(now) + grantTtlMs).toISOString();
  const grantData = {
    grantId,
    expiresAt,
    payloadHash,
    targetIdsJson: snapshot.targetIdsJson,
    authorizedTargets: snapshot.targets,
    ownerRequired: snapshot.ownerRequired,
    permissionVersion: membership.permissionVersion,
  };
  const evidenceToken = await deriveGrantEvidenceToken(grantSecret, {
    purpose: 'renewal.policy_links.allocate',
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: membership.id,
    action: LINK_ACTION,
    idempotencyKey: key,
    expectedTargetVersion: null,
    ...grantData,
  });
  const evidenceHash = await computeEvidenceHash(evidenceToken);
  const grantStatement = db
    .prepare(
      `INSERT INTO sensitive_action_grants
       (id,evidence_hash,agency_id,actor_user_id,actor_membership_id,action,payload_hash,target_ids_json,
        expected_target_version,permission_version,assurance,status,issued_at,expires_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?, ?,NULL,?,'SECURE_GRANT','ISSUED',?,?,?,?)`,
    )
    .bind(
      grantId,
      evidenceHash,
      agencyId,
      context.userId,
      membership.id,
      LINK_ACTION,
      payloadHash,
      snapshot.targetIdsJson,
      membership.permissionVersion,
      now,
      expiresAt,
      now,
      now,
    );
  const receiptStatement = operationReceiptStatement(db, {
    id: receiptId,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: membership.id,
    action: LINK_GRANT_ACTION,
    idempotencyKey: key,
    payloadFingerprint: fingerprint,
    responseBody: JSON.stringify(grantData),
    createdAt: now,
  });
  const audit = auditInsert(db, {
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: membership.id,
    action: LINK_GRANT_AUDIT_ACTION,
    targetType: 'renewal_policy_link_grant',
    targetId: grantId,
    idempotencyKey: key,
    createdAt: now,
    reasonCode: 'SECURE_GRANT_ISSUED',
    changedCount: snapshot.links.length,
  });
  try {
    await db.batch([
      liveAuthorityAssertion(
        db,
        context,
        membership,
        snapshot.targets,
        snapshot.ownerRequired,
        permissionSet,
      ),
      ...groupCasStatements(db, snapshot),
      grantIssuanceTimeAssertion(db, now, expiresAt),
      grantStatement,
      receiptStatement,
      audit,
    ]);
  } catch (error) {
    const raced = await readReceipt(
      db,
      agencyId,
      context.userId,
      membership.id,
      LINK_GRANT_ACTION,
      key,
    );
    if (raced) {
      if (raced.payload_fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
      const replay = await replayGrantReceipt(
        db,
        context,
        membership,
        raced,
        fingerprint,
        grantSecret,
      );
      return { data: replay.data, replayed: true };
    }
    const racedKey = await readReceiptForKey(db, agencyId, context.userId, membership.id, key);
    if (racedKey) {
      if (racedKey.action !== LINK_GRANT_ACTION) throw conflict('IDEMPOTENCY_KEY_REUSED');
      if (racedKey.payload_fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
      const replay = await replayGrantReceipt(
        db,
        context,
        membership,
        racedKey,
        fingerprint,
        grantSecret,
      );
      return { data: replay.data, replayed: true };
    }
    mapLinkBatchError(error);
  }
  const receipt: ReceiptRow = {
    id: receiptId,
    agency_id: agencyId,
    actor_user_id: context.userId,
    actor_membership_id: membership.id,
    action: LINK_GRANT_ACTION,
    idempotency_key: key,
    payload_fingerprint: fingerprint,
    status: 'COMPLETED',
    response_status: 201,
    response_body: JSON.stringify(grantData),
  };
  const result = await grantResultFromReceipt(receipt, fingerprint, grantSecret);
  return { data: result, replayed: false };
}

function buildAllocationResult(snapshot: GroupSnapshot, operationId: string): AllocationResult {
  const links = snapshot.links.map((link) => ({
    id: crypto.randomUUID(),
    renewalId: link.renewalId,
    newPolicyId: link.newPolicyId,
    allocatedNewPremiumMinor: link.allocatedNewPremiumMinor,
    currency: link.currency,
    differentPolicyholderReasonCode: link.differentPolicyholderReasonCode,
  }));
  return {
    operationId,
    reasonCode: snapshot.reasonCode,
    ownerRequired: snapshot.ownerRequired,
    authorizedTargets: snapshot.targets,
    links,
    supersededLinkIds: snapshot.previousLinks.map((link) => link.id).sort(),
  };
}

function activeLinkSetAssertion(
  db: D1Database,
  snapshot: GroupSnapshot,
  result: AllocationResult,
): D1PreparedStatement {
  const renewalIds = [...snapshot.renewals.keys()];
  const allowedPairs = result.links
    .map(() => '(l.renewal_id=? AND l.new_policy_id=?)')
    .join(' OR ');
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN
         (SELECT count(*) FROM renewal_policy_links l WHERE l.agency_id=? AND l.status='ACTIVE'
           AND l.renewal_id IN (${renewalIds.map(() => '?').join(',')}))=?
         AND NOT EXISTS (
           SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=? AND l.status='ACTIVE'
             AND l.renewal_id IN (${renewalIds.map(() => '?').join(',')})
             AND NOT (${allowedPairs})
         )
       THEN 1 ELSE 0 END,'RENEWAL_POLICY_LINK_CONFLICT'`,
    )
    .bind(
      crypto.randomUUID(),
      snapshot.agencyId,
      ...renewalIds,
      result.links.length,
      snapshot.agencyId,
      ...renewalIds,
      ...result.links.flatMap((link) => [link.renewalId, link.newPolicyId]),
    );
}

function consumeGrantStatement(
  db: D1Database,
  context: AuthenticatedUserContext,
  snapshot: GroupSnapshot,
  grant: GrantRow,
  evidenceHash: string,
  operationId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sensitive_action_grants
       SET status='CONSUMED',
           consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           consumed_operation_id=?,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=?
         AND action=? AND payload_hash=? AND target_ids_json=? AND expected_target_version IS NULL
         AND permission_version=? AND assurance='SECURE_GRANT' AND status='ISSUED'
         AND consumed_at IS NULL AND revoked_at IS NULL
         AND issued_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND (julianday(expires_at)-julianday(issued_at))<=180.001/86400.0`,
    )
    .bind(
      operationId,
      evidenceHash,
      snapshot.agencyId,
      context.userId,
      snapshot.membership.id,
      LINK_ACTION,
      grant.payload_hash,
      snapshot.targetIdsJson,
      snapshot.membership.permissionVersion,
    );
}

function consumeGrantCas(db: D1Database): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,changes(),'SENSITIVE_GRANT_CONSUMPTION_FAILED'`,
    )
    .bind(crypto.randomUUID());
}

async function readAllocationResult(
  db: D1Database,
  receipt: ReceiptRow,
  input: AllocateRenewalPolicyLinksInput,
  fingerprint: string,
): Promise<AllocationResult> {
  return allocationResultFromEffects(db, receipt, input, fingerprint);
}

export async function allocateRenewalPolicyLinks(
  context: AuthenticatedUserContext,
  db: D1Database,
  raw: unknown,
  rawIdempotencyKey: string,
): Promise<{ data: AllocationResult; status: 201; replayed: boolean }> {
  requireSecureContext(context);
  const parsed: AllocateRenewalPolicyLinksCommandInput =
    allocateRenewalPolicyLinksCommandSchema.parse(raw);
  const key = requireIdempotencyKey(rawIdempotencyKey);
  const firstLink = parsed.links[0];
  if (!firstLink) throw new RenewalCommandError('VALIDATION_ERROR', 400);
  const agencyId = await readAgencyForRenewal(db, firstLink.renewalId);
  const membership = membershipForAgency(context, agencyId);
  const operationInput: AllocateRenewalPolicyLinksInput = {
    reasonCode: parsed.reasonCode,
    links: parsed.links,
  };
  const fingerprint = await operationFingerprint(agencyId, operationInput);
  const oldReceipt = await readReceipt(
    db,
    agencyId,
    context.userId,
    membership.id,
    LINK_ACTION,
    key,
  );
  if (oldReceipt) {
    if (
      oldReceipt.agency_id !== agencyId ||
      oldReceipt.actor_user_id !== context.userId ||
      oldReceipt.actor_membership_id !== membership.id ||
      oldReceipt.action !== LINK_ACTION
    ) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    const result = await readAllocationResult(db, oldReceipt, operationInput, fingerprint);
    await assertAllocationReplay(db, context, membership, oldReceipt, result, key);
    return { data: result, status: 201, replayed: true };
  }

  await assertKeyActionAvailable(db, agencyId, context.userId, membership.id, LINK_ACTION, key);
  const snapshot = await loadGroupSnapshot(db, context, operationInput);
  const grantPayloadValue = grantPayload(snapshot);
  const grantPayloadHash = await computePayloadHash(grantPayloadValue);
  const secureGrantBinding = {
    evidence: parsed.grantEvidenceToken,
    payload: grantPayloadValue,
    targetIds: [...(JSON.parse(snapshot.targetIdsJson as string) as string[])],
    expectedTargetVersion: null,
  };
  let permissionSet: string;
  try {
    permissionSet = await authorizeWithStablePermissionSet(db, membership.id, async () => {
      await authorizeGroupTargets(db, context, snapshot);
      for (const renewal of snapshot.renewals.values()) {
        const authorization = await evaluateAuthorization(db, {
          context,
          action: LINK_ACTION,
          resource: {
            agencyId: renewal.agency_id,
            renewalAssigneeMembershipId: renewal.renewal_assignee_membership_id,
            customerAssigneeMembershipId: renewal.old_customer_assignee_membership_id,
          },
          secureGrantBinding,
        });
        if (authorization.decision !== 'ALLOW' || authorization.effectiveScope !== 'AGENCY') {
          throw forbidden(authorization.code);
        }
      }
    });
  } catch (error) {
    const racedReplay = await replayRacedAllocationReceipt(
      db,
      context,
      membership,
      operationInput,
      fingerprint,
      key,
    );
    if (racedReplay) return racedReplay;
    throw error;
  }
  validateFreshGroupSnapshot(snapshot);

  const grant = await readGrant(db, parsed.grantEvidenceToken);
  const now = new Date().toISOString();
  if (!grantMatchesSnapshot(grant, context, snapshot, grantPayloadHash, now)) {
    const racedReceipt = await readReceipt(
      db,
      agencyId,
      context.userId,
      membership.id,
      LINK_ACTION,
      key,
    );
    if (racedReceipt) {
      if (racedReceipt.payload_fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
      const replay = await readAllocationResult(db, racedReceipt, operationInput, fingerprint);
      await assertAllocationReplay(db, context, membership, racedReceipt, replay, key);
      return { data: replay, status: 201, replayed: true };
    }
    throw forbidden('SENSITIVE_ACTION_GRANT_INVALID');
  }

  const operationId = crypto.randomUUID();
  const result = buildAllocationResult(snapshot, operationId);
  const responseBody = JSON.stringify(result);
  const receipt = linkReceiptStatement(db, {
    id: operationId,
    agencyId,
    userId: context.userId,
    membershipId: membership.id,
    key,
    fingerprint,
    body: responseBody,
    now,
  });
  const updateRenewalRows: D1PreparedStatement[] = [];
  for (const renewal of snapshot.renewals.values()) {
    const requested = snapshot.links.find((link) => link.renewalId === renewal.id);
    if (!requested) throw new RenewalCommandError('VALIDATION_ERROR', 400);
    updateRenewalRows.push(
      db
        .prepare(
          `UPDATE renewal_opportunities SET version=version+1,updated_at=?
           WHERE agency_id=? AND id=? AND version=?
             AND state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
             AND closed_at IS NULL`,
        )
        .bind(now, agencyId, renewal.id, requested.expectedRenewalVersion),
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
           SELECT ?,1,changes(),'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
        )
        .bind(crypto.randomUUID()),
    );
  }

  try {
    await db.batch([
      liveAuthorityAssertion(
        db,
        context,
        membership,
        snapshot.targets,
        snapshot.ownerRequired,
        permissionSet,
      ),
      ...groupCasStatements(db, snapshot),
      consumeGrantStatement(db, context, snapshot, grant, grant.evidence_hash, operationId),
      consumeGrantCas(db),
      receipt,
      ...supersedePreviousLinks(db, snapshot, operationId, now),
      ...updateRenewalRows,
      ...createNewLinkStatements(db, snapshot, result, now),
      activeLinkSetAssertion(db, snapshot, result),
      auditInsert(db, {
        agencyId,
        actorUserId: context.userId,
        actorMembershipId: membership.id,
        action: LINK_ACTION,
        targetType: 'renewal_policy_link_batch',
        targetId: operationId,
        idempotencyKey: key,
        createdAt: now,
        reasonCode: snapshot.reasonCode,
        changedCount: result.links.length + result.supersededLinkIds.length,
      }),
    ]);
  } catch (error) {
    let raced: ReceiptRow | null = null;
    try {
      raced = await readReceipt(db, agencyId, context.userId, membership.id, LINK_ACTION, key);
    } catch {
      mapLinkBatchError(error);
    }
    if (raced) {
      if (raced.payload_fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
      const replay = await readAllocationResult(db, raced, operationInput, fingerprint);
      await assertAllocationReplay(db, context, membership, raced, replay, key);
      return { data: replay, status: 201, replayed: true };
    }
    const racedKey = await readReceiptForKey(db, agencyId, context.userId, membership.id, key);
    if (racedKey) {
      if (racedKey.action !== LINK_ACTION) throw conflict('IDEMPOTENCY_KEY_REUSED');
      if (racedKey.payload_fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
      const replay = await readAllocationResult(db, racedKey, operationInput, fingerprint);
      await assertAllocationReplay(db, context, membership, racedKey, replay, key);
      return { data: replay, status: 201, replayed: true };
    }
    mapLinkBatchError(error);
  }
  return { data: result, status: 201, replayed: false };
}

async function allocationResultFromEffects(
  db: D1Database,
  receipt: ReceiptRow,
  input: AllocateRenewalPolicyLinksInput,
  expectedFingerprint: string,
): Promise<AllocationResult> {
  if (
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 201 ||
    receipt.payload_fingerprint !== expectedFingerprint ||
    !receipt.response_body
  ) {
    throw conflict('IDEMPOTENCY_CONFLICT');
  }
  const agencyId = receipt.agency_id;
  const newEffectsResult = await db
    .prepare(
      `SELECT id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
              different_policyholder_reason_code,created_by_membership_id,allocation_operation_id,status
       FROM renewal_policy_links
       WHERE agency_id=? AND allocation_operation_id=?
       ORDER BY renewal_id,new_policy_id,id`,
    )
    .bind(agencyId, receipt.id)
    .all<{
      id: string;
      agency_id: string;
      renewal_id: string;
      new_policy_id: string;
      allocated_new_premium_minor: number;
      currency: string;
      different_policyholder_reason_code: string | null;
      created_by_membership_id: string;
      allocation_operation_id: string;
      status: 'ACTIVE' | 'SUPERSEDED';
    }>();
  const supersededEffectsResult = await db
    .prepare(
      `SELECT id,agency_id,renewal_id,new_policy_id,different_policyholder_reason_code,
              superseded_by_membership_id,supersede_reason_code,superseded_operation_id,status
       FROM renewal_policy_links
       WHERE agency_id=? AND superseded_operation_id=?
       ORDER BY renewal_id,new_policy_id,id`,
    )
    .bind(agencyId, receipt.id)
    .all<{
      id: string;
      agency_id: string;
      renewal_id: string;
      new_policy_id: string;
      different_policyholder_reason_code: string | null;
      superseded_by_membership_id: string | null;
      supersede_reason_code: string | null;
      superseded_operation_id: string | null;
      status: 'ACTIVE' | 'SUPERSEDED';
    }>();
  if (!newEffectsResult.success || !supersededEffectsResult.success) {
    throw new RenewalCommandError('DATABASE_ERROR', 500);
  }
  const newEffects = newEffectsResult.results;
  const supersededEffects = supersededEffectsResult.results;
  const requested = normalizeLinks(input.links);
  if (newEffects.length !== requested.length) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const byPair = new Map(
    newEffects.map((effect) => [`${effect.renewal_id}\u0000${effect.new_policy_id}`, effect]),
  );
  const links = requested.map((expected) => {
    const effect = byPair.get(`${expected.renewalId}\u0000${expected.newPolicyId}`);
    if (
      !effect ||
      effect.agency_id !== agencyId ||
      effect.created_by_membership_id !== receipt.actor_membership_id ||
      effect.allocation_operation_id !== receipt.id ||
      (effect.status !== 'ACTIVE' && effect.status !== 'SUPERSEDED') ||
      effect.allocated_new_premium_minor !== expected.allocatedNewPremiumMinor ||
      effect.currency !== expected.currency ||
      effect.different_policyholder_reason_code !== expected.differentPolicyholderReasonCode
    ) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    return {
      id: effect.id,
      renewalId: expected.renewalId,
      newPolicyId: expected.newPolicyId,
      allocatedNewPremiumMinor: expected.allocatedNewPremiumMinor,
      currency: expected.currency,
      differentPolicyholderReasonCode: expected.differentPolicyholderReasonCode,
    };
  });
  if (
    supersededEffects.some(
      (effect) =>
        effect.agency_id !== agencyId ||
        effect.status !== 'SUPERSEDED' ||
        effect.superseded_by_membership_id !== receipt.actor_membership_id ||
        effect.supersede_reason_code !== input.reasonCode ||
        effect.superseded_operation_id !== receipt.id,
    )
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const auditRows = await db
    .prepare(
      `SELECT metadata_json FROM audit_events
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=?
         AND action=? AND target_type='renewal_policy_link_batch' AND target_id=?
         AND idempotency_key=? AND outcome='SUCCESS'`,
    )
    .bind(
      agencyId,
      receipt.actor_user_id,
      receipt.actor_membership_id,
      LINK_ACTION,
      receipt.id,
      receipt.idempotency_key,
    )
    .all<{ metadata_json: string }>();
  if (!auditRows.success || auditRows.results.length !== 1) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(auditRows.results[0]!.metadata_json) as Record<string, unknown>;
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (
    metadata.reasonCode !== input.reasonCode ||
    metadata.referenceId !== receipt.id ||
    metadata.changedFieldCount !== newEffects.length + supersededEffects.length
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const renewalIds = [
    ...new Set([...newEffects, ...supersededEffects].map((effect) => effect.renewal_id)),
  ].sort();
  const renewals = new Map<string, RenewalRow>();
  for (const renewalId of renewalIds) {
    const renewal = await loadRenewal(db, agencyId, renewalId);
    if (!renewal || renewal.agency_id !== agencyId) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    renewals.set(renewalId, renewal);
  }
  const policyIds = [
    ...new Set([
      ...Array.from(renewals.values()).map((renewal) => renewal.expiring_policy_id),
      ...newEffects.map((effect) => effect.new_policy_id),
      ...supersededEffects.map((effect) => effect.new_policy_id),
    ]),
  ].sort();
  const policies = new Map<string, PolicyRow>();
  for (const policyId of policyIds) {
    const policy = await loadPolicy(db, agencyId, policyId);
    if (!policy || policy.agency_id !== agencyId) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    policies.set(policyId, policy);
  }
  const customerIds = [
    ...new Set([...policies.values()].map((policy) => policy.customer_id)),
  ].sort();
  const targets = sortedTargets([
    ...renewalIds.map((id): TargetRef => ({ kind: 'renewal', id })),
    ...policyIds.map((id): TargetRef => ({ kind: 'policy', id })),
    ...customerIds.map((id): TargetRef => ({ kind: 'customer', id })),
  ]);
  const ownerRequired =
    newEffects.some((effect) => effect.different_policyholder_reason_code !== null) ||
    supersededEffects.some((effect) => effect.different_policyholder_reason_code !== null) ||
    [...newEffects, ...supersededEffects].some((effect) => {
      const renewal = renewals.get(effect.renewal_id);
      const expiringPolicy = renewal ? policies.get(renewal.expiring_policy_id) : null;
      const newPolicy = policies.get(effect.new_policy_id);
      return !expiringPolicy || !newPolicy || expiringPolicy.customer_id !== newPolicy.customer_id;
    });
  const result: AllocationResult = {
    operationId: receipt.id,
    reasonCode: input.reasonCode,
    ownerRequired,
    authorizedTargets: targets,
    links,
    supersededLinkIds: supersededEffects.map((effect) => effect.id).sort(),
  };
  if (receipt.response_body !== JSON.stringify(result)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return result;
}

async function assertAllocationReplay(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembership,
  receipt: ReceiptRow,
  result: AllocationResult,
  idempotencyKey: string,
): Promise<void> {
  const rows = await loadTargetsByRefs(db, membership.agencyId, result.authorizedTargets);
  const permissionSet = await authorizeWithStablePermissionSet(db, membership.id, () =>
    authorizeTargetRows(
      db,
      context,
      membership,
      result.authorizedTargets,
      rows,
      result.ownerRequired,
    ),
  );
  const authority = liveAuthorityPredicate(
    context,
    membership,
    result.authorizedTargets,
    result.ownerRequired,
    permissionSet,
  );
  const expectedLinkValues = result.links.map(() => '(?,?,?,?,?,?)').join(',');
  const expectedSupersededValues = result.supersededLinkIds.length
    ? `VALUES ${result.supersededLinkIds.map(() => '(?)').join(',')}`
    : 'SELECT NULL WHERE 0';
  const query = `WITH expected_links(id,renewal_id,new_policy_id,amount,currency,different_reason) AS (
      VALUES ${expectedLinkValues}
    ), expected_superseded(id) AS (${expectedSupersededValues})
    SELECT
      CASE WHEN EXISTS(${authority.sql}) THEN 1 ELSE 0 END AS authority_count,
      (SELECT count(*) FROM operation_receipts r
       WHERE r.id=? AND r.agency_id=? AND r.actor_user_id=? AND r.actor_membership_id=?
         AND r.action=? AND r.idempotency_key=? AND r.payload_fingerprint=?
         AND r.status='COMPLETED' AND r.response_status=201 AND r.response_body=?) AS receipt_count,
      (SELECT count(*) FROM audit_events a
       WHERE a.agency_id=? AND a.actor_user_id=? AND a.actor_membership_id=?
         AND a.action=? AND a.target_type='renewal_policy_link_batch'
         AND a.target_id=? AND a.idempotency_key=? AND a.outcome='SUCCESS') AS audit_count,
      (SELECT count(*) FROM expected_links e
       JOIN renewal_policy_links l ON l.id=e.id AND l.agency_id=? AND l.allocation_operation_id=?
         AND l.renewal_id=e.renewal_id AND l.new_policy_id=e.new_policy_id
         AND l.allocated_new_premium_minor=e.amount AND l.currency=e.currency
         AND l.different_policyholder_reason_code IS e.different_reason) AS link_count,
      (SELECT count(*) FROM expected_superseded e
       JOIN renewal_policy_links l ON l.id=e.id AND l.agency_id=? AND l.superseded_operation_id=?
         AND l.status='SUPERSEDED' AND l.superseded_by_membership_id=?) AS superseded_count`;
  const bindValues = [
    ...result.links.flatMap((link) => [
      link.id,
      link.renewalId,
      link.newPolicyId,
      link.allocatedNewPremiumMinor,
      link.currency,
      link.differentPolicyholderReasonCode,
    ]),
    ...result.supersededLinkIds,
    ...authority.bindings,
    receipt.id,
    receipt.agency_id,
    receipt.actor_user_id,
    receipt.actor_membership_id,
    receipt.action,
    idempotencyKey,
    receipt.payload_fingerprint,
    JSON.stringify(result),
    receipt.agency_id,
    receipt.actor_user_id,
    receipt.actor_membership_id,
    LINK_ACTION,
    result.operationId,
    idempotencyKey,
    membership.agencyId,
    result.operationId,
    membership.agencyId,
    result.operationId,
    membership.id,
  ];
  const proof = await db
    .prepare(query)
    .bind(...bindValues)
    .first<{
      authority_count: number;
      receipt_count: number;
      audit_count: number;
      link_count: number;
      superseded_count: number;
    }>();
  if (
    proof?.authority_count !== 1 ||
    proof.receipt_count !== 1 ||
    proof.audit_count !== 1 ||
    proof.link_count !== result.links.length ||
    proof.superseded_count !== result.supersededLinkIds.length
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

async function replayRacedAllocationReceipt(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembership,
  input: AllocateRenewalPolicyLinksInput,
  fingerprint: string,
  idempotencyKey: string,
): Promise<{ data: AllocationResult; status: 201; replayed: true } | null> {
  const receipt = await readReceiptForKey(
    db,
    membership.agencyId,
    context.userId,
    membership.id,
    idempotencyKey,
  );
  if (!receipt) return null;
  if (receipt.action !== LINK_ACTION) throw conflict('IDEMPOTENCY_KEY_REUSED');
  if (receipt.payload_fingerprint !== fingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
  const result = await readAllocationResult(db, receipt, input, fingerprint);
  await assertAllocationReplay(db, context, membership, receipt, result, idempotencyKey);
  return { data: result, status: 201, replayed: true };
}

function linkReceiptStatement(
  db: D1Database,
  input: {
    readonly id: string;
    readonly agencyId: string;
    readonly userId: string;
    readonly membershipId: string;
    readonly key: string;
    readonly fingerprint: string;
    readonly body: string;
    readonly now: string;
  },
): D1PreparedStatement {
  return operationReceiptStatement(db, {
    id: input.id,
    agencyId: input.agencyId,
    actorUserId: input.userId,
    actorMembershipId: input.membershipId,
    action: LINK_ACTION,
    idempotencyKey: input.key,
    payloadFingerprint: input.fingerprint,
    responseBody: input.body,
    createdAt: input.now,
  });
}

async function readGrant(db: D1Database, token: string): Promise<GrantRow | null> {
  const evidenceHash = await computeEvidenceHash(token);
  return db
    .prepare(
      `SELECT id,evidence_hash,agency_id,actor_user_id,actor_membership_id,action,payload_hash,
              target_ids_json,expected_target_version,permission_version,assurance,status,issued_at,
              expires_at,consumed_at,revoked_at
       FROM sensitive_action_grants WHERE evidence_hash=?`,
    )
    .bind(evidenceHash)
    .first<GrantRow>();
}

function grantMatchesSnapshot(
  grant: GrantRow | null,
  context: AuthenticatedUserContext,
  snapshot: GroupSnapshot,
  grantPayloadHash: string,
  now: string,
): grant is GrantRow {
  return !!(
    grant &&
    grant.agency_id === snapshot.agencyId &&
    grant.actor_user_id === context.userId &&
    grant.actor_membership_id === snapshot.membership.id &&
    grant.action === LINK_ACTION &&
    grant.payload_hash === grantPayloadHash &&
    grant.target_ids_json === snapshot.targetIdsJson &&
    grant.expected_target_version === null &&
    grant.permission_version === snapshot.membership.permissionVersion &&
    grant.assurance === 'SECURE_GRANT' &&
    grant.status === 'ISSUED' &&
    grant.consumed_at === null &&
    grant.revoked_at === null &&
    grant.expires_at > now
  );
}

function createNewLinkStatements(
  db: D1Database,
  snapshot: GroupSnapshot,
  result: AllocationResult,
  now: string,
): D1PreparedStatement[] {
  const previousByPair = new Map(
    snapshot.previousLinks.map((link) => [
      `${link.renewal_id}\u0000${link.new_policy_id}`,
      link.id,
    ]),
  );
  const statements: D1PreparedStatement[] = [];
  for (const link of result.links) {
    statements.push(
      db
        .prepare(
          `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,status,
            supersedes_link_id,allocation_operation_id,different_policyholder_reason_code,
            created_by_membership_id,created_at)
           VALUES(?,?,?,?,?,?,'ACTIVE',?,?,?,?,?)`,
        )
        .bind(
          link.id,
          snapshot.agencyId,
          link.renewalId,
          link.newPolicyId,
          link.allocatedNewPremiumMinor,
          link.currency,
          previousByPair.get(`${link.renewalId}\u0000${link.newPolicyId}`) ?? null,
          result.operationId,
          link.differentPolicyholderReasonCode,
          snapshot.membership.id,
          now,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
           SELECT ?,1,changes(),'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
        )
        .bind(crypto.randomUUID()),
    );
  }
  return statements;
}

function supersedePreviousLinks(
  db: D1Database,
  snapshot: GroupSnapshot,
  operationId: string,
  now: string,
): D1PreparedStatement[] {
  if (snapshot.previousLinks.length === 0) return [];
  const ids = snapshot.previousLinks.map((link) => link.id);
  return [
    db
      .prepare(
        `UPDATE renewal_policy_links SET status='SUPERSEDED',superseded_at=?,
           superseded_by_membership_id=?,supersede_reason_code=?,superseded_operation_id=?
         WHERE agency_id=? AND status='ACTIVE' AND id IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(
        now,
        snapshot.membership.id,
        snapshot.reasonCode,
        operationId,
        snapshot.agencyId,
        ...ids,
      ),
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
         SELECT ?,?,changes(),'RENEWAL_POLICY_LINK_CONFLICT'`,
      )
      .bind(crypto.randomUUID(), ids.length),
  ];
}
