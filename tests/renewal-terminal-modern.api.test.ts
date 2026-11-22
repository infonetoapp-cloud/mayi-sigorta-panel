// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  customerId = '',
  serial = 0;
const cookies: Record<string, string> = {};
type Result = {
  renewalId: string;
  previousState: string;
  state: string;
  primaryTaskId: string;
  renewalVersion: number;
  taskVersion: number;
  closedAt: string;
  lossReasonId?: string;
  voidReasonCode?: string;
};
it.each(['close-lost', 'void'])(
  'rejects the original frozen terminal snapshot after its primary task was replaced (%s)',
  async (kind) => {
    const original = await seed(),
      body = kind === 'void' ? voided(original) : lost(original);
    const completion = await data<{
      replacementTaskId: string;
      replacementTaskVersion: number;
      renewalVersion: number;
    }>(
      await post(`/api/renewals/${original.renewalId}/tasks/${original.taskId}/complete`, {
        expectedRenewalVersion: original.renewalVersion,
        expectedTaskVersion: original.taskVersion,
        replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    );
    expect(completion.replacementTaskId).not.toBe(original.taskId);
    expect(completion.renewalVersion).toBe(original.renewalVersion);
    const before = await snapshot();
    const response = await post(url(original, kind), body);
    const returned = (await response.json()) as { data?: Result };
    const state = await f.db
      .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
      .bind(original.renewalId)
      .first();
    const tasks = (
      await f.db
        .prepare('SELECT id,status,version FROM tasks WHERE renewal_id=? ORDER BY id')
        .bind(original.renewalId)
        .all()
    ).results;
    const actual = {
      status: response.status,
      originalRenewalVersion: original.renewalVersion,
      originalTaskVersion: original.taskVersion,
      replacementInitialTaskVersion: completion.replacementTaskVersion,
      primaryTargetWasReplaced: returned.data?.primaryTaskId === completion.replacementTaskId,
      returnedState: returned.data?.state,
      returnedRenewalVersion: returned.data?.renewalVersion,
      returnedTaskVersion: returned.data?.taskVersion,
      state,
      tasks: tasks.map((t) => ({
        original: t.id === original.taskId,
        replacement: t.id === completion.replacementTaskId,
        status: t.status,
        version: t.version,
      })),
      unchanged: (await snapshot()) === before,
    };
    expect(actual, JSON.stringify(actual)).toMatchObject({ status: 409, unchanged: true });
  },
);
const codes = [
  'TECHNICAL_ERROR',
  'DUPLICATE',
  'NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE',
] as const;
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function post(url: string, body: unknown, actor = 'tf-owner', key = crypto.randomUUID()) {
  return f.request(url, 'POST', cookies[actor], body, await f.csrf(cookies[actor]!), {
    'idempotency-key': key,
  });
}
async function seed(actor = 'tf-ahmet') {
  const p = await data<{ id: string }>(
    await post('/api/policies', {
      customerId,
      insurerId: 'tf-i',
      productId: 'tf-p',
      branchId: 'tf-b',
      paymentMethodId: 'tf-m',
      policyNumber: 'TF-' + ++serial,
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
      await f.request('/api/tasks/today?limit=50', 'GET', cookies['tf-owner']),
    )
  ).items.find((t) => t.policyId === p.id)!;
}
const lost = (t: TodayTaskDto) => ({
  expectedPrimaryTaskId: t.taskId,
  expectedRenewalVersion: t.renewalVersion,
  expectedTaskVersion: t.taskVersion,
  lossReasonId: 'tf-price',
  lossReasonNotes: null,
});
const voided = (t: TodayTaskDto, code: string = 'TECHNICAL_ERROR') => ({
  expectedPrimaryTaskId: t.taskId,
  expectedRenewalVersion: t.renewalVersion,
  expectedTaskVersion: t.taskVersion,
  voidReasonCode: code,
});
const url = (t: TodayTaskDto, kind = 'close-lost') => `/api/renewals/${t.renewalId}/${kind}`;
async function snapshot() {
  const s: Record<string, unknown> = {};
  for (const table of [
    'renewal_opportunities',
    'tasks',
    'renewal_state_history',
    'operation_receipts',
    'audit_events',
    'policies',
  ])
    s[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  return JSON.stringify(s);
}
beforeAll(async () => {
  f = await localAuthFixture();
  for (const actor of ['tf-owner', 'tf-ahmet', 'tf-ayse', 'tf-foreign']) {
    const m = await f.seed(
      actor,
      actor === 'tf-owner' || actor === 'tf-foreign' ? 'OWNER' : 'MEMBER',
      false,
      actor === 'tf-foreign' ? 'tf-other' : 'agency-auth-test',
    );
    if (actor === 'tf-ahmet' || actor === 'tf-ayse')
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
  await f.db
    .prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('tf-i','agency-auth-test','TF','Sentetik')",
    )
    .run();
  customerId = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Sonuç',
        insurerNumber: { insurerId: 'tf-i', customerNumber: 'TF-CUSTOMER' },
      }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('tf-b','agency-auth-test','TF','Sentetik','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('tf-p','agency-auth-test','tf-i','tf-b','TF','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('tf-m','agency-auth-test','TF','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('tf-price','agency-auth-test','PRICE','Fiyat'),('tf-other','agency-auth-test','OTHER','Diğer')",
    ),
  ]);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function verify(t: TodayTaskDto, r: Result, key: string, previousTaskIds: string[] = []) {
  expect(r).toMatchObject({
    renewalId: t.renewalId,
    primaryTaskId: t.taskId,
    previousState: t.renewalState,
    renewalVersion: t.renewalVersion + 1,
    taskVersion: t.taskVersion + 1,
  });
  expect(new Date(r.closedAt).toISOString()).toBe(r.closedAt);
  const renewal = await f.db
    .prepare(
      'SELECT state,version,closed_at,loss_reason_id,loss_reason_notes,void_reason_code FROM renewal_opportunities WHERE id=?',
    )
    .bind(t.renewalId)
    .first();
  expect(renewal).toMatchObject({
    state: r.state,
    version: r.renewalVersion,
    closed_at: r.closedAt,
  });
  const tasks = (
    await f.db
      .prepare('SELECT id,status,version FROM tasks WHERE renewal_id=?')
      .bind(t.renewalId)
      .all<{ id: string; status: string; version: number }>()
  ).results;
  expect(tasks.map(({ id }) => id).sort()).toEqual([t.taskId, ...previousTaskIds].sort());
  expect(tasks.find(({ id }) => id === t.taskId)).toMatchObject({
    status: 'COMPLETED',
    version: r.taskVersion,
  });
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM renewal_state_history WHERE renewal_id=?')
      .bind(t.renewalId)
      .first<{ n: number }>())!.n,
  ).toBe(2);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await f.db
      .prepare("SELECT count(*) n FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'")
      .bind(key)
      .first<{ n: number }>())!.n,
  ).toBe(1);
  const read = await data<{
    items: { id: string; state: string; version: number }[];
    nextCursor: string | null;
  }>(await f.request(`/api/customers/${customerId}/renewals?limit=50`, 'GET', cookies['tf-owner']));
  expect(read.items.find((x) => x.id === t.renewalId)).toMatchObject({
    state: r.state,
    version: r.renewalVersion,
  });
  return renewal;
}
it.each(['tf-owner', 'tf-ahmet', 'tf-ayse'])(
  'closes LOST atomically for authorized %s with no replacement and exact replay',
  async (actor) => {
    const t = await seed(actor),
      key = crypto.randomUUID(),
      r = await data<Result>(await post(url(t), lost(t), actor, key));
    expect(r.lossReasonId).toBe('tf-price');
    await verify(t, r, key);
    const before = await snapshot();
    expect(await data<Result>(await post(url(t), lost(t), actor, key))).toEqual(r);
    expect(
      (
        await post(
          url(t),
          { ...lost(t), lossReasonId: 'tf-other', lossReasonNotes: 'Farklı' },
          actor,
          key,
        )
      ).status,
    ).toBe(409);
    expect(await snapshot()).toBe(before);
  },
);
it('requires OTHER trimmed note and rejects inactive/invalid reasons without effects', async () => {
  const t = await seed();
  for (const body of [
    { ...lost(t), lossReasonId: 'tf-other' },
    { ...lost(t), lossReasonId: 'tf-other', lossReasonNotes: ' ' },
    { ...lost(t), lossReasonNotes: 'Gereksiz' },
    { ...lost(t), lossReasonId: 'missing' },
    { ...lost(t), lossReasonId: 'tf-other', lossReasonNotes: 'x'.repeat(501) },
  ]) {
    const before = await snapshot();
    expect([400, 409]).toContain((await post(url(t), body)).status);
    expect(await snapshot()).toBe(before);
  }
  await f.db.prepare("UPDATE loss_reasons SET status='INACTIVE' WHERE id='tf-price'").run();
  try {
    const before = await snapshot();
    expect((await post(url(t), lost(t))).status).toBe(409);
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db.prepare("UPDATE loss_reasons SET status='ACTIVE' WHERE id='tf-price'").run();
  }
  const key = crypto.randomUUID(),
    r = await data<Result>(
      await post(
        url(t),
        { ...lost(t), lossReasonId: 'tf-other', lossReasonNotes: '  Sentetik açıklama  ' },
        'tf-owner',
        key,
      ),
    );
  expect(await verify(t, r, key)).toMatchObject({
    loss_reason_id: 'tf-other',
    loss_reason_notes: 'Sentetik açıklama',
    void_reason_code: null,
  });
});
it.each(codes)(
  'closes VOIDED only with canonical reason %s and preserves LOST separation',
  async (code) => {
    const t = await seed(),
      key = crypto.randomUUID(),
      r = await data<Result>(await post(url(t, 'void'), voided(t, code), 'tf-owner', key));
    expect(r.voidReasonCode).toBe(code);
    expect(await verify(t, r, key)).toMatchObject({
      loss_reason_id: null,
      loss_reason_notes: null,
      void_reason_code: code,
    });
    const before = await snapshot();
    expect(
      await data<Result>(await post(url(t, 'void'), voided(t, code), 'tf-owner', key)),
    ).toEqual(r);
    expect(
      (
        await post(
          url(t, 'void'),
          voided(
            t,
            codes.find((c) => c !== code)!,
          ),
          'tf-owner',
          key,
        )
      ).status,
    ).toBe(409);
    expect(await snapshot()).toBe(before);
  },
);
it.each(['tf-ahmet', 'tf-ayse'])(
  'denies standard %s VOID and another employee task despite shared records',
  async (actor) => {
    const own = await seed(actor),
      other = await seed(actor === 'tf-ahmet' ? 'tf-ayse' : 'tf-ahmet'),
      before = await snapshot();
    expect([403, 404]).toContain((await post(url(own, 'void'), voided(own), actor)).status);
    expect([403, 404]).toContain((await post(url(other), lost(other), actor)).status);
    expect(await snapshot()).toBe(before);
  },
);
it('rejects stale dual CAS and invalid VOID fields without evidence', async () => {
  const t = await seed();
  for (const [route, body] of [
    ['close-lost', { ...lost(t), expectedRenewalVersion: t.renewalVersion + 1 }],
    ['close-lost', { ...lost(t), expectedTaskVersion: t.taskVersion + 1 }],
    ['void', { ...voided(t), voidReasonCode: 'PRICE' }],
    ['void', { ...voided(t), voidReasonNotes: 'not allowed' }],
  ] as const) {
    const before = await snapshot();
    expect([400, 409]).toContain((await post(url(t, route), body)).status);
    expect(await snapshot()).toBe(before);
  }
});
it('denies foreign/HEALTH/revoked session and keeps customer renewals read independent', async () => {
  const t = await seed(),
    before = await snapshot();
  expect([403, 404]).toContain((await post(url(t), lost(t), 'tf-foreign')).status);
  expect(await snapshot()).toBe(before);
  await f.db
    .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='tf-b'")
    .run();
  try {
    const s = await snapshot();
    expect([403, 404]).toContain((await post(url(t), lost(t))).status);
    expect(await snapshot()).toBe(s);
  } finally {
    await f.db
      .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='tf-b'")
      .run();
  }
  const session = await f.session('tf-owner'),
    csrf = await f.csrf(session.cookie);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), session.hash)
    .run();
  expect(
    (
      await f.request(url(t), 'POST', session.cookie, lost(t), csrf, {
        'idempotency-key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(401);
});
async function competing(work: () => Promise<Response[]>) {
  const db = f.env.DB;
  let arrivals = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (st: D1PreparedStatement[]) => {
          if (st.length >= 8 && arrivals < 2) {
            if (++arrivals === 2) release();
            await gate;
          }
          return target.batch(st);
        };
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    const r = await work();
    expect(arrivals).toBe(2);
    return r;
  } finally {
    f.env.DB = db;
  }
}
it.each(['lost/lost', 'void/void', 'lost/void', 'complete/lost'])(
  'serializes competing %s outcomes with one atomic winner',
  async (kind) => {
    const t = await seed(),
      before = JSON.parse(await snapshot()) as Record<string, unknown[]>;
    const a = kind.startsWith('void')
      ? post(url(t, 'void'), voided(t))
      : kind.startsWith('complete')
        ? post(`/api/renewals/${t.renewalId}/tasks/${t.taskId}/complete`, {
            expectedRenewalVersion: t.renewalVersion,
            expectedTaskVersion: t.taskVersion,
            replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
          })
        : post(url(t), lost(t));
    const responses = await competing(() =>
      Promise.all([
        a,
        kind.endsWith('void') ? post(url(t, 'void'), voided(t)) : post(url(t), lost(t)),
      ]),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = JSON.parse(await snapshot()) as Record<string, unknown[]>;
    expect(after.operation_receipts!.length).toBe(before.operation_receipts!.length + 1);
    expect(after.audit_events!.length).toBe(before.audit_events!.length + 1);
    const row = await f.db
      .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
      .bind(t.renewalId)
      .first<{ state: string }>();
    const tasks = (
      await f.db
        .prepare('SELECT status FROM tasks WHERE renewal_id=?')
        .bind(t.renewalId)
        .all<{ status: string }>()
    ).results;
    if (['LOST', 'VOIDED'].includes(row!.state)) {
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('COMPLETED');
    } else {
      expect(tasks).toHaveLength(2);
      expect(tasks.filter((t) => t.status === 'OPEN')).toHaveLength(1);
    }
  },
);
it.each(['close-lost', 'void'])('reconciles concurrent exact-key receipts for %s', async (kind) => {
  const t = await seed(),
    key = crypto.randomUUID(),
    body = kind === 'void' ? voided(t) : lost(t);
  const replies = await competing(() =>
    Promise.all([
      post(url(t, kind), body, 'tf-owner', key),
      post(url(t, kind), body, 'tf-owner', key),
    ]),
  );
  expect(await data<Result>(replies[0]!)).toEqual(await data<Result>(replies[1]!));
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
it('keeps independent customer renewals permission denial separate from successful closure', async () => {
  const t = await seed('tf-ahmet');
  await data(await post(url(t), lost(t), 'tf-ahmet'));
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-tf-ahmet' AND permission_code='policy.read'",
    )
    .run();
  try {
    expect(
      (
        await f.request(
          `/api/customers/${customerId}/renewals?limit=50`,
          'GET',
          cookies['tf-ahmet'],
        )
      ).status,
    ).toBe(403);
  } finally {
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-tf-ahmet','policy.read','AGENCY')",
      )
      .bind(crypto.randomUUID())
      .run();
  }
  expect(
    await f.db.prepare('SELECT status FROM tasks WHERE id=?').bind(t.taskId).first(),
  ).toMatchObject({ status: 'COMPLETED' });
});
it('reads and closes an authorized later cursor-page task without first-page assumptions', async () => {
  await seed();
  await seed();
  const first = await data<TodayTasksResponseData>(
    await f.request('/api/tasks/today?limit=1', 'GET', cookies['tf-owner']),
  );
  expect(first.nextCursor).toBeTruthy();
  const later = await data<TodayTasksResponseData>(
    await f.request(
      '/api/tasks/today?limit=1&cursor=' + encodeURIComponent(first.nextCursor!),
      'GET',
      cookies['tf-owner'],
    ),
  );
  const t = later.items[0]!;
  expect(t.taskId).not.toBe(first.items[0]!.taskId);
  const previousTasks = (
    await f.db
      .prepare('SELECT id FROM tasks WHERE renewal_id=? AND id<>?')
      .bind(t.renewalId, t.taskId)
      .all<{ id: string }>()
  ).results;
  const key = crypto.randomUUID(),
    r = await data<Result>(await post(url(t), lost(t), 'tf-owner', key));
  await verify(
    t,
    r,
    key,
    previousTasks.map(({ id }) => id),
  );
});
it.each(['reason', 'permission', 'session'])(
  'rejects live %s revocation at final batch with no business evidence',
  async (kind) => {
    const t = await seed('tf-ahmet'),
      db = f.env.DB;
    let reached = false,
      baseline = '';
    f.env.DB = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async (st: D1PreparedStatement[]) => {
            if (st.length >= 8 && !reached) {
              reached = true;
              if (kind === 'reason')
                await f.db
                  .prepare("UPDATE loss_reasons SET status='INACTIVE' WHERE id='tf-price'")
                  .run();
              else if (kind === 'permission')
                await f.db
                  .prepare(
                    "DELETE FROM membership_permissions WHERE membership_id='membership-tf-ahmet' AND permission_code='renewal.close_lost'",
                  )
                  .run();
              else
                await f.db
                  .prepare("UPDATE local_sessions SET revoked_at=? WHERE user_id='tf-ahmet'")
                  .bind(Date.now())
                  .run();
              baseline = await snapshot();
            }
            return target.batch(st);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    try {
      const r = await post(url(t), lost(t), 'tf-ahmet');
      expect(reached).toBe(true);
      expect([401, 403, 404, 409]).toContain(r.status);
      expect(await snapshot()).toBe(baseline);
      expect(
        (await f.db.prepare('SELECT count(*) n FROM d1_cas_assertions').first<{ n: number }>())!.n,
      ).toBe(0);
    } finally {
      f.env.DB = db;
      if (kind === 'reason')
        await f.db.prepare("UPDATE loss_reasons SET status='ACTIVE' WHERE id='tf-price'").run();
      if (kind === 'permission')
        await f.db
          .prepare(
            "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-tf-ahmet','renewal.close_lost','AGENCY')",
          )
          .bind(crypto.randomUUID())
          .run();
      if (kind === 'session') cookies['tf-ahmet'] = (await f.session('tf-ahmet')).cookie;
    }
  },
);
