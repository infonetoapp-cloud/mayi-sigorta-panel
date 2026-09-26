import {
  canonicalizeTargetIds,
  computeEvidenceHash,
  issueAndPersistSensitiveActionGrant,
} from '../mutations/grants';
import { computePayloadHash } from '../mutations/canonical';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { correctWonRenewalSchema, wonRenewalCorrectionGrantSchema } from './validation';
import type { WonRenewalCorrectionInput } from './validation';
import {
  activeMembership,
  actorAuthorityAssertion,
  authorizeWonCorrectionReadScope,
  authorizeWonPolicyTargets,
  casAssertion,
  isCanonicalTimestamp,
  isReceiptRace,
  issueRenewalWonCorrectionGrant,
  loadRenewalTask,
  loadWonLinks,
  loadWonPolicy,
  parseWonCorrectionReceipt,
  readReceipt,
  receiptInsert,
  receiptTaskId,
  reopenTargetState,
  reopenWonRenewalStatement,
  RenewalCommandError,
  stateHistoryInsert,
  validateWonCorrectionState,
  wonCorrectionAuthorityAssertion,
  wonCorrectionAuditInsert,
  wonCorrectionGrantConsumption,
  wonCorrectionLinkSnapshotAssertion,
  wonCorrectionPayload,
  wonCorrectionPrimaryTaskInsert,
  wonPolicyReadAssertion,
  wonPolicyReplayReadAssertion,
  wonPolicyReplayVersionAssertion,
  wonPolicyVersionAssertion,
  type AuthorizationScopes,
  type ActiveMembership,
  type WonCorrectionBaseInput,
  type WonLinkRow,
  type RenewalTaskRow,
  type WonPolicyTarget,
  type RenewalWonCorrectionResult,
} from './commands';

const WON_CORRECTION_ACTION = 'renewal.won.correct';
const WON_GROUP_ACTION = 'renewal.close_won.group';
const WON_GROUP_CORRECTION_RECEIPT_ACTION = 'renewal.won.correct.group';
type WonRenewalCorrectionGrantInput = Omit<WonRenewalCorrectionInput, 'grantEvidenceToken'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface OriginGroupMember {
  readonly renewalId: string;
  readonly previousState: string;
  readonly state: 'WON';
  readonly primaryTaskId: string;
  readonly renewalVersion: number;
  readonly taskVersion: number;
  readonly closedAt: string;
  readonly linkIds: readonly string[];
  readonly links: readonly {
    readonly id: string;
    readonly renewalId: string;
    readonly newPolicyId: string;
    readonly allocatedNewPremiumMinor: number;
    readonly currency: string;
    readonly differentPolicyholderReasonCode: string | null;
    readonly allocationOperationId: string;
    readonly policyVersion: number;
  }[];
}

interface OriginGroupEnvelope {
  readonly binding: Record<string, unknown>;
  readonly result: {
    readonly operationId: string;
    readonly reasonCode: string;
    readonly renewals: readonly OriginGroupMember[];
  };
}

interface GroupCorrectionMember {
  readonly row: import('./commands').RenewalTaskRow;
  readonly scopes: AuthorizationScopes;
  readonly links: readonly WonLinkRow[];
  readonly reopenedState: import('./commands').OpenRenewalState;
  readonly expectedRenewalVersion: number;
  readonly expectedTaskVersion: number;
}

interface GroupCorrectionSnapshot {
  readonly active: ActiveMembership;
  readonly renewalId: string;
  readonly request: WonRenewalCorrectionGrantInput;
  readonly origin: OriginGroupEnvelope['result'];
  readonly originPayloadFingerprint: string;
  readonly members: readonly GroupCorrectionMember[];
  readonly targets: readonly WonPolicyTarget[];
  readonly targetIds: readonly string[];
  readonly targetIdsJson: string;
  readonly binding: Record<string, unknown>;
  readonly payloadHash: string;
}

interface GroupCorrectionResult {
  readonly operationId: string;
  readonly renewalId: string;
  readonly groupOperationId: string;
  readonly correctedAt: string;
  readonly correctionReasonCode: string;
  readonly preservedPolicyIds: readonly string[];
  readonly renewals: readonly RenewalWonCorrectionResult[];
}

interface GroupCorrectionEnvelope {
  readonly binding: Record<string, unknown>;
  readonly result: GroupCorrectionResult;
}

interface GroupCorrectionGrantRow {
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

function correctionBaseInput(input: WonRenewalCorrectionInput): WonCorrectionBaseInput {
  return {
    expectedRenewalVersion: input.expectedRenewalVersion,
    expectedTaskVersion: input.expectedTaskVersion,
    replacementDueAt: input.replacementDueAt,
    correctionReasonCode: input.correctionReasonCode,
  };
}

async function loadGroupCorrectionSnapshot(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  input: WonRenewalCorrectionGrantInput,
): Promise<GroupCorrectionSnapshot | null> {
  const active = activeMembership(context);
  const root = await loadRenewalTask(db, active.agencyId, renewalId);
  if (!root) throw new RenewalCommandError('NOT_FOUND', 404);
  validateWonCorrectionState(root, input);
  const rootLinks = await loadWonLinks(db, active.agencyId, renewalId);
  if (!rootLinks.links.length) return null;
  const operationIds = [...new Set(rootLinks.links.map((link) => link.allocationOperationId))];
  if (operationIds.length !== 1) return null;
  const receipt = await db
    .prepare(
      `SELECT action,status,response_status,response_body,payload_fingerprint FROM operation_receipts WHERE id=? AND agency_id=?`,
    )
    .bind(operationIds[0], active.agencyId)
    .first<{
      action: string;
      status: string;
      response_status: number;
      response_body: string;
      payload_fingerprint: string;
    }>();
  if (!receipt || receipt.action !== WON_GROUP_ACTION) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(receipt.response_body);
  } catch {
    throw new RenewalCommandError('WON_GROUP_NOT_FOUND', 404);
  }
  if (!isRecord(raw) || !isRecord(raw.binding) || !isRecord(raw.result))
    throw new RenewalCommandError('WON_GROUP_NOT_FOUND', 404);
  const origin = raw.result as unknown as OriginGroupEnvelope['result'];
  if (
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 201 ||
    origin.operationId !== operationIds[0] ||
    !Array.isArray(origin.renewals) ||
    origin.renewals.length < 2 ||
    (await computePayloadHash(raw.binding)) !== receipt.payload_fingerprint ||
    !origin.renewals.some((item) => item.renewalId === renewalId)
  )
    throw new RenewalCommandError('WON_GROUP_NOT_FOUND', 404);
  const members: GroupCorrectionMember[] = [];
  for (const item of origin.renewals) {
    const row = await loadRenewalTask(db, active.agencyId, item.renewalId);
    if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
    const expectedRenewalVersion =
      item.renewalId === renewalId ? input.expectedRenewalVersion : row.renewal_version;
    const expectedTaskVersion =
      item.renewalId === renewalId ? input.expectedTaskVersion : row.task_version;
    if (
      row.renewal_state !== 'WON' ||
      row.task_status !== 'COMPLETED' ||
      row.task_id !== item.primaryTaskId ||
      row.renewal_version !== expectedRenewalVersion ||
      row.task_version !== expectedTaskVersion ||
      row.renewal_version !== item.renewalVersion ||
      row.task_version !== item.taskVersion ||
      row.renewal_closed_at !== item.closedAt
    )
      throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
    const current = await loadWonLinks(db, active.agencyId, item.renewalId);
    if (
      current.links.length !== item.links.length ||
      current.links.some(
        (link) =>
          !item.links.some(
            (expected: OriginGroupMember['links'][number]) =>
              expected.id === link.id &&
              expected.newPolicyId === link.newPolicyId &&
              expected.allocatedNewPremiumMinor === link.allocatedNewPremiumMinor &&
              expected.currency === link.currency &&
              expected.differentPolicyholderReasonCode ===
                link.different_policyholder_reason_code &&
              expected.allocationOperationId === link.allocationOperationId,
          ),
      )
    )
      throw new RenewalCommandError('RENEWAL_POLICY_LINK_CONFLICT', 409);
    const scopes = await authorizeWonCorrectionReadScope(db, context, row);
    members.push({
      row,
      scopes,
      links: current.links,
      reopenedState: await reopenTargetState(db, row),
      expectedRenewalVersion,
      expectedTaskVersion,
    });
  }
  const policyIds = [
    ...new Set(members.flatMap((member) => member.links.map((link) => link.newPolicyId))),
  ].sort();
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
  )
    throw new RenewalCommandError('FORBIDDEN', 403);
  const ownerReviewRequired = members.some((member) =>
    member.links.some((link) => {
      const target = targets.find((candidate) => candidate.id === link.newPolicyId);
      return (
        link.different_policyholder_reason_code !== null ||
        target?.customer_id !== member.row.customer_id
      );
    }),
  );
  if (ownerReviewRequired && active.type !== 'OWNER')
    throw new RenewalCommandError('OWNER_REVIEW_REQUIRED', 403);
  const targetGroups = [
    [...new Set(members.map((member) => member.row.renewal_id))],
    [...new Set(members.map((member) => member.row.policy_id))],
    policyIds,
    [...new Set(targets.map((target) => target.customer_id))],
  ];
  for (let i = 0; i < targetGroups.length; i += 1)
    for (let j = i + 1; j < targetGroups.length; j += 1)
      if (targetGroups[i]!.some((id) => targetGroups[j]!.includes(id)))
        throw new RenewalCommandError('WON_GROUP_TARGET_COLLISION', 400);
  let targetIdsJson: string;
  try {
    targetIdsJson = canonicalizeTargetIds(targetGroups.flat());
  } catch {
    throw new RenewalCommandError('WON_GROUP_TARGET_INVALID', 400);
  }
  const targetIds = JSON.parse(targetIdsJson) as string[];
  const request = {
    renewalId,
    expectedRenewalVersion: input.expectedRenewalVersion,
    expectedTaskVersion: input.expectedTaskVersion,
    replacementDueAt: input.replacementDueAt,
    correctionReasonCode: input.correctionReasonCode,
  };
  const binding: Record<string, unknown> = {
    action: WON_GROUP_CORRECTION_RECEIPT_ACTION,
    request,
    groupOperationId: origin.operationId,
    originPayloadFingerprint: receipt.payload_fingerprint,
    ownerReviewRequired,
    targetIds,
    members: members.map((member) => ({
      renewalId: member.row.renewal_id,
      sourcePolicyId: member.row.policy_id,
      customerId: member.row.customer_id,
      renewalVersion: member.row.renewal_version,
      taskId: member.row.task_id,
      taskVersion: member.row.task_version,
      closedAt: member.row.renewal_closed_at,
      reopenedState: member.reopenedState,
      linkIds: member.links.map((link) => link.id).sort(),
    })),
    links: members
      .flatMap((member) =>
        member.links.map((link) => ({
          renewalId: member.row.renewal_id,
          id: link.id,
          newPolicyId: link.newPolicyId,
          amount: link.allocatedNewPremiumMinor,
          currency: link.currency,
          allocationOperationId: link.allocationOperationId,
          differentPolicyholderReasonCode: link.different_policyholder_reason_code,
        })),
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
    policies: targets.map((target) => ({
      id: target.id,
      version: target.version,
      status: target.status,
      archivedAt: target.archived_at,
      customerId: target.customer_id,
      currency: target.currency,
      grossPremiumMinor: target.gross_premium_minor,
      dataClassification: target.data_classification,
    })),
  };
  return {
    active,
    renewalId,
    request: input,
    origin,
    originPayloadFingerprint: receipt.payload_fingerprint,
    members,
    targets,
    targetIds,
    targetIdsJson,
    binding,
    payloadHash: await computePayloadHash(binding),
  };
}

async function assertWonCorrectionReplay(
  db: D1Database,
  agencyId: string,
  receipt: {
    readonly id: string;
    readonly payload_fingerprint: string;
  },
  actorMembershipId: string,
  result: RenewalWonCorrectionResult,
  idempotencyKey: string,
): Promise<void> {
  const [linkProof, policyProof, eventProof] = await Promise.all([
    db
      .prepare(
        `SELECT count(*) AS count FROM renewal_policy_links
         WHERE agency_id=? AND renewal_id=? AND status='SUPERSEDED'
           AND id IN (${result.supersededLinkIds.map(() => '?').join(',')})
           AND superseded_operation_id=? AND superseded_by_membership_id=?
           AND supersede_reason_code='WON_CORRECTED'`,
      )
      .bind(agencyId, result.renewalId, ...result.supersededLinkIds, receipt.id, actorMembershipId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT count(*) AS count FROM policies
         WHERE agency_id=? AND id IN (${result.preservedPolicyIds.map(() => '?').join(',')})`,
      )
      .bind(agencyId, ...result.preservedPolicyIds)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT
           (SELECT count(*) FROM tasks WHERE agency_id=? AND renewal_id=? AND id=?
             AND kind='RENEWAL_FOLLOWUP') AS replacement_task,
           (SELECT count(*) FROM tasks WHERE agency_id=? AND renewal_id=? AND id=?
             AND kind='RENEWAL_FOLLOWUP' AND status='COMPLETED' AND version=?
             AND completed_at=?) AS closed_task,
           (SELECT count(*) FROM renewal_state_history WHERE agency_id=? AND renewal_id=?
             AND from_state='WON' AND to_state=? AND actor_kind='USER'
             AND actor_membership_id=? AND reason_code='WON_CORRECTED' AND created_at=?) AS correction_history,
           (SELECT count(*) FROM audit_events WHERE agency_id=? AND target_id=?
             AND action='renewal.won.corrected' AND idempotency_key=? AND outcome='SUCCESS'
             AND created_at=?) AS correction_audit,
           (SELECT count(*) FROM audit_events WHERE agency_id=? AND target_id=?
             AND action='renewal.closed_won' AND outcome='SUCCESS' AND created_at=?) AS prior_won_audit,
           (SELECT count(*) FROM operation_receipts WHERE id=? AND agency_id=?
             AND action=? AND idempotency_key=? AND payload_fingerprint=? AND response_body=?) AS receipt_proof`,
      )
      .bind(
        agencyId,
        result.renewalId,
        result.primaryTaskId,
        agencyId,
        result.renewalId,
        result.closedTaskId,
        result.closedTaskVersion,
        result.terminalClosedAt,
        agencyId,
        result.renewalId,
        result.state,
        actorMembershipId,
        result.correctedAt,
        agencyId,
        result.renewalId,
        idempotencyKey,
        result.correctedAt,
        agencyId,
        result.renewalId,
        result.terminalClosedAt,
        receipt.id,
        agencyId,
        WON_CORRECTION_ACTION,
        idempotencyKey,
        receipt.payload_fingerprint,
        JSON.stringify(result),
      )
      .first<{
        replacement_task: number;
        closed_task: number;
        correction_history: number;
        correction_audit: number;
        prior_won_audit: number;
        receipt_proof: number;
      }>(),
  ]);
  if (
    linkProof?.count !== result.supersededLinkIds.length ||
    policyProof?.count !== result.preservedPolicyIds.length ||
    eventProof?.replacement_task !== 1 ||
    eventProof.closed_task !== 1 ||
    eventProof.correction_history !== 1 ||
    eventProof.correction_audit !== 1 ||
    eventProof.prior_won_audit < 1 ||
    eventProof.receipt_proof !== 1
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

async function replayWonCorrection(
  context: AuthenticatedUserContext,
  db: D1Database,
  active: ReturnType<typeof activeMembership>,
  receipt: NonNullable<Awaited<ReturnType<typeof readReceipt>>>,
  input: WonRenewalCorrectionInput,
  fingerprintValue: string,
  renewalId: string,
  idempotencyKey: string,
): Promise<{ data: RenewalWonCorrectionResult; replayed: true }> {
  const result = parseWonCorrectionReceipt(receipt, fingerprintValue, input, renewalId);
  const row = await loadRenewalTask(db, active.agencyId, renewalId, result.primaryTaskId);
  if (!row) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  let scopes: AuthorizationScopes;
  try {
    scopes = await authorizeWonCorrectionReadScope(db, context, row);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const policyIds = result.preservedPolicyIds.filter((id) => id !== row.policy_id);
  const rows = await Promise.all(policyIds.map((id) => loadWonPolicy(db, active.agencyId, id)));
  if (rows.some((target) => target === null)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const targets = await authorizeWonPolicyTargets(
    db,
    context,
    active.agencyId,
    rows.filter((target): target is WonPolicyTarget => target !== null),
  );
  if (
    targets.some(
      (target) => target.policyReadScope !== 'AGENCY' || target.customerReadScope !== 'AGENCY',
    )
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  await assertWonCorrectionReplay(db, active.agencyId, receipt, active.id, result, idempotencyKey);
  try {
    await db.batch([
      actorAuthorityAssertion(
        db,
        context,
        active,
        row,
        scopes,
        WON_CORRECTION_ACTION,
        'task.create',
        scopes.taskUpdate,
        false,
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

async function groupCorrectionGrantToken(
  secret: string,
  context: AuthenticatedUserContext,
  snapshot: GroupCorrectionSnapshot,
  key: string,
): Promise<string> {
  if (secret.length < 32) throw new RenewalCommandError('GRANT_KEY_UNAVAILABLE', 500);
  const bindingHash = await computePayloadHash({
    purpose: 'renewal.won.correct.group.grant',
    agencyId: snapshot.active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: snapshot.active.id,
    identityId: context.identityId,
    groupOperationId: snapshot.origin.operationId,
    idempotencyKey: key,
  });
  const encoder = new TextEncoder();
  const masterKey = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  const hmacKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('mayi-sigorta-v1'),
      info: encoder.encode('renewal-won-group-correction/grant-evidence'),
    },
    masterKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    encoder.encode(`grant-evidence-v1\u0000${bindingHash}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function readGroupCorrectionGrant(
  db: D1Database,
  evidenceHash: string,
): Promise<GroupCorrectionGrantRow | null> {
  return db
    .prepare(
      `SELECT id,issued_at,expires_at,status,agency_id,actor_user_id,actor_membership_id,action,
      payload_hash,target_ids_json,expected_target_version,permission_version,assurance,revoked_at
    FROM sensitive_action_grants WHERE evidence_hash=?`,
    )
    .bind(evidenceHash)
    .first<GroupCorrectionGrantRow>();
}

function groupGrantIsValid(
  grant: GroupCorrectionGrantRow,
  context: AuthenticatedUserContext,
  snapshot: GroupCorrectionSnapshot,
): boolean {
  const now = Date.now();
  return (
    grant.status === 'ISSUED' &&
    grant.revoked_at === null &&
    grant.agency_id === snapshot.active.agencyId &&
    grant.actor_user_id === context.userId &&
    grant.actor_membership_id === snapshot.active.id &&
    grant.action === WON_CORRECTION_ACTION &&
    grant.payload_hash === snapshot.payloadHash &&
    grant.target_ids_json === snapshot.targetIdsJson &&
    grant.expected_target_version === null &&
    grant.permission_version === snapshot.active.permissionVersion &&
    grant.assurance === 'SECURE_GRANT' &&
    Date.parse(grant.issued_at) <= now &&
    Date.parse(grant.expires_at) > now
  );
}

export async function issueWonRenewalCorrectionGrant(
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
  const input = wonRenewalCorrectionGrantSchema.parse(rawInput);
  if (!isCanonicalTimestamp(input.replacementDueAt))
    throw new RenewalCommandError('REOPEN_DUE_AT_INVALID', 400);
  const key = rawIdempotencyKey.trim();
  if (!key || key.length > 128) throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  const snapshot = await loadGroupCorrectionSnapshot(context, db, renewalId, input);
  if (!snapshot) {
    const single = await issueRenewalWonCorrectionGrant(
      context,
      db,
      renewalId,
      rawInput,
      key,
      grantSecret,
    );
    return single;
  }
  const token = await groupCorrectionGrantToken(grantSecret, context, snapshot, key);
  const evidenceHash = await computeEvidenceHash(token);
  const existing = await readGroupCorrectionGrant(db, evidenceHash);
  if (existing) {
    if (!groupGrantIsValid(existing, context, snapshot))
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    return {
      grantId: existing.id,
      grantEvidenceToken: token,
      expiresAt: existing.expires_at,
      replayed: true,
    };
  }
  try {
    const issued = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId: snapshot.active.agencyId,
      action: WON_CORRECTION_ACTION,
      payloadHash: snapshot.payloadHash,
      targetIds: snapshot.targetIds,
      expectedTargetVersion: null,
      evidenceToken: token,
    });
    return {
      grantId: issued.grantRecord.id,
      grantEvidenceToken: issued.grantToken,
      expiresAt: issued.grantRecord.expiresAt,
      replayed: false,
    };
  } catch (error) {
    const raced = await readGroupCorrectionGrant(db, evidenceHash);
    if (raced && groupGrantIsValid(raced, context, snapshot))
      return {
        grantId: raced.id,
        grantEvidenceToken: token,
        expiresAt: raced.expires_at,
        replayed: true,
      };
    throw error;
  }
}

export function groupCorrectionReceiptInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  snapshot: GroupCorrectionSnapshot,
  key: string,
  result: GroupCorrectionResult,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operation_receipts
         (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
          status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
    )
    .bind(
      result.operationId,
      snapshot.active.agencyId,
      context.userId,
      snapshot.active.id,
      WON_GROUP_CORRECTION_RECEIPT_ACTION,
      key,
      snapshot.payloadHash,
      JSON.stringify({ binding: snapshot.binding, result }),
      result.correctedAt,
      result.correctedAt,
    );
}

function groupCorrectionGrantConsume(
  db: D1Database,
  context: AuthenticatedUserContext,
  snapshot: GroupCorrectionSnapshot,
  evidenceHash: string,
  operationId: string,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sensitive_action_grants SET status='CONSUMED',consumed_at=?,consumed_operation_id=?,updated_at=?
       WHERE evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=?
         AND action=? AND payload_hash=? AND target_ids_json=? AND expected_target_version IS NULL
         AND permission_version=? AND assurance='SECURE_GRANT' AND status='ISSUED'
         AND consumed_at IS NULL AND revoked_at IS NULL
         AND julianday(issued_at)<=julianday(?) AND julianday(expires_at)>julianday(?)`,
    )
    .bind(
      now,
      operationId,
      now,
      evidenceHash,
      snapshot.active.agencyId,
      context.userId,
      snapshot.active.id,
      WON_CORRECTION_ACTION,
      snapshot.payloadHash,
      snapshot.targetIdsJson,
      snapshot.active.permissionVersion,
      now,
      now,
    );
}

function groupCorrectionActionAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
         JOIN agencies a ON a.id=m.agency_id
         JOIN auth_identities ai ON ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE'
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND m.permission_version=? AND u.status='ACTIVE' AND a.status='ACTIVE'
           AND (m.type='OWNER' OR EXISTS(
             SELECT 1 FROM membership_permissions p WHERE p.membership_id=m.id
               AND p.permission_code='renewal.update' AND p.scope='AGENCY'))
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

function groupCorrectionMemberResult(
  member: GroupCorrectionMember,
  snapshot: GroupCorrectionSnapshot,
  correctedAt: string,
): RenewalWonCorrectionResult {
  return {
    renewalId: member.row.renewal_id,
    previousState: 'WON',
    state: member.reopenedState,
    closedTaskId: member.row.task_id,
    closedTaskVersion: member.row.task_version,
    terminalClosedAt: member.row.renewal_closed_at!,
    primaryTaskId: crypto.randomUUID(),
    renewalVersion: member.row.renewal_version + 1,
    taskVersion: 1,
    correctedAt,
    correctionReasonCode: snapshot.request.correctionReasonCode,
    supersededLinkIds: member.links.map((link) => link.id).sort(),
    preservedPolicyIds: [
      ...new Set([member.row.policy_id, ...member.links.map((link) => link.newPolicyId)]),
    ].sort(),
  };
}

function groupCorrectionReceiptShape(value: unknown): value is GroupCorrectionEnvelope {
  if (!isRecord(value) || !isRecord(value.binding) || !isRecord(value.result)) return false;
  const result = value.result as Record<string, unknown>;
  return (
    typeof result.operationId === 'string' &&
    typeof result.renewalId === 'string' &&
    typeof result.groupOperationId === 'string' &&
    typeof result.correctedAt === 'string' &&
    typeof result.correctionReasonCode === 'string' &&
    Array.isArray(result.renewals) &&
    result.renewals.length >= 2 &&
    result.renewals.every(
      (member) =>
        isRecord(member) &&
        typeof member.renewalId === 'string' &&
        Array.isArray(member.supersededLinkIds),
    )
  );
}

function groupCorrectionRequest(
  renewalId: string,
  input: WonRenewalCorrectionInput,
): Record<string, unknown> {
  return {
    renewalId,
    expectedRenewalVersion: input.expectedRenewalVersion,
    expectedTaskVersion: input.expectedTaskVersion,
    replacementDueAt: input.replacementDueAt,
    correctionReasonCode: input.correctionReasonCode,
  };
}

async function replayGroupCorrection(
  context: AuthenticatedUserContext,
  db: D1Database,
  active: ActiveMembership,
  receipt: NonNullable<Awaited<ReturnType<typeof readReceipt>>>,
  input: WonRenewalCorrectionInput,
  renewalId: string,
  key: string,
): Promise<{ data: GroupCorrectionResult; replayed: true }> {
  if (
    receipt.action !== WON_GROUP_CORRECTION_RECEIPT_ACTION ||
    receipt.response_status !== 200 ||
    !receipt.response_body
  )
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  let raw: unknown;
  try {
    raw = JSON.parse(receipt.response_body);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (!groupCorrectionReceiptShape(raw))
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const { binding, result } = raw;
  if (JSON.stringify(binding.request) !== JSON.stringify(groupCorrectionRequest(renewalId, input)))
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  if (
    result.operationId !== receipt.id ||
    result.renewalId !== renewalId ||
    result.correctionReasonCode !== input.correctionReasonCode ||
    (await computePayloadHash(binding)) !== receipt.payload_fingerprint
  )
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const currentRows: RenewalTaskRow[] = [];
  const currentScopes: AuthorizationScopes[] = [];
  for (const member of result.renewals) {
    const row = await loadRenewalTask(db, active.agencyId, member.renewalId);
    if (
      !row ||
      row.renewal_state !== member.state ||
      row.renewal_version !== member.renewalVersion ||
      row.task_id !== member.primaryTaskId ||
      row.task_status !== 'OPEN' ||
      row.task_version !== member.taskVersion
    )
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    let scopes: AuthorizationScopes;
    try {
      scopes = await authorizeWonCorrectionReadScope(db, context, row);
    } catch {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    currentRows.push(row);
    currentScopes.push(scopes);
  }
  const preserved = await Promise.all(
    result.preservedPolicyIds.map((id) => loadWonPolicy(db, active.agencyId, id)),
  );
  if (preserved.some((target) => target === null))
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const targets = await authorizeWonPolicyTargets(
    db,
    context,
    active.agencyId,
    preserved.filter((target): target is WonPolicyTarget => target !== null),
  );
  if (
    targets.some(
      (target) => target.policyReadScope !== 'AGENCY' || target.customerReadScope !== 'AGENCY',
    )
  )
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  const linkIds = result.renewals.flatMap((member) => member.supersededLinkIds);
  const links = await db
    .prepare(
      `SELECT count(*) AS count FROM renewal_policy_links WHERE agency_id=? AND status='SUPERSEDED'
      AND superseded_operation_id=? AND superseded_by_membership_id=? AND supersede_reason_code='WON_CORRECTED'
      AND id IN (${linkIds.map(() => '?').join(',')})`,
    )
    .bind(active.agencyId, receipt.id, active.id, ...linkIds)
    .first<{ count: number }>();
  if (links?.count !== linkIds.length) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  for (const member of result.renewals) {
    const proof = await db
      .prepare(
        `SELECT
        (SELECT count(*) FROM tasks WHERE agency_id=? AND renewal_id=? AND id=? AND status='COMPLETED'
          AND version=? AND completed_at=?) AS closed_task,
        (SELECT count(*) FROM renewal_state_history WHERE agency_id=? AND renewal_id=? AND from_state='WON'
          AND to_state=? AND actor_kind='USER' AND actor_user_id=? AND actor_membership_id=?
          AND reason_code='WON_CORRECTED' AND created_at=?) AS correction_history,
        (SELECT count(*) FROM audit_events WHERE agency_id=? AND target_id=?
          AND action='renewal.won.corrected' AND idempotency_key=? AND outcome='SUCCESS' AND created_at=?) AS correction_audit,
        (SELECT count(*) FROM audit_events WHERE agency_id=? AND target_id=?
          AND action='renewal.closed_won' AND outcome='SUCCESS' AND created_at=?) AS won_audit,
        (SELECT count(*) FROM operation_receipts WHERE id=? AND agency_id=? AND action=?
          AND idempotency_key=? AND payload_fingerprint=? AND response_body=?) AS receipt_proof`,
      )
      .bind(
        active.agencyId,
        member.renewalId,
        member.closedTaskId,
        member.closedTaskVersion,
        member.terminalClosedAt,
        active.agencyId,
        member.renewalId,
        member.state,
        context.userId,
        active.id,
        member.correctedAt,
        active.agencyId,
        member.renewalId,
        key,
        member.correctedAt,
        active.agencyId,
        member.renewalId,
        member.terminalClosedAt,
        receipt.id,
        active.agencyId,
        WON_GROUP_CORRECTION_RECEIPT_ACTION,
        key,
        receipt.payload_fingerprint,
        JSON.stringify({ binding, result }),
      )
      .first<{
        closed_task: number;
        correction_history: number;
        correction_audit: number;
        won_audit: number;
        receipt_proof: number;
      }>();
    if (
      proof?.closed_task !== 1 ||
      proof.correction_history !== 1 ||
      proof.correction_audit !== 1 ||
      proof.won_audit < 1 ||
      proof.receipt_proof !== 1
    )
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  try {
    await db.batch([
      groupCorrectionActionAssertion(db, context, active),
      ...currentRows.map((row, index) =>
        actorAuthorityAssertion(
          db,
          context,
          active,
          row,
          currentScopes[index]!,
          WON_CORRECTION_ACTION,
          'task.create',
          currentScopes[index]!.taskUpdate,
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

async function executeGroupCorrection(
  context: AuthenticatedUserContext,
  db: D1Database,
  snapshot: GroupCorrectionSnapshot,
  input: WonRenewalCorrectionInput,
  key: string,
): Promise<{ data: GroupCorrectionResult; replayed: boolean }> {
  for (const member of snapshot.members) {
    const decision = await evaluateAuthorization(db, {
      context,
      action: WON_CORRECTION_ACTION,
      resource: {
        agencyId: member.row.agency_id,
        renewalAssigneeMembershipId: member.row.renewal_assignee_membership_id,
        customerAssigneeMembershipId: member.row.customer_assignee_membership_id,
      },
      secureGrantBinding: {
        evidence: input.grantEvidenceToken,
        payload: snapshot.binding,
        targetIds: snapshot.targetIds,
        expectedTargetVersion: null,
      },
    });
    if (decision.decision !== 'ALLOW' || decision.effectiveScope !== 'AGENCY')
      throw new RenewalCommandError('FORBIDDEN', 403);
  }
  const evidenceHash = await computeEvidenceHash(input.grantEvidenceToken);
  const grant = await readGroupCorrectionGrant(db, evidenceHash);
  if (!grant || !groupGrantIsValid(grant, context, snapshot))
    throw new RenewalCommandError('FORBIDDEN', 403);
  const correctedAt = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const members = snapshot.members.map((member) =>
    groupCorrectionMemberResult(member, snapshot, correctedAt),
  );
  const result: GroupCorrectionResult = {
    operationId,
    renewalId: snapshot.renewalId,
    groupOperationId: snapshot.origin.operationId,
    correctedAt,
    correctionReasonCode: snapshot.request.correctionReasonCode,
    preservedPolicyIds: [...new Set(members.flatMap((member) => member.preservedPolicyIds))].sort(),
    renewals: members,
  };
  const statements: D1PreparedStatement[] = [
    groupCorrectionActionAssertion(db, context, snapshot.active),
    ...snapshot.members.map((member) =>
      actorAuthorityAssertion(
        db,
        context,
        snapshot.active,
        member.row,
        member.scopes,
        WON_CORRECTION_ACTION,
        'task.create',
        member.scopes.taskUpdate,
        false,
      ),
    ),
    ...snapshot.members.map((member) =>
      wonCorrectionLinkSnapshotAssertion(
        db,
        snapshot.active.agencyId,
        member.row.renewal_id,
        member.links,
      ),
    ),
    ...snapshot.targets.flatMap((target) => [
      wonPolicyReplayReadAssertion(db, context, snapshot.active, target),
      wonPolicyReplayVersionAssertion(db, snapshot.active.agencyId, target),
    ]),
    groupCorrectionGrantConsume(db, context, snapshot, evidenceHash, operationId, correctedAt),
    casAssertion(db, 'SENSITIVE_ACTION_GRANT_INVALID'),
    groupCorrectionReceiptInsert(db, context, snapshot, key, result),
  ];
  for (let index = 0; index < snapshot.members.length; index += 1) {
    const member = snapshot.members[index]!;
    const memberInput: WonRenewalCorrectionInput = {
      expectedRenewalVersion: member.expectedRenewalVersion,
      expectedTaskVersion: member.expectedTaskVersion,
      replacementDueAt: input.replacementDueAt,
      correctionReasonCode: input.correctionReasonCode,
      grantEvidenceToken: input.grantEvidenceToken,
    };
    statements.push(
      stateHistoryInsert(
        db,
        context,
        snapshot.active,
        member.row,
        member.reopenedState,
        'WON_CORRECTED',
        correctedAt,
      ),
      casAssertion(db, 'BUSINESS_MUTATION_FAILED'),
      reopenWonRenewalStatement(
        db,
        snapshot.active,
        member.row,
        memberInput,
        member.reopenedState,
        correctedAt,
      ),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
    );
  }
  for (const member of snapshot.members) {
    for (const link of member.links) {
      statements.push(
        db
          .prepare(
            `UPDATE renewal_policy_links SET status='SUPERSEDED',superseded_at=?,
          superseded_by_membership_id=?,supersede_reason_code='WON_CORRECTED',superseded_operation_id=?
        WHERE agency_id=? AND renewal_id=? AND id=? AND status='ACTIVE'`,
          )
          .bind(
            correctedAt,
            snapshot.active.id,
            operationId,
            snapshot.active.agencyId,
            member.row.renewal_id,
            link.id,
          ),
        casAssertion(db, 'RENEWAL_POLICY_LINK_CONFLICT'),
      );
    }
  }
  for (let index = 0; index < snapshot.members.length; index += 1) {
    const member = snapshot.members[index]!;
    const resultMember = members[index]!;
    const memberInput: WonRenewalCorrectionInput = {
      expectedRenewalVersion: member.expectedRenewalVersion,
      expectedTaskVersion: member.expectedTaskVersion,
      replacementDueAt: input.replacementDueAt,
      correctionReasonCode: input.correctionReasonCode,
      grantEvidenceToken: input.grantEvidenceToken,
    };
    statements.push(
      wonCorrectionPrimaryTaskInsert(
        db,
        context,
        snapshot.active,
        member.row,
        resultMember,
        memberInput,
      ),
      casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      wonCorrectionAuditInsert(db, context, snapshot.active, resultMember, key),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, snapshot.active, context.userId, key);
      if (raced)
        return replayGroupCorrection(
          context,
          db,
          snapshot.active,
          raced,
          input,
          snapshot.renewalId,
          key,
        );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      /MEMBERSHIP_PERMISSION_NOT_FOUND|SENSITIVE_ACTION_GRANT_INVALID|FINAL_AUTHORITY/.test(message)
    )
      throw new RenewalCommandError('FORBIDDEN', 403);
    if (/OPTIMISTIC_CONCURRENCY|RENEWAL_POLICY_LINK|WON_CORRECTION|RENEWAL_WON/.test(message))
      throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
    if (/operation_receipts|IDEMPOTENCY_ROW_REPLACEMENT/.test(message))
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    throw error;
  }
  return { data: result, replayed: false };
}

export async function correctWonRenewal(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawIdempotencyKey: string,
): Promise<{ data: RenewalWonCorrectionResult | GroupCorrectionResult; replayed: boolean }> {
  if (context.assurance !== 'SECURE') {
    throw new RenewalCommandError('SECURE_ASSURANCE_REQUIRED', 403);
  }
  const active = activeMembership(context);
  const input = correctWonRenewalSchema.parse(rawInput);
  const baseInput = correctionBaseInput(input);
  if (!isCanonicalTimestamp(input.replacementDueAt)) {
    throw new RenewalCommandError('REOPEN_DUE_AT_INVALID', 400);
  }
  const idempotencyKey = rawIdempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  }
  const fingerprintValue = await computePayloadHash({
    action: WON_CORRECTION_ACTION,
    target: renewalId,
    payload: baseInput,
    version: {
      expectedRenewalVersion: input.expectedRenewalVersion,
      expectedTaskVersion: input.expectedTaskVersion,
    },
  });
  const receipt = await readReceipt(db, active, context.userId, idempotencyKey);
  const receiptRenewalId = (() => {
    if (!receipt?.response_body) return null;
    try {
      const body = JSON.parse(receipt.response_body) as Record<string, unknown>;
      const data = isRecord(body.result) ? body.result : body;
      return typeof data.renewalId === 'string' ? data.renewalId : null;
    } catch {
      return null;
    }
  })();
  const sameTarget = receiptRenewalId === renewalId;
  const row = await loadRenewalTask(
    db,
    active.agencyId,
    renewalId,
    receipt && receipt.action !== WON_GROUP_CORRECTION_RECEIPT_ACTION && sameTarget
      ? receiptTaskId(receipt)
      : undefined,
  );
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  if (receipt) {
    if (!sameTarget) throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    if (receipt.action === WON_GROUP_CORRECTION_RECEIPT_ACTION) {
      return replayGroupCorrection(context, db, active, receipt, input, renewalId, idempotencyKey);
    }
    if (receipt.action !== WON_CORRECTION_ACTION)
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    return replayWonCorrection(
      context,
      db,
      active,
      receipt,
      input,
      fingerprintValue,
      renewalId,
      idempotencyKey,
    );
  }

  const groupSnapshot = await loadGroupCorrectionSnapshot(context, db, renewalId, input);
  if (groupSnapshot)
    return executeGroupCorrection(context, db, groupSnapshot, input, idempotencyKey);

  validateWonCorrectionState(row, baseInput);
  const scopes = await authorizeWonCorrectionReadScope(db, context, row);
  const currentLinks = await loadWonLinks(db, active.agencyId, renewalId);
  if (!currentLinks.links.length) throw new RenewalCommandError('WON_POLICY_LINK_REQUIRED', 409);
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
    currentLinks.links.some((link: WonLinkRow) => link.different_policyholder_reason_code !== null)
  ) {
    if (active.type !== 'OWNER') throw new RenewalCommandError('OWNER_REVIEW_REQUIRED', 403);
  }
  const boundPayload = wonCorrectionPayload(row, baseInput, currentLinks.links, targets);
  const payloadHash = await computePayloadHash(boundPayload);
  const authorization = await evaluateAuthorization(db, {
    context,
    action: WON_CORRECTION_ACTION,
    resource: {
      agencyId: row.agency_id,
      renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
      customerAssigneeMembershipId: row.customer_assignee_membership_id,
    },
    secureGrantBinding: {
      evidence: input.grantEvidenceToken,
      payload: boundPayload,
      targetIds: [renewalId],
      expectedTargetVersion: input.expectedRenewalVersion,
    },
  });
  if (authorization.decision !== 'ALLOW' || authorization.effectiveScope !== 'AGENCY') {
    throw new RenewalCommandError('FORBIDDEN', 403);
  }
  const evidenceHash = await computeEvidenceHash(input.grantEvidenceToken);
  const reopenedState = await reopenTargetState(db, row);
  const correctedAt = new Date().toISOString();
  const receiptId = crypto.randomUUID();
  const result: RenewalWonCorrectionResult = {
    renewalId,
    previousState: 'WON',
    state: reopenedState,
    closedTaskId: row.task_id,
    closedTaskVersion: row.task_version,
    terminalClosedAt: row.renewal_closed_at!,
    primaryTaskId: crypto.randomUUID(),
    renewalVersion: row.renewal_version + 1,
    taskVersion: 1,
    correctedAt,
    correctionReasonCode: input.correctionReasonCode,
    supersededLinkIds: currentLinks.links.map((link) => link.id).sort(),
    preservedPolicyIds: [
      ...new Set([row.policy_id, ...currentLinks.targets.map((target) => target.id)]),
    ].sort(),
  };
  const linkIds = result.supersededLinkIds;
  const statements: D1PreparedStatement[] = [
    wonCorrectionAuthorityAssertion(db, context, active, row, scopes),
    wonCorrectionLinkSnapshotAssertion(db, active.agencyId, renewalId, currentLinks.links),
    ...targets.flatMap((target) => [
      wonPolicyReadAssertion(db, context, active, target),
      wonPolicyVersionAssertion(db, active.agencyId, target),
    ]),
    wonCorrectionGrantConsumption(
      db,
      context,
      active,
      renewalId,
      input,
      payloadHash,
      evidenceHash,
      receiptId,
      correctedAt,
    ),
    casAssertion(db, 'SENSITIVE_ACTION_GRANT_INVALID'),
    receiptInsert(
      db,
      active,
      context,
      idempotencyKey,
      WON_CORRECTION_ACTION,
      fingerprintValue,
      result,
      correctedAt,
      200,
      receiptId,
    ),
    stateHistoryInsert(db, context, active, row, reopenedState, 'WON_CORRECTED', correctedAt),
    reopenWonRenewalStatement(db, active, row, input, reopenedState, correctedAt),
    casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
    db
      .prepare(
        `UPDATE renewal_policy_links SET status='SUPERSEDED',superseded_at=?,
           superseded_by_membership_id=?,supersede_reason_code='WON_CORRECTED',superseded_operation_id=?
         WHERE agency_id=? AND renewal_id=? AND status='ACTIVE' AND id IN (${linkIds.map(() => '?').join(',')})`,
      )
      .bind(correctedAt, active.id, receiptId, active.agencyId, renewalId, ...linkIds),
    casAssertion(db, 'RENEWAL_POLICY_LINK_CONFLICT'),
    wonCorrectionPrimaryTaskInsert(db, context, active, row, result, input),
    casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
    wonCorrectionAuditInsert(db, context, active, result, idempotencyKey),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, active, context.userId, idempotencyKey);
      if (raced) {
        return replayWonCorrection(
          context,
          db,
          active,
          raced,
          input,
          fingerprintValue,
          renewalId,
          idempotencyKey,
        );
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      /MEMBERSHIP_PERMISSION_NOT_FOUND|SENSITIVE_ACTION_GRANT_INVALID|FINAL_AUTHORITY/.test(message)
    ) {
      throw new RenewalCommandError('FORBIDDEN', 403);
    }
    if (/OPTIMISTIC_CONCURRENCY|RENEWAL_POLICY_LINK|WON_CORRECTION|RENEWAL_WON/.test(message)) {
      throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
    }
    if (/operation_receipts|IDEMPOTENCY_ROW_REPLACEMENT/.test(message)) {
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    }
    throw error;
  }
  return { data: result, replayed: false };
}
