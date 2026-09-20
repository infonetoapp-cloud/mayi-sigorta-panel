// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT, type JWK, createLocalJWKSet } from 'jose';
import { createApp, type Env } from '../src/server/index';
import { createAccessVerifier } from '../src/server/auth/verifier';
import type {
  ApiResponse,
  ApiSuccessEnvelope,
  CustomerDto,
  CustomerIdentityRevealDto,
  ExternalCustomerReferenceDto,
  CustomerAssignmentOptionDto,
} from '../src/shared/types';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

const TEST_TEAM_DOMAIN = 'mayi-test.cloudflareaccess.com';
const TEST_ISSUER = `https://${TEST_TEAM_DOMAIN}`;
const TEST_NORMAL_AUDIENCE = 'synthetic-normal-aud-1234567890abcdef';
const PRIMARY_KID = 'key-synthetic-primary-001';
const CSRF_SECRET = 'super-secret-csrf-key-for-test-32-chars-long';
const TRUSTED_ORIGIN = 'https://panel.mayisigorta.com';

const IDENTITY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const IDENTITY_HMAC_KEY = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const IDENTITY_KEY_VERSION = '1';

function asSuccess<T>(json: ApiResponse<T>): ApiSuccessEnvelope<T> {
  expect(json.success).toBe(true);
  return json as ApiSuccessEnvelope<T>;
}

function mutationRequest(
  url: string,
  method: 'POST' | 'PATCH' | 'PUT',
  headers: Record<string, string>,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: {
      Origin: TRUSTED_ORIGIN,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function queryRequest(url: string, jwt: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: {
      'Cf-Access-Jwt-Assertion': jwt,
    },
  });
}

describe('M2-T02 Customer Identity, Assign, and External Reference API Tests (Miniflare D1)', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  let primaryKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let keyResolver: ReturnType<typeof createLocalJWKSet>;
  let testApp: ReturnType<typeof createApp>;

  const AGENCY_ID = 'ag-m2t02-api';
  const OTHER_AGENCY_ID = 'ag-m2t02-other';

  const OWNER_USER = 'usr-owner';
  const OWNER_MEM = 'mem-owner';
  const OWNER_SUB = 'sub-owner';

  const MEMBER_ASSIGNED_USER = 'usr-member-assigned';
  const MEMBER_ASSIGNED_MEM = 'mem-member-assigned';
  const MEMBER_ASSIGNED_SUB = 'sub-member-assigned';

  const MEMBER_OTHER_USER = 'usr-member-other';
  const MEMBER_OTHER_MEM = 'mem-member-other';
  const MEMBER_OTHER_SUB = 'sub-member-other';

  const INACTIVE_USER = 'usr-inactive-mem';
  const INACTIVE_MEM = 'mem-inactive-mem';

  const OTHER_OWNER_USER = 'usr-other-owner';
  const OTHER_OWNER_MEM = 'mem-other-owner';
  const OTHER_OWNER_SUB = 'sub-other-owner';

  beforeAll(async () => {
    primaryKeyPair = await generateKeyPair('RS256');
    const publicJWK = await exportJWK(primaryKeyPair.publicKey);
    publicJWK.kid = PRIMARY_KID;
    publicJWK.use = 'sig';
    publicJWK.alg = 'RS256';

    keyResolver = createLocalJWKSet({
      keys: [publicJWK as JWK],
    });

    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000008',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    for (const file of [
      'db/migrations/0000_good_hammerhead.sql',
      'db/migrations/0001_chunky_blazing_skull.sql',
      'db/migrations/0002_productive_arclight.sql',
      'db/migrations/0003_lonely_zzzax.sql',
      'db/migrations/0004_thankful_pixie.sql',
      'db/migrations/0005_graceful_northstar.sql',
    ]) {
      const sql = readFileSync(resolve(rootDir, file), 'utf8');
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    async function seedAgency(agId: string, uId: string, mId: string, email: string, sub: string) {
      await db
        .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
        .bind(agId)
        .run();
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
        .bind(uId)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
           ) VALUES (?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)`,
        )
        .bind(mId, agId, uId, email)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
        )
        .bind(`ident-${uId}`, uId, TEST_ISSUER, sub, email)
        .run();
      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
        .bind(uId)
        .run();
      await db
        .prepare(
          "UPDATE agency_memberships SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z', version = version + 1, permission_version = permission_version + 1 WHERE id = ?",
        )
        .bind(mId)
        .run();
      await db
        .prepare(
          "UPDATE agencies SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z', activated_at = '2026-09-17T00:00:00.000Z', version = version + 1 WHERE id = ?",
        )
        .bind(agId)
        .run();
    }

    await seedAgency(AGENCY_ID, OWNER_USER, OWNER_MEM, 'owner@mayi.test', OWNER_SUB);
    await seedAgency(
      OTHER_AGENCY_ID,
      OTHER_OWNER_USER,
      OTHER_OWNER_MEM,
      'other-owner@mayi.test',
      OTHER_OWNER_SUB,
    );

    // Seed Member Assigned
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(MEMBER_ASSIGNED_USER)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version, activated_at
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'mem-ass@test.com', '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z')`,
      )
      .bind(MEMBER_ASSIGNED_MEM, AGENCY_ID, MEMBER_ASSIGNED_USER)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES ('ident-mem-ass', ?, ?, ?, 'mem-ass@test.com', 'ACTIVE')`,
      )
      .bind(MEMBER_ASSIGNED_USER, TEST_ISSUER, MEMBER_ASSIGNED_SUB)
      .run();

    // Seed Member Other
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(MEMBER_OTHER_USER)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version, activated_at
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'mem-oth@test.com', '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z')`,
      )
      .bind(MEMBER_OTHER_MEM, AGENCY_ID, MEMBER_OTHER_USER)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES ('ident-mem-oth', ?, ?, ?, 'mem-oth@test.com', 'ACTIVE')`,
      )
      .bind(MEMBER_OTHER_USER, TEST_ISSUER, MEMBER_OTHER_SUB)
      .run();

    // Seed Inactive Member
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(INACTIVE_USER)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version, activated_at, suspended_at
         ) VALUES (?, ?, ?, 'MEMBER', 'SUSPENDED', 'inactive@test.com', '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
      )
      .bind(INACTIVE_MEM, AGENCY_ID, INACTIVE_USER)
      .run();

    // Permissions for Member Assigned
    for (const [perm, scope] of [
      ['customer.create', 'UNSCOPED'],
      ['customer.read', 'ASSIGNED'],
      ['customer.update', 'ASSIGNED'],
      ['customer.assign', 'ASSIGNED'],
      ['sensitive.identity.read', 'UNSCOPED'],
      ['sensitive.identity.write', 'UNSCOPED'],
    ]) {
      await db
        .prepare(
          'INSERT INTO membership_permissions (id, membership_id, permission_code, scope) VALUES (?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), MEMBER_ASSIGNED_MEM, perm, scope)
        .run();
    }

    // Permissions for Member Other: customer.read (ASSIGNED), customer.update (ASSIGNED)
    for (const [perm, scope] of [
      ['customer.read', 'ASSIGNED'],
      ['customer.update', 'ASSIGNED'],
    ]) {
      await db
        .prepare(
          'INSERT INTO membership_permissions (id, membership_id, permission_code, scope) VALUES (?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), MEMBER_OTHER_MEM, perm, scope)
        .run();
    }

    // Sensitive permissions for Owner
    for (const perm of ['sensitive.identity.read', 'sensitive.identity.write']) {
      await db
        .prepare(
          "INSERT INTO membership_permissions (id, membership_id, permission_code, scope) VALUES (?, ?, ?, 'UNSCOPED')",
        )
        .bind(crypto.randomUUID(), OWNER_MEM, perm)
        .run();
    }

    testApp = createApp({
      createVerifier: (cfg) =>
        createAccessVerifier({
          config: cfg,
          keyResolver,
        }),
    });
  });

  afterAll(async () => {
    if (mf) await mf.dispose();
  });

  const TEST_SECURE_AUDIENCE = 'synthetic-secure-aud-9876543210fedcba';

  function getEnv(): Env {
    return {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
      CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
      CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
      CSRF_SECRET,
      IDENTITY_ENCRYPTION_KEY: IDENTITY_KEY,
      IDENTITY_HMAC_KEY: IDENTITY_HMAC_KEY,
      IDENTITY_KEY_VERSION,
    };
  }

  function send(req: Request) {
    return testApp.fetch(req, getEnv());
  }

  async function makeJwt(sub: string, email: string): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({
      email,
      sub,
      iss: TEST_ISSUER,
      aud: TEST_NORMAL_AUDIENCE,
      type: 'app',
      iat: nowSec - 60,
      nbf: nowSec - 60,
      exp: nowSec + 3600,
    })
      .setProtectedHeader({ alg: 'RS256', kid: PRIMARY_KID, typ: 'JWT' })
      .sign(primaryKeyPair.privateKey);
  }

  async function getCsrfToken(jwt: string): Promise<string> {
    const res = await send(
      new Request('https://panel.mayisigorta.com/api/csrf-token', {
        headers: { 'Cf-Access-Jwt-Assertion': jwt },
      }),
    );
    if (res.status !== 200) {
      const text = await res.text();
      console.error('CSRF TOKEN ERROR:', res.status, text);
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiSuccessEnvelope<{ token: string }>;
    return body.data.token;
  }

  it('keeps health and basic customer listing available while identity capabilities fail closed without crypto secrets', async () => {
    const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
    const envWithoutIdentitySecrets: Env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
      CF_ACCESS_AUDIENCE: TEST_NORMAL_AUDIENCE,
      CF_ACCESS_SECURE_AUDIENCE: TEST_SECURE_AUDIENCE,
      CSRF_SECRET,
    };

    const health = await testApp.fetch(
      new Request('https://panel.mayisigorta.com/api/health'),
      envWithoutIdentitySecrets,
    );
    expect(health.status).toBe(200);

    const list = await testApp.fetch(
      queryRequest('https://panel.mayisigorta.com/api/customers', ownerJwt),
      envWithoutIdentitySecrets,
    );
    expect(list.status).toBe(200);

    const reveal = await testApp.fetch(
      queryRequest('https://panel.mayisigorta.com/api/customers/nonexistent/identity', ownerJwt),
      envWithoutIdentitySecrets,
    );
    expect(reveal.status).toBe(503);

    const csrf = await getCsrfToken(ownerJwt);
    const write = await testApp.fetch(
      mutationRequest(
        'https://panel.mayisigorta.com/api/customers/nonexistent/identity',
        'PUT',
        {
          'Cf-Access-Jwt-Assertion': ownerJwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idem-missing-identity-config',
        },
        { expectedVersion: 1, identityType: 'TCKN', identityValue: '12345678901' },
      ),
      envWithoutIdentitySecrets,
    );
    expect(write.status).toBe(503);

    const search = await testApp.fetch(
      mutationRequest(
        'https://panel.mayisigorta.com/api/customers/search-sensitive',
        'POST',
        {
          'Cf-Access-Jwt-Assertion': ownerJwt,
          'X-CSRF-Token': csrf,
        },
        { identityType: 'TCKN', identityValue: '12345678901' },
      ),
      envWithoutIdentitySecrets,
    );
    expect(search.status).toBe(503);
  });

  describe('PUT /api/customers/:id/identity & GET /api/customers/:id/identity', () => {
    it('sets TCKN on individual customer, verifies masked in DTO, and reveals plaintext with no-store', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const csrf = await getCsrfToken(ownerJwt);

      // Create INDIVIDUAL customer
      const createRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-api-create-indiv',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'Individual With Identity',
            firstName: 'Ali',
            lastName: 'Veli',
          },
        ),
      );
      expect(createRes.status).toBe(201);
      const created = asSuccess<CustomerDto>(await createRes.json()).data;
      expect(created.hasIdentity).toBe(false);
      expect(created.identityMasked).toBeNull();

      // Set TCKN identity via PUT /api/customers/:id/identity
      const putRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${created.id}/identity`,
          'PUT',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-api-put-id-1',
          },
          {
            expectedVersion: 1,
            identityType: 'TCKN',
            identityValue: '12345678901',
          },
        ),
      );
      expect(putRes.status).toBe(200);

      const persistedIdentity = await db
        .prepare(
          `SELECT identity_type, identity_ciphertext, identity_iv, identity_tag,
                  identity_search_hash, identity_key_version
           FROM customers WHERE id = ?`,
        )
        .bind(created.id)
        .first<Record<string, unknown>>();
      const identityAudit = await db
        .prepare(
          "SELECT metadata_json FROM audit_events WHERE action = 'customer.identity.update' AND target_id = ?",
        )
        .bind(created.id)
        .first<{ metadata_json: string }>();
      const identityReceipt = await db
        .prepare(
          "SELECT * FROM operation_receipts WHERE action = 'customer.identity.update' AND idempotency_key = 'idem-api-put-id-1'",
        )
        .first<Record<string, unknown>>();
      for (const persistedValue of [persistedIdentity, identityAudit, identityReceipt]) {
        expect(JSON.stringify(persistedValue)).not.toContain('12345678901');
      }

      // Verify GET /api/customers/:id returns masked
      const getCustRes = await send(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${created.id}`, ownerJwt),
      );
      expect(getCustRes.status).toBe(200);
      const fetchedCust = asSuccess<CustomerDto>(await getCustRes.json()).data;
      expect(JSON.stringify(fetchedCust)).not.toContain('12345678901');
      expect(fetchedCust.hasIdentity).toBe(true);
      expect(fetchedCust.identityMasked).toBe('***');
      expect(fetchedCust.version).toBe(2);

      // Reveal identity via GET /api/customers/:id/identity
      const revealRes = await send(
        queryRequest(
          `https://panel.mayisigorta.com/api/customers/${created.id}/identity`,
          ownerJwt,
        ),
      );
      expect(revealRes.status).toBe(200);
      expect(revealRes.headers.get('Cache-Control')).toContain('no-store');
      expect(revealRes.headers.get('Cache-Control')).toContain('private');

      const revealed = asSuccess<CustomerIdentityRevealDto>(await revealRes.json()).data;
      expect(revealed.customerId).toBe(created.id);
      expect(revealed.identityType).toBe('TCKN');
      expect(revealed.identityValue).toBe('12345678901');

      // Clear identity via PUT /api/customers/:id/identity with clear: true
      const clearRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${created.id}/identity`,
          'PUT',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-api-put-id-clear',
          },
          {
            expectedVersion: 2,
            clear: true,
          },
        ),
      );
      expect(clearRes.status).toBe(200);

      // Verify reveal after clear returns 404
      const revealAfterClear = await send(
        queryRequest(
          `https://panel.mayisigorta.com/api/customers/${created.id}/identity`,
          ownerJwt,
        ),
      );
      expect(revealAfterClear.status).toBe(404);
    });

    it('rejects invalid TCKN (not 11 digits) or VKN (not 10 digits)', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const csrf = await getCsrfToken(ownerJwt);

      // Create customer first
      const createRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-create-for-bad-id',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'Bad ID Customer',
            firstName: 'Bad',
            lastName: 'ID',
          },
        ),
      );
      const cust = asSuccess<CustomerDto>(await createRes.json()).data;

      // Try 10 digits as TCKN
      const badRes1 = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/identity`,
          'PUT',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-bad-tckn',
          },
          {
            expectedVersion: 1,
            identityType: 'TCKN',
            identityValue: '1234567890', // 10 digits
          },
        ),
      );
      expect(badRes1.status).toBe(400);

      // Try non-numeric
      const badRes2 = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/identity`,
          'PUT',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-bad-vkn',
          },
          {
            expectedVersion: 1,
            identityType: 'VKN',
            identityValue: '12345ABC90',
          },
        ),
      );
      expect(badRes2.status).toBe(400);
    });

    it('rejects generic PATCH sending identity or assignment fields', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const csrf = await getCsrfToken(ownerJwt);

      const createRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-create-for-patch-guard',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'Patch Guard Customer',
            firstName: 'Patch',
            lastName: 'Guard',
          },
        ),
      );
      const cust = asSuccess<CustomerDto>(await createRes.json()).data;

      const patchRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}`,
          'PATCH',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-patch-forbidden-field',
          },
          {
            expectedVersion: 1,
            identityType: 'TCKN',
            identityValue: '12345678901',
          },
        ),
      );
      expect(patchRes.status).toBe(400);
    });
  });

  describe('POST /api/customers/search-sensitive', () => {
    it('requires CSRF before parsing the sensitive search body', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const response = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers/search-sensitive',
          'POST',
          { 'Cf-Access-Jwt-Assertion': ownerJwt },
          { identityType: 'TCKN', identityValue: '12345678901' },
        ),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: { code: 'MISSING_CSRF_TOKEN' },
      });
    });

    it('finds customer by exact identity search and enforces no query strings and no-store', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const csrf = await getCsrfToken(ownerJwt);

      // Create company customer
      const createRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-create-comp-search',
          },
          {
            type: 'COMPANY',
            displayName: 'Searchable Corp',
            companyTitle: 'Searchable Corp A.Ş.',
          },
        ),
      );
      const companyCust = asSuccess<CustomerDto>(await createRes.json()).data;

      // Set VKN
      await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCust.id}/identity`,
          'PUT',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-put-vkn-search',
          },
          {
            expectedVersion: 1,
            identityType: 'VKN',
            identityValue: '9876543210',
          },
        ),
      );

      // Attempt search with query parameter in URL -> must be REJECTED!
      const urlWithQuery = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers/search-sensitive?vkn=9876543210',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
          },
          {
            identityType: 'VKN',
            identityValue: '9876543210',
          },
        ),
      );
      expect(urlWithQuery.status).toBe(400);

      // Search with body only -> succeeds
      const searchRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers/search-sensitive',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
          },
          {
            identityType: 'VKN',
            identityValue: '9876543210',
          },
        ),
      );
      expect(searchRes.status).toBe(200);
      expect(searchRes.headers.get('Cache-Control')).toContain('no-store');
      expect(searchRes.headers.get('Cache-Control')).toContain('private');

      const items = asSuccess<CustomerDto[]>(await searchRes.json()).data;
      expect(items.length).toBe(1);
      expect(items[0]!.id).toBe(companyCust.id);
      expect(items[0]!.hasIdentity).toBe(true);
      expect(items[0]!.identityMasked).toBe('***');
    });

    it('returns only customers inside an ASSIGNED member effective scope', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const memberJwt = await makeJwt(MEMBER_ASSIGNED_SUB, 'mem-ass@test.com');
      const ownerCsrf = await getCsrfToken(ownerJwt);
      const memberCsrf = await getCsrfToken(memberJwt);
      const identityValue = '11111111111';

      const createCustomerFor = async (
        jwt: string,
        csrf: string,
        key: string,
        displayName: string,
      ) => {
        const response = await send(
          mutationRequest(
            'https://panel.mayisigorta.com/api/customers',
            'POST',
            {
              'Cf-Access-Jwt-Assertion': jwt,
              'X-CSRF-Token': csrf,
              'Idempotency-Key': `${key}-create`,
            },
            { type: 'INDIVIDUAL', displayName, firstName: displayName, lastName: 'Scope' },
          ),
        );
        expect(response.status).toBe(201);
        return asSuccess<CustomerDto>(await response.json()).data;
      };

      const assignedCustomer = await createCustomerFor(
        memberJwt,
        memberCsrf,
        'idem-assigned-search-own',
        'Assigned',
      );
      const outsideCustomer = await createCustomerFor(
        ownerJwt,
        ownerCsrf,
        'idem-assigned-search-other',
        'Outside',
      );

      for (const [customer, jwt, csrf, key] of [
        [assignedCustomer, memberJwt, memberCsrf, 'idem-assigned-search-own-identity'],
        [outsideCustomer, ownerJwt, ownerCsrf, 'idem-assigned-search-other-identity'],
      ] as const) {
        const response = await send(
          mutationRequest(
            `https://panel.mayisigorta.com/api/customers/${customer.id}/identity`,
            'PUT',
            {
              'Cf-Access-Jwt-Assertion': jwt,
              'X-CSRF-Token': csrf,
              'Idempotency-Key': key,
            },
            { expectedVersion: 1, identityType: 'TCKN', identityValue },
          ),
        );
        expect(response.status).toBe(200);
      }

      const search = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers/search-sensitive',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': memberJwt,
            'X-CSRF-Token': memberCsrf,
          },
          { identityType: 'TCKN', identityValue },
        ),
      );
      expect(search.status).toBe(200);
      const items = asSuccess<CustomerDto[]>(await search.json()).data;
      expect(items.map((item) => item.id)).toEqual([assignedCustomer.id]);
    });
  });

  describe('GET /api/customers/:id/assignment-options', () => {
    it('returns only active same-agency memberships after assignment authorization', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const ownerCsrf = await getCsrfToken(ownerJwt);
      const createResponse = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': ownerCsrf,
            'Idempotency-Key': 'idem-assignment-options-customer',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'Assignment Options',
            firstName: 'Assignment',
            lastName: 'Options',
          },
        ),
      );
      expect(createResponse.status).toBe(201);
      const customer = asSuccess<CustomerDto>(await createResponse.json()).data;

      const response = await send(
        queryRequest(
          `https://panel.mayisigorta.com/api/customers/${customer.id}/assignment-options`,
          ownerJwt,
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      const options = asSuccess<CustomerAssignmentOptionDto[]>(await response.json()).data;
      expect(options).toEqual([
        {
          membershipId: MEMBER_ASSIGNED_MEM,
          label: 'mem-ass@test.com',
          membershipType: 'MEMBER',
        },
        {
          membershipId: MEMBER_OTHER_MEM,
          label: 'mem-oth@test.com',
          membershipType: 'MEMBER',
        },
        { membershipId: OWNER_MEM, label: 'owner@mayi.test', membershipType: 'OWNER' },
      ]);
      expect(options.some((option) => option.membershipId === INACTIVE_MEM)).toBe(false);
      expect(options.some((option) => option.membershipId === OTHER_OWNER_MEM)).toBe(false);
    });
  });

  describe('POST /api/customers/:id/assign', () => {
    it('reassigns customer and verifies immediate live ASSIGNED scope switch', async () => {
      const memberAssignedJwt = await makeJwt(MEMBER_ASSIGNED_SUB, 'mem-ass@test.com');
      const csrfMember = await getCsrfToken(memberAssignedJwt);

      // Create customer assigned to Member Assigned
      // Note: Member Assigned creates it -> assignee is Member Assigned
      const createRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': memberAssignedJwt,
            'X-CSRF-Token': csrfMember,
            'Idempotency-Key': 'idem-create-for-reassign',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'To Be Reassigned',
            firstName: 'Reassign',
            lastName: 'Customer',
          },
        ),
      );
      expect(createRes.status).toBe(201);
      const cust = asSuccess<CustomerDto>(await createRes.json()).data;
      expect(cust.assigneeMembershipId).toBe(MEMBER_ASSIGNED_MEM);

      // Member Assigned reassigns customer to Member Other
      const assignRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/assign`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': memberAssignedJwt,
            'X-CSRF-Token': csrfMember,
            'Idempotency-Key': 'idem-assign-action-1',
          },
          {
            expectedVersion: 1,
            assigneeMembershipId: MEMBER_OTHER_MEM,
          },
        ),
      );
      expect(assignRes.status).toBe(200);
      const reassignedCust = asSuccess<CustomerDto>(await assignRes.json()).data;
      expect(reassignedCust.assigneeMembershipId).toBe(MEMBER_OTHER_MEM);
      expect(reassignedCust.version).toBe(2);

      const assignmentReplay = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/assign`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': memberAssignedJwt,
            'X-CSRF-Token': csrfMember,
            'Idempotency-Key': 'idem-assign-action-1',
          },
          { expectedVersion: 1, assigneeMembershipId: MEMBER_OTHER_MEM },
        ),
      );
      expect(assignmentReplay.status).toBe(200);
      expect(asSuccess<CustomerDto>(await assignmentReplay.json()).data).toEqual(reassignedCust);

      const memberOtherJwt = await makeJwt(MEMBER_OTHER_SUB, 'mem-oth@test.com');
      const newAssigneeRead = await send(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${cust.id}`, memberOtherJwt),
      );
      expect(newAssigneeRead.status).toBe(200);

      const assignmentAudits = await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'customer.assign' AND target_id = ?",
        )
        .bind(cust.id)
        .first<{ count: number }>();
      expect(assignmentAudits?.count).toBe(1);

      // LIVE SCOPE SWITCH VERIFICATION:
      // Member Assigned immediately tries to update the customer!
      // Must be forbidden (403 or 404 non-disclosure)!
      const updateRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}`,
          'PATCH',
          {
            'Cf-Access-Jwt-Assertion': memberAssignedJwt,
            'X-CSRF-Token': csrfMember,
            'Idempotency-Key': 'idem-member-blocked-update',
          },
          {
            expectedVersion: 2,
            displayName: 'Should Not Work',
          },
        ),
      );
      expect([403, 404]).toContain(updateRes.status);
    });

    it('rejects assignment to inactive member or cross-agency member', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const csrf = await getCsrfToken(ownerJwt);

      // Create customer
      const createRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-create-for-bad-assign',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'Bad Assign Customer',
            firstName: 'Bad',
            lastName: 'Assign',
          },
        ),
      );
      const cust = asSuccess<CustomerDto>(await createRes.json()).data;

      const staleRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/assign`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-stale-assign',
          },
          { expectedVersion: 99, assigneeMembershipId: MEMBER_OTHER_MEM },
        ),
      );
      expect(staleRes.status).toBe(409);

      // Inactive member
      const badRes1 = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/assign`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-bad-assign-inact',
          },
          {
            expectedVersion: 1,
            assigneeMembershipId: INACTIVE_MEM,
          },
        ),
      );
      expect(badRes1.status).toBe(400);

      // Cross-agency member
      const badRes2 = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/assign`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-bad-assign-cross',
          },
          {
            expectedVersion: 1,
            assigneeMembershipId: OTHER_OWNER_MEM,
          },
        ),
      );
      expect(badRes2.status).toBe(400);
    });
  });

  describe('POST & GET /api/customers/:id/external-references', () => {
    it('creates external reference, increments version, lists references, and rejects duplicates', async () => {
      const ownerJwt = await makeJwt(OWNER_SUB, 'owner@mayi.test');
      const csrf = await getCsrfToken(ownerJwt);

      // Create customer
      const createRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-create-for-ext-ref',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'Customer Ext Ref Test',
            firstName: 'Ext',
            lastName: 'Ref',
          },
        ),
      );
      const cust = asSuccess<CustomerDto>(await createRes.json()).data;

      // Create external reference
      const postRefRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/external-references`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-post-ext-ref-1',
          },
          {
            expectedVersion: 1,
            sourceNamespace: 'ALLIANZ',
            externalKey: 'POL-100200',
          },
        ),
      );
      expect(postRefRes.status).toBe(201);
      const createdRef = asSuccess<ExternalCustomerReferenceDto>(await postRefRes.json()).data;
      expect(createdRef.customerId).toBe(cust.id);
      expect(createdRef.sourceNamespace).toBe('ALLIANZ');
      expect(createdRef.externalKey).toBe('POL-100200');

      const replayRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/external-references`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-post-ext-ref-1',
          },
          { expectedVersion: 1, sourceNamespace: 'ALLIANZ', externalKey: 'POL-100200' },
        ),
      );
      expect(replayRes.status).toBe(201);
      expect(asSuccess<ExternalCustomerReferenceDto>(await replayRes.json()).data).toEqual(
        createdRef,
      );

      const secondCustomerRes = await send(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-create-for-ext-ref-second-target',
          },
          {
            type: 'INDIVIDUAL',
            displayName: 'Second External Reference Target',
            firstName: 'Second',
            lastName: 'Target',
          },
        ),
      );
      expect(secondCustomerRes.status).toBe(201);
      const secondCustomer = asSuccess<CustomerDto>(await secondCustomerRes.json()).data;

      const changedTargetRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${secondCustomer.id}/external-references`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-post-ext-ref-1',
          },
          { expectedVersion: 1, sourceNamespace: 'ALLIANZ', externalKey: 'POL-100200' },
        ),
      );
      expect(changedTargetRes.status).toBe(409);

      const changedPayloadRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/external-references`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-post-ext-ref-1',
          },
          { expectedVersion: 1, sourceNamespace: 'ALLIANZ', externalKey: 'POL-CHANGED' },
        ),
      );
      expect(changedPayloadRes.status).toBe(409);

      // List external references
      const listRefRes = await send(
        queryRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/external-references`,
          ownerJwt,
        ),
      );
      expect(listRefRes.status).toBe(200);
      const refList = asSuccess<ExternalCustomerReferenceDto[]>(await listRefRes.json()).data;
      expect(refList.length).toBe(1);
      expect(refList[0]!.sourceNamespace).toBe('ALLIANZ');
      expect(refList[0]!.externalKey).toBe('POL-100200');

      const extRefAudits = await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'customer.external_reference.create' AND target_id = ?",
        )
        .bind(createdRef.id)
        .first<{ count: number }>();
      expect(extRefAudits?.count).toBe(1);

      // Reject duplicate
      const dupRes = await send(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${cust.id}/external-references`,
          'POST',
          {
            'Cf-Access-Jwt-Assertion': ownerJwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idem-post-ext-ref-dup',
          },
          {
            expectedVersion: 2,
            sourceNamespace: 'ALLIANZ',
            externalKey: 'POL-100200',
          },
        ),
      );
      expect(dupRes.status).toBe(409);
    });
  });
});
