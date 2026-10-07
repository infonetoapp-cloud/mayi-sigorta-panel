import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LOCAL_AUTH_ISSUER,
  NORMAL_ABSOLUTE_MS,
  randomSessionToken,
  hashSessionToken,
  sessionInsert,
  createLocalSessionVerifier,
  type LocalSessionConfig,
  type LocalSessionVerifier,
} from '../../src/server/auth/session';
import { generateIdentityBoundCsrfToken } from '../../src/server/security/csrf';

const fixtureSessions = new WeakMap<D1Database, Map<string, { cookie: string; hash: string }>>();
/** Domain tests seed principals explicitly, then exercise real local session middleware/storage. */
export async function mintFixtureSession(
  db: D1Database,
  subject: string,
  _email?: string,
  secure = false,
): Promise<string> {
  if (
    !(await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_sessions'")
      .first())
  ) {
    for (const sql of readFileSync(resolve('db/migrations/0020_local_authentication.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  }
  // Trusted fixture provisioning follows the production ordering: local OWNER
  // credentials must exist before the first MEMBER credential in an ACTIVE agency.
  const owners = await db
    .prepare(
      "SELECT DISTINCT i.id,i.user_id,i.verified_email,i.email_provenance FROM auth_identities i JOIN users u ON u.id=i.user_id JOIN agency_memberships m ON m.user_id=u.id JOIN agencies a ON a.id=m.agency_id WHERE i.issuer=? AND i.status='ACTIVE' AND u.status='ACTIVE' AND m.type='OWNER' AND m.status='ACTIVE' AND a.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM local_credentials c WHERE c.user_id=u.id)",
    )
    .bind(LOCAL_AUTH_ISSUER)
    .all<{ id: string; user_id: string; verified_email: string; email_provenance: string }>();
  for (const owner of owners.results) {
    if (owner.email_provenance !== 'OWNER_PROVISIONED')
      await db
        .prepare(
          "UPDATE auth_identities SET email_provenance='OWNER_PROVISIONED',version=version+1 WHERE id=?",
        )
        .bind(owner.id)
        .run();
    await db
      .prepare(
        'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,updated_at) VALUES(?,?,?,?,0,NULL,?)',
      )
      .bind(
        owner.user_id,
        owner.id,
        owner.verified_email.trim().toLowerCase(),
        'controlled-fixture-verifier-not-production',
        Date.now(),
      )
      .run();
  }
  const identity = await db
    .prepare(
      'SELECT id,user_id,verified_email,status,email_provenance FROM auth_identities WHERE issuer=? AND subject=?',
    )
    .bind(LOCAL_AUTH_ISSUER, subject)
    .first<{
      id: string;
      user_id: string;
      verified_email: string;
      status: string;
      email_provenance: string;
    }>();
  const token = randomSessionToken(),
    hash = await hashSessionToken(token),
    cookie = `__Host-mayi-session=${token}`;
  if (!identity || identity.status !== 'ACTIVE') return cookie;
  if (identity.email_provenance !== 'OWNER_PROVISIONED')
    await db
      .prepare(
        "UPDATE auth_identities SET email_provenance='OWNER_PROVISIONED',version=version+1 WHERE id=?",
      )
      .bind(identity.id)
      .run();
  const existing = await db
    .prepare('SELECT credential_version FROM local_credentials WHERE user_id=?')
    .bind(identity.user_id)
    .first<{ credential_version: number }>();
  if (!existing)
    await db
      .prepare(
        'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,updated_at) VALUES(?,?,?,?,0,NULL,?)',
      )
      .bind(
        identity.user_id,
        identity.id,
        identity.verified_email.trim().toLowerCase(),
        'controlled-fixture-verifier-not-production',
        Date.now(),
      )
      .run();
  const membership = await db
    .prepare(
      "SELECT m.id,m.permission_version FROM agency_memberships m JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id WHERE m.user_id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' LIMIT 2",
    )
    .bind(identity.user_id)
    .all<{ id: string; permission_version: number }>();
  if (membership.results.length !== 1) return cookie;
  const now = Date.now();
  await sessionInsert(
    db,
    hash,
    {
      user_id: identity.user_id,
      identity_id: identity.id,
      membership_id: membership.results[0]!.id,
      credential_version: existing?.credential_version ?? 1,
      permission_version: membership.results[0]!.permission_version,
    },
    'NORMAL',
    now,
    now + NORMAL_ABSOLUTE_MS,
    secure ? now : null,
  ).run();
  let map = fixtureSessions.get(db);
  if (!map) {
    map = new Map();
    fixtureSessions.set(db, map);
  }
  map.set(subject, { cookie, hash });
  return cookie;
}
export async function fixtureCsrf(
  db: D1Database,
  subject: string,
  secret: string,
): Promise<string> {
  const session = fixtureSessions.get(db)?.get(subject);
  if (!session) throw new Error('Controlled local session was not minted');
  return generateIdentityBoundCsrfToken({ subject: `${subject}:${session.hash}` }, secret);
}
export function fixtureVerifier(config: LocalSessionConfig): LocalSessionVerifier {
  return createLocalSessionVerifier({ config });
}
