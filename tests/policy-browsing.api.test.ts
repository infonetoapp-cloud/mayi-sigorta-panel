// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { PolicyLifecycleContext } from '../src/shared/policy-cancellation';
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
  const body = (await response.json()) as { data: T; error?: { code?: string } };
  expect(response.status, body.error?.code).toBe(status);
  return body.data;
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
      .prepare('INSERT INTO loss_reasons(id,agency_id,code,name) VALUES(?,?,?,?)')
      .bind('browse-customer-request', agency, 'CUSTOMER_REQUEST', 'Müşteri talebi'),
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
    await post('/api/customers', {
      type: 'INDIVIDUAL',
      firstName: 'Kaynak',
      lastName: 'Müşteri',
      insurerNumber: { insurerId: 'browse-insurer', customerNumber: '000-BROWSE-1' },
    }),
    201,
  );
  insured = await data<CustomerDto>(
    await post('/api/customers', {
      type: 'INDIVIDUAL',
      insurerNumber: { insurerId: 'browse-insurer', customerNumber: '000-BROWSE-2' },
      firstName: 'Sigortalı',
      lastName: 'Müşteri',
    }),
    201,
  );
  policies = [];
  for (const [index, status] of ['ACTIVE', 'CANCELLED', 'VOIDED'].entries()) {
    let created = await data<PolicyDto>(
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
        status: 'ACTIVE',
      }),
      201,
    );
    if (status !== 'ACTIVE') {
      const kind = status === 'CANCELLED' ? 'cancel' : 'void';
      const ctx = await data<PolicyLifecycleContext>(
        await f.request(
          `/api/policies/${created.id}/${kind === 'cancel' ? 'cancellation-context' : 'void-context'}`,
          'GET',
          cookie,
        ),
        200,
      );
      await data(
        await post(`/api/policies/${created.id}/${kind}`, {
          expectedPolicyVersion: ctx.policyVersion,
          targetSetFingerprint: ctx.targetSetFingerprint,
          cancellationDate: '2026-11-17',
          reasonCode: kind === 'cancel' ? 'CUSTOMER_REQUEST' : 'DUPLICATE',
          reasonNotes: null,
          ...(ctx.expectedRenewal ? { expectedRenewal: ctx.expectedRenewal } : {}),
          ...(ctx.expectedRenewal && kind === 'cancel'
            ? { lossReasonId: 'browse-customer-request' }
            : {}),
        }),
        200,
      );
      created = { ...created, status: status as PolicyDto['status'], version: created.version + 1 };
    }
    policies.push(created);
  }
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('returns authorized customer and catalog labels with the historical plate in the bounded policy page', async () => {
  const details = JSON.stringify({
    plate: '34 DFL 537',
    brand: null,
    model: null,
    modelYear: null,
    vin: null,
    engineNumber: null,
    registrationSerial: null,
  });
  await f.db
    .prepare(
      'INSERT INTO customer_vehicles(id,agency_id,customer_id,details_json,normalized_plate) VALUES(?,?,?,?,?)',
    )
    .bind('browse-vehicle', 'agency-auth-test', customer.id, details, '34DFL537')
    .run();
  await f.db
    .prepare(
      'INSERT INTO policy_vehicle_snapshots(policy_id,agency_id,customer_id,vehicle_id,vehicle_version,details_json) VALUES(?,?,?,?,1,?)',
    )
    .bind(policies[0]!.id, 'agency-auth-test', customer.id, 'browse-vehicle', details)
    .run();
  await f.db
    .prepare(
      'UPDATE customer_vehicles SET details_json=?,normalized_plate=?,version=version+1 WHERE id=?',
    )
    .bind(details.replace('34 DFL 537', '06 NEW 001'), '06NEW001', 'browse-vehicle')
    .run();
  const response = await f.request('/api/policies?includeLabels=true&pageSize=1', 'GET', cookie);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const page = await data<PolicyListResponseData>(response);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.labels).toEqual({
    customerDisplayName: 'Kaynak Müşteri',
    branchName: 'Genel Branş',
    productName: 'Genel Ürün',
    insurerName: 'Yetkili Sigortacı',
    plate: '34 DFL 537',
  });
  expect(JSON.stringify(page)).not.toContain('06 NEW 001');
  const next = await data<PolicyListResponseData>(
    await f.request(
      '/api/policies?includeLabels=true&pageSize=1&cursor=' + encodeURIComponent(page.nextCursor!),
      'GET',
      cookie,
    ),
  );
  expect(next.items[0]!.id).toBe(policies[1]!.id);
  expect(next.items[0]!.labels?.plate).toBeNull();
  expect(
    (
      await data<PolicyListResponseData>(
        await f.request('/api/policies?includeLabels=true', 'GET', foreign),
      )
    ).items,
  ).toEqual([]);
});

it('does not reveal a customer label outside the independent customer.read scope', async () => {
  await f.seed('browse-policy-only');
  for (const [code, scope] of [
    ['policy.read', 'AGENCY'],
    ['customer.read', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-browse-policy-only', code, scope)
      .run();
  const actor = (await f.session('browse-policy-only')).cookie;
  const page = await data<PolicyListResponseData>(
    await f.request('/api/policies?includeLabels=true', 'GET', actor),
  );
  expect(page.items).toHaveLength(3);
  expect(page.items.every((policy) => policy.labels?.customerDisplayName === null)).toBe(true);
  expect(JSON.stringify(page)).not.toContain('Kaynak Müşteri');
  await f.db
    .prepare(
      "UPDATE customers SET assignee_membership_id='membership-browse-policy-only',version=version+1 WHERE id=?",
    )
    .bind(customer.id)
    .run();
  const assigned = await data<PolicyListResponseData>(
    await f.request('/api/policies?includeLabels=true', 'GET', actor),
  );
  expect(assigned.items[0]!.labels?.customerDisplayName).toBe('Kaynak Müşteri');
  await f.db
    .prepare(
      "UPDATE customers SET assignee_membership_id='membership-policy-reader',version=version+1 WHERE id=?",
    )
    .bind(customer.id)
    .run();
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
  const path = `/api/policies/${policies[0]!.id}`;
  const { expectedRenewal } = await data<PolicyLifecycleContext>(
    await f.request(path + '/cancellation-context', 'GET', cookie),
  );
  if (expectedRenewal) {
    await data(
      await post(`/api/renewals/${expectedRenewal.id}/close-lost`, {
        expectedPrimaryTaskId: expectedRenewal.primaryTaskId,
        expectedRenewalVersion: expectedRenewal.version,
        expectedTaskVersion: expectedRenewal.taskVersion,
        lossReasonId: 'browse-customer-request',
        lossReasonNotes: null,
      }),
    );
  }
  const current = await data<PolicyDetailDto>(await f.request(path, 'GET', cookie));
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
      await f.request(
        '/api/policies?search=HEALTH&searchMode=prefix&includeLabels=true',
        'GET',
        actor,
      ),
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

it('searches a multibyte policy prefix across insurer partitions and respects the exact boundary', async () => {
  const prefix = 'Ş'.repeat(45) + '\u{10400}';
  const lowercase = 'ş'.repeat(45) + '\u{10428}';
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('browse-insurer-second','agency-auth-test','BROWSE2','İkinci Sigortacı')",
    ),
    f.db.prepare(
      `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
        VALUES('browse-product-second','agency-auth-test','browse-insurer-second','browse-branch','BROWSE2','İkinci Ürün')`,
    ),
  ]);
  const policy = async (policyNumber: string, suffix = '') =>
    data<PolicyDto>(
      await post('/api/policies', {
        customerId: customer.id,
        insurerId: 'browse-insurer' + suffix,
        productId: 'browse-product' + suffix,
        branchId: 'browse-branch',
        paymentMethodId: 'browse-payment',
        policyNumber,
        startDate: '2026-01-01',
        endDate: '2026-12-20',
        grossPremium: '12.34',
        installmentCount: null,
        currency: 'TRY',
        status: 'ACTIVE',
      }),
      201,
    );
  const one = await policy(prefix);
  const two = await policy(prefix + '9', '-second');
  await policy('Ş'.repeat(45) + '\u{10401}');
  const path = '/api/policies?search=' + encodeURIComponent(lowercase) + '&includeLabels=true';
  const list = async (suffix: string) =>
    (await data<PolicyListResponseData>(await f.request(path + suffix, 'GET', cookie))).items.map(
      (row) => row.id,
    );
  expect(new Set(await list('&searchMode=prefix'))).toEqual(new Set([one.id, two.id]));
  expect(await list('&searchMode=prefix&insurerId=browse-insurer-second')).toEqual([two.id]);
  expect(await list('&searchMode=exact')).toEqual([one.id]);
});
