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

it.each(['self', 'stale-policy', 'wrong-customer', 'incomplete'])(
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
  expect(actual, JSON.stringify(actual)).toEqual({
    httpStatus: 409,
    unchanged: true,
    dbCycleRejected: true,
  });
});
it.each([false, true])(
  'persists full LINK_POLICY atomic evidence and exact historical replay (quote %s)',
  async (associate) => {
    const s = await setup(),
      key = crypto.randomUUID(),
      url = `/api/renewals/${s.task.renewalId}/close-won`,
      b = body(s, 'LINK_POLICY', associate),
      policies = (await f.db.prepare('SELECT count(*) n FROM policies').first<{ n: number }>())!.n;
    const r = await data<{
      createdPolicyId: null;
      state: string;
      primaryTaskId: string;
      renewalVersion: number;
      taskVersion: number;
      acceptedQuoteVersionId: string | null;
      acceptedPolicyId: string | null;
    }>(await post(url, b, key));
    expect(r).toMatchObject({
      createdPolicyId: null,
      state: 'WON',
      primaryTaskId: s.task.taskId,
      renewalVersion: s.task.renewalVersion + 1,
      taskVersion: s.task.taskVersion + 1,
      acceptedQuoteVersionId: associate ? s.q.quoteVersionId : null,
      acceptedPolicyId: associate ? s.policy.id : null,
    });
    expect(
      await f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(s.task.taskId).first(),
    ).toEqual({ status: 'COMPLETED', version: s.task.taskVersion + 1 });
    expect((await f.db.prepare('SELECT count(*) n FROM policies').first<{ n: number }>())!.n).toBe(
      policies,
    );
    expect(
      await f.db
        .prepare(
          'SELECT new_policy_id,allocated_new_premium_minor,currency FROM renewal_policy_links WHERE renewal_id=?',
        )
        .bind(s.task.renewalId)
        .first(),
    ).toEqual({ new_policy_id: s.policy.id, allocated_new_premium_minor: 1000, currency: 'TRY' });
    for (const [sql, arg, count] of [
      ['SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?', key, 1],
      ["SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'", key, 1],
      ['SELECT count(*) n FROM renewal_state_history WHERE renewal_id=?', s.task.renewalId, 2],
      [
        "SELECT count(*) n FROM renewal_quote_events WHERE quote_id=? AND event='ACCEPTED'",
        s.q.quoteId,
        associate ? 1 : 0,
      ],
    ] as const)
      expect((await f.db.prepare(sql).bind(arg).first<{ n: number }>())!.n).toBe(count);
    const before = await snapshot();
    expect(await data(await post(url, b, key))).toEqual(r);
    expect((await post(url, { ...b, expectedTaskVersion: 99 }, key)).status).toBe(409);
    expect(await snapshot()).toBe(before);
  },
);
it.each(['required', 'unexpected', 'valid'])(
  'validates explicit quote difference reason: %s',
  async (kind) => {
    const s = await setup();
    if (kind !== 'unexpected')
      await f.db
        .prepare('UPDATE policies SET gross_premium_minor=1200,version=version+1 WHERE id=?')
        .bind(s.policy.id)
        .run();
    const b = {
      ...body(s),
      result: {
        kind: 'LINK_POLICY',
        newPolicyId: s.policy.id,
        expectedPolicyVersion: kind === 'unexpected' ? s.policy.version : s.policy.version + 1,
        allocatedNewPremiumMinor: kind === 'unexpected' ? 1000 : 1200,
        currency: 'TRY',
      },
      ...(kind === 'required' ? {} : { quoteDifferenceReasonCode: 'CUSTOMER_CONFIRMED' }),
    };
    const before = await snapshot(),
      r = await post(`/api/renewals/${s.task.renewalId}/close-won`, b);
    expect(r.status, await r.clone().text()).toBe(kind === 'valid' ? 200 : 400);
    if (kind !== 'valid')
      expect(await r.json()).toMatchObject({
        success: false,
        error: {
          code:
            kind === 'required'
              ? 'QUOTE_DIFFERENCE_REASON_REQUIRED'
              : 'QUOTE_DIFFERENCE_REASON_UNEXPECTED',
        },
      });
    if (kind !== 'valid') expect(await snapshot()).toBe(before);
  },
);
it('rejects expired selected SENT quote before POST without altering business or evidence', async () => {
  const s = await setup(),
    id = crypto.randomUUID();
  await f.db.batch([
    f.db
      .prepare(
        `INSERT INTO renewal_quote_versions(id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at)
 SELECT ?,agency_id,quote_id,2,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,'2020-01-01T00:00:00.000Z',gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at FROM renewal_quote_versions WHERE id=?`,
      )
      .bind(id, s.q.quoteVersionId),
    f.db
      .prepare('UPDATE renewal_quotes SET current_version_id=?,version=version+1 WHERE id=?')
      .bind(id, s.q.quoteId),
  ]);
  const before = await snapshot(),
    r = await post(`/api/renewals/${s.task.renewalId}/close-won`, {
      ...body(s),
      acceptedQuoteVersionId: id,
    });
  expect(r.status).toBe(409);
  expect(await snapshot()).toBe(before);
});
it.each(['foreign', 'HEALTH', 'session', 'permission'])(
  'rejects unauthorized WON target/context %s',
  async (kind) => {
    const s = await setup(),
      b = body(s, 'LINK_POLICY', false);
    const cookieBefore = cookie;
    if (kind === 'foreign') {
      await f.seed('foreign-' + serial, 'OWNER', false, 'other-' + serial);
      cookie = (await f.session('foreign-' + serial)).cookie;
    }
    if (kind === 'HEALTH' || kind === 'permission') {
      const actor = 'member-' + serial;
      await f.seed(actor, 'MEMBER');
      await f.db.batch(
        [
          'customer.read',
          'policy.read',
          'renewal.read',
          'renewal.close_won',
          'task.read',
          'task.update',
          'quote.read',
          'quote.manage',
        ]
          .filter((code) => kind !== 'permission' || code !== 'renewal.close_won')
          .map((code) =>
            f.db
              .prepare(
                'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
              )
              .bind(crypto.randomUUID(), 'membership-' + actor, code, 'AGENCY'),
          ),
      );
      await f.db
        .prepare('UPDATE tasks SET assignee_membership_id=? WHERE id=?')
        .bind('membership-' + actor, s.task.taskId)
        .run();
      await f.db
        .prepare('UPDATE renewal_opportunities SET assignee_membership_id=? WHERE id=?')
        .bind('membership-' + actor, s.task.renewalId)
        .run();
      cookie = (await f.session(actor)).cookie;
      if (kind === 'HEALTH')
        await f.db
          .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='wa-b'")
          .run();
    }
    if (kind === 'session') {
      const session = await f.session('wa-owner'),
        csrf = await f.csrf(session.cookie);
      await f.db
        .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
        .bind(Date.now(), session.hash)
        .run();
      const before = await snapshot(),
        r = await f.request(
          `/api/renewals/${s.task.renewalId}/close-won`,
          'POST',
          session.cookie,
          b,
          csrf,
          { 'idempotency-key': crypto.randomUUID() },
        );
      expect(r.status).toBe(401);
      expect(await snapshot()).toBe(before);
      return;
    }
    try {
      const before = await snapshot(),
        r = await post(`/api/renewals/${s.task.renewalId}/close-won`, b);
      expect([403, 404]).toContain(r.status);
      expect(await snapshot()).toBe(before);
    } finally {
      cookie = cookieBefore;
      if (kind === 'HEALTH')
        await f.db
          .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='wa-b'")
          .run();
    }
  },
);
it.each(['WON', 'VOIDED', 'TASK_COMPLETE'])(
  'serializes WON versus %s at the actual final D1 batch',
  async (kind) => {
    const s = await setup(),
      db = f.env.DB;
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.env.DB = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length >= 8 && arrived < 2) {
              if (++arrived === 2) release();
              await gate;
            }
            return target.batch(statements);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    try {
      const common = {
        expectedPrimaryTaskId: s.task.taskId,
        expectedRenewalVersion: s.task.renewalVersion,
        expectedTaskVersion: s.task.taskVersion,
      };
      const [a, b] = await Promise.all([
        post(`/api/renewals/${s.task.renewalId}/close-won`, body(s, 'LINK_POLICY', false)),
        kind === 'WON'
          ? post(`/api/renewals/${s.task.renewalId}/close-won`, body(s, 'LINK_POLICY', false))
          : kind === 'VOIDED'
            ? post(`/api/renewals/${s.task.renewalId}/void`, {
                ...common,
                voidReasonCode: 'DUPLICATE',
              })
            : post(`/api/renewals/${s.task.renewalId}/tasks/${s.task.taskId}/complete`, {
                expectedRenewalVersion: s.task.renewalVersion,
                expectedTaskVersion: s.task.taskVersion,
                replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
              }),
      ]);
      expect(arrived).toBe(2);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const renewal = await f.db
        .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
        .bind(s.task.renewalId)
        .first<{ state: string }>();
      const links = (await f.db
        .prepare('SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=?')
        .bind(s.task.renewalId)
        .first<{ n: number }>())!.n;
      expect(links).toBe(renewal!.state === 'WON' ? 1 : 0);
      expect(
        await f.db
          .prepare('SELECT status,version FROM tasks WHERE id=?')
          .bind(s.task.taskId)
          .first(),
      ).toEqual({ status: 'COMPLETED', version: s.task.taskVersion + 1 });
      expect(
        (await f.db
          .prepare("SELECT count(*) n FROM tasks WHERE renewal_id=? AND status='OPEN'")
          .bind(s.task.renewalId)
          .first<{ n: number }>())!.n,
      ).toBe(renewal!.state === 'CONTACT_PENDING' ? 1 : 0);
      expect(
        (await f.db.prepare('SELECT count(*) n FROM d1_cas_assertions').first<{ n: number }>())!.n,
      ).toBe(0);
    } finally {
      f.env.DB = db;
    }
  },
  90000,
);
it('rejects full premium allocation when another renewal already allocated the target policy', async () => {
  const s = await setup();
  const old = await data<{ id: string }>(
    await post('/api/policies', {
      ...s.common,
      policyNumber: 'ALLOCATED-OLD-' + serial,
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    }),
    201,
  );
  const other = (
    await data<TodayTasksResponseData>(await f.request('/api/tasks/today?limit=50', 'GET', cookie))
  ).items.find((t) => t.policyId === old.id)!;
  await data(
    await post(`/api/renewals/${other.renewalId}/close-won`, {
      expectedPrimaryTaskId: other.taskId,
      expectedRenewalVersion: other.renewalVersion,
      expectedTaskVersion: other.taskVersion,
      result: {
        kind: 'LINK_POLICY',
        newPolicyId: s.policy.id,
        expectedPolicyVersion: s.policy.version,
        allocatedNewPremiumMinor: 1000,
        currency: 'TRY',
      },
    }),
  );
  const before = await snapshot(),
    r = await post(`/api/renewals/${s.task.renewalId}/close-won`, body(s, 'LINK_POLICY', false));
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({
    success: false,
    error: { code: 'WON_ALLOCATION_INCOMPLETE' },
  });
  expect(await snapshot()).toBe(before);
});
