// @vitest-environment node
import { beforeAll, afterAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
const customerId = 'general-c';
const dueAt = '2027-02-10T06:00:00.000Z';
let serial = 0;
type Result = {
  operationId: string;
  taskId: string;
  taskVersion: number;
  status: 'OPEN' | 'COMPLETED';
  dueAt: string;
  assigneeMembershipId: string | null;
};
beforeAll(async () => {
  f = await localAuthFixture();
  for (const who of [
    'general-owner',
    'general-staff',
    'general-noaccess',
    'general-inactive',
    'general-foreign',
  ]) {
    await f.seed(
      who,
      who === 'general-owner' || who === 'general-foreign' ? 'OWNER' : 'MEMBER',
      false,
      who === 'general-foreign' ? 'general-foreign-agency' : 'agency-auth-test',
    );
  }
  for (const who of ['general-staff', 'general-inactive']) {
    for (const code of ['customer.read', 'task.read', 'task.update', 'task.assign', 'quote.read'])
      await f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), 'membership-' + who, code, 'AGENCY')
        .run();
  }
  await f.db
    .prepare(
      "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),permission_version=permission_version+1,version=version+1 WHERE id='membership-general-inactive'",
    )
    .run();
  for (const who of ['general-owner', 'general-staff', 'general-foreign'])
    cookies[who] = (await f.session(who)).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('general-c','agency-auth-test','INDIVIDUAL','Genel Takip','Genel','Takip','membership-general-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('general-i','agency-auth-test','GT','Şirket')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('general-b','agency-auth-test','GT','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('general-h','agency-auth-test','GTH','Sağlık','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('general-hp','agency-auth-test','general-i','general-h','GTH','Sağlık ürünü')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('general-pay','agency-auth-test','GT','Nakit')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function task(who = 'general-owner', policyId: string | null = null) {
  const id = 'general-task-' + ++serial;
  await f.db
    .prepare(
      "INSERT INTO tasks(id,agency_id,customer_id,policy_id,kind,title,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id) VALUES(?,'agency-auth-test',?,?,'GENERAL','Müşteri görüşmesi',?,?,'USER','general-owner','membership-general-owner')",
    )
    .bind(id, customerId, policyId, dueAt, 'membership-' + who)
    .run();
  return id;
}
async function post(
  id: string,
  action: string,
  body: unknown,
  key = crypto.randomUUID(),
  who = 'general-owner',
) {
  return f.request(
    `/api/tasks/${id}/${action}`,
    'POST',
    cookies[who],
    body,
    await f.csrf(cookies[who]!),
    { 'idempotency-key': key },
  );
}
async function data(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return ((await response.json()) as { data: Result }).data;
}
const reschedule = (version = 1) => ({
  expectedTaskVersion: version,
  reasonCode: 'CALL_AGAIN',
  notes: 'Müşteri arama istedi.',
  dueAt: '2027-03-12T09:00:00.000Z',
});
const complete = (version = 1) => ({
  expectedTaskVersion: version,
  reasonCode: 'COMPLETED',
  notes: null,
});
async function snapshot(id: string) {
  return f.db.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first<Record<string, unknown>>();
}

it('reschedules an actual policy-free GENERAL Task under its own permissions with exact receipt and no duplicate Task', async () => {
  const id = await task('general-staff'),
    before = await f.db.prepare('SELECT count(*) n FROM tasks').first(),
    key = crypto.randomUUID(),
    body = reschedule();
  const context = await f.request(
    `/api/tasks/${id}/general-context`,
    'GET',
    cookies['general-staff'],
  );
  expect(context.status, await context.clone().text()).toBe(200);
  const result = await data(await post(id, 'reschedule', body, key, 'general-staff'));
  expect(result).toMatchObject({
    taskId: id,
    taskVersion: 2,
    status: 'OPEN',
    dueAt: body.dueAt,
    assigneeMembershipId: 'membership-general-staff',
  });
  expect(await snapshot(id)).toMatchObject({
    kind: 'GENERAL',
    policy_id: null,
    renewal_id: null,
    version: 2,
    due_at: body.dueAt,
    status: 'OPEN',
  });
  expect(await f.db.prepare('SELECT count(*) n FROM tasks').first()).toEqual(before);
  expect(await (await post(id, 'reschedule', body, key, 'general-staff')).json()).toMatchObject({
    data: result,
    replayed: true,
  });
  expect(
    (await post(id, 'reschedule', { ...body, notes: 'Değişti' }, key, 'general-staff')).status,
  ).toBe(409);
  expect(
    await (
      await f.request(
        `/api/tasks/${id}/operations/${result.operationId}`,
        'GET',
        cookies['general-staff'],
      )
    ).json(),
  ).toMatchObject({ data: result });
  const audit = await f.db
    .prepare('SELECT metadata_json FROM audit_events WHERE correlation_id=?')
    .bind(result.operationId)
    .first<{ metadata_json: string }>();
  expect(audit).not.toBeNull();
  expect(audit!.metadata_json).not.toContain(body.notes);
});

it('completes a standalone Task with immutable evidence and supports exact completed-operation readback and retry', async () => {
  const id = await task('general-staff'),
    key = crypto.randomUUID(),
    body = complete();
  const result = await data(await post(id, 'complete', body, key, 'general-staff'));
  expect(result).toMatchObject({ taskId: id, taskVersion: 2, status: 'COMPLETED', dueAt });
  expect(await snapshot(id)).toMatchObject({
    status: 'COMPLETED',
    version: 2,
    completed_by_membership_id: 'membership-general-staff',
  });
  expect((await snapshot(id))!.completed_at).not.toBeNull();
  expect(await (await post(id, 'complete', body, key, 'general-staff')).json()).toMatchObject({
    data: result,
    replayed: true,
  });
  expect(
    await (
      await f.request(
        `/api/tasks/${id}/operations/${result.operationId}`,
        'GET',
        cookies['general-staff'],
      )
    ).json(),
  ).toMatchObject({ data: result });
  const queue = await f.request(
    '/api/tasks/today?unified=true&limit=50',
    'GET',
    cookies['general-staff'],
  );
  expect(queue.status).toBe(200);
  expect(await queue.text()).not.toContain(id);
  expect(
    (await post(id, 'reschedule', reschedule(2), crypto.randomUUID(), 'general-staff')).status,
  ).toBe(409);
});

it('rejects stale snapshots, invalid payloads, missing CSRF and oversized notes without partially updating a Task', async () => {
  const id = await task(),
    before = await snapshot(id);
  for (const body of [
    reschedule(2),
    { ...reschedule(), dueAt: '2027-02-30T09:00:00.000Z' },
    { ...reschedule(), extra: true },
    { ...reschedule(), notes: 'x'.repeat(501) },
  ]) {
    const response = await post(id, 'reschedule', body);
    expect([400, 409]).toContain(response.status);
    expect(await snapshot(id)).toEqual(before);
  }
  expect(
    (
      await f.request(
        `/api/tasks/${id}/complete`,
        'POST',
        cookies['general-owner'],
        complete(),
        undefined,
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(403);
  expect(await snapshot(id)).toEqual(before);
});

it('keeps MEMBER Task scope private despite AGENCY grants and rejects foreign agency access', async () => {
  const ownerTask = await task(),
    staffTask = await task('general-staff');
  expect(
    (await f.request(`/api/tasks/${ownerTask}/general-context`, 'GET', cookies['general-staff']))
      .status,
  ).toBe(404);
  expect([403, 404]).toContain(
    (await post(ownerTask, 'reschedule', reschedule(), crypto.randomUUID(), 'general-staff'))
      .status,
  );
  expect(
    (await f.request(`/api/tasks/${staffTask}/general-context`, 'GET', cookies['general-foreign']))
      .status,
  ).toBe(404);
  expect([403, 404]).toContain(
    (await post(staffTask, 'complete', complete(), crypto.randomUUID(), 'general-foreign')).status,
  );
  const ownResult = await data(
    await post(staffTask, 'reschedule', reschedule(), crypto.randomUUID(), 'general-staff'),
  );
  expect(
    (
      await f.request(
        `/api/tasks/${ownerTask}/operations/${ownResult.operationId}`,
        'GET',
        cookies['general-owner'],
      )
    ).status,
  ).toBe(404);
});

it('rolls back the Task, receipt and evidence if the final audit insert fails', async () => {
  const id = await task(),
    before = await snapshot(id),
    key = crypto.randomUUID();
  await f.db
    .prepare(
      `CREATE TRIGGER general_fail_audit BEFORE INSERT ON audit_events WHEN NEW.target_id='${id}' AND NEW.outcome='SUCCESS' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_GENERAL_AUDIT_FAIL'); END;`,
    )
    .run();
  try {
    expect((await post(id, 'reschedule', reschedule(), key)).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER general_fail_audit').run();
  }
  expect(await snapshot(id)).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  expect(
    await f.db.prepare('SELECT id FROM audit_events WHERE target_id=?').bind(id).first(),
  ).toBeNull();
});

it('serializes concurrent same-key retries and competing CAS writes without extra Tasks', async () => {
  const same = await task(),
    key = crypto.randomUUID(),
    body = reschedule();
  const responses = await Promise.all([
    post(same, 'reschedule', body, key),
    post(same, 'reschedule', body, key),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const results = await Promise.all(responses.map((r) => r.json()));
  expect((results[0] as { data: Result }).data).toEqual((results[1] as { data: Result }).data);
  expect((await snapshot(same))!.version).toBe(2);
  const competing = await task();
  const attempts = await Promise.all([
    post(competing, 'complete', complete()),
    post(competing, 'complete', complete()),
  ]);
  expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await snapshot(competing))!.version).toBe(2);
});

it('filters reassignment targets by active membership and actual parent access, preserves a linked case and prevents bare case completion', async () => {
  await f.seed('general-owner-two', 'OWNER');
  const secondOwner = (await f.session('general-owner-two')).cookie;
  const inactiveSource = await task('general-inactive');
  expect(
    (
      await f.request(
        `/api/tasks/${inactiveSource}/general-context`,
        'GET',
        cookies['general-owner'],
      )
    ).status,
  ).toBe(200);
  const firstOptions = await f.request(
    `/api/tasks/${inactiveSource}/assignment-options?limit=1`,
    'GET',
    cookies['general-owner'],
  );
  expect(firstOptions.status).toBe(200);
  const firstPage = (
    (await firstOptions.json()) as {
      data: { memberships: unknown[]; hasMore: boolean; nextCursor: string };
    }
  ).data;
  expect(firstPage.memberships).toHaveLength(1);
  expect(firstPage.hasMore).toBe(true);
  expect(firstPage.nextCursor).toBeTruthy();
  const cursorQuery = '?limit=1&cursor=' + encodeURIComponent(firstPage.nextCursor);
  // The candidate page is tied to the requesting owner, actual Task and its exact current version.
  expect(
    (
      await f.request(
        `/api/tasks/${inactiveSource}/assignment-options${cursorQuery}`,
        'GET',
        secondOwner,
      )
    ).status,
  ).toBe(400);
  const otherTask = await task();
  expect(
    (
      await f.request(
        `/api/tasks/${otherTask}/assignment-options${cursorQuery}`,
        'GET',
        cookies['general-owner'],
      )
    ).status,
  ).toBe(400);
  const recovered = await data(
    await post(inactiveSource, 'assign', {
      expectedTaskVersion: 1,
      reasonCode: 'REASSIGN',
      notes: 'Ayrılan çalışanın takibi devredildi.',
      assigneeMembershipId: 'membership-general-staff',
    }),
  );
  expect(recovered).toMatchObject({
    taskId: inactiveSource,
    taskVersion: 2,
    assigneeMembershipId: 'membership-general-staff',
  });
  expect(await snapshot(inactiveSource)).toMatchObject({
    assignee_membership_id: 'membership-general-staff',
    version: 2,
    status: 'OPEN',
  });
  expect(
    (
      await f.request(
        `/api/tasks/${inactiveSource}/assignment-options${cursorQuery}`,
        'GET',
        cookies['general-owner'],
      )
    ).status,
  ).toBe(400);
  const response = await f.request(
    `/api/customers/${customerId}/sales-cases`,
    'POST',
    cookies['general-owner'],
    {
      context: 'NEW_BUSINESS',
      branchId: 'general-b',
      cycleDate: null,
      dateBasis: 'MANUAL',
      followup: { dueAt },
      confirmSimilar: true,
    },
    await f.csrf(cookies['general-owner']!),
    { 'idempotency-key': crypto.randomUUID() },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  const linked = ((await response.json()) as { data: { caseId: string; taskId: string } }).data;
  expect((await post(linked.taskId, 'complete', complete())).status).toBe(409);
  expect((await post(linked.taskId, 'reschedule', reschedule())).status).toBe(409);
  const options = await f.request(
    `/api/tasks/${linked.taskId}/assignment-options`,
    'GET',
    cookies['general-owner'],
  );
  expect(options.status, await options.clone().text()).toBe(200);
  const text = await options.text();
  expect(text).toContain('membership-general-staff');
  for (const excluded of [
    'membership-general-noaccess',
    'membership-general-inactive',
    'membership-general-foreign',
  ])
    expect(text).not.toContain(excluded);
  const invalid = await post(linked.taskId, 'assign', {
    expectedTaskVersion: 1,
    reasonCode: 'REASSIGN',
    notes: null,
    assigneeMembershipId: 'membership-general-noaccess',
  });
  expect([403, 409]).toContain(invalid.status);
  const key = crypto.randomUUID(),
    body = {
      expectedTaskVersion: 1,
      reasonCode: 'REASSIGN',
      notes: null,
      assigneeMembershipId: 'membership-general-staff',
    };
  const assigned = await data(await post(linked.taskId, 'assign', body, key));
  expect(assigned).toMatchObject({
    taskId: linked.taskId,
    taskVersion: 2,
    assigneeMembershipId: 'membership-general-staff',
  });
  expect(await (await post(linked.taskId, 'assign', body, key)).json()).toMatchObject({
    data: assigned,
    replayed: true,
  });
  expect(
    await f.db
      .prepare('SELECT version,result,active_task_id FROM sales_cases WHERE id=?')
      .bind(linked.caseId)
      .first(),
  ).toEqual({ version: 1, result: 'OPEN', active_task_id: linked.taskId });
  expect(
    (await f.request(`/api/sales-cases/${linked.caseId}/task`, 'GET', cookies['general-staff']))
      .status,
  ).toBe(200);
});

it('enforces HEALTH on policy-linked GENERAL Tasks and rechecks live authority immediately before the final write batch', async () => {
  await f.db
    .prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('general-health-policy','agency-auth-test','general-c','general-i','general-hp','general-h','general-pay','membership-general-owner','GENERAL-HEALTH','GENERALHEALTH','2026-01-01','2027-01-20',12345,'TRY')",
    )
    .run();
  const healthTask = await task('general-owner', 'general-health-policy');
  expect([403, 404]).toContain((await post(healthTask, 'reschedule', reschedule())).status);
  for (const code of ['sensitive.health.read', 'sensitive.health.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-general-owner', code, 'UNSCOPED')
      .run();
  expect((await post(healthTask, 'reschedule', reschedule())).status).toBe(200);
  const id = await task('general-staff'),
    before = await snapshot(id),
    key = crypto.randomUUID(),
    csrf = await f.csrf(cookies['general-staff']!),
    original = f.env.DB;
  let changed = false,
    preparedWrite = false;
  f.env.DB = {
    prepare(sql: string) {
      if (/UPDATE\s+[`"]?tasks[`"]?\s+SET/i.test(sql)) preparedWrite = true;
      return original.prepare(sql);
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (preparedWrite && !changed) {
        changed = true;
        await original
          .prepare(
            "DELETE FROM membership_permissions WHERE membership_id='membership-general-staff' AND permission_code='task.update'",
          )
          .run();
        await original
          .prepare(
            "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-general-staff'",
          )
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const r = await f.request(
      `/api/tasks/${id}/reschedule`,
      'POST',
      cookies['general-staff'],
      reschedule(),
      csrf,
      { 'idempotency-key': key },
    );
    expect(changed).toBe(true);
    expect(r.status, await r.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(await snapshot(id)).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
});
