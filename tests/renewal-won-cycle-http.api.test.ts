// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';

import { localAuthFixture } from './support/local-auth-fixture';
import type { TodayTasksResponseData } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  cookie = '';
let serial = 0;
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
    'renewal_state_history',
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
async function setup(validityMs = 120000) {
  const number = ++serial;
  const customer = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Kabul Süresi',
        insurerNumber: { insurerId: 'wa-i', customerNumber: `WA-CUSTOMER-${number}` },
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
      policyNumber: 'WA-OLD-' + number,
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
      policyNumber: 'WA-NEW-' + number,
      startDate: h.defaultVersion.startDate,
      endDate: h.defaultVersion.endDate,
    }),
    201,
  );
  const validUntil = new Date(Date.now() + validityMs).toISOString();
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
  return { task, policy, q, validUntil, common, h, root };
}

function body(s: Awaited<ReturnType<typeof setup>>, kind = 'LINK_POLICY', associate = true) {
  return {
    expectedPrimaryTaskId: s.task.taskId,
    expectedRenewalVersion: s.task.renewalVersion,
    expectedTaskVersion: s.task.taskVersion,
    ...(associate ? { acceptedQuoteVersionId: s.q.quoteVersionId } : {}),
    result:
      kind === 'CREATE_POLICY'
        ? {
            kind,
            policy: {
              ...s.common,
              policyNumber: 'WA-CREATED-' + serial,
              startDate: s.h.defaultVersion.startDate,
              endDate: s.h.defaultVersion.endDate,
            },
          }
        : kind === 'EXISTING_LINKS'
          ? { kind }
          : {
              kind: 'LINK_POLICY',
              newPolicyId: s.policy.id,
              expectedPolicyVersion: s.policy.version,
              allocatedNewPremiumMinor: 1000,
              currency: 'TRY',
            },
  };
}

it.each(['self', 'stale-policy', 'wrong-customer', 'incomplete', 'overflow'])(
  'rejects invalid LINK_POLICY target %s atomically with HTTP409',
  async (kind) => {
    const s = await setup(),
      b = body(s) as {
        quoteDifferenceReasonCode?: 'CUSTOMER_CONFIRMED';
        result: {
          newPolicyId: string;
          expectedPolicyVersion: number;
          allocatedNewPremiumMinor: number;
        };
      };
    if (kind === 'self') {
      b.result.newPolicyId = s.task.policyId!;
      b.quoteDifferenceReasonCode = 'CUSTOMER_CONFIRMED';
    }
    if (kind === 'stale-policy') b.result.expectedPolicyVersion = 999;
    if (kind === 'incomplete') b.result.allocatedNewPremiumMinor = 1;
    if (kind === 'overflow') b.result.allocatedNewPremiumMinor = 1001;
    if (kind === 'wrong-customer') {
      const c = await data<{ id: string }>(
        await post('/api/customers', {
          type: 'INDIVIDUAL',
          firstName: 'Diğer',
          lastName: 'Sentetik',
          insurerNumber: { insurerId: 'wa-i', customerNumber: `WA-OTHER-${serial}` },
        }),
        201,
      );
      const p = await data<{ id: string }>(
        await post('/api/policies', {
          ...s.common,
          customerId: c.id,
          policyNumber: 'OTHER-' + serial,
          startDate: s.h.defaultVersion.startDate,
          endDate: s.h.defaultVersion.endDate,
        }),
        201,
      );
      b.result.newPolicyId = p.id;
    }
    const before = await snapshot(),
      r = await post(`/api/renewals/${s.task.renewalId}/close-won`, b);
    expect(r.status, await r.clone().text()).toBe(409);
    const envelope = (await r.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe(
      kind === 'self'
        ? 'WON_ALLOCATION_INVALID'
        : kind === 'incomplete' || kind === 'overflow'
          ? 'WON_ALLOCATION_INCOMPLETE'
          : 'WON_POLICY_TARGET_INVALID',
    );
    expect(envelope.error.message).toBe('Kayıt güncel değil veya işlem çakıştı.');
    expect(await snapshot()).toBe(before);
  },
);
it('rejects a cyclic LINK_POLICY through the real route with a definitive conflict and full rollback', async () => {
  const s = await setup(),
    r = crypto.randomUUID(),
    t = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.batch([
    f.db
      .prepare(
        `INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
    VALUES(?,'agency-auth-test',?,'membership-wa-owner','CONTACT_PENDING',1,?,?)`,
      )
      .bind(r, s.policy.id, now, now),
    f.db
      .prepare(
        `INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
    VALUES(?,'agency-auth-test',?,NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
      )
      .bind(crypto.randomUUID(), r, now),
    f.db
      .prepare(
        `INSERT INTO tasks(id,agency_id,customer_id,policy_id,renewal_id,kind,title,due_at,assignee_membership_id,status,actor_kind,version,created_at,updated_at)
    VALUES(?,'agency-auth-test',?,NULL,?,'RENEWAL_FOLLOWUP','Sentetik döngü',?,'membership-wa-owner','OPEN','SYSTEM',1,?,?)`,
      )
      .bind(t, s.task.customerId, r, now, now, now),
  ]);
  await data(
    await post(`/api/renewals/${r}/close-won`, {
      expectedPrimaryTaskId: t,
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      result: {
        kind: 'LINK_POLICY',
        newPolicyId: s.task.policyId,
        expectedPolicyVersion: 1,
        allocatedNewPremiumMinor: 1000,
        currency: 'TRY',
      },
    }),
  );
  const before = await snapshot(),
    db = f.env.DB;
  let dbError = '';
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          try {
            return await target.batch(statements);
          } catch (error) {
            dbError = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let response: Response;
  try {
    response = await post(
      `/api/renewals/${s.task.renewalId}/close-won`,
      body(s, 'LINK_POLICY', false),
    );
  } finally {
    f.env.DB = db;
  }
  const unchanged = (await snapshot()) === before;
  expect(dbError).toContain('RENEWAL_POLICY_LINK_CYCLE');
  const actual = {
    httpStatus: response.status,
    unchanged,
    dbCycleRejected: dbError.includes('RENEWAL_POLICY_LINK_CYCLE'),
  };
  const envelope = (await response.json()) as {
    success: boolean;
    error: { code: string; message: string };
  };
  expect(envelope).toMatchObject({
    success: false,
    error: { code: 'RENEWAL_POLICY_LINK_CYCLE', message: 'Kayıt güncel değil veya işlem çakıştı.' },
  });
  expect(actual, JSON.stringify(actual)).toEqual({
    httpStatus: 409,
    unchanged: true,
    dbCycleRejected: true,
  });
});

it('accepts noncyclic LINK_POLICY, preserves exact historical replay and rejects changed same-key payload', async () => {
  const s = await setup(),
    key = crypto.randomUUID(),
    url = `/api/renewals/${s.task.renewalId}/close-won`,
    b = body(s);
  const result = await data<{ createdPolicyId: null; primaryTaskId: string; state: string }>(
    await post(url, b, key),
  );
  expect(result).toMatchObject({
    createdPolicyId: null,
    primaryTaskId: s.task.taskId,
    state: 'WON',
  });
  const before = await snapshot();
  expect(await data(await post(url, b, key))).toEqual(result);
  expect((await post(url, { ...b, expectedTaskVersion: 99 }, key)).status).toBe(409);
  expect(await snapshot()).toBe(before);
  for (const [sql, arg, count] of [
    ['SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=?', s.task.renewalId, 1],
    ['SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?', key, 1],
    ["SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'", key, 1],
    ['SELECT count(*) n FROM renewal_state_history WHERE renewal_id=?', s.task.renewalId, 2],
  ] as const)
    expect((await f.db.prepare(sql).bind(arg).first<{ n: number }>())!.n).toBe(count);
});
it('retains HTTP500 and full rollback for an isolated real unexpected audit INSERT failure', async () => {
  const s = await setup(),
    b = body(s),
    url = `/api/renewals/${s.task.renewalId}/close-won`;
  const before = await snapshot();
  await f.db
    .prepare(
      `CREATE TRIGGER cycle_test_audit_failure BEFORE INSERT ON audit_events
 WHEN NEW.action='renewal.closed_won' BEGIN SELECT RAISE(ABORT,'ISOLATED_UNEXPECTED_AUDIT_FAILURE'); END`,
    )
    .run();
  try {
    const response = await post(url, b);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Beklenmeyen hata.' },
    });
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db.prepare('DROP TRIGGER cycle_test_audit_failure').run();
  }
  // After removing only the fixture failpoint the same legitimate command succeeds.
  await data(await post(url, b));
});
