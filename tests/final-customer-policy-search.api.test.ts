// @vitest-environment node
import { beforeAll, afterAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let cookies: string[];
const base = '/api/policies?customerId=grow-c&pageSize=20&includeLabels=true';
async function get(path = base, actor = 0) {
  return f.request(path, 'GET', cookies[actor]!);
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('grow-owner', 'OWNER');
  await f.seed('grow-member');
  await f.seed('grow-foreign', 'OWNER', false, 'grow-foreign-agency');
  await f.db.batch(
    createOnboardingTemplateGrants('personel').map((g) =>
      f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope)VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), 'membership-grow-member', g.permission_code, g.scope),
    ),
  );
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,assignee_membership_id)VALUES('grow-c','agency-auth-test','INDIVIDUAL','Sentetik Müşteri','membership-grow-member'),('grow-other','agency-auth-test','INDIVIDUAL','Diğer Müşteri','membership-grow-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name)VALUES('grow-i','agency-auth-test','GROW','IŞIK SİGORTA')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)VALUES('grow-b','agency-auth-test','GROW','Motor','GENERAL'),('grow-h','agency-auth-test','GROWH','Sağlık','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)VALUES('grow-pr','agency-auth-test','grow-i','grow-b','GROW','İŞYERİ KASKO'),('grow-hp','agency-auth-test','grow-i','grow-h','GROWH','Sağlık')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name)VALUES('grow-pm','agency-auth-test','GROW','Peşin')",
    ),
  ]);
  await f.db.batch(
    Array.from({ length: 32 }, (_, i) =>
      f.db
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status)VALUES(?,'agency-auth-test',?,'grow-i',?,?,'grow-pm','membership-grow-member',?,?,'2026-01-01','2027-01-01',1250050,'TRY','ACTIVE')",
        )
        .bind(
          'grow-' + String(i).padStart(2, '0'),
          i === 31 ? 'grow-other' : 'grow-c',
          i === 30 ? 'grow-hp' : 'grow-pr',
          i === 30 ? 'grow-h' : 'grow-b',
          'GROW-' + i,
          'GROW' + i,
        ),
    ),
  );
  cookies = [];
  for (const id of ['grow-owner', 'grow-member', 'grow-foreign'])
    cookies.push((await f.session(id)).cookie);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
for (const actor of [0, 1])
  it(`actor ${actor} searches beyond loaded 20 by full policy identity`, async () => {
    const first = (await (await get(base, actor)).json()) as {
      data: { items: { id: string }[]; hasMore: boolean };
    };
    expect(first.data.items).toHaveLength(20);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.items.some((x) => x.id === 'grow-29')).toBe(false);
    const r = await get(base + '&customerSearch=GROW-29', actor);
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as { data: { items: { id: string }[] } }).data.items.map((x) => x.id),
    ).toEqual(['grow-29']);
  });
it.each(['ışık sigorta', 'IŞIK SİGORTA', 'işyeri kasko', 'İŞYERİ KASKO'])(
  'searches authorized insurer/product labels using Turkish case: %s',
  async (term) => {
    const r = await get(base + '&customerSearch=' + encodeURIComponent(term));
    expect(r.status).toBe(200);
    const d = (
      (await r.json()) as { data: { items: unknown[]; hasMore: boolean; nextCursor: string } }
    ).data;
    expect(d.items).toHaveLength(20);
    expect(d.hasMore).toBe(true);
    const next = await get(
      base +
        '&customerSearch=' +
        encodeURIComponent(term) +
        '&cursor=' +
        encodeURIComponent(d.nextCursor),
    );
    expect(next.status).toBe(200);
    expect(((await next.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(10);
  },
);
it('scopes search before pagination and never returns another customer/tenant or hidden HEALTH rows', async () => {
  const r = await get(base + '&customerSearch=GROW');
  expect(r.status).toBe(200);
  const d = ((await r.json()) as { data: { items: { id: string }[]; nextCursor: string } }).data;
  const next = await get(base + '&customerSearch=GROW&cursor=' + encodeURIComponent(d.nextCursor));
  const rows = [
    ...d.items,
    ...((await next.json()) as { data: { items: { id: string }[] } }).data.items,
  ];
  expect(rows).toHaveLength(30);
  expect(new Set(rows.map((x) => x.id)).size).toBe(30);
  expect(rows.some((x) => ['grow-30', 'grow-31'].includes(x.id))).toBe(false);
  const foreign = await get(base + '&customerSearch=GROW', 2);
  expect(foreign.status).toBe(200);
  expect(((await foreign.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(0);
});
it('does not let literal wildcard text enumerate the customer', async () => {
  for (const value of ['%', '_']) {
    const r = await get(base + '&customerSearch=' + encodeURIComponent(value));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(0);
  }
});
it('binds new customer-search cursors to the active customer/filter', async () => {
  const r = await get(base + '&customerSearch=GROW');
  const cursor = ((await r.json()) as { data: { nextCursor: string } }).data.nextCursor;
  expect(
    (await get(base + '&customerSearch=GROW-29&cursor=' + encodeURIComponent(cursor))).status,
  ).toBe(400);
  expect(
    (
      await get(
        base.replace('grow-c', 'grow-other') +
          '&customerSearch=GROW&cursor=' +
          encodeURIComponent(cursor),
      )
    ).status,
  ).toBe(400);
});
it('rejects unbounded or malformed customer search instead of broadening scope', async () => {
  for (const path of [
    '/api/policies?customerSearch=GROW&includeLabels=true',
    base + '&customerSearch=' + 'x'.repeat(101),
    base + '&customerSearch=',
  ])
    expect((await get(path)).status).toBe(400);
});

async function atRead(
  cookie: string,
  mutate: () => Promise<void>,
  afterSnapshot?: () => Promise<void>,
) {
  const original = f.env.DB;
  const marked = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let fired = false,
    captured = false;
  const wrap = (s: D1PreparedStatement, snapshot = false): D1PreparedStatement => {
    const w = {
      bind: (...v: unknown[]) => wrap(s.bind(...v), snapshot),
      first: async () => {
        const r = await s.first();
        if (snapshot) {
          captured = true;
          await afterSnapshot?.();
        }
        return r;
      },
      all: s.all.bind(s),
      run: s.run.bind(s),
      raw: s.raw.bind(s),
    } as D1PreparedStatement;
    if (!snapshot) marked.set(w, s);
    return w;
  };
  f.env.DB = {
    prepare(sql: string) {
      const s = f.db.prepare(sql);
      return sql.includes('SELECT p.*')
        ? wrap(s)
        : afterSnapshot && sql.includes('AS snapshot')
          ? wrap(s, true)
          : s;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      if (statements.some((s) => marked.has(s))) {
        fired = true;
        await mutate();
      }
      return f.db.batch<T>(statements.map((s) => marked.get(s) ?? s));
    },
  } as D1Database;
  try {
    return {
      response: await f.request(base + '&customerSearch=GROW', 'GET', cookie),
      get fired() {
        return fired;
      },
      get captured() {
        return captured;
      },
    };
  } finally {
    f.env.DB = original;
  }
}
it('search final batch denies session revocation immediately before actual SELECT', async () => {
  const session = await f.session('grow-member');
  const result = await atRead(session.cookie, async () => {
    await f.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
      .bind(Date.now(), session.hash)
      .run();
  });
  expect(result.fired).toBe(true);
  expect(result.response.status).toBe(403);
});
it('search denies final dependency scope inversion without an epoch bump', async () => {
  const session = await f.session('grow-member');
  try {
    const result = await atRead(session.cookie, async () => {
      await f.db
        .prepare(
          "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-grow-member' AND permission_code='policy.read'",
        )
        .run();
    });
    expect(result.fired).toBe(true);
    expect(result.response.status).toBe(403);
  } finally {
    await f.db
      .prepare(
        "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-grow-member' AND permission_code='policy.read'",
      )
      .run();
  }
});
it('search validates the captured graph itself against A-B-A scope inversion', async () => {
  const session = await f.session('grow-member');
  const scope = async (value: string) => {
    await f.db
      .prepare(
        "UPDATE membership_permissions SET scope=? WHERE membership_id='membership-grow-member' AND permission_code='policy.read'",
      )
      .bind(value)
      .run();
  };
  try {
    await scope('ASSIGNED');
    const result = await atRead(
      session.cookie,
      () => scope('ASSIGNED'),
      () => scope('AGENCY'),
    );
    expect(result.captured).toBe(true);
    expect(result.response.status).toBe(403);
  } finally {
    await scope('AGENCY');
  }
});
it('search intersects current ASSIGNED record scope rather than disclosing all matches', async () => {
  const rows = (
    await f.db
      .prepare(
        "SELECT id,scope FROM membership_permissions WHERE membership_id='membership-grow-member'",
      )
      .all<{ id: string; scope: string }>()
  ).results;
  try {
    await f.db.batch([
      f.db.prepare(
        "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-grow-member' AND scope='AGENCY'",
      ),
      f.db.prepare(
        "UPDATE customers SET assignee_membership_id='membership-grow-owner' WHERE id='grow-c'",
      ),
      f.db.prepare(
        "UPDATE policies SET assignee_membership_id=CASE WHEN id='grow-29' THEN 'membership-grow-member' ELSE 'membership-grow-owner' END WHERE customer_id='grow-c'",
      ),
    ]);
    const r = await get(base + '&customerSearch=GROW', 1);
    expect(r.status).toBe(200);
    expect(
      ((await r.json()) as { data: { items: { id: string }[] } }).data.items.map((x) => x.id),
    ).toEqual(['grow-29']);
  } finally {
    await f.db.batch([
      ...rows.map((g) =>
        f.db.prepare('UPDATE membership_permissions SET scope=? WHERE id=?').bind(g.scope, g.id),
      ),
      f.db.prepare(
        "UPDATE customers SET assignee_membership_id='membership-grow-member' WHERE id='grow-c'",
      ),
      f.db.prepare(
        "UPDATE policies SET assignee_membership_id='membership-grow-member' WHERE customer_id='grow-c'",
      ),
    ]);
  }
});
