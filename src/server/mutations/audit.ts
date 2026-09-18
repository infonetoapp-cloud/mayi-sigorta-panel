/**
 * Mayı Sigorta CRM — Güvenli ve Kalıcı Denetim (Audit) Modeli (M1-T09)
 *
 * KRİTİK GÜVENLİK KURALLARI:
 * 1. Asla ham JWT, oturum çerezi, parola, token veya gizli anahtar loglanamaz.
 * 2. Yalnızca güvenli kimlikler, eylem, hedef, korelasyon, idempotency ve maskeli/temiz meta veri tutulur.
 * 3. Denetim kayıtları eklemeli (additive/append-only) ve değişmezdir (immutable).
 */

const SAFE_TOKEN_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;

const CODE_FIELDS = new Set(['reasonCode', 'resultCode', 'requestSource']);

export function sanitizeAuditMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  const obj = metadata as Record<string, unknown>;

  for (const [key, val] of Object.entries(obj)) {
    if (CODE_FIELDS.has(key)) {
      if (typeof val === 'string' && SAFE_TOKEN_REGEX.test(val)) {
        result[key] = val;
      }
    } else if (key === 'changedFieldCount') {
      if (typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 1000) {
        result[key] = val;
      }
    } else if (key === 'targetVersion') {
      if (typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 1_000_000_000) {
        result[key] = val;
      }
    } else if (key === 'replayed') {
      if (typeof val === 'boolean') {
        result[key] = val;
      }
    }
  }

  return result;
}

export interface BuildAuditRecordInput {
  readonly id?: string;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string | null;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly metadata?: unknown;
  readonly createdAt?: string;
}

export interface SafeAuditRecord {
  readonly id: string;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string | null;
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly metadataJson: string;
  readonly createdAt: string;
}

export function buildSafeAuditRecord(input: BuildAuditRecordInput): SafeAuditRecord {
  const safeMetadata = sanitizeAuditMetadata(input.metadata);
  const now = input.createdAt || new Date().toISOString();

  return {
    id: input.id || crypto.randomUUID(),
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey ?? null,
    outcome: input.outcome,
    metadataJson: JSON.stringify(safeMetadata),
    createdAt: now,
  };
}
