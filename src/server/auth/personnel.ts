import { z } from 'zod';
import type { Hono, Context } from 'hono';
import type { Env, AppDependencies } from '../index';
import { createApplicationIdentityResolver } from './identity';
import {
  createLocalSessionVerifier,
  parseLocalSessionConfig,
  getRequestSession,
  RECENT_PASSWORD_MS,
  LOCAL_AUTH_ISSUER,
  assertSessionChange,
  type SessionRow,
} from './session';
import {
  authAudit,
  authErrorResponse,
  authResponse,
  AuthHttpError,
  auditAuthDenial,
  readBoundedJson,
  requireAuthCsrf,
} from './routes';
import { generateTemporaryPassword, normalizeLoginEmail } from './password';
import { createDurableObjectPasswordHasher } from './password-do-adapter';
import { computePayloadHash } from '../mutations/canonical';
import { canonicalizeTargetIds, computeEvidenceHash } from '../mutations/grants';
import { getPermissionDefinition } from '../../shared/permissions';
import { parseCsrfConfig } from '../config';
import {
  safeJustification,
  permissionDeltas,
  personnelAuditMetadataSchema,
  type PersonnelAuditMetadata,
} from './audit-metadata';

const grantSchema = z
  .object({
    permission_code: z.string().max(100),
    scope: z.enum(['UNSCOPED', 'ASSIGNED', 'AGENCY']),
  })
  .strict();
const grantsSchema = z.array(grantSchema).max(100);
const base = {
  targetId: z.string().min(1).max(100),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
};
export const personnelCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      name: z.string().trim().min(2).max(120),
      email: z.string().max(320),
      template: z.enum(['personel', 'yetkili_personel']),
      grants: grantsSchema,
    })
    .strict(),
  z.object({ kind: z.literal('reset'), ...base }).strict(),
  z.object({ kind: z.literal('suspend'), ...base }).strict(),
  z.object({ kind: z.literal('inactivate'), ...base }).strict(),
  z.object({ kind: z.literal('reactivate'), ...base }).strict(),
  z.object({ kind: z.literal('permissions'), ...base, grants: grantsSchema }).strict(),
  z.object({ kind: z.literal('promote'), ...base, grants: grantsSchema }).strict(),
  z.object({ kind: z.literal('demote'), ...base, grants: grantsSchema }).strict(),
  z
    .object({
      kind: z.literal('transfer'),
      ...base,
      oldOwnerGrants: grantsSchema,
      newOwnerGrants: grantsSchema,
    })
    .strict(),
]);
type Command = z.infer<typeof personnelCommandSchema>;
function validateGrants(grants: z.infer<typeof grantsSchema>, type: 'OWNER' | 'MEMBER') {
  const map = new Map(grants.map((g) => [g.permission_code, g]));
  if (map.size !== grants.length)
    throw new AuthHttpError(400, 'INVALID_GRANTS', 'İzin listesi geçersiz.');
  const rank = { UNSCOPED: 0, ASSIGNED: 1, AGENCY: 2 };
  for (const g of grants) {
    const def = getPermissionDefinition(g.permission_code);
    if (
      !def ||
      (def.scopeKind === 'UNSCOPED' ? g.scope !== 'UNSCOPED' : g.scope === 'UNSCOPED') ||
      (type === 'OWNER' && def.classification === 'NORMAL')
    )
      throw new AuthHttpError(400, 'INVALID_GRANTS', 'İzin listesi geçersiz.');
    for (const dependency of def.dependencies) {
      const dep = getPermissionDefinition(dependency)!;
      if (type === 'OWNER' && dep.classification === 'NORMAL') continue;
      const dg = map.get(dependency);
      if (!dg || (dep.scopeKind === 'RECORD_SCOPED' && rank[dg.scope] < rank[g.scope]))
        throw new AuthHttpError(
          400,
          'INVALID_GRANTS',
          'İzin bağımlılıkları veya kapsamı geçersiz.',
        );
    }
  }
}
function action(command: Command) {
  return `personnel.${command.kind}`;
}
function target(command: Command, row: SessionRow) {
  return command.kind === 'create' ? row.agency_id : command.targetId;
}
function commandKey(c: Context<{ Bindings: Env }>) {
  const key = c.req.header('idempotency-key');
  if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(key))
    throw new AuthHttpError(400, 'IDEMPOTENCY_REQUIRED', 'İşlem anahtarı gerekli.');
  return key;
}
async function authorizeOwner(c: Context<{ Bindings: Env }>, csrf = true): Promise<SessionRow> {
  const principal = await createLocalSessionVerifier({
    config: parseLocalSessionConfig(c.env),
  }).verify(c.req.raw, 'SECURE');
  const context = await createApplicationIdentityResolver(c.env.DB).resolve(principal);
  const row = getRequestSession(c.req.raw)!;
  if (!context.memberships.some((m) => m.id === row.membership_id && m.type === 'OWNER'))
    throw new AuthHttpError(403, 'OWNER_REQUIRED', 'Bu işlem yalnız acente sahibine açıktır.');
  if (csrf) await requireAuthCsrf(c, row);
  return row;
}
function actorAssertion(db: D1Database, row: SessionRow, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,count(*),'ACTOR_AUTHORITY_CHANGED'
    FROM local_sessions s JOIN local_credentials c ON c.user_id=s.user_id AND c.identity_id=s.identity_id
    JOIN auth_identities i ON i.id=s.identity_id AND i.user_id=s.user_id JOIN users u ON u.id=s.user_id
    JOIN agency_memberships m ON m.id=s.membership_id AND m.user_id=s.user_id JOIN agencies a ON a.id=m.agency_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.kind='NORMAL' AND s.expires_at>? AND s.last_seen_at>?
    AND s.recent_password_at<=? AND s.recent_password_at>? AND s.credential_version=c.credential_version AND c.must_change_password=0 AND c.login_enabled=1
    AND s.permission_version=m.permission_version AND m.permission_version=? AND m.type='OWNER' AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.id=? AND u.status='ACTIVE' AND i.status='ACTIVE' AND i.issuer=?
    AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
    AND s.last_seen_at>CAST(unixepoch('subsec')*1000 AS INTEGER)-28800000
    AND s.recent_password_at>CAST(unixepoch('subsec')*1000 AS INTEGER)-300000`,
    )
    .bind(
      crypto.randomUUID(),
      row.token_hash,
      now,
      now - 28800000,
      now,
      now - RECENT_PASSWORD_MS,
      row.permission_version,
      row.agency_id,
      LOCAL_AUTH_ISSUER,
    );
}
function replacePermissions(
  db: D1Database,
  membershipId: string,
  grants: z.infer<typeof grantsSchema>,
): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM membership_permissions WHERE membership_id=?').bind(membershipId),
    ...grants.map((g) =>
      db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), membershipId, g.permission_code, g.scope),
    ),
  ];
}
function receipt(
  db: D1Database,
  row: SessionRow,
  key: string,
  fingerprint: string,
  targetUserId: string,
  now: number,
  proof?: { response: string | null; auditId: string; grantId: string },
) {
  return db
    .prepare(
      'INSERT INTO credential_operation_receipts(id,actor_user_id,agency_id,operation_key,fingerprint,target_user_id,created_at,actor_membership_id,safe_response_json,effect_audit_id,grant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      crypto.randomUUID(),
      row.user_id,
      row.agency_id,
      key,
      fingerprint,
      targetUserId,
      now,
      row.membership_id,
      proof?.response ?? null,
      proof?.auditId ?? null,
      proof?.grantId ?? null,
    );
}
async function parseCommand(raw: unknown): Promise<Command> {
  const result = personnelCommandSchema.safeParse(raw);
  if (!result.success) throw new AuthHttpError(400, 'INVALID_INPUT', 'Personel komutu geçersiz.');
  const command = result.data;
  if ('reason' in command) {
    try {
      command.reason = safeJustification(command.reason);
    } catch {
      throw new AuthHttpError(
        400,
        'UNSAFE_JUSTIFICATION',
        'Gerekçe kişisel veri veya güvenlik sırrı içermemelidir.',
      );
    }
  }
  if (command.kind === 'create') {
    command.email = normalizeLoginEmail(command.email);
    validateGrants(command.grants, 'MEMBER');
  } else if ('grants' in command && command.kind !== 'permissions')
    validateGrants(command.grants, command.kind === 'promote' ? 'OWNER' : 'MEMBER');
  else if (command.kind === 'transfer') {
    validateGrants(command.oldOwnerGrants, 'MEMBER');
    validateGrants(command.newOwnerGrants, 'OWNER');
  }
  return command;
}
async function validateTargetGrants(db: D1Database, command: Command, agencyId: string) {
  if (command.kind !== 'permissions') return;
  const member = await db
    .prepare('SELECT type FROM agency_memberships WHERE id=? AND agency_id=?')
    .bind(command.targetId, agencyId)
    .first<{ type: 'OWNER' | 'MEMBER' }>();
  if (!member) throw new AuthHttpError(409, 'CONFLICT', 'Personel kaydı kullanılamıyor.');
  validateGrants(command.grants, member.type);
}
const liveOwnerReplayPredicate = `EXISTS(SELECT 1 FROM local_sessions s
  JOIN local_credentials c ON c.user_id=s.user_id AND c.identity_id=s.identity_id
  JOIN auth_identities i ON i.id=s.identity_id AND i.user_id=s.user_id JOIN users u ON u.id=s.user_id
  JOIN agency_memberships m ON m.id=s.membership_id AND m.user_id=s.user_id JOIN agencies a ON a.id=m.agency_id
  WHERE s.token_hash=? AND s.membership_id=? AND s.user_id=? AND a.id=? AND s.revoked_at IS NULL
  AND s.kind='NORMAL' AND s.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND s.last_seen_at>CAST(unixepoch('subsec')*1000 AS INTEGER)-28800000
  AND s.recent_password_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND s.recent_password_at>CAST(unixepoch('subsec')*1000 AS INTEGER)-300000
  AND c.credential_version=s.credential_version AND c.login_enabled=1 AND c.must_change_password=0
  AND m.permission_version=s.permission_version AND m.permission_version=? AND m.status='ACTIVE' AND m.type='OWNER'
  AND u.status='ACTIVE' AND i.status='ACTIVE' AND i.issuer='urn:mayisigorta:local-auth:v1'
  AND i.email_provenance='OWNER_PROVISIONED' AND a.status='ACTIVE')`;
function replayActorBindings(row: SessionRow) {
  return [row.token_hash, row.membership_id, row.user_id, row.agency_id, row.permission_version];
}
async function replayIssuedGrant(
  db: D1Database,
  row: SessionRow,
  command: Command,
  key: string,
  fingerprint: string,
  evidenceHash: string,
): Promise<boolean> {
  const existing = await db
    .prepare(
      'SELECT fingerprint,actor_membership_id,effect_audit_id,grant_id FROM credential_operation_receipts WHERE actor_user_id=? AND agency_id=? AND operation_key=?',
    )
    .bind(row.user_id, row.agency_id, key)
    .first<{
      fingerprint: string;
      actor_membership_id: string;
      effect_audit_id: string;
      grant_id: string;
    }>();
  if (!existing) return false;
  if (existing.fingerprint !== fingerprint)
    throw new AuthHttpError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'İşlem anahtarı farklı içerikle kullanıldı.',
    );
  const now = Date.now();
  const audit = await db
    .prepare(
      "SELECT metadata_json FROM audit_events WHERE id=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=? AND action='sensitive_action_grant.issued' AND target_type='sensitive_action_grants' AND target_id=? AND outcome='SUCCESS'",
    )
    .bind(
      existing.effect_audit_id,
      row.agency_id,
      row.user_id,
      row.membership_id,
      key,
      existing.grant_id,
    )
    .first<{ metadata_json: string }>();
  let metadata: PersonnelAuditMetadata | null = null;
  try {
    metadata = audit ? personnelAuditMetadataSchema.parse(JSON.parse(audit.metadata_json)) : null;
  } catch {
    /* corrupt persisted evidence denies */
  }
  if (
    existing.actor_membership_id !== row.membership_id ||
    !metadata ||
    JSON.stringify(metadata) !== audit!.metadata_json ||
    metadata.grantId !== existing.grant_id ||
    metadata.effectAuditId !== existing.effect_audit_id ||
    metadata.action !== action(command) ||
    metadata.actorPermissionVersion !== row.permission_version ||
    metadata.reasonCode !== 'OWNER_ACTION_APPROVED' ||
    canonicalizeTargetIds(metadata.grantTargets) !==
      canonicalizeTargetIds([target(command, row)]) ||
    metadata.expectedTargetVersion !== (command.kind === 'create' ? null : command.expectedVersion)
  )
    throw new AuthHttpError(409, 'GRANT_UNAVAILABLE', 'Yeni onay gerekli.');
  const grant = await db
    .prepare(
      `SELECT g.id FROM sensitive_action_grants g
    JOIN credential_operation_receipts r ON r.actor_user_id=g.actor_user_id AND r.agency_id=g.agency_id AND r.operation_key=? AND r.fingerprint=g.payload_hash AND r.target_user_id=g.actor_user_id
    WHERE g.evidence_hash=? AND g.agency_id=? AND g.actor_user_id=? AND g.actor_membership_id=?
    AND g.action=? AND g.payload_hash=? AND g.target_ids_json=? AND g.expected_target_version IS ?
    AND g.permission_version=? AND g.assurance='SECURE_GRANT' AND g.status='ISSUED'
    AND g.consumed_at IS NULL AND g.consumed_operation_id IS NULL
    AND g.issued_at<=? AND g.expires_at>? AND julianday(g.expires_at)>julianday(g.issued_at)
    AND (julianday(g.expires_at)-julianday(g.issued_at))*86400000<=180001
    AND (SELECT count(*) FROM audit_events a WHERE a.agency_id=g.agency_id AND a.actor_user_id=g.actor_user_id
      AND a.actor_membership_id=g.actor_membership_id AND a.action='sensitive_action_grant.issued'
      AND a.target_id=g.id AND a.idempotency_key=r.operation_key AND a.outcome='SUCCESS')=1
    AND g.id=? AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND (? IS NULL OR EXISTS(SELECT 1 FROM agency_memberships t WHERE t.id=? AND t.agency_id=g.agency_id AND t.version=?))
    AND ${liveOwnerReplayPredicate}`,
    )
    .bind(
      key,
      evidenceHash,
      row.agency_id,
      row.user_id,
      row.membership_id,
      action(command),
      fingerprint,
      canonicalizeTargetIds([target(command, row)]),
      command.kind === 'create' ? null : command.expectedVersion,
      row.permission_version,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      existing.grant_id,
      command.kind === 'create' ? null : command.expectedVersion,
      target(command, row),
      command.kind === 'create' ? null : command.expectedVersion,
      ...replayActorBindings(row),
    )
    .first();
  if (!grant) throw new AuthHttpError(409, 'GRANT_UNAVAILABLE', 'Yeni onay gerekli.');
  // A receipt is historical evidence, never reusable OWNER capability or assurance.
  return true;
}
const safeResultSchema = z
  .object({
    userId: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    membershipId: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  })
  .strict();
type MemberEvidence = {
  id: string;
  user_id: string;
  type: 'OWNER' | 'MEMBER';
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'INVITED';
  version: number;
  permission_version: number;
};
async function memberEvidence(db: D1Database, membershipId: string, agencyId: string) {
  return db
    .prepare(
      'SELECT id,user_id,type,status,version,permission_version FROM agency_memberships WHERE id=? AND agency_id=?',
    )
    .bind(membershipId, agencyId)
    .first<MemberEvidence>();
}
async function memberGrants(db: D1Database, membershipId: string) {
  return (
    await db
      .prepare(
        'SELECT permission_code,scope FROM membership_permissions WHERE membership_id=? ORDER BY permission_code',
      )
      .bind(membershipId)
      .all<{ permission_code: string; scope: string }>()
  ).results;
}
async function buildPersonnelEvidence(
  db: D1Database,
  row: SessionRow,
  command: Command,
  userId: string,
  membershipId: string,
  grantId: string,
  auditId: string,
  issued = false,
): Promise<PersonnelAuditMetadata> {
  const before =
    command.kind === 'create' ? null : await memberEvidence(db, membershipId, row.agency_id);
  if (command.kind !== 'create' && (!before || before.version !== command.expectedVersion))
    throw new AuthHttpError(409, 'CONFLICT', 'Personel kaydı değişti.');
  const old = before ? await memberGrants(db, membershipId) : [];
  const next =
    command.kind === 'transfer'
      ? command.newOwnerGrants
      : 'grants' in command
        ? command.grants
        : old;
  let secondary: PersonnelAuditMetadata['secondary'] = null;
  if (command.kind === 'transfer') {
    const actor = await memberEvidence(db, row.membership_id, row.agency_id);
    if (!actor) throw new AuthHttpError(409, 'CONFLICT', 'Sahip kaydı değişti.');
    secondary = {
      membershipId: actor.id,
      userId: actor.user_id,
      beforeVersion: actor.version,
      afterVersion: actor.version + (issued ? 0 : 1),
      beforePermissionVersion: actor.permission_version,
      afterPermissionVersion: actor.permission_version + (issued ? 0 : 1),
      beforeType: actor.type,
      afterType: issued ? actor.type : 'MEMBER',
      beforeStatus: actor.status,
      afterStatus: actor.status,
      permissionDeltas: issued
        ? []
        : permissionDeltas(await memberGrants(db, actor.id), command.oldOwnerGrants),
    };
  }
  return personnelAuditMetadataSchema.parse({
    actorKind: 'USER',
    reasonCode: issued ? 'OWNER_ACTION_APPROVED' : 'OWNER_ACTION_COMPLETED',
    actorPermissionVersion: row.permission_version,
    grantId,
    effectAuditId: auditId,
    action: action(command),
    targetMembershipId: membershipId,
    targetUserId: userId,
    grantTargets: [target(command, row)],
    expectedTargetVersion: command.kind === 'create' ? null : command.expectedVersion,
    beforeVersion: before?.version ?? null,
    afterVersion: (before?.version ?? 0) + (issued && before ? 0 : 1),
    beforePermissionVersion: before?.permission_version ?? null,
    afterPermissionVersion:
      (before?.permission_version ?? 0) + ((issued && before) || command.kind === 'reset' ? 0 : 1),
    beforeStatus: before?.status ?? null,
    afterStatus: issued
      ? (before?.status ?? null)
      : command.kind === 'suspend'
        ? 'SUSPENDED'
        : command.kind === 'inactivate'
          ? 'INACTIVE'
          : command.kind === 'reactivate' || command.kind === 'create'
            ? 'ACTIVE'
            : before!.status,
    beforeType: before?.type ?? null,
    afterType: issued
      ? (before?.type ?? null)
      : command.kind === 'promote' || command.kind === 'transfer'
        ? 'OWNER'
        : command.kind === 'demote' || command.kind === 'create'
          ? 'MEMBER'
          : before!.type,
    changedFields: issued
      ? []
      : command.kind === 'create'
        ? ['membership', 'permissions', 'credential']
        : command.kind === 'reset' || command.kind === 'reactivate'
          ? ['membership', 'credential', 'sessions']
          : [
              'membership',
              'permissions',
              'sessions',
              ...(command.kind === 'transfer' ? ['ownership'] : []),
            ],
    justification: command.kind === 'create' ? 'OWNER_PROVISIONED_EMPLOYEE' : command.reason,
    permissionDeltas: issued ? [] : permissionDeltas(old, next),
    secondary,
  });
}
function targetEvidenceAssertions(
  db: D1Database,
  agencyId: string,
  metadata: PersonnelAuditMetadata,
): D1PreparedStatement[] {
  const snapshots = [
    ...(metadata.beforeVersion === null
      ? []
      : [
          {
            id: metadata.targetMembershipId,
            userId: metadata.targetUserId,
            version: metadata.beforeVersion,
            permissionVersion: metadata.beforePermissionVersion,
            type: metadata.beforeType,
            status: metadata.beforeStatus,
          },
        ]),
    ...(metadata.secondary
      ? [
          {
            id: metadata.secondary.membershipId,
            userId: metadata.secondary.userId,
            version: metadata.secondary.beforeVersion,
            permissionVersion: metadata.secondary.beforePermissionVersion,
            type: metadata.secondary.beforeType,
            status: metadata.secondary.beforeStatus,
          },
        ]
      : []),
  ];
  return snapshots.map((s) =>
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,count(*),'PERSONNEL_TARGET_CHANGED'
    FROM agency_memberships m WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.version=? AND m.permission_version=? AND m.type=? AND m.status=?`,
      )
      .bind(
        crypto.randomUUID(),
        s.id,
        agencyId,
        s.userId,
        s.version,
        s.permissionVersion,
        s.type,
        s.status,
      ),
  );
}
async function replayCompletedCommand(
  db: D1Database,
  row: SessionRow,
  command: Command,
  key: string,
  fingerprint: string,
  evidenceHash: string,
) {
  const r = await db
    .prepare(
      'SELECT * FROM credential_operation_receipts WHERE actor_user_id=? AND agency_id=? AND operation_key=?',
    )
    .bind(row.user_id, row.agency_id, key)
    .first<{
      fingerprint: string;
      actor_membership_id: string;
      safe_response_json: string | null;
      effect_audit_id: string;
      grant_id: string;
      target_user_id: string;
    }>();
  if (!r) return null;
  if (r.fingerprint !== fingerprint)
    throw new AuthHttpError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'İşlem anahtarı farklı içerikle kullanıldı.',
    );
  if (['create', 'reset', 'reactivate'].includes(command.kind))
    throw new AuthHttpError(
      409,
      'ONE_TIME_RESPONSE_UNAVAILABLE',
      'Geçici şifre tekrar gösterilemez; yeni anahtar ve onayla sıfırlayın.',
    );
  try {
    const result = safeResultSchema.parse(JSON.parse(r.safe_response_json!));
    if (
      JSON.stringify(result) !== r.safe_response_json ||
      r.actor_membership_id !== row.membership_id ||
      result.userId !== r.target_user_id ||
      command.kind === 'create' ||
      result.membershipId !== command.targetId
    )
      throw new Error('RECEIPT_BINDING');
    const audit = await db
      .prepare(
        "SELECT metadata_json FROM audit_events WHERE id=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=? AND target_type='users' AND target_id=? AND idempotency_key=? AND outcome='SUCCESS'",
      )
      .bind(
        r.effect_audit_id,
        row.agency_id,
        row.user_id,
        row.membership_id,
        action(command),
        result.userId,
        key,
      )
      .first<{ metadata_json: string }>();
    if (!audit) throw new Error('EFFECT_MISSING');
    const metadata = personnelAuditMetadataSchema.parse(JSON.parse(audit.metadata_json));
    if (
      JSON.stringify(metadata) !== audit.metadata_json ||
      metadata.effectAuditId !== r.effect_audit_id ||
      metadata.grantId !== r.grant_id ||
      metadata.action !== action(command) ||
      metadata.targetMembershipId !== result.membershipId ||
      metadata.targetUserId !== result.userId ||
      metadata.beforeVersion !== command.expectedVersion ||
      metadata.afterVersion !== command.expectedVersion + 1 ||
      metadata.reasonCode !== 'OWNER_ACTION_COMPLETED' ||
      metadata.justification !== command.reason
    )
      throw new Error('EFFECT_BINDING');
    const proof = await db
      .prepare(
        `SELECT g.id FROM sensitive_action_grants g WHERE g.id=? AND g.evidence_hash=? AND g.agency_id=? AND g.actor_user_id=? AND g.actor_membership_id=? AND g.action=? AND g.payload_hash=? AND g.target_ids_json=? AND g.expected_target_version=? AND g.permission_version=? AND g.status='CONSUMED' AND g.consumed_operation_id=? AND g.consumed_at IS NOT NULL
      AND (SELECT count(*) FROM audit_events a WHERE a.action='sensitive_action_grant.consumed' AND a.agency_id=g.agency_id AND a.actor_user_id=g.actor_user_id AND a.actor_membership_id=g.actor_membership_id AND a.target_id=g.id AND a.idempotency_key=? AND a.outcome='SUCCESS' AND a.metadata_json=?)=1
      AND (SELECT count(*) FROM audit_events a WHERE a.action=? AND a.agency_id=g.agency_id AND a.actor_user_id=g.actor_user_id AND a.actor_membership_id=g.actor_membership_id AND a.idempotency_key=? AND a.outcome='SUCCESS')=1
      AND EXISTS(SELECT 1 FROM agency_memberships t WHERE t.id=? AND t.agency_id=g.agency_id AND t.user_id=?)
      AND ${liveOwnerReplayPredicate}`,
      )
      .bind(
        r.grant_id,
        evidenceHash,
        row.agency_id,
        row.user_id,
        row.membership_id,
        action(command),
        fingerprint,
        canonicalizeTargetIds([command.targetId]),
        command.expectedVersion,
        metadata.actorPermissionVersion,
        key,
        key,
        audit.metadata_json,
        action(command),
        key,
        result.membershipId,
        result.userId,
        ...replayActorBindings(row),
      )
      .first();
    const liveTarget = await memberEvidence(db, result.membershipId, row.agency_id);
    if (
      !proof ||
      liveTarget?.user_id !== result.userId ||
      (metadata.secondary &&
        (metadata.secondary.membershipId !== row.membership_id ||
          metadata.secondary.userId !== row.user_id ||
          !(await memberEvidence(db, metadata.secondary.membershipId, row.agency_id))))
    )
      throw new Error('TARGET_OR_GRANT_PROOF');
    await actorAssertion(db, row, Date.now()).run();
    return result;
  } catch {
    throw new AuthHttpError(
      409,
      'REPLAY_UNAVAILABLE',
      'Güncel yetki veya işlem kanıtı doğrulanamadı.',
    );
  }
}
export function registerPersonnelRoutes(
  app: Hono<{ Bindings: Env }>,
  dependencies: AppDependencies,
): void {
  app.get('/api/personnel', async (c) => {
    try {
      const principal = await createLocalSessionVerifier({
        config: parseLocalSessionConfig(c.env),
      }).verify(c.req.raw);
      const context = await createApplicationIdentityResolver(c.env.DB).resolve(principal);
      const row = getRequestSession(c.req.raw)!;
      if (!context.memberships.some((m) => m.id === row.membership_id && m.type === 'OWNER'))
        throw new AuthHttpError(403, 'OWNER_REQUIRED', 'Bu işlem yalnız acente sahibine açıktır.');
      const query = z
        .object({
          page_size: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).max(100).optional(),
        })
        .strict()
        .safeParse(c.req.query());
      if (!query.success) throw new AuthHttpError(400, 'INVALID_INPUT', 'Sayfalama geçersiz.');
      const rows = await c.env.DB.prepare(
        `SELECT m.id,m.user_id,m.type,m.status,m.version,m.permission_version,u.display_name,c.login_email FROM agency_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN local_credentials c ON c.user_id=m.user_id WHERE m.agency_id=? AND m.id>? ORDER BY m.id LIMIT ?`,
      )
        .bind(row.agency_id, query.data.cursor ?? '', query.data.page_size + 1)
        .all();
      const page = rows.results.slice(0, query.data.page_size);
      const permissions = page.length
        ? await c.env.DB.prepare(
            `SELECT p.membership_id,p.permission_code,p.scope FROM membership_permissions p JOIN agency_memberships m ON m.id=p.membership_id WHERE m.agency_id=? AND m.id IN (SELECT value FROM json_each(?))`,
          )
            .bind(row.agency_id, JSON.stringify(page.map((m) => m.id)))
            .all()
        : { results: [] };
      return authResponse(c, {
        personnel: page.map((m) => ({
          ...m,
          grants: permissions.results
            .filter((p) => p.membership_id === m.id)
            .map((p) => ({ permission_code: p.permission_code, scope: p.scope })),
        })),
        nextCursor: rows.results.length > query.data.page_size ? page.at(-1)!.id : null,
      });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });
  app.post('/secure/api/personnel/grants', async (c) => {
    try {
      const row = await authorizeOwner(c);
      const command = await parseCommand(await readBoundedJson(c.req.raw));
      await validateTargetGrants(c.env.DB, command, row.agency_id);
      const key = `grant:${commandKey(c)}`;
      const fingerprint = await computePayloadHash({
        action: action(command),
        target: target(command, row),
        command,
      });
      const db = c.env.DB;
      const now = Date.now();
      const secret = parseCsrfConfig(c.env).CSRF_SECRET;
      const hmacKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const raw = await crypto.subtle.sign(
        'HMAC',
        hmacKey,
        new TextEncoder().encode(`${row.token_hash}:${key}:${fingerprint}`),
      );
      const token = Array.from(new Uint8Array(raw), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      const evidenceHash = await computeEvidenceHash(token);
      if (await replayIssuedGrant(db, row, command, key, fingerprint, evidenceHash)) {
        return authResponse(c, { grantEvidenceToken: token });
      }
      const grantId = crypto.randomUUID();
      const issuanceAuditId = crypto.randomUUID();
      const issuanceTarget =
        command.kind === 'create'
          ? null
          : await memberEvidence(db, command.targetId, row.agency_id);
      const issuanceMetadata = await buildPersonnelEvidence(
        db,
        row,
        command,
        issuanceTarget?.user_id ?? row.user_id,
        issuanceTarget?.id ?? row.membership_id,
        grantId,
        issuanceAuditId,
        true,
      );
      try {
        await db.batch([
          actorAssertion(db, row, now),
          ...targetEvidenceAssertions(db, row.agency_id, issuanceMetadata),
          db
            .prepare(
              `INSERT INTO sensitive_action_grants(id,evidence_hash,agency_id,actor_user_id,actor_membership_id,action,payload_hash,target_ids_json,expected_target_version,permission_version,assurance,status,issued_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'SECURE_GRANT','ISSUED',?,?,?,?)`,
            )
            .bind(
              grantId,
              evidenceHash,
              row.agency_id,
              row.user_id,
              row.membership_id,
              action(command),
              fingerprint,
              canonicalizeTargetIds([target(command, row)]),
              command.kind === 'create' ? null : command.expectedVersion,
              row.permission_version,
              new Date(now).toISOString(),
              new Date(now + 180000).toISOString(),
              new Date(now).toISOString(),
              new Date(now).toISOString(),
            ),
          receipt(db, row, key, fingerprint, row.user_id, now, {
            response: null,
            auditId: issuanceAuditId,
            grantId,
          }),
          authAudit(
            db,
            row,
            'sensitive_action_grant.issued',
            grantId,
            now,
            key,
            issuanceMetadata,
            issuanceAuditId,
            'sensitive_action_grants',
          ),
        ]);
      } catch (error) {
        // Only a unique race can reconcile; generic storage/audit failures never replay.
        if (
          !/UNIQUE constraint failed|SENSITIVE_GRANT_ROW_REPLACEMENT_FORBIDDEN/i.test(
            String(error),
          ) ||
          !(await replayIssuedGrant(db, row, command, key, fingerprint, evidenceHash))
        )
          throw error;
      }
      return authResponse(c, { grantEvidenceToken: token });
    } catch (error) {
      await auditAuthDenial(c, 'personnel.denied');
      return authErrorResponse(c, error);
    }
  });
  app.post('/secure/api/personnel/commands', async (c) => {
    try {
      const row = await authorizeOwner(c);
      const raw = z
        .object({ command: z.unknown(), grantEvidenceToken: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .safeParse(await readBoundedJson(c.req.raw));
      if (!raw.success) throw new AuthHttpError(400, 'INVALID_INPUT', 'Girdi geçersiz.');
      const command = await parseCommand(raw.data.command);
      const key = commandKey(c);
      const db = c.env.DB;
      const fingerprint = await computePayloadHash({
        action: action(command),
        target: target(command, row),
        command,
      });
      const evidenceHash = await computeEvidenceHash(raw.data.grantEvidenceToken);
      const replay = await replayCompletedCommand(db, row, command, key, fingerprint, evidenceHash);
      if (replay) return authResponse(c, replay);
      await validateTargetGrants(db, command, row.agency_id);
      const targetRow =
        command.kind === 'create'
          ? null
          : await db
              .prepare(
                'SELECT id,user_id,status,type,version FROM agency_memberships WHERE id=? AND agency_id=?',
              )
              .bind(command.targetId, row.agency_id)
              .first<{
                id: string;
                user_id: string;
                status: string;
                type: 'OWNER' | 'MEMBER';
                version: number;
              }>();
      if (
        command.kind !== 'create' &&
        (!targetRow || targetRow.version !== command.expectedVersion)
      )
        throw new AuthHttpError(409, 'CONFLICT', 'Personel kaydı değişti veya kullanılamıyor.');
      if (
        command.kind === 'reactivate' &&
        targetRow!.status !== 'INACTIVE' &&
        targetRow!.status !== 'SUSPENDED'
      )
        throw new AuthHttpError(409, 'INVALID_STATUS', 'Personel yeniden etkinleştirilemez.');
      if (
        ['promote', 'demote', 'transfer', 'permissions'].includes(command.kind) &&
        targetRow!.status !== 'ACTIVE'
      )
        throw new AuthHttpError(409, 'INVALID_STATUS', 'Aktif personel gerekli.');
      const temporary = ['create', 'reset', 'reactivate'].includes(command.kind)
        ? generateTemporaryPassword()
        : null;
      const verifier = temporary
        ? await (
            dependencies.passwordHasher ?? createDurableObjectPasswordHasher(c.env.PASSWORD_KDF)
          ).hash(temporary)
        : null;
      const now = Date.now(),
        iso = new Date(now).toISOString();
      const userId = targetRow?.user_id ?? crypto.randomUUID();
      const membershipId = targetRow?.id ?? crypto.randomUUID();
      const identityId = crypto.randomUUID();
      const grant = await db
        .prepare('SELECT id FROM sensitive_action_grants WHERE evidence_hash=?')
        .bind(evidenceHash)
        .first<{ id: string }>();
      if (!grant) throw new AuthHttpError(409, 'GRANT_UNAVAILABLE', 'Yeni onay gerekli.');
      const effectAuditId = crypto.randomUUID();
      const effectMetadata = await buildPersonnelEvidence(
        db,
        row,
        command,
        userId,
        membershipId,
        grant.id,
        effectAuditId,
      );
      const ops: D1PreparedStatement[] = [
        actorAssertion(db, row, now),
        ...targetEvidenceAssertions(db, row.agency_id, effectMetadata),
      ];
      ops.push(
        db
          .prepare(
            `UPDATE sensitive_action_grants SET status='CONSUMED',consumed_at=?,consumed_operation_id=?,updated_at=? WHERE evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=? AND payload_hash=? AND target_ids_json=? AND expected_target_version IS ? AND permission_version=? AND status='ISSUED' AND expires_at>? AND issued_at<=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          )
          .bind(
            iso,
            key,
            iso,
            evidenceHash,
            row.agency_id,
            row.user_id,
            row.membership_id,
            action(command),
            fingerprint,
            canonicalizeTargetIds([target(command, row)]),
            command.kind === 'create' ? null : command.expectedVersion,
            row.permission_version,
            iso,
            iso,
          ),
        assertSessionChange(db),
      );
      if (command.kind === 'create') {
        ops.push(
          db
            .prepare("INSERT INTO users(id,status,display_name) VALUES(?,'ACTIVE',?)")
            .bind(userId, command.name),
          db
            .prepare(
              "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance) VALUES(?,?,?,?,?,'OWNER_PROVISIONED')",
            )
            .bind(identityId, userId, LOCAL_AUTH_ISSUER, crypto.randomUUID(), command.email),
          db
            .prepare(
              "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at) VALUES(?,?,?,'MEMBER','ACTIVE',?,?,?)",
            )
            .bind(
              membershipId,
              row.agency_id,
              userId,
              command.email,
              new Date(now + 86400000).toISOString(),
              iso,
            ),
          db
            .prepare(
              'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,updated_at) VALUES(?,?,?,?,1,?,?)',
            )
            .bind(userId, identityId, command.email, verifier, now + 86400000, now),
          ...replacePermissions(db, membershipId, command.grants),
        );
      } else {
        const beforeType = targetRow!.type;
        const status =
          command.kind === 'suspend'
            ? 'SUSPENDED'
            : command.kind === 'inactivate'
              ? 'INACTIVE'
              : command.kind === 'reactivate'
                ? 'ACTIVE'
                : targetRow!.status;
        const type =
          command.kind === 'promote' ? 'OWNER' : command.kind === 'demote' ? 'MEMBER' : beforeType;
        if (command.kind === 'reset') {
          ops.push(
            db
              .prepare(
                'UPDATE agency_memberships SET version=version+1 WHERE id=? AND agency_id=? AND version=?',
              )
              .bind(membershipId, row.agency_id, command.expectedVersion),
            assertSessionChange(db),
          );
        }
        if (command.kind !== 'reset') {
          if (command.kind === 'transfer') {
            if (beforeType !== 'MEMBER' || membershipId === row.membership_id)
              throw new AuthHttpError(409, 'INVALID_TRANSFER', 'Aktif MEMBER hedef gerekli.');
            ops.push(
              db
                .prepare(
                  "UPDATE agency_memberships SET type='OWNER',version=version+1,permission_version=permission_version+1 WHERE id=? AND version=? AND status='ACTIVE'",
                )
                .bind(membershipId, command.expectedVersion),
              assertSessionChange(db),
              ...replacePermissions(db, membershipId, command.newOwnerGrants),
              db
                .prepare(
                  "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id=? AND type='OWNER' AND status='ACTIVE' AND permission_version=?",
                )
                .bind(row.membership_id, row.permission_version),
              assertSessionChange(db),
              ...replacePermissions(db, row.membership_id, command.oldOwnerGrants),
            );
          } else {
            ops.push(
              db
                .prepare(
                  `UPDATE agency_memberships SET type=?,status=?,activated_at=coalesce(activated_at,?),suspended_at=CASE WHEN ?='SUSPENDED' THEN ? ELSE suspended_at END,inactivated_at=CASE WHEN ?='INACTIVE' THEN ? ELSE inactivated_at END,version=version+1,permission_version=permission_version+1 WHERE id=? AND version=?`,
                )
                .bind(
                  type,
                  status,
                  iso,
                  status,
                  iso,
                  status,
                  iso,
                  membershipId,
                  command.expectedVersion,
                ),
              assertSessionChange(db),
            );
            if ('grants' in command) {
              validateGrants(command.grants, type);
              ops.push(...replacePermissions(db, membershipId, command.grants));
            }
          }
        }
        if (verifier)
          ops.push(
            db
              .prepare(
                'UPDATE local_credentials SET verifier=?,credential_version=credential_version+1,must_change_password=1,temporary_expires_at=?,login_enabled=1,updated_at=? WHERE user_id=?',
              )
              .bind(verifier, now + 86400000, now, userId),
            assertSessionChange(db),
          );
        ops.push(
          db
            .prepare(
              'UPDATE local_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
            )
            .bind(now, userId),
        );
      }
      ops.push(
        receipt(db, row, key, fingerprint, userId, now, {
          response: temporary ? null : JSON.stringify({ userId, membershipId }),
          auditId: effectAuditId,
          grantId: grant.id,
        }),
        authAudit(
          db,
          row,
          'sensitive_action_grant.consumed',
          grant.id,
          now,
          key,
          effectMetadata,
          crypto.randomUUID(),
          'sensitive_action_grants',
        ),
        authAudit(db, row, action(command), userId, now, key, effectMetadata, effectAuditId),
      );
      try {
        await db.batch(ops);
      } catch {
        // All reconciliation still proves the committed exact effect and current authority;
        // neither a stale preflight nor an arbitrary receipt authorizes a response.
        const completed = await replayCompletedCommand(
          db,
          row,
          command,
          key,
          fingerprint,
          evidenceHash,
        );
        if (completed) return authResponse(c, completed);
        throw new AuthHttpError(
          409,
          'CONFLICT',
          'Yetki, sürüm veya son sahip koşulu değişti. İşlem uygulanmadı.',
        );
      }
      return authResponse(
        c,
        {
          userId,
          membershipId,
          ...(temporary
            ? { temporaryPassword: temporary, expiresAt: new Date(now + 86400000).toISOString() }
            : {}),
        },
        command.kind === 'create' ? 201 : 200,
      );
    } catch (error) {
      await auditAuthDenial(c, 'personnel.denied');
      return authErrorResponse(c, error);
    }
  });
}
