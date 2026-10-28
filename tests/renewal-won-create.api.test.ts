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

function creation(s: Awaited<ReturnType<typeof setup>>) {
  return {
    expectedPrimaryTaskId: s.task.taskId,
    expectedRenewalVersion: s.task.renewalVersion,
    expectedTaskVersion: s.task.taskVersion,
    result: {
      kind: 'CREATE_POLICY',
      policy: {
        ...s.common,
        policyNumber: 'CREATE-' + serial,
        startDate: s.h.defaultVersion.startDate,
        endDate: s.h.defaultVersion.endDate,
        status: 'ACTIVE',
      },
    },
  };
}
async function n(table: string) {
  return (await f.db.prepare(`SELECT count(*) n FROM ${table}`).first<{ n: number }>())!.n;
}
it('creates one ACTIVE policy plus link/task/WON/history/receipt/two SUCCESS audits with HTTP201 and historical exact replay', async () => {
  const s = await setup(),
    b = creation(s),
    key = crypto.randomUUID(),
    before = await n('policies'),
    url = `/api/renewals/${s.task.renewalId}/close-won`;
  const r = await data<{
    createdPolicyId: string;
    primaryTaskId: string;
    renewalVersion: number;
    taskVersion: number;
    links: { newPolicyId: string; allocatedNewPremiumMinor: number }[];
  }>(await post(url, b, key), 201);
  expect(r.primaryTaskId).toBe(s.task.taskId);
  expect(await n('policies')).toBe(before + 1);
  expect(r.links).toHaveLength(1);
  expect(r.links[0]).toMatchObject({
    newPolicyId: r.createdPolicyId,
    allocatedNewPremiumMinor: 1000,
  });
  const policy = await data<{
    customerId: string;
    insurerId: string;
    productId: string;
    grossPremiumMinor: number;
    status: string;
  }>(await f.request(`/api/policies/${r.createdPolicyId}`, 'GET', cookie));
  expect(policy).toMatchObject({
    customerId: s.task.customerId,
    insurerId: 'wa-i',
    productId: 'wa-p',
    grossPremiumMinor: 1000,
    status: 'ACTIVE',
  });
  expect(
    await f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(s.task.taskId).first(),
  ).toEqual({ status: 'COMPLETED', version: s.task.taskVersion + 1 });
  expect(
    (await f.db
      .prepare("SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'")
      .bind(key)
      .first<{ n: number }>())!.n,
  ).toBe(2);
  const saved = await snapshot();
  expect(await data(await post(url, b, key))).toEqual(r);
  expect(
    (
      await post(
        url,
        { ...b, result: { ...b.result, policy: { ...b.result.policy, policyNumber: 'CHANGED' } } },
        key,
      )
    ).status,
  ).toBe(409);
  expect(await snapshot()).toBe(saved);
});
it.each([
  'premium',
  'period',
  'currency',
  'installments',
  'inactive',
  'product-mismatch',
  'duplicate',
  'no-default',
  'explicit-no-default',
])('validates CREATE_POLICY %s without partial side effects', async (kind) => {
  const s = await setup(),
    b: {
      expectedPrimaryTaskId: string;
      expectedRenewalVersion: number;
      expectedTaskVersion: number;
      result: { kind: string; policy: Record<string, unknown> };
    } = creation(s);
  let expected = 400;
  if (kind === 'premium') b.result.policy.grossPremium = '1.005';
  if (kind === 'period') b.result.policy.startDate = '2099-01-01';
  if (kind === 'currency') b.result.policy.currency = 'ZZZ';
  if (kind === 'installments') b.result.policy.installmentCount = 3;
  if (kind === 'inactive') {
    await f.db.prepare("UPDATE insurance_products SET status='INACTIVE' WHERE id='wa-p'").run();
    expected = 409;
  }
  if (kind === 'product-mismatch') {
    b.result.policy.insurerId = 'missing';
    expected = 409;
  }
  if (kind === 'duplicate') {
    b.result.policy.policyNumber = 'WA-NEW-' + serial;
    expected = 409;
  }
  if (kind === 'no-default' || kind === 'explicit-no-default') {
    await f.db.prepare('UPDATE agency_settings SET default_insurer_id=NULL').run();
    if (kind === 'no-default') {
      delete b.result.policy.insurerId;
      expected = 409;
    } else expected = 201;
  }
  const before = await snapshot();
  try {
    const r = await post(`/api/renewals/${s.task.renewalId}/close-won`, b);
    expect(r.status, await r.clone().text()).toBe(expected);
    if (expected !== 201) expect(await snapshot()).toBe(before);
  } finally {
    if (kind === 'inactive')
      await f.db.prepare("UPDATE insurance_products SET status='ACTIVE' WHERE id='wa-p'").run();
  }
});
it('rejects stale Task A after replacement B without orphan created policy', async () => {
  const s = await setup(),
    b = creation(s);
  await data(
    await post(`/api/renewals/${s.task.renewalId}/tasks/${s.task.taskId}/complete`, {
      expectedRenewalVersion: s.task.renewalVersion,
      expectedTaskVersion: s.task.taskVersion,
      replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  );
  const before = await snapshot();
  expect((await post(`/api/renewals/${s.task.renewalId}/close-won`, b)).status).toBe(409);
  expect(await snapshot()).toBe(before);
});
it('rolls back created policy and all subsequent effects on a real injected final audit failure', async () => {
  const s = await setup(),
    b = creation(s),
    before = await snapshot();
  await f.db
    .prepare(
      "CREATE TRIGGER create_won_fail BEFORE INSERT ON audit_events WHEN NEW.action='renewal.closed_won' BEGIN SELECT RAISE(ABORT,'CREATE_WON_TEST_FAILURE'); END",
    )
    .run();
  try {
    expect((await post(`/api/renewals/${s.task.renewalId}/close-won`, b)).status).toBe(500);
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db.prepare('DROP TRIGGER create_won_fail').run();
  }
});
async function member(s: Awaited<ReturnType<typeof setup>>) {
  const actor = 'create-member-' + serial;
  await f.seed(actor, 'MEMBER');
  await f.db.batch(
    [
      'customer.read',
      'policy.read',
      'renewal.read',
      'renewal.close_won',
      'task.read',
      'task.update',
    ].map((code) =>
      f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), 'membership-' + actor, code, 'AGENCY'),
    ),
  );
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'policy.create','UNSCOPED')",
    )
    .bind(crypto.randomUUID(), 'membership-' + actor)
    .run();
  await f.db
    .prepare('UPDATE tasks SET assignee_membership_id=? WHERE id=?')
    .bind('membership-' + actor, s.task.taskId)
    .run();
  await f.db
    .prepare('UPDATE renewal_opportunities SET assignee_membership_id=? WHERE id=?')
    .bind('membership-' + actor, s.task.renewalId)
    .run();
  return actor;
}
it.each(['allowed', 'no-create', 'other-assignee', 'HEALTH', 'revoked-create'])(
  'enforces independent MEMBER create and assignment authority: %s',
  async (kind) => {
    const s = await setup(),
      actor = await member(s),
      b = creation(s),
      owner = cookie,
      db = f.env.DB;
    cookie = (await f.session(actor)).cookie;
    b.result.policy.assigneeMembershipId = 'membership-' + actor;
    if (kind === 'no-create')
      await f.db
        .prepare(
          "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='policy.create'",
        )
        .bind('membership-' + actor)
        .run();
    if (kind === 'other-assignee') b.result.policy.assigneeMembershipId = 'membership-wa-owner';
    if (kind === 'HEALTH')
      await f.db
        .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='wa-b'")
        .run();
    let before = await snapshot(),
      held = false;
    if (kind === 'revoked-create')
      f.env.DB = new Proxy(db, {
        get(t, k) {
          if (k === 'batch')
            return async (st: D1PreparedStatement[]) => {
              if (st.length >= 12 && !held) {
                held = true;
                await f.db
                  .prepare(
                    "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='policy.create'",
                  )
                  .bind('membership-' + actor)
                  .run();
                before = await snapshot();
              }
              return t.batch(st);
            };
          const v = Reflect.get(t, k, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    try {
      const r = await post(`/api/renewals/${s.task.renewalId}/close-won`, b);
      expect(r.status, await r.clone().text()).toBe(kind === 'allowed' ? 201 : 403);
      if (kind !== 'allowed') expect(await snapshot()).toBe(before);
      if (kind === 'revoked-create') expect(held).toBe(true);
    } finally {
      cookie = owner;
      f.env.DB = db;
      if (kind === 'HEALTH')
        await f.db
          .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='wa-b'")
          .run();
    }
  },
);
it.each(['same-key', 'different-key', 'VOIDED', 'TASK_COMPLETE'])(
  'has one atomic winner for competing CREATE_POLICY / %s',
  async (kind) => {
    const s = await setup(),
      b = creation(s),
      db = f.env.DB,
      key = crypto.randomUUID(),
      policies = await n('policies');
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.env.DB = new Proxy(db, {
      get(t, k) {
        if (k === 'batch')
          return async (st: D1PreparedStatement[]) => {
            if (st.length >= 8 && arrived < 2) {
              if (++arrived === 2) release();
              await gate;
            }
            return t.batch(st);
          };
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    try {
      const rs = await Promise.all([
        post(`/api/renewals/${s.task.renewalId}/close-won`, b, key),
        kind === 'VOIDED'
          ? post(`/api/renewals/${s.task.renewalId}/void`, {
              expectedPrimaryTaskId: s.task.taskId,
              expectedRenewalVersion: s.task.renewalVersion,
              expectedTaskVersion: s.task.taskVersion,
              voidReasonCode: 'DUPLICATE',
            })
          : kind === 'TASK_COMPLETE'
            ? post(`/api/renewals/${s.task.renewalId}/tasks/${s.task.taskId}/complete`, {
                expectedRenewalVersion: s.task.renewalVersion,
                expectedTaskVersion: s.task.taskVersion,
                replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
              })
            : post(
                `/api/renewals/${s.task.renewalId}/close-won`,
                b,
                kind === 'same-key' ? key : crypto.randomUUID(),
              ),
      ]);
      expect(arrived).toBe(2);
      expect(rs.map((r) => r.status).sort()).toEqual(
        kind === 'same-key'
          ? [200, 201]
          : rs.some((r) => r.status === 201)
            ? [201, 409]
            : [200, 409],
      );
      const won =
        (await f.db
          .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
          .bind(s.task.renewalId)
          .first<{ state: string }>())!.state === 'WON';
      expect(await n('policies')).toBe(policies + (won ? 1 : 0));
      expect(
        (await f.db
          .prepare('SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=?')
          .bind(s.task.renewalId)
          .first<{ n: number }>())!.n,
      ).toBe(won ? 1 : 0);
    } finally {
      f.env.DB = db;
    }
  },
  90000,
);
it.each(['foreign', 'archived', 'new-HEALTH', 'assigned-customer', 'assignee-revoked'])(
  'fails closed for CREATE target boundary %s with no orphan rows',
  async (kind) => {
    const s = await setup(),
      b = creation(s),
      owner = cookie,
      db = f.env.DB;
    let held = false;
    if (kind === 'foreign') {
      await f.seed('create-foreign-' + serial, 'OWNER', false, 'create-other-' + serial);
      cookie = (await f.session('create-foreign-' + serial)).cookie;
    }
    if (kind === 'archived') {
      const original = await snapshot();
      await expect(
        f.db
          .prepare(
            "UPDATE customers SET archived_at=?,archived_by_membership_id='membership-wa-owner',archive_reason_code='TEST' WHERE id=?",
          )
          .bind(new Date().toISOString(), s.task.customerId)
          .run(),
      ).rejects.toThrow('OPEN_DEPENDENCIES');
      expect(await snapshot()).toBe(original);
      const other = await data<{ id: string }>(
        await post('/api/customers', {
          type: 'INDIVIDUAL',
          firstName: 'Archived',
          lastName: 'Sentetik',
        }),
        201,
      );
      await f.db
        .prepare(
          "UPDATE customers SET archived_at=?,archived_by_membership_id='membership-wa-owner',archive_reason_code='TEST' WHERE id=?",
        )
        .bind(new Date().toISOString(), other.id)
        .run();
      b.result.policy.customerId = other.id;
    }
    if (kind === 'new-HEALTH' || kind === 'assigned-customer') {
      const actor = await member(s);
      b.result.policy.assigneeMembershipId = 'membership-' + actor;
      if (kind === 'new-HEALTH') {
        await f.db.batch([
          f.db
            .prepare(
              "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES(?,'agency-auth-test',?,'Sentetik sağlık','HEALTH')",
            )
            .bind('health-b-' + serial, 'HB' + serial),
          f.db
            .prepare(
              "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES(?,'agency-auth-test','wa-i',?,?,'Sentetik sağlık')",
            )
            .bind('health-p-' + serial, 'health-b-' + serial, 'HP' + serial),
        ]);
        b.result.policy.branchId = 'health-b-' + serial;
        b.result.policy.productId = 'health-p-' + serial;
      } else {
        await f.db
          .prepare(
            "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id=? AND permission_code IN ('customer.read','policy.read','renewal.read','renewal.close_won')",
          )
          .bind('membership-' + actor)
          .run();
      }
      cookie = (await f.session(actor)).cookie;
    }
    if (kind === 'assignee-revoked') {
      await f.seed('create-assignee-' + serial, 'MEMBER');
      b.result.policy.assigneeMembershipId = 'membership-create-assignee-' + serial;
      f.env.DB = new Proxy(db, {
        get(t, k) {
          if (k === 'batch')
            return async (st: D1PreparedStatement[]) => {
              if (st.length >= 12 && !held) {
                held = true;
                await f.db
                  .prepare(
                    "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
                  )
                  .bind(new Date().toISOString(), b.result.policy.assigneeMembershipId)
                  .run();
                before = await snapshot();
              }
              return t.batch(st);
            };
          const v = Reflect.get(t, k, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    }
    let before = await snapshot();
    try {
      const r = await post(`/api/renewals/${s.task.renewalId}/close-won`, b);
      expect([403, 404, 409]).toContain(r.status);
      expect(await snapshot()).toBe(before);
      if (kind === 'assignee-revoked') expect(held).toBe(true);
    } finally {
      cookie = owner;
      f.env.DB = db;
    }
  },
);
