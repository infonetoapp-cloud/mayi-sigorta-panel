// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { verifySalesRecovery } from '../scripts/recovery/sales-data-proof';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
let serial = 0;
type Source = {
  renewalId: string;
  taskId: string;
  policyId: string;
  taskVersion: number;
  renewalVersion: number;
};
type Result = {
  operationId: string;
  caseId: string;
  caseVersion: number;
  taskId: string;
  taskVersion: number;
  dueAt: string;
};
const dueAt = '2027-01-10T06:00:00.000Z';
const customerId = 'adopt-c';
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('adopt-owner', 'OWNER');
  await f.seed('adopt-staff');
  await f.seed('adopt-foreign', 'OWNER', false, 'adopt-foreign-agency');
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['policy.read', 'AGENCY'],
    ['renewal.read', 'AGENCY'],
    ['quote.read', 'ASSIGNED'],
    ['quote.manage', 'ASSIGNED'],
    ['task.read', 'AGENCY'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-adopt-staff', code, scope)
      .run();
  for (const who of ['adopt-owner', 'adopt-staff', 'adopt-foreign'])
    cookies[who] = (await f.session(who)).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('adopt-c','agency-auth-test','INDIVIDUAL','Yenileme Müşterisi','Yenileme','Müşterisi','membership-adopt-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('adopt-i','agency-auth-test','AD','Şirket')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('adopt-b','agency-auth-test','AD','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('adopt-h','agency-auth-test','ADH','Sağlık','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('adopt-pr','agency-auth-test','adopt-i','adopt-b','AD','Ürün')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('adopt-hr','agency-auth-test','adopt-i','adopt-h','ADH','Sağlık ürünü')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('adopt-pay','agency-auth-test','AD','Nakit')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function source(who = 'adopt-owner', health = false): Promise<Source> {
  const id = 'adopt-source-' + ++serial;
  await f.db
    .prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'agency-auth-test',?,'adopt-i',?,?,'adopt-pay',?,?,?,'2026-01-01','2027-01-20',12345,'TRY')",
    )
    .bind(
      id,
      customerId,
      health ? 'adopt-hr' : 'adopt-pr',
      health ? 'adopt-h' : 'adopt-b',
      'membership-' + who,
      id,
      id,
    )
    .run();
  await f.db
    .prepare(
      "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id) VALUES(?,'agency-auth-test',?,?)",
    )
    .bind(id + '-r', id, 'membership-' + who)
    .run();
  await f.db
    .prepare(
      "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES(?,'agency-auth-test',?,?,'RENEWAL_FOLLOWUP','Yenileme',?,?,'SYSTEM')",
    )
    .bind(id + '-t', customerId, id + '-r', dueAt, 'membership-' + who)
    .run();
  return {
    policyId: id,
    renewalId: id + '-r',
    taskId: id + '-t',
    taskVersion: 1,
    renewalVersion: 1,
  };
}
function command(s: Source) {
  return {
    context: 'RENEWAL',
    renewalId: s.renewalId,
    expectedVersion: s.renewalVersion,
    expectedPrimaryTaskId: s.taskId,
    expectedPrimaryTaskVersion: s.taskVersion,
  };
}
async function post(path: string, body: unknown, key = crypto.randomUUID(), who = 'adopt-owner') {
  return f.request(path, 'POST', cookies[who], body, await f.csrf(cookies[who]!), {
    'idempotency-key': key,
  });
}
const path = `/api/customers/${customerId}/sales-cases`;
async function adopted(s: Source, who = 'adopt-owner', key = crypto.randomUUID()) {
  const r = await post(path, command(s), key, who);
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { data: Result }).data;
}
async function counts() {
  return Promise.all(
    [
      'tasks',
      'policies',
      'renewal_opportunities',
      'sales_cases',
      'sales_case_tasks',
      'sales_case_history',
    ].map((table) => f.db.prepare(`SELECT count(*) n FROM ${table}`).first<{ n: number }>()),
  );
}
async function verify() {
  await verifySalesRecovery(
    async (sql) => (await f.db.prepare(sql).all<Record<string, unknown>>()).results,
  );
}

it('adopts the actual primary Task without creating a second Task or parallel renewal state and replays exactly', async () => {
  const s = await source(),
    before = await counts(),
    key = crypto.randomUUID();
  const data = await adopted(s, 'adopt-owner', key);
  expect(data).toMatchObject({ caseVersion: 1, taskId: s.taskId, taskVersion: 1, dueAt });
  expect(
    await f.db
      .prepare(
        'SELECT context_kind,renewal_id,source_policy_id,result,active_task_id,cycle_date FROM sales_cases WHERE id=?',
      )
      .bind(data.caseId)
      .first(),
  ).toEqual({
    context_kind: 'RENEWAL',
    renewal_id: s.renewalId,
    source_policy_id: s.policyId,
    result: null,
    active_task_id: null,
    cycle_date: '2027-01-20',
  });
  const after = await counts();
  expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
  expect(after.slice(3).map((v, i) => v!.n - before[i + 3]!.n)).toEqual([1, 1, 1]);
  expect(await (await post(path, command(s), key)).json()).toMatchObject({ data, replayed: true });
  expect((await post(path, { ...command(s), expectedVersion: 2 }, key)).status).toBe(409);
  expect((await post(path, command(s))).status).toBe(409);
  expect(
    await (
      await f.request(
        `/api/sales-cases/${data.caseId}/operations/${data.operationId}`,
        'GET',
        cookies['adopt-owner'],
      )
    ).json(),
  ).toMatchObject({ data });
  expect((await f.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await verify();
});

it('keeps shared summaries separate from private Task admission and enforces agency and strict source identity', async () => {
  const own = await source('adopt-staff'),
    privateSource = await source();
  const data = await adopted(own, 'adopt-staff');
  expect([403, 404]).toContain(
    (await post(path, command(privateSource), crypto.randomUUID(), 'adopt-staff')).status,
  );
  const ownerCase = await adopted(privateSource);
  // Admission above uses renewal-assigned quote access even though the customer belongs to the owner.
  // Shared reading below has an explicit broader quote.read grant; task.read AGENCY still cannot open another employee's Task.
  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-adopt-staff' AND permission_code='quote.read'",
    )
    .run();
  const summary = await f.request(
    `/api/sales-cases/${ownerCase.caseId}`,
    'GET',
    cookies['adopt-staff'],
  );
  expect(summary.status).toBe(200);
  expect(await summary.text()).not.toMatch(/taskId|dueAt|assigneeMembershipId/);
  expect(
    (await f.request(`/api/sales-cases/${ownerCase.caseId}/task`, 'GET', cookies['adopt-staff']))
      .status,
  ).toBe(404);
  expect(
    (await f.request(`/api/sales-cases/${data.caseId}`, 'GET', cookies['adopt-foreign'])).status,
  ).toBe(404);
  expect((await post(path, { ...command(own), followup: { dueAt } })).status).toBe(400);
  const mismatch = await source();
  expect([404, 409]).toContain(
    (await post(path, { ...command(mismatch), expectedPrimaryTaskId: own.taskId })).status,
  );
});

it('rejects stale renewal and Task snapshots and leaves no partial admission', async () => {
  const s = await source(),
    before = await counts();
  for (const body of [
    { ...command(s), expectedVersion: 2 },
    { ...command(s), expectedPrimaryTaskVersion: 2 },
  ]) {
    const r = await post(path, body);
    expect(r.status, await r.clone().text()).toBe(409);
    expect(await counts()).toEqual(before);
  }
});

it('rolls every admission write back when the final audit insert fails', async () => {
  const s = await source(),
    before = await counts(),
    key = crypto.randomUUID();
  await f.db
    .prepare(
      "CREATE TRIGGER adopt_fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='sales.case.adopt' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FINAL_AUDIT_FAIL'); END;",
    )
    .run();
  try {
    const r = await post(path, command(s), key);
    expect(r.status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER adopt_fail_audit').run();
  }
  expect(await counts()).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
});

it('keeps one case under concurrent admission attempts and one exact receipt for concurrent same-key retries', async () => {
  const same = await source(),
    key = crypto.randomUUID();
  const results = await Promise.all([
    post(path, command(same), key),
    post(path, command(same), key),
  ]);
  expect(results.map((r) => r.status)).toEqual([201, 201]);
  const bodies = await Promise.all(
    results.map(async (r) => ((await r.json()) as { data: Result }).data),
  );
  expect(bodies[0]).toEqual(bodies[1]);
  const different = await source();
  const attempts = await Promise.all([
    post(path, command(different)),
    post(path, command(different)),
  ]);
  expect(attempts.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(
    await f.db
      .prepare('SELECT count(*) n FROM sales_cases WHERE renewal_id=?')
      .bind(different.renewalId)
      .first(),
  ).toEqual({ n: 1 });
});

it('preserves the existing renewal replacement and terminal/reopen motor and verifies historical admission after replacement', async () => {
  const s = await source(),
    key = crypto.randomUUID(),
    data = await adopted(s, 'adopt-owner', key);
  const replacementDueAt = '2027-01-15T09:00:00.000Z';
  const completed = await post(`/api/renewals/${s.renewalId}/tasks/${s.taskId}/complete`, {
    expectedRenewalVersion: 1,
    expectedTaskVersion: 1,
    replacementDueAt,
    followupReason: 'CALL_AGAIN',
  });
  expect(completed.status, await completed.clone().text()).toBe(200);
  const replacement = (
    (await completed.json()) as {
      data: { replacementTaskId: string; replacementTaskVersion: number; renewalVersion: number };
    }
  ).data;
  expect(replacement.replacementTaskId).not.toBe(s.taskId);
  const task = await f.request(
    `/api/sales-cases/${data.caseId}/task`,
    'GET',
    cookies['adopt-owner'],
  );
  expect(await task.json()).toMatchObject({
    data: { taskId: replacement.replacementTaskId, dueAt: replacementDueAt },
  });
  expect(
    (
      await post(`/api/sales-cases/${data.caseId}/followup`, {
        expectedCaseVersion: 1,
        expectedTaskId: replacement.replacementTaskId,
        expectedTaskVersion: 1,
        dueAt,
        reasonCode: 'CALL_AGAIN',
        notes: null,
      })
    ).status,
  ).toBe(409);
  const terminal = await post(`/api/renewals/${s.renewalId}/void`, {
    expectedPrimaryTaskId: replacement.replacementTaskId,
    expectedRenewalVersion: replacement.renewalVersion,
    expectedTaskVersion: replacement.replacementTaskVersion,
    voidReasonCode: 'DUPLICATE',
  });
  expect(terminal.status, await terminal.clone().text()).toBe(200);
  const closed = (
    (await terminal.json()) as { data: { renewalVersion: number; taskVersion: number } }
  ).data;
  expect(
    await (
      await f.request(`/api/sales-cases/${data.caseId}`, 'GET', cookies['adopt-owner'])
    ).json(),
  ).toMatchObject({ data: { result: 'VOIDED' } });
  expect(await (await post(path, command(s), key)).json()).toMatchObject({ data, replayed: true });
  const reopened = await post(`/api/renewals/${s.renewalId}/reopen`, {
    expectedRenewalVersion: closed.renewalVersion,
    expectedTaskVersion: closed.taskVersion,
    replacementDueAt: '2027-01-16T09:00:00.000Z',
    reopenReasonCode: 'CORRECT_MISTAKE',
  });
  expect(reopened.status, await reopened.clone().text()).toBe(200);
  expect(
    await f.db
      .prepare('SELECT result,active_task_id,version FROM sales_cases WHERE id=?')
      .bind(data.caseId)
      .first(),
  ).toEqual({ result: null, active_task_id: null, version: 1 });
  await verify();
  await expect(
    verifySalesRecovery(async (sql) => {
      const rows = (await f.db.prepare(sql).all<Record<string, unknown>>()).results;
      return sql === 'SELECT * FROM sales_case_tasks'
        ? rows.filter((r) => r.case_id !== data.caseId)
        : rows;
    }),
  ).rejects.toThrow();
});

it('rejects changing the linked source branch with a clear conflict while preserving the real policy and admission', async () => {
  const s = await source();
  const data = await adopted(s);
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('adopt-other-b','agency-auth-test','AD2','Konut')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('adopt-other-pr','agency-auth-test','adopt-i','adopt-other-b','AD2','Konut ürünü')",
    ),
  ]);
  const key = crypto.randomUUID();
  const response = await f.request(
    `/api/policies/${s.policyId}`,
    'PATCH',
    cookies['adopt-owner'],
    { expectedVersion: 1, branchId: 'adopt-other-b', productId: 'adopt-other-pr' },
    await f.csrf(cookies['adopt-owner']!),
    { 'idempotency-key': key },
  );
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'RENEWAL_SOURCE_IMMUTABLE' } });
  expect(
    await f.db
      .prepare('SELECT branch_id,version FROM policies WHERE id=?')
      .bind(s.policyId)
      .first(),
  ).toEqual({ branch_id: 'adopt-b', version: 1 });
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  expect(
    (await f.request(`/api/sales-cases/${data.caseId}`, 'GET', cookies['adopt-owner'])).status,
  ).toBe(200);
});
it('requires explicit HEALTH read/write for owners and revokes adoption authority in the final transaction', async () => {
  const health = await source('adopt-owner', true);
  const hidden = await post(path, command(health));
  expect([403, 404]).toContain(hidden.status);
  for (const code of ['sensitive.health.read', 'sensitive.health.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-adopt-owner', code, 'UNSCOPED')
      .run();
  const healthCase = await adopted(health);
  expect(healthCase.taskId).toBe(health.taskId);
  await expect(
    f.db
      .prepare(
        "UPDATE insurance_branches SET data_classification='GENERAL',version=version+1 WHERE id='adopt-h'",
      )
      .run(),
  ).rejects.toThrow('SALES_RENEWAL_HEALTH_DOWNGRADE_FORBIDDEN');
  const s = await source('adopt-staff'),
    before = await counts(),
    key = crypto.randomUUID(),
    csrf = await f.csrf(cookies['adopt-staff']!),
    original = f.env.DB;
  let changed = false;
  f.env.DB = {
    prepare: original.prepare.bind(original),
    batch: async (statements: D1PreparedStatement[]) => {
      // Session binding prepends its assertion: a read batch has two statements, the admission transaction has eight.
      if (!changed && statements.length >= 8) {
        changed = true;
        await original
          .prepare(
            "DELETE FROM membership_permissions WHERE membership_id='membership-adopt-staff' AND permission_code='quote.manage'",
          )
          .run();
        await original
          .prepare(
            "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-adopt-staff'",
          )
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const r = await f.request(path, 'POST', cookies['adopt-staff'], command(s), csrf, {
      'idempotency-key': key,
    });
    expect(changed).toBe(true);
    expect(r.status, await r.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(await counts()).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
});
