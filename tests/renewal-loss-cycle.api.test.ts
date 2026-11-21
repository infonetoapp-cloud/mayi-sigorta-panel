import { verifySalesRecovery } from '../scripts/recovery/sales-data-proof';
import { verifySalesLossRecovery } from '../scripts/recovery/sales-loss-proof';
// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import type { RenewalLostResult } from '../src/server/renewals/commands';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  f = await localAuthFixture();
  for (const who of ['cycle-owner', 'cycle-staff', 'cycle-other']) {
    await f.seed(who, who === 'cycle-staff' ? 'MEMBER' : 'OWNER');
    cookies[who] = (await f.session(who)).cookie;
  }
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['policy.read', 'AGENCY'],
    ['renewal.read', 'AGENCY'],
    ['renewal.close_lost', 'AGENCY'],
    ['task.read', 'AGENCY'],
    ['task.update', 'AGENCY'],
    ['task.create', 'UNSCOPED'],
    ['quote.read', 'AGENCY'],
    ['quote.manage', 'AGENCY'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-cycle-staff', code, scope)
      .run();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('cycle-c','agency-auth-test','INDIVIDUAL','Dönem Müşterisi','Dönem','Müşterisi','membership-cycle-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('cycle-i','agency-auth-test','CYCLE','Anadolu Sigorta')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('cycle-b','agency-auth-test','CYCLE','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('cycle-p','agency-auth-test','cycle-i','cycle-b','CYCLE','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('cycle-pay','agency-auth-test','CYCLE','Nakit')",
    ),
    f.db.prepare(
      "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('cycle-loss','agency-auth-test','PRICE','Fiyat uygun bulunmadı')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function post(url: string, body: unknown, key = crypto.randomUUID(), who = 'cycle-owner') {
  return f.request(url, 'POST', cookies[who], body, await f.csrf(cookies[who]!), {
    'idempotency-key': key,
  });
}
async function data<T>(r: Response, status = 200) {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function create(who = 'cycle-owner') {
  const p = crypto.randomUUID(),
    r = crypto.randomUUID(),
    t = crypto.randomUUID();
  await f.db.batch([
    f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'agency-auth-test','cycle-c','cycle-i','cycle-p','cycle-b','cycle-pay',?,?,?,'2026-01-01','2027-01-20',12345,'TRY')",
      )
      .bind(p, 'membership-' + who, p, p),
    f.db
      .prepare(
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id) VALUES(?,'agency-auth-test',?,?)",
      )
      .bind(r, p, 'membership-' + who),
    f.db
      .prepare(
        "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES(?,'agency-auth-test','cycle-c',?,'RENEWAL_FOLLOWUP','Yenileme','2027-01-10T06:00:00.000Z',?,'SYSTEM')",
      )
      .bind(t, r, 'membership-' + who),
  ]);
  const c = await data<{ caseId: string }>(
    await post(
      '/api/customers/cycle-c/sales-cases',
      {
        context: 'RENEWAL',
        renewalId: r,
        expectedVersion: 1,
        expectedPrimaryTaskId: t,
        expectedPrimaryTaskVersion: 1,
      },
      crypto.randomUUID(),
      who,
    ),
    201,
  );
  return { renewalId: r, taskId: t, caseId: c.caseId };
}
function body(s: { taskId: string; caseId: string }) {
  return {
    expectedPrimaryTaskId: s.taskId,
    expectedRenewalVersion: 1,
    expectedTaskVersion: 1,
    lossReasonId: 'cycle-loss',
    lossReasonNotes: null,
    salesCycle: {
      caseId: s.caseId,
      expectedCaseVersion: 1,
      notes: null as string | null,
      nextCycle: {
        mode: 'FOLLOW_UP' as const,
        cycleDate: '2028-02-29',
        dateBasis: 'KNOWN_END_DATE' as const,
        dueAt: '2028-01-30T06:00:00.000Z',
      },
    },
  };
}
const url = (s: { renewalId: string }) => `/api/renewals/${s.renewalId}/close-lost`;
async function counts() {
  return f.db
    .prepare(
      'SELECT (SELECT count(*) FROM sales_cases) cases,(SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM sales_case_result_revisions) results,(SELECT count(*) FROM operation_receipts) receipts',
    )
    .first();
}
it('atomically closes the actual renewal/primary Task and links an empty successor without copying renewal state', async () => {
  const s = await create(),
    b = body(s),
    key = crypto.randomUUID(),
    r = await data<RenewalLostResult>(await post(url(s), b, key));
  expect(r).toMatchObject({
    renewalId: s.renewalId,
    state: 'LOST',
    primaryTaskId: s.taskId,
    renewalVersion: 2,
    taskVersion: 2,
    salesCycle: { caseId: s.caseId, caseVersion: 2, taskId: s.taskId, taskVersion: 2 },
  });
  expect(
    await f.db
      .prepare('SELECT result,active_task_id,current_result_id FROM sales_cases WHERE id=?')
      .bind(s.caseId)
      .first(),
  ).toEqual({
    result: null,
    active_task_id: null,
    current_result_id: r.salesCycle!.resultRevisionId,
  });
  expect(
    await f.db
      .prepare(
        'SELECT predecessor_case_id,origin_result_revision_id,result FROM sales_cases WHERE id=?',
      )
      .bind(r.salesCycle!.followup!.caseId)
      .first(),
  ).toEqual({
    predecessor_case_id: s.caseId,
    origin_result_revision_id: r.salesCycle!.resultRevisionId,
    result: 'OPEN',
  });
  expect(
    await f.db
      .prepare(
        'SELECT kind,renewal_id,policy_id,status,assignee_membership_id,due_at FROM tasks WHERE id=?',
      )
      .bind(r.salesCycle!.followup!.taskId)
      .first(),
  ).toEqual({
    kind: 'GENERAL',
    renewal_id: null,
    policy_id: null,
    status: 'OPEN',
    assignee_membership_id: 'membership-cycle-owner',
    due_at: b.salesCycle.nextCycle.dueAt,
  });
  expect(
    await data(
      await f.request(
        `/api/sales-cases/${s.caseId}/loss-operations/${r.salesCycle!.operationId}`,
        'GET',
        cookies['cycle-owner'],
      ),
    ),
  ).toEqual(r.salesCycle);
  expect(
    await data(
      await f.request(
        `/api/sales-cases/${s.caseId}/loss-operations/${r.salesCycle!.operationId}`,
        'GET',
        cookies['cycle-other'],
      ),
    ),
  ).toEqual(r.salesCycle);
  expect(
    (
      await f.request(
        `/api/sales-cases/${s.caseId}/loss-operations/${r.salesCycle!.operationId}`,
        'GET',
        cookies['cycle-staff'],
      )
    ).status,
  ).toBe(404);
  const before = await counts();
  expect(await data(await post(url(s), b, key))).toEqual(r);
  expect(await counts()).toEqual(before);
  expect(
    (await post(url(s), { ...b, salesCycle: { ...b.salesCycle, notes: 'Farklı' } }, key)).status,
  ).toBe(409);
  expect(
    await data(
      await f.request(`/api/sales-cases/${s.caseId}/loss-result`, 'GET', cookies['cycle-staff']),
    ),
  ).toMatchObject({ followupCaseId: r.salesCycle!.followup!.caseId });
});
it('rolls back both domains when the final renewal audit fails', async () => {
  const s = await create(),
    before = await counts();
  await f.db
    .prepare(
      "CREATE TRIGGER cycle_audit_fail BEFORE INSERT ON audit_events WHEN NEW.action='renewal.closed_lost' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END",
    )
    .run();
  try {
    expect((await post(url(s), body(s))).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER cycle_audit_fail').run();
  }
  expect(await counts()).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
      .bind(s.renewalId)
      .first(),
  ).toEqual({ state: 'CONTACT_PENDING', version: 1 });
  expect(
    await f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(s.taskId).first(),
  ).toEqual({ status: 'OPEN', version: 1 });
});
it('rejects stale case versions, cross-case identity and invalid next dates without partial closure', async () => {
  const s = await create(),
    other = await create(),
    b = body(s),
    before = await counts();
  for (const bad of [
    { ...b, salesCycle: { ...b.salesCycle, expectedCaseVersion: 9 } },
    { ...b, salesCycle: { ...b.salesCycle, caseId: other.caseId } },
    {
      ...b,
      salesCycle: {
        ...b.salesCycle,
        nextCycle: { ...b.salesCycle.nextCycle, dueAt: '2020-01-01T06:00:00.000Z' },
      },
    },
  ])
    expect([400, 404, 409]).toContain((await post(url(s), bad)).status);
  expect([403, 404]).toContain((await post(url(s), b, crypto.randomUUID(), 'cycle-staff')).status);
  expect(await counts()).toEqual(before);
});
it('permits an explicit documented exception without task.create and keeps that separate from legacy OTHER-note rules', async () => {
  const s = await create('cycle-staff'),
    b = body(s);
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-cycle-staff' AND permission_code='task.create'",
    )
    .run();
  expect((await post(url(s), b, crypto.randomUUID(), 'cycle-staff')).status).toBe(403);
  const r = await data<RenewalLostResult>(
    await post(
      url(s),
      {
        ...b,
        salesCycle: {
          ...b.salesCycle,
          notes: 'Tekrar iletişim istemiyor.',
          nextCycle: { mode: 'NO_FOLLOW_UP', exceptionCode: 'NO_FURTHER_CONTACT' },
        },
      },
      crypto.randomUUID(),
      'cycle-staff',
    ),
  );
  expect(r.salesCycle!.followup).toBeNull();
});
it('returns the same successor for identical concurrent requests and admits only one competing result', async () => {
  const s = await create(),
    b = body(s),
    key = crypto.randomUUID();
  const same = await Promise.all([post(url(s), b, key), post(url(s), b, key)]);
  expect(same.map((r) => r.status)).toEqual([200, 200]);
  expect(await data(same[0]!)).toEqual(await data(same[1]!));
  const other = await create(),
    different = await Promise.all([post(url(other), body(other)), post(url(other), body(other))]);
  expect(different.map((r) => r.status).sort()).toEqual([200, 409]);
});
it('prevents reopening a linked cycle without recalling the successor while leaving legacy reopen behavior intact', async () => {
  const s = await create();
  const contextUrl = `/api/renewals/${s.renewalId}/cycle-context`;
  expect(
    await data(await f.request(contextUrl + '?mode=close', 'GET', cookies['cycle-owner'])),
  ).toMatchObject({
    taskId: s.taskId,
    taskVersion: 1,
    renewalVersion: 1,
    salesCycle: { caseId: s.caseId, expectedCaseVersion: 1, canCreateFollowup: true },
  });
  const lostKey = crypto.randomUUID();
  const lost = await data<RenewalLostResult>(await post(url(s), body(s), lostKey));
  const cycle = lost.salesCycle!;

  expect(
    await data(await f.request(contextUrl + '?mode=reopen', 'GET', cookies['cycle-owner'])),
  ).toMatchObject({
    taskId: s.taskId,
    renewalVersion: 2,
    salesCycle: {
      resultRevisionId: cycle.resultRevisionId,
      successorCaseId: cycle.followup!.caseId,
      successorDueAt: cycle.followup!.dueAt,
      canRecall: true,
    },
  });
  expect(
    await data(await f.request(contextUrl + '?mode=reopen', 'GET', cookies['cycle-other'])),
  ).toMatchObject({
    salesCycle: { successorCaseId: null, successorDueAt: null, canRecall: false },
  });
  const reopen = {
    expectedRenewalVersion: 2,
    expectedTaskVersion: 2,
    replacementDueAt: '2027-02-01T06:00:00.000Z',
    reopenReasonCode: 'CUSTOMER_RETURNED',
  };
  const response = await post(`/api/renewals/${s.renewalId}/reopen`, reopen);
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'SALES_CYCLE_REOPEN_REQUIRED' } });
  const command = {
    ...reopen,
    salesCycle: {
      caseId: s.caseId,
      expectedCaseVersion: cycle.caseVersion,
      resultRevisionId: cycle.resultRevisionId,
      successorCaseId: cycle.followup!.caseId,
    },
  };
  const reopenUrl = `/api/renewals/${s.renewalId}/reopen`;
  const key = crypto.randomUUID(),
    before = await counts();
  await f.db
    .prepare(
      "CREATE TRIGGER recall_fail BEFORE INSERT ON audit_events WHEN NEW.action='renewal.reopened' BEGIN SELECT RAISE(ABORT,'TEST_RECALL_ROLLBACK'); END",
    )
    .run();
  try {
    expect((await post(reopenUrl, command, key)).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER recall_fail').run();
  }
  expect(await counts()).toEqual(before);
  expect(
    await f.db
      .prepare('SELECT result FROM sales_cases WHERE id=?')
      .bind(cycle.followup!.caseId)
      .first(),
  ).toEqual({ result: 'OPEN' });
  const result = await data<{ primaryTaskId: string }>(await post(reopenUrl, command, key));
  expect(await data(await post(reopenUrl, command, key))).toEqual(result);
  expect(await data(await post(url(s), body(s), lostKey))).toEqual(lost);
  expect(
    await f.db
      .prepare('SELECT result,active_task_id FROM sales_cases WHERE id=?')
      .bind(cycle.followup!.caseId)
      .first(),
  ).toEqual({ result: 'VOIDED', active_task_id: null });
  expect(
    await f.db
      .prepare('SELECT status,version FROM tasks WHERE id=?')
      .bind(cycle.followup!.taskId)
      .first(),
  ).toEqual({ status: 'COMPLETED', version: 2 });
  const again = body(s);
  again.expectedPrimaryTaskId = result.primaryTaskId;
  again.expectedRenewalVersion = 3;
  again.salesCycle.expectedCaseVersion = 3;
  const newLoss = await data<RenewalLostResult>(await post(url(s), again));
  expect(newLoss.salesCycle!.followup!.caseId).not.toBe(cycle.followup!.caseId);
  expect(await data(await post(reopenUrl, command, key))).toEqual(result);
  const old = await create(),
    { salesCycle: unused, ...legacy } = body(old);
  void unused;
  await data(await post(url(old), legacy));
  expect((await post(`/api/renewals/${old.renewalId}/reopen`, reopen)).status).toBe(200);
});

it('keeps a successor intact if it belongs to another worker or its followup has advanced', async () => {
  const source = await create(),
    lost = await data<RenewalLostResult>(await post(url(source), body(source))),
    cycle = lost.salesCycle!;
  const command = {
    expectedRenewalVersion: 2,
    expectedTaskVersion: 2,
    replacementDueAt: '2027-02-01T06:00:00.000Z',
    reopenReasonCode: 'CUSTOMER_RETURNED',
    salesCycle: {
      caseId: source.caseId,
      expectedCaseVersion: cycle.caseVersion,
      resultRevisionId: cycle.resultRevisionId,
      successorCaseId: cycle.followup!.caseId,
    },
  };
  const path = `/api/renewals/${source.renewalId}/reopen`;
  const other = await post(path, command, crypto.randomUUID(), 'cycle-other');
  expect(other.status).toBe(409);
  expect(await other.json()).toMatchObject({
    error: { code: 'SALES_CYCLE_SUCCESSOR_UNAVAILABLE' },
  });
  await data(
    await post(`/api/sales-cases/${cycle.followup!.caseId}/followup`, {
      expectedCaseVersion: 1,
      expectedTaskId: cycle.followup!.taskId,
      expectedTaskVersion: 1,
      dueAt: '2028-01-31T06:00:00.000Z',
      reasonCode: 'CALL_AGAIN',
      notes: null,
    }),
  );
  const before = await counts();
  const advanced = await post(path, command);
  expect(advanced.status).toBe(409);
  expect(await advanced.json()).toMatchObject({
    error: { code: 'SALES_CYCLE_SUCCESSOR_UNAVAILABLE' },
  });
  expect(await counts()).toEqual(before);
});
it('reopens an explicit no-followup loss without creating or recalling a successor', async () => {
  const source = await create();
  const close = body(source);
  const lost = await data<RenewalLostResult>(
    await post(url(source), {
      ...close,
      salesCycle: {
        ...close.salesCycle,
        notes: 'Müşteri tekrar iletişim istemedi.',
        nextCycle: { mode: 'NO_FOLLOW_UP', exceptionCode: 'NO_FURTHER_CONTACT' },
      },
    }),
  );
  const cycle = lost.salesCycle!;
  const command = {
    expectedRenewalVersion: lost.renewalVersion,
    expectedTaskVersion: lost.taskVersion,
    replacementDueAt: '2027-02-01T06:00:00.000Z',
    reopenReasonCode: 'CUSTOMER_RETURNED',
    salesCycle: {
      caseId: source.caseId,
      expectedCaseVersion: cycle.caseVersion,
      resultRevisionId: cycle.resultRevisionId,
      successorCaseId: null,
    },
  };
  const before = await counts();
  const path = `/api/renewals/${source.renewalId}/reopen`;
  const key = crypto.randomUUID();
  const saved = await data(await post(path, command, key));
  expect(saved).toMatchObject({ salesCycle: { successorCaseId: null, successorTaskId: null } });
  expect(await data(await post(path, command, key))).toEqual(saved);
  expect(await counts()).toEqual({
    ...before,
    tasks: Number(before?.tasks) + 1,
    receipts: Number(before?.receipts) + 1,
  });
});

it('uses the replacement primary Task without rewriting the historical adoption link', async () => {
  const s = await create();
  const replacement = await data<{ replacementTaskId: string; renewalVersion: number }>(
    await post(`/api/renewals/${s.renewalId}/tasks/${s.taskId}/complete`, {
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      replacementDueAt: '2027-01-15T06:00:00.000Z',
      followupReason: 'CALL_AGAIN',
    }),
  );
  const b = body(s);
  b.expectedPrimaryTaskId = replacement.replacementTaskId;
  b.expectedRenewalVersion = replacement.renewalVersion;
  const r = await data<RenewalLostResult>(await post(url(s), b));
  expect(r.primaryTaskId).toBe(replacement.replacementTaskId);
  expect(
    await f.db
      .prepare('SELECT task_id FROM sales_case_tasks WHERE case_id=?')
      .bind(s.caseId)
      .first(),
  ).toEqual({ task_id: s.taskId });
});
it('proves actual renewal/receipt/history lineage and rejects missing results and successors during recovery', async () => {
  const query = async (sql: string) => (await f.db.prepare(sql).all()).results;
  const restored = new DatabaseSync(':memory:');
  try {
    const schema = await f.db
      .prepare(
        "SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all<{ name: string; type: string; sql: string }>();
    const tables = schema.results.filter((object) => object.type === 'table');
    for (const table of tables) restored.exec(table.sql);
    for (const index of schema.results.filter((object) => object.type === 'index'))
      restored.exec(index.sql);
    restored.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
    const quoteIdentifier = (id: string) => '"' + id.replaceAll('"', '""') + '"';
    for (const table of tables) {
      const name = quoteIdentifier(table.name);
      const rows = (
        await f.db.prepare('SELECT * FROM ' + name).all<Record<string, string | number | null>>()
      ).results;
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]!);
      const insert = restored.prepare(
        `INSERT INTO ${name} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      for (const row of rows) insert.run(...columns.map((column) => row[column]!));
    }
    restored.exec('COMMIT');
    for (const object of schema.results.filter((object) =>
      ['trigger', 'view'].includes(object.type),
    ))
      restored.exec(object.sql);
    expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const restoredQuery = (sql: string) => restored.prepare(sql).all();
    await verifySalesRecovery(restoredQuery);
    await verifySalesLossRecovery(restoredQuery);
  } finally {
    restored.close();
  }
  for (const table of ['sales_case_result_revisions', 'sales_case_history', 'sales_cases'])
    await expect(
      verifySalesLossRecovery(async (sql) => (sql === `SELECT * FROM ${table}` ? [] : query(sql))),
    ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
});
it.each(['permission', 'session'] as const)(
  'rejects a final %s revocation without leaving a successor or partial renewal result',
  async (kind) => {
    const s = await create(),
      before = await counts(),
      original = f.env.DB,
      csrf = await f.csrf(cookies['cycle-owner']!);
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
          if (kind === 'permission')
            await original
              .prepare(
                "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-cycle-owner'",
              )
              .run();
          else
            await original
              .prepare(
                "UPDATE local_sessions SET revoked_at=? WHERE user_id='cycle-owner' AND revoked_at IS NULL",
              )
              .bind(Date.now())
              .run();
        }
        return original.batch(statements);
      },
    } as D1Database;
    try {
      const r = await f.request(url(s), 'POST', cookies['cycle-owner'], body(s), csrf, {
        'idempotency-key': crypto.randomUUID(),
      });
      expect(revoked).toBe(true);
      expect(r.status, await r.clone().text()).toBe(403);
    } finally {
      f.env.DB = original;
      cookies['cycle-owner'] = (await f.session('cycle-owner')).cookie;
    }
    expect(await counts()).toEqual(before);
  },
);
