// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setTimeout } from 'node:timers/promises';
import { localAuthFixture } from './support/local-auth-fixture';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  cookie = '';
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function post(url: string, body: unknown, key: string = crypto.randomUUID()) {
  return f.request(url, 'POST', cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('wa-owner', 'OWNER');
  cookie = (await f.session('wa-owner')).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('wa-i','agency-auth-test','WA','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('wa-b','agency-auth-test','WA','Sentetik','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('wa-p','agency-auth-test','wa-i','wa-b','WA','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('wa-m','agency-auth-test','WA','Sentetik')",
    ),
  ]);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function snapshot() {
  const s: Record<string, unknown> = {};
  for (const t of [
    'renewal_opportunities',
    'tasks',
    'renewal_quotes',
    'renewal_quote_versions',
    'renewal_quote_events',
    'renewal_policy_links',
    'operation_receipts',
    'audit_events',
    'policies',
    'd1_cas_assertions',
  ])
    s[t] = (await f.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results;
  return JSON.stringify(s);
}
async function setup() {
  const customer = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Kabul Süresi',
      }),
      201,
    )
  ).id;
  const common = {
    customerId: customer,
    insurerId: 'wa-i',
    productId: 'wa-p',
    branchId: 'wa-b',
    paymentMethodId: 'wa-m',
    grossPremium: '10.00',
    currency: 'TRY',
    installmentCount: null,
    assigneeMembershipId: 'membership-wa-owner',
  };
  const old = await data<{ id: string }>(
    await post('/api/policies', {
      ...common,
      policyNumber: 'WA-OLD',
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    }),
    201,
  );
  const task = (
    await data<TodayTasksResponseData>(await f.request('/api/tasks/today?limit=50', 'GET', cookie))
  ).items.find((t) => t.policyId === old.id)!;
  expect(task).toBeTruthy();
  const root = `/api/renewals/${task.renewalId}/quotes`;
  const h = await data<{
    defaultVersion: { startDate: string; endDate: string; [key: string]: unknown };
  }>(await f.request(root, 'GET', cookie));
  const policy = await data<{ id: string; version: number }>(
    await post('/api/policies', {
      ...common,
      policyNumber: 'WA-NEW',
      startDate: h.defaultVersion.startDate,
      endDate: h.defaultVersion.endDate,
    }),
    201,
  );
  const validUntil = new Date(Date.now() + 60000).toISOString();
  const q = await data<{ quoteId: string; quoteVersionId: string }>(
    await post(root, {
      expectedRenewalVersion: task.renewalVersion,
      version: { ...h.defaultVersion, grossPremiumMinor: 1000, currency: 'TRY', validUntil },
    }),
    201,
  );
  await data(
    await post(`${root}/${q.quoteId}/send`, {
      expectedQuoteVersion: 1,
      quoteVersionId: q.quoteVersionId,
    }),
    201,
  );
  return { task, policy, q, validUntil };
}
it('rejects selected SENT quote expiry after WON LINK_POLICY preflight at the real atomic D1 boundary and rolls back every effect', async () => {
  const { task, policy, q, validUntil } = await setup(),
    key = crypto.randomUUID(),
    before = await snapshot(),
    db = f.env.DB;
  let reached = false,
    sqliteNow = '',
    sqlExpired = false;
  f.env.DB = new Proxy(db, {
    get(target, k) {
      if (k === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 12 && !reached) {
            reached = true;
            expect(Date.now()).toBeLessThan(Date.parse(validUntil));
            await setTimeout(Math.max(0, Date.parse(validUntil) - Date.now() + 150));
            const clock = await f.db
              .prepare(
                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now,CASE WHEN ?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END AS expired",
              )
              .bind(validUntil)
              .first<{ now: string; expired: number }>();
            sqliteNow = clock!.now;
            sqlExpired = clock!.expired === 1;
            expect(sqlExpired).toBe(true);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, k, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let response: Response;
  try {
    response = await post(
      `/api/renewals/${task.renewalId}/close-won`,
      {
        expectedPrimaryTaskId: task.taskId,
        expectedRenewalVersion: task.renewalVersion,
        expectedTaskVersion: task.taskVersion,
        acceptedQuoteVersionId: q.quoteVersionId,
        result: {
          kind: 'LINK_POLICY',
          newPolicyId: policy.id,
          expectedPolicyVersion: policy.version,
          allocatedNewPremiumMinor: 1000,
          currency: 'TRY',
        },
      },
      key,
    );
  } finally {
    f.env.DB = db;
  }
  expect(reached).toBe(true);
  const actual = await observe(task, q.quoteId, key);
  const unchanged = (await snapshot()) === before;
  expect(
    { httpStatus: response.status, sqlExpired, sqliteNow, validUntil, unchanged, ...actual },
    JSON.stringify({
      httpStatus: response.status,
      sqlExpired,
      sqliteNow,
      validUntil,
      unchanged,
      ...actual,
    }),
  ).toMatchObject({
    httpStatus: 409,
    sqlExpired: true,
    unchanged: true,
    renewal: { state: 'CONTACT_PENDING', version: task.renewalVersion },
    task: { status: 'OPEN', version: task.taskVersion },
    quote: { status: 'SENT', version: 2, accepted_version_id: null },
    links: 0,
    acceptedEvents: 0,
    receipts: 0,
    successAudits: 0,
  });
}, 180000);
async function observe(t: TodayTaskDto, quoteId: string, key: string) {
  const n = async (sql: string, ...values: string[]) =>
    (await f.db
      .prepare(sql)
      .bind(...values)
      .first<{ n: number }>())!.n;
  return {
    renewal: await f.db
      .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
      .bind(t.renewalId)
      .first(),
    task: await f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(t.taskId).first(),
    quote: await f.db
      .prepare('SELECT status,version,accepted_version_id FROM renewal_quotes WHERE id=?')
      .bind(quoteId)
      .first(),
    links: await n('SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=?', t.renewalId),
    acceptedEvents: await n(
      "SELECT count(*) n FROM renewal_quote_events WHERE quote_id=? AND event='ACCEPTED'",
      quoteId,
    ),
    receipts: await n('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?', key),
    successAudits: await n(
      "SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'",
      key,
    ),
  };
}
