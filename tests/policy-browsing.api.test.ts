// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { interceptFinalRead } from './support/intercept-final-read';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type {
  PolicyDto,
  PolicyDetailDto,
  PolicyListResponseData,
  CustomerDto,
} from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let cookie: string;
let customer: CustomerDto, insured: CustomerDto, policies: PolicyDto[];
let ahmet: string, ayse: string, foreign: string, denied: string;
async function login(id: string, type: 'OWNER' | 'MEMBER' = 'MEMBER', agencyId?: string) {
  const actor = await f.seed(id, type, false, agencyId);
  if (id === 'browse-ahmet' || id === 'browse-ayse')
    for (const grant of createOnboardingTemplateGrants('personel'))
      await f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), actor.membershipId, grant.permission_code, grant.scope)
        .run();
  const result = await f.request('/api/auth/login', 'POST', undefined, {
    email: actor.email,
    password: actor.password,
  });
  expect(result.status).toBe(200);
  return result.headers.get('set-cookie')!.split(';')[0]!;
}
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}
async function post(path: string, body: unknown, key = crypto.randomUUID()) {
  return f.request(path, 'POST', cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}
beforeAll(async () => {
  f = await localAuthFixture();
  cookie = await login('policy-reader', 'OWNER');
  ahmet = await login('browse-ahmet');
  ayse = await login('browse-ayse');
  denied = await login('browse-denied');
  foreign = await login('browse-foreign', 'OWNER', 'foreign-policy-agency');
  const agency = 'agency-auth-test';
  await f.db.batch([
    f.db
      .prepare('INSERT INTO insurers(id,agency_id,code,name) VALUES(?,?,?,?)')
      .bind('browse-insurer', agency, 'BROWSE', 'Yetkili Sigortacı'),
    f.db
      .prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES(?,?,?,?,'GENERAL')",
      )
      .bind('browse-branch', agency, 'BROWSE', 'Genel Branş'),
    f.db
      .prepare(
        'INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES(?,?,?,?,?,?)',
      )
      .bind('browse-product', agency, 'browse-insurer', 'browse-branch', 'BROWSE', 'Genel Ürün'),
    f.db
      .prepare('INSERT INTO payment_methods(id,agency_id,code,name) VALUES(?,?,?,?)')
      .bind('browse-payment', agency, 'BROWSE', 'Peşin'),
  ]);
  customer = await data<CustomerDto>(
    await post('/api/customers', { type: 'INDIVIDUAL', firstName: 'Kaynak', lastName: 'Müşteri' }),
    201,
  );
  insured = await data<CustomerDto>(
    await post('/api/customers', {
      type: 'INDIVIDUAL',
      firstName: 'Sigortalı',
      lastName: 'Müşteri',
    }),
    201,
  );
  policies = [];
  for (const [index, status] of ['ACTIVE', 'CANCELLED', 'VOIDED'].entries()) {
    const created = await data<PolicyDto>(
      await post('/api/policies', {
        customerId: customer.id,
        insurerId: 'browse-insurer',
        productId: 'browse-product',
        branchId: 'browse-branch',
        paymentMethodId: 'browse-payment',
        assigneeMembershipId: 'membership-policy-reader',
        policyNumber: `BROWSE-${index}`,
        startDate: '2026-01-01',
        endDate: `2026-12-${20 + index}`,
        grossPremium: '1234.56',
        installmentCount: null,
        currency: 'TRY',
        status,
      }),
      201,
    );
    policies.push(created);
  }
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('rejects the reproduced wrong limit parameter and accepts canonical customer pageSize=20', async () => {
  const result = await f.request(
    '/api/policies?customerId=customer-profile&limit=20',
    'GET',
    cookie,
  );
  expect(result.status).toBe(400);
  const resultData = await data<PolicyListResponseData>(
    await f.request(`/api/policies?customerId=${customer.id}&pageSize=20`, 'GET', cookie),
  );
  expect(resultData.items.map((item) => item.id)).toEqual(policies.map((item) => item.id));
});
it('preserves server end-date ordering, opaque cursor pages and exact/prefix/status/date filters', async () => {
  const first = await data<PolicyListResponseData>(
    await f.request('/api/policies?pageSize=1', 'GET', cookie),
  );
  expect(first.items.map((p) => p.id)).toEqual([policies[0]!.id]);
  expect(first.hasMore).toBe(true);
  const second = await data<PolicyListResponseData>(
    await f.request(
      '/api/policies?pageSize=1&cursor=' + encodeURIComponent(first.nextCursor!),
      'GET',
      cookie,
    ),
  );
  expect(second.items.map((p) => p.id)).toEqual([policies[1]!.id]);
  const exact = await data<PolicyListResponseData>(
    await f.request('/api/policies?search=BROWSE-1&searchMode=exact&pageSize=20', 'GET', cookie),
  );
  expect(exact.items.map((p) => p.id)).toEqual([policies[1]!.id]);
  const prefix = await data<PolicyListResponseData>(
    await f.request(
      '/api/policies?search=BROWSE&searchMode=prefix&status=VOIDED&endFrom=2026-12-22&endTo=2026-12-22',
      'GET',
      cookie,
    ),
  );
  expect(prefix.items.map((p) => p.id)).toEqual([policies[2]!.id]);
  const descending = await data<PolicyListResponseData>(
    await f.request('/api/policies?sort=end_date_desc', 'GET', cookie),
  );
  expect(descending.items.map((p) => p.id)).toEqual([...policies].reverse().map((p) => p.id));
  expect(exact.items[0]!.grossPremiumMinor).toBe(123456);
  expect(exact.items[0]).not.toHaveProperty('customer');
});
it('supports existing creation, insured parties, endorsements and references through unchanged domain APIs', async () => {
  const id = policies[0]!.id,
    path = `/api/policies/${id}`;

  const version = async () =>
    (await data<PolicyDetailDto>(await f.request(path, 'GET', cookie))).version;
  await data(
    await post(path + '/parties', {
      expectedVersion: await version(),
      customerId: insured.id,
      role: 'INSURED',
    }),
    201,
  );
  await data(
    await post(path + '/amendments', {
      expectedVersion: await version(),
      externalReference: 'ZEYL-BROWSE',
      effectiveDate: '2026-05-01',
      description: 'Sentetik tarihsel zeyil',
      premiumDifference: '-0.50',
      currency: 'TRY',
    }),
    201,
  );
  await data(
    await post(path + '/external-references', {
      expectedVersion: await version(),
      sourceNamespace: 'synthetic',
      externalKey: 'BROWSE-REF',
    }),
    201,
  );
  for (const actor of [cookie, ahmet, ayse]) {
    const detailResponse = await f.request(path, 'GET', actor);
    expect(detailResponse.headers.get('cache-control')).toContain('no-store');
    const detail = await data<PolicyDetailDto>(detailResponse);
    expect(detail.customer.id).toBe(customer.id);
    expect(detail.insurer.name).toBe('Yetkili Sigortacı');
    expect(detail).not.toHaveProperty('identityValue');
    expect(detail).not.toHaveProperty('healthData');
    expect(await data(await f.request(path + '/parties', 'GET', actor))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customerDisplayName: 'Sigortalı Müşteri' }),
      ]),
    );
    expect(await data(await f.request(path + '/amendments', 'GET', actor))).toEqual(
      expect.arrayContaining([expect.objectContaining({ premiumDifferenceMinor: -50 })]),
    );
    expect(await data(await f.request(path + '/external-references', 'GET', actor))).toEqual(
      expect.arrayContaining([expect.objectContaining({ externalKey: 'BROWSE-REF' })]),
    );
  }
});
it('preserves archived history independently from cancellation or void status', async () => {
  const path = `/api/policies/${policies[0]!.id}`,
    current = await data<PolicyDetailDto>(await f.request(path, 'GET', cookie));
  await data(
    await post(path + '/archive', {
      expectedVersion: current.version,
      reasonCode: 'HISTORICAL_RECORD',
    }),
  );
  for (const actor of [cookie, ahmet, ayse]) {
    const detail = await data<PolicyDetailDto>(await f.request(path, 'GET', actor));
    expect(detail.status).toBe('ACTIVE');
    expect(detail.archivedAt).not.toBeNull();
    expect((await f.request(path + '/amendments', 'GET', actor)).status).toBe(200);
  }
});
it('excludes a synthetic HEALTH fixture from ordinary lists and denies every detail section without explicit sensitive permission', async () => {
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('browse-health-branch','agency-auth-test','HEALTH','Protected health branch','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('browse-health-product','agency-auth-test','browse-insurer','browse-health-branch','HEALTH','Protected health product')",
    ),
    f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('browse-health','agency-auth-test',?,'browse-insurer','browse-health-product','browse-health-branch','browse-payment','membership-policy-reader','HEALTH-HIDDEN','HEALTHHIDDEN','2026-01-01','2026-12-31',100,'TRY')",
      )
      .bind(customer.id),
  ]);
  for (const actor of [cookie, ahmet, ayse]) {
    const listed = await data<PolicyListResponseData>(
      await f.request('/api/policies?search=HEALTH&searchMode=prefix', 'GET', actor),
    );
    expect(listed.items).toEqual([]);
    for (const suffix of ['', '/parties', '/amendments', '/external-references']) {
      const denied = await f.request('/api/policies/browse-health' + suffix, 'GET', actor);
      expect(denied.status).toBe(403);
      const body = await denied.json();
      expect(body).not.toHaveProperty('data');
      expect(JSON.stringify(body)).not.toContain('HEALTH-HIDDEN');
    }
  }
});
it('denies foreign, ungranted and revoked actors without policy fields on every read endpoint', async () => {
  const path = `/api/policies/${policies[0]!.id}`;
  for (const suffix of ['', '/parties', '/amendments', '/external-references'])
    for (const [actor, status] of [
      [foreign, 404],
      [denied, 403],
    ] as const) {
      const result = await f.request(path + suffix, 'GET', actor);
      expect(result.status).toBe(status);
      const body = await result.json();
      expect(body).not.toHaveProperty('data');
      expect(JSON.stringify(body)).not.toContain('BROWSE-0');
    }
  expect((await f.request('/api/policies', 'GET', denied)).status).toBe(403);
  expect((await f.request(path)).status).toBe(401);
  await f.db
    .prepare("UPDATE local_sessions SET revoked_at=? WHERE user_id='browse-ayse'")
    .bind(Date.now())
    .run();
  expect((await f.request(path, 'GET', ayse)).status).toBe(401);
});

it('keeps insurer/label projection scoped, HEALTH filtered, and reused cursors unable to bypass insurer scope', async () => {
  const path = '/api/policies?includeLabels=true&insurerId=browse-insurer&pageSize=1';
  const first = await data<PolicyListResponseData>(await f.request(path, 'GET', cookie));
  expect(first.items[0]!.labels).toEqual({
    insurerName: 'Yetkili Sigortacı',
    productName: 'Genel Ürün',
    branchName: 'Genel Branş',
  });
  const next = await data<PolicyListResponseData>(
    await f.request(path + '&cursor=' + encodeURIComponent(first.nextCursor!), 'GET', cookie),
  );
  expect(next.items[0]!.id).not.toBe(first.items[0]!.id);
  expect(
    (
      await data<PolicyListResponseData>(
        await f.request(
          '/api/policies?includeLabels=true&insurerId=other&pageSize=1&cursor=' +
            encodeURIComponent(first.nextCursor!),
          'GET',
          cookie,
        ),
      )
    ).items,
  ).toEqual([]);
  const all = await data<PolicyListResponseData>(
    await f.request('/api/policies?includeLabels=true&insurerId=browse-insurer', 'GET', cookie),
  );
  expect(all.items.some((p) => p.id === 'browse-health')).toBe(false);
  expect((await data<PolicyListResponseData>(await f.request(path, 'GET', foreign))).items).toEqual(
    [],
  );
  expect((await f.request(path, 'GET', denied)).status).toBe(403);
  const actor = await f.seed('portfolio-assigned', 'MEMBER', false);
  for (const [code, scope] of [
    ['policy.read', 'ASSIGNED'],
    ['customer.read', 'AGENCY'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), actor.membershipId, code, scope)
      .run();
  const loginResponse = await f.request('/api/auth/login', 'POST', undefined, {
    email: actor.email,
    password: actor.password,
  });
  expect(loginResponse.status).toBe(200);
  const assignedCookie = loginResponse.headers.get('set-cookie')!.split(';')[0]!;
  expect(
    (await data<PolicyListResponseData>(await f.request(path, 'GET', assignedCookie))).items,
  ).toEqual([]);
  const created = await data<PolicyDto>(
    await post('/api/policies', {
      customerId: customer.id,
      insurerId: 'browse-insurer',
      productId: 'browse-product',
      branchId: 'browse-branch',
      paymentMethodId: 'browse-payment',
      assigneeMembershipId: actor.membershipId,
      policyNumber: 'ASSIGNED-PORTFOLIO',
      startDate: '2026-01-01',
      endDate: '2030-12-31',
      grossPremium: '1234.56',
      installmentCount: null,
      currency: 'TRY',
      status: 'ACTIVE',
    }),
    201,
  );
  const visible = await data<PolicyListResponseData>(await f.request(path, 'GET', assignedCookie));
  expect(visible.items.map((p) => p.id)).toEqual([created.id]);
  expect(visible.items[0]!.labels?.insurerName).toBe('Yetkili Sigortacı');
});

it.each(['session', 'read-permission', 'health-permission'])(
  'denies authority loss immediately before final policy disclosure: %s',
  async (kind) => {
    const actor = 'browse-ahmet';
    if (kind === 'health-permission') {
      await f.db.batch([
        f.db.prepare(
          "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('list-race-health-b','agency-auth-test','LIST_RACE_HEALTH','Sentetik sağlık','HEALTH')",
        ),
        f.db.prepare(
          "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('list-race-health-product','agency-auth-test','browse-insurer','list-race-health-b','LIST_RACE_HEALTH','Sentetik sağlık ürünü')",
        ),
        f.db
          .prepare(
            "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('list-race-health-policy','agency-auth-test',?,'browse-insurer','list-race-health-product','list-race-health-b','browse-payment','membership-policy-reader','LIST-RACE-HEALTH','LISTRACEHEALTH','2026-01-01','2026-12-31',100,'TRY')",
          )
          .bind(customer.id),
        f.db.prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('list-race-health-grant','membership-browse-ahmet','sensitive.health.read','UNSCOPED')",
        ),
      ]);
    }
    const session = await f.session(actor);
    const path = '/api/policies?includeLabels=true&pageSize=20';
    const baseline = await data<PolicyListResponseData>(
      await f.request(path, 'GET', session.cookie),
    );
    expect(baseline.items.length).toBeGreaterThan(0);
    if (kind === 'health-permission')
      expect(baseline.items.some((p) => p.id === 'list-race-health-policy')).toBe(true);
    const original = f.env.DB;
    const barrier = interceptFinalRead(
      f.db,
      (sql) => sql.includes('SELECT p.* ') && sql.includes('ORDER BY'),
      async () => {
        if (kind === 'session')
          await f.db
            .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
            .bind(Date.now(), session.hash)
            .run();
        else if (kind === 'read-permission')
          await f.db
            .prepare(
              "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-browse-ahmet' AND permission_code='policy.read'",
            )
            .run();
        else
          await f.db
            .prepare("DELETE FROM membership_permissions WHERE id='list-race-health-grant'")
            .run();
      },
    );
    f.env.DB = barrier.db;
    try {
      const response = await f.request(path, 'GET', session.cookie);
      expect(barrier.wasTriggered()).toBe(true);
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('data');
    } finally {
      f.env.DB = original;
      await f.db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-browse-ahmet' AND permission_code='policy.read'",
        )
        .run();
      await f.db
        .prepare("DELETE FROM membership_permissions WHERE id='list-race-health-grant'")
        .run();
    }
  },
);
