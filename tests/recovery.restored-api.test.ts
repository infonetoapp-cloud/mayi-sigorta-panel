// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import {
  createSyntheticAuthBackup,
  type AuthBackupArtifact,
} from '../scripts/recovery/local-auth-restore-proof';
import { orderedD1Import } from '../scripts/recovery/ordered-d1-import';
import { queryRestorePlan } from '../scripts/recovery/query-restore-plan';
import { runQueryRecovery } from '../scripts/recovery/query-phase-executor';
import { currentAuthorityImportSql } from '../scripts/recovery/provider-runner';
import { canonical, sha256, type CurrentAuthority } from '../scripts/recovery/executor-bundle';
import { openLocalKdfAdapter } from './support/local-kdf-runtime';
import { testRateLimit } from './support/local-auth-fixture';

const agency = 'synthetic-auth-agency';
const actors = ['temporary', 'permanent', 'offboard', 'revoked'] as const;
const password = 'synthetic local recovery passphrase ' + crypto.randomUUID();
const cookies: Record<string, string> = {};
const beforeCookies: Record<string, string> = {};
const app = createApp(); // Default production auth/route composition, no session/evaluator bypass.
let kdf: Awaited<ReturnType<typeof openLocalKdfAdapter>>;
let source: Awaited<ReturnType<typeof createSyntheticAuthBackup>>;
let runtime: InstanceType<typeof miniflare.Miniflare>;
let db: D1Database;
let artifact: AuthBackupArtifact;
let authority: CurrentAuthority;
let journal: string;
const writes: string[] = [];
const immutable = new Map<string, string>();
function environment(database: D1Database): Env {
  return {
    DB: database,
    APP_ENV: 'test',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    CSRF_SECRET: 'synthetic-local-restored-api-only',
    DOCUMENTS_ENABLED: 'false',
    AUTH_ACCOUNT_RATE_LIMITER: testRateLimit(1000),
    AUTH_SOURCE_RATE_LIMITER: testRateLimit(1000),
    PASSWORD_KDF: { getByName: () => kdf.hasher } as unknown as Env['PASSWORD_KDF'],
  };
}
let env: Env;
async function request(path: string, cookie?: string, body?: unknown, target = env) {
  return app.fetch(
    new Request('https://panel.mayisigorta.com' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined
          ? {}
          : {
              origin: 'https://panel.mayisigorta.com',
              'content-type': 'application/json',
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    target,
  );
}
async function login(id: string, target = env) {
  return request(
    '/api/auth/login',
    undefined,
    { email: `${id}@example.invalid`, password },
    target,
  );
}
async function successfulLogin(id: string, target = env) {
  const response = await login(id, target);
  expect(response.status, `login ${id}`).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  expect(Boolean(cookie)).toBe(true);
  return cookie!;
}
const fingerprint = (rows: readonly Record<string, unknown>[]) =>
  sha256(canonical(rows.map((r) => canonical(r)).sort()));
async function rows(table: string, database = db) {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw Error('TEST_TABLE_DENIED');
  return (await database.prepare(`SELECT * FROM "${table}"`).all()).results;
}

beforeAll(async () => {
  kdf = await openLocalKdfAdapter();
  // Real scrypt verifier exists BEFORE the native backup boundary, never patched into a restored DB.
  const verifier = await kdf.hasher.hash(password);
  source = await createSyntheticAuthBackup(undefined, async (database) => {
    const now = Date.now();
    for (const id of ['offboard', 'revoked']) {
      await database.batch([
        database.prepare("INSERT INTO users(id,status) VALUES(?,'ACTIVE')").bind(`synthetic-${id}`),
        database
          .prepare(
            "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance) VALUES(?,?,'urn:mayisigorta:local-auth:v1',?,?,'OWNER_PROVISIONED')",
          )
          .bind(
            `synthetic-identity-${id}`,
            `synthetic-${id}`,
            `synthetic-subject-${id}`,
            `${id}@example.invalid`,
          ),
        database
          .prepare(
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,activated_at) VALUES(?,?,?,'MEMBER','ACTIVE',3,?,'2099-01-01T00:00:00.000Z',?)",
          )
          .bind(
            `synthetic-membership-${id}`,
            agency,
            `synthetic-${id}`,
            `${id}@example.invalid`,
            new Date(now).toISOString(),
          ),
        database
          .prepare(
            'INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,credential_version,must_change_password,updated_at) VALUES(?,?,?,?,7,0,?)',
          )
          .bind(
            `synthetic-${id}`,
            `synthetic-identity-${id}`,
            `${id}@example.invalid`,
            verifier,
            now,
          ),
      ]);
    }
    await database
      .prepare(
        'UPDATE local_credentials SET verifier=?,must_change_password=0,temporary_expires_at=NULL,updated_at=?',
      )
      .bind(verifier, now)
      .run();
    const grants = [
      ['customer.read', 'AGENCY'],
      ['policy.read', 'AGENCY'],
      ['renewal.read', 'AGENCY'],
      ['quote.read', 'AGENCY'],
      ['task.read', 'AGENCY'],
      ['task.update', 'AGENCY'],
      ['sensitive.health.read', 'UNSCOPED'],
    ];
    for (const [code, scope] of grants)
      await database
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(`synthetic-grant-${code}`, 'synthetic-membership-permanent', code, scope)
        .run();
    await database.batch([
      database.prepare(
        "INSERT INTO agencies(id,status) VALUES('synthetic-other-agency','PROVISIONING')",
      ),
      database.prepare("INSERT INTO users(id,status) VALUES('synthetic-foreign-user','ACTIVE')"),
      database.prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('synthetic-membership-foreign','synthetic-other-agency','synthetic-foreign-user','OWNER','INVITED','foreign@example.invalid','2099-01-01T00:00:00.000Z')",
      ),
      database.prepare(
        "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-09-01T00:00:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id='synthetic-membership-foreign'",
      ),
      database.prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,email_provenance) VALUES('synthetic-identity-foreign','synthetic-foreign-user','urn:mayisigorta:local-auth:v1','synthetic-subject-foreign','foreign@example.invalid','OWNER_PROVISIONED')",
      ),
      database
        .prepare(
          "INSERT INTO local_credentials(user_id,identity_id,login_email,verifier,credential_version,must_change_password,updated_at) VALUES('synthetic-foreign-user','synthetic-identity-foreign','foreign@example.invalid',?,7,0,?)",
        )
        .bind(verifier, now),
      database.prepare(
        "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-09-01T00:00:00.000Z',activated_at='2026-09-01T00:00:00.000Z',version=version+1 WHERE id='synthetic-other-agency'",
      ),
      database.prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('synthetic-foreign-customer','synthetic-other-agency','INDIVIDUAL','Foreign Synthetic','Foreign','Synthetic','synthetic-membership-foreign')",
      ),
      database.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('synthetic-foreign-insurer','synthetic-other-agency','SYN','Foreign synthetic')",
      ),
      database.prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('synthetic-foreign-branch','synthetic-other-agency','SYN','Foreign synthetic','GENERAL')",
      ),
      database.prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('synthetic-foreign-product','synthetic-other-agency','synthetic-foreign-insurer','synthetic-foreign-branch','SYN','Foreign synthetic')",
      ),
      database.prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('synthetic-foreign-payment','synthetic-other-agency','SYN','Foreign synthetic')",
      ),
      database.prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('synthetic-foreign-policy','synthetic-other-agency','synthetic-foreign-customer','synthetic-foreign-insurer','synthetic-foreign-product','synthetic-foreign-branch','synthetic-foreign-payment','synthetic-membership-foreign','SYN-FOREIGN','SYN-FOREIGN','2026-01-01','2026-09-15',1,'TRY')",
      ),
      database
        .prepare(
          "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('synthetic-health',?,'HEALTH','Synthetic health','HEALTH')",
        )
        .bind(agency),
      database
        .prepare(
          "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('synthetic-health-product',?,'synthetic-insurer','synthetic-health','HEALTH','Synthetic health')",
        )
        .bind(agency),
      database
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('synthetic-health-policy',?,'synthetic-customer','synthetic-insurer','synthetic-health-product','synthetic-health','synthetic-payment','synthetic-membership-permanent','SYN-HEALTH','SYN-HEALTH','2026-01-01','2026-09-15',123456,'TRY')",
        )
        .bind(agency),
      database.prepare(
        "UPDATE policies SET assignee_membership_id='synthetic-membership-permanent',version=version+1 WHERE id='synthetic-policy-05'",
      ),
      database.prepare(
        "UPDATE policies SET assignee_membership_id='synthetic-membership-permanent',version=version+1 WHERE id='synthetic-policy-03'",
      ),
      database.prepare(
        "UPDATE policies SET assignee_membership_id='synthetic-membership-permanent',version=version+1 WHERE id='synthetic-policy-02'",
      ),
      database
        .prepare(
          "INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES('synthetic-member-task',?,'synthetic-customer','GENERAL','Synthetic member private','2026-09-01T06:00:00.000Z','synthetic-membership-permanent','SYSTEM')",
        )
        .bind(agency),
    ]);
    const sourceEnv = environment(database);
    for (const id of actors) beforeCookies[id] = await successfulLogin(id, sourceEnv);
    const ownerCsrf = await request(
      '/api/auth/csrf-token',
      beforeCookies.temporary,
      undefined,
      sourceEnv,
    );
    const ownerToken = ((await ownerCsrf.json()) as { data: { token: string } }).data.token;
    const assigned = await app.fetch(
      new Request(
        'https://panel.mayisigorta.com/api/renewals/synthetic-renewal-03/tasks/synthetic-task-03/assign',
        {
          method: 'POST',
          headers: {
            cookie: beforeCookies.temporary!,
            origin: 'https://panel.mayisigorta.com',
            'content-type': 'application/json',
            'x-csrf-token': ownerToken,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            assigneeMembershipId: 'synthetic-membership-permanent',
          }),
        },
      ),
      sourceEnv,
    );
    expect(assigned.status).toBe(200);
    // Real quote/version/send/receipt/audit data, created before the snapshot using production routes.
    const quotePath = '/api/renewals/synthetic-renewal-03/quotes';
    const defaults = await request(quotePath, beforeCookies.temporary, undefined, sourceEnv);
    const defaultBody = (await defaults.json()) as {
      data: { defaultVersion: Record<string, unknown> };
    };
    const post = async (path: string, body: unknown) =>
      app.fetch(
        new Request('https://panel.mayisigorta.com' + path, {
          method: 'POST',
          headers: {
            cookie: beforeCookies.temporary!,
            origin: 'https://panel.mayisigorta.com',
            'content-type': 'application/json',
            'x-csrf-token': ownerToken,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        }),
        sourceEnv,
      );
    const quote = await post(quotePath, {
      expectedRenewalVersion: 2,
      version: {
        ...defaultBody.data.defaultVersion,
        validUntil: '2099-01-01T00:00:00.000Z',
        grossPremiumMinor: 12345,
      },
    });
    expect(quote.status).toBe(201);
    const created = (await quote.json()) as { data: { quoteId: string } };
    const revision = await post(`${quotePath}/${created.data.quoteId}/versions`, {
      expectedQuoteVersion: 1,
      version: {
        ...defaultBody.data.defaultVersion,
        validUntil: '2099-01-01T00:00:00.000Z',
        grossPremiumMinor: 23456,
      },
    });
    expect(revision.status).toBe(201);
    const revised = (await revision.json()) as { data: { quoteVersionId: string } };
    const sent = await post(`${quotePath}/${created.data.quoteId}/send`, {
      expectedQuoteVersion: 2,
      quoteVersionId: revised.data.quoteVersionId,
    });
    expect(sent.status).toBe(201);
    // A real revoked cookie is present in the exported dataset (not merely expired or invented).
    const csrf = await request('/api/auth/csrf-token', beforeCookies.revoked, undefined, sourceEnv);
    const csrfBody = (await csrf.json()) as { data: { token: string } };
    const logout = await app.fetch(
      new Request('https://panel.mayisigorta.com/api/auth/logout', {
        method: 'POST',
        headers: {
          cookie: beforeCookies.revoked!,
          origin: 'https://panel.mayisigorta.com',
          'x-csrf-token': csrfBody.data.token,
        },
      }),
      sourceEnv,
    );
    expect(logout.status).toBe(200);
    expect(
      (
        await request(
          '/api/policies/synthetic-health-policy',
          beforeCookies.permanent,
          undefined,
          sourceEnv,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          '/api/renewals/synthetic-renewal-03/quotes',
          beforeCookies.permanent,
          undefined,
          sourceEnv,
        )
      ).status,
    ).toBe(200);
  });
  artifact = JSON.parse(source.backup.artifactJson) as AuthBackupArtifact;
  // Independent authority changes occur on the still-live SOURCE, strictly AFTER its backup.
  await source.db
    .prepare(
      "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id='synthetic-membership-offboard'",
    )
    .bind(new Date().toISOString())
    .run();
  await source.db
    .prepare(
      "UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id='synthetic-membership-permanent'",
    )
    .run();
  await source.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='synthetic-membership-permanent' AND permission_code IN ('quote.read','sensitive.health.read')",
    )
    .run();
  await source.db
    .prepare(
      "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='synthetic-membership-permanent' AND permission_code='policy.read'",
    )
    .run();
  authority = {
    format: 'OPS001_CURRENT_AUTHORITY_V1',
    classification: 'INDEPENDENT_SYNTHETIC_CURRENT_STATE',
    sourceSha256: sha256(source.nativeExportSql),
    sequence: 1,
    issuedAt: new Date().toISOString(),
    memberships: (
      await source.db
        .prepare(
          'SELECT id,status,permission_version,version,suspended_at FROM agency_memberships ORDER BY id',
        )
        .all()
    ).results as CurrentAuthority['memberships'],
    grants: (
      await source.db
        .prepare(
          'SELECT id,membership_id,permission_code,scope FROM membership_permissions ORDER BY id',
        )
        .all()
    ).results as CurrentAuthority['grants'],
    tombstones: [],
    sensitiveGrants: 'INVALIDATE_ALL',
    sessions: 'REVOKE_ALL',
  };
  runtime = new miniflare.Miniflare(
    miniflare.convertV4MiniflareOptions({
      modules: true,
      script: 'export default {}',
      cf: false,
      d1Databases: { DB: '00000000-0000-4000-8000-000000000905' },
    }),
  );
  db = await runtime.getD1Database('DB');
  env = environment(db);
  const derived = orderedD1Import(source.nativeExportSql);
  expect(
    queryRestorePlan(derived, currentAuthorityImportSql(authority)).map((p) => p.name),
  ).toEqual(['schema', 'data', 'guards', 'authority']);
  for (const [table, data] of Object.entries(artifact.data))
    if (
      ![
        'agency_memberships',
        'membership_permissions',
        'local_credentials',
        'local_sessions',
      ].includes(table)
    )
      immutable.set(table, fingerprint(data));
  // The executor owns every write to a fresh target; never adopts an unjournaled partial restore.
  journal = mkdtempSync(join(tmpdir(), 'mayi-restored-http-journal-'));
  const input = {
    directory: journal,
    targetBinding: 'LOCAL_SYNTHETIC_AUTH_GATE_ONLY',
    derived,
    authoritySql: currentAuthorityImportSql(authority),
    query: async (sql: string) => (await db.prepare(sql).all()).results,
    write: async (name: string, batch: readonly { sql: string }[]) => {
      writes.push(name);
      await db.batch(batch.map(({ sql }) => db.prepare(sql)));
      if (name === 'guards')
        for (const [table, data] of Object.entries(artifact.data))
          expect(fingerprint(await rows(table)), table).toBe(fingerprint(data));
      if (name === 'authority') throw Error('SYNTHETIC_ACK_LOST');
    },
  };
  await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
  expect(await runQueryRecovery(input)).toMatchObject({
    publication: 'SEALED',
    phasesConfirmed: 4,
  });
  expect(writes).toEqual(['schema', 'data', 'guards', 'authority']);
  expect(
    (
      await db
        .prepare('SELECT count(*) n FROM local_sessions WHERE revoked_at IS NULL')
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  for (const old of artifact.data.local_sessions!.filter((r) => r.revoked_at !== null)) {
    const restored = await db
      .prepare('SELECT revoked_at FROM local_sessions WHERE token_hash=?')
      .bind(old.token_hash)
      .first<{ revoked_at: number }>();
    expect(restored?.revoked_at === old.revoked_at).toBe(true);
  }
  for (const id of ['temporary', 'permanent', 'revoked']) cookies[id] = await successfulLogin(id);
}, 240000);
afterAll(async () => {
  await runtime?.dispose();
  await source?.dispose();
  await kdf?.dispose();
  if (journal) rmSync(journal, { recursive: true, force: true });
});

it('authenticates active OWNER and MEMBER with actual scrypt and reads their authorized customer/policy', async () => {
  for (const id of ['temporary', 'permanent'])
    for (const path of [
      '/api/auth/session',
      '/api/customers/synthetic-customer',
      '/api/policies/synthetic-policy-05',
    ])
      expect((await request(path, cookies[id])).status, `${id} ${path}`).toBe(200);
});
it('rejects the correct offboarded password and every pre-backup cookie after reconciliation', async () => {
  expect((await login('offboard')).status).toBe(401);
  for (const id of actors)
    for (const path of [
      '/api/auth/session',
      '/api/customers/synthetic-customer',
      '/api/tasks/today',
    ])
      expect((await request(path, beforeCookies[id])).status, `${id} ${path}`).toBe(401);
});
it('keeps revoked quote and HEALTH permissions revoked for a freshly authenticated MEMBER', async () => {
  for (const path of [
    '/api/renewals/synthetic-renewal-03/quotes',
    '/api/policies/synthetic-health-policy',
  ])
    expect((await request(path, cookies.permanent)).status).toBe(403);
});
it('requires explicit HEALTH permission even for OWNER and filters HEALTH out of policy lists', async () => {
  expect((await request('/api/policies/synthetic-health-policy', cookies.temporary)).status).toBe(
    403,
  );
  for (const id of ['temporary', 'permanent']) {
    const res = await request('/api/policies', cookies[id]);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('synthetic-health-policy');
  }
});
it('keeps tenant and current ASSIGNED-policy boundaries intact on direct IDs and lists', async () => {
  for (const id of ['temporary', 'permanent']) {
    expect((await request('/api/customers/synthetic-foreign-customer', cookies[id])).status).toBe(
      404,
    );
    expect((await request('/api/policies/synthetic-foreign-policy', cookies[id])).status).toBe(404);
    for (const path of ['/api/customers', '/api/policies']) {
      const response = await request(path, cookies[id]);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('synthetic-foreign-');
    }
  }
  expect((await request('/api/policies/synthetic-policy-00', cookies.permanent)).status).toBe(403);
  const response = await request('/api/policies', cookies.permanent);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('synthetic-policy-05');
  expect(body).not.toContain('synthetic-policy-00');
});
it('does not disclose another employee private Task through legacy AGENCY task grants or direct commands', async () => {
  // Both parent policy and renewal are readable; a parent DENY cannot mask a broken private-Task check.
  expect((await request('/api/policies/synthetic-policy-02', cookies.permanent)).status).toBe(200);
  const renewals = await request('/api/customers/synthetic-customer/renewals', cookies.permanent);
  expect(renewals.status).toBe(200);
  expect(await renewals.text()).toContain('synthetic-renewal-02');
  const response = await request('/api/tasks/today', cookies.permanent);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('synthetic-task-03');
  expect(body).not.toContain('synthetic-task-02');
  expect((await request('/api/tasks/synthetic-task-02/context', cookies.permanent)).status).toBe(
    404,
  );
  expect((await request('/api/tasks/synthetic-task-03/context', cookies.permanent)).status).toBe(
    200,
  );
  const csrf = await request('/api/auth/csrf-token', cookies.permanent);
  const token = ((await csrf.json()) as { data: { token: string } }).data.token;
  const denied = await app.fetch(
    new Request(
      'https://panel.mayisigorta.com/api/renewals/synthetic-renewal-02/tasks/synthetic-task-02/complete',
      {
        method: 'POST',
        headers: {
          cookie: cookies.permanent!,
          origin: 'https://panel.mayisigorta.com',
          'content-type': 'application/json',
          'x-csrf-token': token,
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          expectedTaskVersion: 1,
          expectedRenewalVersion: 1,
          replacementDueAt: '2099-01-01T00:00:00.000Z',
        }),
      },
    ),
    env,
  );
  expect(denied.status).toBe(404);
});
it('matches the independently changed SOURCE authority in both stored state and real API decisions', async () => {
  expect(
    fingerprint(
      (
        await db
          .prepare(
            'SELECT id,status,permission_version,version,suspended_at FROM agency_memberships',
          )
          .all()
      ).results,
    ),
  ).toBe(fingerprint(authority.memberships));
  expect(
    fingerprint(
      (
        await db
          .prepare('SELECT id,membership_id,permission_code,scope FROM membership_permissions')
          .all()
      ).results,
    ),
  ).toBe(fingerprint(authority.grants));
  const sourceEnv = environment(source.db);
  const liveCookie = await successfulLogin('permanent', sourceEnv);
  expect((await login('offboard', sourceEnv)).status).toBe(401);
  for (const [path, status] of [
    ['/api/customers/synthetic-customer', 200],
    ['/api/policies/synthetic-policy-05', 200],
    ['/api/policies/synthetic-policy-00', 403],
    ['/api/policies/synthetic-health-policy', 403],
    ['/api/renewals/synthetic-renewal-03/quotes', 403],
    ['/api/tasks/synthetic-task-02/context', 404],
  ] as const) {
    expect((await request(path, liveCookie, undefined, sourceEnv)).status, path).toBe(status);
    expect((await request(path, cookies.permanent)).status, path).toBe(status);
  }
});
it('rejects a newly revoked post-recovery session through the real logout API', async () => {
  const cookie = await successfulLogin('permanent');
  const csrf = await request('/api/auth/csrf-token', cookie);
  const token = ((await csrf.json()) as { data: { token: string } }).data.token;
  const logout = await app.fetch(
    new Request('https://panel.mayisigorta.com/api/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://panel.mayisigorta.com', 'x-csrf-token': token },
    }),
    env,
  );
  expect(logout.status).toBe(200);
  for (const path of ['/api/auth/session', '/api/customers/synthetic-customer', '/api/tasks/today'])
    expect((await request(path, cookie)).status).toBe(401);
});
it('enforces current customer ASSIGNED scope without widening it through a restored session', async () => {
  try {
    await db
      .prepare(
        "UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id='synthetic-membership-permanent'",
      )
      .run();
    await db
      .prepare(
        "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='synthetic-membership-permanent' AND permission_code='customer.read'",
      )
      .run();
    const cookie = await successfulLogin('permanent');
    expect((await request('/api/customers/synthetic-customer', cookie)).status).toBe(404);
    const res = await request('/api/customers', cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('synthetic-customer');
    expect((await request('/api/customers/synthetic-customer', cookies.permanent)).status).toBe(
      401,
    );
  } finally {
    await db
      .prepare(
        "UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id='synthetic-membership-permanent'",
      )
      .run();
    await db
      .prepare(
        "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='synthetic-membership-permanent' AND permission_code='customer.read'",
      )
      .run();
    cookies.permanent = await successfulLogin('permanent');
  }
});
it('preserves every financial/task/renewal/receipt/audit row and migration ledger after HTTP checks', async () => {
  for (const [table, expected] of immutable) {
    const current = await rows(table);
    // Real authorization denials append audit events. Historical audit rows must remain byte-exact.
    if (table === 'audit_events') {
      const original = artifact.data.audit_events!;
      const ids = new Set<unknown>(original.map((r) => r.id));
      expect(fingerprint(current.filter((r) => ids.has(r.id)))).toBe(expected);
    } else expect(fingerprint(current), table).toBe(expected);
  }
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  expect((await db.prepare('SELECT count(*) n FROM d1_migrations').first<{ n: number }>())?.n).toBe(
    23,
  );
  expect((await rows('renewal_quote_versions')).map((r) => r.gross_premium_minor).sort()).toEqual([
    12345, 23456,
  ]);
});
