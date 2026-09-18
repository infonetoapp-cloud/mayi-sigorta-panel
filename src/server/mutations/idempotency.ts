/**
 * Mayı Sigorta CRM — Deterministik Idempotency Yöneticisi (M1-T09)
 *
 * KRİTİK GÜVENLİK VE TUTARLILIK KURALLARI:
 * 1. Idempotency anahtarı daima (agencyId + actorUserId + actorMembershipId + action + idempotencyKey) bileşimine bağlıdır.
 * 2. Kanonik payload parmak izi (payloadFingerprint) eşleşirse aynı sonuç deterministik olarak tekrarlanır (replay).
 * 3. Aynı anahtar ile farklı payload parmak izi gelirse derhal CONFLICT ('IDEMPOTENCY_PAYLOAD_MISMATCH') üretilir.
 * 4. Devam eden işlem varsa 'IDEMPOTENCY_IN_PROGRESS' çatışması fırlatılır.
 * 5. Eşzamanlı mükerrer isteklerde en fazla bir iş etkisi ve bir başarı denetimi gerçekleşir.
 */

export class IdempotencyConflictError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? `IDEMPOTENCY_CONFLICT: ${code}`);
    this.name = 'IdempotencyConflictError';
    this.code = code;
  }
}

export interface CheckReceiptInput {
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly action: string;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
}

export type ReceiptCheckResult =
  | { readonly kind: 'NEW' }
  | { readonly kind: 'REPLAY'; readonly responseStatus: number; readonly responseBody: string }
  | { readonly kind: 'CONFLICT'; readonly code: string }
  | { readonly kind: 'IN_PROGRESS'; readonly code: string };

interface OperationReceiptRow {
  readonly id: string;
  readonly status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  readonly payload_fingerprint: string;
  readonly response_status: number | null;
  readonly response_body: string | null;
}

export async function checkIdempotencyReceipt(
  db: D1Database,
  input: CheckReceiptInput,
): Promise<ReceiptCheckResult> {
  const query = `
    SELECT id, status, payload_fingerprint, response_status, response_body
    FROM operation_receipts
    WHERE agency_id = ?
      AND actor_user_id = ?
      AND actor_membership_id = ?
      AND action = ?
      AND idempotency_key = ?
  `;

  const row = await db
    .prepare(query)
    .bind(
      input.agencyId,
      input.actorUserId,
      input.actorMembershipId,
      input.action,
      input.idempotencyKey,
    )
    .first<OperationReceiptRow>();

  if (!row) {
    return { kind: 'NEW' };
  }

  if (row.status === 'COMPLETED') {
    if (row.payload_fingerprint === input.payloadFingerprint) {
      return {
        kind: 'REPLAY',
        responseStatus: row.response_status ?? 200,
        responseBody: row.response_body ?? '{}',
      };
    }
    return {
      kind: 'CONFLICT',
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    };
  }

  if (row.status === 'IN_PROGRESS') {
    return {
      kind: 'IN_PROGRESS',
      code: 'IDEMPOTENCY_IN_PROGRESS',
    };
  }

  return {
    kind: 'CONFLICT',
    code: 'IDEMPOTENCY_PREVIOUS_EXECUTION_FAILED',
  };
}
