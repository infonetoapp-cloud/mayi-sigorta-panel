import { parseServerConfig } from '../config';
import type { AuthenticatedPrincipal } from './types';
import { SessionVerificationError } from './errors';

export const LOCAL_AUTH_ISSUER = 'urn:mayisigorta:local-auth:v1';
export const SESSION_COOKIE = '__Host-mayi-session';
export const NORMAL_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const NORMAL_IDLE_MS = 8 * 60 * 60 * 1000;
export const ACTIVATION_LIFETIME_MS = 15 * 60 * 1000;
export const RECENT_PASSWORD_MS = 5 * 60 * 1000;
export const IDLE_WRITE_INTERVAL_MS = 15 * 60 * 1000;

export interface LocalSessionConfig {
  readonly db: D1Database;
  readonly origin: string;
}
export class LocalSessionConfigError extends Error {}
export function parseLocalSessionConfig(env: Record<string, unknown>): LocalSessionConfig {
  if (!env.DB) throw new LocalSessionConfigError('CONFIGURATION_ERROR');
  return { db: env.DB as D1Database, origin: parseServerConfig(env).PANEL_ORIGIN };
}
export interface SessionRow {
  token_hash: string;
  user_id: string;
  identity_id: string;
  membership_id: string;
  credential_version: number;
  permission_version: number;
  kind: 'NORMAL' | 'ACTIVATION';
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  recent_password_at: number | null;
  revoked_at: number | null;
  subject: string;
  login_email: string;
  agency_id: string;
  must_change_password: number;
  temporary_expires_at: number | null;
}

export function randomSessionToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function hashSessionToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function sessionCookie(token: string, expiresAt: number): string {
  return `${SESSION_COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(expiresAt).toUTCString()}`;
}
export const EXPIRE_SESSION_COOKIE = `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
const requestSessions = new WeakMap<Request, SessionRow>();
export function getRequestSession(request: Request): SessionRow | undefined {
  return requestSessions.get(request);
}
export function csrfSessionSubject(request: Request, subject: string): string {
  const session = requestSessions.get(request);
  return session ? `${subject}:${session.token_hash}` : subject;
}

export async function loadLocalSession(
  db: D1Database,
  request: Request,
  allowActivation = false,
  now = Date.now(),
): Promise<SessionRow> {
  const cookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length !== 1) throw new SessionVerificationError('SESSION_MISSING');
  const token = cookies[0]!.slice(SESSION_COOKIE.length + 1);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new SessionVerificationError('SESSION_INVALID');
  const tokenHash = await hashSessionToken(token);
  const row = await db
    .prepare(
      `SELECT s.*, i.subject, c.login_email, m.agency_id, c.must_change_password, c.temporary_expires_at
    FROM local_sessions s JOIN local_credentials c ON c.user_id=s.user_id AND c.identity_id=s.identity_id
    JOIN auth_identities i ON i.id=s.identity_id AND i.user_id=s.user_id
    JOIN users u ON u.id=s.user_id JOIN agency_memberships m ON m.id=s.membership_id AND m.user_id=s.user_id
    JOIN agencies a ON a.id=m.agency_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.last_seen_at>?
    AND s.credential_version=c.credential_version AND s.permission_version=m.permission_version
    AND c.login_enabled=1 AND i.issuer=? AND i.email_provenance='OWNER_PROVISIONED'
    AND i.status='ACTIVE' AND u.status='ACTIVE' AND m.status='ACTIVE' AND a.status='ACTIVE'`,
    )
    .bind(tokenHash, now, now - NORMAL_IDLE_MS, LOCAL_AUTH_ISSUER)
    .first<SessionRow>();
  if (
    !row ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at > now ||
    row.expires_at > row.created_at + NORMAL_ABSOLUTE_MS ||
    row.last_seen_at > now ||
    (row.kind !== 'NORMAL' && row.kind !== 'ACTIVATION') ||
    (row.kind === 'NORMAL' && row.must_change_password !== 0) ||
    (row.kind === 'ACTIVATION' &&
      (!allowActivation ||
        row.must_change_password !== 1 ||
        row.temporary_expires_at === null ||
        row.temporary_expires_at <= now ||
        row.expires_at > row.created_at + ACTIVATION_LIFETIME_MS))
  ) {
    throw new SessionVerificationError('SESSION_EXPIRED');
  }
  if (now - row.last_seen_at >= IDLE_WRITE_INTERVAL_MS) {
    try {
      const result = await db
        .prepare(
          'UPDATE local_sessions SET last_seen_at=? WHERE token_hash=? AND revoked_at IS NULL AND last_seen_at=? AND expires_at>?',
        )
        .bind(now, tokenHash, row.last_seen_at, now)
        .run();
      if (result.success !== true) throw new Error('SESSION_ACTIVITY_UPDATE_FAILED');
    } catch {
      console.error('SESSION_ACTIVITY_UPDATE_FAILED');
      throw new SessionVerificationError('CONFIGURATION_ERROR');
    }
  }
  requestSessions.set(request, Object.freeze({ ...row }));
  return row;
}
export interface LocalSessionVerifier {
  readonly config: LocalSessionConfig;
  verify(
    request: Request,
    expectedAssurance?: 'NORMAL' | 'SECURE',
  ): Promise<AuthenticatedPrincipal>;
}
export function createLocalSessionVerifier({
  config,
}: {
  readonly config: LocalSessionConfig;
}): LocalSessionVerifier {
  return {
    config,
    async verify(request, expectedAssurance) {
      if (new URL(request.url).origin !== config.origin)
        throw new SessionVerificationError('SESSION_INVALID');
      const row = await loadLocalSession(config.db, request);
      const recent =
        row.recent_password_at !== null &&
        row.recent_password_at <= Date.now() &&
        Date.now() - row.recent_password_at < RECENT_PASSWORD_MS;
      if (
        (expectedAssurance === 'SECURE' || new URL(request.url).pathname.startsWith('/secure')) &&
        !recent
      )
        throw new SessionVerificationError('REAUTH_REQUIRED');
      return Object.freeze({
        issuer: LOCAL_AUTH_ISSUER,
        subject: row.subject,
        email: row.login_email,
        assurance: recent ? 'SECURE' : 'NORMAL',
        expiresAt: Math.floor(row.expires_at / 1000),
        sessionHash: row.token_hash,
      });
    },
  };
}

export function assertSessionChange(db: D1Database, expected = 1): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) VALUES (?,?,changes(),'AUTH_STATE_CHANGED')",
    )
    .bind(crypto.randomUUID(), expected);
}
/** Repeat all session authority predicates in the same batch as credential mutation. */
export function liveSessionAssertion(
  db: D1Database,
  row: SessionRow,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,count(*),'AUTH_STATE_CHANGED' FROM local_sessions s
    JOIN local_credentials c ON c.user_id=s.user_id AND c.identity_id=s.identity_id
    JOIN auth_identities i ON i.id=s.identity_id AND i.user_id=s.user_id
    JOIN users u ON u.id=s.user_id JOIN agency_memberships m ON m.id=s.membership_id AND m.user_id=s.user_id
    JOIN agencies a ON a.id=m.agency_id
    WHERE s.token_hash=? AND s.kind=? AND s.revoked_at IS NULL AND s.created_at<=? AND s.expires_at>?
    AND s.last_seen_at>? AND s.last_seen_at<=? AND s.credential_version=? AND s.credential_version=c.credential_version
    AND s.permission_version=? AND s.permission_version=m.permission_version
    AND c.login_enabled=1 AND i.status='ACTIVE' AND i.issuer=? AND i.email_provenance='OWNER_PROVISIONED'
    AND u.status='ACTIVE' AND m.status='ACTIVE' AND a.status='ACTIVE' AND m.id=? AND a.id=?
    AND ((s.kind='NORMAL' AND c.must_change_password=0 AND s.expires_at<=s.created_at+43200000)
      OR (s.kind='ACTIVATION' AND c.must_change_password=1 AND c.temporary_expires_at>? AND s.expires_at<=c.temporary_expires_at AND s.expires_at<=s.created_at+900000))`,
    )
    .bind(
      crypto.randomUUID(),
      row.token_hash,
      row.kind,
      now,
      now,
      now - NORMAL_IDLE_MS,
      now,
      row.credential_version,
      row.permission_version,
      LOCAL_AUTH_ISSUER,
      row.membership_id,
      row.agency_id,
      now,
    );
}
export function sessionInsert(
  db: D1Database,
  hash: string,
  row: Pick<
    SessionRow,
    'user_id' | 'identity_id' | 'membership_id' | 'credential_version' | 'permission_version'
  >,
  kind: 'NORMAL' | 'ACTIVATION',
  now: number,
  expiresAt: number,
  recentAt: number | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO local_sessions(token_hash,user_id,identity_id,membership_id,credential_version,permission_version,kind,created_at,expires_at,last_seen_at,recent_password_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      hash,
      row.user_id,
      row.identity_id,
      row.membership_id,
      row.credential_version,
      row.permission_version,
      kind,
      now,
      expiresAt,
      now,
      recentAt,
    );
}
