// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  owner: string,
  customer: string,
  renewal: string;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('accept-owner', 'OWNER');
  const m = await f.seed('accept-member');
  await f.db.batch(
    createOnboardingTemplateGrants('personel').map((g) =>
      f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), m.membershipId, g.permission_code, g.scope),
    ),
  );
  owner = (await f.session('accept-owner')).cookie;
  const write = async (path: string, body: unknown) =>
    f.request(path, 'POST', owner, body, await f.csrf(owner), {
      'idempotency-key': crypto.randomUUID(),
    });
  const c = await write('/api/customers', {
    type: 'INDIVIDUAL',
    firstName: 'Sentetik',
    lastName: 'Final Sınır',
  });
  expect(c.status).toBe(201);
  customer = ((await c.json()) as { data: { id: string } }).data.id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('accept-i','agency-auth-test','ACCEPT','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('accept-b','agency-auth-test','ACCEPT','Sentetik','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('accept-product','agency-auth-test','accept-i','accept-b','ACCEPT','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('accept-pay','agency-auth-test','ACCEPT','Sentetik')",
    ),
  ]);
  const p = await write('/api/policies', {
    customerId: customer,
    insurerId: 'accept-i',
    branchId: 'accept-b',
    productId: 'accept-product',
    paymentMethodId: 'accept-pay',
    assigneeMembershipId: 'membership-accept-member',
    policyNumber: 'ACCEPT-FINAL-BOUNDARY',
    startDate: '2026-01-01',
    endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    grossPremium: '12500.50',
    currency: 'TRY',
    installmentCount: null,
  });
  expect(p.status).toBe(201);
  const pid = ((await p.json()) as { data: { id: string } }).data.id;
  renewal = (await f.db
    .prepare('SELECT id FROM renewal_opportunities WHERE expiring_policy_id=?')
    .bind(pid)
    .first<{ id: string }>())!.id;
  const note = await write(`/api/renewals/${renewal}/interactions`, {
    outcome: 'NOTE',
    channel: 'OTHER',
    occurredAt: new Date().toISOString(),
    companyContactId: null,
    note: 'Sentetik son disclosure notu',
  });
  expect(note.status).toBe(201);
  const defaults = (
    (await (await f.request(`/api/renewals/${renewal}/quotes`, 'GET', owner)).json()) as {
      data: { defaultVersion: Record<string, unknown> };
    }
  ).data.defaultVersion;
  const q = await write(`/api/renewals/${renewal}/quotes`, {
    expectedRenewalVersion: 1,
    version: defaults,
  });
  expect(q.status).toBe(201);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
/** Fire immediately before the actual final SELECT, old .all or corrected atomic batch. */
async function atDisclosure(
  path: string,
  sqlPattern: RegExp,
  mutate: () => Promise<void>,
  cookie: string,
  afterSnapshot?: () => Promise<void>,
  requireFinal = true,
) {
  const real = f.env.DB;
  const unwrapped = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let fired = false;
  const fire = async () => {
    if (!fired) {
      fired = true;
      await mutate();
    }
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      all: async () => {
        await fire();
        return s.all();
      },
      first: s.first.bind(s),
      run: s.run.bind(s),
      raw: s.raw.bind(s),
    } as D1PreparedStatement;
    unwrapped.set(w, s);
    return w;
  };
  const snapshotWrap = (s: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...v: unknown[]) => snapshotWrap(s.bind(...v)),
      first: async () => {
        const row = await s.first();
        await afterSnapshot?.();
        return row;
      },
      all: s.all.bind(s),
      run: s.run.bind(s),
      raw: s.raw.bind(s),
    }) as D1PreparedStatement;
  f.env.DB = {
    prepare(sql: string) {
      const stmt = f.db.prepare(sql);
      if (afterSnapshot && sql.includes('AS snapshot')) return snapshotWrap(stmt);
      if (!sqlPattern.test(sql)) return stmt;
      return wrap(stmt);
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      if (statements.some((s) => unwrapped.has(s))) await fire();
      return f.db.batch<T>(statements.map((s) => unwrapped.get(s) ?? s));
    },
  } as D1Database;
  try {
    const response = await f.request(path, 'GET', cookie);
    if (requireFinal) expect(fired).toBe(true);
    return response;
  } finally {
    f.env.DB = real;
  }
}
const paths = {
  customer: () => `/api/customers/${customer}/renewals?includePolicyId=true`,
  interactions: () => `/api/renewals/${renewal}/interactions`,
  quotes: () => `/api/renewals/${renewal}/quotes`,
};
const queries = {
  customer: /SELECT r\.id,r\.state,r\.version,p\.id AS policyId/,
  interactions: /SELECT i\.id,i\.outcome,i\.channel/,
  quotes: /SELECT version\.id,version\.version_number/,
};
for (const kind of ['customer', 'interactions', 'quotes'] as const) {
  it(`${kind} final read denies a session revoked immediately before disclosure`, async () => {
    const s = await f.session('accept-member');
    expect((await f.request(paths[kind](), 'GET', s.cookie)).status).toBe(200);
    const r = await atDisclosure(
      paths[kind](),
      queries[kind],
      async () => {
        await f.db
          .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
          .bind(Date.now(), s.hash)
          .run();
      },
      s.cookie,
    );
    expect(r.status).toBe(403);
    expect((await r.text()).includes('Sentetik son disclosure notu')).toBe(false);
  });
}
for (const [kind, code] of [
  ['interactions', 'interaction.read'],
  ['quotes', 'quote.read'],
] as const) {
  it(`${kind} final read denies live permission loss even without relying on an epoch bump`, async () => {
    const s = await f.session('accept-member');
    const g = await f.db
      .prepare(
        'SELECT id,scope FROM membership_permissions WHERE membership_id=? AND permission_code=?',
      )
      .bind('membership-accept-member', code)
      .first<{ id: string; scope: string }>();
    expect(g).toBeTruthy();
    try {
      const r = await atDisclosure(
        paths[kind](),
        queries[kind],
        async () => {
          await f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(g!.id).run();
        },
        s.cookie,
      );
      expect(r.status).toBe(403);
    } finally {
      if (
        !(await f.db
          .prepare('SELECT id FROM membership_permissions WHERE id=?')
          .bind(g!.id)
          .first())
      )
        await f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(g!.id, 'membership-accept-member', code, g!.scope)
          .run();
    }
  });
}
it('interaction final read applies live HEALTH classification rather than its preflight GENERAL snapshot', async () => {
  const s = await f.session('accept-member');
  try {
    const r = await atDisclosure(
      paths.interactions(),
      queries.interactions,
      async () => {
        await f.db
          .prepare(
            "UPDATE insurance_branches SET data_classification='HEALTH',version=version+1 WHERE id='accept-b'",
          )
          .run();
      },
      s.cookie,
    );
    expect(r.status).toBe(403);
  } finally {
    await f.db
      .prepare(
        "UPDATE insurance_branches SET data_classification='GENERAL',version=version+1 WHERE id='accept-b'",
      )
      .run();
  }
});
for (const [kind, code] of [
  ['interactions', 'interaction.read'],
  ['quotes', 'quote.read'],
] as const) {
  it(`${kind} refuses dependency scope inversion introduced at final disclosure`, async () => {
    const s = await f.session('accept-member');
    try {
      const r = await atDisclosure(
        paths[kind](),
        queries[kind],
        async () => {
          await f.db
            .prepare(
              "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-accept-member' AND permission_code=?",
            )
            .bind(code)
            .run();
        },
        s.cookie,
      );
      expect((await f.request(paths[kind](), 'GET', s.cookie)).status).toBe(403);
      expect(r.status).toBe(403);
    } finally {
      await f.db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-accept-member' AND permission_code=?",
        )
        .bind(code)
        .run();
    }
  });
}
for (const [kind, code] of [
  ['interactions', 'interaction.read'],
  ['quotes', 'quote.read'],
] as const) {
  it(`${kind} validates the captured grant set itself against A-B-A dependency inversion`, async () => {
    const s = await f.session('accept-member');
    const scope = async (value: string) => {
      await f.db
        .prepare(
          "UPDATE membership_permissions SET scope=? WHERE membership_id='membership-accept-member' AND permission_code=?",
        )
        .bind(value, code)
        .run();
    };
    try {
      await scope('ASSIGNED');
      const r = await atDisclosure(
        paths[kind](),
        queries[kind],
        () => scope('ASSIGNED'),
        s.cookie,
        () => scope('AGENCY'),
        false,
      );
      expect(r.status).toBe(403);
    } finally {
      await scope('AGENCY');
    }
  });
}
for (const kind of ['interactions', 'quotes'] as const) {
  it(`${kind} denies OWNER sensitive HEALTH revocation at populated final batch`, async () => {
    const id = crypto.randomUUID();
    try {
      await f.db.batch([
        f.db
          .prepare(
            "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-accept-owner','sensitive.health.read','UNSCOPED')",
          )
          .bind(id),
        f.db.prepare(
          "UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='accept-b'",
        ),
      ]);
      expect((await f.request(paths[kind](), 'GET', owner)).status).toBe(200);
      const r = await atDisclosure(
        paths[kind](),
        queries[kind],
        async () => {
          await f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(id).run();
        },
        owner,
      );
      expect(r.status).toBe(403);
    } finally {
      await f.db.batch([
        f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(id),
        f.db.prepare(
          "UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='accept-b'",
        ),
      ]);
    }
  });
}
it('populated quote final batch blocks GENERAL to HEALTH transition and rolls assertions back', async () => {
  const s = await f.session('accept-member');
  const before = await f.db.prepare('SELECT count(*) n FROM d1_cas_assertions').first('n');
  try {
    const r = await atDisclosure(
      paths.quotes(),
      queries.quotes,
      async () => {
        await f.db
          .prepare(
            "UPDATE insurance_branches SET data_classification='HEALTH',version=version+1 WHERE id='accept-b'",
          )
          .run();
      },
      s.cookie,
    );
    expect(r.status).toBe(403);
    expect(await f.db.prepare('SELECT count(*) n FROM d1_cas_assertions').first('n')).toBe(before);
  } finally {
    await f.db
      .prepare(
        "UPDATE insurance_branches SET data_classification='GENERAL',version=version+1 WHERE id='accept-b'",
      )
      .run();
  }
});
