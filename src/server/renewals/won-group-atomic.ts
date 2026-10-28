import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import {
  canonicalizeTargetIds,
  computeEvidenceHash,
  issueAndPersistSensitiveActionGrant,
} from '../mutations/grants';
import { computePayloadHash } from '../mutations/canonical';
import {
  closeRenewalWonGroupGrantSchema,
  closeRenewalWonGroupSchema,
  type CloseRenewalWonGroupGrantInput,
} from './validation';
import {
  activeMembership,
  actorAuthorityAssertion,
  authorizeCurrentTarget,
  authorizeWonPolicyTargets,
  casAssertion,
  closeRenewalWonStatement,
  completePrimaryTaskStatement,
  isCanonicalTimestamp,
  isReceiptRace,
  loadRenewalTask,
  loadWonPolicy,
  readReceipt,
  RenewalCommandError,
  stateHistoryInsert,
  wonAuditStatement,
  wonPolicyReadAssertion,
  wonPolicyReplayReadAssertion,
  wonPolicyReplayVersionAssertion,
  wonPolicyVersionAssertion,
  type ActiveMembership,
  type AuthorizationScopes,
  type ReceiptRow,
  type RenewalTaskRow,
  type WonPolicyTarget,
} from './commands';

const GROUP_ACTION = 'renewal.close_won.group';
const WON_ACTION = 'renewal.close_won';
const OPEN_STATES = [
  'CONTACT_PENDING',
  'CONTACTED',
  'QUOTE_PREPARING',
  'QUOTE_SENT',
  'AWAITING_RESPONSE',
] as const;

type GroupRenewalInput = CloseRenewalWonGroupGrantInput['renewals'][number];
type GroupLinkInput = Omit<
  CloseRenewalWonGroupGrantInput['links'][number],
  'differentPolicyholderReasonCode'
> & {
  readonly differentPolicyholderReasonCode: string | null;
};

interface GroupPriorActiveLink {
  readonly id: string;
  readonly renewalId: string;
  readonly newPolicyId: string;
  readonly allocatedNewPremiumMinor: number;
  readonly currency: string;
  readonly allocationOperationId: string;
  readonly differentPolicyholderReasonCode: string | null;
  readonly createdByMembershipId: string;
}

interface GroupActiveLinkEvidence extends GroupPriorActiveLink {
  readonly allocationAction: string;
  readonly allocationStatus: string;
  readonly allocationResponseStatus: number | null;
  readonly allocationActorMembershipId: string;
  readonly allocationResponseBody: string | null;
}

function hasValidAllocationReceipt(link: GroupActiveLinkEvidence): boolean {
  if (
    link.allocationAction !== 'renewal.policy_links.allocate' ||
    link.allocationStatus !== 'COMPLETED' ||
    link.allocationResponseStatus !== 201 ||
    link.allocationActorMembershipId !== link.createdByMembershipId ||
    !link.allocationResponseBody
  ) {
    return false;
  }
  try {
    const value: unknown = JSON.parse(link.allocationResponseBody);
    if (
      !hasExactKeys(value, [
        'operationId',
        'reasonCode',
        'ownerRequired',
        'authorizedTargets',
        'links',
        'supersededLinkIds',
      ]) ||
      value.operationId !== link.allocationOperationId ||
      typeof value.reasonCode !== 'string' ||
      typeof value.ownerRequired !== 'boolean' ||
      !Array.isArray(value.authorizedTargets) ||
      !Array.isArray(value.supersededLinkIds) ||
      !Array.isArray(value.links)
    ) {
      return false;
    }
    return value.links.some(
      (item) =>
        hasExactKeys(item, [
          'id',
          'renewalId',
          'newPolicyId',
          'allocatedNewPremiumMinor',
          'currency',
          'differentPolicyholderReasonCode',
        ]) &&
        item.id === link.id &&
        item.renewalId === link.renewalId &&
        item.newPolicyId === link.newPolicyId &&
        item.allocatedNewPremiumMinor === link.allocatedNewPremiumMinor &&
        item.currency === link.currency &&
        item.differentPolicyholderReasonCode === link.differentPolicyholderReasonCode,
    );
  } catch {
    return false;
  }
}

async function loadGroupPriorActiveLinks(
  db: D1Database,
  agencyId: string,
  renewalIds: readonly string[],
  policyIds: readonly string[],
): Promise<GroupPriorActiveLink[]> {
  const result = await db
    .prepare(
      `SELECT l.id,l.renewal_id,l.new_policy_id,l.allocated_new_premium_minor,l.currency,
              l.allocation_operation_id,l.different_policyholder_reason_code,
              l.created_by_membership_id,r.action AS allocation_action,
              r.status AS allocation_status,r.response_status AS allocation_response_status,
              r.actor_membership_id AS allocation_actor_membership_id,
              r.response_body AS allocation_response_body
       FROM renewal_policy_links l
       JOIN operation_receipts r ON r.id=l.allocation_operation_id AND r.agency_id=l.agency_id
       WHERE l.agency_id=? AND l.status='ACTIVE'
         AND (l.renewal_id IN (${renewalIds.map(() => '?').join(',')})
           OR l.new_policy_id IN (${policyIds.map(() => '?').join(',')}))
       ORDER BY l.renewal_id,l.new_policy_id,l.id`,
    )
    .bind(agencyId, ...renewalIds, ...policyIds)
    .all<{
      id: string;
      renewal_id: string;
      new_policy_id: string;
      allocated_new_premium_minor: number;
      currency: string;
      allocation_operation_id: string;
      different_policyholder_reason_code: string | null;
      created_by_membership_id: string;
      allocation_action: string;
      allocation_status: string;
      allocation_response_status: number | null;
      allocation_actor_membership_id: string;
      allocation_response_body: string | null;
    }>();
  if (!result.success) throw new RenewalCommandError('DATABASE_ERROR', 500);
  return result.results.map((row) => {
    const prior: GroupActiveLinkEvidence = {
      id: row.id,
      renewalId: row.renewal_id,
      newPolicyId: row.new_policy_id,
      allocatedNewPremiumMinor: row.allocated_new_premium_minor,
      currency: row.currency,
      allocationOperationId: row.allocation_operation_id,
      differentPolicyholderReasonCode: row.different_policyholder_reason_code,
      createdByMembershipId: row.created_by_membership_id,
      allocationAction: row.allocation_action,
      allocationStatus: row.allocation_status,
      allocationResponseStatus: row.allocation_response_status,
      allocationActorMembershipId: row.allocation_actor_membership_id,
      allocationResponseBody: row.allocation_response_body,
    };
    if (!hasValidAllocationReceipt(prior)) {
      throw new RenewalCommandError('WON_GROUP_LINKS_ALREADY_ALLOCATED', 409);
    }
    return {
      id: prior.id,
      renewalId: prior.renewalId,
      newPolicyId: prior.newPolicyId,
      allocatedNewPremiumMinor: prior.allocatedNewPremiumMinor,
      currency: prior.currency,
      allocationOperationId: prior.allocationOperationId,
      differentPolicyholderReasonCode: prior.differentPolicyholderReasonCode,
      createdByMembershipId: prior.createdByMembershipId,
    };
  });
}

interface GroupSnapshotEntry {
  readonly input: GroupRenewalInput;
  readonly row: RenewalTaskRow;
  readonly scopes: AuthorizationScopes;
}

interface GroupSnapshot {
  readonly agencyId: string;
  readonly membership: ActiveMembership;
  readonly request: {
    readonly reasonCode: string;
    readonly renewals: readonly GroupRenewalInput[];
    readonly links: readonly GroupLinkInput[];
  };
  readonly entries: readonly GroupSnapshotEntry[];
  readonly targets: readonly WonPolicyTarget[];
  readonly priorActiveLinks: readonly GroupPriorActiveLink[];
  readonly ownerRequired: boolean;
  readonly targetIds: readonly string[];
  readonly targetIdsJson: string;
  readonly binding: Record<string, unknown>;
  readonly payloadHash: string;
}

interface GroupLinkResult {
  readonly id: string;
  readonly renewalId: string;
  readonly newPolicyId: string;
  readonly allocatedNewPremiumMinor: number;
  readonly currency: string;
  readonly differentPolicyholderReasonCode: string | null;
  readonly allocationOperationId: string;
  readonly policyVersion: number;
}

interface GroupRenewalResult {
  readonly renewalId: string;
  readonly previousState: string;
  readonly state: 'WON';
  readonly primaryTaskId: string;
  readonly renewalVersion: number;
  readonly taskVersion: number;
  readonly closedAt: string;
  readonly createdPolicyId: null;
  readonly newPolicyIds: readonly string[];
  readonly linkIds: readonly string[];
  readonly links: readonly GroupLinkResult[];
}

interface GroupResult {
  readonly operationId: string;
  readonly reasonCode: string;
  readonly renewals: readonly GroupRenewalResult[];
}

interface GroupReceiptEnvelope {
  readonly binding: Record<string, unknown>;
  readonly result: GroupResult;
}

interface GrantRow {
  readonly id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly status: string;
  readonly agency_id: string;
  readonly actor_user_id: string;
  readonly actor_membership_id: string;
  readonly action: string;
  readonly payload_hash: string;
  readonly target_ids_json: string;
  readonly expected_target_version: number | null;
  readonly permission_version: number;
  readonly assurance: string;
  readonly revoked_at: string | null;
}

function canonicalRequest(input: CloseRenewalWonGroupGrantInput): GroupSnapshot['request'] {
  return {
    reasonCode: input.reasonCode,
    renewals: [...input.renewals].sort((left, right) =>
      left.renewalId.localeCompare(right.renewalId),
    ),
    links: [...input.links]
      .map((link) => ({
        ...link,
        differentPolicyholderReasonCode: link.differentPolicyholderReasonCode ?? null,
      }))
      .sort(
        (left, right) =>
          left.renewalId.localeCompare(right.renewalId) ||
          left.newPolicyId.localeCompare(right.newPolicyId),
      ),
  };
}

function targetIdSet(ids: readonly string[]): { readonly ids: string[]; readonly json: string } {
  if (new Set(ids).size !== ids.length) throw new RenewalCommandError('TARGET_KIND_COLLISION', 400);
  try {
    const json = canonicalizeTargetIds(ids);
    return { ids: JSON.parse(json) as string[], json };
  } catch {
    throw new RenewalCommandError('INVALID_TARGET_SET', 400);
  }
}

function rowBinding(row: RenewalTaskRow): Record<string, unknown> {
  return {
    renewalId: row.renewal_id,
    sourcePolicyId: row.policy_id,
    customerId: row.customer_id,
    state: row.renewal_state,
    version: row.renewal_version,
    taskId: row.task_id,
    taskVersion: row.task_version,
    renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
    taskAssigneeMembershipId: row.task_assignee_membership_id,
    sourcePolicyDataClassification: row.branch_data_classification,
  };
}

function policyBinding(target: WonPolicyTarget): Record<string, unknown> {
  return {
    id: target.id,
    agencyId: target.agency_id,
    customerId: target.customer_id,
    version: target.version,
    status: target.status,
    archivedAt: target.archived_at,
    grossPremiumMinor: target.gross_premium_minor,
    currency: target.currency,
    assigneeMembershipId: target.assignee_membership_id,
    customerAssigneeMembershipId: target.customer_assignee_membership_id,
    branchId: target.branch_id,
    dataClassification: target.data_classification,
    customerArchivedAt: target.customer_archived_at,
  };
}

async function loadGroupSnapshot(
  context: AuthenticatedUserContext,
  db: D1Database,
  rawInput: CloseRenewalWonGroupGrantInput,
): Promise<GroupSnapshot> {
  const active = activeMembership(context);
  const request = canonicalRequest(rawInput);
  const entries: GroupSnapshotEntry[] = [];
  for (const item of request.renewals) {
    const row = await loadRenewalTask(db, active.agencyId, item.renewalId);
    if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
    if (
      !OPEN_STATES.includes(row.renewal_state as (typeof OPEN_STATES)[number]) ||
      row.renewal_closed_at !== null ||
      row.task_status !== 'OPEN'
    ) {
      throw new RenewalCommandError('RENEWAL_STATE_CONFLICT', 409);
    }
    if (
      row.renewal_version !== item.expectedRenewalVersion ||
      row.task_version !== item.expectedTaskVersion
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
    const scopes = await authorizeCurrentTarget(db, context, row, WON_ACTION);
    if (
      scopes.terminalAction !== 'AGENCY' ||
      scopes.renewalRead !== 'AGENCY' ||
      scopes.policyRead !== 'AGENCY' ||
      scopes.customerRead !== 'AGENCY' ||
      scopes.taskRead !== 'AGENCY' ||
      scopes.taskUpdate !== 'AGENCY'
    ) {
      throw new RenewalCommandError('FORBIDDEN', 403);
    }
    entries.push({ input: item, row, scopes });
  }
  const policyIds = [...new Set(request.links.map((link) => link.newPolicyId))].sort();
  const rawTargets = await Promise.all(
    policyIds.map((id) => loadWonPolicy(db, active.agencyId, id)),
  );
  if (rawTargets.some((target) => target === null)) throw new RenewalCommandError('NOT_FOUND', 404);
  const targets = await authorizeWonPolicyTargets(
    db,
    context,
    active.agencyId,
    rawTargets.filter((target): target is WonPolicyTarget => target !== null),
  );
  if (
    targets.some(
      (target) => target.policyReadScope !== 'AGENCY' || target.customerReadScope !== 'AGENCY',
    )
  ) {
    throw new RenewalCommandError('FORBIDDEN', 403);
  }
  const requestedByPolicy = new Map<string, number>();
  let ownerRequired = false;
  for (const link of request.links) {
    const renewal = entries.find((entry) => entry.row.renewal_id === link.renewalId);
    const target = targets.find((candidate) => candidate.id === link.newPolicyId);
    if (!renewal || !target) throw new RenewalCommandError('NOT_FOUND', 404);
    const requestedVersion = rawInput.links.find(
      (item) => item.renewalId === link.renewalId && item.newPolicyId === link.newPolicyId,
    )?.expectedPolicyVersion;
    if (
      requestedVersion !== target.version ||
      target.status !== 'ACTIVE' ||
      target.archived_at !== null ||
      target.customer_archived_at !== null ||
      target.currency !== link.currency
    ) {
      throw new RenewalCommandError('WON_POLICY_TARGET_INVALID', 409);
    }
    const differentCustomer = target.customer_id !== renewal.row.customer_id;
    if (
      (differentCustomer && !link.differentPolicyholderReasonCode) ||
      (!differentCustomer && link.differentPolicyholderReasonCode !== null)
    ) {
      throw new RenewalCommandError('POLICYHOLDER_REASON_REQUIRED', 409);
    }
    if (differentCustomer || link.differentPolicyholderReasonCode !== null) ownerRequired = true;
    const requestedTotal = (requestedByPolicy.get(target.id) ?? 0) + link.allocatedNewPremiumMinor;
    if (!Number.isSafeInteger(requestedTotal)) {
      throw new RenewalCommandError('WON_ALLOCATION_OVERFLOW', 409);
    }
    requestedByPolicy.set(target.id, requestedTotal);
  }
  if (ownerRequired && active.type !== 'OWNER')
    throw new RenewalCommandError('OWNER_REVIEW_REQUIRED', 403);
  const priorActiveLinks = await loadGroupPriorActiveLinks(
    db,
    active.agencyId,
    entries.map((entry) => entry.row.renewal_id),
    policyIds,
  );
  if (
    priorActiveLinks.some((prior) => {
      const requested = request.links.find(
        (link) => link.renewalId === prior.renewalId && link.newPolicyId === prior.newPolicyId,
      );
      return (
        !requested ||
        requested.allocatedNewPremiumMinor !== prior.allocatedNewPremiumMinor ||
        requested.currency !== prior.currency ||
        requested.differentPolicyholderReasonCode !== prior.differentPolicyholderReasonCode
      );
    })
  ) {
    throw new RenewalCommandError('WON_GROUP_LINKS_ALREADY_ALLOCATED', 409);
  }
  for (const target of targets) {
    if (!Number.isSafeInteger(target.gross_premium_minor)) {
      throw new RenewalCommandError('WON_ALLOCATION_OVERFLOW', 409);
    }
    if (requestedByPolicy.get(target.id)! > target.gross_premium_minor) {
      throw new RenewalCommandError('WON_ALLOCATION_OVERFLOW', 409);
    }
    if (requestedByPolicy.get(target.id) !== target.gross_premium_minor)
      throw new RenewalCommandError('WON_ALLOCATION_INCOMPLETE', 409);
  }
  const targetKinds = [
    new Set(entries.map((entry) => entry.row.renewal_id)),
    new Set(entries.map((entry) => entry.row.policy_id)),
    new Set(targets.map((target) => target.id)),
    new Set(targets.map((target) => target.customer_id)),
  ];
  for (let left = 0; left < targetKinds.length; left += 1) {
    for (let right = left + 1; right < targetKinds.length; right += 1) {
      if ([...targetKinds[left]!].some((id) => targetKinds[right]!.has(id))) {
        throw new RenewalCommandError('TARGET_KIND_COLLISION', 400);
      }
    }
  }
  const targetSet = targetIdSet(targetKinds.flatMap((kind) => [...kind]));
  const binding: Record<string, unknown> = {
    action: GROUP_ACTION,
    request,
    sourceRows: entries.map((entry) => rowBinding(entry.row)),
    policies: targets.map(policyBinding),
    ownerRequired,
    targetIds: targetSet.ids,
    priorActiveLinks,
  };
  return {
    agencyId: active.agencyId,
    membership: active,
    request,
    entries,
    targets,
    priorActiveLinks,
    ownerRequired,
    targetIds: targetSet.ids,
    targetIdsJson: targetSet.json,
    binding,
    payloadHash: await computePayloadHash(binding),
  };
}

async function authorizeGroupAction(
  db: D1Database,
  context: AuthenticatedUserContext,
  snapshot: GroupSnapshot,
): Promise<void> {
  for (const entry of snapshot.entries) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: WON_ACTION,
      resource: {
        agencyId: entry.row.agency_id,
        renewalAssigneeMembershipId: entry.row.renewal_assignee_membership_id,
        customerAssigneeMembershipId: entry.row.customer_assignee_membership_id,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY')
      throw new RenewalCommandError('FORBIDDEN', 403);
  }
}

async function deriveGrantToken(
  secret: string,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  keyValue: string,
): Promise<string> {
  if (secret.length < 32) throw new RenewalCommandError('GRANT_KEY_UNAVAILABLE', 500);
  const hash = await computePayloadHash({
    purpose: 'renewal.close_won.group.grant',
    action: GROUP_ACTION,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    idempotencyKey: keyValue,
  });
  const encoder = new TextEncoder();
  const root = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('mayi-sigorta-v1'),
      info: encoder.encode('renewal-close-won-group/grant-evidence'),
    },
    root,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`grant-evidence-v1\u0000${hash}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function readGrant(db: D1Database, token: string): Promise<GrantRow | null> {
  const hash = await computeEvidenceHash(token);
  return db
    .prepare(
      `SELECT id,issued_at,expires_at,status,agency_id,actor_user_id,actor_membership_id,action,
       payload_hash,target_ids_json,expected_target_version,permission_version,assurance,revoked_at
       FROM sensitive_action_grants WHERE evidence_hash=?`,
    )
    .bind(hash)
    .first<GrantRow>();
}

async function grantValid(
  grant: GrantRow,
  context: AuthenticatedUserContext,
  snapshot: GroupSnapshot,
): Promise<boolean> {
  const now = Date.now();
  const issuedAt = Date.parse(grant.issued_at);
  const expiresAt = Date.parse(grant.expires_at);
  const valid =
    grant.status === 'ISSUED' &&
    grant.revoked_at === null &&
    grant.agency_id === snapshot.agencyId &&
    grant.actor_user_id === context.userId &&
    grant.actor_membership_id === snapshot.membership.id &&
    grant.action === GROUP_ACTION &&
    grant.payload_hash === snapshot.payloadHash &&
    grant.target_ids_json === snapshot.targetIdsJson &&
    grant.expected_target_version === null &&
    grant.permission_version === snapshot.membership.permissionVersion &&
    grant.assurance === 'SECURE_GRANT' &&
    Number.isFinite(issuedAt) &&
    issuedAt <= now &&
    Number.isFinite(expiresAt) &&
    expiresAt > now;
  return valid;
}

function groupReceiptInsert(
  db: D1Database,
  active: ActiveMembership,
  context: AuthenticatedUserContext,
  key: string,
  fingerprint: string,
  result: GroupResult,
  binding: Record<string, unknown>,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operation_receipts
      (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
       status,response_status,response_body,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'COMPLETED',201,?,?,?)`,
    )
    .bind(
      result.operationId,
      active.agencyId,
      context.userId,
      active.id,
      GROUP_ACTION,
      key,
      fingerprint,
      JSON.stringify({ binding, result }),
      now,
      now,
    );
}

function consumeGrant(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  snapshot: GroupSnapshot,
  tokenHash: string,
  operationId: string,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sensitive_action_grants SET status='CONSUMED',consumed_at=?,consumed_operation_id=?,updated_at=?
      WHERE evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=?
        AND payload_hash=? AND target_ids_json=? AND expected_target_version IS NULL
        AND permission_version=? AND assurance='SECURE_GRANT' AND status='ISSUED'
        AND consumed_at IS NULL AND revoked_at IS NULL
        AND julianday(issued_at)<=julianday(?) AND julianday(expires_at)>julianday(?)`,
    )
    .bind(
      now,
      operationId,
      now,
      tokenHash,
      active.agencyId,
      context.userId,
      active.id,
      GROUP_ACTION,
      snapshot.payloadHash,
      snapshot.targetIdsJson,
      active.permissionVersion,
      now,
      now,
    );
}

function groupActionAuthority(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN EXISTS(
      SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
      JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
      WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
        AND m.permission_version=? AND u.status='ACTIVE' AND a.status='ACTIVE'
        AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions p WHERE p.membership_id=m.id
          AND p.permission_code='renewal.close_won' AND p.scope='AGENCY'))
    ) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      context.identityId,
      active.id,
      active.agencyId,
      context.userId,
      active.permissionVersion,
    );
}

function groupLinkPlanAssertion(db: D1Database, snapshot: GroupSnapshot): D1PreparedStatement {
  const renewalIds = snapshot.request.renewals.map((item) => item.renewalId);
  const policyIds = snapshot.targets.map((item) => item.id);
  const expectedPriorLinks = snapshot.priorActiveLinks.length
    ? snapshot.priorActiveLinks
        .map(
          () =>
            `(l.id=? AND l.renewal_id=? AND l.new_policy_id=? AND l.allocated_new_premium_minor=? AND l.currency=? AND l.allocation_operation_id=? AND l.different_policyholder_reason_code IS ? AND l.created_by_membership_id=?)`,
        )
        .join(' OR ')
    : '0';
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN
      (SELECT count(*) FROM renewal_policy_links l WHERE l.agency_id=? AND l.status='ACTIVE'
        AND (l.renewal_id IN (${renewalIds.map(() => '?').join(',')})
          OR l.new_policy_id IN (${policyIds.map(() => '?').join(',')})))=?
      AND NOT EXISTS(SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=? AND l.status='ACTIVE'
        AND (l.renewal_id IN (${renewalIds.map(() => '?').join(',')})
          OR l.new_policy_id IN (${policyIds.map(() => '?').join(',')}))
        AND NOT (${expectedPriorLinks}))
    THEN 1 ELSE 0 END,'RENEWAL_POLICY_LINK_CONFLICT'`,
    )
    .bind(
      crypto.randomUUID(),
      snapshot.agencyId,
      ...renewalIds,
      ...policyIds,
      snapshot.priorActiveLinks.length,
      snapshot.agencyId,
      ...renewalIds,
      ...policyIds,
      ...snapshot.priorActiveLinks.flatMap((link) => [
        link.id,
        link.renewalId,
        link.newPolicyId,
        link.allocatedNewPremiumMinor,
        link.currency,
        link.allocationOperationId,
        link.differentPolicyholderReasonCode,
        link.createdByMembershipId,
      ]),
    );
}

function insertLink(
  db: D1Database,
  active: ActiveMembership,
  operationId: string,
  now: string,
  id: string,
  link: GroupLinkInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO renewal_policy_links
      (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
       allocation_operation_id,different_policyholder_reason_code,created_by_membership_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      active.agencyId,
      link.renewalId,
      link.newPolicyId,
      link.allocatedNewPremiumMinor,
      link.currency,
      operationId,
      link.differentPolicyholderReasonCode ?? null,
      active.id,
      now,
    );
}

function changesAssertion(db: D1Database, code: string): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), code);
}

function resultFromSnapshot(
  snapshot: GroupSnapshot,
  operationId: string,
  closedAt: string,
): GroupResult {
  const priorByPair = new Map(
    snapshot.priorActiveLinks.map((link) => [`${link.renewalId}\u0000${link.newPolicyId}`, link]),
  );
  return {
    operationId,
    reasonCode: snapshot.request.reasonCode,
    renewals: snapshot.entries.map((entry) => {
      const links = snapshot.request.links
        .filter((link) => link.renewalId === entry.row.renewal_id)
        .map((link) => {
          const prior = priorByPair.get(`${link.renewalId}\u0000${link.newPolicyId}`);
          return {
            id: prior?.id ?? crypto.randomUUID(),
            renewalId: link.renewalId,
            newPolicyId: link.newPolicyId,
            allocatedNewPremiumMinor: link.allocatedNewPremiumMinor,
            currency: link.currency,
            differentPolicyholderReasonCode: link.differentPolicyholderReasonCode,
            allocationOperationId: prior?.allocationOperationId ?? operationId,
            policyVersion: snapshot.targets.find((target) => target.id === link.newPolicyId)!
              .version,
          };
        })
        .sort(
          (left, right) =>
            left.newPolicyId.localeCompare(right.newPolicyId) || left.id.localeCompare(right.id),
        );
      return {
        renewalId: entry.row.renewal_id,
        previousState: entry.row.renewal_state,
        state: 'WON' as const,
        primaryTaskId: entry.row.task_id,
        renewalVersion: entry.row.renewal_version + 1,
        taskVersion: entry.row.task_version + 1,
        closedAt,
        createdPolicyId: null,
        newPolicyIds: [...new Set(links.map((link) => link.newPolicyId))].sort(),
        linkIds: links.map((link) => link.id).sort(),
        links,
      };
    }),
  };
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isGroupReceiptEnvelope(value: unknown): value is GroupReceiptEnvelope {
  if (!hasExactKeys(value, ['binding', 'result'])) return false;
  const binding = value.binding;
  if (
    !hasExactKeys(binding, [
      'action',
      'request',
      'sourceRows',
      'policies',
      'ownerRequired',
      'targetIds',
      'priorActiveLinks',
    ])
  )
    return false;
  if (
    binding.action !== GROUP_ACTION ||
    typeof binding.ownerRequired !== 'boolean' ||
    !Array.isArray(binding.sourceRows) ||
    !Array.isArray(binding.policies) ||
    !Array.isArray(binding.targetIds) ||
    !binding.targetIds.every((id) => typeof id === 'string') ||
    !Array.isArray(binding.priorActiveLinks) ||
    !binding.priorActiveLinks.every(
      (link) =>
        hasExactKeys(link, [
          'id',
          'renewalId',
          'newPolicyId',
          'allocatedNewPremiumMinor',
          'currency',
          'allocationOperationId',
          'differentPolicyholderReasonCode',
          'createdByMembershipId',
        ]) &&
        typeof link.id === 'string' &&
        typeof link.renewalId === 'string' &&
        typeof link.newPolicyId === 'string' &&
        Number.isSafeInteger(link.allocatedNewPremiumMinor) &&
        typeof link.currency === 'string' &&
        typeof link.allocationOperationId === 'string' &&
        (typeof link.differentPolicyholderReasonCode === 'string' ||
          link.differentPolicyholderReasonCode === null) &&
        typeof link.createdByMembershipId === 'string',
    ) ||
    !hasExactKeys(binding.request, ['reasonCode', 'renewals', 'links'])
  )
    return false;
  const request = binding.request;
  if (
    typeof request.reasonCode !== 'string' ||
    !Array.isArray(request.renewals) ||
    !Array.isArray(request.links) ||
    !request.renewals.every(
      (item) =>
        hasExactKeys(item, ['renewalId', 'expectedRenewalVersion', 'expectedTaskVersion']) &&
        typeof item.renewalId === 'string' &&
        Number.isSafeInteger(item.expectedRenewalVersion) &&
        Number.isSafeInteger(item.expectedTaskVersion),
    ) ||
    !request.links.every(
      (item) =>
        hasExactKeys(item, [
          'renewalId',
          'newPolicyId',
          'expectedPolicyVersion',
          'allocatedNewPremiumMinor',
          'currency',
          'differentPolicyholderReasonCode',
        ]) &&
        typeof item.renewalId === 'string' &&
        typeof item.newPolicyId === 'string' &&
        Number.isSafeInteger(item.expectedPolicyVersion) &&
        Number.isSafeInteger(item.allocatedNewPremiumMinor) &&
        typeof item.currency === 'string' &&
        (typeof item.differentPolicyholderReasonCode === 'string' ||
          item.differentPolicyholderReasonCode === null),
    )
  )
    return false;
  if (!hasExactKeys(value.result, ['operationId', 'reasonCode', 'renewals'])) return false;
  const result = value.result;
  if (
    typeof result.operationId !== 'string' ||
    typeof result.reasonCode !== 'string' ||
    !Array.isArray(result.renewals)
  )
    return false;
  return result.renewals.every((item) => {
    if (
      !hasExactKeys(item, [
        'renewalId',
        'previousState',
        'state',
        'primaryTaskId',
        'renewalVersion',
        'taskVersion',
        'closedAt',
        'createdPolicyId',
        'newPolicyIds',
        'linkIds',
        'links',
      ])
    )
      return false;
    return (
      typeof item.renewalId === 'string' &&
      typeof item.previousState === 'string' &&
      item.state === 'WON' &&
      typeof item.primaryTaskId === 'string' &&
      Number.isSafeInteger(item.renewalVersion) &&
      Number.isSafeInteger(item.taskVersion) &&
      typeof item.closedAt === 'string' &&
      item.createdPolicyId === null &&
      Array.isArray(item.newPolicyIds) &&
      item.newPolicyIds.every((id) => typeof id === 'string') &&
      Array.isArray(item.linkIds) &&
      item.linkIds.every((id) => typeof id === 'string') &&
      Array.isArray(item.links) &&
      item.links.every(
        (link) =>
          hasExactKeys(link, [
            'id',
            'renewalId',
            'newPolicyId',
            'allocatedNewPremiumMinor',
            'currency',
            'differentPolicyholderReasonCode',
            'allocationOperationId',
            'policyVersion',
          ]) &&
          typeof link.id === 'string' &&
          typeof link.renewalId === 'string' &&
          typeof link.newPolicyId === 'string' &&
          Number.isSafeInteger(link.allocatedNewPremiumMinor) &&
          typeof link.currency === 'string' &&
          (typeof link.differentPolicyholderReasonCode === 'string' ||
            link.differentPolicyholderReasonCode === null) &&
          typeof link.allocationOperationId === 'string' &&
          Number.isSafeInteger(link.policyVersion),
      )
    );
  });
}

async function proveGroupReplay(
  db: D1Database,
  active: ActiveMembership,
  context: AuthenticatedUserContext,
  receipt: ReceiptRow,
  result: GroupResult,
  binding: Record<string, unknown>,
  key: string,
): Promise<void> {
  for (const item of result.renewals) {
    const linkRows = await db
      .prepare(
        `SELECT l.id,l.new_policy_id,l.allocated_new_premium_minor,l.currency,
                l.different_policyholder_reason_code,l.allocation_operation_id,l.status,
                l.created_by_membership_id,r.action AS allocation_action,
                r.status AS allocation_status,r.response_status AS allocation_response_status,
                r.actor_membership_id AS allocation_actor_membership_id,
                r.response_body AS allocation_response_body
         FROM renewal_policy_links l
         JOIN operation_receipts r ON r.id=l.allocation_operation_id AND r.agency_id=l.agency_id
         WHERE l.agency_id=? AND l.renewal_id=? AND l.id IN (${item.linkIds.map(() => '?').join(',')})
           AND l.status IN ('ACTIVE','SUPERSEDED')`,
      )
      .bind(active.agencyId, item.renewalId, ...item.linkIds)
      .all<{
        id: string;
        new_policy_id: string;
        allocated_new_premium_minor: number;
        currency: string;
        different_policyholder_reason_code: string | null;
        allocation_operation_id: string;
        status: 'ACTIVE' | 'SUPERSEDED';
        created_by_membership_id: string;
        allocation_action: string;
        allocation_status: string;
        allocation_response_status: number | null;
        allocation_actor_membership_id: string;
        allocation_response_body: string | null;
      }>();
    const linkById = new Map(linkRows.results.map((link) => [link.id, link]));
    if (
      !linkRows.success ||
      linkRows.results.length !== item.links.length ||
      item.links.some((expected) => {
        const actual = linkById.get(expected.id);
        if (
          !actual ||
          actual.new_policy_id !== expected.newPolicyId ||
          actual.allocated_new_premium_minor !== expected.allocatedNewPremiumMinor ||
          actual.currency !== expected.currency ||
          actual.different_policyholder_reason_code !== expected.differentPolicyholderReasonCode ||
          actual.allocation_operation_id !== expected.allocationOperationId
        ) {
          return true;
        }
        if (actual.allocation_operation_id === receipt.id) {
          return (
            actual.allocation_action !== GROUP_ACTION ||
            actual.allocation_status !== 'COMPLETED' ||
            actual.allocation_response_status !== 201 ||
            actual.allocation_actor_membership_id !== actual.created_by_membership_id
          );
        }
        return !hasValidAllocationReceipt({
          id: actual.id,
          renewalId: expected.renewalId,
          newPolicyId: actual.new_policy_id,
          allocatedNewPremiumMinor: actual.allocated_new_premium_minor,
          currency: actual.currency,
          allocationOperationId: actual.allocation_operation_id,
          differentPolicyholderReasonCode: actual.different_policyholder_reason_code,
          createdByMembershipId: actual.created_by_membership_id,
          allocationAction: actual.allocation_action,
          allocationStatus: actual.allocation_status,
          allocationResponseStatus: actual.allocation_response_status,
          allocationActorMembershipId: actual.allocation_actor_membership_id,
          allocationResponseBody: actual.allocation_response_body,
        });
      })
    ) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    const proof = await db
      .prepare(
        `SELECT
      (SELECT count(*) FROM tasks WHERE agency_id=? AND renewal_id=? AND id=? AND status='COMPLETED' AND version=? AND completed_at=?) AS task_proof,
      (SELECT count(*) FROM renewal_state_history WHERE agency_id=? AND renewal_id=? AND from_state=? AND to_state='WON'
        AND actor_kind='USER' AND actor_membership_id=? AND reason_code='WON' AND created_at=?) AS history_proof,
      (SELECT count(*) FROM audit_events WHERE agency_id=? AND target_id=? AND actor_user_id=? AND actor_membership_id=?
        AND action='renewal.closed_won' AND idempotency_key=? AND outcome='SUCCESS' AND created_at=?) AS audit_proof`,
      )
      .bind(
        active.agencyId,
        item.renewalId,
        item.primaryTaskId,
        item.taskVersion,
        item.closedAt,
        active.agencyId,
        item.renewalId,
        item.previousState,
        active.id,
        item.closedAt,
        active.agencyId,
        item.renewalId,
        context.userId,
        active.id,
        key,
        item.closedAt,
      )
      .first<{ task_proof: number; history_proof: number; audit_proof: number }>();
    if (proof?.task_proof !== 1 || proof.history_proof !== 1 || proof.audit_proof !== 1)
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const receiptProof = await db
    .prepare(
      `SELECT count(*) AS count FROM operation_receipts WHERE id=? AND agency_id=? AND actor_user_id=?
    AND actor_membership_id=? AND action=? AND idempotency_key=? AND payload_fingerprint=? AND response_body=?`,
    )
    .bind(
      receipt.id,
      active.agencyId,
      context.userId,
      active.id,
      GROUP_ACTION,
      key,
      receipt.payload_fingerprint,
      JSON.stringify({ binding, result }),
    )
    .first<{ count: number }>();
  if (receiptProof?.count !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
}

async function replayGroup(
  context: AuthenticatedUserContext,
  db: D1Database,
  active: ActiveMembership,
  receipt: ReceiptRow,
  request: GroupSnapshot['request'],
  key: string,
): Promise<{ data: GroupResult; replayed: true }> {
  if (!receipt.response_body) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(receipt.response_body);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (!isGroupReceiptEnvelope(envelopeValue)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const { binding, result } = envelopeValue;
  if (JSON.stringify(binding.request) !== JSON.stringify(request)) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  const fingerprint = await computePayloadHash(binding);
  if (
    receipt.action !== GROUP_ACTION ||
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 201 ||
    receipt.payload_fingerprint !== fingerprint ||
    result.operationId !== receipt.id ||
    result.reasonCode !== request.reasonCode ||
    result.renewals.length !== request.renewals.length
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const priorActiveLinks = binding.priorActiveLinks as GroupPriorActiveLink[];
  for (const [index, item] of result.renewals.entries()) {
    const expected = request.renewals[index];
    const expectedLinks = request.links.filter((link) => link.renewalId === item.renewalId);
    const expectedPolicyIds = [...new Set(expectedLinks.map((link) => link.newPolicyId))].sort();
    const expectedLinkIds = [...item.linkIds].sort();
    if (
      !expected ||
      item.renewalId !== expected.renewalId ||
      item.renewalVersion !== expected.expectedRenewalVersion + 1 ||
      item.taskVersion !== expected.expectedTaskVersion + 1 ||
      !OPEN_STATES.includes(item.previousState as (typeof OPEN_STATES)[number]) ||
      item.state !== 'WON' ||
      item.createdPolicyId !== null ||
      !item.primaryTaskId ||
      !isCanonicalTimestamp(item.closedAt) ||
      item.links.length !== expectedLinks.length ||
      JSON.stringify(item.newPolicyIds) !== JSON.stringify(expectedPolicyIds) ||
      JSON.stringify(expectedLinkIds) !==
        JSON.stringify(item.links.map((link) => link.id).sort()) ||
      item.links.some((link) => {
        const requestedLink = expectedLinks.find(
          (candidate) => candidate.newPolicyId === link.newPolicyId,
        );
        const prior = priorActiveLinks.find(
          (candidate) =>
            candidate.renewalId === item.renewalId && candidate.newPolicyId === link.newPolicyId,
        );
        return (
          link.renewalId !== item.renewalId ||
          link.allocationOperationId !== (prior?.allocationOperationId ?? receipt.id) ||
          !requestedLink ||
          requestedLink.expectedPolicyVersion !== link.policyVersion ||
          requestedLink.allocatedNewPremiumMinor !== link.allocatedNewPremiumMinor ||
          requestedLink.currency !== link.currency ||
          requestedLink.differentPolicyholderReasonCode !== link.differentPolicyholderReasonCode ||
          (!!prior &&
            (prior.id !== link.id ||
              prior.allocatedNewPremiumMinor !== link.allocatedNewPremiumMinor ||
              prior.currency !== link.currency ||
              prior.differentPolicyholderReasonCode !== link.differentPolicyholderReasonCode))
        );
      })
    ) {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
  }
  const rows: RenewalTaskRow[] = [];
  const scopes: AuthorizationScopes[] = [];
  for (const item of result.renewals) {
    const row = await loadRenewalTask(db, active.agencyId, item.renewalId);
    if (!row) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    const scope = await authorizeCurrentTarget(db, context, row, WON_ACTION);
    const base = await evaluateAuthorization(db, {
      context,
      action: WON_ACTION,
      resource: {
        agencyId: row.agency_id,
        renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
        customerAssigneeMembershipId: row.customer_assignee_membership_id,
      },
    });
    if (
      scope.terminalAction !== 'AGENCY' ||
      base.decision !== 'ALLOW' ||
      base.effectiveScope !== 'AGENCY'
    )
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    rows.push(row);
    scopes.push(scope);
  }
  const policyIds = [...new Set(result.renewals.flatMap((item) => item.newPolicyIds))].sort();
  const rawTargets = await Promise.all(
    policyIds.map((id) => loadWonPolicy(db, active.agencyId, id)),
  );
  if (rawTargets.some((target) => target === null))
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const targets = await authorizeWonPolicyTargets(
    db,
    context,
    active.agencyId,
    rawTargets.filter((target): target is WonPolicyTarget => target !== null),
  );
  if (
    targets.some(
      (target) => target.policyReadScope !== 'AGENCY' || target.customerReadScope !== 'AGENCY',
    )
  )
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  await proveGroupReplay(db, active, context, receipt, result, binding, key);
  try {
    await db.batch([
      groupActionAuthority(db, context, active),
      ...rows.map((row, index) =>
        actorAuthorityAssertion(
          db,
          context,
          active,
          row,
          scopes[index]!,
          WON_ACTION,
          'task.update',
          scopes[index]!.taskUpdate,
          false,
        ),
      ),
      ...targets.flatMap((target) => [
        wonPolicyReplayReadAssertion(db, context, active, target),
        wonPolicyReplayVersionAssertion(db, active.agencyId, target),
      ]),
    ]);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return { data: result, replayed: true };
}

export async function issueRenewalWonGroupGrant(
  context: AuthenticatedUserContext,
  db: D1Database,
  raw: unknown,
  rawKey: string,
  grantSecret: string,
): Promise<{
  data: { grantId: string; grantEvidenceToken: string; expiresAt: string };
  replayed: boolean;
}> {
  if (context.assurance !== 'SECURE')
    throw new RenewalCommandError('SECURE_ASSURANCE_REQUIRED', 403);
  const input = closeRenewalWonGroupGrantSchema.parse(raw);
  const snapshot = await loadGroupSnapshot(context, db, input);
  await authorizeGroupAction(db, context, snapshot);
  const key = rawKey.trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  const token = await deriveGrantToken(grantSecret, context, snapshot.membership, key);
  const existing = await readGrant(db, token);
  if (existing) {
    if (!(await grantValid(existing, context, snapshot)))
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    return {
      data: { grantId: existing.id, grantEvidenceToken: token, expiresAt: existing.expires_at },
      replayed: true,
    };
  }
  try {
    const grant = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId: snapshot.agencyId,
      action: GROUP_ACTION,
      payloadHash: snapshot.payloadHash,
      targetIds: snapshot.targetIds,
      expectedTargetVersion: null,
      evidenceToken: token,
    });
    return {
      data: {
        grantId: grant.grantRecord.id,
        grantEvidenceToken: grant.grantToken,
        expiresAt: grant.grantRecord.expiresAt,
      },
      replayed: false,
    };
  } catch (error) {
    const raced = await readGrant(db, token);
    if (raced && (await grantValid(raced, context, snapshot)))
      return {
        data: { grantId: raced.id, grantEvidenceToken: token, expiresAt: raced.expires_at },
        replayed: true,
      };
    if (error instanceof Error && /ACTIVE_|MEMBERSHIP_PERMISSION_STALE/.test(error.message))
      throw new RenewalCommandError('FORBIDDEN', 403);
    throw error;
  }
}

export async function closeRenewalWonGroup(
  context: AuthenticatedUserContext,
  db: D1Database,
  raw: unknown,
  rawKey: string,
): Promise<{ data: GroupResult; replayed: boolean; status: 200 | 201 }> {
  if (context.assurance !== 'SECURE')
    throw new RenewalCommandError('SECURE_ASSURANCE_REQUIRED', 403);
  const input = closeRenewalWonGroupSchema.parse(raw);
  const grantInput: CloseRenewalWonGroupGrantInput = {
    reasonCode: input.reasonCode,
    renewals: input.renewals,
    links: input.links,
  };
  const active = activeMembership(context);
  const key = rawKey.trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  const request = canonicalRequest(grantInput);
  const prior = await readReceipt(db, active, context.userId, key);
  if (prior) {
    if (prior.action !== GROUP_ACTION) throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    const replay = await replayGroup(context, db, active, prior, request, key);
    return { data: replay.data, replayed: true, status: 200 };
  }
  const snapshot = await loadGroupSnapshot(context, db, grantInput);
  await authorizeGroupAction(db, context, snapshot);
  const grantBinding = {
    evidence: input.grantEvidenceToken,
    payload: snapshot.binding,
    targetIds: [...snapshot.targetIds],
    expectedTargetVersion: null,
  };
  for (const entry of snapshot.entries) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: GROUP_ACTION,
      resource: {
        agencyId: entry.row.agency_id,
        renewalAssigneeMembershipId: entry.row.renewal_assignee_membership_id,
        customerAssigneeMembershipId: entry.row.customer_assignee_membership_id,
      },
      secureGrantBinding: grantBinding,
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY')
      throw new RenewalCommandError('FORBIDDEN', 403);
  }
  const tokenHash = await computeEvidenceHash(input.grantEvidenceToken);
  const grant = await readGrant(db, input.grantEvidenceToken);
  if (!grant || !(await grantValid(grant, context, snapshot)))
    throw new RenewalCommandError('FORBIDDEN', 403);
  const now = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const result = resultFromSnapshot(snapshot, operationId, now);
  const statements: D1PreparedStatement[] = [
    groupActionAuthority(db, context, active),
    ...snapshot.entries.map((entry) =>
      actorAuthorityAssertion(db, context, active, entry.row, entry.scopes, WON_ACTION),
    ),
    ...snapshot.targets.flatMap((target) => [
      wonPolicyReadAssertion(db, context, active, target),
      wonPolicyVersionAssertion(db, active.agencyId, target),
    ]),
    groupLinkPlanAssertion(db, snapshot),
    consumeGrant(db, context, active, snapshot, tokenHash, operationId, now),
    changesAssertion(db, 'SENSITIVE_ACTION_GRANT_INVALID'),
    groupReceiptInsert(
      db,
      active,
      context,
      key,
      snapshot.payloadHash,
      result,
      snapshot.binding,
      now,
    ),
  ];
  const priorLinkIds = new Set(snapshot.priorActiveLinks.map((link) => link.id));
  for (const item of result.renewals) {
    for (const link of item.links) {
      if (priorLinkIds.has(link.id)) continue;
      statements.push(
        insertLink(db, active, operationId, now, link.id, {
          renewalId: link.renewalId,
          newPolicyId: link.newPolicyId,
          expectedPolicyVersion: link.policyVersion,
          allocatedNewPremiumMinor: link.allocatedNewPremiumMinor,
          currency: link.currency,
          differentPolicyholderReasonCode: link.differentPolicyholderReasonCode,
        }),
        changesAssertion(db, 'RENEWAL_POLICY_LINK_CONFLICT'),
      );
    }
  }
  for (const entry of snapshot.entries) {
    statements.push(
      completePrimaryTaskStatement(db, active, entry.row, now),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      closeRenewalWonStatement(db, active, entry.row, now),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      stateHistoryInsert(db, context, active, entry.row, 'WON', 'WON', now),
      wonAuditStatement(
        db,
        context,
        active,
        'renewal.closed_won',
        'renewal_opportunities',
        entry.row.renewal_id,
        key,
        now,
        {
          reasonCode: 'WON',
          entityCode: request.reasonCode,
          changedFields: ['state', 'closed_at', 'primary_task_status', 'policy_links'],
        },
      ),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, active, context.userId, key);
      if (raced)
        return {
          data: (await replayGroup(context, db, active, raced, request, key)).data,
          replayed: true,
          status: 200,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/MEMBERSHIP_PERMISSION_NOT_FOUND|FINAL_AUTHORITY|SENSITIVE_ACTION_GRANT/.test(message))
      throw new RenewalCommandError('FORBIDDEN', 403);
    if (
      /OPTIMISTIC_CONCURRENCY|RENEWAL_POLICY_LINK|WON_ALLOCATION|RENEWAL_WON|WON_POLICY/.test(
        message,
      )
    )
      throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
    if (/operation_receipts|IDEMPOTENCY_ROW_REPLACEMENT/.test(message))
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    throw error;
  }
  return { data: result, replayed: false, status: 201 };
}
