// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import { mintFixtureSession, fixtureCsrf } from './support/domain-local-session';
import { LOCAL_AUTH_ISSUER, hashSessionToken } from '../src/server/auth/session';
import { verifyIdentityBoundCsrfToken } from '../src/server/security/csrf';
import type {
  ApiResponse,
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  CustomerDto,
  CustomerDetailDto,
  CustomerListResponseData,
  CompanyContactDto,
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

function asError(json: unknown): ApiErrorEnvelope {
  const err = json as ApiErrorEnvelope;
  expect(err.success).toBe(false);
  return err;
}

function mutationRequest(
  url: string,
  method: 'POST' | 'PATCH',
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

describe('M2-T01 Customer & CompanyContact Integration Tests (Miniflare D1)', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  let testApp: ReturnType<typeof createApp>;

  // Agency 1
  const AGENCY_1 = 'ag-m2-01';
  const OWNER_1_USER = 'usr-owner-1';
  const OWNER_1_MEM = 'mem-owner-1';
  const OWNER_1_SUB = 'sub-owner-1';

  const MEMBER_ASSIGNED_USER = 'usr-member-assigned';
  const MEMBER_ASSIGNED_MEM = 'mem-member-assigned';
  const MEMBER_ASSIGNED_SUB = 'sub-member-assigned';

  const MEMBER_AGENCY_USER = 'usr-member-agency';
  const MEMBER_AGENCY_MEM = 'mem-member-agency';
  const MEMBER_AGENCY_SUB = 'sub-member-agency';

  const MEMBER_NOPREV_USER = 'usr-member-noprev';
  const MEMBER_NOPREV_MEM = 'mem-member-noprev';
  const MEMBER_NOPREV_SUB = 'sub-member-noprev';

  // Agency 2
  const AGENCY_2 = 'ag-m2-02';
  const OWNER_2_USER = 'usr-owner-2';
  const OWNER_2_MEM = 'mem-owner-2';
  const OWNER_2_SUB = 'sub-owner-2';

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

    // Use the real archive schema; mutation lifecycle guards depend on it.
    const migrationFiles = [
      'db/migrations/0000_good_hammerhead.sql',
      'db/migrations/0001_chunky_blazing_skull.sql',
      'db/migrations/0002_productive_arclight.sql',
      'db/migrations/0003_lonely_zzzax.sql',
      'db/migrations/0004_thankful_pixie.sql',
      'db/migrations/0005_graceful_northstar.sql',
      'db/migrations/0006_parched_proteus.sql',
      'db/migrations/0007_robust_scalphunter.sql',
      'db/migrations/0008_fearless_giant_girl.sql',
    ];

    for (const file of migrationFiles) {
      const sql = readFileSync(resolve(rootDir, file), 'utf8');
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    testApp = createApp();

    // Seed Data
    async function bootstrapAgencyWithOwner(
      agencyId: string,
      ownerUserId: string,
      ownerMemId: string,
      ownerSub: string,
      ownerEmail: string,
    ) {
      await db
        .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
        .bind(agencyId)
        .run();
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
        .bind(ownerUserId)
        .run();
      await db
        .prepare(
          `
        INSERT INTO agency_memberships (
          id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
        ) VALUES (?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)
      `,
        )
        .bind(ownerMemId, agencyId, ownerUserId, ownerEmail)
        .run();
      await db
        .prepare(
          `
        INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE')
      `,
        )
        .bind(`ident-${ownerUserId}`, ownerUserId, TEST_ISSUER, ownerSub, ownerEmail)
        .run();
      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
        .bind(ownerUserId)
        .run();
      await db
        .prepare(
          `
        UPDATE agency_memberships
        SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
            version = version + 1, permission_version = permission_version + 1
        WHERE id = ?
      `,
        )
        .bind(ownerMemId)
        .run();
      await db
        .prepare(
          `
        UPDATE agencies
        SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
            activated_at = '2026-09-17T00:00:00.000Z', version = version + 1
        WHERE id = ?
      `,
        )
        .bind(agencyId)
        .run();
    }

    async function addMember(
      agencyId: string,
      userId: string,
      memId: string,
      sub: string,
      email: string,
    ) {
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
        .bind(userId)
        .run();
      await db
        .prepare(
          `
        INSERT INTO agency_memberships (
          id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
        ) VALUES (?, ?, ?, 'MEMBER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)
      `,
        )
        .bind(memId, agencyId, userId, email)
        .run();
      await db
        .prepare(
          `
        INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE')
      `,
        )
        .bind(`ident-${userId}`, userId, TEST_ISSUER, sub, email)
        .run();
      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
        .bind(userId)
        .run();
      await db
        .prepare(
          `
        UPDATE agency_memberships
        SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
            version = version + 1, permission_version = permission_version + 1
        WHERE id = ?
      `,
        )
        .bind(memId)
        .run();
    }

    // 1. Agency 1
    await bootstrapAgencyWithOwner(
      AGENCY_1,
      OWNER_1_USER,
      OWNER_1_MEM,
      OWNER_1_SUB,
      'owner1@mayisigorta.test',
    );

    // Member Assigned
    await addMember(
      AGENCY_1,
      MEMBER_ASSIGNED_USER,
      MEMBER_ASSIGNED_MEM,
      MEMBER_ASSIGNED_SUB,
      'member-assigned@mayisigorta.test',
    );
    await db
      .prepare(
        `
      INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
      VALUES ('mp-1', ?, 'customer.read', 'ASSIGNED'),
             ('mp-2', ?, 'customer.create', 'UNSCOPED'),
             ('mp-3', ?, 'customer.update', 'ASSIGNED')
    `,
      )
      .bind(MEMBER_ASSIGNED_MEM, MEMBER_ASSIGNED_MEM, MEMBER_ASSIGNED_MEM)
      .run();

    // Member Agency Scope
    await addMember(
      AGENCY_1,
      MEMBER_AGENCY_USER,
      MEMBER_AGENCY_MEM,
      MEMBER_AGENCY_SUB,
      'member-agency@mayisigorta.test',
    );
    await db
      .prepare(
        `
      INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
      VALUES ('mp-4', ?, 'customer.read', 'AGENCY'),
             ('mp-5', ?, 'customer.create', 'UNSCOPED'),
             ('mp-6', ?, 'customer.update', 'AGENCY')
    `,
      )
      .bind(MEMBER_AGENCY_MEM, MEMBER_AGENCY_MEM, MEMBER_AGENCY_MEM)
      .run();

    // Member No Permissions
    await addMember(
      AGENCY_1,
      MEMBER_NOPREV_USER,
      MEMBER_NOPREV_MEM,
      MEMBER_NOPREV_SUB,
      'member-noprev@mayisigorta.test',
    );

    // 2. Agency 2
    await bootstrapAgencyWithOwner(
      AGENCY_2,
      OWNER_2_USER,
      OWNER_2_MEM,
      OWNER_2_SUB,
      'owner2@otheragency.test',
    );
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  function getEnv(): Env {
    return {
      DB: db,

      CSRF_SECRET,
    };
  }

  async function createSessionCookie(subject: string, email: string): Promise<string> {
    return mintFixtureSession(db, subject, email);
  }

  async function getCsrf(subject: string): Promise<string> {
    return fixtureCsrf(db, subject, CSRF_SECRET);
  }

  // =========================================================================
  // 1. Müşteri Oluşturma (Individual vs Company) & Validasyon
  // =========================================================================
  describe('Customer Creation & Validation', () => {
    it('creates an INDIVIDUAL customer with actor default assignee and computed display_name', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-indiv-01',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Ahmet',
            lastName: 'Yılmaz',
            email: 'ahmet.yilmaz@example.test',
            phone: '+905551112233',
            address: 'Moda Cad. No: 12 Kadıköy İstanbul',
          },
        ),
        getEnv(),
      );

      expect(res.status).toBe(201);
      const json = asSuccess<CustomerDto>(await res.json());
      expect(json.data.type).toBe('INDIVIDUAL');
      expect(json.data.firstName).toBe('Ahmet');
      expect(json.data.lastName).toBe('Yılmaz');
      expect(json.data.displayName).toBe('Ahmet Yılmaz');
      expect(json.data.companyTitle).toBeNull();
      expect(json.data.email).toBe('ahmet.yilmaz@example.test');
      expect(json.data.phone).toBe('+905551112233');
      expect(json.data.address).toBe('Moda Cad. No: 12 Kadıköy İstanbul');
      expect(json.data.assigneeMembershipId).toBe(OWNER_1_MEM);
      expect(json.data.version).toBe(1);
      expect(json.data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('rejects INDIVIDUAL customer with company_title or missing names', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      // Missing firstName
      const res1 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-bad-indiv-1',
          },
          {
            type: 'INDIVIDUAL',
            lastName: 'Yılmaz',
          },
        ),
        getEnv(),
      );
      expect(res1.status).toBe(400);

      // Passing companyTitle on INDIVIDUAL
      const res2 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-bad-indiv-2',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Ahmet',
            lastName: 'Yılmaz',
            companyTitle: 'Yılmazlar A.Ş.',
          },
        ),
        getEnv(),
      );
      expect(res2.status).toBe(400);
      const json2 = asError(await res2.json());
      expect(json2.error.code).toBe('INDIVIDUAL_NAMES_REQUIRED');
    });

    it('creates a COMPANY customer with computed display_name as company_title', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-comp-01',
          },
          {
            type: 'COMPANY',
            companyTitle: 'Mayı Lojistik Ltd. Şti.',
            email: 'info@mayilojistik.test',
            phone: '+902165554433',
            address: 'Ataşehir İstanbul',
          },
        ),
        getEnv(),
      );

      expect(res.status).toBe(201);
      const json = asSuccess<CustomerDto>(await res.json());
      expect(json.data.type).toBe('COMPANY');
      expect(json.data.companyTitle).toBe('Mayı Lojistik Ltd. Şti.');
      expect(json.data.displayName).toBe('Mayı Lojistik Ltd. Şti.');
      expect(json.data.firstName).toBeNull();
      expect(json.data.lastName).toBeNull();
      expect(json.data.address).toBe('Ataşehir İstanbul');
      expect(json.data.version).toBe(1);
    });

    it('rejects COMPANY customer with firstName or missing companyTitle', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-bad-comp-1',
          },
          {
            type: 'COMPANY',
            firstName: 'Ahmet',
            companyTitle: 'Mayı Lojistik Ltd. Şti.',
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(400);
      const json = asError(await res.json());
      expect(json.error.code).toBe('COMPANY_TITLE_REQUIRED');
    });

    it('rejects POST /api/customers if CSRF token is missing or invalid', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');

      // Missing CSRF
      const res1 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'Idempotency-Key': 'ik-csrf-missing',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Can',
            lastName: 'Demir',
          },
        ),
        getEnv(),
      );
      expect(res1.status).toBe(403);
      const json1 = asError(await res1.json());
      expect(json1.error.code).toBe('MISSING_CSRF_TOKEN');

      // Bad CSRF
      const res2 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': 'invalid.csrf.token',
            'Idempotency-Key': 'ik-csrf-invalid',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Can',
            lastName: 'Demir',
          },
        ),
        getEnv(),
      );
      expect(res2.status).toBe(403);
    });
  });

  // =========================================================================
  // 2. Idempotency & Replay
  // =========================================================================
  describe('Idempotency & Replay Behavior', () => {
    it('returns exact replay on duplicate identical request without side effects', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const payload = {
        type: 'INDIVIDUAL' as const,
        firstName: 'Zeynep',
        lastName: 'Kaya',
        email: 'zeynep@example.test',
      };

      const res1 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-replay-01',
          },
          payload,
        ),
        getEnv(),
      );
      expect(res1.status).toBe(201);
      const json1 = asSuccess<CustomerDto>(await res1.json());

      // Duplicate identical call
      const res2 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-replay-01',
          },
          payload,
        ),
        getEnv(),
      );
      expect(res2.status).toBe(201);
      const json2 = asSuccess<CustomerDto>(await res2.json());
      expect(json2.data.id).toBe(json1.data.id);
      expect(json2.data.displayName).toBe(json1.data.displayName);

      // Verify in DB that only 1 row exists
      const rows = await db
        .prepare(
          "SELECT COUNT(*) as count FROM customers WHERE first_name = 'Zeynep' AND last_name = 'Kaya'",
        )
        .all<{ count: number }>();
      expect(rows.results[0]?.count).toBe(1);
    });

    it('returns 409 conflict when idempotency key is reused with different payload', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-replay-01',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Different',
            lastName: 'Person',
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(409);
      const json = asError(await res.json());
      expect(json.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    });
  });

  // =========================================================================
  // 3. Customer Update & Optimistic Concurrency Control
  // =========================================================================
  describe('Customer Update & OCC', () => {
    let customerId: string;

    beforeAll(async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-occ-cust-setup',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Kemal',
            lastName: 'Arslan',
            email: 'kemal@test.test',
          },
        ),
        getEnv(),
      );
      const json = asSuccess<CustomerDto>(await res.json());
      customerId = json.data.id;
    });

    it('successfully updates customer fields and increments version', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${customerId}`,
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-update-01',
          },
          {
            expectedVersion: 1,
            firstName: 'Kemalettin',
            phone: '+905321110099',
            address: 'Çankaya Ankara',
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(200);
      const json = asSuccess<CustomerDto>(await res.json());
      expect(json.data.firstName).toBe('Kemalettin');
      expect(json.data.displayName).toBe('Kemalettin Arslan');
      expect(json.data.phone).toBe('+905321110099');
      expect(json.data.address).toBe('Çankaya Ankara');
      expect(json.data.version).toBe(2);
    });

    it('rejects update with 409 when expectedVersion is stale', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${customerId}`,
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-update-stale',
          },
          {
            expectedVersion: 1, // Current is 2!
            phone: '+905320000000',
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(409);
      const json = asError(await res.json());
      expect(json.error.code).toBe('OPTIMISTIC_CONCURRENCY_CONFLICT');
    });

    it('prohibits changing immutable customer type', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${customerId}`,
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-type-change-attempt',
          },
          {
            expectedVersion: 2,
            type: 'COMPANY',
            companyTitle: 'Hacker Inc',
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(400);
      const json = asError(await res.json());
      expect(json.error.code).toBe('CANNOT_CHANGE_CUSTOMER_TYPE');
    });
  });

  // =========================================================================
  // 4. Listing, Sorting, Pagination & Searching
  // =========================================================================
  describe('Customer Listing & Query Parameters', () => {
    it('lists customers with deterministic cursor pagination and cache-control no-store', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');

      const res = await testApp.fetch(
        queryRequest(
          'https://panel.mayisigorta.com/api/customers?limit=2&sort=created_at&order=asc',
          jwt,
        ),
        getEnv(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');

      const json = asSuccess<CustomerListResponseData>(await res.json());
      expect(json.data.items.length).toBe(2);
      expect(json.data.hasMore).toBe(true);
      expect(typeof json.data.nextCursor).toBe('string');

      // Fetch next page with cursor
      const res2 = await testApp.fetch(
        queryRequest(
          `https://panel.mayisigorta.com/api/customers?limit=2&sort=created_at&order=asc&cursor=${encodeURIComponent(json.data.nextCursor!)}`,
          jwt,
        ),
        getEnv(),
      );
      expect(res2.status).toBe(200);
      const json2 = asSuccess<CustomerListResponseData>(await res2.json());
      expect(json2.data.items.length).toBeGreaterThan(0);
      // Ensure disjoint IDs
      const page1Ids = json.data.items.map((i: CustomerDto) => i.id);
      const page2Ids = json2.data.items.map((i: CustomerDto) => i.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it('filters customers by type and search keyword', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');

      // Filter by type=COMPANY
      const resComp = await testApp.fetch(
        queryRequest('https://panel.mayisigorta.com/api/customers?type=COMPANY', jwt),
        getEnv(),
      );
      expect(resComp.status).toBe(200);
      const jsonComp = asSuccess<CustomerListResponseData>(await resComp.json());
      expect(jsonComp.data.items.every((c: CustomerDto) => c.type === 'COMPANY')).toBe(true);

      // Search by Turkish text 'ahmet'
      const resSearch = await testApp.fetch(
        queryRequest('https://panel.mayisigorta.com/api/customers?search=ahmet', jwt),
        getEnv(),
      );
      expect(resSearch.status).toBe(200);
      const jsonSearch = asSuccess<CustomerListResponseData>(await resSearch.json());
      expect(jsonSearch.data.items.length).toBeGreaterThan(0);
      expect(jsonSearch.data.items[0]?.displayName.toLowerCase()).toContain('ahmet');
    });

    it('rejects invalid sort column or order', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');

      const res1 = await testApp.fetch(
        queryRequest('https://panel.mayisigorta.com/api/customers?sort=secret_column', jwt),
        getEnv(),
      );
      expect(res1.status).toBe(400);

      const res2 = await testApp.fetch(
        queryRequest('https://panel.mayisigorta.com/api/customers?order=sideways', jwt),
        getEnv(),
      );
      expect(res2.status).toBe(400);
    });
  });

  // =========================================================================
  // 5. Şirket Yetkilisi (Company Contact) & Tek Aktif Birincil Kuralı
  // =========================================================================
  describe('Company Contacts & Primary Contact Invariants', () => {
    let companyCustomerId: string;
    let individualCustomerId: string;

    beforeAll(async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      // Setup company customer
      const resComp = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-contact-test-comp',
          },
          {
            type: 'COMPANY',
            companyTitle: 'Atlas Holding A.Ş.',
          },
        ),
        getEnv(),
      );
      const jsonComp = asSuccess<CustomerDto>(await resComp.json());
      companyCustomerId = jsonComp.data.id;

      // Setup individual customer
      const resIndiv = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-contact-test-indiv',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Burak',
            lastName: 'Yıldız',
          },
        ),
        getEnv(),
      );
      const jsonIndiv = asSuccess<CustomerDto>(await resIndiv.json());
      individualCustomerId = jsonIndiv.data.id;
    });

    it('strictly forbids adding a contact to an INDIVIDUAL customer', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${individualCustomerId}/contacts`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-indiv-contact-attempt',
          },
          {
            firstName: 'Ali',
            lastName: 'Veli',
            role: 'Müdür',
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(400);
      const json = asError(await res.json());
      expect(json.error.code).toBe('INDIVIDUAL_CONTACT_PROHIBITED');
    });

    let contact1Id: string;
    let contact2Id: string;

    it('creates first contact on COMPANY customer as primary', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCustomerId}/contacts`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-contact-create-1',
          },
          {
            firstName: 'Selin',
            lastName: 'Öztürk',
            role: 'Finans Direktörü',
            email: 'selin@atlas.test',
            phone: '+905331112233',
            isPrimary: true,
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(201);
      const json = asSuccess<CompanyContactDto>(await res.json());
      expect(json.data.firstName).toBe('Selin');
      expect(json.data.lastName).toBe('Öztürk');
      expect(json.data.role).toBe('Finans Direktörü');
      expect(json.data.isPrimary).toBe(true);
      expect(json.data.status).toBe('ACTIVE');
      expect(json.data.version).toBe(1);
      contact1Id = json.data.id;
    });

    it('replays an exact company-contact create through the API with the original 201 DTO', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);
      const customerResponse = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-exact-contact-replay-customer',
          },
          { type: 'COMPANY', companyTitle: 'Exact Contact Replay Customer' },
        ),
        getEnv(),
      );
      expect(customerResponse.status).toBe(201);
      const replayCustomer = asSuccess<CustomerDto>(await customerResponse.json()).data;
      const payload = {
        firstName: 'Replay',
        lastName: 'Contact',
        role: 'Yetkili',
        email: 'replay.contact@atlas.test',
        isPrimary: false,
      };
      const key = 'ik-company-contact-exact-replay';
      const request = () =>
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${replayCustomer.id}/contacts`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': key,
          },
          payload,
        );

      const firstResponse = await testApp.fetch(request(), getEnv());
      expect(firstResponse.status).toBe(201);
      const first = asSuccess<CompanyContactDto>(await firstResponse.json()).data;

      const replayResponse = await testApp.fetch(request(), getEnv());
      expect(replayResponse.status).toBe(201);
      const replay = asSuccess<CompanyContactDto>(await replayResponse.json()).data;
      expect(replay).toEqual(first);

      expect(
        (
          await db
            .prepare(
              'SELECT count(*) AS count FROM company_contacts WHERE id = ? AND agency_id = ?',
            )
            .bind(first.id, AGENCY_1)
            .first<{ count: number }>()
        )?.count,
      ).toBe(1);
      expect(
        (
          await db
            .prepare(
              "SELECT count(*) AS count FROM audit_events WHERE action = 'company_contact.create' AND idempotency_key = ? AND outcome = 'SUCCESS'",
            )
            .bind(key)
            .first<{ count: number }>()
        )?.count,
      ).toBe(1);
    });

    it('denies an exact contact-create replay after the parent leaves the actor ASSIGNED scope', async () => {
      const ownerJwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const ownerCsrf = await getCsrf(OWNER_1_SUB);
      const memberJwt = await createSessionCookie(
        MEMBER_ASSIGNED_SUB,
        'member-assigned@mayisigorta.test',
      );
      const memberCsrf = await getCsrf(MEMBER_ASSIGNED_SUB);
      const customerResponse = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: ownerJwt,
            'X-CSRF-Token': ownerCsrf,
            'Idempotency-Key': 'ik-contact-reassign-customer-create',
          },
          { type: 'COMPANY', companyTitle: 'Contact Replay Scope Customer' },
        ),
        getEnv(),
      );
      expect(customerResponse.status).toBe(201);
      const customer = asSuccess<CustomerDto>(await customerResponse.json()).data;

      const assignToMember = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${customer.id}/assign`,
          'POST',
          {
            Cookie: ownerJwt,
            'X-CSRF-Token': ownerCsrf,
            'Idempotency-Key': 'ik-contact-reassign-to-member',
          },
          { expectedVersion: 1, assigneeMembershipId: MEMBER_ASSIGNED_MEM },
        ),
        getEnv(),
      );
      expect(assignToMember.status).toBe(200);

      const payload = {
        firstName: 'Scope',
        lastName: 'Evidence',
        role: 'Yetkili',
        isPrimary: false,
      };
      const key = 'ik-company-contact-assigned-replay';
      const contactRequest = () =>
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${customer.id}/contacts`,
          'POST',
          {
            Cookie: memberJwt,
            'X-CSRF-Token': memberCsrf,
            'Idempotency-Key': key,
          },
          payload,
        );
      const firstResponse = await testApp.fetch(contactRequest(), getEnv());
      expect(firstResponse.status).toBe(201);
      const first = asSuccess<CompanyContactDto>(await firstResponse.json()).data;

      const assignAway = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${customer.id}/assign`,
          'POST',
          {
            Cookie: ownerJwt,
            'X-CSRF-Token': ownerCsrf,
            'Idempotency-Key': 'ik-contact-reassign-away',
          },
          { expectedVersion: 2, assigneeMembershipId: OWNER_1_MEM },
        ),
        getEnv(),
      );
      expect(assignAway.status).toBe(200);

      const replayResponse = await testApp.fetch(contactRequest(), getEnv());
      expect(replayResponse.status).toBe(404);
      const replayError = asError(await replayResponse.json());
      expect(replayError.error.code).toBe('NOT_FOUND');
      expect(replayError.error.message).toBe('Kayıt bulunamadı.');
      expect(JSON.stringify(replayError)).not.toContain(first.id);
      expect(JSON.stringify(replayError)).not.toContain(first.firstName);
      expect(
        (
          await db
            .prepare('SELECT count(*) AS count FROM company_contacts WHERE customer_id = ?')
            .bind(customer.id)
            .first<{ count: number }>()
        )?.count,
      ).toBe(1);
      expect(
        (
          await db
            .prepare(
              "SELECT count(*) AS count FROM audit_events WHERE action = 'company_contact.create' AND idempotency_key = ? AND outcome = 'SUCCESS'",
            )
            .bind(key)
            .first<{ count: number }>()
        )?.count,
      ).toBe(1);
    });

    it('replays an exact contact-create request for a MEMBER with current AGENCY authority', async () => {
      const ownerJwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const ownerCsrf = await getCsrf(OWNER_1_SUB);
      const customerResponse = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: ownerJwt,
            'X-CSRF-Token': ownerCsrf,
            'Idempotency-Key': 'ik-agency-contact-replay-customer',
          },
          { type: 'COMPANY', companyTitle: 'Agency Contact Replay Customer' },
        ),
        getEnv(),
      );
      expect(customerResponse.status).toBe(201);
      const replayCustomer = asSuccess<CustomerDto>(await customerResponse.json()).data;
      const jwt = await createSessionCookie(MEMBER_AGENCY_SUB, 'member-agency@mayisigorta.test');
      const csrf = await getCsrf(MEMBER_AGENCY_SUB);
      const payload = {
        firstName: 'Agency',
        lastName: 'Replay',
        role: 'Yetkili',
        isPrimary: false,
      };
      const key = 'ik-company-contact-agency-replay';
      const request = () =>
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${replayCustomer.id}/contacts`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': key,
          },
          payload,
        );

      const firstResponse = await testApp.fetch(request(), getEnv());
      expect(firstResponse.status).toBe(201);
      const first = asSuccess<CompanyContactDto>(await firstResponse.json()).data;
      const replayResponse = await testApp.fetch(request(), getEnv());
      expect(replayResponse.status).toBe(201);
      expect(asSuccess<CompanyContactDto>(await replayResponse.json()).data).toEqual(first);
      expect(
        (
          await db
            .prepare('SELECT count(*) AS count FROM company_contacts WHERE id = ?')
            .bind(first.id)
            .first<{ count: number }>()
        )?.count,
      ).toBe(1);
    });

    it('creates second contact as primary and automatically demotes first contact', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCustomerId}/contacts`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-contact-create-2',
          },
          {
            firstName: 'Mert',
            lastName: 'Koç',
            role: 'Genel Müdür',
            email: 'mert@atlas.test',
            isPrimary: true,
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(201);
      const json = asSuccess<CompanyContactDto>(await res.json());
      expect(json.data.firstName).toBe('Mert');
      expect(json.data.isPrimary).toBe(true);
      contact2Id = json.data.id;

      // Check customer detail to verify contact 1 was demoted to isPrimary: false
      const detailRes = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${companyCustomerId}`, jwt),
        getEnv(),
      );
      expect(detailRes.status).toBe(200);
      const detailJson = asSuccess<CustomerDetailDto>(await detailRes.json());
      const contacts = detailJson.data.contacts ?? [];
      expect(contacts).toHaveLength(2);

      const c1 = contacts.find((c: CompanyContactDto) => c.id === contact1Id);
      const c2 = contacts.find((c: CompanyContactDto) => c.id === contact2Id);
      expect(c1?.isPrimary).toBe(false);
      expect(c2?.isPrimary).toBe(true);
    });

    it('sets first contact back to primary via set-primary endpoint', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      // Contact 1 was updated during demotion, let's fetch its current version
      const detailRes = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${companyCustomerId}`, jwt),
        getEnv(),
      );
      const detailJson = asSuccess<CustomerDetailDto>(await detailRes.json());
      const c1Current = (detailJson.data.contacts ?? []).find(
        (c: CompanyContactDto) => c.id === contact1Id,
      )!;

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCustomerId}/contacts/${contact1Id}/set-primary`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-set-primary-1',
          },
          {
            expectedVersion: c1Current.version,
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(200);
      const json = asSuccess<CompanyContactDto>(await res.json());
      expect(json.data.isPrimary).toBe(true);

      // Verify contact 2 is now not primary
      const verifyRes = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${companyCustomerId}`, jwt),
        getEnv(),
      );
      const verifyJson = asSuccess<CustomerDetailDto>(await verifyRes.json());
      const c2 = (verifyJson.data.contacts ?? []).find(
        (c: CompanyContactDto) => c.id === contact2Id,
      );
      expect(c2?.isPrimary).toBe(false);
    });

    it('updates contact details and blocks lifecycle fields via PATCH', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      // Fetch contact 2
      const detailRes = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${companyCustomerId}`, jwt),
        getEnv(),
      );
      const detailJson = asSuccess<CustomerDetailDto>(await detailRes.json());
      const c2Current = (detailJson.data.contacts ?? []).find(
        (c: CompanyContactDto) => c.id === contact2Id,
      )!;

      // 1. Valid update
      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCustomerId}/contacts/${contact2Id}`,
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-contact-update-2',
          },
          {
            expectedVersion: c2Current.version,
            role: 'Yönetim Kurulu Başkanı',
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(200);
      const json = asSuccess<CompanyContactDto>(await res.json());
      expect(json.data.role).toBe('Yönetim Kurulu Başkanı');
      expect(json.data.version).toBe(c2Current.version + 1);

      // 2. Attempting status mutation via generic PATCH is blocked
      const resBlocked = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCustomerId}/contacts/${contact2Id}`,
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-contact-patch-lifecycle',
          },
          {
            expectedVersion: json.data.version,
            status: 'INACTIVE',
          },
        ),
        getEnv(),
      );
      expect(resBlocked.status).toBe(400);
      const jsonBlocked = asError(await resBlocked.json());
      expect(jsonBlocked.error.code).toBe('LIFECYCLE_MUTATION_VIA_PATCH_PROHIBITED');
    });

    it('deactivates contact and removes primary flag if was primary', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrf = await getCsrf(OWNER_1_SUB);

      // Contact 1 is currently primary
      const detailRes = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${companyCustomerId}`, jwt),
        getEnv(),
      );
      const detailJson = asSuccess<CustomerDetailDto>(await detailRes.json());
      const c1Current = (detailJson.data.contacts ?? []).find(
        (c: CompanyContactDto) => c.id === contact1Id,
      )!;
      expect(c1Current.isPrimary).toBe(true);

      const res = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCustomerId}/contacts/${contact1Id}/deactivate`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-deactivate-1',
          },
          {
            expectedVersion: c1Current.version,
          },
        ),
        getEnv(),
      );
      expect(res.status).toBe(200);
      const json = asSuccess<CompanyContactDto>(await res.json());
      expect(json.data.status).toBe('INACTIVE');
      expect(json.data.isPrimary).toBe(false);

      // Deactivating again should fail
      const resAgain = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${companyCustomerId}/contacts/${contact1Id}/deactivate`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-deactivate-1-again',
          },
          {
            expectedVersion: json.data.version,
          },
        ),
        getEnv(),
      );
      expect(resAgain.status).toBe(400);
      const jsonAgain = asError(await resAgain.json());
      expect(jsonAgain.error.code).toBe('CONTACT_ALREADY_INACTIVE');
    });
  });

  // =========================================================================
  // 6. Yetkilendirme Kapsamı (ASSIGNED vs AGENCY vs İzin Yok) & İzolasyon
  // =========================================================================
  describe('Authorization Scopes & Agency Boundary Isolation', () => {
    let assignedCustId: string;
    let otherCustId: string;

    beforeAll(async () => {
      // 1. Create a customer assigned to MEMBER_ASSIGNED_MEM
      const jwtAssigned = await createSessionCookie(
        MEMBER_ASSIGNED_SUB,
        'member-assigned@mayisigorta.test',
      );
      const csrfAssigned = await getCsrf(MEMBER_ASSIGNED_SUB);

      const res1 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwtAssigned,
            'X-CSRF-Token': csrfAssigned,
            'Idempotency-Key': 'ik-scope-cust-1',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'Assigned',
            lastName: 'Customer',
          },
        ),
        getEnv(),
      );
      const json1 = asSuccess<CustomerDto>(await res1.json());
      assignedCustId = json1.data.id;
      expect(json1.data.assigneeMembershipId).toBe(MEMBER_ASSIGNED_MEM);

      // 2. Create a customer assigned to OWNER
      const jwtOwner = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrfOwner = await getCsrf(OWNER_1_SUB);

      const res2 = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwtOwner,
            'X-CSRF-Token': csrfOwner,
            'Idempotency-Key': 'ik-scope-cust-2',
          },
          {
            type: 'INDIVIDUAL',
            firstName: 'OwnerOnly',
            lastName: 'Customer',
          },
        ),
        getEnv(),
      );
      const json2 = asSuccess<CustomerDto>(await res2.json());
      otherCustId = json2.data.id;
    });

    it('member with NO permissions receives 403 Forbidden', async () => {
      const jwt = await createSessionCookie(MEMBER_NOPREV_SUB, 'member-noprev@mayisigorta.test');

      const res = await testApp.fetch(
        queryRequest('https://panel.mayisigorta.com/api/customers', jwt),
        getEnv(),
      );
      expect(res.status).toBe(403);
    });

    it('member with ASSIGNED scope can access own customer but receives 404 for unassigned customer', async () => {
      const jwt = await createSessionCookie(
        MEMBER_ASSIGNED_SUB,
        'member-assigned@mayisigorta.test',
      );
      const csrf = await getCsrf(MEMBER_ASSIGNED_SUB);

      // 1. Can read assigned customer
      const resReadOwn = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${assignedCustId}`, jwt),
        getEnv(),
      );
      expect(resReadOwn.status).toBe(200);

      // 2. Cannot read other customer -> 404 non-disclosure
      const resReadOther = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${otherCustId}`, jwt),
        getEnv(),
      );
      expect(resReadOther.status).toBe(404);

      // 3. Cannot update other customer -> 404 non-disclosure
      const resUpdateOther = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${otherCustId}`,
          'PATCH',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-unauth-patch',
          },
          {
            expectedVersion: 1,
            firstName: 'HackedName',
          },
        ),
        getEnv(),
      );
      expect(resUpdateOther.status).toBe(404);

      // 4. List endpoint only returns customers assigned to them
      const resList = await testApp.fetch(
        queryRequest('https://panel.mayisigorta.com/api/customers', jwt),
        getEnv(),
      );
      expect(resList.status).toBe(200);
      const jsonList = asSuccess<CustomerListResponseData>(await resList.json());
      expect(
        jsonList.data.items.every(
          (c: CustomerDto) => c.assigneeMembershipId === MEMBER_ASSIGNED_MEM,
        ),
      ).toBe(true);
    });

    it('member with AGENCY scope can read and update any customer in the agency', async () => {
      const jwt = await createSessionCookie(MEMBER_AGENCY_SUB, 'member-agency@mayisigorta.test');

      const res1 = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${assignedCustId}`, jwt),
        getEnv(),
      );
      expect(res1.status).toBe(200);

      const res2 = await testApp.fetch(
        queryRequest(`https://panel.mayisigorta.com/api/customers/${otherCustId}`, jwt),
        getEnv(),
      );
      expect(res2.status).toBe(200);
    });

    it('cross-agency actor strictly receives 404 non-disclosure when accessing another agency customer', async () => {
      const jwtOtherAgency = await createSessionCookie(OWNER_2_SUB, 'owner2@otheragency.test');
      const csrfOtherAgency = await getCsrf(OWNER_2_SUB);

      // Read Agency 1's customer from Agency 2 actor
      const resRead = await testApp.fetch(
        queryRequest(
          `https://panel.mayisigorta.com/api/customers/${assignedCustId}`,
          jwtOtherAgency,
        ),
        getEnv(),
      );
      expect(resRead.status).toBe(404);

      // Update Agency 1's customer from Agency 2 actor
      const resUpdate = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${assignedCustId}`,
          'PATCH',
          {
            Cookie: jwtOtherAgency,
            'X-CSRF-Token': csrfOtherAgency,
            'Idempotency-Key': 'ik-cross-agency-patch',
          },
          {
            expectedVersion: 1,
            firstName: 'CrossAgency',
          },
        ),
        getEnv(),
      );
      expect(resUpdate.status).toBe(404);

      // List from Agency 2 never returns Agency 1 customers
      const resList = await testApp.fetch(
        queryRequest('https://panel.mayisigorta.com/api/customers', jwtOtherAgency),
        getEnv(),
      );
      expect(resList.status).toBe(200);
      const jsonList = asSuccess<CustomerListResponseData>(await resList.json());
      expect(jsonList.data.items.every((c: CustomerDto) => c.agencyId === AGENCY_2)).toBe(true);
    });

    it('non-disclosure: unassigned member attempting contact operations on other customer receives 404, never leaking type or lifecycle state', async () => {
      const jwt = await createSessionCookie(
        MEMBER_ASSIGNED_SUB,
        'member-assigned@mayisigorta.test',
      );
      const csrf = await getCsrf(MEMBER_ASSIGNED_SUB);

      // otherCustId is an INDIVIDUAL customer owned by OWNER_1_MEM.
      // If authorization didn't precede domain validation, actor would get 400 (INDIVIDUAL_CONTACT_PROHIBITED)
      // and learn that otherCustId is an INDIVIDUAL customer!
      // With proper non-disclosure order, actor gets strict 404:
      const resAddContact = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${otherCustId}/contacts`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-nd-add-contact',
          },
          {
            firstName: 'Leak',
            lastName: 'Probe',
          },
        ),
        getEnv(),
      );
      expect(resAddContact.status).toBe(404);

      // Lifecycle probe on contact of another customer -> strict 404
      const resSetPrimary = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${otherCustId}/contacts/fake-contact-id/set-primary`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-nd-set-primary',
          },
          {
            expectedVersion: 1,
          },
        ),
        getEnv(),
      );
      expect(resSetPrimary.status).toBe(404);

      const resDeactivate = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${otherCustId}/contacts/fake-contact-id/deactivate`,
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'ik-nd-deact',
          },
          {
            expectedVersion: 1,
          },
        ),
        getEnv(),
      );
      expect(resDeactivate.status).toBe(404);
    });

    it('strict schema: rejects mass-assignment and unexpected parameters with 400 VALIDATION_ERROR', async () => {
      const jwtOwner = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');
      const csrfOwner = await getCsrf(OWNER_1_SUB);

      // 1. Attempt mass-assignment with forbidden fields on create
      const forbiddenFields = [
        { action: 'customer.override' },
        { authority: 'OWNER_ONLY' },
        { assurance: 'SECURE' },
        { agencyId: 'ag-hacked' },
        { assigneeMembershipId: 'mem-hacked' },
        { permission: 'all' },
        { requiredPermission: 'none' },
        { version: 99 },
        { audit: { fake: true } },
        { timestamp: '2026-01-01' },
      ];

      for (const forbidden of forbiddenFields) {
        const res = await testApp.fetch(
          mutationRequest(
            'https://panel.mayisigorta.com/api/customers',
            'POST',
            {
              Cookie: jwtOwner,
              'X-CSRF-Token': csrfOwner,
              'Idempotency-Key': `ik-mass-create-${Object.keys(forbidden)[0]}`,
            },
            {
              type: 'INDIVIDUAL',
              firstName: 'Strict',
              lastName: 'Tester',
              ...forbidden,
            },
          ),
          getEnv(),
        );
        expect(res.status).toBe(400);
        const json = asError(await res.json());
        expect(json.error.code).toBe('VALIDATION_ERROR');
      }

      // 2. Reject 'version' alias on update; require exact 'expectedVersion'
      const resOldVersion = await testApp.fetch(
        mutationRequest(
          `https://panel.mayisigorta.com/api/customers/${assignedCustId}`,
          'PATCH',
          {
            Cookie: jwtOwner,
            'X-CSRF-Token': csrfOwner,
            'Idempotency-Key': 'ik-strict-version-alias',
          },
          {
            version: 1, // forbidden alias
            firstName: 'AttemptAlias',
          },
        ),
        getEnv(),
      );
      expect(resOldVersion.status).toBe(400);
      const jsonAlias = asError(await resOldVersion.json());
      expect(jsonAlias.error.code).toBe('VALIDATION_ERROR');
    });

    it('cursor validation: fail-closed on malformed cursor or sort/order mismatch (produces 400)', async () => {
      const jwtOwner = await createSessionCookie(OWNER_1_SUB, 'owner1@mayisigorta.test');

      // 1. Malformed base64 cursor -> 400 VALIDATION_ERROR
      const resMalformed = await testApp.fetch(
        queryRequest(
          'https://panel.mayisigorta.com/api/customers?cursor=not-a-valid-base64-json-cursor',
          jwtOwner,
        ),
        getEnv(),
      );
      expect(resMalformed.status).toBe(400);
      const jsonMalformed = asError(await resMalformed.json());
      expect(jsonMalformed.error.code).toBe('VALIDATION_ERROR');

      // 2. Valid cursor generated for sort='createdAt' used under sort='displayName' -> 400 VALIDATION_ERROR
      const resFirstPage = await testApp.fetch(
        queryRequest(
          'https://panel.mayisigorta.com/api/customers?limit=1&sort=createdAt&order=desc',
          jwtOwner,
        ),
        getEnv(),
      );
      const jsonFirst = asSuccess<CustomerListResponseData>(await resFirstPage.json());
      expect(jsonFirst.data.nextCursor).toBeTruthy();
      const validCursor = jsonFirst.data.nextCursor!;

      const resMismatched = await testApp.fetch(
        queryRequest(
          `https://panel.mayisigorta.com/api/customers?cursor=${validCursor}&sort=displayName&order=asc`,
          jwtOwner,
        ),
        getEnv(),
      );
      expect(resMismatched.status).toBe(400);
      const jsonMismatched = asError(await resMismatched.json());
      expect(jsonMismatched.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // =========================================================================
  // 7. Veritabanı Tetikleyici (Trigger) ve Kural Bütünlüğü Testleri
  // =========================================================================
  describe('Database Triggers & Invariant Integrity', () => {
    it('trigger raises CROSS_AGENCY_ASSIGNEE_PROHIBITED on cross-agency assignee', async () => {
      // Trying to insert a customer for AGENCY_1 with assignee from AGENCY_2 (OWNER_2_MEM)
      await expect(
        db
          .prepare(
            `
          INSERT INTO customers (id, agency_id, type, first_name, last_name, display_name, assignee_membership_id)
          VALUES ('cust-cross-mem', ?, 'INDIVIDUAL', 'Test', 'Cross', 'Test Cross', ?)
        `,
          )
          .bind(AGENCY_1, OWNER_2_MEM)
          .run(),
      ).rejects.toThrow(/CROSS_AGENCY_ASSIGNEE_PROHIBITED/);
    });

    it('trigger raises INDIVIDUAL_CONTACT_PROHIBITED on direct SQL insert of contact to individual', async () => {
      // Create individual customer
      await db
        .prepare(
          `
        INSERT INTO customers (id, agency_id, type, first_name, last_name, display_name, assignee_membership_id)
        VALUES ('cust-indiv-trig', ?, 'INDIVIDUAL', 'Trigger', 'Indiv', 'Trigger Indiv', ?)
      `,
        )
        .bind(AGENCY_1, OWNER_1_MEM)
        .run();

      await expect(
        db
          .prepare(
            `
          INSERT INTO company_contacts (id, agency_id, customer_id, first_name, last_name)
          VALUES ('cnt-indiv-trig', ?, 'cust-indiv-trig', 'Ahmet', 'Trigger')
        `,
          )
          .bind(AGENCY_1)
          .run(),
      ).rejects.toThrow(/INDIVIDUAL_CONTACT_PROHIBITED/);
    });

    it('trigger raises CROSS_AGENCY_PARENT_PROHIBITED on cross-agency company contact', async () => {
      // Create company in agency 2
      await db
        .prepare(
          `
        INSERT INTO customers (id, agency_id, type, company_title, display_name, assignee_membership_id)
        VALUES ('comp-ag2-trig', ?, 'COMPANY', 'Agency 2 Co', 'Agency 2 Co', ?)
      `,
        )
        .bind(AGENCY_2, OWNER_2_MEM)
        .run();

      // Attempt to insert contact in agency 1 pointing to agency 2 company
      await expect(
        db
          .prepare(
            `
          INSERT INTO company_contacts (id, agency_id, customer_id, first_name, last_name)
          VALUES ('cnt-cross-ag', ?, 'comp-ag2-trig', 'Ali', 'Cross')
        `,
          )
          .bind(AGENCY_1)
          .run(),
      ).rejects.toThrow(/CROSS_AGENCY_PARENT_PROHIBITED/);
    });

    it('trigger raises MULTIPLE_ACTIVE_PRIMARY_CONTACTS_PROHIBITED on direct SQL insert of duplicate active primary', async () => {
      // Create company
      await db
        .prepare(
          `
        INSERT INTO customers (id, agency_id, type, company_title, display_name, assignee_membership_id)
        VALUES ('comp-dup-prim', ?, 'COMPANY', 'Duplicate Primary Co', 'Duplicate Primary Co', ?)
      `,
        )
        .bind(AGENCY_1, OWNER_1_MEM)
        .run();

      // Insert first active primary
      await db
        .prepare(
          `
        INSERT INTO company_contacts (id, agency_id, customer_id, first_name, last_name, is_primary, status)
        VALUES ('cnt-prim-1', ?, 'comp-dup-prim', 'Primary', 'One', 1, 'ACTIVE')
      `,
        )
        .bind(AGENCY_1)
        .run();

      // Attempt direct insert of second active primary -> trigger aborts
      await expect(
        db
          .prepare(
            `
          INSERT INTO company_contacts (id, agency_id, customer_id, first_name, last_name, is_primary, status)
          VALUES ('cnt-prim-2', ?, 'comp-dup-prim', 'Primary', 'Two', 1, 'ACTIVE')
        `,
          )
          .bind(AGENCY_1)
          .run(),
      ).rejects.toThrow(/MULTIPLE_ACTIVE_PRIMARY_CONTACTS_PROHIBITED/);
    });
  });

  // =========================================================================
  // 8. Audit Log & Operation Receipt Denetimi
  // =========================================================================
  describe('Audit Logging & Receipts Sanitization', () => {
    it('verifies operation receipts and sanitized audit events are created without PII leak', async () => {
      const receipts = await db
        .prepare(
          'SELECT * FROM operation_receipts WHERE agency_id = ? ORDER BY created_at DESC LIMIT 5',
        )
        .bind(AGENCY_1)
        .all<{ id: string; action: string; payload_fingerprint: string }>();

      expect(receipts.results.length).toBeGreaterThan(0);
      for (const r of receipts.results) {
        expect(r.payload_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }

      const audits = await db
        .prepare('SELECT * FROM audit_events WHERE agency_id = ? ORDER BY created_at DESC LIMIT 10')
        .bind(AGENCY_1)
        .all<{ id: string; action: string; metadata_json: string }>();

      expect(audits.results.length).toBeGreaterThan(0);
      for (const a of audits.results) {
        const meta = JSON.parse(a.metadata_json);
        // Ensure no PII fields leaked into audit metadata
        expect(meta).not.toHaveProperty('firstName');
        expect(meta).not.toHaveProperty('lastName');
        expect(meta).not.toHaveProperty('email');
        expect(meta).not.toHaveProperty('phone');
        expect(meta).not.toHaveProperty('address');
        expect(meta).not.toHaveProperty('companyTitle');
      }
    });
  });

  // =========================================================================
  // 9. CSRF Issuance, Identity Binding & Production Verifier Integration Tests
  // =========================================================================
  describe('CSRF Issuance & Verification End-to-End', () => {
    it('CSRF issuance without CSRF_SECRET fails closed', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@test.com');
      const { CSRF_SECRET: _omitted, ...envWithoutCsrfSecret } = getEnv();
      const res = await testApp.fetch(
        new Request('https://panel.mayisigorta.com/api/csrf-token', {
          method: 'GET',
          headers: {
            Origin: TRUSTED_ORIGIN,
            Cookie: jwt,
          },
        }),
        envWithoutCsrfSecret,
      );

      expect(res.status).toBe(503);
      const body = asError(await res.json());
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(body)).not.toContain(CSRF_SECRET);
    });

    it('protected mutation without CSRF_SECRET fails before business effect', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@test.com');
      const csrf = await getCsrf(OWNER_1_SUB);
      const customerIdempotencyKey = 'ik-missing-csrf-config-no-effect';
      const { CSRF_SECRET: _omitted, ...envWithoutCsrfSecret } = getEnv();

      const res = await testApp.fetch(
        mutationRequest(
          'https://panel.mayisigorta.com/api/customers',
          'POST',
          {
            Cookie: jwt,
            'X-CSRF-Token': csrf,
            'Idempotency-Key': customerIdempotencyKey,
          },
          { type: 'INDIVIDUAL', firstName: 'No', lastName: 'Secret' },
        ),
        envWithoutCsrfSecret,
      );

      expect(res.status).toBe(503);
      const body = asError(await res.json());
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');

      const customer = await db
        .prepare("SELECT id FROM customers WHERE display_name = 'No Secret'")
        .first();
      expect(customer).toBeNull();
      const receipt = await db
        .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
        .bind(customerIdempotencyKey)
        .first();
      expect(receipt).toBeNull();
    });

    // 1. Authenticated same-origin issuance produces valid token
    it('authenticated same-origin GET /api/csrf-token issues valid token bound to subject', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@test.com');
      const req = new Request('https://panel.mayisigorta.com/api/csrf-token', {
        method: 'GET',
        headers: {
          Origin: TRUSTED_ORIGIN,
          Cookie: jwt,
        },
      });

      const res = await testApp.fetch(req, getEnv());
      expect(res.status).toBe(200);

      // Verify no-store / private headers
      const cacheControl = res.headers.get('cache-control');
      const cacheDirectives = new Set(
        (cacheControl ?? '')
          .split(',')
          .map((directive) => directive.trim().toLowerCase())
          .filter(Boolean),
      );
      expect(cacheDirectives.has('no-store')).toBe(true);
      expect(cacheDirectives.has('private')).toBe(true);

      const body = (await res.json()) as ApiResponse<{ token: string }>;
      expect(body.success).toBe(true);
      const token = asSuccess(body).data.token;
      expect(typeof token).toBe('string');
      expect(token).toContain('.');

      // Secret or key must NOT be leaked in response
      expect(body).not.toHaveProperty('secret');
      expect(body).not.toHaveProperty('key');
      expect(asSuccess(body).data).not.toHaveProperty('secret');
      expect(asSuccess(body).data).not.toHaveProperty('key');

      // Validate with production verifier
      const verification = await verifyIdentityBoundCsrfToken(
        token,
        `${OWNER_1_SUB}:${await hashSessionToken(jwt.split('=')[1]!)}`,
        CSRF_SECRET,
      );
      expect(verification.valid).toBe(true);
      if (verification.valid) {
        expect(verification.subject).toBe(
          `${OWNER_1_SUB}:${await hashSessionToken(jwt.split('=')[1]!)}`,
        );
      }

      // Cannot be used by another identity/subject
      const mismatch = await verifyIdentityBoundCsrfToken(token, 'different-sub', CSRF_SECRET);
      expect(mismatch.valid).toBe(false);
      if (!mismatch.valid) {
        expect(mismatch.code).toBe('SUBJECT_MISMATCH');
      }
    });

    // 2. Unauthenticated request to /api/csrf-token is denied with 401
    it('unauthenticated GET /api/csrf-token is denied with 401', async () => {
      const req = new Request('https://panel.mayisigorta.com/api/csrf-token', {
        method: 'GET',
        headers: {
          Origin: TRUSTED_ORIGIN,
        },
      });

      const res = await testApp.fetch(req, getEnv());
      expect(res.status).toBe(401);
      const body = asError(await res.json());
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    // 3. Hostile origin / cross-site request to /api/csrf-token is denied with 403
    it('hostile origin to GET /api/csrf-token is denied with 403 by security boundary', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@test.com');
      const req = new Request('https://panel.mayisigorta.com/api/csrf-token', {
        method: 'GET',
        headers: {
          Origin: 'https://evil.attacker.com',
          Cookie: jwt,
        },
      });

      const res = await testApp.fetch(req, getEnv());
      expect(res.status).toBe(403);
    });

    // 4. Client cannot select subject via query or headers
    it('client query or body params cannot override verified subject binding', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@test.com');
      const req = new Request(
        'https://panel.mayisigorta.com/api/csrf-token?sub=attacker-chosen-sub',
        {
          method: 'GET',
          headers: {
            Origin: TRUSTED_ORIGIN,
            Cookie: jwt,
            'X-Subject': 'attacker-chosen-sub',
          },
        },
      );

      const res = await testApp.fetch(req, getEnv());
      expect(res.status).toBe(200);
      const body = asSuccess((await res.json()) as ApiResponse<{ token: string }>);

      // Token must still be strictly bound to OWNER_1_SUB, NOT attacker-chosen-sub
      const verifyReal = await verifyIdentityBoundCsrfToken(
        body.data.token,
        `${OWNER_1_SUB}:${await hashSessionToken(jwt.split('=')[1]!)}`,
        CSRF_SECRET,
      );
      expect(verifyReal.valid).toBe(true);

      const verifyAttacker = await verifyIdentityBoundCsrfToken(
        body.data.token,
        'attacker-chosen-sub',
        CSRF_SECRET,
      );
      expect(verifyAttacker.valid).toBe(false);
    });

    // 5. Full Real Flow: Auth -> GET /api/csrf-token -> Create Customer -> Add Contact (Both succeed with issued token)
    it('full flow: auth -> issue CSRF token -> CSRF-protected Customer create & CompanyContact mutation succeed', async () => {
      const jwt = await createSessionCookie(OWNER_1_SUB, 'owner1@test.com');

      // Step A: Issue CSRF token
      const tokenReq = new Request('https://panel.mayisigorta.com/api/csrf-token', {
        method: 'GET',
        headers: {
          Origin: TRUSTED_ORIGIN,
          Cookie: jwt,
        },
      });
      const tokenRes = await testApp.fetch(tokenReq, getEnv());
      expect(tokenRes.status).toBe(200);
      const tokenBody = asSuccess((await tokenRes.json()) as ApiResponse<{ token: string }>);
      const issuedToken = tokenBody.data.token;

      // Step B: Create Customer using issued token
      const createCustReq = mutationRequest(
        'https://panel.mayisigorta.com/api/customers',
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': issuedToken,
          'Idempotency-Key': 'ik-csrf-flow-cust-create',
        },
        {
          type: 'COMPANY',
          companyTitle: 'Real CSRF Flow Ltd',
          email: 'csrf@flow.test',
        },
      );
      const custRes = await testApp.fetch(createCustReq, getEnv());
      expect(custRes.status).toBe(201);
      const custData = asSuccess((await custRes.json()) as ApiResponse<CustomerDto>).data;
      expect(custData.companyTitle).toBe('Real CSRF Flow Ltd');

      // Step C: Create Company Contact using same issued token
      const createContactReq = mutationRequest(
        `https://panel.mayisigorta.com/api/customers/${custData.id}/contacts`,
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': issuedToken,
          'Idempotency-Key': 'ik-csrf-flow-cnt-create',
        },
        {
          firstName: 'Yetkili',
          lastName: 'Müdür',
          isPrimary: true,
        },
      );
      const contactRes = await testApp.fetch(createContactReq, getEnv());
      expect(contactRes.status).toBe(201);
      const contactData = asSuccess(
        (await contactRes.json()) as ApiResponse<CompanyContactDto>,
      ).data;
      expect(contactData.firstName).toBe('Yetkili');
      expect(contactData.isPrimary).toBe(true);

      // Step D: Mutate contact with tampered/forged token fails with 403
      const badTokenReq = mutationRequest(
        `https://panel.mayisigorta.com/api/customers/${custData.id}/contacts`,
        'POST',
        {
          Cookie: jwt,
          'X-CSRF-Token': 'forged.token',
          'Idempotency-Key': 'ik-csrf-flow-bad-token',
        },
        {
          firstName: 'Hacker',
          lastName: 'Contact',
        },
      );
      const badRes = await testApp.fetch(badTokenReq, getEnv());
      expect(badRes.status).toBe(403);
    });
  });
});
