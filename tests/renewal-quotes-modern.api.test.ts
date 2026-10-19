// @vitest-environment node
import { beforeAll, afterAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
import type { VersionPayload } from '../src/app/components/RenewalQuoteForm';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  customer = '';
const cookies: Record<string, string> = {};
let serial = 0;
type Result = {
  operationId: string;
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
  status: string;
};
type Quote = {
  id: string;
  version: number;
  status: string;
  current_version_id: string;
  versions: Record<string, unknown>[];
  events: unknown[];
};
type History = { quotes: Quote[]; defaultVersion: VersionPayload };
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function post(path: string, body: unknown, actor = 'qq-owner', key = crypto.randomUUID()) {
  return f.request(path, 'POST', cookies[actor], body, await f.csrf(cookies[actor]!), {
    'idempotency-key': key,
  });
}
const path = (id: string) => `/api/renewals/${id}/quotes`;
async function history(task: TodayTaskDto, actor = 'qq-owner') {
  return data<History>(await f.request(path(task.renewalId), 'GET', cookies[actor]));
}
async function seed(actor = 'qq-ahmet') {
  const p = await data<{ id: string }>(
    await post('/api/policies', {
      customerId: customer,
      insurerId: 'qq-i',
      branchId: 'qq-b',
      productId: 'qq-p',
      paymentMethodId: 'qq-m',
      policyNumber: 'QQ-' + ++serial,
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
      assigneeMembershipId: 'membership-' + actor,
    }),
    201,
  );
  const q = await data<TodayTasksResponseData>(
    await f.request('/api/tasks/today?limit=50', 'GET', cookies['qq-owner']),
  );
  return q.items.find((t) => t.policyId === p.id)!;
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    'renewal_quotes',
    'renewal_quote_versions',
    'renewal_quote_events',
    'operation_receipts',
    'audit_events',
    'renewal_opportunities',
    'tasks',
  ])
    result[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  return JSON.stringify(result);
}
beforeAll(async () => {
  f = await localAuthFixture();
  for (const actor of ['qq-owner', 'qq-ahmet', 'qq-ayse', 'qq-foreign']) {
    const m = await f.seed(
      actor,
      actor === 'qq-owner' || actor === 'qq-foreign' ? 'OWNER' : 'MEMBER',
      false,
      actor === 'qq-foreign' ? 'qq-other-agency' : 'agency-auth-test',
    );
    if (actor === 'qq-ahmet' || actor === 'qq-ayse')
      await f.db.batch(
        createOnboardingTemplateGrants('personel').map((g) =>
          f.db
            .prepare(
              'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
            )
            .bind(crypto.randomUUID(), m.membershipId, g.permission_code, g.scope),
        ),
      );
    cookies[actor] = (await f.session(actor)).cookie;
  }
  customer = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Teklif',
      }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('qq-i','agency-auth-test','QQ','QQ')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('qq-b','agency-auth-test','QQ','QQ','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('qq-p','agency-auth-test','qq-i','qq-b','QQ','QQ')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('qq-m','agency-auth-test','QQ','QQ')",
    ),
    f.db.prepare(
      "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('qq-loss','agency-auth-test','QQ','Sentetik')",
    ),
  ]);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
it.each(['qq-owner', 'qq-ahmet', 'qq-ayse'])(
  'creates from authorized defaults and preserves exact immutable version history for %s',
  async (actor) => {
    const t = await seed(actor),
      first = await history(t, actor),
      version = {
        ...first.defaultVersion,
        grossPremiumMinor: 9007199254740991,
        termsSummary: 'İlk koşul',
      };
    const created = await data<Result>(
      await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version }, actor),
      201,
    );
    expect(created).toMatchObject({ versionNumber: 1, status: 'DRAFT' });
    const q = (await history(t, actor)).quotes.find((q) => q.id === created.quoteId)!;
    const original = JSON.stringify(q.versions);
    const next = await data<Result>(
      await post(
        path(t.renewalId) + '/' + q.id + '/versions',
        {
          expectedQuoteVersion: q.version,
          version: { ...version, grossPremiumMinor: 50, termsSummary: 'Yeni koşul' },
        },
        actor,
      ),
      201,
    );
    expect(next).toMatchObject({ quoteId: q.id, versionNumber: 2, status: 'DRAFT' });
    const fresh = (await history(t, actor)).quotes.find((r) => r.id === q.id)!;
    expect(JSON.stringify(fresh.versions.slice(0, 1))).toBe(original);
    expect(fresh.current_version_id).toBe(next.quoteVersionId);
    expect(fresh.versions[1]).toMatchObject({
      id: next.quoteVersionId,
      version_number: 2,
      gross_premium_minor: 50,
    });
  },
);
it('keeps interaction.read independent of quote.read and quote.manage independent of a successful quote GET', async () => {
  const t = await seed();
  for (const code of ['quote.read', 'quote.manage']) {
    const grants = await f.db
      .prepare(
        "SELECT permission_code,scope FROM membership_permissions WHERE membership_id=? AND (permission_code=? OR (?=1 AND permission_code='quote.manage'))",
      )
      .bind('membership-qq-ahmet', code, code === 'quote.read' ? 1 : 0)
      .all<{ permission_code: string; scope: string }>();
    for (const grant of grants.results)
      await f.db
        .prepare('DELETE FROM membership_permissions WHERE membership_id=? AND permission_code=?')
        .bind('membership-qq-ahmet', grant.permission_code)
        .run();
    try {
      const before = await snapshot();
      if (code === 'quote.read')
        expect([403, 404]).toContain(
          (await f.request(path(t.renewalId), 'GET', cookies['qq-ahmet'])).status,
        );
      else
        expect((await f.request(path(t.renewalId), 'GET', cookies['qq-ahmet'])).status).toBe(200);
      expect(
        (await f.request(`/api/renewals/${t.renewalId}/interactions`, 'GET', cookies['qq-ahmet']))
          .status,
      ).toBe(200);
      expect([403, 404]).toContain(
        (
          await post(
            path(t.renewalId),
            {
              expectedRenewalVersion: t.renewalVersion,
              version: (await history(t)).defaultVersion,
            },
            'qq-ahmet',
          )
        ).status,
      );
      expect(await snapshot()).toBe(before);
    } finally {
      for (const grant of grants.results)
        await f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), 'membership-qq-ahmet', grant.permission_code, grant.scope)
          .run();
    }
  }
});
it('replays exact create/version responses after lost success without duplicate quote/version/audit evidence', async () => {
  const t = await seed(),
    version = (await history(t)).defaultVersion,
    body = { expectedRenewalVersion: t.renewalVersion, version },
    key = crypto.randomUUID();
  const created = await data<Result>(await post(path(t.renewalId), body, 'qq-owner', key), 201),
    before = await snapshot();
  expect(await data(await post(path(t.renewalId), body, 'qq-owner', key), 200)).toEqual(created);
  expect(await snapshot()).toBe(before);
  const url = path(t.renewalId) + '/' + created.quoteId + '/versions',
    payload = { expectedQuoteVersion: 1, version: { ...version, grossPremiumMinor: 51 } },
    versionKey = crypto.randomUUID(),
    result = await data<Result>(await post(url, payload, 'qq-owner', versionKey), 201),
    after = await snapshot();
  expect(await data(await post(url, payload, 'qq-owner', versionKey), 200)).toEqual(result);
  expect(await snapshot()).toBe(after);
});
it('rejects stale renewal CAS separately from quote CAS, expired/invalid dates, mismatched catalogs and installments', async () => {
  const t = await seed(),
    v = (await history(t)).defaultVersion;
  const created = await data<Result>(
    await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version: v }),
    201,
  );
  for (const [url, body] of [
    [path(t.renewalId), { expectedRenewalVersion: t.renewalVersion + 1, version: v }],
    [
      path(t.renewalId) + '/' + created.quoteId + '/versions',
      { expectedQuoteVersion: 2, version: v },
    ],
    [
      path(t.renewalId),
      { expectedRenewalVersion: t.renewalVersion, version: { ...v, startDate: '2026-02-30' } },
    ],
    [
      path(t.renewalId),
      { expectedRenewalVersion: t.renewalVersion, version: { ...v, endDate: v.startDate } },
    ],
    [
      path(t.renewalId),
      {
        expectedRenewalVersion: t.renewalVersion,
        version: { ...v, validUntil: '2020-01-01T00:00:00.000Z' },
      },
    ],
    [
      path(t.renewalId),
      { expectedRenewalVersion: t.renewalVersion, version: { ...v, productId: 'wrong' } },
    ],
    [
      path(t.renewalId),
      { expectedRenewalVersion: t.renewalVersion, version: { ...v, installmentCount: 3 } },
    ],
  ] as const) {
    const before = await snapshot();
    expect([400, 409]).toContain((await post(url, body)).status);
    expect(await snapshot()).toBe(before);
  }
});
it('does not disclose HEALTH, foreign-agency or revoked-session quote data', async () => {
  const t = await seed(),
    v = (await history(t)).defaultVersion;
  expect([403, 404]).toContain(
    (await f.request(path(t.renewalId), 'GET', cookies['qq-foreign'])).status,
  );
  const created = await data<Result>(
      await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version: v }),
      201,
    ),
    tenantBefore = await snapshot();
  expect([403, 404]).toContain(
    (
      await post(
        path(t.renewalId),
        { expectedRenewalVersion: t.renewalVersion, version: v },
        'qq-foreign',
      )
    ).status,
  );
  expect([403, 404]).toContain(
    (
      await post(
        path(t.renewalId) + '/' + created.quoteId + '/versions',
        { expectedQuoteVersion: 1, version: v },
        'qq-foreign',
      )
    ).status,
  );
  expect(await snapshot()).toBe(tenantBefore);
  await f.db
    .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='qq-b'")
    .run();
  try {
    const before = await snapshot();
    expect([403, 404]).toContain(
      (await f.request(path(t.renewalId), 'GET', cookies['qq-owner'])).status,
    );
    expect([403, 404]).toContain(
      (await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version: v }))
        .status,
    );
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db
      .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='qq-b'")
      .run();
  }
  const s = await f.session('qq-ahmet'),
    csrf = await f.csrf(s.cookie);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), s.hash)
    .run();
  expect((await f.request(path(t.renewalId), 'GET', s.cookie)).status).toBe(401);
  expect(
    (
      await f.request(
        path(t.renewalId),
        'POST',
        s.cookie,
        { expectedRenewalVersion: t.renewalVersion, version: v },
        csrf,
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(401);
});
it('rejects quote versions after an authorized terminal LOST renewal without changing immutable history', async () => {
  const t = await seed(),
    v = (await history(t)).defaultVersion,
    q = await data<Result>(
      await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version: v }),
      201,
    );
  await data(
    await post(`/api/renewals/${t.renewalId}/close-lost`, {
      expectedPrimaryTaskId: t.taskId,
      expectedRenewalVersion: t.renewalVersion,
      expectedTaskVersion: t.taskVersion,
      lossReasonId: 'qq-loss',
      lossReasonNotes: null,
    }),
  );
  const before = await snapshot();
  expect(
    (
      await post(path(t.renewalId) + '/' + q.quoteId + '/versions', {
        expectedQuoteVersion: 1,
        version: v,
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
});
it('denies a quote ID from another renewal and preserves current history', async () => {
  const t = await seed(),
    other = await seed(),
    v = (await history(t)).defaultVersion,
    q = await data<Result>(
      await post(path(other.renewalId), {
        expectedRenewalVersion: other.renewalVersion,
        version: v,
      }),
      201,
    ),
    before = await snapshot();
  expect(
    (
      await post(path(t.renewalId) + '/' + q.quoteId + '/versions', {
        expectedQuoteVersion: 1,
        version: v,
      })
    ).status,
  ).toBe(404);
  expect(await snapshot()).toBe(before);
});
it('retains accepted quote evidence through the existing send/WON protocol and rejects further immutable versions', async () => {
  const t = await seed(),
    version = (await history(t)).defaultVersion,
    q = await data<Result>(
      await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version }),
      201,
    );
  await data(
    await post(path(t.renewalId) + '/' + q.quoteId + '/send', {
      expectedQuoteVersion: 1,
      quoteVersionId: q.quoteVersionId,
    }),
    201,
  );
  await data(
    await post(`/api/renewals/${t.renewalId}/close-won`, {
      expectedPrimaryTaskId: t.taskId,
      expectedRenewalVersion: t.renewalVersion,
      expectedTaskVersion: t.taskVersion,
      acceptedQuoteVersionId: q.quoteVersionId,
      result: {
        kind: 'CREATE_POLICY',
        policy: {
          customerId: customer,
          insurerId: version.insurerId,
          productId: version.productId,
          branchId: version.branchId,
          paymentMethodId: version.paymentMethodId,
          policyNumber: 'ACCEPTED-' + ++serial,
          startDate: version.startDate,
          endDate: version.endDate,
          grossPremium: '10.00',
          currency: version.currency,
          installmentCount: null,
        },
      },
    }),
    201,
  );
  const accepted = (await history(t)).quotes.find((r) => r.id === q.quoteId)!;
  expect(accepted.status).toBe('ACCEPTED');
  const before = await snapshot();
  expect(
    (
      await post(path(t.renewalId) + '/' + q.quoteId + '/versions', {
        expectedQuoteVersion: accepted.version,
        version,
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
});
it('preserves the same quote identity by rejecting a different active insurer/product alternative under versions', async () => {
  const t = await seed(),
    version = (await history(t)).defaultVersion,
    q = await data<Result>(
      await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version }),
      201,
    );
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('qq-alternative-i','agency-auth-test','QQALT','Sentetik alternatif')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('qq-alternative-p','agency-auth-test','qq-alternative-i','qq-b','QQALT','Sentetik alternatif ürün')",
    ),
  ]);
  const before = await snapshot();
  const r = await post(path(t.renewalId) + '/' + q.quoteId + '/versions', {
    expectedQuoteVersion: 1,
    version: { ...version, insurerId: 'qq-alternative-i', productId: 'qq-alternative-p' },
  });
  const current = (await history(t)).quotes.find((row) => row.id === q.quoteId)!;
  expect({
    status: r.status,
    versionCount: current.versions.length,
    currentInsurer: current.versions.at(-1)!.insurer_id,
    currentProduct: current.versions.at(-1)!.product_id,
  }).toEqual({
    status: 409,
    versionCount: 1,
    currentInsurer: version.insurerId,
    currentProduct: version.productId,
  });
  expect(await snapshot()).toBe(before);
});
async function barrier<T>(work: () => Promise<T>): Promise<T> {
  // Hold both requests at the final persistence boundary, not a sequential stale-version retry.
  const db = f.env.DB;
  let arrivals = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 7 && arrivals < 2) {
            if (++arrivals === 2) release();
            await gate;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const value = await work();
    expect(arrivals).toBe(2);
    return value;
  } finally {
    f.env.DB = db;
  }
}
it('converges simultaneous same-key quote creation at the atomic batch without duplicate records', async () => {
  const t = await seed(),
    version = (await history(t)).defaultVersion,
    body = { expectedRenewalVersion: t.renewalVersion, version },
    key = crypto.randomUUID();
  const results = await barrier(() =>
    Promise.all([
      post(path(t.renewalId), body, 'qq-owner', key),
      post(path(t.renewalId), body, 'qq-owner', key),
    ]),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
  const values = await Promise.all(results.map((r) => r.json() as Promise<{ data: Result }>));
  expect(values[0]!.data).toEqual(values[1]!.data);
  expect((await history(t)).quotes).toHaveLength(1);
});
it('serializes competing new immutable versions with one winner, unchanged original and no orphan evidence', async () => {
  const t = await seed(),
    version = (await history(t)).defaultVersion,
    q = await data<Result>(
      await post(path(t.renewalId), { expectedRenewalVersion: t.renewalVersion, version }),
      201,
    ),
    original = (await history(t)).quotes[0]!.versions[0],
    url = path(t.renewalId) + '/' + q.quoteId + '/versions';
  const result = await barrier(() =>
    Promise.all([
      post(url, { expectedQuoteVersion: 1, version: { ...version, termsSummary: 'Birinci' } }),
      post(url, { expectedQuoteVersion: 1, version: { ...version, termsSummary: 'İkinci' } }),
    ]),
  );
  expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
  const final = (await history(t)).quotes[0]!;
  expect(final.versions).toHaveLength(2);
  expect(final.versions[0]).toEqual(original);
  await expect(
    f.db
      .prepare("UPDATE renewal_quote_versions SET terms_summary='overwrite' WHERE id=?")
      .bind(q.quoteVersionId)
      .run(),
  ).rejects.toThrow('IMMUTABLE');
  await expect(
    f.db.prepare('DELETE FROM renewal_quote_versions WHERE id=?').bind(q.quoteVersionId).run(),
  ).rejects.toThrow('IMMUTABLE');
});
