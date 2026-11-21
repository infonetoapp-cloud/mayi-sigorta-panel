// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { verifyOperationalRecovery } from '../scripts/recovery/operational-data-proof';

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
    ['task.update', 'AGENCY'],
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
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('issue-product','agency-auth-test','price-events-i','price-events-b','NEW','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('issue-payment','agency-auth-test','NEW','Nakit')",
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

const issue = (s: Source) => base(s.caseId) + '/issue-policy';
function policyInput(label: string, premium = '12500.50') {
  return {
    customerId,
    insurerId: 'price-events-i',
    productId: 'issue-product',
    branchId: 'price-events-b',
    paymentMethodId: 'issue-payment',
    policyNumber: 'NEW-ISSUE-' + label,
    startDate: '2027-01-10',
    endDate: '2027-04-01',
    grossPremium: premium,
    currency: 'TRY',
    installmentCount: null,
  };
}
async function accepted() {
  const s = await source();
  await event(s, 'SHARED');
  return { s, acceptance: await event(s, 'CUSTOMER_ACCEPTED') };
}
const voidPath = (s: Source) => base(s.caseId) + '/void';
const body = (s: Source) => ({
  expectedCaseVersion: s.caseVersion,
  expectedTaskId: s.taskId,
  expectedTaskVersion: s.taskVersion,
  reasonCode: 'DUPLICATE',
  notes: 'Müşteri için açılmış ikinci çalışma.',
});
async function caseState(s: Source) {
  return f.db
    .prepare('SELECT result,active_task_id,version FROM sales_cases WHERE id=?')
    .bind(s.caseId)
    .first();
}
async function taskState(s: Source) {
  return f.db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(s.taskId).first();
}
it('authorizes the exact task, closes the duplicate atomically, and preserves the existing price and approval', async () => {
  const { s, acceptance } = await accepted();
  const other = await source();
  await expect(
    f.db
      .prepare(
        "UPDATE sales_cases SET result='VOIDED',active_task_id=NULL,version=version+1 WHERE id=?",
      )
      .bind(s.caseId)
      .run(),
  ).rejects.toThrow('SALES_RESULT_POINTER_INVALID');
  expect(await data(await get(voidPath(s) + '-context'))).toEqual({
    caseId: s.caseId,
    caseVersion: s.caseVersion,
    taskId: s.taskId,
    taskVersion: s.taskVersion,
  });
  const key = crypto.randomUUID();
  const replies = await Promise.all([
    post(voidPath(s), body(s), key),
    post(voidPath(s), body(s), key),
  ]);
  const results = await Promise.all(replies.map((r) => data(r)));
  expect(results[0]).toEqual(results[1]);
  expect(await caseState(s)).toEqual({
    result: 'VOIDED',
    active_task_id: null,
    version: s.caseVersion + 1,
  });
  expect(await taskState(s)).toEqual({ status: 'COMPLETED', version: s.taskVersion + 1 });
  expect(await taskState(other)).toEqual({ status: 'OPEN', version: other.taskVersion });
  expect(
    await f.db
      .prepare('SELECT event_code FROM sales_price_events WHERE id=?')
      .bind(acceptance.eventId)
      .first(),
  ).toEqual({ event_code: 'CUSTOMER_ACCEPTED' });
  expect(
    await f.db
      .prepare(
        "SELECT reason_code,notes FROM sales_case_history WHERE case_id=? AND event_code='VOIDED'",
      )
      .bind(s.caseId)
      .first(),
  ).toEqual({ reason_code: body(s).reasonCode, notes: body(s).notes });
  const proof = await f.request(
    voidPath(s) + '-operation',
    'GET',
    cookies['price-events-owner'],
    undefined,
    undefined,
    { 'idempotency-key': key },
  );
  expect(proof.headers.get('cache-control')).toBe('private, no-store');
  expect(await data(proof)).toEqual(results[0]);
  expect((await post(voidPath(s), { ...body(s), notes: 'Değişmiş açıklama' }, key)).status).toBe(
    409,
  );
  await expect(
    verifyOperationalRecovery(async (sql) => (await f.db.prepare(sql).all()).results),
  ).resolves.toBeUndefined();
  await expect(
    verifyOperationalRecovery(async (sql) =>
      sql.includes("action='sales.case.void' AND outcome")
        ? []
        : (await f.db.prepare(sql).all()).results,
    ),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
});
it('rejects missing notes, stale revisions, unrelated tasks, and another employee or agency', async () => {
  const s = await source(),
    other = await source();
  expect((await post(voidPath(s), { ...body(s), notes: '   ' })).status).toBe(400);
  expect(
    (await post(voidPath(s), { ...body(s), expectedTaskVersion: s.taskVersion + 1 })).status,
  ).toBe(409);
  expect((await post(voidPath(s), { ...body(s), expectedTaskId: other.taskId })).status).toBe(404);
  for (const user of ['price-events-staff', 'price-events-foreign']) {
    expect((await get(voidPath(s) + '-context', user)).status).toBe(404);
    expect((await post(voidPath(s), body(s), crypto.randomUUID(), user)).status).toBe(404);
  }
  expect(await taskState(s)).toEqual({ status: 'OPEN', version: s.taskVersion });
});
it('rolls back the history, case and task if the final audit fails', async () => {
  const s = await source(),
    key = crypto.randomUUID();
  await f.db
    .prepare(
      "CREATE TRIGGER void_audit_fault BEFORE INSERT ON audit_events WHEN NEW.action='sales.case.void' BEGIN SELECT RAISE(ABORT,'TEST_VOID_AUDIT_FAULT'); END",
    )
    .run();
  try {
    expect((await post(voidPath(s), body(s), key)).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER void_audit_fault').run();
  }
  expect(await caseState(s)).toEqual({
    result: 'OPEN',
    active_task_id: s.taskId,
    version: s.caseVersion,
  });
  expect(await taskState(s)).toEqual({ status: 'OPEN', version: s.taskVersion });
  expect(
    await f.db
      .prepare("SELECT id FROM sales_case_history WHERE case_id=? AND event_code='VOIDED'")
      .bind(s.caseId)
      .first(),
  ).toBeNull();
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  expect((await post(voidPath(s), body(s), key)).status).toBe(200);
});
it('allows only one of issuing a policy and voiding the same case', async () => {
  const s = await source();
  const payload = {
    expectedCaseVersion: s.caseVersion,
    expectedTaskId: s.taskId,
    expectedTaskVersion: s.taskVersion,
    source: { kind: 'NO_QUOTE', reason: 'Poliçe doğrudan düzenlendi' },
    result: { kind: 'CREATE_POLICY', policy: policyInput('race') },
  };
  const [a, b] = await Promise.all([post(voidPath(s), body(s)), post(issue(s), payload)]);
  expect([200, 409]).toContain(a.status);
  expect([201, 409]).toContain(b.status);
  expect([a.status, b.status].filter((status) => status === 409)).toHaveLength(1);
  const issued = b.status === 201;
  expect((await caseState(s))?.result).toBe(issued ? 'WON' : 'VOIDED');
  expect(
    !!(await f.db.prepare("SELECT id FROM policies WHERE policy_number='NEW-ISSUE-race'").first()),
  ).toBe(issued);
  expect((await taskState(s))?.status).toBe('COMPLETED');
});
