import { LOCAL_AUTH_ISSUER, RECENT_PASSWORD_MS, type SessionRow } from './session';

// Server composition owns this monotonic policy; session assurance is evidence, not policy.
const policies = new WeakMap<object, { recentPasswordRequired: boolean }>();
export function requireRecentPassword(db: D1Database): void {
  const policy = policies.get(db);
  if (policy) policy.recentPasswordRequired = true;
}
export function inheritSessionPolicy(source: object, target: D1Database): D1Database {
  const policy = policies.get(source);
  if (policy) policies.set(target, policy);
  return target;
}

/** A per-request D1 capability; never mutate/share the original Env across requests. */
export function sessionBoundDatabase(
  db: D1Database,
  row: SessionRow,
  secureRoute = false,
): D1Database {
  const prepare = db.prepare.bind(db),
    batch = db.batch.bind(db);
  const policy = { recentPasswordRequired: secureRoute };
  const snapshot = Object.freeze({ ...row });
  const scoped = {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const now = Date.now();
      const assertion =
        prepare(`INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,count(*),'LOCAL_SESSION_REVOKED'
        FROM local_sessions s JOIN local_credentials c ON c.user_id=s.user_id AND c.identity_id=s.identity_id
        JOIN auth_identities i ON i.id=s.identity_id AND i.user_id=s.user_id JOIN users u ON u.id=s.user_id
        JOIN agency_memberships m ON m.id=s.membership_id AND m.user_id=s.user_id JOIN agencies a ON a.id=m.agency_id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.kind='NORMAL' AND s.expires_at>? AND s.last_seen_at>?
        AND s.credential_version=c.credential_version AND c.credential_version=? AND c.login_enabled=1 AND c.must_change_password=0
        AND s.permission_version=m.permission_version AND m.permission_version=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND i.status='ACTIVE' AND i.issuer=? AND a.status='ACTIVE' AND m.id=? AND a.id=?
        AND (?=0 OR (s.recent_password_at<=? AND s.recent_password_at>?
          AND s.recent_password_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
          AND s.recent_password_at>CAST(unixepoch('subsec')*1000 AS INTEGER)-300000))`).bind(
          crypto.randomUUID(),
          snapshot.token_hash,
          now,
          now - 28800000,
          snapshot.credential_version,
          snapshot.permission_version,
          LOCAL_AUTH_ISSUER,
          snapshot.membership_id,
          snapshot.agency_id,
          policy.recentPasswordRequired ? 1 : 0,
          now,
          now - RECENT_PASSWORD_MS,
        );
      // Preserve the exact original result-array indexes expected by accepted domain executors.
      const results = await batch<T>([assertion, ...statements]);
      return results.slice(1);
    },
  } as D1Database;
  policies.set(scoped, policy);
  return scoped;
}
