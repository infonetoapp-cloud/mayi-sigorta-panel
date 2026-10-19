// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { z } from 'zod';
import { createRenewalQuoteVersionSchema } from '../src/server/renewals/validation';
import type { TodayTasksResponseData } from '../src/shared/types';
import { localAuthFixture } from './support/local-auth-fixture';

type Version = z.infer<typeof createRenewalQuoteVersionSchema>['version'];
type Result = {
  operationId: string;
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
};
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  cookie = '',
  customerId = '',
  serial = 0,
  assertionSql = '';
const agency = 'agency-auth-test';
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function post(url: string, body: unknown, key = crypto.randomUUID()) {
  return f.request(url, 'POST', cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}
async function seed() {
  const policy = await data<{ id: string }>(
    await post('/api/policies', {
      customerId,
      insurerId: 'qe-i',
      productId: 'qe-p',
      branchId: 'qe-b',
      paymentMethodId: 'qe-m',
      policyNumber: `QE-${++serial}`,
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
      assigneeMembershipId: 'membership-qe-owner',
    }),
    201,
  );
  const task = (
    await data<TodayTasksResponseData>(await f.request('/api/tasks/today?limit=50', 'GET', cookie))
  ).items.find((t) => t.policyId === policy.id)!;
  const root = `/api/renewals/${task.renewalId}/quotes`;
  const version = (await data<{ defaultVersion: Version }>(await f.request(root, 'GET', cookie)))
    .defaultVersion;
  const quote = await data<Result>(
    await post(root, { expectedRenewalVersion: task.renewalVersion, version }),
    201,
  );
  return {
    root,
    task,
    quote,
    version,
    url: `${root}/${quote.quoteId}/send`,
    body: { expectedQuoteVersion: 1, quoteVersionId: quote.quoteVersionId },
  };
}
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const t of [
    'renewal_quotes',
    'renewal_quote_versions',
    'renewal_quote_events',
    'operation_receipts',
    'audit_events',
    'd1_cas_assertions',
  ])
    state[t] = (await f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results;
  return JSON.stringify(state);
}
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
function boundAssertion(bindings: string[]) {
  let i = 0;
  const sql = assertionSql.replaceAll('?', () => literal(bindings[i++]!));
  expect(i).toBe(bindings.length);
  return sql;
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('qe-owner', 'OWNER');
  cookie = (await f.session('qe-owner')).cookie;
  customerId = (
    await data<{ id: string }>(
      await post('/api/customers', { type: 'INDIVIDUAL', firstName: 'Sentetik', lastName: 'Süre' }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('qe-i','agency-auth-test','QE','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('qe-b','agency-auth-test','QE','Sentetik','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('qe-p','agency-auth-test','qe-i','qe-b','QE','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('qe-m','agency-auth-test','QE','Sentetik')",
    ),
  ]);
  // Capture the exact production assertion, not a test reimplementation of its condition.
  const db = f.env.DB;
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (sql.includes("END,'RENEWAL_QUOTE_EXPIRED'")) assertionSql = sql;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const s = await seed();
    await data(await post(s.url, s.body), 201);
    expect(assertionSql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  } finally {
    f.env.DB = db;
  }
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});

it('rolls back expiry crossed between successful preflight and the final real D1 batch', async () => {
  const s = await seed(),
    until = new Date(Date.now() + 30000).toISOString();
  const version = await data<Result>(
    await post(`${s.root}/${s.quote.quoteId}/versions`, {
      expectedQuoteVersion: 1,
      version: { ...s.version, validUntil: until },
    }),
    201,
  );
  const db = f.env.DB,
    before = await snapshot();
  let held = false;
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 7 && !held) {
            held = true;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, Date.parse(until) - Date.now() + 100)),
            );
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    expect(
      (await post(s.url, { expectedQuoteVersion: 2, quoteVersionId: version.quoteVersionId }))
        .status,
    ).toBe(409);
    expect(held).toBe(true);
    expect(await snapshot()).toBe(before);
  } finally {
    f.env.DB = db;
  }
}, 60000);
it.each([-1, 0, 1])(
  'uses strict SQL-clock millisecond validity at now %+d ms in one real SQLite step',
  async (offset) => {
    const s = await seed(),
      versionId = crypto.randomUUID(),
      trigger = 'qe_boundary_' + serial;
    const check = boundAssertion([
      crypto.randomUUID(),
      agency,
      s.task.renewalId,
      s.quote.quoteId,
      versionId,
    ]);
    // A trigger is one sqlite3_step: every 'now' is identical. The immutable version is
    // inserted using the real DB clock +/-1ms, then the UNCHANGED production assertion runs.
    // No clock mock, predicate substitution, disabled guard or mutable historical version.
    await f.db
      .prepare(
        `CREATE TRIGGER ${trigger} AFTER INSERT ON qe_boundary_control BEGIN
    INSERT INTO renewal_quote_versions
      (id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at)
    SELECT ${literal(versionId)},agency_id,quote_id,2,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,
      strftime('%Y-%m-%dT%H:%M:%fZ','now','${offset >= 0 ? '+' : ''}${offset / 1000} seconds'),gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at
    FROM renewal_quote_versions WHERE id=${literal(s.quote.quoteVersionId)};
    UPDATE renewal_quotes SET current_version_id=${literal(versionId)} WHERE id=${literal(s.quote.quoteId)};
    ${check};
    INSERT INTO qe_boundary_observation(valid_until,db_now) SELECT valid_until,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM renewal_quote_versions WHERE id=${literal(versionId)};
  END`,
      )
      .run();
    const before = await snapshot();
    try {
      if (offset <= 0) {
        await expect(
          f.db.prepare('INSERT INTO qe_boundary_control DEFAULT VALUES').run(),
        ).rejects.toThrow('OPTIMISTIC_CONCURRENCY');
        expect(await snapshot()).toBe(before);
      } else {
        await f.db.prepare('INSERT INTO qe_boundary_control DEFAULT VALUES').run();
        const row = await f.db
          .prepare(
            'SELECT valid_until,db_now FROM qe_boundary_observation ORDER BY rowid DESC LIMIT 1',
          )
          .first<{ valid_until: string; db_now: string }>();
        expect(Date.parse(row!.valid_until) - Date.parse(row!.db_now)).toBe(1);
        expect(row!.valid_until).toMatch(/\.\d{3}Z$/);
      }
      expect(
        (await f.db.prepare('SELECT count(*) AS n FROM d1_cas_assertions').first<{ n: number }>())!
          .n,
      ).toBe(0);
    } finally {
      await f.db.prepare(`DROP TRIGGER ${trigger}`).run();
    }
  },
);
beforeAll(async () => {
  await f.db.prepare('CREATE TABLE qe_boundary_control(id INTEGER PRIMARY KEY)').run();
  await f.db.prepare('CREATE TABLE qe_boundary_observation(valid_until TEXT,db_now TEXT)').run();
});

it.each(['bad-agency', 'bad-renewal', 'bad-quote', 'missing-version', 'historical-version'])(
  'fails closed for %s in the exact bound production assertion',
  async (kind) => {
    const s = await seed();
    const versionId = s.quote.quoteVersionId;
    if (kind === 'historical-version') {
      const next = await data<Result>(
        await post(`${s.root}/${s.quote.quoteId}/versions`, {
          expectedQuoteVersion: 1,
          version: s.version,
        }),
        201,
      );
      expect(next.quoteVersionId).not.toBe(versionId);
    }
    const before = await snapshot();
    await expect(
      f.db
        .prepare(assertionSql)
        .bind(
          crypto.randomUUID(),
          kind === 'bad-agency' ? 'other-agency' : agency,
          kind === 'bad-renewal' ? 'other-renewal' : s.task.renewalId,
          kind === 'bad-quote' ? 'other-quote' : s.quote.quoteId,
          kind === 'missing-version' ? 'missing-version' : versionId,
        )
        .run(),
    ).rejects.toThrow('OPTIMISTIC_CONCURRENCY');
    expect(await snapshot()).toBe(before);
  },
);
it.each([
  'invalid',
  '2099-02-30T00:00:00.000Z',
  '2099-01-01T00:00:00Z',
  '2099-01-01T03:00:00.000+03:00',
])(
  'rejects invalid/noncanonical persisted validity %s before any business effect',
  async (validity) => {
    const s = await seed(),
      v = crypto.randomUUID();
    await f.db.batch([
      f.db
        .prepare(
          `INSERT INTO renewal_quote_versions
      (id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at)
      SELECT ?,agency_id,quote_id,2,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,?,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at FROM renewal_quote_versions WHERE id=?`,
        )
        .bind(v, validity, s.quote.quoteVersionId),
      f.db
        .prepare('UPDATE renewal_quotes SET current_version_id=?,version=2 WHERE id=?')
        .bind(v, s.quote.quoteId),
    ]);
    const before = await snapshot();
    expect((await post(s.url, { expectedQuoteVersion: 2, quoteVersionId: v })).status).toBe(409);
    expect(await snapshot()).toBe(before);
  },
);
it('replays committed SENT after real expiry but rejects a fresh key and changed same-key payload with no new effects', async () => {
  const s = await seed(),
    id = crypto.randomUUID(),
    until = new Date(Date.now() + 30000).toISOString();
  await data(
    await post(`${s.root}/${s.quote.quoteId}/versions`, {
      expectedQuoteVersion: 1,
      version: { ...s.version, validUntil: until },
    }),
    201,
  );
  const h = await data<{ quotes: { current_version_id: string }[] }>(
    await f.request(s.root, 'GET', cookie),
  );
  const body = { expectedQuoteVersion: 2, quoteVersionId: h.quotes[0]!.current_version_id };
  const result = await data<Result>(await post(s.url, body, id), 201);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Date.parse(until) - Date.now() + 100)),
  );
  const before = await snapshot();
  expect(await data<Result>(await post(s.url, body, id))).toEqual(result);
  expect((await post(s.url, { ...body, expectedQuoteVersion: 3 }, id)).status).toBe(409);
  expect((await post(s.url, { ...body, expectedQuoteVersion: 3 })).status).toBe(409);
  expect(await snapshot()).toBe(before);
}, 60000);

async function competing(work: () => Promise<Response[]>) {
  const db = f.env.DB;
  let arrived = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 7 && arrived < 2) {
            if (++arrived === 2) release();
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
    expect(arrived).toBe(2);
    return responses;
  } finally {
    f.env.DB = db;
  }
}
it.each(['same-key', 'different-key', 'new-version'])(
  'preserves final-batch competing %s operations with exactly one effect/receipt/audit',
  async (kind) => {
    const s = await seed(),
      key = crypto.randomUUID();
    const before = JSON.parse(await snapshot()) as Record<string, unknown[]>;
    const responses = await competing(() =>
      Promise.all([
        post(s.url, s.body, key),
        kind === 'new-version'
          ? post(`${s.root}/${s.quote.quoteId}/versions`, {
              expectedQuoteVersion: 1,
              version: s.version,
            })
          : post(s.url, s.body, kind === 'same-key' ? key : crypto.randomUUID()),
      ]),
    );
    expect(responses.map((r) => r.status).sort()).toEqual(
      kind === 'same-key' ? [200, 201] : [201, 409],
    );
    if (kind === 'same-key') {
      const a = (await responses[0]!.json()) as { data: Result },
        b = (await responses[1]!.json()) as { data: Result };
      expect(a.data).toEqual(b.data);
    }
    const after = JSON.parse(await snapshot()) as Record<string, unknown[]>;
    expect(after.operation_receipts!.length).toBe(before.operation_receipts!.length + 1);
    expect(after.audit_events!.length).toBe(before.audit_events!.length + 1);
    expect(after.d1_cas_assertions).toEqual([]);
    const q = (
      await data<{
        quotes: { status: string; version: number; versions: unknown[]; events: unknown[] }[];
      }>(await f.request(s.root, 'GET', cookie))
    ).quotes[0]!;
    expect(q.version).toBe(2);
    if (q.status === 'SENT') {
      expect(q.events).toHaveLength(1);
      expect(q.versions).toHaveLength(1);
    } else {
      expect(q.status).toBe('DRAFT');
      expect(q.events).toHaveLength(0);
      expect(q.versions).toHaveLength(2);
    }
  },
);
