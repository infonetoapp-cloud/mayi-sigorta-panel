// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setTimeout } from 'node:timers/promises';
import { localAuthFixture } from './support/local-auth-fixture';
import type { TodayTasksResponseData } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  cookie = '';
let serial = 0;
let assertionSql = '';
let assertionBindings: unknown[] = [];
let assertionStatement: D1PreparedStatement;
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
async function capture<T>(work: () => Promise<T>) {
  const db = f.env.DB;
  f.env.DB = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare')
        return (sql: string) => {
          const st = t.prepare(sql);
          if (!sql.includes("END,'RENEWAL_QUOTE_ACCEPTANCE_CONFLICT'")) return st;
          assertionSql = sql;
          return new Proxy(st, {
            get(p, n) {
              if (n === 'bind')
                return (...v: unknown[]) => {
                  assertionBindings = v;
                  assertionStatement = p.bind(...v);
                  return assertionStatement;
                };
              const x = Reflect.get(p, n, p);
              return typeof x === 'function' ? x.bind(p) : x;
            },
          });
        };
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  try {
    return await work();
  } finally {
    f.env.DB = db;
  }
}
async function atBatch<T>(
  before: (statements: D1PreparedStatement[]) => Promise<void>,
  work: () => Promise<T>,
) {
  const db = f.env.DB;
  let reached = false;
  f.env.DB = new Proxy(db, {
    get(t, k) {
      if (k === 'batch')
        return async (st: D1PreparedStatement[]) => {
          if (st.length >= 12 && !reached) {
            reached = true;
            await before(st);
          }
          return t.batch(st);
        };
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  try {
    const r = await work();
    expect(reached).toBe(true);
    return r;
  } finally {
    f.env.DB = db;
  }
}
it('inspects installed assertion guard fallback and accepts a valid selected SENT quote using the actual production assertion', async () => {
  const trigger = await f.db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='d1_cas_assertions_guard'",
    )
    .first<{ sql: string }>();
  expect(trigger!.sql).toContain('OPTIMISTIC_CONCURRENCY_CONFLICT');
  const s = await setup();
  const result = await capture(() => post(`/api/renewals/${s.task.renewalId}/close-won`, body(s)));
  await data(result);
  expect(assertionSql).toContain(
    "v.valid_until COLLATE BINARY > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  );
  expect(assertionBindings).toHaveLength(8);
});
const literal = (s: unknown) =>
  typeof s === 'number' ? String(s) : "'" + String(s).replaceAll("'", "''") + "'";
it.each([
  -1,
  0,
  1,
  'invalid',
  '2099-02-30T00:00:00.000Z',
  '2099-01-01T00:00:00Z',
  '2099-01-01T03:00:00.000+03:00',
])(
  'runs unchanged production acceptance assertion at SQLite boundary %s with all real joined rows',
  async (offset) => {
    const s = await setup();
    await capture(() => post(`/api/renewals/${s.task.renewalId}/close-won`, body(s))).then((r) =>
      data(r),
    );
    const q = crypto.randomUUID(),
      v = crypto.randomUUID(),
      control = 'wa_control_' + serial,
      obs = 'wa_obs_' + serial,
      trigger = 'wa_boundary_' + serial;
    const bindings = [...assertionBindings];
    bindings[0] = crypto.randomUUID();
    bindings[1] = v;
    bindings[4] = q;
    let i = 0;
    const sql = assertionSql.replaceAll('?', () => literal(bindings[i++]));
    expect(i).toBe(8);
    await f.db.prepare(`CREATE TABLE ${control}(id INTEGER PRIMARY KEY)`).run();
    await f.db.prepare(`CREATE TABLE ${obs}(valid_until TEXT,db_now TEXT)`).run();
    const expiry =
      typeof offset === 'number'
        ? `strftime('%Y-%m-%dT%H:%M:%fZ','now','${offset >= 0 ? '+' : ''}${offset / 1000} seconds')`
        : literal(offset);
    await f.db
      .prepare(
        `CREATE TRIGGER ${trigger} AFTER INSERT ON ${control} BEGIN
 INSERT INTO renewal_quotes(id,agency_id,renewal_id,status,current_version_id,version,created_by_user_id,created_by_membership_id,created_at,updated_at)
 SELECT ${literal(q)},agency_id,renewal_id,'DRAFT',NULL,2,created_by_user_id,created_by_membership_id,created_at,updated_at FROM renewal_quotes WHERE id=${literal(s.q.quoteId)};
 INSERT INTO renewal_quote_versions(id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at)
 SELECT ${literal(v)},agency_id,${literal(q)},1,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,${expiry},gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at FROM renewal_quote_versions WHERE id=${literal(s.q.quoteVersionId)};
 UPDATE renewal_quotes SET current_version_id=${literal(v)} WHERE id=${literal(q)};
 INSERT INTO renewal_quote_events(id,agency_id,quote_id,quote_version_id,event,operation_receipt_id,actor_user_id,actor_membership_id,occurred_at)
 SELECT ${literal(crypto.randomUUID())},agency_id,${literal(q)},${literal(v)},'SENT',operation_receipt_id,actor_user_id,actor_membership_id,occurred_at FROM renewal_quote_events WHERE quote_id=${literal(s.q.quoteId)} AND event='SENT';
 UPDATE renewal_quotes SET status='SENT' WHERE id=${literal(q)};
 ${sql};
 INSERT INTO ${obs} SELECT valid_until,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM renewal_quote_versions WHERE id=${literal(v)};
 END`,
      )
      .run();
    const before = await snapshot();
    try {
      if (offset === 1) {
        await f.db.prepare(`INSERT INTO ${control} DEFAULT VALUES`).run();
        const row = await f.db
          .prepare(`SELECT * FROM ${obs}`)
          .first<{ valid_until: string; db_now: string }>();
        expect(Date.parse(row!.valid_until) - Date.parse(row!.db_now)).toBe(1);
      } else {
        await expect(f.db.prepare(`INSERT INTO ${control} DEFAULT VALUES`).run()).rejects.toThrow(
          'OPTIMISTIC_CONCURRENCY_CONFLICT',
        );
        expect(await snapshot()).toBe(before);
      }
      expect(
        (await f.db.prepare('SELECT count(*) n FROM d1_cas_assertions').first<{ n: number }>())!.n,
      ).toBe(0);
    } finally {
      await f.db.prepare(`DROP TRIGGER ${trigger}`).run();
    }
  },
);
it.each([
  'agency',
  'quote',
  'renewal',
  'version',
  'historical-version',
  'cas',
  'policy',
  'receipt',
])('fails closed for wrong bound %s without mutation', async (kind) => {
  const s = await setup();
  let bindings: unknown[] = [];
  const r = await capture(() =>
    atBatch(
      async (statements) => {
        bindings = [...assertionBindings];
        const index = {
          agency: 3,
          quote: 4,
          renewal: 5,
          version: 1,
          'historical-version': 1,
          cas: 6,
          policy: 2,
          receipt: 7,
        }[kind]!;
        if (kind === 'historical-version') {
          const historical = crypto.randomUUID();
          await f.db
            .prepare(
              `INSERT INTO renewal_quote_versions(id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at)
              SELECT ?,agency_id,quote_id,2,insurer_id,product_id,branch_id,payment_method_id,start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,created_by_user_id,created_by_membership_id,created_at FROM renewal_quote_versions WHERE id=?`,
            )
            .bind(historical, s.q.quoteVersionId)
            .run();
          await f.db
            .prepare('UPDATE renewal_quotes SET current_version_id=? WHERE id=?')
            .bind(historical, s.q.quoteId)
            .run();
        } else bindings[index] = kind === 'cas' ? 999 : 'missing-target';
        const indexOfAssertion = statements.indexOf(assertionStatement);
        expect(indexOfAssertion).toBeGreaterThan(0);
        const before = await snapshot();
        await expect(
          f.db.batch([
            ...statements.slice(0, indexOfAssertion),
            f.db.prepare(assertionSql).bind(...bindings),
          ]),
        ).rejects.toThrow('OPTIMISTIC_CONCURRENCY_CONFLICT');
        expect(await snapshot()).toBe(before);
        if (kind === 'historical-version')
          await f.db
            .prepare('UPDATE renewal_quotes SET current_version_id=? WHERE id=?')
            .bind(s.q.quoteVersionId, s.q.quoteId)
            .run();
      },
      () => post(`/api/renewals/${s.task.renewalId}/close-won`, body(s)),
    ),
  );
  await data(r);
});
it('replays historical WON after actual expiry without writes and rejects changed same key/new key', async () => {
  const s = await setup(20000),
    key = crypto.randomUUID(),
    b = body(s),
    url = `/api/renewals/${s.task.renewalId}/close-won`;
  const result = await data(await post(url, b, key));
  await setTimeout(Math.max(0, Date.parse(s.validUntil) - Date.now() + 150));
  const before = await snapshot();
  expect(await data(await post(url, b, key))).toEqual(result);
  expect((await post(url, { ...b, expectedTaskVersion: 2 }, key)).status).toBe(409);
  expect((await post(url, b)).status).toBe(409);
  expect(await snapshot()).toBe(before);
}, 90000);
it.each(['same-key', 'different-key'])(
  'preserves %s WON final-batch concurrency',
  async (kind) => {
    const s = await setup(),
      db = f.env.DB,
      key = crypto.randomUUID(),
      otherKey = kind === 'same-key' ? key : crypto.randomUUID(),
      b = body(s),
      url = `/api/renewals/${s.task.renewalId}/close-won`;
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.env.DB = new Proxy(db, {
      get(t, k) {
        if (k === 'batch')
          return async (st: D1PreparedStatement[]) => {
            if (st.length >= 12 && arrived < 2) {
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
      const rs = await Promise.all([post(url, b, key), post(url, b, otherKey)]);
      expect(arrived).toBe(2);
      expect(rs.map((r) => r.status).sort()).toEqual(kind === 'same-key' ? [200, 200] : [200, 409]);
      expect(
        (await f.db
          .prepare('SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=?')
          .bind(s.task.renewalId)
          .first<{ n: number }>())!.n,
      ).toBe(1);
      expect(
        (await f.db
          .prepare(
            "SELECT count(*) n FROM renewal_quote_events WHERE quote_id=? AND event='ACCEPTED'",
          )
          .bind(s.q.quoteId)
          .first<{ n: number }>())!.n,
      ).toBe(1);
      for (const sql of [
        'SELECT count(*) n FROM operation_receipts WHERE idempotency_key IN (?,?)',
        "SELECT count(*) n FROM audit_events WHERE idempotency_key IN (?,?) AND action='renewal.closed_won' AND outcome='SUCCESS'",
      ])
        expect((await f.db.prepare(sql).bind(key, otherKey).first<{ n: number }>())!.n).toBe(1);
      expect(
        (await f.db
          .prepare('SELECT count(*) n FROM renewal_state_history WHERE renewal_id=?')
          .bind(s.task.renewalId)
          .first<{ n: number }>())!.n,
      ).toBe(2);
      expect(
        await f.db
          .prepare('SELECT status,version FROM tasks WHERE id=?')
          .bind(s.task.taskId)
          .first(),
      ).toEqual({ status: 'COMPLETED', version: s.task.taskVersion + 1 });
      expect(
        (await f.db.prepare('SELECT count(*) n FROM d1_cas_assertions').first<{ n: number }>())!.n,
      ).toBe(0);
    } finally {
      f.env.DB = db;
    }
  },
  90000,
);
it.each(['LINK_POLICY', 'CREATE_POLICY', 'EXISTING_LINKS'])(
  'keeps %s without quote association unaffected',
  async (kind) => {
    const s = await setup();
    if (kind === 'EXISTING_LINKS') await existingLink(s);
    const r = await data<{ createdPolicyId: string | null }>(
      await post(`/api/renewals/${s.task.renewalId}/close-won`, body(s, kind, false)),
      kind === 'CREATE_POLICY' ? 201 : 200,
    );
    expect(kind === 'CREATE_POLICY' ? r.createdPolicyId !== null : r.createdPolicyId === null).toBe(
      true,
    );
    expect(
      await f.db.prepare('SELECT status FROM renewal_quotes WHERE id=?').bind(s.q.quoteId).first(),
    ).toEqual({ status: 'SENT' });
  },
);
async function existingLink(s: Awaited<ReturnType<typeof setup>>) {
  const receipt = crypto.randomUUID();
  await f.db
    .prepare(
      `INSERT INTO operation_receipts
    (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at)
    VALUES(?,'agency-auth-test','wa-owner','membership-wa-owner','renewal.policy_links.allocate',?,?,'COMPLETED',201,'{}',?,?)`,
    )
    .bind(
      receipt,
      crypto.randomUUID(),
      'a'.repeat(64),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await f.db
    .prepare(
      `INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,status,allocation_operation_id,created_by_membership_id,created_at)
 VALUES(?,'agency-auth-test',?,?,1000,'TRY','ACTIVE',?,'membership-wa-owner',?)`,
    )
    .bind(crypto.randomUUID(), s.task.renewalId, s.policy.id, receipt, new Date().toISOString())
    .run();
}
it.each(['CREATE_POLICY', 'EXISTING_LINKS'])(
  'accepts valid selected quote via %s and rejects after real batch barrier expiry with full rollback',
  async (kind) => {
    const good = await setup();
    if (kind === 'EXISTING_LINKS') await existingLink(good);
    await data(
      await post(`/api/renewals/${good.task.renewalId}/close-won`, body(good, kind)),
      kind === 'CREATE_POLICY' ? 201 : 200,
    );
    const s = await setup(20000);
    if (kind === 'EXISTING_LINKS') await existingLink(s);
    const before = await snapshot();
    const r = await atBatch(
      async () => {
        expect(Date.now()).toBeLessThan(Date.parse(s.validUntil));
        await setTimeout(Math.max(0, Date.parse(s.validUntil) - Date.now() + 150));
      },
      () => post(`/api/renewals/${s.task.renewalId}/close-won`, body(s, kind)),
    );
    expect(r.status).toBe(409);
    expect(await snapshot()).toBe(before);
  },
  90000,
);
it.each(['quote-cas', 'current-pointer', 'policy-cas'])(
  'rejects %s raced after successful preflight with no partial WON writes',
  async (kind) => {
    const s = await setup();
    let before = '';
    const r = await atBatch(
      async () => {
        if (kind === 'quote-cas')
          await f.db
            .prepare('UPDATE renewal_quotes SET version=version+1 WHERE id=?')
            .bind(s.q.quoteId)
            .run();
        if (kind === 'current-pointer')
          await f.db
            .prepare(
              'UPDATE renewal_quotes SET current_version_id=NULL,version=version+1 WHERE id=?',
            )
            .bind(s.q.quoteId)
            .run();
        if (kind === 'policy-cas')
          await f.db
            .prepare('UPDATE policies SET version=version+1 WHERE id=?')
            .bind(s.policy.id)
            .run();
        before = await snapshot();
      },
      () => post(`/api/renewals/${s.task.renewalId}/close-won`, body(s)),
    );
    expect(r.status).toBe(409);
    expect(await snapshot()).toBe(before);
  },
);
it.each([
  'allowed',
  'no-quote-manage',
  'HEALTH',
  'foreign',
  'revoked-session',
  'suspended-membership',
])(
  'keeps selected-quote WON authorization fail closed: %s',
  async (kind) => {
    const s = await setup(),
      actor = 'wa-member-' + serial;
    await f.seed(
      actor,
      kind === 'foreign' ? 'OWNER' : 'MEMBER',
      false,
      kind === 'foreign' ? 'wa-other-' + serial : 'agency-auth-test',
    );
    if (kind !== 'foreign') {
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
        ].map((code) =>
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
      // Ordinary primary-task reassignment keeps renewal/task assignees consistent.
      await f.db
        .prepare('UPDATE renewal_opportunities SET assignee_membership_id=? WHERE id=?')
        .bind('membership-' + actor, s.task.renewalId)
        .run();
    }
    const session = await f.session(actor),
      csrf = await f.csrf(session.cookie);
    if (kind === 'no-quote-manage')
      await f.db
        .prepare(
          "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='quote.manage'",
        )
        .bind('membership-' + actor)
        .run();
    if (kind === 'HEALTH')
      await f.db
        .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='wa-b'")
        .run();
    if (kind === 'revoked-session')
      await f.db
        .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
        .bind(Date.now(), session.hash)
        .run();
    if (kind === 'suspended-membership')
      await f.db
        .prepare(
          "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind(new Date().toISOString(), 'membership-' + actor)
        .run();
    const before = await snapshot();
    try {
      const r = await f.request(
        `/api/renewals/${s.task.renewalId}/close-won`,
        'POST',
        session.cookie,
        body(s),
        csrf,
        { 'idempotency-key': crypto.randomUUID() },
      );
      if (kind === 'allowed') await data(r);
      else {
        expect([401, 403, 404]).toContain(r.status);
        expect(await snapshot()).toBe(before);
      }
    } finally {
      if (kind === 'HEALTH')
        await f.db
          .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='wa-b'")
          .run();
    }
  },
  90000,
);
