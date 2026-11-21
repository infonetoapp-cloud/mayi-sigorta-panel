// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import {
  enableCompanyRegistration,
  registrationNumber,
} from './support/customer-registration-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type {
  CustomerDto,
  PolicyDto,
  PolicyAmendmentDto,
  PolicyExternalReferenceDto,
} from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  owner: string,
  ahmet: string,
  ayse: string,
  foreign: string,
  denied: string,
  path: string;
const amendment = {
  externalReference: 'ZEYL',
  effectiveDate: '2026-05-01',
  description: 'Tarihsel zeyil',
};
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function version() {
  return (await data<PolicyDto>(await f.request(path, 'GET', owner))).version;
}
async function send(section: string, body: unknown, cookie = owner, key = crypto.randomUUID()) {
  return f.request(path + '/' + section, 'POST', cookie, body, await f.csrf(cookie), {
    'idempotency-key': key,
  });
}
async function snapshot() {
  return JSON.stringify({
    p: (await f.db.prepare('SELECT * FROM policies ORDER BY id').all()).results,
    a: (await f.db.prepare('SELECT * FROM policy_amendments ORDER BY id').all()).results,
    x: (await f.db.prepare('SELECT * FROM policy_external_references ORDER BY id').all()).results,
    r: (await f.db.prepare('SELECT * FROM operation_receipts ORDER BY idempotency_key').all())
      .results,
    e: (await f.db.prepare("SELECT * FROM audit_events WHERE outcome='SUCCESS' ORDER BY id").all())
      .results,
  });
}
beforeAll(async () => {
  f = await localAuthFixture();
  async function login(id: string, type: 'OWNER' | 'MEMBER' = 'MEMBER', agency?: string) {
    const a = await f.seed(id, type, false, agency);
    if (['append-ahmet', 'append-ayse'].includes(id))
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
  owner = await login('append-owner', 'OWNER');
  await enableCompanyRegistration(f, 'membership-append-owner');
  ahmet = await login('append-ahmet');
  ayse = await login('append-ayse');
  foreign = await login('append-foreign', 'OWNER', 'append-foreign-agency');
  denied = await login('append-denied');
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('append-i','agency-auth-test','AP','Insurer')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('append-b','agency-auth-test','AP','Branch','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('append-p','agency-auth-test','append-i','append-b','AP','Product')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('append-pm','agency-auth-test','AP','Cash')",
    ),
  ]);
  const c = await data<CustomerDto>(
    await f.request(
      '/api/customers',
      'POST',
      owner,
      {
        type: 'COMPANY',
        companyTitle: 'Append Şirket',
        taxNumber: '9000000111',
        insurerNumber: registrationNumber('append-i'),
      },
      await f.csrf(owner),
      { 'idempotency-key': crypto.randomUUID() },
    ),
    201,
  );
  const p = await data<PolicyDto>(
    await f.request(
      '/api/policies',
      'POST',
      owner,
      {
        customerId: c.id,
        insurerId: 'append-i',
        branchId: 'append-b',
        productId: 'append-p',
        paymentMethodId: 'append-pm',
        policyNumber: 'APPEND-PERIOD',
        startDate: '2026-01-01',
        endDate: '2027-12-31',
        grossPremium: '10.00',
        currency: 'TRY',
        installmentCount: null,
      },
      await f.csrf(owner),
      { 'idempotency-key': crypto.randomUUID() },
    ),
    201,
  );
  path = '/api/policies/' + p.id;
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('appends positive negative zero and absent differences for shared actors without changing the original premium or period', async () => {
  for (const [index, value] of [
    '12.34',
    '-0.50',
    '0',
    null,
    '90071992547409.91',
    '-90071992547409.91',
  ].entries()) {
    const r = await data<PolicyAmendmentDto>(
      await send(
        'amendments',
        {
          ...amendment,
          externalReference: 'ZEYL-' + index,
          expectedVersion: await version(),
          ...(value === null ? {} : { premiumDifference: value, currency: 'TRY' }),
        },
        [owner, ahmet, ayse][index % 3],
      ),
      201,
    );
    expect(r.premiumDifferenceMinor).toBe(
      [1234, -50, 0, null, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER][index],
    );
  }
  const p = await data<PolicyDto>(await f.request(path, 'GET', owner));
  expect(p.grossPremiumMinor).toBe(1000);
  expect(p.endDate).toBe('2027-12-31');
  expect(p.status).toBe('ACTIVE');
});
it('rejects invalid paired/decimal/overflow/date/length fields without receipts audit or data changes', async () => {
  const before = await snapshot();
  for (const patch of [
    { premiumDifference: '1.00' },
    { currency: 'TRY' },
    { premiumDifference: '1,00', currency: 'TRY' },
    { premiumDifference: '+1.00', currency: 'TRY' },
    { premiumDifference: '1.234', currency: 'TRY' },
    { premiumDifference: '90071992547409.92', currency: 'TRY' },
    { premiumDifference: '-90071992547409.92', currency: 'TRY' },
    { premiumDifference: '0', currency: 'ZZZ' },
    { effectiveDate: '2026-02-30' },
    { description: 'x'.repeat(2001) },
    { externalReference: 'x'.repeat(201) },
  ])
    expect(
      (await send('amendments', { ...amendment, expectedVersion: await version(), ...patch })).ok,
    ).toBe(false);
  for (const fields of [
    { sourceNamespace: '', externalKey: 'valid' },
    { sourceNamespace: 'x'.repeat(101), externalKey: 'valid' },
    { sourceNamespace: 'valid', externalKey: '' },
    { sourceNamespace: 'valid', externalKey: 'x'.repeat(201) },
  ])
    expect(
      (await send('external-references', { ...fields, expectedVersion: await version() })).ok,
    ).toBe(false);
  expect(await snapshot()).toBe(before);
});
it('preserves exact create replays and backend reference uniqueness without duplicate success evidence', async () => {
  for (const section of ['amendments', 'external-references']) {
    const body = {
        expectedVersion: await version(),
        ...(section === 'amendments'
          ? { ...amendment, externalReference: 'EXACT-ZEYL' }
          : { sourceNamespace: 'synthetic', externalKey: 'EXACT-REF' }),
      },
      key = crypto.randomUUID();
    const first = await data<{ id: string }>(await send(section, body, owner, key), 201);
    const before = await snapshot();
    expect((await data<{ id: string }>(await send(section, body, owner, key), 201)).id).toBe(
      first.id,
    );
    expect(await snapshot()).toBe(before);
  }
  const before = await snapshot();
  expect(
    (
      await send('external-references', {
        expectedVersion: await version(),
        sourceNamespace: 'synthetic',
        externalKey: 'EXACT-REF',
      })
    ).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
});
it('allows only one concurrent append at the same parent CAS and rolls back the losing command evidence', async () => {
  const v = await version(),
    csrf = await f.csrf(owner);
  const beforeAudit = (await f.db
    .prepare("SELECT count(*) n FROM audit_events WHERE outcome='SUCCESS'")
    .first<{ n: number }>())!.n;
  const beforeRows = (await f.db
    .prepare('SELECT count(*) n FROM policy_external_references')
    .first<{ n: number }>())!.n;
  const beforeCount = (await f.db
    .prepare('SELECT count(*) n FROM operation_receipts')
    .first<{ n: number }>())!.n;
  const results = await Promise.all(
    ['A', 'B'].map((s) =>
      f.request(
        path + '/external-references',
        'POST',
        owner,
        { expectedVersion: v, sourceNamespace: 'concurrent', externalKey: s },
        csrf,
        { 'idempotency-key': crypto.randomUUID() },
      ),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await version()).toBe(v + 1);
  expect(
    (await f.db
      .prepare("SELECT count(*) n FROM audit_events WHERE outcome='SUCCESS'")
      .first<{ n: number }>())!.n,
  ).toBe(beforeAudit + 1);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM policy_external_references')
      .first<{ n: number }>())!.n,
  ).toBe(beforeRows + 1);
  expect(
    (await f.db.prepare('SELECT count(*) n FROM operation_receipts').first<{ n: number }>())!.n,
  ).toBe(beforeCount + 1);
  const before = await snapshot();
  expect((await send('amendments', { ...amendment, expectedVersion: v })).status).toBe(409);
  expect(await snapshot()).toBe(before);
});
it('keeps authorized historical reads after archive and rejects both new append commands', async () => {
  const csrf = await f.csrf(owner);
  await data(
    await f.request(
      path + '/archive',
      'POST',
      owner,
      { expectedVersion: await version(), reasonCode: 'HISTORICAL_RECORD' },
      csrf,
      { 'idempotency-key': crypto.randomUUID() },
    ),
  );
  const before = await snapshot();
  for (const actor of [owner, ahmet, ayse])
    for (const section of ['amendments', 'external-references']) {
      const rows = await data<PolicyAmendmentDto[] | PolicyExternalReferenceDto[]>(
        await f.request(path + '/' + section, 'GET', actor),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(
        (
          await send(
            section,
            {
              expectedVersion: await version(),
              ...(section === 'amendments'
                ? amendment
                : { sourceNamespace: 'new', externalKey: 'NO-WRITE' }),
            },
            actor,
          )
        ).ok,
      ).toBe(false);
    }
  expect(await snapshot()).toBe(before);
});
it('denies foreign missing-permission revoked-session and HEALTH access without protected data or successful effects', async () => {
  const denialBefore = await snapshot();
  for (const actor of [foreign, denied])
    for (const section of ['amendments', 'external-references']) {
      const r = await f.request(path + '/' + section, 'GET', actor);
      expect(r.status).toBe(actor === foreign ? 404 : 403);
      expect(await r.json()).not.toHaveProperty('data');
      expect(
        (
          await send(
            section,
            {
              expectedVersion: 1,
              ...(section === 'amendments'
                ? amendment
                : { sourceNamespace: 'denied', externalKey: 'NO' }),
            },
            actor,
          )
        ).ok,
      ).toBe(false);
    }
  expect(await snapshot()).toBe(denialBefore);
  const csrf = await f.csrf(ahmet),
    before = await snapshot();
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
    .bind(Date.now(), 'append-ahmet')
    .run();
  for (const section of ['amendments', 'external-references'])
    expect(
      (
        await f.request(
          path + '/' + section,
          'POST',
          ahmet,
          {
            expectedVersion: 1,
            ...(section === 'amendments'
              ? amendment
              : { sourceNamespace: 'denied', externalKey: 'NO' }),
          },
          csrf,
          { 'idempotency-key': crypto.randomUUID() },
        )
      ).status,
    ).toBe(401);
  expect(await snapshot()).toBe(before);
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('append-h','agency-auth-test','H','Health','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('append-hp','agency-auth-test','append-i','append-h','H','Health')",
    ),
    f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) SELECT 'append-health',agency_id,customer_id,insurer_id,'append-hp','append-h',payment_method_id,assignee_membership_id,'HIDDEN','HIDDEN',start_date,end_date,gross_premium_minor,currency FROM policies WHERE id=?",
      )
      .bind(path.split('/').at(-1)),
  ]);
  path = '/api/policies/append-health';
  const hbefore = await snapshot();
  for (const actor of [owner, ayse])
    for (const section of ['amendments', 'external-references']) {
      const r = await f.request(path + '/' + section, 'GET', actor);
      expect(r.status).toBe(403);
      expect(await r.json()).not.toHaveProperty('data');
      expect(
        (
          await send(
            section,
            {
              expectedVersion: 1,
              ...(section === 'amendments'
                ? amendment
                : { sourceNamespace: 'denied', externalKey: 'NO' }),
            },
            actor,
          )
        ).status,
      ).toBe(403);
    }
  expect(await snapshot()).toBe(hbefore);
});
