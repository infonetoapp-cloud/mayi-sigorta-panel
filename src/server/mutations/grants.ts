/**
 * Mayı Sigorta CRM — SensitiveActionGrant Yöneticisi (M1-T09 / RG-00)
 *
 * KRİTİK GÜVENLİK KURALLARI:
 * 1. Yalnızca doğrulanmış Secure Access Audience (CF_ACCESS_SECURE_AUDIENCE) üzerinden üretilebilir.
 * 2. TTL kesinlikle en fazla 180 saniyedir (3 dakika).
 * 3. Tek kullanımlıktır (Single-use).
 * 4. Aktör kullanıcı, aktör üyelik, acente, eylem, kanonik payload hash, hedef ID'leri,
 *    beklenen hedef versiyon, permission_version ve güvence (SECURE_GRANT) alanlarına sıkı sıkıya bağlıdır.
 * 5. Başka aktör, acente, payload veya versiyon için kullanılamaz; her uyuşmazlıkta fail-closed ret verir.
 */

import { computePayloadHash } from './canonical';
import type { AuthenticatedUserContext } from '../auth/identity';

export const MAX_GRANT_TTL_SECONDS = 180;

export interface SensitiveActionGrantRecord {
  readonly id: string;
  readonly evidenceHash: string;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly action: string;
  readonly payloadHash: string;
  readonly targetIdsJson: string;
  readonly expectedTargetVersion: number | null;
  readonly permissionVersion: number;
  readonly assurance: 'SECURE_GRANT';
  readonly status: 'ISSUED' | 'CONSUMED' | 'REVOKED';
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly consumedOperationId: string | null;
}

export interface IssueGrantResult {
  readonly grantToken: string;
  readonly grantRecord: SensitiveActionGrantRecord;
}

export async function computeEvidenceHash(token: string): Promise<string> {
  return computePayloadHash(token);
}

function generateSecureRandomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function canonicalizeTargetIds(targetIds: readonly string[]): string {
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
  }
  const seen = new Set<string>();
  for (const id of targetIds) {
    if (typeof id !== 'string' || id.trim().length === 0 || id !== id.trim()) {
      throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
    }
    if (seen.has(id)) {
      throw new Error('CANONICAL_PAYLOAD_UNSUPPORTED');
    }
    seen.add(id);
  }
  const sorted = [...targetIds].sort();
  return JSON.stringify(sorted);
}

export interface IssueAndPersistGrantInput {
  readonly agencyId: string;
  readonly action: string;
  readonly payloadHash: string;
  readonly targetIds: readonly string[];
  readonly expectedTargetVersion?: number | null;
  readonly ttlSeconds?: number;
  readonly now?: Date;
  readonly evidenceToken?: string;
}

export async function issueAndPersistSensitiveActionGrant(
  db: D1Database,
  userContext: AuthenticatedUserContext,
  input: IssueAndPersistGrantInput,
): Promise<IssueGrantResult> {
  // 1. Context güvencesi SECURE olmak zorundadır
  if (!userContext || userContext.assurance !== 'SECURE') {
    throw new Error('SECURE_ASSURANCE_REQUIRED');
  }

  // 2. İlk await öncesinde tüm girdi ve bağlam ilkellerini derinlemesine snapshot'la
  const actorUserId = String(userContext.userId);
  const targetAgencyId = String(input.agencyId);
  const targetAction = String(input.action);
  const targetPayloadHash = String(input.payloadHash);
  if (targetPayloadHash.length !== 64) {
    throw new Error('MALFORMED_PAYLOAD_HASH');
  }

  const targetIds = Array.isArray(input.targetIds) ? [...input.targetIds] : [];
  const sortedTargetsJson = canonicalizeTargetIds(targetIds);

  const targetExpectedVersion =
    input.expectedTargetVersion !== undefined && input.expectedTargetVersion !== null
      ? Number(input.expectedTargetVersion)
      : null;

  const requestedTtl = input.ttlSeconds ?? MAX_GRANT_TTL_SECONDS;
  if (!Number.isFinite(requestedTtl) || requestedTtl <= 0 || requestedTtl > MAX_GRANT_TTL_SECONDS) {
    throw new Error('INVALID_GRANT_TTL');
  }

  const contextMembership = userContext.memberships?.find(
    (m) => m.agencyId === targetAgencyId && m.status === 'ACTIVE',
  );
  if (!contextMembership) {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }
  const actorMembershipId = String(contextMembership.id);

  // 3. D1'deki canlı durumları doğrula (User, Agency, Membership)
  const userRow = await db
    .prepare('SELECT id, status FROM users WHERE id = ?')
    .bind(actorUserId)
    .first<{ id: string; status: string }>();
  if (!userRow || userRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_USER_REQUIRED');
  }

  const agencyRow = await db
    .prepare('SELECT id, status FROM agencies WHERE id = ?')
    .bind(targetAgencyId)
    .first<{ id: string; status: string }>();
  if (!agencyRow || agencyRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_AGENCY_REQUIRED');
  }

  const membershipRow = await db
    .prepare(
      'SELECT id, status, permission_version FROM agency_memberships WHERE id = ? AND agency_id = ? AND user_id = ?',
    )
    .bind(actorMembershipId, targetAgencyId, actorUserId)
    .first<{ id: string; status: string; permission_version: number }>();
  if (!membershipRow || membershipRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }

  const livePermissionVersion = Number(membershipRow.permission_version);
  if (livePermissionVersion !== contextMembership.permissionVersion) {
    throw new Error('MEMBERSHIP_PERMISSION_STALE');
  }

  // 4. Token ve Evidence Hash üretimi (Web Crypto)
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error('INVALID_DATE');
  }

  const issuedAtStr = now.toISOString();
  const expiresAtStr = new Date(nowMs + requestedTtl * 1000).toISOString();

  const grantToken = input.evidenceToken ?? generateSecureRandomToken();
  if (!/^[a-f0-9]{64}$/.test(grantToken)) throw new Error('MALFORMED_GRANT_EVIDENCE');
  const evidenceHash = await computeEvidenceHash(grantToken);
  const grantId = crypto.randomUUID();

  const grantRecord: SensitiveActionGrantRecord = {
    id: grantId,
    evidenceHash,
    agencyId: targetAgencyId,
    actorUserId,
    actorMembershipId,
    action: targetAction,
    payloadHash: targetPayloadHash,
    targetIdsJson: sortedTargetsJson,
    expectedTargetVersion: targetExpectedVersion,
    permissionVersion: livePermissionVersion,
    assurance: 'SECURE_GRANT',
    status: 'ISSUED',
    issuedAt: issuedAtStr,
    expiresAt: expiresAtStr,
    consumedAt: null,
    revokedAt: null,
    consumedOperationId: null,
  };

  await db
    .prepare(
      `INSERT INTO sensitive_action_grants (
         id, evidence_hash, agency_id, actor_user_id, actor_membership_id,
         action, payload_hash, target_ids_json, expected_target_version,
         permission_version, assurance, status, issued_at, expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SECURE_GRANT', 'ISSUED', ?, ?, ?, ?)`,
    )
    .bind(
      grantRecord.id,
      grantRecord.evidenceHash,
      grantRecord.agencyId,
      grantRecord.actorUserId,
      grantRecord.actorMembershipId,
      grantRecord.action,
      grantRecord.payloadHash,
      grantRecord.targetIdsJson,
      grantRecord.expectedTargetVersion,
      grantRecord.permissionVersion,
      grantRecord.issuedAt,
      grantRecord.expiresAt,
      grantRecord.issuedAt,
      grantRecord.issuedAt,
    )
    .run();

  return {
    grantToken,
    grantRecord,
  };
}
