/**
 * Mayı Sigorta CRM — Deterministik Idempotency Yöneticisi (M1-T09)
 *
 * KRİTİK GÜVENLİK VE TUTARLILIK KURALLARI:
 * 1. Idempotency anahtarı daima (agencyId + actorUserId + actorMembershipId + idempotencyKey) namespace'ine bağlıdır.
 * 2. Aynı namespace/key içinde action ve kanonik payload parmak izi aynıysa sonuç deterministik olarak tekrarlanır.
 * 3. Aynı anahtar ile farklı action veya payload gelirse deterministik CONFLICT üretilir.
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
  readonly action: string;
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
    SELECT id, action, status, payload_fingerprint, response_status, response_body
    FROM operation_receipts
    WHERE agency_id = ?
      AND actor_user_id = ?
      AND actor_membership_id = ?
      AND idempotency_key = ?
  `;

  const row = await db
    .prepare(query)
    .bind(input.agencyId, input.actorUserId, input.actorMembershipId, input.idempotencyKey)
    .first<OperationReceiptRow>();

  if (!row) {
    return { kind: 'NEW' };
  }

  if (row.action !== input.action) {
    return {
      kind: 'CONFLICT',
      code: 'IDEMPOTENCY_ACTION_MISMATCH',
    };
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
