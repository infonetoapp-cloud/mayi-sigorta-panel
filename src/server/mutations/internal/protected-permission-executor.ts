/**
 * Mayı Sigorta CRM — Yeniden Kullanılabilir Atomik D1 Mutasyon Yürütücüsü (M1-T09)
 *
 * KRİTİK GÜVENLİK VE TUTARLILIK SÖZLEŞMESİ:
 * 1. Grant tüketimi (SensitiveActionGrant consumption), iş etkisi hazırlıklı ifadeleri (business statements),
 *    idempotency tamamlanması (operation_receipts insert) ve başarı denetim kaydı (audit_events insert)
 *    TEK BİR D1 BATCH İÇİNDE ATOMİK OLARAK ÇALIŞTIRILIR.
 * 2. d1_cas_assertions ve DB trigger'ları sayesinde herhangi bir koşullu güncellemede sıfır satır
 *    değişirse (veya grant zaten tüketilmişse/süresi dolmuşsa) veritabanı RAISE(ABORT) ile tüm batch'i geri alır (rollback).
 * 3. Hata durumunda veritabanında asla sahte başarı audit kaydı veya yarım tüketilmiş grant kalmaz.
 * 4. Deterministik Idempotency: Aynı anahtar ve aynı kanonik payload parmak izi ile gelen tekrarlar
 *    iş etkisi yaratmadan ve yeni audit oluşturmadan önceki cevabı döner (replay).
 *    Aynı anahtar ve farklı payload parmak izinde CONFLICT fırlatılır.
 */

import { computePayloadHash } from '../canonical';
import { checkIdempotencyReceipt, IdempotencyConflictError } from '../idempotency';
import {
  computeEvidenceHash,
  canonicalizeTargetIds,
  type SensitiveActionGrantRecord,
} from '../grants';
import { buildSafeAuditRecord } from '../audit';
import { OptimisticConcurrencyError } from '../../db/optimistic';
import {
  DEFAULT_ACTION_REGISTRY,
  evaluateAuthorization,
  type ActionDefinition,
} from '../../auth/authorization';
import type { AuthenticatedUserContext } from '../../auth/identity';
import {
  ActivePermissionDependencyError,
  DuplicatePermissionGrantError,
  IncompatibleDependencyScopeError,
  InvalidPermissionScopeError,
  MembershipNotFoundError,
  MembershipPermissionNotFoundError,
  MissingPermissionDependencyError,
  OwnerNormalPermissionProhibitedError,
  UnknownPermissionError,
  type StoredScope,
} from '../../db/permissions';
import { getPermissionDefinition, type PermissionCode } from '../../../shared/permissions';
import { verifyCsrfMutationGuard } from '../../security/csrf';

export class SensitiveGrantError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? `SENSITIVE_GRANT_ERROR: ${code}`);
    this.name = 'SensitiveGrantError';
    this.code = code;
  }
}

interface BusinessOperation {
  readonly statement: D1PreparedStatement;
  readonly expectedChanges: number;
  readonly failureCode?: string;
}

interface AtomicMutationInput<TResult = unknown> {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId?: string;
  readonly action: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly grantEvidenceToken?: string | null;
  readonly expectedTargetVersion?: number | null;
  readonly targetVersionKind?: 'ROW_VERSION' | 'PERMISSION_VERSION';
  readonly targetIds?: readonly string[];
  readonly targetType: string;
  readonly targetId: string;
  readonly auditMetadata?: Record<string, unknown>;
  readonly businessOperations: readonly BusinessOperation[];
  readonly resultProducer: () => { status: number; body: TResult };
}

export interface AtomicMutationExecutionResult<TResult = unknown> {
  readonly executed: boolean;
  readonly replayed: boolean;
  readonly status: number;
  readonly body: TResult;
  readonly auditId?: string;
  readonly grantId?: string;
}

async function executeAtomicMutation<TResult>(
  input: AtomicMutationInput<TResult>,
): Promise<AtomicMutationExecutionResult<TResult>> {
  const { db, agencyId, actorUserId, actorMembershipId, action, correlationId, idempotencyKey } =
    input;

  // 0. Girdi Doğrulaması (Fail-Closed)
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  if (
    !input.grantEvidenceToken ||
    typeof input.grantEvidenceToken !== 'string' ||
    input.grantEvidenceToken.trim().length === 0
  ) {
    throw new Error('GRANT_EVIDENCE_REQUIRED');
  }

  if (
    !input.businessOperations ||
    !Array.isArray(input.businessOperations) ||
    input.businessOperations.length === 0
  ) {
    throw new Error('BUSINESS_OPERATIONS_REQUIRED');
  }

  const trimmedIdempotencyKey = idempotencyKey.trim();

  // 1. Kanonik Payload Parmak İzi
  const payloadFingerprint = await computePayloadHash(input.payload);

  // 2. Deterministik Idempotency Kontrolü
  const receiptCheck = await checkIdempotencyReceipt(db, {
    agencyId,
    actorUserId,
    actorMembershipId,
    action,
    idempotencyKey: trimmedIdempotencyKey,
    payloadFingerprint,
  });

  if (receiptCheck.kind === 'REPLAY') {
    let parsedBody: TResult;
    try {
      parsedBody = JSON.parse(receiptCheck.responseBody) as TResult;
    } catch {
      parsedBody = receiptCheck.responseBody as unknown as TResult;
    }

    return {
      executed: false,
      replayed: true,
      status: receiptCheck.responseStatus,
      body: parsedBody,
    };
  }

  if (receiptCheck.kind === 'CONFLICT' || receiptCheck.kind === 'IN_PROGRESS') {
    throw new IdempotencyConflictError(receiptCheck.code);
  }

  // 3. SensitiveActionGrant Hazırlığı (SECURE_GRANT modunda D1'den yükleme ve ilk kontroller)
  let activeGrantRecord: SensitiveActionGrantRecord | null = null;
  let foundGrantRow: {
    id: unknown;
    evidence_hash: unknown;
    agency_id: unknown;
    actor_user_id: unknown;
    actor_membership_id: unknown;
    action: unknown;
    payload_hash: unknown;
    target_ids_json: unknown;
    expected_target_version: unknown;
    permission_version: unknown;
    assurance: unknown;
    status: unknown;
    issued_at: unknown;
    expires_at: unknown;
    consumed_at: unknown;
    revoked_at: unknown;
    consumed_operation_id: unknown;
  } | null;

  {
    const presentedEvidenceHash = await computeEvidenceHash(input.grantEvidenceToken!.trim());

    foundGrantRow = await db
      .prepare(
        `SELECT id, evidence_hash, agency_id, actor_user_id, actor_membership_id, action,
                payload_hash, target_ids_json, expected_target_version, permission_version,
                assurance, status, issued_at, expires_at, consumed_at, revoked_at, consumed_operation_id
         FROM sensitive_action_grants
         WHERE evidence_hash = ?`,
      )
      .bind(presentedEvidenceHash)
      .first<{
        id: unknown;
        evidence_hash: unknown;
        agency_id: unknown;
        actor_user_id: unknown;
        actor_membership_id: unknown;
        action: unknown;
        payload_hash: unknown;
        target_ids_json: unknown;
        expected_target_version: unknown;
        permission_version: unknown;
        assurance: unknown;
        status: unknown;
        issued_at: unknown;
        expires_at: unknown;
        consumed_at: unknown;
        revoked_at: unknown;
        consumed_operation_id: unknown;
      }>();

    if (!foundGrantRow) {
      throw new SensitiveGrantError('GRANT_NOT_FOUND');
    }

    if (
      typeof foundGrantRow.id !== 'string' ||
      typeof foundGrantRow.evidence_hash !== 'string' ||
      typeof foundGrantRow.agency_id !== 'string' ||
      typeof foundGrantRow.actor_user_id !== 'string' ||
      typeof foundGrantRow.actor_membership_id !== 'string' ||
      typeof foundGrantRow.action !== 'string' ||
      typeof foundGrantRow.payload_hash !== 'string' ||
      typeof foundGrantRow.target_ids_json !== 'string' ||
      typeof foundGrantRow.permission_version !== 'number' ||
      typeof foundGrantRow.issued_at !== 'string' ||
      typeof foundGrantRow.expires_at !== 'string' ||
      foundGrantRow.assurance !== 'SECURE_GRANT'
    ) {
      throw new SensitiveGrantError('GRANT_VALIDATION_FAILED');
    }

    if (foundGrantRow.status === 'CONSUMED') {
      throw new SensitiveGrantError('GRANT_ALREADY_CONSUMED');
    }
    if (foundGrantRow.status === 'REVOKED' || foundGrantRow.revoked_at !== null) {
      throw new SensitiveGrantError('GRANT_REVOKED');
    }
    if (foundGrantRow.status !== 'ISSUED') {
      throw new SensitiveGrantError('GRANT_VALIDATION_FAILED');
    }

    const nowMs = Date.now();
    const issuedAtMs = new Date(foundGrantRow.issued_at).getTime();
    const expiresAtMs = new Date(foundGrantRow.expires_at).getTime();
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      issuedAtMs <= 0 ||
      expiresAtMs <= issuedAtMs
    ) {
      throw new SensitiveGrantError('GRANT_EXPIRED');
    }

    const grantTtlSec = (expiresAtMs - issuedAtMs) / 1000;
    if (grantTtlSec <= 0 || grantTtlSec > 180) {
      throw new SensitiveGrantError('GRANT_VALIDATION_FAILED');
    }

    if (nowMs < issuedAtMs || nowMs >= expiresAtMs) {
      throw new SensitiveGrantError('GRANT_EXPIRED');
    }

    if (foundGrantRow.agency_id !== agencyId) {
      throw new SensitiveGrantError('GRANT_AGENCY_MISMATCH');
    }
    if (foundGrantRow.actor_user_id !== actorUserId) {
      throw new SensitiveGrantError('GRANT_ACTOR_USER_MISMATCH');
    }
    if (foundGrantRow.actor_membership_id !== actorMembershipId) {
      throw new SensitiveGrantError('GRANT_MEMBERSHIP_MISMATCH');
    }
    if (foundGrantRow.action !== action) {
      throw new SensitiveGrantError('GRANT_ACTION_MISMATCH');
    }
    if (foundGrantRow.payload_hash !== payloadFingerprint) {
      throw new SensitiveGrantError('GRANT_PAYLOAD_MISMATCH');
    }

    const canonicalTargets = canonicalizeTargetIds(input.targetIds ?? [input.targetId]);
    if (foundGrantRow.target_ids_json !== canonicalTargets) {
      throw new SensitiveGrantError('GRANT_TARGET_MISMATCH');
    }

    const expectedVer =
      input.expectedTargetVersion !== undefined ? input.expectedTargetVersion : null;
    if (foundGrantRow.expected_target_version !== expectedVer) {
      throw new SensitiveGrantError('GRANT_TARGET_VERSION_MISMATCH');
    }
  }

  // 4. Canlı DB Yaşam Döngüsü ve İzin Versiyonu Doğrulaması (Contract 3)
  const userRow = await db
    .prepare('SELECT id, status FROM users WHERE id = ?')
    .bind(actorUserId)
    .first<{ id: unknown; status: unknown }>();
  if (!userRow || typeof userRow.id !== 'string' || userRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_USER_REQUIRED');
  }

  const agencyRow = await db
    .prepare('SELECT id, status FROM agencies WHERE id = ?')
    .bind(agencyId)
    .first<{ id: unknown; status: unknown }>();
  if (!agencyRow || typeof agencyRow.id !== 'string' || agencyRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_AGENCY_REQUIRED');
  }

  const membershipRow = await db
    .prepare(
      'SELECT id, type, status, permission_version FROM agency_memberships WHERE id = ? AND agency_id = ? AND user_id = ?',
    )
    .bind(actorMembershipId, agencyId, actorUserId)
    .first<{ id: unknown; type: unknown; status: unknown; permission_version: unknown }>();
  if (
    !membershipRow ||
    typeof membershipRow.id !== 'string' ||
    (membershipRow.type !== 'OWNER' && membershipRow.type !== 'MEMBER') ||
    membershipRow.status !== 'ACTIVE' ||
    typeof membershipRow.permission_version !== 'number'
  ) {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }

  const livePermissionVersion = membershipRow.permission_version;
  const liveMembershipType = membershipRow.type;

  if (foundGrantRow) {
    // Canlı permission_version kontrolü (Grant üretildikten sonra üyelik izni değiştiyse fail-closed ret!)
    if (livePermissionVersion !== foundGrantRow.permission_version) {
      throw new SensitiveGrantError('GRANT_PERMISSION_VERSION_STALE');
    }

    activeGrantRecord = {
      id: foundGrantRow.id as string,
      evidenceHash: foundGrantRow.evidence_hash as string,
      agencyId: foundGrantRow.agency_id as string,
      actorUserId: foundGrantRow.actor_user_id as string,
      actorMembershipId: foundGrantRow.actor_membership_id as string,
      action: foundGrantRow.action as string,
      payloadHash: foundGrantRow.payload_hash as string,
      targetIdsJson: foundGrantRow.target_ids_json as string,
      expectedTargetVersion: foundGrantRow.expected_target_version as number | null,
      permissionVersion: foundGrantRow.permission_version as number,
      assurance: 'SECURE_GRANT',
      status: 'ISSUED',
      issuedAt: foundGrantRow.issued_at as string,
      expiresAt: foundGrantRow.expires_at as string,
      consumedAt: null,
      revokedAt: null,
      consumedOperationId: null,
    };
  }

  const batchStatements: D1PreparedStatement[] = [];

  // Preflight nihai yetki değildir. Bu assertion aynı D1 batch/transaction içinde
  // Agency, User, AuthIdentity ve Membership yaşam döngüsü ile permission_version
  // bağını yeniden okur. Yarışta herhangi biri değiştiyse trigger bütün batch'i geri alır.
  const finalAuthorityRecheckStmt = db
    .prepare(
      `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
       SELECT ?, 1,
         CASE WHEN EXISTS (
           SELECT 1
           FROM agency_memberships m
           INNER JOIN users u ON u.id = m.user_id
           INNER JOIN agencies a ON a.id = m.agency_id
           WHERE m.id = ?
             AND m.agency_id = ?
             AND m.user_id = ?
             AND m.type = ?
             AND m.status = 'ACTIVE'
             AND m.permission_version = ?
             AND u.status = 'ACTIVE'
             AND a.status = 'ACTIVE'
             AND EXISTS (
               SELECT 1 FROM auth_identities ai
               WHERE ai.user_id = u.id
                 AND ai.status = 'ACTIVE'
                 AND (? IS NULL OR ai.id = ?)
             )
         ) THEN 1 ELSE 0 END,
         'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      actorMembershipId,
      agencyId,
      actorUserId,
      liveMembershipType,
      livePermissionVersion,
      input.actorIdentityId ?? null,
      input.actorIdentityId ?? null,
    );
  batchStatements.push(finalAuthorityRecheckStmt);

  if (
    input.expectedTargetVersion !== undefined &&
    input.expectedTargetVersion !== null &&
    input.targetType === 'agency_memberships'
  ) {
    const targetVersionColumn =
      input.targetVersionKind === 'PERMISSION_VERSION' ? 'permission_version' : 'version';
    const targetLifecyclePredicate =
      input.targetVersionKind === 'PERMISSION_VERSION' ? "AND status = 'ACTIVE'" : '';
    const finalTargetVersionRecheckStmt = db
      .prepare(
        `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
         SELECT ?, 1,
           CASE WHEN EXISTS (
             SELECT 1 FROM agency_memberships
             WHERE id = ? AND agency_id = ? AND ${targetVersionColumn} = ?
               ${targetLifecyclePredicate}
           ) THEN 1 ELSE 0 END,
           'FINAL_TARGET_VERSION_RECHECK_FAILED'`,
      )
      .bind(crypto.randomUUID(), input.targetId, agencyId, input.expectedTargetVersion);
    batchStatements.push(finalTargetVersionRecheckStmt);
  }

  if (activeGrantRecord) {
    const canonicalTargets = canonicalizeTargetIds(input.targetIds ?? [input.targetId]);
    const expectedTargetVer =
      input.expectedTargetVersion !== undefined && input.expectedTargetVersion !== null
        ? Number(input.expectedTargetVersion)
        : null;

    // Atomik Grant Tüketimi: Bütün değişmez boyutlar WHERE koşulunda tam doğrulanır!
    const consumeGrantStmt = db
      .prepare(
        `UPDATE sensitive_action_grants
         SET status = 'CONSUMED',
             consumed_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             consumed_operation_id = ?,
             updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         WHERE id = ?
           AND evidence_hash = ?
           AND agency_id = ?
           AND actor_user_id = ?
           AND actor_membership_id = ?
           AND action = ?
           AND payload_hash = ?
           AND target_ids_json = ?
           AND (expected_target_version IS ? OR expected_target_version = ?)
           AND permission_version = ?
           AND assurance = 'SECURE_GRANT'
           AND status = 'ISSUED'
           AND revoked_at IS NULL
           AND expires_at > (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .bind(
        correlationId,
        activeGrantRecord.id,
        activeGrantRecord.evidenceHash,
        agencyId,
        actorUserId,
        actorMembershipId,
        action,
        payloadFingerprint,
        canonicalTargets,
        expectedTargetVer,
        expectedTargetVer,
        livePermissionVersion,
      );

    const assertGrantStmt = db
      .prepare(
        `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
         VALUES (?, 1, changes(), 'SENSITIVE_GRANT_CONSUMPTION_FAILED')`,
      )
      .bind(crypto.randomUUID());

    batchStatements.push(consumeGrantStmt, assertGrantStmt);
  }

  // 5. Sonuç Nesnesi Üretimi
  const mutationResult = input.resultProducer();
  const serializedResponseBody = JSON.stringify(mutationResult.body);

  // 6. Idempotency Receipt İfadesi
  const receiptStmt = db
    .prepare(
      `INSERT INTO operation_receipts (
         id, agency_id, actor_user_id, actor_membership_id, action,
         idempotency_key, payload_fingerprint, status, response_status, response_body,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?,
         (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       )`,
    )
    .bind(
      crypto.randomUUID(),
      agencyId,
      actorUserId,
      actorMembershipId,
      action,
      trimmedIdempotencyKey,
      payloadFingerprint,
      mutationResult.status,
      serializedResponseBody,
    );

  batchStatements.push(receiptStmt);

  // 7. İş Etkisi (Business Operations) + Otomatik CAS Doğrulaması (Contract 4)
  for (const op of input.businessOperations) {
    batchStatements.push(op.statement);
    const failureCode = op.failureCode || 'BUSINESS_MUTATION_FAILED';
    const assertStmt = db
      .prepare(
        `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
         VALUES (?, ?, changes(), ?)`,
      )
      .bind(crypto.randomUUID(), op.expectedChanges, failureCode);
    batchStatements.push(assertStmt);
  }

  // 8. Başarı Denetim Kaydı (Audit Event)
  const auditRecord = buildSafeAuditRecord({
    agencyId,
    actorUserId,
    actorMembershipId,
    action,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId,
    idempotencyKey: trimmedIdempotencyKey,
    outcome: 'SUCCESS',
    metadata: input.auditMetadata,
  });

  const auditStmt = db
    .prepare(
      `INSERT INTO audit_events (
         id, agency_id, actor_user_id, actor_membership_id, action,
         target_type, target_id, correlation_id, idempotency_key,
         outcome, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUCCESS', ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
    )
    .bind(
      auditRecord.id,
      auditRecord.agencyId,
      auditRecord.actorUserId,
      auditRecord.actorMembershipId,
      auditRecord.action,
      auditRecord.targetType,
      auditRecord.targetId,
      auditRecord.correlationId,
      auditRecord.idempotencyKey,
      auditRecord.metadataJson,
    );

  batchStatements.push(auditStmt);

  // 9. TEK BİR ATOMİK D1 BATCH ÇALIŞTIRMA
  try {
    const results = await db.batch(batchStatements);
    for (const res of results) {
      if (!res.success) {
        throw new Error('D1_BATCH_EXECUTION_FAILED');
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('SENSITIVE_GRANT_CONSUMPTION_FAILED')) {
      throw new SensitiveGrantError('SENSITIVE_GRANT_CONSUMPTION_FAILED');
    }
    if (
      msg.includes('OPTIMISTIC_CONCURRENCY_CONFLICT') ||
      msg.includes('BUSINESS_MUTATION_FAILED')
    ) {
      throw new OptimisticConcurrencyError(0);
    }
    if (
      msg.includes('IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN') ||
      msg.includes('operation_receipts_idem_uq') ||
      msg.includes('UNIQUE constraint failed: operation_receipts')
    ) {
      // Eşzamanlı idempotency yarışı: D1'deki tamamlanmış makbuzu yeniden oku
      const receipt = await db
        .prepare(
          `SELECT payload_fingerprint, status, response_status, response_body
           FROM operation_receipts
           WHERE agency_id = ?
             AND actor_user_id = ?
             AND actor_membership_id = ?
             AND action = ?
             AND idempotency_key = ?`,
        )
        .bind(agencyId, actorUserId, actorMembershipId, action, trimmedIdempotencyKey)
        .first<{
          payload_fingerprint: string;
          status: string;
          response_status: number;
          response_body: string;
        }>();

      if (
        receipt &&
        receipt.payload_fingerprint === payloadFingerprint &&
        receipt.status === 'COMPLETED'
      ) {
        let parsedBody: TResult;
        try {
          parsedBody = JSON.parse(receipt.response_body) as TResult;
        } catch {
          parsedBody = receipt.response_body as unknown as TResult;
        }

        return {
          executed: false,
          replayed: true,
          status: receipt.response_status,
          body: parsedBody,
        };
      }

      throw new IdempotencyConflictError('CONCURRENT_IDEMPOTENCY_EXECUTION');
    }
    throw error;
  }

  return {
    executed: true,
    replayed: false,
    status: mutationResult.status,
    body: mutationResult.body,
    auditId: auditRecord.id,
    grantId: activeGrantRecord?.id,
  };
}

export type PermissionMutationOperation =
  | {
      readonly kind: 'GRANT_PERMISSION';
      readonly membershipId: string;
      readonly permissionCode: string;
      readonly scope: StoredScope;
      readonly expectedPermissionVersion: number;
    }
  | {
      readonly kind: 'REVOKE_PERMISSION';
      readonly membershipId: string;
      readonly permissionCode: string;
      readonly expectedPermissionVersion: number;
    }
  | {
      readonly kind: 'CHANGE_PERMISSION_SCOPE';
      readonly membershipId: string;
      readonly permissionCode: string;
      readonly newScope: 'ASSIGNED' | 'AGENCY';
      readonly expectedPermissionVersion: number;
    };

interface AuthorizePermissionMutationInput {
  readonly context: AuthenticatedUserContext;
  readonly agencyId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly grantEvidenceToken: string;
  readonly operation: PermissionMutationOperation;
}

interface AuthorizedPermissionMutationIntent {
  readonly kind: 'AUTHORIZED_PERMISSION_MUTATION_INTENT';
}

interface PermissionIntentState {
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly action: string;
  readonly actionDefinition: ActionDefinition;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly grantEvidenceToken: string;
  readonly payload: Readonly<Record<string, string | number>>;
  readonly payloadFingerprint: string;
  readonly targetId: string;
  readonly expectedTargetVersion: number;
  readonly operationFingerprint: string;
}

const permissionIntentStates = new WeakMap<object, PermissionIntentState>();

function permissionActionFor(operation: PermissionMutationOperation): string {
  if (operation.kind === 'GRANT_PERMISSION') return 'permission.grant';
  if (operation.kind === 'REVOKE_PERMISSION') return 'permission.revoke';
  return 'permission.scope.change';
}

function snapshotPermissionOperation(
  operation: PermissionMutationOperation,
): PermissionMutationOperation {
  if (!operation || typeof operation !== 'object') {
    throw new Error('MALFORMED_PERMISSION_OPERATION');
  }
  const membershipId = operation.membershipId;
  const permissionCode = operation.permissionCode;
  const expectedPermissionVersion = operation.expectedPermissionVersion;
  if (
    typeof membershipId !== 'string' ||
    membershipId.trim().length === 0 ||
    membershipId !== membershipId.trim() ||
    typeof permissionCode !== 'string' ||
    permissionCode.trim().length === 0 ||
    permissionCode !== permissionCode.trim() ||
    !Number.isInteger(expectedPermissionVersion) ||
    expectedPermissionVersion < 1
  ) {
    throw new Error('MALFORMED_PERMISSION_OPERATION');
  }
  if (operation.kind === 'GRANT_PERMISSION') {
    if (
      operation.scope !== 'UNSCOPED' &&
      operation.scope !== 'ASSIGNED' &&
      operation.scope !== 'AGENCY'
    ) {
      throw new Error('MALFORMED_PERMISSION_OPERATION');
    }
    return Object.freeze({
      kind: operation.kind,
      membershipId,
      permissionCode,
      scope: operation.scope,
      expectedPermissionVersion,
    });
  }
  if (operation.kind === 'REVOKE_PERMISSION') {
    return Object.freeze({
      kind: operation.kind,
      membershipId,
      permissionCode,
      expectedPermissionVersion,
    });
  }
  if (operation.kind === 'CHANGE_PERMISSION_SCOPE') {
    if (operation.newScope !== 'ASSIGNED' && operation.newScope !== 'AGENCY') {
      throw new Error('MALFORMED_PERMISSION_OPERATION');
    }
    return Object.freeze({
      kind: operation.kind,
      membershipId,
      permissionCode,
      newScope: operation.newScope,
      expectedPermissionVersion,
    });
  }
  throw new Error('MALFORMED_PERMISSION_OPERATION');
}

function permissionPayload(
  operation: PermissionMutationOperation,
): Readonly<Record<string, string | number>> {
  if (operation.kind === 'GRANT_PERMISSION') {
    return Object.freeze({
      kind: operation.kind,
      membershipId: operation.membershipId,
      permissionCode: operation.permissionCode,
      scope: operation.scope,
      expectedPermissionVersion: operation.expectedPermissionVersion,
    });
  }
  if (operation.kind === 'CHANGE_PERMISSION_SCOPE') {
    return Object.freeze({
      kind: operation.kind,
      membershipId: operation.membershipId,
      permissionCode: operation.permissionCode,
      newScope: operation.newScope,
      expectedPermissionVersion: operation.expectedPermissionVersion,
    });
  }
  return Object.freeze({
    kind: operation.kind,
    membershipId: operation.membershipId,
    permissionCode: operation.permissionCode,
    expectedPermissionVersion: operation.expectedPermissionVersion,
  });
}

async function authorizePermissionMutation(
  db: D1Database,
  input: AuthorizePermissionMutationInput,
): Promise<AuthorizedPermissionMutationIntent> {
  const operation = snapshotPermissionOperation(input.operation);
  const action = permissionActionFor(operation);
  const actionDefinition = DEFAULT_ACTION_REGISTRY.get(action);
  if (!actionDefinition || actionDefinition.assurance !== 'SECURE_GRANT') {
    throw new Error('CANONICAL_ACTION_REQUIRED');
  }
  if (input.context.assurance !== 'SECURE') {
    throw new Error('SECURE_ASSURANCE_REQUIRED');
  }
  if (
    typeof input.agencyId !== 'string' ||
    input.agencyId.trim().length === 0 ||
    typeof input.correlationId !== 'string' ||
    input.correlationId.trim().length === 0 ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim().length === 0 ||
    typeof input.grantEvidenceToken !== 'string' ||
    input.grantEvidenceToken.trim().length === 0
  ) {
    throw new Error('MALFORMED_PROTECTED_MUTATION_INPUT');
  }

  const payload = permissionPayload(operation);
  const authorization = await evaluateAuthorization(db, {
    context: input.context,
    action,
    agencyId: input.agencyId,
    secureGrantBinding: {
      evidence: input.grantEvidenceToken,
      payload,
      targetIds: [operation.membershipId],
      expectedTargetVersion: operation.expectedPermissionVersion,
    },
  });
  if (authorization.decision !== 'ALLOW') {
    throw new Error(`PROTECTED_MUTATION_DENIED:${authorization.code}`);
  }

  const memberships = input.context.memberships.filter((item) => item.agencyId === input.agencyId);
  if (memberships.length !== 1) {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }
  const membership = memberships[0]!;
  const payloadFingerprint = await computePayloadHash(payload);
  const operationFingerprint = await computePayloadHash(operation);
  const intent = Object.freeze({
    kind: 'AUTHORIZED_PERMISSION_MUTATION_INTENT' as const,
  });
  permissionIntentStates.set(intent, {
    agencyId: input.agencyId,
    actorUserId: input.context.userId,
    actorMembershipId: membership.id,
    actorIdentityId: input.context.identityId,
    action,
    actionDefinition,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey.trim(),
    grantEvidenceToken: input.grantEvidenceToken.trim(),
    payload,
    payloadFingerprint,
    targetId: operation.membershipId,
    expectedTargetVersion: operation.expectedPermissionVersion,
    operationFingerprint,
  });
  return intent;
}

interface PermissionMembershipRow {
  id: string;
  agency_id: string;
  type: 'OWNER' | 'MEMBER';
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  permission_version: number;
}

interface PermissionGrantRow {
  permission_code: string;
  scope: StoredScope;
}

function permissionScopeWeight(scope: StoredScope): number {
  if (scope === 'AGENCY') return 2;
  if (scope === 'ASSIGNED') return 1;
  return 0;
}

function assertCatalogScope(permissionCode: string, scope: StoredScope): void {
  const definition = getPermissionDefinition(permissionCode);
  if (!definition) throw new UnknownPermissionError(permissionCode);
  if (
    (definition.scopeKind === 'UNSCOPED' && scope !== 'UNSCOPED') ||
    (definition.scopeKind === 'RECORD_SCOPED' && scope !== 'ASSIGNED' && scope !== 'AGENCY')
  ) {
    throw new InvalidPermissionScopeError(permissionCode, scope, definition.scopeKind);
  }
}

async function buildPermissionBusinessOperations(
  db: D1Database,
  agencyId: string,
  operation: PermissionMutationOperation,
): Promise<{
  readonly operations: readonly BusinessOperation[];
  readonly result: Readonly<Record<string, string | number>>;
}> {
  const definition = getPermissionDefinition(operation.permissionCode);
  if (!definition) throw new UnknownPermissionError(operation.permissionCode);
  const membership = await db
    .prepare(
      `SELECT id, agency_id, type, status, permission_version
       FROM agency_memberships WHERE id = ? AND agency_id = ?`,
    )
    .bind(operation.membershipId, agencyId)
    .first<PermissionMembershipRow>();
  if (!membership) throw new MembershipNotFoundError(operation.membershipId);
  if (membership.status !== 'ACTIVE') throw new MembershipNotFoundError(operation.membershipId);
  const grantsResult = await db
    .prepare(
      `SELECT permission_code, scope FROM membership_permissions
       WHERE membership_id = ?`,
    )
    .bind(operation.membershipId)
    .all<PermissionGrantRow>();
  const grants = grantsResult.results ?? [];
  for (const grant of grants) assertCatalogScope(grant.permission_code, grant.scope);

  const versionUpdate = db
    .prepare(
      `UPDATE agency_memberships
       SET permission_version = permission_version + 1,
           version = version + 1,
           updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ? AND agency_id = ? AND status = 'ACTIVE' AND permission_version = ?`,
    )
    .bind(operation.membershipId, agencyId, operation.expectedPermissionVersion);

  if (operation.kind === 'GRANT_PERMISSION') {
    assertCatalogScope(operation.permissionCode, operation.scope);
    if (membership.type === 'OWNER' && definition.classification === 'NORMAL') {
      throw new OwnerNormalPermissionProhibitedError(
        operation.membershipId,
        operation.permissionCode,
      );
    }
    if (grants.some((grant) => grant.permission_code === operation.permissionCode)) {
      throw new DuplicatePermissionGrantError(operation.membershipId, operation.permissionCode);
    }
    for (const dependencyCode of definition.dependencies) {
      const dependencyDefinition = getPermissionDefinition(dependencyCode);
      if (!dependencyDefinition) throw new UnknownPermissionError(dependencyCode);
      const implicitOwnerDependency =
        membership.type === 'OWNER' && dependencyDefinition.classification === 'NORMAL';
      const dependency = grants.find((grant) => grant.permission_code === dependencyCode);
      if (!implicitOwnerDependency && !dependency) {
        throw new MissingPermissionDependencyError(operation.permissionCode, dependencyCode);
      }
      const dependencyScope = implicitOwnerDependency ? 'AGENCY' : dependency!.scope;
      if (
        definition.scopeKind === 'RECORD_SCOPED' &&
        dependencyDefinition.scopeKind === 'RECORD_SCOPED' &&
        permissionScopeWeight(operation.scope) > permissionScopeWeight(dependencyScope)
      ) {
        throw new IncompatibleDependencyScopeError(
          operation.permissionCode,
          operation.scope,
          dependencyCode,
          dependencyScope,
        );
      }
    }
    const grantId = crypto.randomUUID();
    return {
      operations: [
        { statement: versionUpdate, expectedChanges: 1 },
        {
          statement: db
            .prepare(
              `INSERT INTO membership_permissions
               (id, membership_id, permission_code, scope, created_at, updated_at)
               VALUES (?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                 (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
            )
            .bind(grantId, operation.membershipId, operation.permissionCode, operation.scope),
          expectedChanges: 1,
        },
      ],
      result: Object.freeze({
        grantId,
        membershipId: operation.membershipId,
        permissionCode: definition.code as PermissionCode,
        scope: operation.scope,
        newPermissionVersion: operation.expectedPermissionVersion + 1,
      }),
    };
  }

  const existing = grants.find((grant) => grant.permission_code === operation.permissionCode);
  if (!existing) {
    throw new MembershipPermissionNotFoundError(operation.membershipId, operation.permissionCode);
  }

  if (operation.kind === 'REVOKE_PERMISSION') {
    for (const grant of grants) {
      if (grant.permission_code === operation.permissionCode) continue;
      const grantDefinition = getPermissionDefinition(grant.permission_code);
      if (grantDefinition?.dependencies.includes(operation.permissionCode)) {
        throw new ActivePermissionDependencyError(operation.permissionCode, grant.permission_code);
      }
    }
    return {
      operations: [
        { statement: versionUpdate, expectedChanges: 1 },
        {
          statement: db
            .prepare(
              'DELETE FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
            )
            .bind(operation.membershipId, operation.permissionCode),
          expectedChanges: 1,
        },
      ],
      result: Object.freeze({
        membershipId: operation.membershipId,
        permissionCode: definition.code as PermissionCode,
        newPermissionVersion: operation.expectedPermissionVersion + 1,
      }),
    };
  }

  if (definition.scopeKind !== 'RECORD_SCOPED') {
    throw new InvalidPermissionScopeError(
      operation.permissionCode,
      operation.newScope,
      'RECORD_SCOPED',
    );
  }
  if (membership.type === 'OWNER' && definition.classification === 'NORMAL') {
    throw new OwnerNormalPermissionProhibitedError(
      operation.membershipId,
      operation.permissionCode,
    );
  }
  for (const dependencyCode of definition.dependencies) {
    const dependencyDefinition = getPermissionDefinition(dependencyCode);
    if (!dependencyDefinition) throw new UnknownPermissionError(dependencyCode);
    const implicitOwnerDependency =
      membership.type === 'OWNER' && dependencyDefinition.classification === 'NORMAL';
    const dependency = grants.find((grant) => grant.permission_code === dependencyCode);
    if (!implicitOwnerDependency && !dependency) {
      throw new MissingPermissionDependencyError(operation.permissionCode, dependencyCode);
    }
    const dependencyScope = implicitOwnerDependency ? 'AGENCY' : dependency!.scope;
    if (
      dependencyDefinition.scopeKind === 'RECORD_SCOPED' &&
      permissionScopeWeight(operation.newScope) > permissionScopeWeight(dependencyScope)
    ) {
      throw new IncompatibleDependencyScopeError(
        operation.permissionCode,
        operation.newScope,
        dependencyCode,
        dependencyScope,
      );
    }
  }
  for (const grant of grants) {
    if (grant.permission_code === operation.permissionCode) continue;
    const grantDefinition = getPermissionDefinition(grant.permission_code);
    if (
      grantDefinition?.dependencies.includes(operation.permissionCode) &&
      grantDefinition.scopeKind === 'RECORD_SCOPED' &&
      permissionScopeWeight(operation.newScope) < permissionScopeWeight(grant.scope)
    ) {
      throw new ActivePermissionDependencyError(operation.permissionCode, grant.permission_code);
    }
  }
  return {
    operations: [
      { statement: versionUpdate, expectedChanges: 1 },
      {
        statement: db
          .prepare(
            `UPDATE membership_permissions
             SET scope = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             WHERE membership_id = ? AND permission_code = ?`,
          )
          .bind(operation.newScope, operation.membershipId, operation.permissionCode),
        expectedChanges: 1,
      },
    ],
    result: Object.freeze({
      membershipId: operation.membershipId,
      permissionCode: definition.code as PermissionCode,
      scope: operation.newScope,
      newPermissionVersion: operation.expectedPermissionVersion + 1,
    }),
  };
}

async function executePermissionMutation(
  db: D1Database,
  intent: AuthorizedPermissionMutationIntent,
  operationInput: PermissionMutationOperation,
): Promise<AtomicMutationExecutionResult<Readonly<Record<string, string | number>>>> {
  const state = permissionIntentStates.get(intent as object);
  if (!state) throw new Error('TRUSTED_MUTATION_INTENT_REQUIRED');
  const operation = snapshotPermissionOperation(operationInput);
  const operationFingerprint = await computePayloadHash(operation);
  const payload = permissionPayload(operation);
  const payloadFingerprint = await computePayloadHash(payload);
  if (
    permissionActionFor(operation) !== state.action ||
    operation.membershipId !== state.targetId ||
    operation.expectedPermissionVersion !== state.expectedTargetVersion ||
    operationFingerprint !== state.operationFingerprint ||
    payloadFingerprint !== state.payloadFingerprint
  ) {
    throw new Error('TRUSTED_MUTATION_INTENT_MISMATCH');
  }
  if (state.actionDefinition.assurance !== 'SECURE_GRANT') {
    throw new Error('CANONICAL_ACTION_ASSURANCE_MISMATCH');
  }

  const prepared = await buildPermissionBusinessOperations(db, state.agencyId, operation);
  return executeAtomicMutation({
    db,

    agencyId: state.agencyId,
    actorUserId: state.actorUserId,
    actorMembershipId: state.actorMembershipId,
    actorIdentityId: state.actorIdentityId,
    action: state.action,
    correlationId: state.correlationId,
    idempotencyKey: state.idempotencyKey,
    payload: state.payload,
    grantEvidenceToken: state.grantEvidenceToken,
    expectedTargetVersion: state.expectedTargetVersion,
    targetVersionKind: 'PERMISSION_VERSION',
    targetIds: [state.targetId],
    targetType: 'agency_memberships',
    targetId: state.targetId,
    auditMetadata: {
      reasonCode: operation.kind,
      changedFieldCount: operation.kind === 'CHANGE_PERMISSION_SCOPE' ? 1 : 2,
      targetVersion: state.expectedTargetVersion,
      replayed: false,
    },
    businessOperations: prepared.operations,
    resultProducer: () => ({ status: 200, body: prepared.result }),
  });
}

async function replayCompletedPermissionMutation(
  db: D1Database,
  input: AuthorizePermissionMutationInput,
): Promise<AtomicMutationExecutionResult<Readonly<Record<string, string | number>>> | null> {
  const operation = snapshotPermissionOperation(input.operation);
  const action = permissionActionFor(operation);
  if (input.context.assurance !== 'SECURE') {
    throw new Error('SECURE_ASSURANCE_REQUIRED');
  }
  if (
    typeof input.agencyId !== 'string' ||
    input.agencyId.trim().length === 0 ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim().length === 0
  ) {
    throw new Error('MALFORMED_PROTECTED_MUTATION_INPUT');
  }

  const memberships = input.context.memberships.filter(
    (item) => item.agencyId === input.agencyId && item.status === 'ACTIVE',
  );
  if (memberships.length !== 1) {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }
  const membership = memberships[0]!;
  const idempotencyKey = input.idempotencyKey.trim();
  const existing = await db
    .prepare(
      `SELECT action
       FROM operation_receipts
       WHERE agency_id = ?
         AND actor_user_id = ?
         AND actor_membership_id = ?
         AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(input.agencyId, input.context.userId, membership.id, idempotencyKey)
    .first<{ action: unknown }>();
  if (!existing) return null;
  if (existing.action !== action) {
    throw new IdempotencyConflictError('IDEMPOTENCY_ACTION_MISMATCH');
  }

  const receiptCheck = await checkIdempotencyReceipt(db, {
    agencyId: input.agencyId,
    actorUserId: input.context.userId,
    actorMembershipId: membership.id,
    action,
    idempotencyKey,
    payloadFingerprint: await computePayloadHash(permissionPayload(operation)),
  });
  if (receiptCheck.kind === 'CONFLICT' || receiptCheck.kind === 'IN_PROGRESS') {
    throw new IdempotencyConflictError(receiptCheck.code);
  }
  if (receiptCheck.kind !== 'REPLAY') return null;

  let body: Readonly<Record<string, string | number>>;
  try {
    body = JSON.parse(receiptCheck.responseBody) as Readonly<Record<string, string | number>>;
  } catch {
    throw new IdempotencyConflictError('IDEMPOTENCY_RESPONSE_INVALID');
  }
  return {
    executed: false,
    replayed: true,
    status: receiptCheck.responseStatus,
    body,
  };
}

export interface ProtectedPermissionMutationRequest {
  readonly agencyId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly grantEvidenceToken: string;
  readonly operation: PermissionMutationOperation;
}

export interface ExecuteProtectedPermissionMutationInput {
  readonly request: Request;
  readonly csrfSecret: string;
  readonly authenticatedSubject: string;
  readonly context: AuthenticatedUserContext;
  readonly resolveMutation: () => Promise<ProtectedPermissionMutationRequest>;
}

/**
 * Phase-1 permission mutasyonlarının desteklenen tek yürütme girişi.
 * CSRF doğrulaması geçmeden mutasyon gövdesi ayrıştırılmaz; assurance/action/SQL
 * çağıran tarafından seçilemez ve yalnız canonical operation'dan türetilir.
 */
export async function executeProtectedPermissionMutation(
  db: D1Database,
  input: ExecuteProtectedPermissionMutationInput,
): Promise<AtomicMutationExecutionResult<Readonly<Record<string, string | number>>>> {
  const csrf = await verifyCsrfMutationGuard(input.request, {
    authenticatedSubject: input.authenticatedSubject,
    secret: input.csrfSecret,
  });
  if (!csrf.allowed) {
    throw new Error(`CSRF_MUTATION_GUARD_FAILED:${csrf.code}`);
  }

  const mutation = await input.resolveMutation();
  const authorizationInput: AuthorizePermissionMutationInput = {
    context: input.context,
    agencyId: mutation.agencyId,
    correlationId: mutation.correlationId,
    idempotencyKey: mutation.idempotencyKey,
    grantEvidenceToken: mutation.grantEvidenceToken,
    operation: mutation.operation,
  };
  const completedReplay = await replayCompletedPermissionMutation(db, authorizationInput);
  if (completedReplay) return completedReplay;

  try {
    const intent = await authorizePermissionMutation(db, authorizationInput);
    return await executePermissionMutation(db, intent, mutation.operation);
  } catch (error) {
    const concurrentReplay = await replayCompletedPermissionMutation(db, authorizationInput);
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }
}
