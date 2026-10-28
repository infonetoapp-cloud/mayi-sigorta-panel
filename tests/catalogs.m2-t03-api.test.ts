// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import { mintFixtureSession } from './support/domain-local-session';
import { LOCAL_AUTH_ISSUER } from '../src/server/auth/session';
import { createDefaultActionRegistry } from '../src/server/auth/authorization';
import type {
  ApiResponse,
  ApiSuccessEnvelope,
  InsurerDto,
  InsuranceBranchDto,
  SelectableCatalogsDto,
} from '../src/shared/types';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

const TEST_ISSUER = LOCAL_AUTH_ISSUER;
const CSRF_SECRET = 'super-secret-csrf-key-for-test-32-chars-long';
const TRUSTED_ORIGIN = 'https://panel.mayisigorta.com';

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
      Cookie: jwt,
    },
  });
}

describe('M2-T03 Catalogs & Agency Settings API & Auth Tests (Miniflare D1)', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  let testApp: ReturnType<typeof createApp>;

  const AGENCY_A = 'ag-t03-api-a';
  const AGENCY_B = 'ag-t03-api-b';

  const OWNER_USER = 'usr-t03-api-owner';
  const OWNER_MEM = 'mem-t03-api-owner';
  const OWNER_SUB = 'sub-t03-api-owner';

  const MEMBER_CAT_USER = 'usr-t03-api-mem-cat';
  const MEMBER_CAT_MEM = 'mem-t03-api-mem-cat';
  const MEMBER_CAT_SUB = 'sub-t03-api-mem-cat';

  const MEMBER_SETT_USER = 'usr-t03-api-mem-sett';
  const MEMBER_SETT_MEM = 'mem-t03-api-mem-sett';
  const MEMBER_SETT_SUB = 'sub-t03-api-mem-sett';

  const MEMBER_NONE_USER = 'usr-t03-api-mem-none';
  const MEMBER_NONE_MEM = 'mem-t03-api-mem-none';
  const MEMBER_NONE_SUB = 'sub-t03-api-mem-none';

  const OTHER_OWNER_USER = 'usr-t03-api-other-owner';
  const OTHER_OWNER_MEM = 'mem-t03-api-other-owner';
  const OTHER_OWNER_SUB = 'sub-t03-api-other-owner';

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000009',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    for (const file of [
      '0000_good_hammerhead.sql',
      '0001_chunky_blazing_skull.sql',
      '0002_productive_arclight.sql',
      '0003_lonely_zzzax.sql',
      '0004_thankful_pixie.sql',
      '0005_graceful_northstar.sql',
    ]) {
      const sql = readFileSync(resolve(rootDir, 'db/migrations', file), 'utf8');
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    try {
      const { readdirSync } = await import('node:fs');
      const migDir = resolve(rootDir, 'db/migrations');
      const generated = readdirSync(migDir)
        .filter((file) => /^000[67]_.*\.sql$/.test(file))
        .sort();
      for (const file of generated) {
        const sql = readFileSync(resolve(migDir, file), 'utf8');
        const stmts = sql
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const stmt of stmts) {
          await db.prepare(stmt).run();
        }
      }
    } catch {
      // RED phase
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
        .prepare("UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = ?")
        .bind(uId)
        .run();
      await db
        .prepare(
          "UPDATE agency_memberships SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z', version = 2, permission_version = 2 WHERE id = ?",
        )
        .bind(mId)
        .run();
      await db
        .prepare(
          "UPDATE agencies SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z', activated_at = '2026-09-17T00:00:00.000Z', version = 2 WHERE id = ?",
        )
        .bind(agId)
        .run();
    }

    await seedAgency(AGENCY_A, OWNER_USER, OWNER_MEM, 'owner@test.com', OWNER_SUB);
    await seedAgency(
      AGENCY_B,
      OTHER_OWNER_USER,
      OTHER_OWNER_MEM,
      'other-owner@test.com',
      OTHER_OWNER_SUB,
    );

    async function addMember(
      uId: string,
      mId: string,
      email: string,
      sub: string,
      perms: string[],
    ) {
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
        .bind(uId)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
             activated_at, version, permission_version
           ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z',
             '2026-09-17T00:00:00.000Z', 1, 1)`,
        )
        .bind(mId, AGENCY_A, uId, email)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
        )
        .bind(`ident-${uId}`, uId, TEST_ISSUER, sub, email)
        .run();

      for (const p of perms) {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES (?, ?, ?, 'UNSCOPED')`,
          )
          .bind(`perm-${mId}-${p}`, mId, p)
          .run();
      }
    }

    // Member with catalog.manage only
    await addMember(MEMBER_CAT_USER, MEMBER_CAT_MEM, 'mem-cat@test.com', MEMBER_CAT_SUB, [
      'catalog.manage',
    ]);

    // Member with agency.settings.manage only
    await addMember(MEMBER_SETT_USER, MEMBER_SETT_MEM, 'mem-sett@test.com', MEMBER_SETT_SUB, [
      'agency.settings.manage',
    ]);

    // Member with NO permissions
    await addMember(MEMBER_NONE_USER, MEMBER_NONE_MEM, 'mem-none@test.com', MEMBER_NONE_SUB, []);

    testApp = createApp();
  });

  afterAll(async () => {
    if (mf) await mf.dispose();
  });

  async function createSessionCookie(subject: string, email: string): Promise<string> {
    return mintFixtureSession(db, subject, email);
  }

  async function getCsrfToken(jwt: string): Promise<string> {
    const res = await testApp.fetch(
      new Request('https://panel.mayisigorta.com/api/csrf-token', {
        headers: { Cookie: jwt },
      }),
      {
        DB: db,
        CSRF_SECRET,
        TRUSTED_ORIGIN,
      } as unknown as Env,
    );
    const body = (await res.json()) as { success: boolean; data: { token: string } };
    return body.data.token;
  }

  function env(): Env {
    return {
      DB: db,
      CSRF_SECRET,
      TRUSTED_ORIGIN,
    } as unknown as Env;
  }

  describe('CSRF & Request Security Gate', () => {
    it('rejects mutation without CSRF token before body parse', async () => {
      const jwt = await createSessionCookie(OWNER_SUB, 'owner@test.com');
      const req = mutationRequest(
        'https://panel.mayisigorta.com/api/catalogs/insurers',
        'POST',
        {
          Cookie: jwt,
          // Missing X-CSRF-Token!
          'Idempotency-Key': 'idemp-csrf-1',
        },
        { code: 'AXA', name: 'Axa Sigorta' },
      );
      const res = await testApp.fetch(req, env());
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        success: false,
        error: { code: 'MISSING_CSRF_TOKEN' },
      });
    });

    it('rejects caller-selected authority fields in payload', async () => {
      const jwt = await createSessionCookie(OWNER_SUB, 'owner@test.com');
      const csrf = await getCsrfToken(jwt);
      const req = mutationRequest(
        'https://panel.mayisigorta.com/api/catalogs/insurers',
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-mass-assign-1',
        },
        {
          code: 'SOMPO',
          name: 'Sompo Sigorta',
          agencyId: AGENCY_B, // FORBIDDEN: caller cannot select agency!
          status: 'INACTIVE', // FORBIDDEN: caller cannot select status!
          version: 99, // FORBIDDEN!
          action: 'agency.settings.update_operations',
          permissionCode: 'agency.settings.manage',
          assurance: 'SECURE_GRANT',
        },
      );
      const res = await testApp.fetch(req, env());
      expect(res.status).toBe(400); // Strict Zod rejection
    });

    it('rejects an invalid agency timezone before persistence', async () => {
      const jwt = await createSessionCookie(OWNER_SUB, 'owner@test.com');
      const csrf = await getCsrfToken(jwt);
      const response = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/agency/settings',
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idemp-invalid-timezone',
          },
          { expectedVersion: 1, timezone: 'not/a-real-timezone' },
        ),
        env(),
      );
      expect(response.status).toBe(400);
    });
  });

  describe('Authorization & Permission Matrix', () => {
    it('registers operational catalog/settings actions as membership-authorized normal-session actions', () => {
      const registry = createDefaultActionRegistry();
      const catalogActions = [
        'catalog.insurer.create',
        'catalog.insurer.update',
        'catalog.insurer.deactivate',
        'catalog.branch.create',
        'catalog.branch.update',
        'catalog.branch.deactivate',
        'catalog.product.create',
        'catalog.product.update',
        'catalog.product.deactivate',
        'catalog.payment_method.create',
        'catalog.payment_method.update',
        'catalog.payment_method.deactivate',
        'catalog.loss_reason.create',
        'catalog.loss_reason.update',
        'catalog.loss_reason.deactivate',
      ];

      for (const code of catalogActions) {
        expect(registry.get(code)).toMatchObject({
          authority: 'MEMBERSHIP_AUTHORIZED',
          assurance: 'NORMAL_SESSION',
          requiredNormalPermissions: ['catalog.manage'],
          requiredSensitivePermissions: [],
        });
      }
      expect(registry.get('agency.settings.update_operations')).toMatchObject({
        authority: 'MEMBERSHIP_AUTHORIZED',
        assurance: 'NORMAL_SESSION',
        requiredNormalPermissions: ['agency.settings.manage'],
        requiredSensitivePermissions: [],
      });
    });

    it('OWNER has implicit normal permission and can create insurer', async () => {
      const jwt = await createSessionCookie(OWNER_SUB, 'owner@test.com');
      const csrf = await getCsrfToken(jwt);
      const req = mutationRequest(
        'https://panel.mayisigorta.com/api/catalogs/insurers',
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-api-ins-owner',
        },
        { code: 'ANADOLU_API', name: 'Anadolu Sigorta' },
      );
      const res = await testApp.fetch(req, env());
      expect(res.status).toBe(201);
      const body = asSuccess<InsurerDto>(await res.json());
      expect(body.data.code).toBe('ANADOLU_API');
      expect(body.data.status).toBe('ACTIVE');
    });

    it('MEMBER with catalog.manage can create branch', async () => {
      const jwt = await createSessionCookie(MEMBER_CAT_SUB, 'mem-cat@test.com');
      const csrf = await getCsrfToken(jwt);
      const req = mutationRequest(
        'https://panel.mayisigorta.com/api/catalogs/branches',
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-api-br-cat',
        },
        { code: 'TRAFIK', name: 'Zorunlu Trafik Sigortası' },
      );
      const res = await testApp.fetch(req, env());
      expect(res.status).toBe(201);
      const body = asSuccess<InsuranceBranchDto>(await res.json());
      expect(body.data.code).toBe('TRAFIK');
    });

    it('MEMBER with catalog.manage CANNOT update agency settings (requires agency.settings.manage)', async () => {
      const jwt = await createSessionCookie(MEMBER_CAT_SUB, 'mem-cat@test.com');
      const csrf = await getCsrfToken(jwt);
      const req = mutationRequest(
        'https://panel.mayisigorta.com/api/agency/settings',
        'PATCH',
        {
          Cookie: jwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-api-sett-fail',
        },
        { expectedVersion: 1, renewalWindowDays: 45 },
      );
      const res = await testApp.fetch(req, env());
      expect(res.status).toBe(403);
    });

    it('MEMBER with agency.settings.manage can update operational settings', async () => {
      const jwt = await createSessionCookie(MEMBER_SETT_SUB, 'mem-sett@test.com');
      const csrf = await getCsrfToken(jwt);
      const response = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/agency/settings',
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'idemp-api-settings-allowed',
          },
          { expectedVersion: 1, timezone: 'Europe/Istanbul', renewalWindowDays: 45 },
        ),
        env(),
      );
      expect(response.status).toBe(200);
    });

    it('MEMBER with agency.settings.manage CANNOT mutate catalogs (requires catalog.manage)', async () => {
      const jwt = await createSessionCookie(MEMBER_SETT_SUB, 'mem-sett@test.com');
      const csrf = await getCsrfToken(jwt);
      const req = mutationRequest(
        'https://panel.mayisigorta.com/api/catalogs/insurers',
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-api-ins-sett-fail',
        },
        { code: 'HDI', name: 'HDI Sigorta' },
      );
      const res = await testApp.fetch(req, env());
      expect(res.status).toBe(403);
    });

    it('MEMBER with NO permissions is rejected for both', async () => {
      const jwt = await createSessionCookie(MEMBER_NONE_SUB, 'mem-none@test.com');
      const csrf = await getCsrfToken(jwt);
      const req1 = mutationRequest(
        'https://panel.mayisigorta.com/api/catalogs/insurers',
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-api-none-cat',
        },
        { code: 'TURKIYE', name: 'Türkiye Sigorta' },
      );
      const res1 = await testApp.fetch(req1, env());
      expect(res1.status).toBe(403);

      const req2 = mutationRequest(
        'https://panel.mayisigorta.com/api/agency/settings',
        'PATCH',
        {
          Cookie: jwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-api-none-sett',
        },
        { expectedVersion: 1, renewalWindowDays: 60 },
      );
      const res2 = await testApp.fetch(req2, env());
      expect(res2.status).toBe(403);
    });
  });

  describe('Catalogs Lifecycle & Selectable vs Historical Resolution', () => {
    it('selectable lists only ACTIVE items; resolve-by-ID includes INACTIVE items', async () => {
      const ownerJwt = await createSessionCookie(OWNER_SUB, 'owner@test.com');
      const csrf = await getCsrfToken(ownerJwt);

      // Create insurer in Agency A
      const createReq = mutationRequest(
        'https://panel.mayisigorta.com/api/catalogs/insurers',
        'POST',
        {
          Cookie: ownerJwt,
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'idemp-api-ins-life',
        },
        { code: 'MAPFRE', name: 'Mapfre Sigorta' },
      );
      const createRes = await testApp.fetch(createReq, env());
      expect(createRes.status).toBe(201);
      const createdInsurer = asSuccess<InsurerDto>(await createRes.json()).data;
      const insurerId = createdInsurer.id;

      const otherOwnerJwt = await createSessionCookie(OTHER_OWNER_SUB, 'other-owner@test.com');
      const crossAgencyResolve = await testApp.fetch(
        queryRequest(
          `https://panel.mayisigorta.com/api/catalogs/resolve/insurer/${insurerId}`,
          otherOwnerJwt,
        ),
        env(),
      );
      expect(crossAgencyResolve.status).toBe(404);

      // Deactivate it
      const csrfDeact = await getCsrfToken(ownerJwt);
      const deactReq = mutationRequest(
        `https://panel.mayisigorta.com/api/catalogs/insurers/${insurerId}/deactivate`,
        'POST',
        {
          Cookie: ownerJwt,
          'X-CSRF-Token': csrfDeact,
          'Idempotency-Key': 'idemp-api-ins-deact',
        },
        { expectedVersion: createdInsurer.version },
      );
      const deactRes = await testApp.fetch(deactReq, env());
      expect(deactRes.status).toBe(200);

      // Query selectable endpoint
      const selectableReq = queryRequest(
        'https://panel.mayisigorta.com/api/catalogs/selectable',
        ownerJwt,
      );
      const selectableRes = await testApp.fetch(selectableReq, env());
      expect(selectableRes.status).toBe(200);
      const selectableData = asSuccess<SelectableCatalogsDto>(await selectableRes.json()).data;
      // MAPFRE should NOT be in selectable
      const foundInSelectable = selectableData.insurers.find((i) => i.id === insurerId);
      expect(foundInSelectable).toBeUndefined();

      // Resolve by ID: MUST be found and status is INACTIVE
      const resolveReq = queryRequest(
        `https://panel.mayisigorta.com/api/catalogs/resolve/insurer/${insurerId}`,
        ownerJwt,
      );
      const resolveRes = await testApp.fetch(resolveReq, env());
      expect(resolveRes.status).toBe(200);
      const resolvedData = asSuccess<InsurerDto>(await resolveRes.json()).data;
      expect(resolvedData.id).toBe(insurerId);
      expect(resolvedData.code).toBe('MAPFRE');
      expect(resolvedData.status).toBe('INACTIVE');
    });
  });
});
