// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT, type JWK, createLocalJWKSet } from 'jose';
import worker, { app, createApp, createWorker, type Env } from '../src/server/index';
import { createAccessVerifier } from '../src/server/auth/verifier';
import { API_PREFIX } from '../src/shared/constants';
import type { ApiResponse, UserMeDto } from '../src/shared/types';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

const TEST_TEAM_DOMAIN = 'mayi-test.cloudflareaccess.com';
const TEST_ISSUER = `https://${TEST_TEAM_DOMAIN}`;
const TEST_NORMAL_AUDIENCE = 'synthetic-normal-aud-1234567890abcdef';
const TEST_SECURE_AUDIENCE = 'synthetic-secure-aud-9876543210fedcba';
const PRIMARY_KID = 'key-synthetic-primary-001';

describe('M1-T06 GET /api/me Uç Noktası Entegrasyon Testleri (Miniflare D1 + Access JWT)', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  let primaryKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let keyResolver: ReturnType<typeof createLocalJWKSet>;
  let testApp: ReturnType<typeof createApp>;

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000001',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    // D1 migrasyonlarını çalıştır
    const m0 = readFileSync(resolve(rootDir, 'db/migrations/0000_good_hammerhead.sql'), 'utf8');
    const m1 = readFileSync(
      resolve(rootDir, 'db/migrations/0001_chunky_blazing_skull.sql'),
      'utf8',
    );

    for (const sql of [m0, m1]) {
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    // RS256 anahtar çifti oluştur
    primaryKeyPair = await generateKeyPair('RS256', { extractable: true });
    const exportedPrimary = await exportJWK(primaryKeyPair.publicKey);
    const primaryJwk: JWK = {
      ...exportedPrimary,
      kid: PRIMARY_KID,
      alg: 'RS256',
      use: 'sig',
    };
    keyResolver = createLocalJWKSet({ keys: [primaryJwk] });

    // Explicit dependency seam: testApp uses explicit verifier factory
    testApp = createApp({
      createVerifier: (config) => createAccessVerifier({ config, keyResolver }),
    });
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  function getBaseEnv(): Env {
    return {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
      CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
      CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
    };
  }

  async function createToken(
    claims: Record<string, unknown> = {},
    options: {
      kid?: string;
      alg?: string;
      expiresInSeconds?: number;
    } = {},
  ): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + (options.expiresInSeconds ?? 3600);
    const builder = new SignJWT({
      iss: TEST_ISSUER,
      aud: TEST_NORMAL_AUDIENCE,
      sub: 'usr-default-sub',
      type: 'app',
      email: 'personel@mayisigorta.com',
      iat: nowSec - 60,
      nbf: nowSec - 60,
      exp,
      ...claims,
    });

    builder.setProtectedHeader({
      alg: options.alg ?? 'RS256',
      kid: options.kid ?? PRIMARY_KID,
      typ: 'JWT',
    });

    return builder.sign(primaryKeyPair.privateKey);
  }

  // D1 Test Verisi Bootstrap Yardımcısı
  async function bootstrapActiveAgency(prefix: string, subject = `${prefix}-owner-sub`) {
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
      .bind(`${prefix}-agency`)
      .run();
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(`${prefix}-owner-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
         ) VALUES (?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)`,
      )
      .bind(
        `${prefix}-owner-mem`,
        `${prefix}-agency`,
        `${prefix}-owner-user`,
        `${prefix}-owner@example.test`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${prefix}-owner-id`,
        `${prefix}-owner-user`,
        TEST_ISSUER,
        subject,
        `${prefix}-owner@example.test`,
      )
      .run();
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
      .bind(`${prefix}-owner-user`)
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships
         SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
             version = version + 1, permission_version = permission_version + 1
         WHERE id = ?`,
      )
      .bind(`${prefix}-owner-mem`)
      .run();
    await db
      .prepare(
        `UPDATE agencies
         SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
             activated_at = '2026-09-17T00:00:00.000Z', version = version + 1
         WHERE id = ?`,
      )
      .bind(`${prefix}-agency`)
      .run();
  }

  it('GET /api/me without assertion header -> 401 generic JSON', async () => {
    const res = await testApp.request(`${API_PREFIX}/me`, undefined, getBaseEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toBe('Kimlik doğrulaması sağlanamadı.');
      expect('token' in body.error).toBe(false);
    }
  });

  it('GET /api/me with invalid assertion token -> 401 generic JSON', async () => {
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      {
        headers: { 'cf-access-jwt-assertion': 'invalid.token.structure' },
      },
      getBaseEnv(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('GET /api/me with expired token -> 401 generic JSON', async () => {
    const token = await createToken({}, { expiresInSeconds: -300 });
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      {
        headers: { 'cf-access-jwt-assertion': token },
      },
      getBaseEnv(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('GET /api/me with missing Access config -> 503 generic JSON', async () => {
    const token = await createToken();
    const envWithoutConfig: Env = {
      DB: db,
    };
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      {
        headers: { 'cf-access-jwt-assertion': token },
      },
      envWithoutConfig,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('GET /api/me with missing DB binding -> 503 generic JSON', async () => {
    const token = await createToken();
    const envWithoutDb = {
      CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
      CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
      CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
    } as unknown as Env;

    const res = await testApp.request(
      `${API_PREFIX}/me`,
      {
        headers: { 'cf-access-jwt-assertion': token },
      },
      envWithoutDb,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('GET /api/me with unknown subject -> 403 fail-closed (does not reveal lookup failed)', async () => {
    const token = await createToken({ sub: 'unknown-subject-12345' });
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      {
        headers: { 'cf-access-jwt-assertion': token },
      },
      getBaseEnv(),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Erişim reddedildi.');
      // Must not leak subject or internal lookup detail
      expect(JSON.stringify(body)).not.toContain('unknown-subject-12345');
    }
  });

  it('GET /api/me with revoked identity -> 403 fail-closed (generic error)', async () => {
    const p = 'route-revoked';
    const sub = `${p}-member-sub`;
    await bootstrapActiveAgency(p, `${p}-owner-sub`);

    // Add member
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${p}-member-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status, revoked_at)
         VALUES (?, ?, ?, ?, ?, 'REVOKED', '2026-09-17T00:00:00.000Z')`,
      )
      .bind(`${p}-member-id`, `${p}-member-user`, TEST_ISSUER, sub, `${p}-mem@test.com`)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem`, `${p}-agency`, `${p}-member-user`, `${p}-mem@test.com`)
      .run();

    const token = await createToken({ sub });
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      getBaseEnv(),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Erişim reddedildi.');
    }
  });

  it('GET /api/me with inactive user -> 403 fail-closed (generic error)', async () => {
    const p = 'route-inact-usr';
    const sub = `${p}-member-sub`;
    await bootstrapActiveAgency(p, `${p}-owner-sub`);

    // Add member with inactive user
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(`${p}-member-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(`${p}-member-id`, `${p}-member-user`, TEST_ISSUER, sub, `${p}-mem@test.com`)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem`, `${p}-agency`, `${p}-member-user`, `${p}-mem@test.com`)
      .run();

    const token = await createToken({ sub });
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      getBaseEnv(),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Erişim reddedildi.');
    }
  });

  it('GET /api/me with suspended/invited membership -> 403 fail-closed (generic error)', async () => {
    const p = 'route-susp-mem';
    const sub = `${p}-member-sub`;
    await bootstrapActiveAgency(p, `${p}-owner-sub`);

    // Add member with SUSPENDED membership
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${p}-member-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(`${p}-member-id`, `${p}-member-user`, TEST_ISSUER, sub, `${p}-mem@test.com`)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, suspended_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'SUSPENDED', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem`, `${p}-agency`, `${p}-member-user`, `${p}-mem@test.com`)
      .run();

    const token = await createToken({ sub });
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      getBaseEnv(),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Erişim reddedildi.');
    }
  });

  it('GET /api/me with corrupt identity data -> 503 generic JSON (dependency/integrity failure)', async () => {
    const corruptApp = createApp({
      createVerifier: (config) => createAccessVerifier({ config, keyResolver }),
      createResolver: () => ({
        resolve: async () => {
          const { IdentityResolutionError } = await import('../src/server/auth/identity');
          throw new IdentityResolutionError('CORRUPT_IDENTITY_DATA');
        },
      }),
    });

    const token = await createToken();
    const res = await corruptApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      getBaseEnv(),
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error.message).toBe('Hizmet şu anda kullanılamıyor.');
      expect(JSON.stringify(body)).not.toContain('CORRUPT_IDENTITY_DATA');
    }
  });

  it('GET /api/me with corrupt membership data -> 503 generic JSON (dependency/integrity failure)', async () => {
    const corruptApp = createApp({
      createVerifier: (config) => createAccessVerifier({ config, keyResolver }),
      createResolver: () => ({
        resolve: async () => {
          const { IdentityResolutionError } = await import('../src/server/auth/identity');
          throw new IdentityResolutionError('CORRUPT_MEMBERSHIP_DATA');
        },
      }),
    });

    const token = await createToken();
    const res = await corruptApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      getBaseEnv(),
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error.message).toBe('Hizmet şu anda kullanılamıyor.');
      expect(JSON.stringify(body)).not.toContain('CORRUPT_MEMBERSHIP_DATA');
    }
  });

  // =========================================================================
  // Adversarial D1Result Boundary Tests (I-01 Correction Cycle 2)
  // =========================================================================

  it('GET /api/me fails closed with 503 when D1 identity query returns malformed { success: true, results: [null] }', async () => {
    const adversarialDb = {
      prepare(_query: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              async all() {
                return { success: true, results: [null] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const token = await createToken();
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      { ...getBaseEnv(), DB: adversarialDb },
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error.message).toBe('Hizmet şu anda kullanılamıyor.');
    }
  });

  it('GET /api/me fails closed with 503 when D1 identity query returns unsuccessful { success: false, results: [] }', async () => {
    const adversarialDb = {
      prepare(_query: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              async all() {
                return { success: false, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const token = await createToken();
    const res = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      { ...getBaseEnv(), DB: adversarialDb },
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error.message).toBe('Hizmet şu anda kullanılamıyor.');
    }
  });

  it('GET /api/me fails closed with 503 when D1 user query returns malformed { success: true, results: [null] } or { success: false, results: [] }', async () => {
    // 1. user query returns { success: true, results: [null] }
    const userNullDb = {
      prepare(query: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'id-1',
                        user_id: 'usr-1',
                        issuer: TEST_ISSUER,
                        subject: 'usr-default-sub',
                        verified_email: 'personel@mayisigorta.com',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return { success: true, results: [null] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const token = await createToken();
    const res1 = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      { ...getBaseEnv(), DB: userNullDb },
    );
    expect(res1.status).toBe(503);
    const body1 = (await res1.json()) as ApiResponse<never>;
    expect(body1.success).toBe(false);
    if (!body1.success) {
      expect(body1.error.code).toBe('SERVICE_UNAVAILABLE');
    }

    // 2. user query returns { success: false, results: [] }
    const userUnsuccessDb = {
      prepare(query: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'id-1',
                        user_id: 'usr-1',
                        issuer: TEST_ISSUER,
                        subject: 'usr-default-sub',
                        verified_email: 'personel@mayisigorta.com',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return { success: false, results: [] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const res2 = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      { ...getBaseEnv(), DB: userUnsuccessDb },
    );
    expect(res2.status).toBe(503);
    const body2 = (await res2.json()) as ApiResponse<never>;
    expect(body2.success).toBe(false);
    if (!body2.success) {
      expect(body2.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('GET /api/me fails closed with 503 when D1 membership query returns malformed { success: true, results: [null] } or { success: false, results: [] }', async () => {
    // 1. membership query returns { success: true, results: [null] }
    const memNullDb = {
      prepare(query: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'id-1',
                        user_id: 'usr-1',
                        issuer: TEST_ISSUER,
                        subject: 'usr-default-sub',
                        verified_email: 'personel@mayisigorta.com',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return {
                    success: true,
                    results: [{ id: 'usr-1', status: 'ACTIVE' }],
                  };
                }
                if (query.includes('FROM agency_memberships')) {
                  return { success: true, results: [null] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const token = await createToken();
    const res1 = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      { ...getBaseEnv(), DB: memNullDb },
    );
    expect(res1.status).toBe(503);
    const body1 = (await res1.json()) as ApiResponse<never>;
    expect(body1.success).toBe(false);
    if (!body1.success) {
      expect(body1.error.code).toBe('SERVICE_UNAVAILABLE');
    }

    // 2. membership query returns { success: false, results: [] }
    const memUnsuccessDb = {
      prepare(query: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'id-1',
                        user_id: 'usr-1',
                        issuer: TEST_ISSUER,
                        subject: 'usr-default-sub',
                        verified_email: 'personel@mayisigorta.com',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return {
                    success: true,
                    results: [{ id: 'usr-1', status: 'ACTIVE' }],
                  };
                }
                if (query.includes('FROM agency_memberships')) {
                  return { success: false, results: [] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const res2 = await testApp.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': token } },
      { ...getBaseEnv(), DB: memUnsuccessDb },
    );
    expect(res2.status).toBe(503);
    const body2 = (await res2.json()) as ApiResponse<never>;
    expect(body2.success).toBe(false);
    if (!body2.success) {
      expect(body2.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('GET /api/me with valid active user and active membership -> 200 OK safe JSON DTO (no permissionVersion)', async () => {
    const p = 'route-success';
    const sub = `${p}-sub`;
    await bootstrapActiveAgency(p, sub);

    const token = await createToken({
      sub,
      email: `${p}-owner@example.test`,
    });

    const res = await testApp.request(
      `${API_PREFIX}/me`,
      {
        headers: { 'cf-access-jwt-assertion': token },
      },
      getBaseEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = (await res.json()) as ApiResponse<UserMeDto>;
    expect(body.success).toBe(true);
    if (body.success) {
      expect(body.data.userId).toBe(`${p}-owner-user`);
      expect(body.data.email).toBe(`${p}-owner@example.test`);
      expect(body.data.assurance).toBe('NORMAL');
      expect(body.data.memberships).toHaveLength(1);
      const [mem] = body.data.memberships;
      expect(mem).toBeDefined();
      expect(mem).toEqual({
        id: `${p}-owner-mem`,
        agencyId: `${p}-agency`,
        type: 'OWNER',
        status: 'ACTIVE',
      });

      // Internal concurrency / lifecycle fields must NOT be in the client DTO
      expect('permissionVersion' in mem!).toBe(false);
      expect('version' in mem!).toBe(false);

      // Safety checks on body:
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain('auth_identities');
      expect(serialized).not.toContain('agency_memberships');
      expect(serialized).not.toContain(`${p}-owner-id`); // internal identityId must not leak
      expect('permissions' in body.data).toBe(false); // No M1-T07 permission results
    }
  });

  it('production app ignores runtime env injection hooks and rejects forged principal/token', async () => {
    const p = 'prod-bypass-neg';
    const sub = `${p}-sub`;
    await bootstrapActiveAgency(p, sub);

    // Untrusted key that is not in any legitimate JWKS
    const rogueKeyPair = await generateKeyPair('RS256', { extractable: true });
    const rogueToken = await new SignJWT({
      iss: TEST_ISSUER,
      aud: TEST_NORMAL_AUDIENCE,
      sub,
      type: 'app',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'rogue-kid', typ: 'JWT' })
      .sign(rogueKeyPair.privateKey);

    // Malicious environment passing fake verifier and fake resolver hooks
    const maliciousEnv = {
      ...getBaseEnv(),
      ACCESS_VERIFIER: {
        verify: async () => ({
          issuer: TEST_ISSUER,
          subject: sub,
          assurance: 'NORMAL' as const,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      },
      IDENTITY_RESOLVER: {
        resolve: async () => ({
          userId: 'hacked-user',
          identityId: 'hacked-id',
          assurance: 'NORMAL' as const,
          memberships: [
            {
              id: 'hacked-mem',
              agencyId: 'hacked-agency',
              type: 'OWNER' as const,
              status: 'ACTIVE' as const,
              permissionVersion: 1,
            },
          ],
        }),
      },
    };

    // Request made to the EXPORTED PRODUCTION app (not testApp)
    const res = await app.request(
      `${API_PREFIX}/me`,
      { headers: { 'cf-access-jwt-assertion': rogueToken } },
      maliciousEnv,
    );

    // Must NOT be 200 (production app ignores env hooks completely and fails verification)
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as ApiResponse<never>;
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toContain('hacked-user');
    expect(JSON.stringify(body)).not.toContain('hacked-agency');
  });

  it('Worker handles routing and preserves /api/health and routing guarantees', async () => {
    const testWorker = createWorker(testApp);

    const p = 'worker-route';
    const sub = `${p}-sub`;
    await bootstrapActiveAgency(p, sub);
    const token = await createToken({ sub });

    const request = new Request('https://panel.mayisigorta.com/api/me', {
      headers: { 'cf-access-jwt-assertion': token },
    });

    const response = await testWorker.fetch(request, getBaseEnv(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');

    // Check that /api/health is preserved on production worker
    const healthReq = new Request('https://panel.mayisigorta.com/api/health');
    const healthRes = await worker.fetch(healthReq, getBaseEnv(), {} as ExecutionContext);
    expect(healthRes.status).toBe(200);

    // Check that unknown API still returns 404 JSON on production worker
    const unknownReq = new Request('https://panel.mayisigorta.com/api/unknown-endpoint');
    const unknownRes = await worker.fetch(unknownReq, getBaseEnv(), {} as ExecutionContext);
    expect(unknownRes.status).toBe(404);
  });
});
