// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import type { SalesLossResult } from '../src/shared/sales-loss';
import type { SalesReopenResult, SalesReopenCommand } from '../src/shared/sales-reopen';
import { verifyOperationalRecovery } from '../scripts/recovery/operational-data-proof';
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
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('loss-i','agency-auth-test','I','Anadolu Sigorta')",
    ),
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
async function close(withFollowup = true, withPrice = false) {
  const s = await create(),
    key = crypto.randomUUID();
  if (withPrice) {
    const saved = await data<{ caseVersion: number }>(
      await post(base(s.caseId) + '/prices', {
        expectedCaseVersion: s.caseVersion,
        insurerId: 'loss-i',
        amountMinor: 12000,
        currency: 'TRY',
        termsNote: null,
        offeredPeriod: null,
      }),
      201,
    );
    s.caseVersion = saved.caseVersion;
  }
  const raw = command(s);
  const input = withFollowup
    ? raw
    : {
        ...raw,
        notes: 'Müşterinin takip tercihi.',
        nextCycle: { mode: 'NO_FOLLOW_UP', exceptionCode: 'NO_FURTHER_CONTACT' },
      };
  const result = await data<SalesLossResult>(
    await post(base(s.caseId) + '/close-lost', input, key),
  );
  return { result, input, key };
}
function reopenBody(result: SalesLossResult): SalesReopenCommand {
  return {
    expectedCaseVersion: result.caseVersion,
    expectedResultRevisionId: result.resultRevisionId,
    expectedTaskId: result.taskId,
    expectedTaskVersion: result.taskVersion,
    expectedSuccessor: result.followup
      ? {
          caseId: result.followup.caseId,
          caseVersion: result.followup.caseVersion,
          taskId: result.followup.taskId,
          taskVersion: result.followup.taskVersion,
        }
      : null,
    replacementDueAt: '2027-02-17T09:00:00.000Z',
    reasonCode: 'WRONG_OUTCOME',
    notes: 'Kayıp sonucu yanlış seçildi.',
  };
}
async function caseState(id: string) {
  return f.db
    .prepare('SELECT result,active_task_id,current_result_id,version FROM sales_cases WHERE id=?')
    .bind(id)
    .first();
}
async function taskState(id: string) {
  return f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(id).first();
}
it('recalls the untouched next cycle, replaces only the old follow-up and preserves exact concurrency replay', async () => {
  const { result, input, key: lostKey } = await close(true, true);
  const url = base(result.caseId) + '/reopen',
    key = crypto.randomUUID();
  const body = reopenBody(result);
  expect(await data(await get(url + '-context'))).toMatchObject({
    caseId: result.caseId,
    taskId: result.taskId,
    successor: body.expectedSuccessor,
  });
  const replies = await Promise.all([post(url, body, key), post(url, body, key)]);
  const outputs = await Promise.all(replies.map((reply) => data<SalesReopenResult>(reply)));
  const reopened = outputs[0]!;
  expect(outputs[1]).toEqual(reopened);
  expect(await caseState(result.caseId)).toEqual({
    result: 'OPEN',
    active_task_id: reopened.taskId,
    current_result_id: null,
    version: result.caseVersion + 1,
  });
  expect(await taskState(result.taskId)).toEqual({
    status: 'COMPLETED',
    version: result.taskVersion,
  });
  expect(await taskState(reopened.taskId)).toEqual({ status: 'OPEN', version: 1 });
  expect((await caseState(result.followup!.caseId))?.result).toBe('VOIDED');
  expect(await taskState(result.followup!.taskId)).toEqual({ status: 'COMPLETED', version: 2 });
  expect(
    await f.db
      .prepare('SELECT count(*) n FROM sales_prices WHERE case_id=?')
      .bind(result.caseId)
      .first(),
  ).toEqual({ n: 1 });
  const query = async (sql: string) => (await f.db.prepare(sql).all()).results;
  await expect(verifyOperationalRecovery(query)).resolves.toBeUndefined();
  expect(await data(await post(base(result.caseId) + '/close-lost', input, lostKey))).toEqual(
    result,
  );
  expect(
    await data(
      await f.request(url + '-operation', 'GET', cookies['loss-owner'], undefined, undefined, {
        'idempotency-key': key,
      }),
    ),
  ).toEqual(reopened);
  expect((await post(url, { ...body, notes: 'Farklı açıklama' }, key)).status).toBe(409);
  const updated = await data<{ caseVersion: number; taskId: string; taskVersion: number }>(
    await post(base(result.caseId) + '/followup', {
      expectedCaseVersion: reopened.caseVersion,
      expectedTaskId: reopened.taskId,
      expectedTaskVersion: reopened.taskVersion,
      dueAt: '2027-02-19T10:00:00.000Z',
      reasonCode: 'CALL_AGAIN',
      notes: null,
    }),
  );
  const secondLoss = await data<SalesLossResult>(
    await post(base(result.caseId) + '/close-lost', command(updated)),
  );
  expect(secondLoss.resultRevisionId).not.toBe(result.resultRevisionId);
  expect(secondLoss.followup?.caseId).not.toBe(result.followup?.caseId);
  expect(
    (
      await f.db
        .prepare(
          'SELECT result_no FROM sales_case_result_revisions WHERE case_id=? ORDER BY result_no',
        )
        .bind(result.caseId)
        .all()
    ).results,
  ).toEqual([{ result_no: 1 }, { result_no: 2 }]);
  expect(await data(await post(url, body, key))).toEqual(reopened);
  await expect(verifyOperationalRecovery(query)).resolves.toBeUndefined();
  await expect(
    verifyOperationalRecovery(async (sql) =>
      sql.includes("action='sales.case.reopen' AND outcome") ? [] : query(sql),
    ),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
});
it('rejects an advanced next cycle even if its task is still open, and preserves both records', async () => {
  const { result } = await close();
  const child = result.followup!;
  expect(
    (
      await post(base(child.caseId) + '/prices', {
        expectedCaseVersion: 1,
        insurerId: 'loss-i',
        amountMinor: 12000,
        currency: 'TRY',
        termsNote: null,
        offeredPeriod: null,
      })
    ).status,
  ).toBe(201);
  expect((await post(base(result.caseId) + '/reopen', reopenBody(result))).status).toBe(409);
  expect((await caseState(result.caseId))?.result).toBe('LOST');
  expect((await caseState(child.caseId))?.result).toBe('OPEN');
  expect(await taskState(child.taskId)).toEqual({ status: 'OPEN', version: 1 });
});
it('rolls back the new task and both case changes on final audit failure', async () => {
  const { result } = await close();
  const before = await f.db.prepare('SELECT count(*) n FROM tasks').first();
  await f.db
    .prepare(
      "CREATE TRIGGER reopen_audit_fault BEFORE INSERT ON audit_events WHEN NEW.action='sales.case.reopen' BEGIN SELECT RAISE(ABORT,'TEST_REOPEN_AUDIT_FAULT'); END",
    )
    .run();
  try {
    expect((await post(base(result.caseId) + '/reopen', reopenBody(result))).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER reopen_audit_fault').run();
  }
  expect(await f.db.prepare('SELECT count(*) n FROM tasks').first()).toEqual(before);
  expect((await caseState(result.caseId))?.result).toBe('LOST');
  expect((await caseState(result.followup!.caseId))?.result).toBe('OPEN');
  expect(await taskState(result.followup!.taskId)).toEqual({ status: 'OPEN', version: 1 });
});
it('permits a new task for a recorded no-follow-up outcome and rejects other employees and past dates', async () => {
  const { result } = await close(false);
  const url = base(result.caseId) + '/reopen',
    input = reopenBody(result);
  expect((await post(url, input, crypto.randomUUID(), 'loss-staff')).status).toBe(404);
  expect((await post(url, { ...input, replacementDueAt: '2020-01-01T00:00:00.000Z' })).status).toBe(
    400,
  );
  expect((await post(url, input)).status).toBe(200);
});
