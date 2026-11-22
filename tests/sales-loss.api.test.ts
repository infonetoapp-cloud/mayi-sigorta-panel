// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import type { SalesLossResult } from '../src/shared/sales-loss';
import { verifySalesRecovery } from '../scripts/recovery/sales-data-proof';
import { verifySalesLossRecovery } from '../scripts/recovery/sales-loss-proof';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  f = await localAuthFixture();
  for (const who of ['loss-owner', 'loss-other', 'loss-staff']) {
    await f.seed(who, who === 'loss-staff' ? 'MEMBER' : 'OWNER');
    cookies[who] = (await f.session(who)).cookie;
  }
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['quote.read', 'AGENCY'],
    ['quote.manage', 'AGENCY'],
    ['task.read', 'AGENCY'],
    ['task.update', 'AGENCY'],
    ['task.create', 'UNSCOPED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-loss-staff', code, scope)
      .run();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('loss-c','agency-auth-test','INDIVIDUAL','Takip Müşterisi','Takip','Müşterisi','membership-loss-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('loss-b','agency-auth-test','LOSS','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('loss-r','agency-auth-test','PRICE','Fiyat uygun bulunmadı')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
const base = (id: string) => `/api/sales-cases/${id}`;
async function get(url: string, who = 'loss-owner') {
  return f.request(url, 'GET', cookies[who]);
}
async function post(url: string, body: unknown, key = crypto.randomUUID(), who = 'loss-owner') {
  return f.request(url, 'POST', cookies[who], body, await f.csrf(cookies[who]!), {
    'idempotency-key': key,
  });
}
async function data<T>(r: Response, status = 200) {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function create(who = 'loss-owner') {
  return data<{ caseId: string; taskId: string; caseVersion: number; taskVersion: number }>(
    await post(
      '/api/customers/loss-c/sales-cases',
      {
        context: 'NEW_BUSINESS',
        branchId: 'loss-b',
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
}
function command(s: { caseVersion: number; taskId: string; taskVersion: number }) {
  return {
    expectedCaseVersion: s.caseVersion,
    expectedTaskId: s.taskId,
    expectedTaskVersion: s.taskVersion,
    lossReasonId: 'loss-r',
    notes: null as string | null,
    nextCycle: {
      mode: 'FOLLOW_UP' as const,
      cycleDate: '2028-02-29',
      dateBasis: 'KNOWN_END_DATE' as const,
      dueAt: '2028-01-30T06:00:00.000Z',
    },
  };
}
async function counts() {
  return (await f.db
    .prepare(
      "SELECT (SELECT count(*) FROM sales_cases) cases,(SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM sales_case_result_revisions) results,(SELECT count(*) FROM operation_receipts WHERE action='sales.case.close_lost') receipts",
    )
    .first())!;
}
it('closes the real Task and creates exactly one linked empty next-cycle case atomically, with exact historical replay', async () => {
  const s = await create(),
    body = command(s),
    key = crypto.randomUUID();
  const context = await data<{ taskId: string; canCreateFollowup: boolean }>(
    await get(base(s.caseId) + '/loss-context'),
  );
  expect(context).toMatchObject({ taskId: s.taskId, canCreateFollowup: true });
  const r = await data<SalesLossResult>(await post(base(s.caseId) + '/close-lost', body, key));
  expect(r.followup).not.toBeNull();
  expect(
    await f.db
      .prepare('SELECT result,active_task_id,current_result_id,version FROM sales_cases WHERE id=?')
      .bind(s.caseId)
      .first(),
  ).toEqual({
    result: 'LOST',
    active_task_id: null,
    current_result_id: r.resultRevisionId,
    version: s.caseVersion + 1,
  });
  expect(
    await f.db
      .prepare('SELECT status,version,completed_at FROM tasks WHERE id=?')
      .bind(s.taskId)
      .first(),
  ).toEqual({ status: 'COMPLETED', version: s.taskVersion + 1, completed_at: r.closedAt });
  expect(
    await f.db
      .prepare(
        'SELECT result,predecessor_case_id,origin_result_revision_id,cycle_date,active_task_id FROM sales_cases WHERE id=?',
      )
      .bind(r.followup!.caseId)
      .first(),
  ).toEqual({
    result: 'OPEN',
    predecessor_case_id: s.caseId,
    origin_result_revision_id: r.resultRevisionId,
    cycle_date: '2028-02-29',
    active_task_id: r.followup!.taskId,
  });
  expect(
    await f.db
      .prepare('SELECT purpose FROM sales_case_tasks WHERE case_id=?')
      .bind(r.followup!.caseId)
      .first(),
  ).toEqual({ purpose: 'NEXT_CYCLE' });
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM sales_prices WHERE case_id=?')
      .bind(r.followup!.caseId)
      .first())!.n,
  ).toBe(0);
  const before = await counts();
  expect(
    await data<SalesLossResult>(await post(base(s.caseId) + '/close-lost', body, key)),
  ).toEqual(r);
  expect(
    await data<SalesLossResult>(await get(base(s.caseId) + '/loss-operations/' + r.operationId)),
  ).toEqual(r);
  expect(await counts()).toEqual(before);
  expect((await get(base(s.caseId) + '/operations/' + r.operationId)).status).toBe(404);
  const queue = await data<{ items: Array<{ taskId: string; caseId: string; bucket: string }> }>(
    await get('/api/tasks/today?limit=50&unified=true'),
  );
  expect(queue.items.some((t) => t.taskId === s.taskId)).toBe(false);
  expect(queue.items.find((t) => t.taskId === r.followup!.taskId)).toMatchObject({
    caseId: r.followup!.caseId,
    bucket: 'UPCOMING',
  });
  expect(
    (await post(base(s.caseId) + '/close-lost', { ...body, notes: 'Farklı' }, key)).status,
  ).toBe(409);
  const summary = await data<Record<string, unknown>>(
    await get(base(s.caseId) + '/loss-result', 'loss-staff'),
  );
  expect(summary).toMatchObject({
    reason: 'Fiyat uygun bulunmadı',
    followupCaseId: r.followup!.caseId,
  });
  expect(summary).not.toHaveProperty('taskId');
  expect(summary).not.toHaveProperty('operationId');
  expect(
    (await get(base(s.caseId) + '/loss-operations/' + r.operationId, 'loss-staff')).status,
  ).toBe(404);
  expect((await post(base(s.caseId) + '/close-lost', body)).status).toBe(409);
});
it('rejects invalid dates, reason and stale/private Task versions without partial writes', async () => {
  const s = await create(),
    body = command(s),
    before = await counts();
  for (const bad of [
    { ...body, lossReasonId: 'missing' },
    { ...body, expectedCaseVersion: 99 },
    { ...body, expectedTaskVersion: 99 },
    { ...body, nextCycle: { ...body.nextCycle, dueAt: '2020-01-01T06:00:00.000Z' } },
    { ...body, nextCycle: { ...body.nextCycle, cycleDate: '2027-02-29' } },
    { ...body, nextCycle: { mode: 'NO_FOLLOW_UP', exceptionCode: 'DUPLICATE' } },
  ])
    expect([400, 409]).toContain((await post(base(s.caseId) + '/close-lost', bad)).status);
  expect(
    (await post(base(s.caseId) + '/close-lost', body, crypto.randomUUID(), 'loss-staff')).status,
  ).toBe(404);
  expect(await counts()).toEqual(before);
});
it('permits only an explicit documented no-followup exception; task.create is required only for successor creation', async () => {
  const s = await create('loss-staff'),
    body = command(s);
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-loss-staff' AND permission_code='task.create'",
    )
    .run();
  expect(
    (await post(base(s.caseId) + '/close-lost', body, crypto.randomUUID(), 'loss-staff')).status,
  ).toBe(403);
  const r = await data<SalesLossResult>(
    await post(
      base(s.caseId) + '/close-lost',
      {
        ...body,
        notes: 'Müşteri tekrar aranmak istemedi.',
        nextCycle: { mode: 'NO_FOLLOW_UP', exceptionCode: 'NO_FURTHER_CONTACT' },
      },
      crypto.randomUUID(),
      'loss-staff',
    ),
  );
  expect(r.followup).toBeNull();
  expect(await data(await get(base(s.caseId) + '/loss-result'))).toMatchObject({
    exceptionCode: 'NO_FURTHER_CONTACT',
    notes: 'Müşteri tekrar aranmak istemedi.',
  });
});
it('rolls back source, result, receipt, successor and Task when final audit insertion fails', async () => {
  const s = await create(),
    before = await counts();
  await f.db
    .prepare(
      "CREATE TRIGGER loss_test_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='sales.case.close_lost' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END",
    )
    .run();
  try {
    expect((await post(base(s.caseId) + '/close-lost', command(s))).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER loss_test_audit_failure').run();
  }
  expect(await counts()).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT result,version,active_task_id FROM sales_cases WHERE id=?')
      .bind(s.caseId)
      .first(),
  ).toEqual({ result: 'OPEN', version: 1, active_task_id: s.taskId });
  expect(
    await f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(s.taskId).first(),
  ).toEqual({ status: 'OPEN', version: 1 });
});
it('admits only one of two concurrent terminal commands', async () => {
  const s = await create(),
    body = command(s);
  const responses = await Promise.all([
    post(base(s.caseId) + '/close-lost', body),
    post(base(s.caseId) + '/close-lost', body),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM sales_case_result_revisions WHERE case_id=?')
      .bind(s.caseId)
      .first())!.n,
  ).toBe(1);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM sales_cases WHERE predecessor_case_id=?')
      .bind(s.caseId)
      .first())!.n,
  ).toBe(1);
});
it('replays the historical creation after loss, follows a successor again without duplicating the predecessor, and verifies recovery lineage', async () => {
  const createBody = {
      context: 'NEW_BUSINESS',
      branchId: 'loss-b',
      cycleDate: null,
      dateBasis: 'MANUAL',
      followup: { dueAt: '2027-01-10T06:00:00.000Z' },
      confirmSimilar: true,
    },
    key = crypto.randomUUID();
  const s = await data<{
    caseId: string;
    taskId: string;
    taskVersion: number;
    caseVersion: number;
  }>(await post('/api/customers/loss-c/sales-cases', createBody, key), 201);
  const r = await data<SalesLossResult>(await post(base(s.caseId) + '/close-lost', command(s)));
  expect(await data(await post('/api/customers/loss-c/sales-cases', createBody, key), 201)).toEqual(
    s,
  );
  const followKey = crypto.randomUUID(),
    followBody = {
      expectedCaseVersion: 1,
      expectedTaskId: r.followup!.taskId,
      expectedTaskVersion: 1,
      dueAt: '2028-01-31T06:00:00.000Z',
      reasonCode: 'CALL_AGAIN',
      notes: null,
    };
  const follow = await data<{ caseVersion: number; taskId: string; taskVersion: number }>(
    await post(base(r.followup!.caseId) + '/followup', followBody, followKey),
  );
  const nextCommand = command(follow);
  nextCommand.nextCycle.cycleDate = '2029-04-20';
  nextCommand.nextCycle.dueAt = '2029-03-20T06:00:00.000Z';
  const next = await data<SalesLossResult>(
    await post(base(r.followup!.caseId) + '/close-lost', nextCommand),
  );
  expect(next.followup!.caseId).not.toBe(r.followup!.caseId);
  expect(
    await data(await post(base(r.followup!.caseId) + '/followup', followBody, followKey)),
  ).toEqual(follow);
  const query = async (sql: string) => (await f.db.prepare(sql).all()).results;
  await verifySalesRecovery(query);
  await verifySalesLossRecovery(query);
  for (const table of ['sales_case_result_revisions', 'sales_case_history', 'sales_case_tasks']) {
    await expect(
      verifySalesLossRecovery(async (sql) => (sql === `SELECT * FROM ${table}` ? [] : query(sql))),
    ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
  }
});
it('requires HEALTH read/write even for owners and carries frozen HEALTH into the successor after a branch downgrade', async () => {
  await f.db
    .prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('loss-health','agency-auth-test','LOSS_H','Sağlık','HEALTH')",
    )
    .run();
  for (const code of ['sensitive.health.read', 'sensitive.health.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-loss-owner', code, 'UNSCOPED')
      .run();
  const s = await data<{
    caseId: string;
    taskId: string;
    taskVersion: number;
    caseVersion: number;
  }>(
    await post('/api/customers/loss-c/sales-cases', {
      context: 'NEW_BUSINESS',
      branchId: 'loss-health',
      cycleDate: null,
      dateBasis: 'MANUAL',
      followup: { dueAt: '2027-01-10T06:00:00.000Z' },
      confirmSimilar: true,
    }),
    201,
  );
  await f.db
    .prepare(
      "UPDATE insurance_branches SET data_classification='GENERAL',version=version+1 WHERE id='loss-health'",
    )
    .run();
  expect((await get(base(s.caseId) + '/loss-context', 'loss-other')).status).toBe(404);
  expect(
    (await post(base(s.caseId) + '/close-lost', command(s), crypto.randomUUID(), 'loss-other'))
      .status,
  ).toBe(404);
  const r = await data<SalesLossResult>(await post(base(s.caseId) + '/close-lost', command(s)));
  expect(
    await f.db
      .prepare('SELECT data_classification FROM sales_cases WHERE id=?')
      .bind(r.followup!.caseId)
      .first(),
  ).toEqual({ data_classification: 'HEALTH' });
});
it('rechecks the current permission version at the last atomic boundary', async () => {
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) SELECT ?,'membership-loss-staff','task.create','UNSCOPED' WHERE NOT EXISTS(SELECT 1 FROM membership_permissions WHERE membership_id='membership-loss-staff' AND permission_code='task.create')",
    )
    .bind(crypto.randomUUID())
    .run();
  const s = await create('loss-staff'),
    before = await counts(),
    original = f.env.DB,
    csrf = await f.csrf(cookies['loss-staff']!);
  let prepared = false,
    revoked = false;
  f.env.DB = {
    prepare(sql: string) {
      if (/INSERT INTO sales_case_result_revisions/.test(sql)) prepared = true;
      return original.prepare(sql);
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (prepared && !revoked) {
        revoked = true;
        await original
          .prepare(
            "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-loss-staff'",
          )
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const response = await f.request(
      base(s.caseId) + '/close-lost',
      'POST',
      cookies['loss-staff'],
      command(s),
      csrf,
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(revoked).toBe(true);
    expect(response.status, await response.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(await counts()).toEqual(before);
});
it('rolls back a session revoked between admission and the final write batch', async () => {
  const s = await create(),
    before = await counts(),
    original = f.env.DB,
    csrf = await f.csrf(cookies['loss-owner']!);
  let prepared = false,
    revoked = false;
  f.env.DB = {
    prepare(sql: string) {
      if (/INSERT INTO sales_case_result_revisions/.test(sql)) prepared = true;
      return original.prepare(sql);
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (prepared && !revoked) {
        revoked = true;
        await original
          .prepare(
            "UPDATE local_sessions SET revoked_at=? WHERE user_id='loss-owner' AND revoked_at IS NULL",
          )
          .bind(Date.now())
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const response = await f.request(
      base(s.caseId) + '/close-lost',
      'POST',
      cookies['loss-owner'],
      command(s),
      csrf,
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(revoked).toBe(true);
    expect(response.status, await response.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(await counts()).toEqual(before);
});
