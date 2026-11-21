// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import type { RenewalWonResult } from '../src/server/renewals/commands';
import type { WonPriceOptions } from '../src/shared/renewal-won-price';
import { verifyRenewalWonPriceRecovery } from '../scripts/recovery/renewal-won-price-proof';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  f = await localAuthFixture();
  for (const who of ['cycle-owner']) {
    await f.seed(who, who === 'cycle-staff' ? 'MEMBER' : 'OWNER');
    cookies[who] = (await f.session(who)).cookie;
  }
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

async function accepted(s: Awaited<ReturnType<typeof create>>) {
  const root = `/api/sales-cases/${s.caseId}`;
  const price = await data<{ revisionId: string; caseVersion: number }>(
    await post(root + '/prices', {
      expectedCaseVersion: 1,
      insurerId: 'cycle-i',
      amountMinor: 12345,
      currency: 'TRY',
      termsNote: null,
      offeredPeriod: null,
    }),
    201,
  );
  const event = (expectedCaseVersion: number, event: string) =>
    post(root + '/price-events', {
      expectedCaseVersion,
      revisionId: price.revisionId,
      event,
      occurredAt: new Date().toISOString(),
      expectedTaskId: s.taskId,
      expectedTaskVersion: 1,
    });
  const shared = await data<{ caseVersion: number }>(await event(price.caseVersion, 'SHARED'), 201);
  const result = await data<{ caseVersion: number; eventId: string }>(
    await event(shared.caseVersion, 'CUSTOMER_ACCEPTED'),
    201,
  );
  return {
    selection: {
      kind: 'PRICE_REVISION',
      caseId: s.caseId,
      expectedCaseVersion: result.caseVersion,
      revisionId: price.revisionId,
      acceptanceEventId: result.eventId,
    },
    event,
  };
}
async function policy(suffix: string, amount = '123.45') {
  return data<{ id: string; version: number }>(
    await post('/api/policies', policyInput(suffix, amount)),
    201,
  );
}
function policyInput(suffix: string, amount = '123.45') {
  return {
    customerId: 'cycle-c',
    insurerId: 'cycle-i',
    productId: 'cycle-p',
    branchId: 'cycle-b',
    paymentMethodId: 'cycle-pay',
    assigneeMembershipId: 'membership-cycle-owner',
    policyNumber: 'LW-' + suffix,
    startDate: '2027-01-21',
    endDate: '2027-04-20',
    grossPremium: amount,
    currency: 'TRY',
    installmentCount: null,
  };
}
function base(s: Awaited<ReturnType<typeof create>>) {
  return { expectedPrimaryTaskId: s.taskId, expectedRenewalVersion: 1, expectedTaskVersion: 1 };
}
const endpoint = (s: Awaited<ReturnType<typeof create>>) =>
  `/api/renewals/${s.renewalId}/close-won`;
async function options(renewalId: string) {
  const r = await f.request(
    `/api/renewals/${renewalId}/won-price-options`,
    'GET',
    cookies['cycle-owner'],
  );
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  return data<WonPriceOptions>(r);
}
it('creates the actual policy and terminal result in one batch and replays the exact accepted price', async () => {
  const s = await create(),
    { selection } = await accepted(s),
    key = crypto.randomUUID();
  const payload = {
    ...base(s),
    acceptedPriceSource: selection,
    result: { kind: 'CREATE_POLICY', policy: policyInput('create') },
  };
  expect(await options(s.renewalId)).toEqual({
    options: [
      {
        source: selection,
        insurerId: 'cycle-i',
        insurerName: 'Anadolu Sigorta',
        branchId: 'cycle-b',
        amountMinor: 12345,
        currency: 'TRY',
        startDate: null,
        endDate: null,
      },
    ],
    nextAfter: null,
  });
  const result = await data<RenewalWonResult>(await post(endpoint(s), payload, key), 201);
  expect(result.acceptedPriceEvidence).toEqual({ ...selection, policyId: result.createdPolicyId });
  expect(await data(await post(endpoint(s), payload, key))).toEqual(result);
  expect((await options(s.renewalId)).options).toEqual([]);
  expect(await f.db.prepare('SELECT status FROM tasks WHERE id=?').bind(s.taskId).first()).toEqual({
    status: 'COMPLETED',
  });
  expect(
    await f.db
      .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
      .bind(s.renewalId)
      .first(),
  ).toEqual({ state: 'WON' });
  expect(
    await f.db
      .prepare('SELECT end_date FROM policies WHERE id=?')
      .bind(result.createdPolicyId)
      .first(),
  ).toEqual({ end_date: '2027-04-20' });
  const query = async (sql: string) => (await f.db.prepare(sql).all()).results;
  await expect(verifyRenewalWonPriceRecovery(query)).resolves.toBeUndefined();
  await expect(
    verifyRenewalWonPriceRecovery(async (sql) =>
      sql.includes('FROM audit_events') ? [] : query(sql),
    ),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
});
it('links an existing policy and requires a reason for actual premium differences', async () => {
  const s = await create(),
    { selection } = await accepted(s),
    p = await policy('linked', '130.45');
  const payload = {
    ...base(s),
    acceptedPriceSource: selection,
    result: {
      kind: 'LINK_POLICY',
      newPolicyId: p.id,
      expectedPolicyVersion: p.version,
      allocatedNewPremiumMinor: 13045,
      currency: 'TRY',
    },
  };
  const rejected = await post(endpoint(s), payload);
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({
    error: { code: 'QUOTE_DIFFERENCE_REASON_REQUIRED' },
  });
  const result = await data<RenewalWonResult>(
    await post(endpoint(s), { ...payload, quoteDifferenceReasonCode: 'PREMIUM_CHANGED' }),
  );
  expect(result.acceptedPriceEvidence?.policyId).toBe(p.id);
});
it('rejects conflicting sources and revoked approvals, even with a fresh case version', async () => {
  const s = await create(),
    { selection, event } = await accepted(s);
  const payload = {
    ...base(s),
    acceptedPriceSource: selection,
    result: { kind: 'CREATE_POLICY', policy: policyInput('revoked') },
  };
  expect((await post(endpoint(s), { ...payload, acceptedQuoteVersionId: 'legacy' })).status).toBe(
    400,
  );
  const revoked = await data<{ caseVersion: number }>(
    await event(selection.expectedCaseVersion, 'ACCEPTANCE_REVOKED'),
    201,
  );
  expect((await options(s.renewalId)).options).toEqual([]);
  expect(
    (
      await post(endpoint(s), {
        ...payload,
        acceptedPriceSource: { ...selection, expectedCaseVersion: revoked.caseVersion },
      })
    ).status,
  ).toBe(409);
  expect(await f.db.prepare('SELECT status FROM tasks WHERE id=?').bind(s.taskId).first()).toEqual({
    status: 'OPEN',
  });
});
it('rolls policy, link, task and source evidence back on final audit failure', async () => {
  const s = await create(),
    { selection } = await accepted(s);
  await f.db
    .prepare(
      "CREATE TRIGGER test_price_won_fail BEFORE INSERT ON audit_events WHEN NEW.action='renewal.closed_won' BEGIN SELECT RAISE(ABORT,'TEST_WON_ROLLBACK'); END",
    )
    .run();
  try {
    const response = await post(endpoint(s), {
      ...base(s),
      acceptedPriceSource: selection,
      result: { kind: 'CREATE_POLICY', policy: policyInput('rollback') },
    });
    expect(response.status, await response.clone().text()).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER test_price_won_fail').run();
  }
  expect(
    await f.db.prepare("SELECT id FROM policies WHERE policy_number='LW-rollback'").first(),
  ).toBeNull();
  expect(
    await f.db
      .prepare('SELECT id FROM renewal_policy_links WHERE renewal_id=?')
      .bind(s.renewalId)
      .first(),
  ).toBeNull();
  expect(await f.db.prepare('SELECT status FROM tasks WHERE id=?').bind(s.taskId).first()).toEqual({
    status: 'OPEN',
  });
});
