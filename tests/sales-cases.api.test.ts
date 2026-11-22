// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { verifySalesRecovery } from '../scripts/recovery/sales-data-proof';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  owner: string,
  staff: string,
  foreign: string,
  customerId: string;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('sales-owner', 'OWNER');
  await f.seed('sales-staff');
  await f.seed('sales-other', 'OWNER', false, 'sales-foreign');
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['quote.read', 'AGENCY'],
    ['quote.manage', 'AGENCY'],
    ['task.read', 'ASSIGNED'],
    ['task.create', 'UNSCOPED'],
    ['task.update', 'ASSIGNED'],
    ['report.operations', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-sales-staff', code, scope)
      .run();
  owner = (await f.session('sales-owner')).cookie;
  staff = (await f.session('sales-staff')).cookie;
  foreign = (await f.session('sales-other')).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('sales-i','agency-auth-test','S','Şirket')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('sales-b','agency-auth-test','S','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('sales-h','agency-auth-test','H','Sağlık','HEALTH')",
    ),
  ]);
  const c = await post('/api/customers', {
    type: 'INDIVIDUAL',
    firstName: 'Poliçesiz',
    lastName: 'Müşteri',
    insurerNumber: { insurerId: 'sales-i', customerNumber: '000-SALES' },
  });
  expect(c.status).toBe(201);
  customerId = ((await c.json()) as { data: { id: string } }).data.id;
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
function body() {
  return {
    context: 'NEW_BUSINESS',
    branchId: 'sales-b',
    cycleDate: null,
    dateBasis: 'MANUAL',
    followup: { dueAt: '2027-01-10T06:00:00.000Z' },
    confirmSimilar: true,
  };
}
async function post(path: string, b: unknown, key = crypto.randomUUID(), cookie = owner) {
  return f.request(path, 'POST', cookie, b, await f.csrf(cookie), { 'idempotency-key': key });
}
async function create(cookie = owner) {
  const r = await post(
    `/api/customers/${customerId}/sales-cases`,
    body(),
    crypto.randomUUID(),
    cookie,
  );
  expect(r.status, await r.clone().text()).toBe(201);
  return (
    (await r.json()) as {
      data: {
        caseId: string;
        caseVersion: number;
        taskId: string;
        taskVersion: number;
        dueAt: string;
      };
    }
  ).data;
}
it('creates a real policy-free case/Task/link/history atomically, preserving manual dates and exact replay', async () => {
  const key = crypto.randomUUID(),
    url = `/api/customers/${customerId}/sales-cases`,
    b = body();
  const r = await post(url, b, key, staff);
  expect(r.status, await r.clone().text()).toBe(201);
  const data = ((await r.json()) as { data: Record<string, unknown> }).data;
  expect(
    await f.db
      .prepare(
        'SELECT kind,policy_id,renewal_id,assignee_membership_id,due_at FROM tasks WHERE id=?',
      )
      .bind(data.taskId)
      .first(),
  ).toEqual({
    kind: 'GENERAL',
    policy_id: null,
    renewal_id: null,
    assignee_membership_id: 'membership-sales-staff',
    due_at: b.followup.dueAt,
  });
  expect(await f.db.prepare('SELECT count(*) n FROM policies').first()).toEqual({ n: 0 });
  expect(await f.db.prepare('SELECT count(*) n FROM renewal_opportunities').first()).toEqual({
    n: 0,
  });
  expect(await (await post(url, b, key, staff)).json()).toMatchObject({ data, replayed: true });
  expect((await post(url, { ...b, cycleDate: '2027-11-01' }, key, staff)).status).toBe(409);
  expect((await f.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
it('shares only case summaries while keeping another employees real Task private', async () => {
  const a = await create();
  const detail = await f.request(`/api/sales-cases/${a.caseId}`, 'GET', staff);
  expect(detail.status).toBe(200);
  const text = await detail.text();
  expect(text).not.toContain(a.taskId);
  expect(text).not.toContain('dueAt');
  expect((await f.request(`/api/sales-cases/${a.caseId}/task`, 'GET', staff)).status).toBe(404);
  expect((await f.request(`/api/sales-cases/${a.caseId}`, 'GET', foreign)).status).toBe(404);
});
it('reschedules the same real Task with CAS/history and safe exact retry, not a second date authority', async () => {
  const a = await create(staff),
    url = `/api/sales-cases/${a.caseId}/followup`,
    b = {
      expectedCaseVersion: 1,
      expectedTaskId: a.taskId,
      expectedTaskVersion: 1,
      dueAt: '2027-02-12T06:00:00.000Z',
      reasonCode: 'CALL_AGAIN',
      notes: 'Müşteri istedi',
    },
    key = crypto.randomUUID();
  const r = await post(url, b, key, staff);
  expect(r.status, await r.clone().text()).toBe(200);
  expect(await (await post(url, b, key, staff)).json()).toMatchObject({
    replayed: true,
    data: { caseVersion: 2, taskVersion: 2, taskId: a.taskId, dueAt: b.dueAt },
  });
  expect(
    (await post(url, { ...b, dueAt: '2027-03-01T06:00:00.000Z' }, crypto.randomUUID(), staff))
      .status,
  ).toBe(409);
  await expect(
    f.db
      .prepare("UPDATE tasks SET status='COMPLETED',version=version+1 WHERE id=?")
      .bind(a.taskId)
      .run(),
  ).rejects.toThrow('SALES_CASE_OUTCOME_REQUIRED');
});
it('bounds lists and rejects mismatched cursors, confirms similar work and protects archived/HEALTH parents', async () => {
  await create();
  const list = await f.request(`/api/sales-cases?customerId=${customerId}&limit=1`, 'GET', staff);
  const data = (
    (await list.json()) as { data: { items: unknown[]; hasMore: boolean; nextCursor: string } }
  ).data;
  expect(data.items).toHaveLength(1);
  expect(data.hasMore).toBe(true);
  expect(
    (
      await f.request(
        '/api/sales-cases?limit=1&cursor=' + encodeURIComponent(data.nextCursor),
        'GET',
        owner,
      )
    ).status,
  ).toBe(400);
  expect(
    (await post(`/api/customers/${customerId}/sales-cases`, { ...body(), confirmSimilar: false }))
      .status,
  ).toBe(409);
  expect(
    (await post(`/api/customers/${customerId}/sales-cases`, { ...body(), branchId: 'sales-h' }))
      .status,
  ).toBe(403);
  await expect(
    f.db
      .prepare('UPDATE customers SET archived_at=? WHERE id=?')
      .bind(new Date().toISOString(), customerId)
      .run(),
  ).rejects.toThrow('OPEN_DEPENDENCIES');
});
it('rolls back Task/case/receipt/history when final audit fails and rejects oversized or forged requests', async () => {
  const before = await f.db.prepare('SELECT count(*) n FROM tasks').first(),
    key = crypto.randomUUID();
  await f.db.exec(
    "CREATE TRIGGER sales_audit_fault BEFORE INSERT ON audit_events WHEN NEW.action='sales.case.create' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_AUDIT_FAULT'); END;",
  );
  try {
    expect((await post(`/api/customers/${customerId}/sales-cases`, body(), key)).status).toBe(500);
  } finally {
    await f.db.exec('DROP TRIGGER sales_audit_fault;');
  }
  expect(await f.db.prepare('SELECT count(*) n FROM tasks').first()).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  expect(
    (
      await post(`/api/customers/${customerId}/sales-cases`, {
        ...body(),
        padding: 'x'.repeat(33000),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await post(`/api/customers/${customerId}/sales-cases`, {
        ...body(),
        followup: { dueAt: '2027-02-31T09:00:00Z' },
      })
    ).status,
  ).toBe(400);
});
it('places actual GENERAL work in the stable daily cursor and exact context without requiring policy access', async () => {
  const own = await create(staff),
    other = await create(owner);
  const response = await f.request('/api/tasks/today?limit=1', 'GET', staff);
  expect(response.status, await response.clone().text()).toBe(200);
  const page = (
    (await response.json()) as {
      data: {
        items: Array<{
          kind: string;
          taskId: string;
          caseId: string;
          renewalId?: string;
          policyId?: string;
        }>;
        nextCursor: string;
      };
    }
  ).data;
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ kind: 'GENERAL' });
  expect(page.items[0]).not.toHaveProperty('renewalId');
  expect(page.items[0]).not.toHaveProperty('policyId');
  expect(page.items.some((t) => t.taskId === other.taskId)).toBe(false);
  const exact = await f.request(`/api/tasks/${own.taskId}/context`, 'GET', staff);
  expect(exact.status, await exact.clone().text()).toBe(200);
  expect(await exact.json()).toMatchObject({
    data: { items: [{ taskId: own.taskId, caseId: own.caseId, kind: 'GENERAL' }] },
  });
  expect((await f.request(`/api/tasks/${other.taskId}/context`, 'GET', staff)).status).toBe(404);
  const op = await f.db
    .prepare("SELECT receipt_id FROM sales_case_history WHERE case_id=? AND event_code='CREATED'")
    .bind(own.caseId)
    .first<{ receipt_id: string }>();
  expect(
    (await f.request(`/api/sales-cases/${own.caseId}/operations/${op!.receipt_id}`, 'GET', staff))
      .status,
  ).toBe(200);
  expect(
    (await f.request(`/api/sales-cases/${own.caseId}/operations/${op!.receipt_id}`, 'GET', foreign))
      .status,
  ).toBe(404);
});
it('supports concurrent exact retries, verifies restored evidence and rejects a changed receipt history', async () => {
  const own = await create(staff),
    body = {
      expectedCaseVersion: 1,
      expectedTaskId: own.taskId,
      expectedTaskVersion: 1,
      dueAt: '2027-02-15T06:00:00.000Z',
      reasonCode: 'CALL_AGAIN',
      notes: null,
    },
    key = crypto.randomUUID();
  const responses = await Promise.all([
    post(`/api/sales-cases/${own.caseId}/followup`, body, key, staff),
    post(`/api/sales-cases/${own.caseId}/followup`, body, key, staff),
  ]);
  for (const r of responses) expect(r.status, await r.clone().text()).toBe(200);
  const query = async (sql: string) =>
    (await f.db.prepare(sql).all<Record<string, unknown>>()).results;
  await expect(verifySalesRecovery(query)).resolves.toBeUndefined();
  await expect(
    verifySalesRecovery(async (sql) =>
      sql === 'SELECT * FROM sales_case_tasks' ? [] : query(sql),
    ),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
  expect(
    (
      await f.request(`/api/customers/${customerId}/sales-cases`, 'POST', staff, body, undefined, {
        'idempotency-key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
});
it('counts policy-free work under its own permissions and preserves frozen HEALTH restrictions', async () => {
  await create(staff);
  const list = await f.request('/api/tasks/today?limit=50', 'GET', staff);
  expect(list.status).toBe(200);
  const rows = ((await list.json()) as { data: { items: unknown[] } }).data.items;
  expect(rows.length).toBeGreaterThan(0);
  const stats = await f.request('/api/tasks/statistics', 'GET', staff);
  expect(stats.status, await stats.clone().text()).toBe(200);
  expect(await stats.json()).toMatchObject({ data: { summary: { upcoming: rows.length } } });
  for (const code of ['sensitive.health.read', 'sensitive.health.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-sales-owner', code, 'UNSCOPED')
      .run();
  const h = await post(`/api/customers/${customerId}/sales-cases`, {
    ...body(),
    branchId: 'sales-h',
  });
  expect(h.status, await h.clone().text()).toBe(201);
  const data = ((await h.json()) as { data: { caseId: string; taskId: string } }).data;
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-sales-owner' AND permission_code LIKE 'sensitive.health.%'",
    )
    .run();
  await f.db
    .prepare(
      "UPDATE insurance_branches SET data_classification='GENERAL',version=version+1 WHERE id='sales-h'",
    )
    .run();
  expect((await f.request(`/api/sales-cases/${data.caseId}`, 'GET', owner)).status).toBe(404);
  const queue = await f.request('/api/tasks/today?limit=50&unified=true', 'GET', owner);
  expect(await queue.text()).not.toContain(data.taskId);
  const hidden = await f.request(`/api/tasks/${data.taskId}/context`, 'GET', owner);
  expect(hidden.status).toBe(404);
});
it('rolls back a create when task/quote authority changes immediately before its final transaction', async () => {
  const key = crypto.randomUUID(),
    csrf = await f.csrf(staff),
    original = f.env.DB,
    before = await f.db.prepare('SELECT count(*) n FROM tasks').first();
  let changed = false;
  f.env.DB = {
    prepare: original.prepare.bind(original),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!changed) {
        changed = true;
        await original
          .prepare(
            "DELETE FROM membership_permissions WHERE membership_id='membership-sales-staff' AND permission_code='quote.manage'",
          )
          .run();
        await original
          .prepare(
            "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-sales-staff'",
          )
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const r = await f.request(
      `/api/customers/${customerId}/sales-cases`,
      'POST',
      staff,
      body(),
      csrf,
      { 'idempotency-key': key },
    );
    expect(changed).toBe(true);
    expect(r.status, await r.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(await f.db.prepare('SELECT count(*) n FROM tasks').first()).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
});
