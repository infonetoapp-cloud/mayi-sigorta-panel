// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { customerCoverageFixture } from './support/customer-coverage-fixture';
import type { CustomerCoverageSummary } from '../src/shared/customer-coverage';
import type { CustomerListResponseData } from '../src/shared/types';
let f: Awaited<ReturnType<typeof customerCoverageFixture>>;
beforeAll(async () => {
  f = await customerCoverageFixture();
  await f.customer('coverage-many');
  await f.customer('coverage-zero');
  for (let i = 0; i < 25; i++) await f.policy('many-' + i, 'coverage-many');
}, 60000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('projects exact authorized coverage beyond a policy page with real display names and a bounded preview', async () => {
  const r = await f.request('/api/customers/coverage-many/coverage', 'GET', f.member);
  expect(r.status).toBe(200);
  const { data } = (await r.json()) as {
    data: {
      activePolicyCount: number;
      types: Array<{ label: string; count: number }>;
      policies: Array<{ insurerName: string; productName: string; branchName: string }>;
    };
  };
  expect(data.activePolicyCount).toBe(25);
  expect(data.types).toEqual([{ label: 'Kasko', count: 25 }]);
  expect(data.policies).toHaveLength(3);
  expect(data.policies[0]).toMatchObject({
    insurerName: 'Sentetik Sigorta',
    productName: 'Kasko Ürünü',
    branchName: 'Kasko',
  });
  expect(r.headers.get('cache-control')).toContain('no-store');
});
async function summary(id: string, cookie = f.member) {
  const r = await f.request(`/api/customers/${id}/coverage`, 'GET', cookie);
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: CustomerCoverageSummary }).data;
}
it('distinguishes zero from denied, and status from expired, scheduled and archived periods', async () => {
  expect(await summary('coverage-zero')).toMatchObject({
    available: true,
    activePolicyCount: 0,
    types: [],
    policies: [],
    nearestExpiry: null,
  });
  await f.customer('coverage-states');
  for (const [id, opts] of [
    ['today', { start: f.day(-1), end: f.today }],
    ['expired', { start: f.day(-40), end: f.day(-1) }],
    ['future', { start: f.day(1), end: f.day(40) }],
    ['cancelled', { status: 'CANCELLED' }],
    ['voided', { status: 'VOIDED' }],
    ['archived', { archived: true }],
    ['bad-date', { start: '2026-02-31', end: '2099-01-01' }],
  ] as const)
    await f.policy('state-' + id, 'coverage-states', 'kasko', opts);
  const s = await summary('coverage-states');
  expect(s).toMatchObject({
    asOfDate: f.today,
    timezone: 'Europe/Istanbul',
    activePolicyCount: 1,
    expiredPolicyCount: 1,
    scheduledPolicyCount: 1,
    cancelledPolicyCount: 1,
    voidedPolicyCount: 1,
    archivedPolicyCount: 1,
    invalidPeriodPolicyCount: 1,
  });
  expect(s.nearestExpiry?.policyId).toBe('state-today');
  expect(s.types).toEqual([{ label: 'Kasko', count: 1 }]);
});
it('groups repeated types, shows only three labels and counts additional authorized types exactly', async () => {
  await f.customer('coverage-types');
  for (const [index, type] of ['kasko', 'kasko', 'trafik', 'konut', 'dask'].entries())
    await f.policy('type-' + index, 'coverage-types', type, { end: f.day(10 + index) });
  const s = await summary('coverage-types', f.owner);
  expect(s.activePolicyCount).toBe(5);
  expect(s.types).toHaveLength(3);
  expect(s.additionalTypeCount).toBe(1);
  expect(s.types[0]).toEqual({ label: 'Kasko', count: 2 });
  expect(s.nearestExpiry?.endDate).toBe(f.day(10));
  expect(s.policies.map((p) => p.policyId)).toEqual(['type-0', 'type-1', 'type-2']);
});
it('keeps historical inactive catalog display names instead of IDs or selectable-only lookups', async () => {
  await f.db
    .prepare(
      "UPDATE insurance_products SET status='INACTIVE',version=version+1 WHERE id='coverage-product-kasko'",
    )
    .run();
  try {
    expect((await summary('coverage-many')).policies[0]).toMatchObject({
      branchName: 'Kasko',
      productName: 'Kasko Ürünü',
      insurerName: 'Sentetik Sigorta',
    });
  } finally {
    await f.db
      .prepare(
        "UPDATE insurance_products SET status='ACTIVE',version=version+1 WHERE id='coverage-product-kasko'",
      )
      .run();
  }
});
it('keeps the complete named policy history paginated, independently of the compact summary', async () => {
  const r = await f.request(
    '/api/policies?customerId=coverage-many&pageSize=20&includeLabels=true',
    'GET',
    f.member,
  );
  expect(r.status).toBe(200);
  const page = (
    (await r.json()) as {
      data: {
        items: Array<{ labels: { branchName: string; productName: string; insurerName: string } }>;
        hasMore: boolean;
        nextCursor: string;
      };
    }
  ).data;
  expect(page.items).toHaveLength(20);
  expect(page.hasMore).toBe(true);
  expect(page.items[0]?.labels).toEqual({
    branchName: 'Kasko',
    productName: 'Kasko Ürünü',
    insurerName: 'Sentetik Sigorta',
  });
});
it('does not disclose HEALTH counts, types or previews even to OWNER without the explicit grant', async () => {
  await f.policy('health-only', 'coverage-many', 'health');
  for (const cookie of [f.owner, f.member]) {
    const s = await summary('coverage-many', cookie);
    expect(s.activePolicyCount).toBe(25);
    expect(JSON.stringify(s)).not.toContain('Sağlık');
  }
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('coverage-health-grant','membership-coverage-a','sensitive.health.read','UNSCOPED')",
    )
    .run();
  try {
    expect((await summary('coverage-many')).activePolicyCount).toBe(26);
  } finally {
    await f.db.prepare("DELETE FROM membership_permissions WHERE id='coverage-health-grant'").run();
  }
});
it('does not turn absent policy permission into a false zero-policy claim', async () => {
  await f.db
    .prepare("DELETE FROM membership_permissions WHERE membership_id='membership-coverage-b'")
    .run();
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('coverage-read-only','membership-coverage-b','customer.read','AGENCY')",
    )
    .run();
  const other = (await f.session('coverage-b')).cookie;
  expect(await summary('coverage-many', other)).toMatchObject({
    available: false,
    activePolicyCount: null,
    types: [],
    nearestExpiry: null,
    policies: [],
  });
});
it('denies cross-agency and customized customer scope without a record-existence hint', async () => {
  await f.seed('coverage-foreign', 'OWNER', false, 'coverage-foreign-agency');
  const cookie = (await f.session('coverage-foreign')).cookie;
  expect((await f.request('/api/customers/coverage-many/coverage', 'GET', cookie)).status).toBe(
    404,
  );
  const original = await f.db
    .prepare(
      "SELECT id,scope FROM membership_permissions WHERE membership_id='membership-coverage-a' AND scope='AGENCY'",
    )
    .all<{ id: string; scope: string }>();
  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-coverage-a' AND scope='AGENCY'",
    )
    .run();
  try {
    expect((await f.request('/api/customers/coverage-many/coverage', 'GET', f.member)).status).toBe(
      404,
    );
    await f.customer('coverage-self', 'coverage-a');
    await f.policy('coverage-self-policy', 'coverage-self', 'trafik', { assignee: 'coverage-b' });
    expect((await summary('coverage-self')).activePolicyCount).toBe(1);
  } finally {
    await f.db.batch(
      original.results.map((row) =>
        f.db
          .prepare('UPDATE membership_permissions SET scope=? WHERE id=?')
          .bind(row.scope, row.id),
      ),
    );
  }
});
it('paginates summaries only for the authorized current customer page, preserving the original opt-out contract', async () => {
  for (let i = 0; i < 23; i++) await f.customer('page-' + String(i).padStart(2, '0'));
  const first = await f.request(
    '/api/customers?include=coverage&limit=20&search=page-&sort=displayName&order=asc',
    'GET',
    f.member,
  );
  expect(first.status).toBe(200);
  const a = ((await first.json()) as { data: CustomerListResponseData }).data;
  expect(a.items).toHaveLength(20);
  expect(a.hasMore).toBe(true);
  expect(a.items.every((c) => c.coverage?.activePolicyCount === 0)).toBe(true);
  const second = await f.request(
    '/api/customers?include=coverage&limit=20&search=page-&sort=displayName&order=asc&cursor=' +
      encodeURIComponent(a.nextCursor!),
    'GET',
    f.member,
  );
  const b = ((await second.json()) as { data: CustomerListResponseData }).data;
  expect(b.items).toHaveLength(3);
  expect(new Set([...a.items, ...b.items].map((c) => c.id)).size).toBe(23);
  const old = await f.request('/api/customers?limit=1', 'GET', f.member);
  expect(
    ((await old.json()) as { data: CustomerListResponseData }).data.items[0],
  ).not.toHaveProperty('coverage');
  for (const query of [
    'include=coverage&limit=21',
    'include=coverage&include=coverage',
    'include=anything',
  ])
    expect((await f.request('/api/customers?' + query, 'GET', f.member)).status).toBe(400);
});
it('uses one indexed aggregate query for either one or twenty customers, never N+1 policy reads', async () => {
  const db = f.db;
  let queries: string[] = [];
  let aggregatePlan: string[] = [];
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'bind')
          return (...values: unknown[]) => {
            if (sql.startsWith('WITH cfg(day)')) aggregatePlan.push(JSON.stringify(values));
            return wrap(target.bind(...values), sql);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          queries.push(sql);
          return wrap(db.prepare(sql), sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    for (const limit of [1, 20]) {
      queries = [];
      aggregatePlan = [];
      const r = await f.request(
        `/api/customers?include=coverage&limit=${limit}&search=page-`,
        'GET',
        f.member,
      );
      expect(r.status).toBe(200);
      const aggregate = queries.filter((sql) => sql.startsWith('WITH cfg(day)'));
      expect(aggregate).toHaveLength(1);
      expect(queries.filter((sql) => sql.includes('FROM policies p'))).toHaveLength(1);
      const plan = await db
        .prepare('EXPLAIN QUERY PLAN ' + aggregate[0])
        .bind(...JSON.parse(aggregatePlan[0]!))
        .all<{ detail: string }>();
      expect(
        plan.results.some((row) => row.detail.includes('policies_agency_customer_end_idx')),
      ).toBe(true);
    }
  } finally {
    f.env.DB = db;
  }
});
it('honors ASSIGNED policy scope without hiding a shared customer', async () => {
  await f.seed('coverage-c');
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['policy.read', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-coverage-c', code, scope)
      .run();
  const cookie = (await f.session('coverage-c')).cookie;
  expect((await summary('coverage-many', cookie)).activePolicyCount).toBe(0);
  await f.policy('assigned-one', 'coverage-many', 'trafik', { assignee: 'coverage-c' });
  const s = await summary('coverage-many', cookie);
  expect(s.activePolicyCount).toBe(1);
  expect(s.types).toEqual([{ label: 'Trafik', count: 1 }]);
  expect(s.policies.map((p) => p.policyId)).toEqual(['assigned-one']);
  expect((await f.request('/api/policies/many-0', 'GET', cookie)).status).toBe(403);
  expect((await f.request('/api/policies/assigned-one', 'GET', cookie)).status).toBe(200);
});
it('does not count an insured relationship as a customer-owned policy', async () => {
  await f.customer('party-only');
  await f.db
    .prepare(
      "INSERT INTO policy_parties(id,agency_id,policy_id,customer_id,role) VALUES('coverage-party','agency-auth-test','many-0','party-only','INSURED')",
    )
    .run();
  expect((await summary('party-only')).activePolicyCount).toBe(0);
});
it('rechecks current customer assignment at the final disclosure boundary', async () => {
  await f.seed('coverage-d');
  for (const [code, scope] of [
    ['customer.read', 'ASSIGNED'],
    ['policy.read', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-coverage-d', code, scope)
      .run();
  await f.customer('live-assigned', 'coverage-d');
  await f.policy('live-assigned-policy', 'live-assigned');
  const cookie = (await f.session('coverage-d')).cookie,
    original = f.env.DB,
    db = f.db;
  let ready = false,
    changed = false;
  f.env.DB = new Proxy(original, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (sql.includes('WITH cfg(day)')) ready = true;
          return target.prepare(sql);
        };
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (ready && !changed) {
            changed = true;
            await db
              .prepare(
                "UPDATE customers SET assignee_membership_id='membership-coverage-owner',version=version+1 WHERE id='live-assigned'",
              )
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const r = await f.request('/api/customers/live-assigned/coverage', 'GET', cookie);
    expect(changed).toBe(true);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('live-assigned-policy');
  } finally {
    f.env.DB = original;
  }
});
it('rechecks live session at the aggregate boundary without returning a stale summary', async () => {
  const session = await f.session('coverage-a');
  const db = f.db;
  let ready = false,
    fired = false;
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (sql.startsWith('WITH cfg(day)')) ready = true;
          return db.prepare(sql);
        };
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (ready && !fired) {
            fired = true;
            await db
              .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
              .bind(Date.now(), session.hash)
              .run();
          }
          return db.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const r = await f.request('/api/customers/coverage-many/coverage', 'GET', session.cookie);
    expect(fired).toBe(true);
    expect([401, 404, 503]).toContain(r.status);
    expect(await r.text()).not.toContain('activePolicyCount');
  } finally {
    f.env.DB = db;
  }
});
