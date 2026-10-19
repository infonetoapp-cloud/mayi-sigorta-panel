// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { z } from 'zod';
import { createRenewalQuoteVersionSchema } from '../src/server/renewals/validation';
import { computePayloadHash } from '../src/server/mutations/canonical';
import type { TodayTasksResponseData } from '../src/shared/types';
import { localAuthFixture } from './support/local-auth-fixture';

type Version = z.infer<typeof createRenewalQuoteVersionSchema>['version'];
type Result = {
  operationId: string;
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
};
type Quote = {
  id: string;
  version: number;
  current_version_id: string;
  versions: Record<string, unknown>[];
};
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let cookie = '',
  customerId = '',
  serial = 0;
const agencyId = 'agency-auth-test';
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}
async function post(url: string, body: unknown, key = crypto.randomUUID()) {
  return f.request(url, 'POST', cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}
async function seed() {
  const policy = await data<{ id: string }>(
    await post('/api/policies', {
      customerId,
      insurerId: 'qi-i',
      productId: 'qi-p',
      branchId: 'qi-b',
      paymentMethodId: 'qi-m',
      policyNumber: `QI-${++serial}`,
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
      assigneeMembershipId: 'membership-qi-owner',
    }),
    201,
  );
  const tasks = await data<TodayTasksResponseData>(
    await f.request('/api/tasks/today?limit=50', 'GET', cookie),
  );
  const task = tasks.items.find((item) => item.policyId === policy.id)!;
  const url = `/api/renewals/${task.renewalId}/quotes`;
  const history = await data<{ defaultVersion: Version }>(await f.request(url, 'GET', cookie));
  const version = history.defaultVersion;
  const quote = await data<Result>(
    await post(url, { expectedRenewalVersion: task.renewalVersion, version }),
    201,
  );
  return { url, version, quote, task, versionsUrl: `${url}/${quote.quoteId}/versions` };
}
async function quotes(url: string) {
  return (await data<{ quotes: Quote[] }>(await f.request(url, 'GET', cookie))).quotes;
}
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const table of [
    'renewal_quotes',
    'renewal_quote_versions',
    'renewal_quote_events',
    'operation_receipts',
    'audit_events',
    'renewal_opportunities',
    'tasks',
    'd1_cas_assertions',
  ])
    state[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  return JSON.stringify(state);
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('qi-owner', 'OWNER');
  cookie = (await f.session('qi-owner')).cookie;
  customerId = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Kimlik',
      }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db
      .prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('qi-i',?,'QI','Sentetik'),('qi-alt-i',?,'QI_ALT','Alternatif')",
      )
      .bind(agencyId, agencyId),
    f.db
      .prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('qi-b',?,'QI','Sentetik','GENERAL')",
      )
      .bind(agencyId),
    f.db
      .prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('qi-p',?,'qi-i','qi-b','QI','İlk'),('qi-sibling-p',?,'qi-i','qi-b','QI_SIB','Diğer ürün'),('qi-alt-p',?,'qi-alt-i','qi-b','QI_ALT','Alternatif')",
      )
      .bind(agencyId, agencyId, agencyId),
    f.db
      .prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('qi-m',?,'QI','Sentetik')",
      )
      .bind(agencyId),
    f.db
      .prepare(
        "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('qi-loss',?,'QI','Sentetik')",
      )
      .bind(agencyId),
  ]);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});

it.each([
  { insurerId: 'qi-alt-i', productId: 'qi-alt-p' },
  { insurerId: 'qi-i', productId: 'qi-sibling-p' },
  { insurerId: 'qi-alt-i', productId: 'qi-p' },
])('rejects changed offer identity without any persisted effect: %j', async (identity) => {
  const s = await seed(),
    before = await snapshot();
  expect(
    (await post(s.versionsUrl, { expectedQuoteVersion: 1, version: { ...s.version, ...identity } }))
      .status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
});

it('allows same-identity revisions and independent Quotes for both different alternatives', async () => {
  const s = await seed(),
    original = (await quotes(s.url))[0]!.versions[0];
  const revised = await data<Result>(
    await post(s.versionsUrl, {
      expectedQuoteVersion: 1,
      version: { ...s.version, grossPremiumMinor: 1250, termsSummary: 'Revizyon' },
    }),
    201,
  );
  expect(revised).toMatchObject({ quoteId: s.quote.quoteId, versionNumber: 2 });
  for (const identity of [
    { insurerId: 'qi-alt-i', productId: 'qi-alt-p' },
    { insurerId: 'qi-i', productId: 'qi-sibling-p' },
  ]) {
    const alternative = await data<Result>(
      await post(s.url, {
        expectedRenewalVersion: s.task.renewalVersion,
        version: { ...s.version, ...identity },
      }),
      201,
    );
    expect(alternative.quoteId).not.toBe(s.quote.quoteId);
    expect(alternative.versionNumber).toBe(1);
  }
  const rows = await quotes(s.url);
  expect(rows).toHaveLength(3);
  const q = rows.find((row) => row.id === s.quote.quoteId)!;
  expect(q.versions).toHaveLength(2);
  expect(q.versions[0]).toEqual(original);
  expect(q.current_version_id).toBe(revised.quoteVersionId);
});

it.each(['insurer', 'product', 'missing'] as const)(
  'uses a real atomic assertion after a misleading %s preflight read',
  async (kind) => {
    const s = await seed();
    const identity =
      kind === 'product'
        ? { insurerId: 'qi-i', productId: 'qi-sibling-p' }
        : { insurerId: 'qi-alt-i', productId: 'qi-alt-p' };
    const db = f.env.DB;
    let reads = 0,
      batches = 0;
    // Only the preflight SELECT is fault-injected. Every batch statement runs unchanged on real D1.
    f.env.DB = new Proxy(db, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            if (sql.includes('SELECT insurer_id,product_id FROM renewal_quote_versions')) {
              return {
                bind: () => ({
                  first: async () => {
                    reads++;
                    return { insurer_id: identity.insurerId, product_id: identity.productId };
                  },
                }),
              };
            }
            return target.prepare(sql);
          };
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length >= 7) batches++;
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // For missing original evidence, hide only v1 from the assertion's actual DB view by using
    // an empty Quote created directly; no immutable rows or security triggers are modified.
    let url = s.versionsUrl;
    if (kind === 'missing') {
      const emptyId = crypto.randomUUID();
      await f.db
        .prepare(
          `INSERT INTO renewal_quotes(id,agency_id,renewal_id,status,version,created_by_user_id,created_by_membership_id)
      VALUES(?,?,?,'DRAFT',1,'qi-owner','membership-qi-owner')`,
        )
        .bind(emptyId, agencyId, s.task.renewalId)
        .run();
      url = `${s.url}/${emptyId}/versions`;
    }
    const before = await snapshot();
    try {
      expect(
        (await post(url, { expectedQuoteVersion: 1, version: { ...s.version, ...identity } }))
          .status,
      ).toBe(409);
      expect(reads).toBe(1);
      expect(batches).toBe(1);
      expect(await snapshot()).toBe(before);
    } finally {
      f.env.DB = db;
    }
  },
);

it('pins to v1 rather than a divergent historical latest/current version', async () => {
  const s = await seed(),
    divergentId = crypto.randomUUID();
  const legacyKey = crypto.randomUUID(),
    operationId = crypto.randomUUID();
  const legacyInput = {
    expectedQuoteVersion: 1,
    version: { ...s.version, insurerId: 'qi-alt-i', productId: 'qi-alt-p' },
  };
  const legacyResult = {
    operationId,
    quoteId: s.quote.quoteId,
    quoteVersionId: divergentId,
    versionNumber: 2,
    status: 'DRAFT',
  };
  const fingerprint = await computePayloadHash({
    action: 'renewal.quote.version.create',
    renewalId: s.task.renewalId,
    quoteId: s.quote.quoteId,
    input: legacyInput,
  });
  const now = new Date().toISOString();
  // Characterize a legacy row allowed by the old backend; do not rewrite immutable history.
  await f.db.batch([
    f.db
      .prepare(
        `INSERT INTO renewal_quote_versions
      (id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at)
      SELECT ?,agency_id,quote_id,2,'qi-alt-i','qi-alt-p',branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at
      FROM renewal_quote_versions WHERE id=?`,
      )
      .bind(divergentId, s.quote.quoteVersionId),
    f.db
      .prepare('UPDATE renewal_quotes SET current_version_id=?,version=2 WHERE id=?')
      .bind(divergentId, s.quote.quoteId),
    f.db
      .prepare(
        `INSERT INTO operation_receipts
      (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at)
      VALUES(?,?,'qi-owner','membership-qi-owner','renewal.quote.version.create',?,?,'COMPLETED',201,?,?,?)`,
      )
      .bind(operationId, agencyId, legacyKey, fingerprint, JSON.stringify(legacyResult), now, now),
  ]);
  const before = await snapshot();
  expect(await data<Result>(await post(s.versionsUrl, legacyInput, legacyKey))).toEqual(
    legacyResult,
  );
  expect(await snapshot()).toBe(before);
  expect(
    (
      await post(s.versionsUrl, {
        expectedQuoteVersion: 2,
        version: { ...s.version, insurerId: 'qi-alt-i', productId: 'qi-alt-p' },
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
  const result = await data<Result>(
    await post(s.versionsUrl, { expectedQuoteVersion: 2, version: s.version }),
    201,
  );
  expect(result.versionNumber).toBe(3);
  const q = (await quotes(s.url))[0]!;
  expect(q.versions[1]).toMatchObject({ id: divergentId, insurer_id: 'qi-alt-i' });
  expect(q.versions[2]).toMatchObject({ insurer_id: 'qi-i', product_id: 'qi-p' });
});

it('replays exact historical receipts before mutable lifecycle/catalog checks and rejects changed-key payloads', async () => {
  const s = await seed(),
    key = crypto.randomUUID();
  const payload = { expectedQuoteVersion: 1, version: { ...s.version, grossPremiumMinor: 1234 } };
  const result = await data<Result>(await post(s.versionsUrl, payload, key), 201);
  await data(
    await post(s.versionsUrl, {
      expectedQuoteVersion: 2,
      version: { ...s.version, grossPremiumMinor: 2345 },
    }),
    201,
  );
  await data(
    await post(`/api/renewals/${s.task.renewalId}/close-lost`, {
      expectedRenewalVersion: s.task.renewalVersion,
      expectedTaskVersion: s.task.taskVersion,
      lossReasonId: 'qi-loss',
      lossReasonNotes: null,
    }),
  );
  await f.db.prepare("UPDATE insurance_products SET status='INACTIVE' WHERE id='qi-p'").run();
  try {
    const before = await snapshot();
    expect(await data<Result>(await post(s.versionsUrl, payload, key))).toEqual(result);
    expect(
      (
        await post(
          s.versionsUrl,
          { ...payload, version: { ...payload.version, productId: 'qi-sibling-p' } },
          key,
        )
      ).status,
    ).toBe(409);
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db.prepare("UPDATE insurance_products SET status='ACTIVE' WHERE id='qi-p'").run();
  }
});

async function race(work: () => Promise<Response[]>) {
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
    const responses = await work();
    expect(arrivals).toBe(2);
    return responses;
  } finally {
    f.env.DB = db;
  }
}
async function counts() {
  const values: Record<string, number> = {};
  for (const table of ['renewal_quote_versions', 'operation_receipts', 'audit_events'])
    values[table] = (await f.db
      .prepare(`SELECT count(*) AS n FROM ${table}`)
      .first<{ n: number }>())!.n;
  return values;
}
it.each([true, false])(
  'preserves atomic version races and exact concurrent receipts (same key: %s)',
  async (sameKey) => {
    const s = await seed(),
      key = crypto.randomUUID(),
      before = await counts();
    const body = { expectedQuoteVersion: 1, version: { ...s.version, grossPremiumMinor: 3456 } };
    const responses = await race(() =>
      Promise.all([
        post(s.versionsUrl, body, key),
        post(
          s.versionsUrl,
          sameKey ? body : { ...body, version: { ...body.version, grossPremiumMinor: 4567 } },
          sameKey ? key : crypto.randomUUID(),
        ),
      ]),
    );
    expect(responses.map((r) => r.status).sort()).toEqual(sameKey ? [200, 201] : [201, 409]);
    if (sameKey) {
      const first = (await responses[0]!.json()) as { data: Result };
      const second = (await responses[1]!.json()) as { data: Result };
      expect(first.data).toEqual(second.data);
    }
    const after = await counts();
    for (const table of Object.keys(before)) expect(after[table]).toBe(before[table]! + 1);
    const q = (await quotes(s.url))[0]!;
    expect(q.version).toBe(2);
    expect(q.versions).toHaveLength(2);
  },
);
