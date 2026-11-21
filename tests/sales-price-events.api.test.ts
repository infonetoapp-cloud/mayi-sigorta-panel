// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
const customerId = 'price-events-c';
type Event = 'SHARED' | 'CUSTOMER_ACCEPTED' | 'ACCEPTANCE_REVOKED';
type Source = {
  caseId: string;
  caseVersion: number;
  priceId: string;
  priceVersion: number;
  revisionId: string;
  taskId: string;
  taskVersion: number;
};
type Result = {
  operationId: string;
  caseId: string;
  caseVersion: number;
  eventId: string;
  revisionId: string;
  event: Event;
  occurredAt: string;
};
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('price-events-owner', 'OWNER');
  await f.seed('price-events-staff');
  await f.seed('price-events-foreign', 'OWNER', false, 'price-events-foreign-agency');
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['quote.read', 'AGENCY'],
    ['quote.manage', 'AGENCY'],
    ['task.read', 'AGENCY'],
    ['task.create', 'UNSCOPED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-price-events-staff', code, scope)
      .run();
  for (const who of ['price-events-owner', 'price-events-staff', 'price-events-foreign'])
    cookies[who] = (await f.session(who)).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('price-events-c','agency-auth-test','INDIVIDUAL','Onay Müşterisi','Onay','Müşterisi','membership-price-events-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('price-events-i','agency-auth-test','PE','Anadolu Sigorta')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('price-events-b','agency-auth-test','PE','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('price-events-h','agency-auth-test','PEH','Sağlık','HEALTH')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
const base = (id: string) => `/api/sales-cases/${id}`;
async function post(
  url: string,
  body: unknown,
  key = crypto.randomUUID(),
  who = 'price-events-owner',
) {
  return f.request(url, 'POST', cookies[who], body, await f.csrf(cookies[who]!), {
    'idempotency-key': key,
  });
}
async function get(url: string, who = 'price-events-owner') {
  return f.request(url, 'GET', cookies[who]);
}
async function data<T>(r: Response, status = 200) {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function source(who = 'price-events-owner', branchId = 'price-events-b'): Promise<Source> {
  const c = await data<{ caseId: string; taskId: string; taskVersion: number }>(
    await post(
      `/api/customers/${customerId}/sales-cases`,
      {
        context: 'NEW_BUSINESS',
        branchId,
        cycleDate: null,
        dateBasis: 'MANUAL',
        followup: { dueAt: '2027-01-10T06:00:00.000Z' },
        confirmSimilar: true,
      },
      crypto.randomUUID(),
      who,
    ),
    201,
  );
  const p = await data<{
    caseVersion: number;
    priceId: string;
    priceVersion: number;
    revisionId: string;
  }>(
    await post(
      base(c.caseId) + '/prices',
      {
        expectedCaseVersion: 1,
        insurerId: 'price-events-i',
        amountMinor: 1250050,
        currency: 'TRY',
        termsNote: null,
        offeredPeriod: null,
      },
      crypto.randomUUID(),
      who,
    ),
    201,
  );
  return { ...c, ...p };
}
function command(s: Source, event: Event = 'SHARED') {
  return {
    expectedCaseVersion: s.caseVersion,
    revisionId: s.revisionId,
    event,
    occurredAt: new Date().toISOString(),
    expectedTaskId: s.taskId,
    expectedTaskVersion: s.taskVersion,
  };
}
async function event(s: Source, kind: Event = 'SHARED', who = 'price-events-owner') {
  const body = command(s, kind),
    result = await data<Result>(
      await post(base(s.caseId) + '/price-events', body, crypto.randomUUID(), who),
      201,
    );
  s.caseVersion = result.caseVersion;
  return result;
}
const timeline = (s: Source, suffix = '') =>
  base(s.caseId) + `/prices/${s.priceId}/revisions/${s.revisionId}/events${suffix}`;
async function snapshot(s: Source) {
  return {
    task: await f.db.prepare('SELECT * FROM tasks WHERE id=?').bind(s.taskId).first(),
    case: await f.db.prepare('SELECT version FROM sales_cases WHERE id=?').bind(s.caseId).first(),
    events: (
      await f.db
        .prepare('SELECT * FROM sales_price_events WHERE case_id=? ORDER BY id')
        .bind(s.caseId)
        .all()
    ).results,
  };
}

it('records revision-specific share, acceptance, revoke and reaccept evidence without mutating the actual Task or issuing a policy', async () => {
  const s = await source(),
    taskBefore = (await snapshot(s)).task;
  expect(
    (await post(base(s.caseId) + '/price-events', command(s, 'CUSTOMER_ACCEPTED'))).status,
  ).toBe(409);
  const context = await data<{
    taskId: string;
    taskVersion: number;
    revisionId: string;
    caseVersion: number;
    allowedEvents: Event[];
  }>(await get(base(s.caseId) + '/price-event-context/' + s.revisionId));
  expect(context).toMatchObject({
    taskId: s.taskId,
    taskVersion: 1,
    revisionId: s.revisionId,
    caseVersion: 2,
  });
  expect(context.allowedEvents).toContain('SHARED');
  const body = command(s),
    key = crypto.randomUUID(),
    shared = await data<Result>(await post(base(s.caseId) + '/price-events', body, key), 201);
  s.caseVersion = shared.caseVersion;
  expect(shared).toMatchObject({
    caseId: s.caseId,
    caseVersion: 3,
    revisionId: s.revisionId,
    event: 'SHARED',
    occurredAt: body.occurredAt,
  });
  expect(await (await post(base(s.caseId) + '/price-events', body, key)).json()).toMatchObject({
    data: shared,
    replayed: true,
  });
  expect(
    (await post(base(s.caseId) + '/price-events', { ...body, event: 'CUSTOMER_ACCEPTED' }, key))
      .status,
  ).toBe(409);
  await event(s, 'CUSTOMER_ACCEPTED');
  await event(s, 'ACCEPTANCE_REVOKED');
  await event(s, 'CUSTOMER_ACCEPTED');
  expect((await snapshot(s)).task).toEqual(taskBefore);
  expect(await f.db.prepare('SELECT count(*) n FROM policies').first()).toEqual({ n: 0 });
  const history = await data<{ events: { event: string }[] }>(await get(timeline(s)));
  expect(history.events.map((e) => e.event).sort()).toEqual([
    'ACCEPTANCE_REVOKED',
    'CUSTOMER_ACCEPTED',
    'CUSTOMER_ACCEPTED',
    'SHARED',
  ]);
  expect(
    await (await get(base(s.caseId) + '/price-event-operations/' + shared.operationId)).json(),
  ).toMatchObject({ data: shared });
  await expect(
    f.db
      .prepare('UPDATE sales_price_events SET event_code=event_code WHERE id=?')
      .bind(shared.eventId)
      .run(),
  ).rejects.toThrow();
  await expect(
    f.db.prepare('DELETE FROM sales_price_events WHERE id=?').bind(shared.eventId).run(),
  ).rejects.toThrow();
});

it('allows public bounded event history while keeping event context and writes tied to the real private Task and required interaction grant', async () => {
  const own = await source('price-events-staff');
  await event(own, 'SHARED', 'price-events-staff');
  expect([403, 404]).toContain(
    (
      await post(
        base(own.caseId) + '/price-events',
        command(own, 'CUSTOMER_ACCEPTED'),
        crypto.randomUUID(),
        'price-events-staff',
      )
    ).status,
  );
  const privateSource = await source();
  await event(privateSource);
  const shared = await get(timeline(privateSource), 'price-events-staff');
  expect(shared.status).toBe(200);
  expect(await shared.text()).not.toMatch(
    /taskId|expectedTask|assignee|actor|receiptId|operationId/,
  );
  expect(
    (
      await get(
        base(privateSource.caseId) + '/price-event-context/' + privateSource.revisionId,
        'price-events-staff',
      )
    ).status,
  ).toBe(404);
  expect([403, 404]).toContain(
    (
      await post(
        base(privateSource.caseId) + '/price-events',
        command(privateSource, 'CUSTOMER_ACCEPTED'),
        crypto.randomUUID(),
        'price-events-staff',
      )
    ).status,
  );
  expect((await get(timeline(privateSource), 'price-events-foreign')).status).toBe(404);
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-price-events-staff','interaction.create','AGENCY')",
    )
    .bind(crypto.randomUUID())
    .run();
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-price-events-staff','interaction.read','AGENCY')",
    )
    .bind(crypto.randomUUID())
    .run();
  await event(own, 'CUSTOMER_ACCEPTED', 'price-events-staff');
  const page = await data<{ events: unknown[]; hasMore: boolean; nextCursor: string }>(
    await get(timeline(own, '?limit=1')),
  );
  expect(page.events).toHaveLength(1);
  expect(page.hasMore).toBe(true);
  expect(
    (
      await get(
        timeline(own, '?limit=1&cursor=' + encodeURIComponent(page.nextCursor)),
        'price-events-staff',
      )
    ).status,
  ).toBe(400);
  expect((await get(timeline(own, '?limit=51'))).status).toBe(400);
});

it('rejects stale source identities and snapshots, future dates and backward event chronology without inheriting acceptance onto a new revision', async () => {
  const s = await source(),
    before = await snapshot(s);
  for (const patch of [
    { expectedCaseVersion: 999 },
    { expectedTaskVersion: 999 },
    { expectedTaskId: 'another-task' },
    { revisionId: 'missing-revision' },
    { occurredAt: new Date(Date.now() + 3600000).toISOString() },
  ]) {
    const r = await post(base(s.caseId) + '/price-events', { ...command(s), ...patch });
    expect([400, 404, 409]).toContain(r.status);
    expect(await snapshot(s)).toEqual(before);
  }
  const shared = await event(s);
  const backward = await post(base(s.caseId) + '/price-events', {
    ...command(s, 'CUSTOMER_ACCEPTED'),
    occurredAt: new Date(Date.parse(shared.occurredAt) - 1).toISOString(),
  });
  expect([400, 409]).toContain(backward.status);
  await event(s, 'CUSTOMER_ACCEPTED');
  const oldRevision = s.revisionId;
  const changed = await data<{ caseVersion: number; priceVersion: number; revisionId: string }>(
    await post(base(s.caseId) + `/prices/${s.priceId}/revisions`, {
      expectedCaseVersion: s.caseVersion,
      expectedPriceVersion: 1,
      amountMinor: 1300000,
      currency: 'TRY',
      termsNote: null,
      offeredPeriod: null,
    }),
  );
  Object.assign(s, changed);
  expect(
    (await post(base(s.caseId) + '/price-events', command(s, 'CUSTOMER_ACCEPTED'))).status,
  ).toBe(409);
  expect(
    (await post(base(s.caseId) + '/price-events', { ...command(s), revisionId: oldRevision }))
      .status,
  ).toBe(409);
  const ctx = await data<{ allowedEvents: Event[] }>(
    await get(base(s.caseId) + '/price-event-context/' + s.revisionId),
  );
  expect(ctx.allowedEvents).not.toContain('CUSTOMER_ACCEPTED');
});

it('rolls event, case/history and receipt back when the final audit fails and serializes concurrent exact retries', async () => {
  const s = await source(),
    before = await snapshot(s),
    key = crypto.randomUUID();
  await f.db
    .prepare(
      "CREATE TRIGGER price_event_audit_fail BEFORE INSERT ON audit_events WHEN NEW.target_id='" +
        s.caseId +
        "' AND NEW.action LIKE 'sales.price.event%' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EVENT_AUDIT_FAIL'); END;",
    )
    .run();
  try {
    expect((await post(base(s.caseId) + '/price-events', command(s), key)).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER price_event_audit_fail').run();
  }
  expect(await snapshot(s)).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  const retryKey = crypto.randomUUID(),
    body = command(s),
    attempts = await Promise.all([
      post(base(s.caseId) + '/price-events', body, retryKey),
      post(base(s.caseId) + '/price-events', body, retryKey),
    ]);
  expect(attempts.map((r) => r.status)).toEqual([201, 201]);
  const results = await Promise.all(attempts.map((r) => r.json()));
  expect((results[0] as { data: Result }).data).toEqual((results[1] as { data: Result }).data);
  const competing = await source(),
    raceBody = command(competing),
    raced = await Promise.all([
      post(base(competing.caseId) + '/price-events', raceBody),
      post(base(competing.caseId) + '/price-events', raceBody),
    ]);
  expect(raced.map((r) => r.status).sort()).toEqual([201, 409]);
});

it('resolves the renewal current primary Task after replacement while exactly replaying historical event evidence', async () => {
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('price-events-pr','agency-auth-test','price-events-i','price-events-b','PE','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('price-events-pay','agency-auth-test','PE','Nakit')",
    ),
    f.db.prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('price-events-policy','agency-auth-test','price-events-c','price-events-i','price-events-pr','price-events-b','price-events-pay','membership-price-events-owner','PE-POLICY','PEPOLICY','2026-01-01','2027-01-20',12345,'TRY')",
    ),
    f.db.prepare(
      "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id) VALUES('price-events-renewal','agency-auth-test','price-events-policy','membership-price-events-owner')",
    ),
    f.db.prepare(
      "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES('price-events-primary','agency-auth-test','price-events-c','price-events-renewal','RENEWAL_FOLLOWUP','Yenileme','2027-01-10T06:00:00.000Z','membership-price-events-owner','SYSTEM')",
    ),
  ]);
  const c = await data<{ caseId: string; taskId: string; taskVersion: number }>(
    await post(`/api/customers/${customerId}/sales-cases`, {
      context: 'RENEWAL',
      renewalId: 'price-events-renewal',
      expectedVersion: 1,
      expectedPrimaryTaskId: 'price-events-primary',
      expectedPrimaryTaskVersion: 1,
    }),
    201,
  );
  const p = await data<{
      caseVersion: number;
      priceId: string;
      priceVersion: number;
      revisionId: string;
    }>(
      await post(base(c.caseId) + '/prices', {
        expectedCaseVersion: 1,
        insurerId: 'price-events-i',
        amountMinor: 12345,
        currency: 'TRY',
        termsNote: null,
        offeredPeriod: null,
      }),
      201,
    ),
    s: Source = { ...c, ...p };
  const body = command(s),
    key = crypto.randomUUID(),
    shared = await data<Result>(await post(base(s.caseId) + '/price-events', body, key), 201);
  s.caseVersion = shared.caseVersion;
  const replacement = await data<{ replacementTaskId: string; replacementTaskVersion: number }>(
    await post('/api/renewals/price-events-renewal/tasks/price-events-primary/complete', {
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      replacementDueAt: '2027-01-12T06:00:00.000Z',
      followupReason: 'CALL_AGAIN',
    }),
  );
  expect(await (await post(base(s.caseId) + '/price-events', body, key)).json()).toMatchObject({
    data: shared,
    replayed: true,
  });
  expect([404, 409]).toContain(
    (await post(base(s.caseId) + '/price-events', command(s, 'CUSTOMER_ACCEPTED'))).status,
  );
  const ctx = await data<{ taskId: string; taskVersion: number }>(
    await get(base(s.caseId) + '/price-event-context/' + s.revisionId),
  );
  expect(ctx).toMatchObject({
    taskId: replacement.replacementTaskId,
    taskVersion: replacement.replacementTaskVersion,
  });
  s.taskId = ctx.taskId;
  s.taskVersion = ctx.taskVersion;
  await event(s, 'CUSTOMER_ACCEPTED');
  const renewalVersion = await f.db
    .prepare("SELECT version FROM renewal_opportunities WHERE id='price-events-renewal'")
    .first<{ version: number }>();
  const closed = await post('/api/renewals/price-events-renewal/void', {
    expectedPrimaryTaskId: s.taskId,
    expectedRenewalVersion: renewalVersion!.version,
    expectedTaskVersion: s.taskVersion,
    voidReasonCode: 'DUPLICATE',
  });
  expect(closed.status, await closed.clone().text()).toBe(200);
  expect([404, 409]).toContain(
    (await post(base(s.caseId) + '/price-events', command(s, 'ACCEPTANCE_REVOKED'))).status,
  );
  expect(await (await post(base(s.caseId) + '/price-events', body, key)).json()).toMatchObject({
    data: shared,
    replayed: true,
  });
  expect((await get(timeline(s))).status).toBe(200);
});

it('enforces HEALTH for owners and rejects a permission/session change at the final event-write boundary without partial evidence', async () => {
  for (const code of ['sensitive.health.read', 'sensitive.health.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-price-events-owner', code, 'UNSCOPED')
      .run();
  cookies['price-events-owner'] = (await f.session('price-events-owner')).cookie;
  const health = await source('price-events-owner', 'price-events-h');
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-price-events-owner' AND permission_code LIKE 'sensitive.health.%'",
    )
    .run();
  expect([403, 404]).toContain(
    (await post(base(health.caseId) + '/price-events', command(health))).status,
  );
  cookies['price-events-staff'] = (await f.session('price-events-staff')).cookie;
  const s = await source('price-events-staff'),
    before = await snapshot(s),
    key = crypto.randomUUID(),
    csrf = await f.csrf(cookies['price-events-staff']!),
    original = f.env.DB;
  let preparedWrite = false,
    changed = false;
  f.env.DB = {
    prepare(sql: string) {
      if (/INSERT\s+INTO\s+[`"]?sales_price_events\b/i.test(sql)) preparedWrite = true;
      return original.prepare(sql);
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (preparedWrite && !changed) {
        changed = true;
        await original
          .prepare(
            "DELETE FROM membership_permissions WHERE membership_id='membership-price-events-staff' AND permission_code='quote.manage'",
          )
          .run();
        await original
          .prepare(
            "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-price-events-staff'",
          )
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const r = await f.request(
      base(s.caseId) + '/price-events',
      'POST',
      cookies['price-events-staff'],
      command(s),
      csrf,
      { 'idempotency-key': key },
    );
    expect(changed).toBe(true);
    expect(r.status, await r.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(await snapshot(s)).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
});
