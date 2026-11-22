import type { Hono, Context } from 'hono';
import { z } from 'zod';
import type { Env, AppDependencies } from '../index';
import { serializeAuthAuditMetadata, type PersonnelAuditMetadata } from './audit-metadata';
import { parseCsrfConfig } from '../config';
import { generateIdentityBoundCsrfToken, verifyCsrfMutationGuard } from '../security/csrf';
import {
  normalizeLoginEmail,
  normalizePassword,
  isSupportedPasswordVerifier,
  validatePermanentPassword,
} from './password';
import { createDurableObjectPasswordHasher } from './password-do-adapter';
import { DUMMY_PASSWORD_VERIFIER } from './password-envelope';
import { PasswordKdfUnavailableError } from './password-kdf-error';
import { loginTurnstileConfig, verifyLoginTurnstile } from './turnstile';
import {
  ACTIVATION_LIFETIME_MS,
  NORMAL_ABSOLUTE_MS,
  LOCAL_AUTH_ISSUER,
  EXPIRE_SESSION_COOKIE,
  assertSessionChange,
  liveSessionAssertion,
  csrfSessionSubject,
  hashSessionToken,
  loadLocalSession,
  randomSessionToken,
  sessionCookie,
  sessionInsert,
  type SessionRow,
  getRequestSession,
} from './session';

export class AuthHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409 | 413 | 415 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function readBoundedJson(
  request: Pick<Request, 'headers' | 'body'>,
  maxBytes = 8192,
): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new AuthHttpError(415, 'JSON_REQUIRED', 'JSON gövdesi gerekli.');
  const reader = request.body?.getReader();
  if (!reader) throw new AuthHttpError(400, 'INVALID_INPUT', 'Girdi geçersiz.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel();
        throw new AuthHttpError(413, 'INPUT_TOO_LARGE', 'Girdi çok büyük.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AuthHttpError(400, 'INVALID_INPUT', 'Girdi geçersiz.');
  }
}
export function authResponse(
  c: Context<{ Bindings: Env }>,
  data: unknown,
  status: 200 | 201 = 200,
): Response {
  return c.json({ success: true, data, timestamp: new Date().toISOString() }, status);
}
export function authErrorResponse(c: Context<{ Bindings: Env }>, error: unknown): Response {
  if (error instanceof PasswordKdfUnavailableError)
    return c.json(
      {
        success: false,
        error: { code: 'PASSWORD_KDF_UNAVAILABLE', message: 'Şifre hizmeti kullanılamıyor.' },
        timestamp: new Date().toISOString(),
      },
      503,
    );
  if (error instanceof AuthHttpError)
    return c.json(
      {
        success: false,
        error: { code: error.code, message: error.message },
        timestamp: new Date().toISOString(),
      },
      error.status,
    );
  return c.json(
    {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Oturum geçersiz veya işlem kullanılamıyor.' },
      timestamp: new Date().toISOString(),
    },
    401,
  );
}
export async function limitPasswordAttempt(
  env: Env,
  request: Request,
  account: string,
): Promise<void> {
  if (!env.AUTH_ACCOUNT_RATE_LIMITER || !env.AUTH_SOURCE_RATE_LIMITER)
    throw new AuthHttpError(503, 'AUTH_PROTECTION_UNAVAILABLE', 'Giriş koruması kullanılamıyor.');
  const source = request.headers.get('cf-connecting-ip') ?? 'local-source';
  if (env.APP_ENV === 'production' && !request.headers.get('cf-connecting-ip'))
    throw new AuthHttpError(503, 'AUTH_PROTECTION_UNAVAILABLE', 'Giriş koruması kullanılamıyor.');
  const [accountKey, sourceKey] = await Promise.all([
    hashSessionToken(account),
    hashSessionToken(source),
  ]);
  let allowed: boolean;
  try {
    const [accountLimit, sourceLimit] = await Promise.all([
      env.AUTH_ACCOUNT_RATE_LIMITER.limit({ key: accountKey }),
      env.AUTH_SOURCE_RATE_LIMITER.limit({ key: sourceKey }),
    ]);
    if (typeof accountLimit?.success !== 'boolean' || typeof sourceLimit?.success !== 'boolean')
      throw new Error('INVALID_AUTH_LIMITER_RESULT');
    allowed = accountLimit.success && sourceLimit.success;
  } catch {
    throw new AuthHttpError(503, 'AUTH_PROTECTION_UNAVAILABLE', 'Giriş koruması kullanılamıyor.');
  }
  if (!allowed)
    throw new AuthHttpError(
      429,
      'RATE_LIMITED',
      'Çok fazla deneme. Bir dakika sonra tekrar deneyin.',
    );
}
export function authAudit(
  db: D1Database,
  row: Pick<SessionRow, 'user_id' | 'membership_id' | 'agency_id'> &
    Partial<Pick<SessionRow, 'permission_version' | 'credential_version'>>,
  action: string,
  target: string,
  now = Date.now(),
  operationKey: string | null = null,
  metadata?: PersonnelAuditMetadata,
  eventId = crypto.randomUUID(),
  targetType = 'users',
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,idempotency_key,outcome,metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'SUCCESS',?,?)`,
    )
    .bind(
      eventId,
      row.agency_id,
      row.user_id,
      row.membership_id,
      action,
      targetType,
      target,
      crypto.randomUUID(),
      operationKey,
      serializeAuthAuditMetadata(metadata, {
        action,
        permissionVersion: row.permission_version,
        credentialVersion: row.credential_version,
      }),
      new Date(now).toISOString(),
    );
}
export async function auditAuthDenial(
  c: Context<{ Bindings: Env }>,
  action: 'personnel.denied' | 'auth.reauth.denied' | 'auth.secure.denied',
): Promise<void> {
  const row = getRequestSession(c.req.raw);
  if (!row) return;
  try {
    await c.env.DB.prepare(
      "INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,'users',?,?,'FAILURE',?,?)",
    )
      .bind(
        crypto.randomUUID(),
        row.agency_id,
        row.user_id,
        row.membership_id,
        action,
        row.user_id,
        crypto.randomUUID(),
        JSON.stringify({
          actorKind: 'USER',
          reasonCode: 'AUTHORIZATION_DENIED',
          actorPermissionVersion: row.permission_version,
        }),
        new Date().toISOString(),
      )
      .run();
  } catch {
    console.error('AUTH_DENIAL_AUDIT_UNAVAILABLE');
  }
}
export async function requireAuthCsrf(
  c: Context<{ Bindings: Env }>,
  row: SessionRow,
): Promise<void> {
  const result = await verifyCsrfMutationGuard(c.req.raw, {
    authenticatedSubject: row.subject,
    secret: parseCsrfConfig(c.env).CSRF_SECRET,
  });
  if (!result.allowed) throw new AuthHttpError(403, result.code, 'Güvenlik doğrulaması başarısız.');
}
const loginSchema = z
  .object({
    email: z.string().max(320),
    password: z.string().max(256),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();
const changeSchema = z
  .object({
    newPassword: z.string().max(256),
    confirmation: z.string().max(256),
    currentPassword: z.string().max(256).optional(),
  })
  .strict();
const reauthSchema = z.object({ password: z.string().max(256) }).strict();
const DUMMY_VERIFIER = DUMMY_PASSWORD_VERIFIER;
interface LoginRow extends SessionRow {
  verifier: string;
  login_enabled: number;
  type: string;
  identity_status: string;
  user_status: string;
  membership_status: string;
  agency_status: string;
}

export function registerLocalAuthRoutes(
  app: Hono<{ Bindings: Env }>,
  dependencies: AppDependencies,
): void {
  app.post('/api/auth/login', async (c) => {
    try {
      const parsed = loginSchema.safeParse(await readBoundedJson(c.req.raw));
      if (!parsed.success) throw new AuthHttpError(400, 'INVALID_INPUT', 'Girdi geçersiz.');
      let email: string;
      let password: string;
      try {
        email = normalizeLoginEmail(parsed.data.email);
        password = normalizePassword(parsed.data.password);
      } catch {
        throw new AuthHttpError(401, 'LOGIN_FAILED', 'E-posta veya şifre hatalı.');
      }
      await limitPasswordAttempt(c.env, c.req.raw, email);
      let humanVerified = true;
      try {
        const challenge = loginTurnstileConfig(c.env);
        if (challenge) {
          const token = parsed.data.turnstileToken;
          humanVerified = !!token && (await verifyLoginTurnstile(challenge, token));
        }
      } catch {
        throw new AuthHttpError(503, 'TURNSTILE_UNAVAILABLE', 'Robot doğrulaması kullanılamıyor.');
      }
      if (!humanVerified)
        throw new AuthHttpError(403, 'TURNSTILE_REQUIRED', 'Robot doğrulamasını tamamlayın.');
      const hasher =
        dependencies.passwordHasher ?? createDurableObjectPasswordHasher(c.env.PASSWORD_KDF);
      const rows = await c.env.DB.prepare(
        `SELECT c.*, i.subject, i.status identity_status, u.status user_status, m.id membership_id,m.permission_version,m.agency_id,m.type,m.status membership_status,a.status agency_status
        FROM local_credentials c JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=c.user_id
        JOIN users u ON u.id=c.user_id JOIN agency_memberships m ON m.user_id=c.user_id JOIN agencies a ON a.id=m.agency_id
        WHERE c.login_email=? AND i.issuer=? AND i.email_provenance='OWNER_PROVISIONED'
        AND m.status='ACTIVE' AND a.status='ACTIVE' LIMIT 2`,
      )
        .bind(email, LOCAL_AUTH_ISSUER)
        .all<LoginRow>();
      const row = rows.results.length === 1 ? rows.results[0] : undefined;
      const now = Date.now();
      const usable =
        !!row &&
        row.login_enabled === 1 &&
        row.identity_status === 'ACTIVE' &&
        row.user_status === 'ACTIVE' &&
        row.membership_status === 'ACTIVE' &&
        row.agency_status === 'ACTIVE' &&
        (row.must_change_password === 0 ||
          (row.must_change_password === 1 &&
            row.temporary_expires_at !== null &&
            row.temporary_expires_at > now)) &&
        (hasher.supports?.(row.verifier) ?? isSupportedPasswordVerifier(row.verifier));
      const verification = await hasher.verify(password, usable ? row!.verifier : DUMMY_VERIFIER);
      if (!usable || !verification.matches)
        throw new AuthHttpError(401, 'LOGIN_FAILED', 'E-posta veya şifre hatalı.');
      // Future supported work-factor upgrades replace the verifier atomically before session creation.
      if (verification.needsRehash) {
        const replacement = await hasher.hash(password);
        await c.env.DB.batch([
          c.env.DB.prepare(
            'UPDATE local_credentials SET verifier=?,updated_at=? WHERE user_id=? AND credential_version=? AND verifier=?',
          ).bind(replacement, now, row!.user_id, row!.credential_version, row!.verifier),
          assertSessionChange(c.env.DB),
        ]);
      }
      const sessionNow = Date.now();
      const kind = row!.must_change_password === 1 ? 'ACTIVATION' : 'NORMAL';
      const expiresAt =
        kind === 'ACTIVATION'
          ? Math.min(sessionNow + ACTIVATION_LIFETIME_MS, row!.temporary_expires_at!)
          : sessionNow + NORMAL_ABSOLUTE_MS;
      const token = randomSessionToken();
      const hash = await hashSessionToken(token);
      try {
        await c.env.DB.batch([
          sessionInsert(c.env.DB, hash, row!, kind, sessionNow, expiresAt),
          authAudit(c.env.DB, row!, 'auth.login', row!.user_id, now),
        ]);
      } catch {
        throw new AuthHttpError(401, 'LOGIN_FAILED', 'E-posta veya şifre hatalı.');
      }
      c.header('Set-Cookie', sessionCookie(token, expiresAt));
      return authResponse(c, { state: kind });
    } catch (error) {
      if (error instanceof AuthHttpError && error.status === 429) c.header('Retry-After', '60');
      return authErrorResponse(c, error);
    }
  });
  app.get('/api/auth/session', async (c) => {
    // The site key is public. Existing sessions remain usable if login protection is unavailable.
    try {
      const challenge = loginTurnstileConfig(c.env);
      if (challenge) c.header('X-Turnstile-Site-Key', challenge.siteKey);
    } catch {
      // Login itself rejects incomplete configuration before looking up any credential.
    }
    try {
      const row = await loadLocalSession(c.env.DB, c.req.raw, true);
      const member = await c.env.DB.prepare('SELECT type FROM agency_memberships WHERE id=?')
        .bind(row.membership_id)
        .first<{ type: string }>();
      return authResponse(c, {
        state: row.kind,
        email: row.login_email,
        isOwner: row.kind === 'NORMAL' && member?.type === 'OWNER',
      });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });
  app.get('/api/auth/csrf-token', async (c) => {
    try {
      const row = await loadLocalSession(c.env.DB, c.req.raw, true);
      const token = await generateIdentityBoundCsrfToken(
        { subject: csrfSessionSubject(c.req.raw, row.subject) },
        parseCsrfConfig(c.env).CSRF_SECRET,
      );
      return authResponse(c, { token });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });
  app.post('/api/auth/logout', async (c) => {
    try {
      const row = await loadLocalSession(c.env.DB, c.req.raw, true);
      await requireAuthCsrf(c, row);
      await c.env.DB.batch([
        c.env.DB.prepare(
          'UPDATE local_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL',
        ).bind(Date.now(), row.token_hash),
        assertSessionChange(c.env.DB),
        authAudit(c.env.DB, row, 'auth.logout', row.user_id),
      ]);
      c.header('Set-Cookie', EXPIRE_SESSION_COOKIE);
      return authResponse(c, { loggedOut: true });
    } catch (error) {
      return authErrorResponse(c, error);
    }
  });
  app.post('/api/auth/password', async (c) => {
    try {
      const row = await loadLocalSession(c.env.DB, c.req.raw, true);
      await requireAuthCsrf(c, row);
      const parsed = changeSchema.safeParse(await readBoundedJson(c.req.raw));
      if (!parsed.success) throw new AuthHttpError(400, 'INVALID_INPUT', 'Girdi geçersiz.');
      if (parsed.data.newPassword !== parsed.data.confirmation)
        throw new AuthHttpError(400, 'PASSWORD_CONFIRMATION', 'Yeni şifreler eşleşmiyor.');
      let password: string;
      try {
        password = validatePermanentPassword(parsed.data.newPassword, row.login_email);
      } catch {
        throw new AuthHttpError(
          400,
          'PASSWORD_POLICY',
          'Parola 15–128 karakter olmalı ve kolay tahmin edilmemelidir.',
        );
      }
      await limitPasswordAttempt(c.env, c.req.raw, row.login_email);
      const credential = await c.env.DB.prepare(
        'SELECT verifier FROM local_credentials WHERE user_id=? AND credential_version=?',
      )
        .bind(row.user_id, row.credential_version)
        .first<{ verifier: string }>();
      if (!credential) throw new AuthHttpError(401, 'UNAUTHORIZED', 'Oturum geçersiz.');
      const hasher =
        dependencies.passwordHasher ?? createDurableObjectPasswordHasher(c.env.PASSWORD_KDF);
      if (
        row.kind === 'NORMAL' &&
        (!parsed.data.currentPassword ||
          !(await hasher.verify(parsed.data.currentPassword, credential.verifier)).matches)
      )
        throw new AuthHttpError(403, 'CURRENT_PASSWORD_FAILED', 'Mevcut şifre hatalı.');
      if ((await hasher.verify(password, credential.verifier)).matches)
        throw new AuthHttpError(400, 'PASSWORD_UNCHANGED', 'Farklı bir yeni şifre seçin.');
      const verifier = await hasher.hash(password);
      const now = Date.now();
      const token = randomSessionToken();
      const hash = await hashSessionToken(token);
      const expiresAt = now + NORMAL_ABSOLUTE_MS;
      await c.env.DB.batch([
        liveSessionAssertion(c.env.DB, row, now),
        c.env.DB.prepare(
          `UPDATE local_credentials SET verifier=?,must_change_password=0,temporary_expires_at=NULL,credential_version=credential_version+1,updated_at=?
          WHERE user_id=? AND credential_version=? AND EXISTS(SELECT 1 FROM local_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND permission_version=(SELECT permission_version FROM agency_memberships WHERE id=?))`,
        ).bind(
          verifier,
          now,
          row.user_id,
          row.credential_version,
          row.token_hash,
          now,
          row.membership_id,
        ),
        assertSessionChange(c.env.DB),
        c.env.DB.prepare(
          'UPDATE local_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
        ).bind(now, row.user_id),
        sessionInsert(
          c.env.DB,
          hash,
          { ...row, credential_version: row.credential_version + 1 },
          'NORMAL',
          now,
          expiresAt,
        ),
        authAudit(
          c.env.DB,
          row,
          row.kind === 'ACTIVATION' ? 'auth.password.activated' : 'auth.password.changed',
          row.user_id,
          now,
        ),
      ]);
      c.header('Set-Cookie', sessionCookie(token, expiresAt));
      return authResponse(c, { state: 'NORMAL' });
    } catch (error) {
      if (error instanceof AuthHttpError && error.status === 429) c.header('Retry-After', '60');
      return authErrorResponse(c, error);
    }
  });
  app.post('/api/auth/reauth', async (c) => {
    try {
      const row = await loadLocalSession(c.env.DB, c.req.raw);
      await requireAuthCsrf(c, row);
      const parsed = reauthSchema.safeParse(await readBoundedJson(c.req.raw));
      if (!parsed.success) throw new AuthHttpError(400, 'INVALID_INPUT', 'Girdi geçersiz.');
      await limitPasswordAttempt(c.env, c.req.raw, row.login_email);
      const hasher =
        dependencies.passwordHasher ?? createDurableObjectPasswordHasher(c.env.PASSWORD_KDF);
      const credential = await c.env.DB.prepare(
        'SELECT verifier FROM local_credentials WHERE user_id=? AND credential_version=? AND must_change_password=0',
      )
        .bind(row.user_id, row.credential_version)
        .first<{ verifier: string }>();
      if (!credential || !(await hasher.verify(parsed.data.password, credential.verifier)).matches)
        throw new AuthHttpError(403, 'REAUTH_FAILED', 'Şifre doğrulaması başarısız.');
      const now = Date.now();
      const token = randomSessionToken();
      const hash = await hashSessionToken(token);
      await c.env.DB.batch([
        liveSessionAssertion(c.env.DB, row, now),
        c.env.DB.prepare(
          'UPDATE local_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND credential_version=(SELECT credential_version FROM local_credentials WHERE user_id=?) AND permission_version=(SELECT permission_version FROM agency_memberships WHERE id=?)',
        ).bind(now, row.token_hash, now, row.user_id, row.membership_id),
        assertSessionChange(c.env.DB),
        sessionInsert(c.env.DB, hash, row, 'NORMAL', now, row.expires_at, now),
        authAudit(c.env.DB, row, 'auth.password.reauthenticated', row.user_id, now),
      ]);
      c.header('Set-Cookie', sessionCookie(token, row.expires_at));
      return authResponse(c, { reauthenticated: true });
    } catch (error) {
      await auditAuthDenial(c, 'auth.reauth.denied');
      if (error instanceof AuthHttpError && error.status === 429) c.header('Retry-After', '60');
      return authErrorResponse(c, error);
    }
  });
}
