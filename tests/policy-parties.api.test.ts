// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import {
  enableCompanyRegistration,
  registrationNumber,
  seedRegistrationInsurer,
} from './support/customer-registration-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { CustomerDto, PolicyDto, PolicyPartyDto } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  owner: string,
  ahmet: string,
  ayse: string,
  foreign: string,
  denied: string,
  path: string;
let customer: CustomerDto, party: PolicyPartyDto;
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function send(suffix: string, body: unknown, actor = owner, key = crypto.randomUUID()) {
  return f.request(path + suffix, 'POST', actor, body, await f.csrf(actor), {
    'idempotency-key': key,
  });
}
async function version() {
  return (await data<PolicyDto>(await f.request(path, 'GET', owner))).version;
}
async function snapshot() {
  return JSON.stringify({
    p: (await f.db.prepare('SELECT * FROM policies ORDER BY id').all()).results,
    pp: (await f.db.prepare('SELECT * FROM policy_parties ORDER BY id').all()).results,
    r: (await f.db.prepare('SELECT * FROM operation_receipts ORDER BY idempotency_key').all())
      .results,
    a: (await f.db.prepare("SELECT * FROM audit_events WHERE outcome='SUCCESS' ORDER BY id").all())
      .results,
  });
}
beforeAll(async () => {
  f = await localAuthFixture();
  async function login(id: string, type: 'OWNER' | 'MEMBER' = 'MEMBER', agency?: string) {
    const a = await f.seed(id, type, false, agency);
    if (['parties-ahmet', 'parties-ayse'].includes(id))
      await f.db.batch(
        createOnboardingTemplateGrants('personel').map((g) =>
          f.db
            .prepare(
              'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
            )
            .bind(crypto.randomUUID(), a.membershipId, g.permission_code, g.scope),
        ),
      );
    const r = await f.request('/api/auth/login', 'POST', undefined, {
      email: a.email,
      password: a.password,
    });
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie')!.split(';')[0]!;
  }
  owner = await login('parties-owner', 'OWNER');
  await enableCompanyRegistration(f, 'membership-parties-owner');
  ahmet = await login('parties-ahmet');
  ayse = await login('parties-ayse');
  foreign = await login('parties-foreign', 'OWNER', 'foreign-parties');
  await seedRegistrationInsurer(f.db, 'foreign-parties', 'foreign-party-i');
  denied = await login('parties-denied');
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('party-i','agency-auth-test','P','Insurer')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('party-b','agency-auth-test','P','Branch','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('party-p','agency-auth-test','party-i','party-b','P','Product')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('party-pm','agency-auth-test','P','Cash')",
    ),
  ]);
  async function post(url: string, body: unknown) {
    return f.request(url, 'POST', owner, body, await f.csrf(owner), {
      'idempotency-key': crypto.randomUUID(),
    });
  }
  customer = await data<CustomerDto>(
    await post('/api/customers', {
      type: 'INDIVIDUAL',
      firstName: 'Taraf',
      lastName: 'Müşteri',
      insurerNumber: registrationNumber('party-i'),
    }),
    201,
  );
  const p = await data<PolicyDto>(
    await post('/api/policies', {
      customerId: customer.id,
      insurerId: 'party-i',
      branchId: 'party-b',
      productId: 'party-p',
      paymentMethodId: 'party-pm',
      policyNumber: 'PARTY-POLICY',
      startDate: '2026-01-01',
      endDate: '2027-12-31',
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
    }),
    201,
  );
  path = '/api/policies/' + p.id;
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('creates insured and beneficiary using parent CAS and denies stale parent version without effects', async () => {
  const original = await version();
  party = await data<PolicyPartyDto>(
    await send(
      '/parties',
      { expectedVersion: original, customerId: customer.id, role: 'INSURED' },
      ahmet,
    ),
    201,
  );
  expect(party.customerId).toBe(customer.id);
  expect(party.version).toBe(1);
  expect(await version()).toBe(original + 1);
  const before = await snapshot();
  expect(
    (
      await send('/parties', {
        expectedVersion: original,
        customerId: customer.id,
        role: 'BENEFICIARY',
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
  const beneficiary = await data<PolicyPartyDto>(
    await send(
      '/parties',
      { expectedVersion: await version(), customerId: customer.id, role: 'BENEFICIARY' },
      ayse,
    ),
    201,
  );
  expect(beneficiary.role).toBe('BENEFICIARY');
});
it('uses party CAS for deactivation, not the newer policy version, and preserves inactive history and exact replay', async () => {
  const before = await snapshot();
  expect(
    (await send('/parties/' + party.id + '/deactivate', { expectedVersion: await version() }))
      .status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
  const key = crypto.randomUUID(),
    body = { expectedVersion: party.version };
  await data<PolicyPartyDto>(await send('/parties/' + party.id + '/deactivate', body, ayse, key));
  const after = await snapshot();
  await data(await send('/parties/' + party.id + '/deactivate', body, ayse, key));
  expect(await snapshot()).toBe(after);
  for (const actor of [owner, ahmet, ayse]) {
    const items = await data<PolicyPartyDto[]>(await f.request(path + '/parties', 'GET', actor));
    expect(items.map((p) => [p.role, p.status])).toEqual([
      ['INSURED', 'INACTIVE'],
      ['BENEFICIARY', 'ACTIVE'],
    ]);
    expect(items[0]).not.toHaveProperty('identityValue');
  }
});
it('reconciles exact create replay without duplicate rows or evidence', async () => {
  const body = { expectedVersion: await version(), customerId: customer.id, role: 'INSURED' },
    key = crypto.randomUUID();
  const first = await data<PolicyPartyDto>(await send('/parties', body, owner, key), 201);
  const before = await snapshot();
  const retry = await data<PolicyPartyDto>(await send('/parties', body, owner, key), 201);
  expect(retry.id).toBe(first.id);
  expect(await snapshot()).toBe(before);
  party = first;
});
it('rejects inaccessible/missing/archived customers without effects', async () => {
  const before = await snapshot();
  for (const id of ['missing', 'foreign-customer'])
    expect(
      (
        await send('/parties', {
          expectedVersion: await version(),
          customerId: id,
          role: 'INSURED',
        })
      ).ok,
    ).toBe(false);
  expect(await snapshot()).toBe(before);
  const result = await f.request(
    '/api/customers',
    'POST',
    owner,
    {
      type: 'COMPANY',
      companyTitle: 'Archived party',
      taxNumber: '9000000115',
      insurerNumber: registrationNumber('party-i'),
    },
    await f.csrf(owner),
    { 'idempotency-key': crypto.randomUUID() },
  );
  const c = await data<CustomerDto>(result, 201);
  await data(
    await f.request(
      '/api/customers/' + c.id + '/archive',
      'POST',
      owner,
      { expectedVersion: c.version, reasonCode: 'HISTORICAL_RECORD' },
      await f.csrf(owner),
      { 'idempotency-key': crypto.randomUUID() },
    ),
  );
  const archivedBefore = await snapshot();
  expect(
    (
      await send('/parties', {
        expectedVersion: await version(),
        customerId: c.id,
        role: 'INSURED',
      })
    ).ok,
  ).toBe(false);
  expect(await snapshot()).toBe(archivedBefore);
});
it('keeps archived policy parties readable but rejects both new mutations', async () => {
  const foreignCustomer = await data<CustomerDto>(
    await f.request(
      '/api/customers',
      'POST',
      foreign,
      {
        type: 'INDIVIDUAL',
        firstName: 'Foreign',
        lastName: 'Hidden',
        insurerNumber: registrationNumber('foreign-party-i'),
      },
      await f.csrf(foreign),
      { 'idempotency-key': crypto.randomUUID() },
    ),
    201,
  );
  const rejectionBefore = await snapshot();
  expect(
    (
      await send('/parties', {
        expectedVersion: await version(),
        customerId: foreignCustomer.id,
        role: 'INSURED',
      })
    ).ok,
  ).toBe(false);
  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-parties-ayse' AND permission_code='customer.read'",
    )
    .run();
  expect((await f.request('/api/customers/' + customer.id, 'GET', ayse)).status).toBe(404);
  expect(
    (
      await send(
        '/parties',
        { expectedVersion: await version(), customerId: customer.id, role: 'BENEFICIARY' },
        ayse,
      )
    ).ok,
  ).toBe(false);
  expect(await snapshot()).toBe(rejectionBefore);
  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-parties-ayse' AND permission_code='customer.read'",
    )
    .run();
  await data(
    await send('/archive', { expectedVersion: await version(), reasonCode: 'HISTORICAL_RECORD' }),
  );
  const before = await snapshot();
  for (const actor of [owner, ahmet, ayse]) {
    expect(
      (
        await send(
          '/parties',
          { expectedVersion: await version(), customerId: customer.id, role: 'INSURED' },
          actor,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await send(
          '/parties/' + party.id + '/deactivate',
          { expectedVersion: party.version },
          actor,
        )
      ).ok,
    ).toBe(false);
    expect((await f.request(path + '/parties', 'GET', actor)).status).toBe(200);
  }
  expect(await snapshot()).toBe(before);
});
it('denies foreign/ungranted/revoked actors and HEALTH reads/writes with no evidence', async () => {
  const before = await snapshot();
  for (const actor of [foreign, denied]) {
    expect(
      (
        await send(
          '/parties',
          { expectedVersion: 1, customerId: customer.id, role: 'INSURED' },
          actor,
        )
      ).ok,
    ).toBe(false);
    const r = await f.request(path + '/parties', 'GET', actor);
    expect(r.status).toBe(actor === foreign ? 404 : 403);
    expect(await r.json()).not.toHaveProperty('data');
  }
  expect(await snapshot()).toBe(before);
  const revokedCsrf = await f.csrf(ahmet);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
    .bind(Date.now(), 'parties-ahmet')
    .run();
  expect((await f.request(path + '/parties', 'GET', ahmet)).status).toBe(401);
  for (const [suffix, body] of [
    ['/parties', { expectedVersion: 1, customerId: customer.id, role: 'INSURED' }],
    ['/parties/' + party.id + '/deactivate', { expectedVersion: party.version }],
  ] as const) {
    expect(
      (
        await f.request(path + suffix, 'POST', ahmet, body, revokedCsrf, {
          'idempotency-key': crypto.randomUUID(),
        })
      ).status,
    ).toBe(401);
  }
  expect(await snapshot()).toBe(before);
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('party-health','agency-auth-test','H','Health','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('party-hp','agency-auth-test','party-i','party-health','H','Health')",
    ),
    f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('party-hpol','agency-auth-test',?,'party-i','party-hp','party-health','party-pm','membership-parties-owner','HIDDEN','HIDDEN','2026-01-01','2027-12-31',100,'TRY')",
      )
      .bind(customer.id),
  ]);
  const healthBefore = await snapshot(),
    normal = path;
  path = '/api/policies/party-hpol';
  for (const actor of [owner, ayse]) {
    expect(
      (
        await send(
          '/parties/' + party.id + '/deactivate',
          { expectedVersion: party.version },
          actor,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          '/parties',
          { expectedVersion: 1, customerId: customer.id, role: 'INSURED' },
          actor,
        )
      ).status,
    ).toBe(403);
    const r = await f.request(path + '/parties', 'GET', actor);
    expect(r.status).toBe(403);
    expect(await r.json()).not.toHaveProperty('data');
  }
  path = normal;
  expect(await snapshot()).toBe(healthBefore);
});
