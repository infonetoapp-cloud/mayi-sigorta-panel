// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import { computePayloadHash } from '../src/server/mutations/canonical';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  customerId = '',
  serial = 0;
const cookies: Record<string, string> = {};
type Kind = 'close-lost' | 'void' | 'close-won';
type Result = {
  renewalId: string;
  primaryTaskId: string;
  renewalVersion: number;
  taskVersion: number;
  state: string;
  closedAt: string;
};
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function post(
  url: string,
  body: unknown,
  actor = 'ti-owner',
  key: string = crypto.randomUUID(),
) {
  return f.request(url, 'POST', cookies[actor], body, await f.csrf(cookies[actor]!), {
    'idempotency-key': key,
  });
}
async function seed(actor = 'ti-owner') {
  const p = await data<{ id: string }>(
    await post('/api/policies', {
      customerId,
      insurerId: 'ti-i',
      productId: 'ti-p',
      branchId: 'ti-b',
      paymentMethodId: 'ti-m',
      policyNumber: 'TI-' + ++serial,
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
      assigneeMembershipId: 'membership-' + actor,
    }),
    201,
  );
  return (
    await data<TodayTasksResponseData>(
      await f.request('/api/tasks/today?limit=50', 'GET', cookies['ti-owner']),
    )
  ).items.find((t) => t.policyId === p.id)!;
}
async function resultPolicy() {
  return data<{ id: string; version: number }>(
    await post('/api/policies', {
      customerId,
      insurerId: 'ti-i',
      productId: 'ti-p',
      branchId: 'ti-b',
      paymentMethodId: 'ti-m',
      policyNumber: 'TI-RESULT-' + ++serial,
      startDate: new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10),
      endDate: new Date(Date.now() + 371 * 86400000).toISOString().slice(0, 10),
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
      assigneeMembershipId: 'membership-ti-owner',
    }),
    201,
  );
}
async function body(t: TodayTaskDto, kind: Kind, withId = true) {
  const common = {
    expectedRenewalVersion: t.renewalVersion,
    expectedTaskVersion: t.taskVersion,
    ...(withId ? { expectedPrimaryTaskId: t.taskId } : {}),
  };
  if (kind === 'close-lost') return { ...common, lossReasonId: 'ti-price', lossReasonNotes: null };
  if (kind === 'void') return { ...common, voidReasonCode: 'TECHNICAL_ERROR' };
  const p = await resultPolicy();
  return {
    ...common,
    result: {
      kind: 'LINK_POLICY',
      newPolicyId: p.id,
      expectedPolicyVersion: p.version,
      allocatedNewPremiumMinor: 1000,
      currency: 'TRY',
    },
  };
}
const endpoint = (t: TodayTaskDto, k: Kind) => `/api/renewals/${t.renewalId}/${k}`;
async function replace(t: TodayTaskDto) {
  const r = await data<{
    replacementTaskId: string;
    renewalVersion: number;
    replacementTaskVersion: number;
  }>(
    await post(`/api/renewals/${t.renewalId}/tasks/${t.taskId}/complete`, {
      expectedRenewalVersion: t.renewalVersion,
      expectedTaskVersion: t.taskVersion,
      replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  );
  expect(r.renewalVersion).toBe(t.renewalVersion);
  expect(r.replacementTaskId).not.toBe(t.taskId);
  expect(r.replacementTaskVersion).toBe(1);
  return { ...t, taskId: r.replacementTaskId, taskVersion: r.replacementTaskVersion };
}
async function snapshot() {
  const s: Record<string, unknown> = {};
  for (const table of [
    'renewal_opportunities',
    'tasks',
    'renewal_state_history',
    'operation_receipts',
    'audit_events',
    'renewal_policy_links',
    'policies',
    'd1_cas_assertions',
  ])
    s[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  return JSON.stringify(s);
}
beforeAll(async () => {
  f = await localAuthFixture();
  for (const actor of ['ti-owner', 'ti-ahmet', 'ti-ayse', 'ti-foreign']) {
    const m = await f.seed(
      actor,
      actor === 'ti-owner' || actor === 'ti-foreign' ? 'OWNER' : 'MEMBER',
      false,
      actor === 'ti-foreign' ? 'ti-other' : 'agency-auth-test',
    );
    if (actor === 'ti-ahmet' || actor === 'ti-ayse')
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
  await f.seed('ti-backup', 'OWNER');
  await f.db
    .prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('ti-i','agency-auth-test','TI','Sentetik')",
    )
    .run();
  customerId = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Görev Kimliği',
        insurerNumber: { insurerId: 'ti-i', customerNumber: 'TI-CUSTOMER' },
      }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('ti-b','agency-auth-test','TI','Sentetik','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('ti-p','agency-auth-test','ti-i','ti-b','TI','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('ti-m','agency-auth-test','TI','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('ti-price','agency-auth-test','PRICE','Fiyat')",
    ),
  ]);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('rejects WON stale A identity after replacement B through a valid policy link (originally RED)', async () => {
  const a = await seed(),
    payload = await body(a, 'close-won'),
    b = await replace(a),
    before = await snapshot();
  const response = await post(endpoint(a, 'close-won'), payload),
    raw = (await response.json()) as { data?: Result };
  const actual = {
    status: response.status,
    wrongTask: raw.data?.primaryTaskId === b.taskId,
    state: raw.data?.state,
    unchanged: (await snapshot()) === before,
  };
  expect(actual, JSON.stringify(actual)).toMatchObject({ status: 409, unchanged: true });
});
const kinds: Kind[] = ['close-lost', 'void', 'close-won'];
async function verify(t: TodayTaskDto, r: Result, key: string) {
  expect(r).toMatchObject({
    renewalId: t.renewalId,
    primaryTaskId: t.taskId,
    renewalVersion: t.renewalVersion + 1,
    taskVersion: t.taskVersion + 1,
  });
  expect(new Date(r.closedAt).toISOString()).toBe(r.closedAt);
  expect(
    await f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(t.taskId).first(),
  ).toMatchObject({ status: 'COMPLETED', version: r.taskVersion });
  expect(
    await f.db
      .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
      .bind(t.renewalId)
      .first(),
  ).toMatchObject({ state: r.state, version: r.renewalVersion });
  expect(
    (await f.db
      .prepare("SELECT count(*) n FROM tasks WHERE renewal_id=? AND status='OPEN'")
      .bind(t.renewalId)
      .first<{ n: number }>())!.n,
  ).toBe(0);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await f.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND action=? AND outcome='SUCCESS'",
      )
      .bind(
        key,
        r.state === 'VOIDED'
          ? 'renewal.voided'
          : r.state === 'LOST'
            ? 'renewal.closed_lost'
            : 'renewal.closed_won',
      )
      .first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM renewal_state_history WHERE renewal_id=?')
      .bind(t.renewalId)
      .first<{ n: number }>())!.n,
  ).toBe(2);
}
it.each(kinds)(
  'rejects pinned A without effects then accepts explicitly selected fresh B: %s',
  async (kind) => {
    const a = await seed(),
      old = await body(a, kind),
      b = await replace(a),
      before = await snapshot();
    expect(a.taskVersion).toBe(b.taskVersion);
    expect((await post(endpoint(a, kind), old)).status).toBe(409);
    expect(await snapshot()).toBe(before);
    const key = crypto.randomUUID(),
      fresh = { ...old, expectedPrimaryTaskId: b.taskId, expectedTaskVersion: b.taskVersion };
    const r = await data<Result>(await post(endpoint(b, kind), fresh, 'ti-owner', key));
    await verify(b, r, key);
  },
);
it.each(kinds)(
  'rejects missing, malformed, wrong, unrelated and nonprimary task IDs without writes: %s',
  async (kind) => {
    const t = await seed(),
      other = await seed(),
      payload = await body(t, kind);
    const general = crypto.randomUUID();
    await f.db
      .prepare(
        "INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES(?,'agency-auth-test',?,'GENERAL','Sentetik','2026-01-01T00:00:00.000Z','membership-ti-owner','SYSTEM')",
      )
      .bind(general, customerId)
      .run();
    const { expectedPrimaryTaskId: _id, ...idless } = payload;
    for (const p of [
      idless,
      { ...payload, expectedPrimaryTaskId: null },
      { ...payload, expectedPrimaryTaskId: '' },
      { ...payload, expectedPrimaryTaskId: ' ' + t.taskId },
      { ...payload, expectedPrimaryTaskId: 'missing' },
      { ...payload, expectedPrimaryTaskId: other.taskId },
      { ...payload, expectedPrimaryTaskId: general },
    ]) {
      const before = await snapshot();
      expect([400, 404]).toContain((await post(endpoint(t, kind), p)).status);
      expect(await snapshot()).toBe(before);
    }
  },
);
it.each(kinds)(
  'binds identity into exact replay, rejects changed identity/payload, and has no extra effects: %s',
  async (kind) => {
    const t = await seed(),
      p = await body(t, kind),
      key = crypto.randomUUID(),
      r = await data<Result>(await post(endpoint(t, kind), p, 'ti-owner', key));
    await verify(t, r, key);
    const before = await snapshot();
    expect(await data<Result>(await post(endpoint(t, kind), p, 'ti-owner', key))).toEqual(r);
    expect(
      (
        await post(
          endpoint(t, kind),
          { ...p, expectedPrimaryTaskId: 'other-task' },
          'ti-owner',
          key,
        )
      ).status,
    ).toBe(409);
    expect(
      (await post(endpoint(t, kind), { ...p, expectedTaskVersion: 99 }, 'ti-owner', key)).status,
    ).toBe(409);
    const { expectedPrimaryTaskId: _id, ...idless } = p;
    expect((await post(endpoint(t, kind), idless, 'ti-owner', key)).status).toBe(409);
    expect(await snapshot()).toBe(before);
  },
);
// Construct a pre-upgrade receipt envelope in the real atomic transaction. Only
// its fingerprint binding is the historical (id-less) payload hash; task/history/
// audit/link effects and every constraint still execute as production D1 SQL.
async function historical(
  t: TodayTaskDto,
  kind: Kind,
  p: Awaited<ReturnType<typeof body>>,
  key: string,
) {
  const { expectedPrimaryTaskId: _id, ...legacy } = p;
  const action =
    kind === 'void'
      ? 'renewal.void'
      : kind === 'close-lost'
        ? 'renewal.close_lost'
        : 'renewal.close_won';
  const hash = await computePayloadHash({
    action,
    target: t.renewalId,
    payload: legacy,
    version: { expectedRenewalVersion: t.renewalVersion, expectedTaskVersion: t.taskVersion },
  });
  const db = f.env.DB;
  let injected = false;
  f.env.DB = new Proxy(db, {
    get(target, k) {
      if (k === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('INSERT INTO operation_receipts')) return statement;
          return new Proxy(statement, {
            get(s, name) {
              if (name === 'bind')
                return (...values: unknown[]) => {
                  if (values[5] === key) {
                    values[6] = hash;
                    injected = true;
                  }
                  return s.bind(...values);
                };
              const v = Reflect.get(s, name, s);
              return typeof v === 'function' ? v.bind(s) : v;
            },
          });
        };
      const v = Reflect.get(target, k, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    const r = await data<Result>(await post(endpoint(t, kind), p, 'ti-owner', key));
    expect(injected).toBe(true);
    return { legacy, r };
  } finally {
    f.env.DB = db;
  }
}
it.each(kinds)(
  'replays proven historical id-less receipts only, with live original-task authority: %s',
  async (kind) => {
    const t = await seed(),
      p = await body(t, kind),
      key = crypto.randomUUID(),
      { legacy, r } = await historical(t, kind, p, key),
      before = await snapshot();
    expect(await data<Result>(await post(endpoint(t, kind), legacy, 'ti-owner', key))).toEqual(r);
    expect((await post(endpoint(t, kind), legacy, 'ti-owner')).status).toBe(400);
    expect(
      (await post(endpoint(t, kind), { ...legacy, expectedTaskVersion: 99 }, 'ti-owner', key))
        .status,
    ).toBe(409);
    expect((await post(endpoint(t, kind), legacy, 'ti-foreign', key)).status).toBe(400);
    expect(await snapshot()).toBe(before);
    // Original Task authority changes after closure: a receipt is not an access grant.
    const csrf = await f.csrf(cookies['ti-owner']!);
    await f.db
      .prepare(
        "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,permission_version=permission_version+1 WHERE id='membership-ti-owner'",
      )
      .run();
    try {
      expect([401, 403, 404]).toContain(
        (
          await f.request(endpoint(t, kind), 'POST', cookies['ti-owner'], legacy, csrf, {
            'idempotency-key': key,
          })
        ).status,
      );
    } finally {
      await f.db
        .prepare(
          "UPDATE agency_memberships SET status='ACTIVE',version=version+1,permission_version=permission_version+1 WHERE id='membership-ti-owner'",
        )
        .run();
      // Suspension disables credentials as well as revoking sessions. Provision a
      // fresh fixture epoch; never revive or modify the revoked session rows.
      await f.db
        .prepare(
          "UPDATE local_credentials SET login_enabled=1,credential_version=credential_version+1 WHERE user_id='ti-owner'",
        )
        .run();
      cookies['ti-owner'] = (await f.session('ti-owner')).cookie;
    }
  },
);
async function competing(work: () => Promise<Response[]>) {
  const db = f.env.DB;
  let arrivals = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.env.DB = new Proxy(db, {
    get(target, k) {
      if (k === 'batch')
        return async (s: D1PreparedStatement[]) => {
          if (s.length >= 8 && arrivals < 2) {
            if (++arrivals === 2) release();
            await gate;
          }
          return target.batch(s);
        };
      const v = Reflect.get(target, k, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    const results = await work();
    expect(arrivals).toBe(2);
    return results;
  } finally {
    f.env.DB = db;
  }
}
it.each(kinds)(
  'serializes exact-key competing terminal requests on the same pinned task: %s',
  async (kind) => {
    const t = await seed(),
      p = await body(t, kind),
      key = crypto.randomUUID();
    const rs = await competing(() =>
      Promise.all([
        post(endpoint(t, kind), p, 'ti-owner', key),
        post(endpoint(t, kind), p, 'ti-owner', key),
      ]),
    );
    const a = await data<Result>(rs[0]!),
      b = await data<Result>(rs[1]!);
    expect(a).toEqual(b);
    await verify(t, a, key);
  },
);
it.each(kinds)(
  'rolls back terminal receipt/history/audit/policy links when exact task changes after preflight: %s',
  async (kind) => {
    const t = await seed(),
      p = await body(t, kind),
      db = f.env.DB;
    let reached = false,
      baseline = '';
    f.env.DB = new Proxy(db, {
      get(target, k) {
        if (k === 'batch')
          return async (s: D1PreparedStatement[]) => {
            if (s.length >= 8 && !reached) {
              reached = true;
              await replace(t);
              baseline = await snapshot();
            }
            return target.batch(s);
          };
        const v = Reflect.get(target, k, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    try {
      expect((await post(endpoint(t, kind), p)).status).toBe(409);
      expect(reached).toBe(true);
      expect(await snapshot()).toBe(baseline);
    } finally {
      f.env.DB = db;
    }
  },
);
it.each(['close-lost', 'void'] as const)(
  'completion versus %s has one winner and cannot silently close the replacement',
  async (kind) => {
    const t = await seed(),
      p = await body(t, kind);
    const rs = await competing(() =>
      Promise.all([
        post(endpoint(t, kind), p),
        post(`/api/renewals/${t.renewalId}/tasks/${t.taskId}/complete`, {
          expectedRenewalVersion: t.renewalVersion,
          expectedTaskVersion: t.taskVersion,
          replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      ]),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const state = await f.db
      .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
      .bind(t.renewalId)
      .first<{ state: string }>();
    const tasks = (
      await f.db
        .prepare('SELECT status FROM tasks WHERE renewal_id=?')
        .bind(t.renewalId)
        .all<{ status: string }>()
    ).results;
    if (state!.state === 'CONTACT_PENDING') {
      expect(tasks).toHaveLength(2);
      expect(tasks.filter((t) => t.status === 'OPEN')).toHaveLength(1);
    } else {
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('COMPLETED');
    }
  },
);
it('LOST versus VOIDED with the same pinned task and versions has only one atomic winner', async () => {
  const t = await seed(),
    lost = await body(t, 'close-lost'),
    voided = await body(t, 'void');
  const rs = await competing(() =>
    Promise.all([post(endpoint(t, 'close-lost'), lost), post(endpoint(t, 'void'), voided)]),
  );
  expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM renewal_state_history WHERE renewal_id=?')
      .bind(t.renewalId)
      .first<{ n: number }>())!.n,
  ).toBe(2);
});
it.each(['ti-ahmet', 'ti-ayse'])(
  'preserves %s own-task LOST authority and other-private-task denial',
  async (actor) => {
    const own = await seed(actor),
      other = await seed(actor === 'ti-ahmet' ? 'ti-ayse' : 'ti-ahmet'),
      ownBody = await body(own, 'close-lost'),
      otherBody = await body(other, 'close-lost'),
      before = await snapshot();
    expect([403, 404]).toContain(
      (await post(endpoint(other, 'close-lost'), otherBody, actor)).status,
    );
    expect(await snapshot()).toBe(before);
    const key = crypto.randomUUID(),
      r = await data<Result>(await post(endpoint(own, 'close-lost'), ownBody, actor, key));
    await verify(own, r, key);
    const unchanged = await snapshot();
    await data<Result>(await post(endpoint(own, 'close-lost'), ownBody, actor, key));
    expect(await snapshot()).toBe(unchanged);
  },
);
it('keeps HEALTH, foreign agency, live session and membership revocation fail closed', async () => {
  const t = await seed(),
    p = await body(t, 'void'),
    before = await snapshot();
  expect([403, 404]).toContain((await post(endpoint(t, 'void'), p, 'ti-foreign')).status);
  expect(await snapshot()).toBe(before);
  await f.db
    .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='ti-b'")
    .run();
  try {
    const before = await snapshot();
    expect([403, 404]).toContain((await post(endpoint(t, 'void'), p)).status);
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db
      .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='ti-b'")
      .run();
  }
  const s = await f.session('ti-owner'),
    csrf = await f.csrf(s.cookie);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), s.hash)
    .run();
  expect(
    (
      await f.request(endpoint(t, 'void'), 'POST', s.cookie, p, csrf, {
        'idempotency-key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(401);
});
