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
function issueBody(s: Source, acceptance: Result, label: string) {
  return {
    expectedCaseVersion: s.caseVersion,
    expectedTaskId: s.taskId,
    expectedTaskVersion: s.taskVersion,
    source: {
      kind: 'PRICE_REVISION',
      revisionId: s.revisionId,
      acceptanceEventId: acceptance.eventId,
    },
    result: { kind: 'CREATE_POLICY', policy: policyInput(label) },
  };
}
async function accepted() {
  const s = await source();
  await event(s, 'SHARED');
  return { s, acceptance: await event(s, 'CUSTOMER_ACCEPTED') };
}
type Issued = {
  operationId: string;
  policyId: string;
  createdPolicy: boolean;
  policyVersion: number;
};
it('creates a nonannual policy, completes the GENERAL Task, and exactly replays concurrent attempts', async () => {
  const { s, acceptance } = await accepted();
  expect(await data(await get(base(s.caseId) + '/issue-context'))).toMatchObject({
    caseId: s.caseId,
    caseVersion: s.caseVersion,
    taskId: s.taskId,
    canCreate: true,
  });
  expect(await data(await get(base(s.caseId) + '/issue-price-options'))).toMatchObject({
    options: [
      {
        source: {
          caseId: s.caseId,
          expectedCaseVersion: s.caseVersion,
          revisionId: s.revisionId,
          acceptanceEventId: acceptance.eventId,
        },
      },
    ],
  });
  const body = issueBody(s, acceptance, 'create'),
    key = crypto.randomUUID();
  const replies = await Promise.all([post(issue(s), body, key), post(issue(s), body, key)]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 201]);
  const outputs = await Promise.all(replies.map((r) => data<Issued>(r, r.status)));
  expect(outputs[0]).toEqual(outputs[1]);
  const saved = outputs[0]!;
  const proof = await f.request(
    base(s.caseId) + '/issue-operation',
    'GET',
    cookies['price-events-owner'],
    undefined,
    undefined,
    { 'idempotency-key': key },
  );
  expect(proof.headers.get('cache-control')).toBe('private, no-store');
  expect(await data(proof)).toEqual(saved);
  expect(
    (
      await f.request(
        base(s.caseId) + '/issue-operation',
        'GET',
        cookies['price-events-staff'],
        undefined,
        undefined,
        { 'idempotency-key': key },
      )
    ).status,
  ).toBe(404);
  expect(saved.createdPolicy).toBe(true);
  expect(await data(await get(base(s.caseId)))).toMatchObject({ id: s.caseId, result: 'WON' });
  expect(
    await f.db
      .prepare('SELECT result,active_task_id FROM sales_cases WHERE id=?')
      .bind(s.caseId)
      .first(),
  ).toEqual({ result: 'WON', active_task_id: null });
  expect(
    await f.db
      .prepare('SELECT kind,status,renewal_id FROM tasks WHERE id=?')
      .bind(s.taskId)
      .first(),
  ).toEqual({ kind: 'GENERAL', status: 'COMPLETED', renewal_id: null });
  expect(
    await f.db.prepare('SELECT end_date FROM policies WHERE id=?').bind(saved.policyId).first(),
  ).toEqual({ end_date: '2027-04-01' });
  expect(
    (
      await post(
        issue(s),
        { ...body, result: { ...body.result, policy: policyInput('new-key') } },
        key,
      )
    ).status,
  ).toBe(409);
  await expect(
    verifyOperationalRecovery(async (sql) => (await f.db.prepare(sql).all()).results),
  ).resolves.toBeUndefined();
  await expect(
    verifyOperationalRecovery(async (sql) =>
      sql.includes("action='sales.case.issue_policy' AND outcome")
        ? []
        : (await f.db.prepare(sql).all()).results,
    ),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
});
it('links an existing policy and requires a reason for a changed premium', async () => {
  const { s, acceptance } = await accepted();
  const p = await data<{ id: string; version: number }>(
    await post('/api/policies', policyInput('link', '13000.50')),
    201,
  );
  const body = {
    ...issueBody(s, acceptance, 'unused'),
    result: { kind: 'LINK_POLICY', policyId: p.id, expectedPolicyVersion: p.version },
  };
  const missing = await post(issue(s), body);
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({
    error: { code: 'POLICY_DIFFERENCE_REASON_REQUIRED' },
  });
  const result = await data<Issued>(
    await post(issue(s), { ...body, differenceReasonCode: 'PREMIUM_CHANGED' }),
  );
  expect(result).toMatchObject({ policyId: p.id, policyVersion: p.version, createdPolicy: false });
});
it('rejects a revoked acceptance and another employee’s private task, and permits an explicit no-quote source', async () => {
  const { s, acceptance } = await accepted();
  await event(s, 'ACCEPTANCE_REVOKED');
  expect(await data(await get(base(s.caseId) + '/issue-price-options'))).toEqual({
    options: [],
    nextAfter: null,
  });
  expect((await get(base(s.caseId) + '/issue-context', 'price-events-staff')).status).toBe(404);
  const body = issueBody(s, acceptance, 'revoked');
  const revoked = await post(issue(s), body);
  expect(revoked.status).toBe(409);
  expect(await revoked.json()).toMatchObject({ error: { code: 'PRICE_ACCEPTANCE_INVALID' } });
  const direct = {
    ...body,
    source: { kind: 'NO_QUOTE', reason: 'Müşteri poliçeyi doğrudan onayladı' },
  };
  expect((await post(issue(s), direct, crypto.randomUUID(), 'price-events-staff')).status).toBe(
    404,
  );
  expect((await post(issue(s), direct, crypto.randomUUID(), 'price-events-foreign')).status).toBe(
    404,
  );
  expect((await post(issue(s), direct)).status).toBe(201);
});
it('rolls back the policy, result, and GENERAL Task when the final audit fails', async () => {
  const { s, acceptance } = await accepted();
  await f.db
    .prepare(
      "CREATE TRIGGER issue_audit_fault BEFORE INSERT ON audit_events WHEN NEW.action='sales.case.issue_policy' BEGIN SELECT RAISE(ABORT,'TEST_ISSUE_AUDIT_FAULT'); END",
    )
    .run();
  try {
    expect((await post(issue(s), issueBody(s, acceptance, 'rollback'))).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER issue_audit_fault').run();
  }
  expect(
    await f.db.prepare("SELECT id FROM policies WHERE policy_number='NEW-ISSUE-rollback'").first(),
  ).toBeNull();
  expect(
    await f.db
      .prepare('SELECT receipt_id FROM sales_case_policy_results WHERE case_id=?')
      .bind(s.caseId)
      .first(),
  ).toBeNull();
  expect(await f.db.prepare('SELECT status FROM tasks WHERE id=?').bind(s.taskId).first()).toEqual({
    status: 'OPEN',
  });
});

it('corrects a wrong issuance once after own-password reauth, keeps evidence, and can link the policy again', async () => {
  const { s, acceptance } = await accepted();
  const issueKey = crypto.randomUUID();
  const original = await data<Issued>(
    await post(issue(s), issueBody(s, acceptance, 'correct'), issueKey),
    201,
  );
  const contextPath = base(s.caseId) + '/won-correction-context';
  const { policyNumber, ...expected } = await data<Record<string, unknown>>(await get(contextPath));
  expect(policyNumber).toBe('NEW-ISSUE-correct');
  expect((await get(contextPath, 'price-events-staff')).status).toBe(404);
  expect((await get(contextPath, 'price-events-foreign')).status).toBe(404);
  const command = {
    ...expected,
    replacementDueAt: '2027-03-10T06:00:00.000Z',
    notes: 'Yanlış çalışma kapatıldı.',
  };
  const secure = '/secure' + base(s.caseId);
  const grantPath = secure + '/won-correction-grants';
  const correctionPath = secure + '/correct-won';
  expect((await post(grantPath, command)).status).toBe(401);
  const reauth = await post('/api/auth/reauth', {
    password: 'synthetic fixture permanent passphrase',
  });
  expect(reauth.status).toBe(200);
  cookies['price-events-owner'] = reauth.headers.get('Set-Cookie')!.split(';')[0]!;
  const grantKey = crypto.randomUUID();
  type Grant = { grantId: string; grantEvidenceToken: string; expiresAt: string };
  const grant = await data<Grant>(await post(grantPath, command, grantKey), 201);
  expect(await data<Grant>(await post(grantPath, command, grantKey))).toEqual(grant);
  expect((await post(grantPath, { ...command, notes: 'Farklı işlem' }, grantKey)).status).toBe(409);
  const mutation = {
    command,
    grantId: grant.grantId,
    grantEvidenceToken: grant.grantEvidenceToken,
  };
  expect(
    (
      await post(correctionPath, {
        ...mutation,
        command: { ...command, notes: 'Gerekçe değişti.' },
      })
    ).status,
  ).toBe(403);
  await f.db
    .prepare(
      `CREATE TRIGGER fail_sales_won_correction_audit BEFORE INSERT ON audit_events
    WHEN NEW.action='sales.case.correct_won' BEGIN SELECT RAISE(ABORT,'TEST_AUDIT_FAILURE'); END;`,
    )
    .run();
  try {
    expect((await post(correctionPath, mutation)).status).toBe(500);
    expect(
      await f.db
        .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
        .bind(grant.grantId)
        .first(),
    ).toEqual({ status: 'ISSUED' });
    expect(
      await f.db
        .prepare('SELECT result,active_task_id FROM sales_cases WHERE id=?')
        .bind(s.caseId)
        .first(),
    ).toEqual({ result: 'WON', active_task_id: null });
  } finally {
    await f.db.exec('DROP TRIGGER fail_sales_won_correction_audit');
  }
  const correctedKey = crypto.randomUUID();
  const [left, right] = await Promise.all([
    post(correctionPath, mutation, correctedKey),
    post(correctionPath, mutation, correctedKey),
  ]);
  type Corrected = {
    operationId: string;
    caseVersion: number;
    taskId: string;
    taskVersion: number;
  };
  const corrected = await data<Corrected>(left);
  expect(await data(right)).toEqual(corrected);
  expect((await post(correctionPath, mutation)).status).toBe(409);
  const readback = await f.request(
    base(s.caseId) + '/won-correction-operation',
    'GET',
    cookies['price-events-owner'],
    undefined,
    undefined,
    { 'idempotency-key': correctedKey },
  );
  expect(await data(readback)).toEqual(corrected);
  expect(
    await data<Issued>(await post(issue(s), issueBody(s, acceptance, 'correct'), issueKey)),
  ).toEqual(original);
  const proof = await f.db
    .prepare(
      `SELECT s.result,s.active_task_id,prior.status old_status,t.status new_status,
    p.version, g.status grant_status FROM sales_cases s
    JOIN sales_case_policy_results w ON w.agency_id=s.agency_id AND w.case_id=s.id
    JOIN policies p ON p.agency_id=w.agency_id AND p.id=w.policy_id
    JOIN tasks prior ON prior.agency_id=w.agency_id AND prior.id=w.task_id
    JOIN tasks t ON t.agency_id=s.agency_id AND t.id=s.active_task_id
    JOIN sensitive_action_grants g ON g.consumed_operation_id=?
    WHERE s.id=?`,
    )
    .bind(corrected.operationId, s.caseId)
    .first();
  expect(proof).toEqual({
    result: 'OPEN',
    active_task_id: corrected.taskId,
    old_status: 'COMPLETED',
    new_status: 'OPEN',
    version: original.policyVersion,
    grant_status: 'CONSUMED',
  });
  const receipt = await f.db
    .prepare('SELECT response_body FROM operation_receipts WHERE id=?')
    .bind(corrected.operationId)
    .first<{ response_body: string }>();
  expect(receipt?.response_body).not.toContain(grant.grantEvidenceToken);
  const next = await data<Issued>(
    await post(issue(s), {
      expectedCaseVersion: corrected.caseVersion,
      expectedTaskId: corrected.taskId,
      expectedTaskVersion: corrected.taskVersion,
      source: { kind: 'NO_QUOTE', reason: 'Poliçe yeniden doğru çalışmaya bağlandı.' },
      result: {
        kind: 'LINK_POLICY',
        policyId: original.policyId,
        expectedPolicyVersion: original.policyVersion,
      },
    }),
  );
  expect(next.policyId).toBe(original.policyId);
  expect(next.operationId).not.toBe(original.operationId);
  await verifyOperationalRecovery(async (query) => (await f.db.prepare(query).all()).results);
  await expect(
    verifyOperationalRecovery(async (query) => {
      const rows = (await f.db.prepare(query).all()).results;
      return query.includes("action='sales.case.correct_won' AND outcome='SUCCESS'") ? [] : rows;
    }),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
}, 60000);
