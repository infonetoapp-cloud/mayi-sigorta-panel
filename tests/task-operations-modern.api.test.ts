// @vitest-environment node
import { beforeAll, afterAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type {
  TodayTaskDto,
  TodayTasksResponseData,
  RenewalTaskReplacementCompletionDto,
  RenewalTaskAssignmentDto,
} from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
let customer = '',
  serial = 0;
const due = () => new Date(Date.now() + 3 * 86400000).toISOString();
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}
async function post(path: string, body: unknown, actor = 'tc-owner', key = crypto.randomUUID()) {
  return f.request(path, 'POST', cookies[actor], body, await f.csrf(cookies[actor]!), {
    'idempotency-key': key,
  });
}
async function queue(actor = 'tc-owner') {
  return data<TodayTasksResponseData>(
    await f.request('/api/tasks/today?limit=50', 'GET', cookies[actor]),
  );
}
async function seed(actor = 'tc-ahmet') {
  const policy = await data<{ id: string }>(
    await post('/api/policies', {
      customerId: customer,
      insurerId: 'tc-i',
      branchId: 'tc-b',
      productId: 'tc-p',
      paymentMethodId: 'tc-m',
      policyNumber: 'TC-' + ++serial,
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
      assigneeMembershipId: 'membership-' + actor,
    }),
    201,
  );
  const row = (await queue()).items.find((t) => t.policyId === policy.id);
  expect(row).toBeTruthy();
  return row!;
}
const path = (task: TodayTaskDto, kind = 'complete') =>
  `/api/renewals/${task.renewalId}/tasks/${task.taskId}/${kind}`;
const complete = (task: TodayTaskDto) => ({
  expectedRenewalVersion: task.renewalVersion,
  expectedTaskVersion: task.taskVersion,
  replacementDueAt: due(),
});
const assign = (task: TodayTaskDto, to: string | null) => ({
  expectedRenewalVersion: task.renewalVersion,
  expectedTaskVersion: task.taskVersion,
  assigneeMembershipId: to,
});
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['tasks', 'renewal_opportunities', 'operation_receipts', 'audit_events'])
    result[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  return JSON.stringify(result);
}
beforeAll(async () => {
  f = await localAuthFixture();
  for (const actor of ['tc-owner', 'tc-ahmet', 'tc-ayse', 'tc-inactive', 'tc-foreign']) {
    const m = await f.seed(
      actor,
      actor === 'tc-owner' || actor === 'tc-foreign' ? 'OWNER' : 'MEMBER',
      false,
      actor === 'tc-foreign' ? 'tc-foreign-agency' : 'agency-auth-test',
    );
    if (m.id !== 'tc-owner' && m.id !== 'tc-foreign')
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
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('tc-i','agency-auth-test','TC','TC')",
    )
    .run();
  customer = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Görev',
        insurerNumber: { insurerId: 'tc-i', customerNumber: 'TC-CUSTOMER' },
      }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('tc-b','agency-auth-test','TC','TC','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('tc-p','agency-auth-test','tc-i','tc-b','TC','TC')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('tc-m','agency-auth-test','TC','TC')",
    ),
  ]);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
it.each(['tc-owner', 'tc-ahmet', 'tc-ayse'])(
  'completes %s follow-up atomically with exactly one inherited replacement and exact replay',
  async (actor) => {
    const t = await seed(actor),
      body = complete(t),
      key = crypto.randomUUID();
    const written = await data<RenewalTaskReplacementCompletionDto>(
      await post(path(t), body, actor, key),
    );
    expect(written).toMatchObject({
      completedTaskId: t.taskId,
      replacementDueAt: body.replacementDueAt,
      renewalVersion: t.renewalVersion,
      completedTaskVersion: t.taskVersion + 1,
      replacementTaskVersion: 1,
    });
    const rows = (
      await f.db
        .prepare('SELECT * FROM tasks WHERE renewal_id=? ORDER BY id')
        .bind(t.renewalId)
        .all<Record<string, unknown>>()
    ).results;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === t.taskId)).toMatchObject({
      status: 'COMPLETED',
      completed_by_membership_id: 'membership-' + actor,
      version: t.taskVersion + 1,
    });
    expect(rows.find((r) => r.id === written.replacementTaskId)).toMatchObject({
      status: 'OPEN',
      assignee_membership_id: t.assigneeMembershipId,
      due_at: body.replacementDueAt,
    });
    const before = await snapshot();
    expect(await data(await post(path(t), body, actor, key))).toEqual(written);
    expect(await snapshot()).toBe(before);
    expect((await queue(actor)).items.some((r) => r.taskId === t.taskId)).toBe(false);
    expect((await queue(actor)).items.some((r) => r.taskId === written.replacementTaskId)).toBe(
      true,
    );
  },
);
it('rejects stale renewal and task CAS and noncanonical or impossible date input without effects', async () => {
  const t = await seed(),
    base = complete(t);
  for (const body of [
    { ...base, expectedRenewalVersion: t.renewalVersion + 1 },
    { ...base, expectedTaskVersion: t.taskVersion + 1 },
    { ...base, replacementDueAt: '2026-02-30T00:00:00.000Z' },
    { ...base, replacementDueAt: '2026-10-19T08:00:00Z' },
    { ...base, replacementDueAt: '2026-10-19T11:00:00.000+03:00' },
  ]) {
    const before = await snapshot(),
      r = await post(path(t), body);
    expect([400, 409]).toContain(r.status);
    expect(await snapshot()).toBe(before);
  }
});
it('authorizes only the endpoint directory and transfers responsibility to an explicit eligible active member', async () => {
  const t = await seed();
  const options = await data<{ membershipId: string }[]>(
    await f.request(path(t, 'assignment-options'), 'GET', cookies['tc-owner']),
  );
  expect(options.some((o) => o.membershipId === 'membership-tc-ayse')).toBe(true);
  const before = await f.db
    .prepare('SELECT assignee_membership_id FROM policies WHERE id=?')
    .bind(t.policyId)
    .first();
  const written = await data<RenewalTaskAssignmentDto>(
    await post(path(t, 'assign'), assign(t, 'membership-tc-ayse')),
  );
  expect(written).toMatchObject({
    renewalVersion: t.renewalVersion + 1,
    taskVersion: t.taskVersion + 1,
    assigneeMembershipId: 'membership-tc-ayse',
  });
  expect((await queue('tc-ahmet')).items.some((r) => r.taskId === t.taskId)).toBe(false);
  expect(
    (await queue('tc-ayse')).items.find((r) => r.taskId === t.taskId)?.assigneeMembershipId,
  ).toBe('membership-tc-ayse');
  expect(
    await f.db
      .prepare('SELECT assignee_membership_id FROM policies WHERE id=?')
      .bind(t.policyId)
      .first(),
  ).toEqual(before);
  expect([403, 404]).toContain(
    (await f.request(path(t, 'assignment-options'), 'GET', cookies['tc-ahmet'])).status,
  );
});
it('supports server-null assignment and rejects suspended/inactive targets until explicitly repaired with an eligible member', async () => {
  const t = await seed();
  const unassigned = await data<RenewalTaskAssignmentDto>(
    await post(path(t, 'assign'), assign(t, null)),
  );
  expect(unassigned.assigneeMembershipId).toBeNull();
  expect((await queue()).unassignedItems.some((r) => r.taskId === t.taskId)).toBe(true);
  for (const status of ['SUSPENDED', 'INACTIVE']) {
    const inactive = await seed('tc-inactive');
    await f.db
      .prepare(
        'UPDATE agency_memberships SET status=?,suspended_at=?,inactivated_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?',
      )
      .bind(
        status,
        status === 'SUSPENDED' ? new Date().toISOString() : null,
        status === 'INACTIVE' ? new Date().toISOString() : null,
        'membership-tc-inactive',
      )
      .run();
    try {
      const before = await snapshot();
      expect(
        (await post(path(inactive, 'assign'), assign(inactive, 'membership-tc-inactive'))).status,
      ).toBe(409);
      expect(await snapshot()).toBe(before);
      const q = await data<TodayTasksResponseData>(
        await f.request(
          '/api/tasks/today?limit=50&needsReassignment=true',
          'GET',
          cookies['tc-owner'],
        ),
      );
      expect(q.items.find((r) => r.taskId === inactive.taskId)).toMatchObject({
        needsReassignment: true,
        assigneeMembershipId: 'membership-tc-inactive',
      });
      const options = await data<{ membershipId: string }[]>(
        await f.request(path(inactive, 'assignment-options'), 'GET', cookies['tc-owner']),
      );
      expect(options.some((o) => o.membershipId === 'membership-tc-inactive')).toBe(false);
      await data(await post(path(inactive, 'assign'), assign(inactive, 'membership-tc-ayse')));
    } finally {
      await f.db
        .prepare(
          "UPDATE agency_memberships SET status='ACTIVE',suspended_at=NULL,inactivated_at=NULL,version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind('membership-tc-inactive')
        .run();
    }
  }
});
it('denies member directory/assignment, other private work and cross-agency commands without evidence', async () => {
  const t = await seed('tc-ayse');
  for (const actor of ['tc-ahmet', 'tc-foreign']) {
    const before = await snapshot();
    expect([403, 404]).toContain(
      (await f.request(path(t, 'assignment-options'), 'GET', cookies[actor])).status,
    );
    expect([403, 404]).toContain(
      (await post(path(t, 'assign'), assign(t, 'membership-tc-ahmet'), actor)).status,
    );
    expect([403, 404]).toContain((await post(path(t), complete(t), actor)).status);
    expect(await snapshot()).toBe(before);
  }
});
it('denies HEALTH without explicit grant and revoked permissions/session under live authorization', async () => {
  const t = await seed();
  await f.db
    .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='tc-b'")
    .run();
  try {
    const before = await snapshot();
    expect([403, 404]).toContain((await post(path(t), complete(t))).status);
    expect([403, 404]).toContain(
      (await f.request(path(t, 'assignment-options'), 'GET', cookies['tc-owner'])).status,
    );
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db
      .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='tc-b'")
      .run();
  }
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-tc-ahmet' AND permission_code='task.update'",
    )
    .run();
  const before = await snapshot();
  expect([403, 404]).toContain((await post(path(t), complete(t), 'tc-ahmet')).status);
  expect(await snapshot()).toBe(before);
  const session = await f.session('tc-ayse');
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
    .bind(Date.now(), 'tc-ayse')
    .run();
  expect((await f.request('/api/tasks/today', 'GET', session.cookie)).status).toBe(401);
});
async function race(t: TodayTaskDto, kinds: ('complete' | 'assign')[]) {
  let arrivals = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = f.env.DB;
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 8 && arrivals < 2) {
            if (++arrivals === 2) release();
            await gate;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const results = await Promise.all(
      kinds.map((kind) =>
        post(path(t, kind), kind === 'complete' ? complete(t) : assign(t, 'membership-tc-ayse')),
      ),
    );
    expect(arrivals).toBe(2);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await f.db
        .prepare("SELECT COUNT(*) count FROM tasks WHERE renewal_id=? AND status='OPEN'")
        .bind(t.renewalId)
        .first<{ count: number }>())!.count,
    ).toBe(1);
  } finally {
    f.env.DB = db;
  }
}
it('serializes two simultaneous completions at the real atomic batch with one replacement', async () => {
  await race(await seed('tc-ayse'), ['complete', 'complete']);
});
it('serializes competing responsibility-transfer vs completion without duplicate open primary tasks', async () => {
  await race(await seed('tc-ayse'), ['assign', 'complete']);
});
