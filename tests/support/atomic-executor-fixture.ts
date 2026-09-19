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

import { computePayloadHash } from '../../src/server/mutations/canonical';
import {
  checkIdempotencyReceipt,
  IdempotencyConflictError,
} from '../../src/server/mutations/idempotency';
import {
  computeEvidenceHash,
  canonicalizeTargetIds,
  type SensitiveActionGrantRecord,
} from '../../src/server/mutations/grants';
import { buildSafeAuditRecord } from '../../src/server/mutations/audit';
import { OptimisticConcurrencyError } from '../../src/server/db/optimistic';

export class SensitiveGrantError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? `SENSITIVE_GRANT_ERROR: ${code}`);
    this.name = 'SensitiveGrantError';
    this.code = code;
  }
}

export interface BusinessOperation {
  readonly statement: D1PreparedStatement;
  readonly expectedChanges: number;
  readonly failureCode?: string;
}

export interface AtomicMutationInput<TResult = unknown> {
  readonly db: D1Database;
  readonly assurance: 'NORMAL_SESSION' | 'SECURE_GRANT';
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly action: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly grantEvidenceToken?: string | null;
  readonly expectedTargetVersion?: number | null;
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

export async function executeAtomicMutation<TResult>(
  input: AtomicMutationInput<TResult>,
): Promise<AtomicMutationExecutionResult<TResult>> {
  const { db, agencyId, actorUserId, actorMembershipId, action, correlationId, idempotencyKey } =
    input;

  // 0. Girdi Doğrulaması (Fail-Closed)
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  if (input.assurance === 'SECURE_GRANT') {
    if (
      !input.grantEvidenceToken ||
      typeof input.grantEvidenceToken !== 'string' ||
      input.grantEvidenceToken.trim().length === 0
    ) {
      throw new Error('GRANT_EVIDENCE_REQUIRED');
    }
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
  } | null = null;

  if (input.assurance === 'SECURE_GRANT') {
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
      'SELECT id, status, permission_version FROM agency_memberships WHERE id = ? AND agency_id = ? AND user_id = ?',
    )
    .bind(actorMembershipId, agencyId, actorUserId)
    .first<{ id: unknown; status: unknown; permission_version: unknown }>();
  if (
    !membershipRow ||
    typeof membershipRow.id !== 'string' ||
    membershipRow.status !== 'ACTIVE' ||
    typeof membershipRow.permission_version !== 'number'
  ) {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }

  const livePermissionVersion = membershipRow.permission_version;

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
