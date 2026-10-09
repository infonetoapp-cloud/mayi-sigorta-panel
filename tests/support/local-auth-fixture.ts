import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import type { PasswordHasher } from '../../src/server/auth/password';
import { serializePasswordEnvelope } from '../../src/server/auth/password-envelope';
import { createApp, type Env } from '../../src/server/index';
import {
  LOCAL_AUTH_ISSUER,
  randomSessionToken,
  hashSessionToken,
  sessionInsert,
  NORMAL_ABSOLUTE_MS,
} from '../../src/server/auth/session';

/** Explicit test-only composition: no Env selector, no production bypass, no slow KDF loop. */
export function createTestPasswordHasher(): PasswordHasher & { calls: number } {
  const passwords = new Map<string, string>();
  const hasher = {
    calls: 0,
    supports: (verifier: string) => passwords.has(verifier),
    async hash(password: string) {
      hasher.calls++;
      const verifier = serializePasswordEnvelope(
        crypto.getRandomValues(new Uint8Array(16)),
        crypto.getRandomValues(new Uint8Array(32)),
      );
      passwords.set(verifier, password.normalize('NFC'));
      return verifier;
    },
    async verify(password: string, verifier: string) {
      hasher.calls++;
      return {
        matches: passwords.has(verifier) && passwords.get(verifier) === password.normalize('NFC'),
        needsRehash: false,
      };
    },
  };
  return hasher;
}
export function testRateLimit(limit = 10): RateLimit & { calls: number; reset(): void } {
  const counts = new Map<string, number>();
  const binding = {
    calls: 0,
    async limit({ key }: { key: string }) {
      binding.calls++;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
    reset() {
      counts.clear();
    },
  };
  return binding;
}
export async function localAuthFixture() {
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response(null)}}',
      d1Databases: { DB: '00000000-0000-0000-0000-000000000027' },
    }),
  );
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('db/migrations')
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    for (const stmt of readFileSync(resolve('db/migrations', file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(stmt).run();
  }
  const hasher = createTestPasswordHasher();
  const accountRate = testRateLimit(100);
  const sourceRate = testRateLimit(1000);
  const env: Env = {
    DB: db,
    APP_ENV: 'test',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    CSRF_SECRET: 'synthetic-csrf-secret-only-for-local-fixtures',
    AUTH_ACCOUNT_RATE_LIMITER: accountRate,
    AUTH_SOURCE_RATE_LIMITER: sourceRate,
    DOCUMENTS_ENABLED: 'false',
  };
  const app = createApp({ passwordHasher: hasher });
  async function seed(
    id: string,
    type: 'OWNER' | 'MEMBER' = 'MEMBER',
    temporary = false,
    agencyId = 'agency-auth-test',
  ) {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const email = `${id}@example.invalid`;
    const password = 'synthetic fixture permanent passphrase';
    if (!(await db.prepare('SELECT id FROM agencies WHERE id=?').bind(agencyId).first()))
      await db
        .prepare("INSERT INTO agencies(id,status) VALUES(?,'PROVISIONING')")
        .bind(agencyId)
        .run();
    await db
      .prepare("INSERT INTO users(id,status,display_name) VALUES(?,'ACTIVE',?)")
      .bind(id, `Synthetic ${id}`)
      .run();
    await db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance) VALUES(?,?,?,?,?,'OWNER_PROVISIONED')",
      )
      .bind(`identity-${id}`, id, LOCAL_AUTH_ISSUER, `subject-${id}`, email)
      .run();
    const agency = await db
      .prepare('SELECT status FROM agencies WHERE id=?')
      .bind(agencyId)
      .first<{ status: string }>();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at) VALUES(?,?,?,?,?,?,'2099-01-01T00:00:00.000Z',?)",
      )
      .bind(
        `membership-${id}`,
        agencyId,
        id,
        type,
        agency?.status === 'PROVISIONING' ? 'INVITED' : 'ACTIVE',
        email,
        iso,
      )
      .run();
    if (agency?.status === 'PROVISIONING')
      await db
        .prepare(
          "UPDATE agency_memberships SET status='ACTIVE',version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind(`membership-${id}`)
        .run();
    await db
      .prepare(
        'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        `identity-${id}`,
        email,
        await hasher.hash(password),
        temporary ? 1 : 0,
        temporary ? now + 86400000 : null,
        now,
      )
      .run();
    if (type === 'OWNER')
      await db
        .prepare(
          "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at=?,activated_at=?,version=version+1 WHERE id=? AND status='PROVISIONING'",
        )
        .bind(iso, iso, agencyId)
        .run();
    return {
      id,
      email,
      password,
      agencyId,
      membershipId: `membership-${id}`,
      identityId: `identity-${id}`,
    };
  }
  async function session(id: string, recent = false) {
    const row = await db
      .prepare(
        'SELECT c.*,m.id membership_id,m.permission_version FROM local_credentials c JOIN agency_memberships m ON m.user_id=c.user_id WHERE c.user_id=?',
      )
      .bind(id)
      .first<{
        user_id: string;
        identity_id: string;
        membership_id: string;
        credential_version: number;
        permission_version: number;
      }>();
    if (!row) throw new Error('Synthetic principal missing');
    const now = Date.now();
    const token = randomSessionToken();
    const hash = await hashSessionToken(token);
    await sessionInsert(
      db,
      hash,
      row,
      'NORMAL',
      now,
      now + NORMAL_ABSOLUTE_MS,
      recent ? now : null,
    ).run();
    return { cookie: `__Host-mayi-session=${token}`, hash };
  }
  async function request(
    path: string,
    method = 'GET',
    cookie?: string,
    body?: unknown,
    csrf?: string,
    extra: Record<string, string> = {},
  ) {
    return app.fetch(
      new Request(`https://panel.mayisigorta.com${path}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method === 'GET'
            ? {}
            : { origin: 'https://panel.mayisigorta.com', 'content-type': 'application/json' }),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  }
  async function csrf(cookie: string) {
    const res = await request('/api/auth/csrf-token', 'GET', cookie);
    return ((await res.json()) as { data: { token: string } }).data.token;
  }
  return { db, mf, hasher, env, app, seed, session, request, csrf, accountRate, sourceRate };
}
