// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { CustomerDto, PolicyDto, PolicyDetailDto } from '../src/shared/types';
import { parseMoneyInput } from '../src/app/lib/monetary';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, ahmet: string, ayse: string, foreign: string, denied: string;
let individual: CustomerDto, company: CustomerDto, policy: PolicyDto;
const base = {
  insurerId: 'form-insurer',
  branchId: 'form-branch',
  productId: 'form-product',
  paymentMethodId: 'form-cash',
  policyNumber: 'FORM-CONTRACT',
  startDate: '2026-01-01',
  endDate: '2027-12-31',
  grossPremium: '1234.56',
  currency: 'TRY',
  installmentCount: null,
  status: 'ACTIVE',
};
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function send(
  path: string,
  method: string,
  body: unknown,
  cookie = owner,
  key = crypto.randomUUID(),
) {
  return f.request(path, method, cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}
async function login(id: string, type: 'OWNER' | 'MEMBER' = 'MEMBER', agency?: string) {
  const actor = await f.seed(id, type, false, agency);
  if (id === 'form-ahmet' || id === 'form-ayse')
    await f.db.batch(
      createOnboardingTemplateGrants('personel').map((g) =>
        f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), actor.membershipId, g.permission_code, g.scope),
      ),
    );
  const r = await f.request('/api/auth/login', 'POST', undefined, {
    email: actor.email,
    password: actor.password,
  });
  expect(r.status).toBe(200);
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
async function snapshot() {
  return JSON.stringify({
    policies: (await f.db.prepare('SELECT * FROM policies ORDER BY id').all()).results,
    receipts: (
      await f.db.prepare('SELECT * FROM operation_receipts ORDER BY idempotency_key').all()
    ).results,
    audits: (
      await f.db.prepare("SELECT * FROM audit_events WHERE outcome='SUCCESS' ORDER BY id").all()
    ).results,
  });
}
beforeAll(async () => {
  f = await localAuthFixture();
  owner = await login('form-owner', 'OWNER');
  ahmet = await login('form-ahmet');
  ayse = await login('form-ayse');
  denied = await login('form-denied');
  foreign = await login('form-foreign', 'OWNER', 'form-foreign-agency');
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('form-insurer','agency-auth-test','FORM','Form Sigortacı'),('form-other-insurer','agency-auth-test','OTHER','Diğer Sigortacı')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('form-branch','agency-auth-test','FORM','Form Branş','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('form-product','agency-auth-test','form-insurer','form-branch','FORM','Form Ürün')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('form-cash','agency-auth-test','CASH','Peşin',0,12),('form-card','agency-auth-test','CARD','Kart',1,6)",
    ),
  ]);
  individual = await data<CustomerDto>(
    await send('/api/customers', 'POST', {
      type: 'INDIVIDUAL',
      firstName: 'Bireysel',
      lastName: 'Müşteri',
    }),
    201,
  );
  company = await data<CustomerDto>(
    await send('/api/customers', 'POST', { type: 'COMPANY', companyTitle: 'Kurumsal Müşteri' }),
    201,
  );
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('UX003 persists identical minor values from all three employee formats, with exact replay and unchanged strict backend input', async () => {
  for (const [index, value] of ['12500,50', '12500.50', '12.500,50'].entries()) {
    const actor = index === 1 ? ahmet : owner,
      key = crypto.randomUUID(),
      body = {
        ...base,
        customerId: individual.id,
        policyNumber: `UX003-${index}`,
        grossPremium: parseMoneyInput(value)!.canonical,
      };
    const created = await data<PolicyDto>(
      await send('/api/policies', 'POST', body, actor, key),
      201,
    );
    expect(created.grossPremiumMinor).toBe(1250050);
    expect(
      await f.db
        .prepare('SELECT gross_premium_minor AS amount,currency FROM policies WHERE id=?')
        .bind(created.id)
        .first(),
    ).toEqual({ amount: 1250050, currency: 'TRY' });
    const before = await snapshot();
    expect(
      (await data<PolicyDto>(await send('/api/policies', 'POST', body, actor, key), 201)).id,
    ).toBe(created.id);
    expect(await snapshot()).toBe(before);
  }
  const before = await snapshot();
  expect(
    (
      await send('/api/policies', 'POST', {
        ...base,
        customerId: individual.id,
        policyNumber: 'UX003-RAW',
        grossPremium: '12500,50',
      })
    ).status,
  ).toBe(500); // Existing backend parser error classification is unchanged; no persistence occurs.
  expect(await snapshot()).toBe(before);
});
it('UX003 canonical money preserves CAS and denied-write financial persistence', async () => {
  const created = await data<PolicyDto>(
    await send('/api/policies', 'POST', {
      ...base,
      customerId: company.id,
      policyNumber: 'UX003-CAS',
    }),
    201,
  );
  const body = {
    expectedVersion: created.version,
    grossPremium: parseMoneyInput('12.500,50')!.canonical,
  };
  await data<PolicyDto>(await send(`/api/policies/${created.id}`, 'PATCH', body));
  const before = await snapshot();
  expect(
    (await send(`/api/policies/${created.id}`, 'PATCH', { ...body, grossPremium: '1.00' })).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
  expect(
    (
      await send(
        '/api/policies',
        'POST',
        {
          ...base,
          customerId: company.id,
          policyNumber: 'UX003-DENIED',
          grossPremium: body.grossPremium,
        },
        denied,
      )
    ).status,
  ).toBe(403);
  expect(await snapshot()).toBe(before);
});
it('creates individual/company periods for OWNER and shared employees with exact premium and installment contracts', async () => {
  for (const [index, actor] of [owner, ahmet, ayse].entries()) {
    const created = await data<PolicyDto>(
      await send(
        '/api/policies',
        'POST',
        {
          ...base,
          customerId: index === 1 ? company.id : individual.id,
          policyNumber: `FORM-${index}`,
          ...(index === 1
            ? { paymentMethodId: 'form-card', installmentCount: 6, currency: 'EUR' }
            : {}),
        },
        actor,
      ),
      201,
    );
    expect(created.grossPremiumMinor).toBe(123456);
    expect(created.customerId).toBe(index === 1 ? company.id : individual.id);
    expect(created.installmentCount).toBe(index === 1 ? 6 : null);
    if (!index) policy = created;
  }
});
it('keeps create exact replay and renewal initialization idempotent without creating another period', async () => {
  const date = (delta: number) =>
    new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
  const body = {
      ...base,
      customerId: individual.id,
      policyNumber: 'FORM-REPLAY',
      startDate: date(-360),
      endDate: date(5),
    },
    key = crypto.randomUUID();
  const first = await data<PolicyDto>(await send('/api/policies', 'POST', body, owner, key), 201);
  const before = await snapshot();
  const replay = await data<PolicyDto>(await send('/api/policies', 'POST', body, owner, key), 201);
  expect(replay.id).toBe(first.id);
  expect(await snapshot()).toBe(before);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM renewal_opportunities WHERE expiring_policy_id=?')
      .bind(first.id)
      .first<{ n: number }>())!.n,
  ).toBe(1);
});
it('edits only requested fields, preserves association, rejects stale CAS and safely replays PATCH', async () => {
  const path = '/api/policies/' + policy.id,
    key = crypto.randomUUID(),
    body = { expectedVersion: policy.version, policyNumber: 'FORM-EDITED' };
  const updated = await data<PolicyDto>(await send(path, 'PATCH', body, ayse, key));
  expect(updated.customerId).toBe(individual.id);
  expect(updated.grossPremiumMinor).toBe(policy.grossPremiumMinor);
  const before = await snapshot();
  expect(
    (await send(path, 'PATCH', { expectedVersion: policy.version, grossPremium: '10.00' })).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
  expect((await data<PolicyDto>(await send(path, 'PATCH', body, ayse, key))).version).toBe(
    updated.version,
  );
  expect(await snapshot()).toBe(before);
});
it('rejects invalid premium/currency/dependencies/installments without successful effects and preserves inactive catalog references on a basic edit', async () => {
  const before = await snapshot();
  for (const patch of [
    { grossPremium: '1,23' },
    { grossPremium: '90071992547409.92' },
    { currency: 'ZZZ' },
    { insurerId: 'form-other-insurer' },
    { installmentCount: 2 },
    { paymentMethodId: 'form-card', installmentCount: null },
    { paymentMethodId: 'form-card', installmentCount: 7 },
  ])
    expect(
      (await send('/api/policies', 'POST', { ...base, customerId: company.id, ...patch })).ok,
    ).toBe(false);
  expect(await snapshot()).toBe(before);
  await f.db
    .prepare(
      "UPDATE insurance_products SET status='INACTIVE',version=version+1 WHERE id='form-product'",
    )
    .run();
  const current = await data<PolicyDetailDto>(
    await f.request('/api/policies/' + policy.id, 'GET', owner),
  );
  const edited = await data<PolicyDto>(
    await send('/api/policies/' + policy.id, 'PATCH', {
      expectedVersion: current.version,
      grossPremium: '90071992547409.91',
    }),
  );
  expect(edited.grossPremiumMinor).toBe(Number.MAX_SAFE_INTEGER);
  expect(edited.productId).toBe('form-product');
  await f.db
    .prepare(
      "UPDATE insurance_products SET status='ACTIVE',version=version+1 WHERE id='form-product'",
    )
    .run();
});
it('rejects archived-policy edits and new policies for archived customers atomically', async () => {
  const current = await data<PolicyDetailDto>(
    await f.request('/api/policies/' + policy.id, 'GET', owner),
  );
  await data(
    await send('/api/policies/' + policy.id + '/archive', 'POST', {
      expectedVersion: current.version,
      reasonCode: 'HISTORICAL_RECORD',
    }),
  );
  const archived = await data<PolicyDetailDto>(
    await f.request('/api/policies/' + policy.id, 'GET', owner),
  );
  let before = await snapshot();
  expect(
    (
      await send('/api/policies/' + policy.id, 'PATCH', {
        expectedVersion: archived.version,
        policyNumber: 'NO-ARCHIVED-EDIT',
      })
    ).ok,
  ).toBe(false);
  expect(await snapshot()).toBe(before);
  const empty = await data<CustomerDto>(
    await send('/api/customers', 'POST', { type: 'COMPANY', companyTitle: 'Arşivli Origin' }),
    201,
  );
  await data(
    await send('/api/customers/' + empty.id + '/archive', 'POST', {
      expectedVersion: empty.version,
      reasonCode: 'NO_LONGER_ACTIVE',
    }),
  );
  before = await snapshot();
  expect(
    (
      await send('/api/policies', 'POST', {
        ...base,
        customerId: empty.id,
        policyNumber: 'NO-ARCHIVED-CREATE',
      })
    ).ok,
  ).toBe(false);
  expect(await snapshot()).toBe(before);
});
it('denies ungranted/foreign/revoked mutations without evidence or customer disclosure', async () => {
  const before = await snapshot();
  for (const [actor, status] of [
    [foreign, 404],
    [denied, 403],
  ] as const)
    expect(
      (
        await send(
          '/api/policies/' + policy.id,
          'PATCH',
          { expectedVersion: 1, policyNumber: 'DENIED' },
          actor,
        )
      ).status,
    ).toBe(status);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
    .bind(Date.now(), 'form-ahmet')
    .run();
  expect((await f.request('/api/policies/' + policy.id, 'GET', ahmet)).status).toBe(401);
  expect(await snapshot()).toBe(before);
});
it('requires explicit sensitive permissions for HEALTH creation and editing, including OWNER', async () => {
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('form-health','agency-auth-test','HEALTH','Health','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('form-health-product','agency-auth-test','form-insurer','form-health','HEALTH','Health')",
    ),
    f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('form-health-policy','agency-auth-test',?,'form-insurer','form-health-product','form-health','form-cash','membership-form-owner','HEALTH-PROTECTED','HEALTHPROTECTED','2026-01-01','2026-12-31',100,'TRY')",
      )
      .bind(individual.id),
  ]);
  const before = await snapshot();
  for (const actor of [owner, ayse]) {
    expect(
      (
        await send(
          '/api/policies',
          'POST',
          {
            ...base,
            customerId: company.id,
            branchId: 'form-health',
            productId: 'form-health-product',
            policyNumber: 'HEALTH-DENIED',
          },
          actor,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          '/api/policies/form-health-policy',
          'PATCH',
          { expectedVersion: 1, grossPremium: '10.00' },
          actor,
        )
      ).status,
    ).toBe(403);
    const read = await f.request('/api/policies/form-health-policy', 'GET', actor);
    expect(read.status).toBe(403);
    expect(await read.json()).not.toHaveProperty('data');
  }
  expect(await snapshot()).toBe(before);
});
