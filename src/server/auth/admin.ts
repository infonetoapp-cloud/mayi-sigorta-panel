import { z } from 'zod';
import {
  generateTemporaryPassword,
  normalizeLoginEmail,
  productionPasswordHasher,
  type PasswordHasher,
} from './password';
import { LOCAL_AUTH_ISSUER, assertSessionChange } from './session';

export const adminTargetSchema = z
  .object({
    mode: z.enum(['bootstrap', 'break-glass']),
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    databaseId: z.string().uuid(),
    agencyId: z.string().min(1).max(100),
    ownerUserId: z.string().min(1).max(100),
    email: z.string().max(320),
    name: z.string().trim().min(2).max(120),
    operationKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();
export type AdminTarget = z.infer<typeof adminTargetSchema>;
export function assertLocalAdminBinding(config: unknown, input: AdminTarget): void {
  const target = adminTargetSchema.parse(input);
  const parsed = z
    .object({
      account_id: z.string(),
      d1_databases: z.array(
        z.object({ binding: z.string(), database_id: z.string(), remote: z.boolean().optional() }),
      ),
    })
    .safeParse(config);
  if (!parsed.success || parsed.data.account_id !== target.accountId)
    throw new Error('EXACT_LOCAL_ACCOUNT_REQUIRED');
  const db = parsed.data.d1_databases.filter((b) => b.binding === 'DB');
  if (db.length !== 1 || db[0]!.database_id !== target.databaseId || db[0]!.remote === true)
    throw new Error('EXACT_LOCAL_D1_REQUIRED');
}
/** No HTTP caller/import. This is a controlled administrative composition, not user authorization. */
export async function administerLocalOwner(
  db: D1Database,
  input: AdminTarget,
  hasher: PasswordHasher = productionPasswordHasher,
): Promise<{ temporaryPassword: string; expiresAt: string }> {
  const target = adminTargetSchema.parse(input);
  const email = normalizeLoginEmail(target.email);
  const agency = await db
    .prepare('SELECT id,status,version FROM agencies WHERE id=?')
    .bind(target.agencyId)
    .first<{ id: string; status: string; version: number }>();
  if (!agency) throw new Error('EXACT_AGENCY_REQUIRED');
  const counts = await db
    .prepare(
      "SELECT count(*) membership_count,sum(CASE WHEN m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE' THEN 1 ELSE 0 END) active_owner_count FROM agency_memberships m JOIN users u ON u.id=m.user_id WHERE m.agency_id=?",
    )
    .bind(target.agencyId)
    .first<{ membership_count: number; active_owner_count: number }>();
  const owner = await db
    .prepare(
      "SELECT m.id,m.user_id,m.type,m.status,m.version,m.permission_version,u.status user_status FROM agency_memberships m JOIN users u ON u.id=m.user_id WHERE m.agency_id=? AND m.user_id=? AND m.type='OWNER'",
    )
    .bind(target.agencyId, target.ownerUserId)
    .first<{
      id: string;
      user_id: string;
      type: string;
      status: string;
      version: number;
      permission_version: number;
      user_status: string;
    }>();

  const user = await db.prepare('SELECT id FROM users WHERE id=?').bind(target.ownerUserId).first();
  const credential = await db
    .prepare('SELECT login_email,credential_version FROM local_credentials WHERE user_id=?')
    .bind(target.ownerUserId)
    .first<{ login_email: string; credential_version: number }>();
  const auditKey = `${target.mode}:${target.operationKey}`;
  if (
    await db
      .prepare(
        "SELECT id FROM system_audit_events WHERE agency_id=? AND system_actor_code='LOCAL_AUTH_OPERATOR' AND idempotency_key=?",
      )
      .bind(target.agencyId, auditKey)
      .first()
  )
    throw new Error('ONE_TIME_RESPONSE_UNAVAILABLE');
  const initial =
    target.mode === 'bootstrap' &&
    agency.status === 'PROVISIONING' &&
    counts?.membership_count === 0 &&
    !user;
  const existing =
    target.mode === 'bootstrap' &&
    agency.status === 'ACTIVE' &&
    owner?.status === 'ACTIVE' &&
    owner.user_status === 'ACTIVE' &&
    counts?.active_owner_count === 1 &&
    !credential;
  if (target.mode === 'bootstrap' && !initial && !existing)
    throw new Error('BOOTSTRAP_SETUP_ALREADY_EXISTS_OR_AMBIGUOUS');
  if (
    target.mode === 'break-glass' &&
    (!owner || !user || !credential || credential.login_email !== email)
  )
    throw new Error('EXACT_EXISTING_OWNER_REQUIRED');
  if (existing) {
    const emails = await db
      .prepare("SELECT verified_email FROM auth_identities WHERE user_id=? AND status='ACTIVE'")
      .bind(target.ownerUserId)
      .all<{ verified_email: string }>();
    if (
      !emails.results.length ||
      emails.results.some((r) => normalizeLoginEmail(r.verified_email) !== email)
    )
      throw new Error('EXACT_OWNER_EMAIL_REQUIRED');
  }
  const now = Date.now(),
    iso = new Date(now).toISOString();
  const temporaryPassword = generateTemporaryPassword();
  const verifier = await hasher.hash(temporaryPassword);
  const identityId = crypto.randomUUID(),
    membershipId = owner?.id ?? crypto.randomUUID();
  const ops: D1PreparedStatement[] = [];
  ops.push(
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,count(*),'ADMIN_STATE_CHANGED' FROM agencies a WHERE a.id=? AND a.version=? AND a.status=?`,
      )
      .bind(crypto.randomUUID(), target.agencyId, agency.version, agency.status),
  );
  if (initial) {
    ops.push(
      db
        .prepare(
          "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,0,count(*),'ADMIN_OWNER_SETUP_CHANGED' FROM agency_memberships WHERE agency_id=?",
        )
        .bind(crypto.randomUUID(), target.agencyId),
      db
        .prepare("INSERT INTO users(id,status,display_name) VALUES(?,'ACTIVE',?)")
        .bind(target.ownerUserId, target.name),
    );
  } else {
    ops.push(
      db
        .prepare(
          "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,count(*),'ADMIN_OWNER_CHANGED' FROM agency_memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.user_id=? AND m.agency_id=? AND m.type='OWNER' AND m.version=? AND m.status=? AND m.permission_version=? AND u.status=?",
        )
        .bind(
          crypto.randomUUID(),
          membershipId,
          target.ownerUserId,
          target.agencyId,
          owner!.version,
          owner!.status,
          owner!.permission_version,
          owner!.user_status,
        ),
    );
  }
  if (existing) {
    ops.push(
      db
        .prepare(
          "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,count(*),'ADMIN_OWNER_SETUP_CHANGED' FROM agency_memberships m JOIN users u ON u.id=m.user_id WHERE m.agency_id=? AND m.type='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE'",
        )
        .bind(crypto.randomUUID(), target.agencyId),
      db
        .prepare(
          "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,count(*),'ADMIN_EMAIL_CHANGED' FROM auth_identities WHERE user_id=? AND status='ACTIVE' AND lower(trim(verified_email))=?",
        )
        .bind(crypto.randomUUID(), target.ownerUserId, email),
      db
        .prepare(
          "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,0,count(*),'ADMIN_EMAIL_CHANGED' FROM auth_identities WHERE user_id=? AND status='ACTIVE' AND lower(trim(verified_email))<>?",
        )
        .bind(crypto.randomUUID(), target.ownerUserId, email),
    );
  }
  if (target.mode === 'bootstrap') {
    ops.push(
      db
        .prepare(
          "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance) VALUES(?,?,?,?,?,'OWNER_PROVISIONED')",
        )
        .bind(identityId, target.ownerUserId, LOCAL_AUTH_ISSUER, crypto.randomUUID(), email),
    );
    if (initial) {
      ops.push(
        db
          .prepare(
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES(?,?,?,'OWNER','INVITED',?,?)",
          )
          .bind(
            membershipId,
            target.agencyId,
            target.ownerUserId,
            email,
            new Date(now + 86400000).toISOString(),
          ),
        db
          .prepare(
            "UPDATE agency_memberships SET status='ACTIVE',activated_at=?,version=version+1,permission_version=permission_version+1 WHERE id=? AND status='INVITED'",
          )
          .bind(iso, membershipId),
        assertSessionChange(db),
        db
          .prepare(
            "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at=?,activated_at=?,version=version+1 WHERE id=? AND version=? AND status='PROVISIONING'",
          )
          .bind(iso, iso, target.agencyId, agency.version),
        assertSessionChange(db),
      );
    }
    ops.push(
      db
        .prepare(
          'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,updated_at) VALUES(?,?,?,?,1,?,?)',
        )
        .bind(target.ownerUserId, identityId, email, verifier, now + 86400000, now),
    );
  } else {
    ops.push(
      db
        .prepare(
          'UPDATE local_credentials SET verifier=?,credential_version=credential_version+1,must_change_password=1,temporary_expires_at=?,login_enabled=1,updated_at=? WHERE user_id=? AND credential_version=? AND login_email=?',
        )
        .bind(
          verifier,
          now + 86400000,
          now,
          target.ownerUserId,
          credential!.credential_version,
          email,
        ),
      assertSessionChange(db),
    );
  }
  ops.push(
    db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .bind(now, target.ownerUserId),
    db
      .prepare(
        "INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json,created_at) VALUES(?,?,'LOCAL_AUTH_OPERATOR',?,'users',?,?,?,'SUCCESS','OPERATOR_CONFIRMED','{}',?)",
      )
      .bind(
        crypto.randomUUID(),
        target.agencyId,
        `auth.admin.${target.mode}`,
        target.ownerUserId,
        crypto.randomUUID(),
        auditKey,
        iso,
      ),
  );
  await db.batch(ops);
  return { temporaryPassword, expiresAt: new Date(now + 86400000).toISOString() };
}
