// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
const customerId = 'prices-c';
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('prices-owner', 'OWNER');
  await f.seed('prices-staff');
  await f.seed('prices-foreign', 'OWNER', false, 'prices-foreign-agency');
  // Shared prices have customer/quote scope, without another employee's Task permissions.
  for (const code of ['customer.read', 'quote.read', 'quote.manage'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-prices-staff', code, 'AGENCY')
      .run();
  for (const who of ['prices-owner', 'prices-staff', 'prices-foreign'])
    cookies[who] = (await f.session(who)).cookie;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('prices-c','agency-auth-test','INDIVIDUAL','Fiyat Müşterisi','Fiyat','Müşterisi','membership-prices-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('prices-i','agency-auth-test','PRI','Anadolu Sigorta')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('prices-i2','agency-auth-test','PRI2','Allianz')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('prices-b','agency-auth-test','PRI','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('prices-h','agency-auth-test','PRIH','Sağlık','HEALTH')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function post(url: string, body: unknown, key = crypto.randomUUID(), who = 'prices-owner') {
  return f.request(url, 'POST', cookies[who], body, await f.csrf(cookies[who]!), {
    'idempotency-key': key,
  });
}
async function newCase(branchId = 'prices-b') {
  const response = await post(`/api/customers/${customerId}/sales-cases`, {
    context: 'NEW_BUSINESS',
    branchId,
    cycleDate: null,
    dateBasis: 'MANUAL',
    followup: { dueAt: '2027-01-10T06:00:00.000Z' },
    confirmSimilar: true,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (
    (await response.json()) as { data: { caseId: string; taskId: string; caseVersion: number } }
  ).data;
}
async function taskSnapshot(taskId: string) {
  return f.db.prepare('SELECT * FROM tasks WHERE id=?').bind(taskId).first();
}
it('keeps legacy QuoteVersion identities and states beside lightweight prices without backfilling or exposing a private Task', async () => {
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('prices-pr','agency-auth-test','prices-i','prices-b','PRI','Kasko ürünü')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('prices-pay','agency-auth-test','PRI','Nakit')",
    ),
    f.db.prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('prices-policy','agency-auth-test','prices-c','prices-i','prices-pr','prices-b','prices-pay','membership-prices-owner','PRICES-POLICY','PRICESPOLICY','2026-01-01','2027-01-20',12345,'TRY')",
    ),
    f.db.prepare(
      "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id) VALUES('prices-renewal','agency-auth-test','prices-policy','membership-prices-owner')",
    ),
    f.db.prepare(
      "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES('prices-private-task','agency-auth-test','prices-c','prices-renewal','RENEWAL_FOLLOWUP','Özel iş','2027-01-10T06:00:00.000Z','membership-prices-owner','SYSTEM')",
    ),
  ]);
  const adopted = await post(`/api/customers/${customerId}/sales-cases`, {
    context: 'RENEWAL',
    renewalId: 'prices-renewal',
    expectedVersion: 1,
    expectedPrimaryTaskId: 'prices-private-task',
    expectedPrimaryTaskVersion: 1,
  });
  expect(adopted.status, await adopted.clone().text()).toBe(201);
  const c = ((await adopted.json()) as { data: { caseId: string } }).data;
  const version = {
    insurerId: 'prices-i',
    productId: 'prices-pr',
    branchId: 'prices-b',
    paymentMethodId: 'prices-pay',
    startDate: '2027-01-21',
    endDate: '2027-07-14',
    validUntil: '2027-01-18T09:00:00.000Z',
    grossPremiumMinor: 180000,
    currency: 'TRY',
    installmentCount: null,
    termsSummary: 'Gerçek eski teklif.',
  };
  const quoteResponse = await post('/api/renewals/prices-renewal/quotes', {
    expectedRenewalVersion: 1,
    version,
  });
  expect(quoteResponse.status, await quoteResponse.clone().text()).toBe(201);
  const q = (
    (await quoteResponse.json()) as {
      data: { quoteId: string; quoteVersionId: string; status: string };
    }
  ).data;
  const oldQuote = await f.db
      .prepare('SELECT * FROM renewal_quotes WHERE id=?')
      .bind(q.quoteId)
      .first(),
    oldVersion = await f.db
      .prepare('SELECT * FROM renewal_quote_versions WHERE id=?')
      .bind(q.quoteVersionId)
      .first();
  const lightKey = crypto.randomUUID(),
    lightBody = priceBody(1, 'prices-i2');
  const light = await result(await post(root(c.caseId) + '/prices', lightBody, lightKey), 201);
  expect((await f.request(root(c.caseId) + '/prices', 'GET', cookies['prices-staff'])).status).toBe(
    404,
  );
  for (const code of ['policy.read', 'renewal.read'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-prices-staff', code, 'AGENCY')
      .run();
  const response = await f.request(root(c.caseId) + '/prices', 'GET', cookies['prices-staff']);
  expect(response.status, await response.clone().text()).toBe(200);
  const text = await response.clone().text();
  expect(text).not.toMatch(/prices-private-task|taskId|assigneeMembershipId/);
  const rows = ((await response.json()) as { data: { items: Record<string, unknown>[] } }).data
    .items;
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.source === 'QUOTE_VERSION')).toMatchObject({
    quoteId: q.quoteId,
    quoteVersionId: q.quoteVersionId,
    quoteStatus: q.status,
    validUntil: version.validUntil,
    startDate: version.startDate,
    endDate: version.endDate,
    amountMinor: version.grossPremiumMinor,
  });
  expect(rows.find((r) => r.source === 'PRICE_REVISION')).toMatchObject({
    priceId: light.priceId,
    revisionId: light.revisionId,
  });
  expect(
    await f.db.prepare('SELECT * FROM renewal_quotes WHERE id=?').bind(q.quoteId).first(),
  ).toEqual(oldQuote);
  expect(
    await f.db
      .prepare('SELECT * FROM renewal_quote_versions WHERE id=?')
      .bind(q.quoteVersionId)
      .first(),
  ).toEqual(oldVersion);
  expect(
    await f.db
      .prepare('SELECT count(*) n FROM sales_prices WHERE case_id=?')
      .bind(c.caseId)
      .first(),
  ).toEqual({ n: 1 });
  const currentRenewal = await f.db
      .prepare("SELECT version FROM renewal_opportunities WHERE id='prices-renewal'")
      .first<{ version: number }>(),
    currentTask = await f.db
      .prepare("SELECT version FROM tasks WHERE id='prices-private-task'")
      .first<{ version: number }>();
  const closed = await post('/api/renewals/prices-renewal/void', {
    expectedPrimaryTaskId: 'prices-private-task',
    expectedRenewalVersion: currentRenewal!.version,
    expectedTaskVersion: currentTask!.version,
    voidReasonCode: 'DUPLICATE',
  });
  expect(closed.status, await closed.clone().text()).toBe(200);
  expect((await f.request(root(c.caseId) + '/prices', 'GET', cookies['prices-staff'])).status).toBe(
    200,
  );
  expect((await post(root(c.caseId) + '/prices', priceBody(2))).status).toBe(409);
  expect(await (await post(root(c.caseId) + '/prices', lightBody, lightKey)).json()).toMatchObject({
    data: light,
    replayed: true,
  });
});
type Result = {
  operationId: string;
  caseId: string;
  caseVersion: number;
  priceId: string;
  priceVersion: number;
  revisionId: string;
  revisionNumber: number;
};
const root = (caseId: string) => `/api/sales-cases/${caseId}`;
const priceBody = (version = 1, insurerId = 'prices-i') => ({
  expectedCaseVersion: version,
  insurerId,
  amountMinor: 123456,
  currency: 'TRY',
  termsNote: null,
  offeredPeriod: null,
});
async function result(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return ((await response.json()) as { data: Result }).data;
}
async function addPrice(caseId: string, version = 1, insurerId = 'prices-i', who = 'prices-owner') {
  return result(
    await post(root(caseId) + '/prices', priceBody(version, insurerId), crypto.randomUUID(), who),
    201,
  );
}
async function priceSnapshot(caseId: string) {
  return Promise.all(
    ['sales_prices', 'sales_price_revisions', 'sales_case_history'].map(async (table) =>
      f.db
        .prepare(
          `SELECT * FROM ${table} WHERE ${table === 'sales_price_revisions' ? 'price_id IN (SELECT id FROM sales_prices WHERE case_id=?)' : 'case_id=?'} ORDER BY id`,
        )
        .bind(caseId)
        .all()
        .then((result) => result.results),
    ),
  );
}

it('saves a shared insurer price without private Task access or inventing a policy, payment, period or acceptance', async () => {
  const c = await newCase(),
    task = await taskSnapshot(c.taskId),
    policiesBefore = await f.db.prepare('SELECT count(*) n FROM policies').first(),
    key = crypto.randomUUID(),
    body = priceBody();
  const data = await result(await post(root(c.caseId) + '/prices', body, key, 'prices-staff'), 201);
  expect(data).toMatchObject({
    caseId: c.caseId,
    caseVersion: 2,
    priceVersion: 1,
    revisionNumber: 1,
  });
  expect(await taskSnapshot(c.taskId)).toEqual(task);
  expect((await f.request(root(c.caseId) + '/task', 'GET', cookies['prices-staff'])).status).toBe(
    404,
  );
  expect(
    await (await post(root(c.caseId) + '/prices', body, key, 'prices-staff')).json(),
  ).toMatchObject({ data, replayed: true });
  expect(
    (await post(root(c.caseId) + '/prices', { ...body, amountMinor: 123457 }, key, 'prices-staff'))
      .status,
  ).toBe(409);
  expect(
    (await post(root(c.caseId) + '/prices', priceBody(2), crypto.randomUUID(), 'prices-staff'))
      .status,
  ).toBe(409);
  const page = await f.request(root(c.caseId) + '/prices', 'GET', cookies['prices-staff']);
  expect(page.status).toBe(200);
  const text = await page.text();
  expect(text).toContain('PRICE_REVISION');
  expect(text).toContain('"eventState":"NOT_SHARED"');
  expect(text).toContain('Anadolu Sigorta');
  expect(text).not.toMatch(
    /taskId|assigneeMembershipId|paymentMethod|productId|validUntil|"(?:CUSTOMER_ACCEPTED|SHARED)"/,
  );
  const manage = await f.db
    .prepare(
      "SELECT id FROM membership_permissions WHERE membership_id='membership-prices-staff' AND permission_code='quote.manage'",
    )
    .first<{ id: string }>();
  await f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(manage!.id).run();
  try {
    const readonly = await f.request(root(c.caseId) + '/prices', 'GET', cookies['prices-staff']);
    expect(readonly.status).toBe(200);
    expect(await readonly.json()).toMatchObject({ data: { canManage: false } });
    expect([403, 404]).toContain(
      (
        await post(
          root(c.caseId) + '/prices',
          priceBody(2, 'prices-i2'),
          crypto.randomUUID(),
          'prices-staff',
        )
      ).status,
    );
  } finally {
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-prices-staff','quote.manage','AGENCY')",
      )
      .bind(manage!.id)
      .run();
  }
  const exact = await f.request(
    root(c.caseId) + `/prices/${data.priceId}/revisions/${data.revisionId}`,
    'GET',
    cookies['prices-staff'],
  );
  expect(exact.status).toBe(200);
  expect(await exact.json()).toMatchObject({
    data: { amountMinor: body.amountMinor, currency: 'TRY', termsNote: null, offeredPeriod: null },
  });
  expect(await f.db.prepare('SELECT count(*) n FROM policies').first()).toEqual(policiesBefore);
  expect(
    await f.db
      .prepare('SELECT event_code,task_id FROM sales_case_history WHERE receipt_id=?')
      .bind(data.operationId)
      .first(),
  ).toEqual({ event_code: 'PRICE_CREATED', task_id: null });
  expect(
    await (
      await f.request(
        root(c.caseId) + '/price-operations/' + data.operationId,
        'GET',
        cookies['prices-staff'],
      )
    ).json(),
  ).toMatchObject({ data });
});

it('revises the current price with case and price CAS while preserving immutable prior revisions and exact old selection', async () => {
  const c = await newCase(),
    first = await addPrice(c.caseId),
    task = await taskSnapshot(c.taskId);
  const old = await f.db
    .prepare('SELECT * FROM sales_price_revisions WHERE id=?')
    .bind(first.revisionId)
    .first();
  const body = {
      expectedCaseVersion: 2,
      expectedPriceVersion: 1,
      amountMinor: 145678,
      currency: 'EUR',
      termsNote: 'Farklı muafiyet.',
      offeredPeriod: { startDate: '2027-02-01', endDate: '2027-04-18' },
    },
    key = crypto.randomUUID();
  const url = root(c.caseId) + `/prices/${first.priceId}/revisions`;
  const revised = await result(await post(url, body, key));
  expect(revised).toMatchObject({
    caseVersion: 3,
    priceId: first.priceId,
    priceVersion: 2,
    revisionNumber: 2,
  });
  expect(revised.revisionId).not.toBe(first.revisionId);
  expect(
    await f.db
      .prepare('SELECT * FROM sales_price_revisions WHERE id=?')
      .bind(first.revisionId)
      .first(),
  ).toEqual(old);
  expect(await taskSnapshot(c.taskId)).toEqual(task);
  expect(
    await f.db
      .prepare('SELECT current_revision_id,version FROM sales_prices WHERE id=?')
      .bind(first.priceId)
      .first(),
  ).toEqual({ current_revision_id: revised.revisionId, version: 2 });
  expect(await (await post(url, body, key)).json()).toMatchObject({
    data: revised,
    replayed: true,
  });
  const before = await priceSnapshot(c.caseId);
  expect((await post(url, { ...body, expectedCaseVersion: 3 })).status).toBe(409);
  expect((await post(url, { ...body, expectedPriceVersion: 2 })).status).toBe(409);
  expect(await priceSnapshot(c.caseId)).toEqual(before);
  const oldExact = await f.request(
    root(c.caseId) + `/prices/${first.priceId}/revisions/${first.revisionId}`,
    'GET',
    cookies['prices-owner'],
  );
  expect(await oldExact.json()).toMatchObject({
    data: { amountMinor: 123456, currency: 'TRY', offeredPeriod: null },
  });
  const newExact = await f.request(
    root(c.caseId) + `/prices/${first.priceId}/revisions/${revised.revisionId}`,
    'GET',
    cookies['prices-owner'],
  );
  expect(await newExact.json()).toMatchObject({
    data: {
      amountMinor: body.amountMinor,
      currency: body.currency,
      termsNote: body.termsNote,
      offeredPeriod: body.offeredPeriod,
    },
  });
  await expect(
    f.db
      .prepare('UPDATE sales_price_revisions SET amount_minor=1 WHERE id=?')
      .bind(first.revisionId)
      .run(),
  ).rejects.toThrow();
  await expect(
    f.db.prepare('DELETE FROM sales_price_revisions WHERE id=?').bind(first.revisionId).run(),
  ).rejects.toThrow();
});

it('bounds current price and revision pages, binds cursors to the reader and case, and avoids per-row history reads', async () => {
  const c = await newCase(),
    first = await addPrice(c.caseId);
  await addPrice(c.caseId, 2, 'prices-i2');
  for (let n = 3; n <= 5; n++) {
    await f.db
      .prepare('INSERT INTO insurers(id,agency_id,code,name) VALUES(?,?,?,?)')
      .bind('prices-i' + n, 'agency-auth-test', 'PRI' + n, 'Şirket ' + n)
      .run();
    await addPrice(c.caseId, n, 'prices-i' + n);
  }
  const revision = {
    expectedCaseVersion: 6,
    expectedPriceVersion: 1,
    amountMinor: 150000,
    currency: 'TRY',
    termsNote: null,
    offeredPeriod: null,
  };
  await result(await post(root(c.caseId) + `/prices/${first.priceId}/revisions`, revision));
  const original = f.env.DB,
    reads: string[] = [];
  f.env.DB = {
    prepare(sql: string) {
      if (
        /^\s*SELECT/i.test(sql) &&
        /\b(sales_prices|sales_price_revisions|sales_cases|renewal_quotes|renewal_quote_versions|renewal_quote_events)\b/i.test(
          sql,
        )
      )
        reads.push(sql);
      return original.prepare(sql);
    },
    batch: original.batch.bind(original),
  } as D1Database;
  let page: { items: unknown[]; nextCursor: string; hasMore: boolean };
  try {
    const response = await f.request(
      root(c.caseId) + '/prices?limit=50',
      'GET',
      cookies['prices-owner'],
    );
    expect(response.status, await response.clone().text()).toBe(200);
    page = ((await response.json()) as { data: typeof page }).data;
  } finally {
    f.env.DB = original;
  }
  expect(page!.items).toHaveLength(5);
  expect(page!.hasMore).toBe(false);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.length).toBeLessThanOrEqual(6);
  const limited = await f.request(
    root(c.caseId) + '/prices?limit=1',
    'GET',
    cookies['prices-owner'],
  );
  page = ((await limited.json()) as { data: typeof page }).data;
  expect(page.items).toHaveLength(1);
  expect(page.hasMore).toBe(true);
  const cursor = '?limit=1&cursor=' + encodeURIComponent(page!.nextCursor);
  expect(
    (await f.request(root(c.caseId) + '/prices' + cursor, 'GET', cookies['prices-staff'])).status,
  ).toBe(400);
  expect(
    (await f.request(root(c.caseId) + '/prices?limit=51', 'GET', cookies['prices-owner'])).status,
  ).toBe(400);
  const historyUrl = root(c.caseId) + `/prices/${first.priceId}/history?limit=1`;
  const history = await f.request(historyUrl, 'GET', cookies['prices-owner']);
  expect(history.status).toBe(200);
  const h = (
    (await history.json()) as {
      data: { revisions: unknown[]; hasMore: boolean; nextCursor: string };
    }
  ).data;
  expect(h.revisions).toHaveLength(1);
  expect(h.hasMore).toBe(true);
  const next = await f.request(
    historyUrl + '&cursor=' + encodeURIComponent(h.nextCursor),
    'GET',
    cookies['prices-owner'],
  );
  expect(next.status).toBe(200);
  expect(((await next.json()) as { data: { revisions: unknown[] } }).data.revisions).toHaveLength(
    1,
  );
  expect(
    (
      await f.request(
        historyUrl + '&cursor=' + encodeURIComponent(h.nextCursor),
        'GET',
        cookies['prices-staff'],
      )
    ).status,
  ).toBe(400);
});

it('rejects invalid money, optional-period mismatches, body additions, foreign readers and mismatched exact operation sources', async () => {
  const c = await newCase(),
    before = await priceSnapshot(c.caseId),
    body = priceBody();
  for (const patch of [
    { amountMinor: -1 },
    { amountMinor: 1.5 },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { currency: 'ZZZ' },
    { offeredPeriod: { startDate: '2027-04-10', endDate: '2027-01-10' } },
    { offeredPeriod: { startDate: '2027-02-30', endDate: '2027-05-01' } },
    { offeredPeriod: { startDate: '2027-01-01' } },
    { paymentMethodId: 'FAKE' },
  ]) {
    const r = await post(root(c.caseId) + '/prices', { ...body, ...patch });
    expect(r.status, await r.clone().text()).toBe(400);
    expect(await priceSnapshot(c.caseId)).toEqual(before);
  }
  expect(
    (await f.request(root(c.caseId) + '/prices', 'GET', cookies['prices-foreign'])).status,
  ).toBe(404);
  const p = await addPrice(c.caseId),
    other = await newCase();
  const zero = await result(
    await post(root(other.caseId) + '/prices', { ...priceBody(), amountMinor: 0 }),
    201,
  );
  expect(
    await f.db
      .prepare('SELECT amount_minor FROM sales_price_revisions WHERE id=?')
      .bind(zero.revisionId)
      .first(),
  ).toEqual({ amount_minor: 0 });
  expect(
    (
      await f.request(
        root(other.caseId) + '/price-operations/' + p.operationId,
        'GET',
        cookies['prices-owner'],
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        root(other.caseId) + `/prices/${p.priceId}/revisions/${p.revisionId}`,
        'GET',
        cookies['prices-owner'],
      )
    ).status,
  ).toBe(404);
});

it('rolls case version, price, revision, history and receipt back on final audit failure and serializes retries', async () => {
  const c = await newCase(),
    before = await priceSnapshot(c.caseId),
    key = crypto.randomUUID();
  await f.db
    .prepare(
      "CREATE TRIGGER prices_fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='sales.price.create' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PRICE_FINAL_AUDIT_FAIL'); END;",
    )
    .run();
  try {
    expect((await post(root(c.caseId) + '/prices', priceBody(), key)).status).toBe(500);
  } finally {
    await f.db.prepare('DROP TRIGGER prices_fail_audit').run();
  }
  expect(await priceSnapshot(c.caseId)).toEqual(before);
  expect(
    await f.db.prepare('SELECT version FROM sales_cases WHERE id=?').bind(c.caseId).first(),
  ).toEqual({ version: 1 });
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  const retryKey = crypto.randomUUID(),
    responses = await Promise.all([
      post(root(c.caseId) + '/prices', priceBody(), retryKey),
      post(root(c.caseId) + '/prices', priceBody(), retryKey),
    ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const results = await Promise.all(responses.map((r) => r.json()));
  expect((results[0] as { data: Result }).data).toEqual((results[1] as { data: Result }).data);
  const competing = await newCase();
  const competingResponses = await Promise.all([
    post(root(competing.caseId) + '/prices', priceBody()),
    post(root(competing.caseId) + '/prices', priceBody(1, 'prices-i2')),
  ]);
  expect(competingResponses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(
    await f.db
      .prepare('SELECT count(*) n FROM sales_prices WHERE case_id=?')
      .bind(competing.caseId)
      .first(),
  ).toEqual({ n: 1 });
});

it('keeps HEALTH and current quote authority in the final atomic boundary without private Task writes', async () => {
  for (const code of ['sensitive.health.read', 'sensitive.health.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-prices-owner', code, 'UNSCOPED')
      .run();
  const health = await newCase('prices-h');
  expect([403, 404]).toContain(
    (await post(root(health.caseId) + '/prices', priceBody(), crypto.randomUUID(), 'prices-staff'))
      .status,
  );
  await addPrice(health.caseId);
  const c = await newCase(),
    before = await priceSnapshot(c.caseId),
    original = f.env.DB,
    key = crypto.randomUUID(),
    csrf = await f.csrf(cookies['prices-staff']!);
  let preparedWrite = false,
    changed = false;
  f.env.DB = {
    prepare(sql: string) {
      if (/INSERT\s+INTO\s+[`"]?sales_prices\b/i.test(sql)) preparedWrite = true;
      return original.prepare(sql);
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (preparedWrite && !changed) {
        changed = true;
        await original
          .prepare(
            "DELETE FROM membership_permissions WHERE membership_id='membership-prices-staff' AND permission_code='quote.manage'",
          )
          .run();
        await original
          .prepare(
            "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-prices-staff'",
          )
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const r = await f.request(
      root(c.caseId) + '/prices',
      'POST',
      cookies['prices-staff'],
      priceBody(),
      csrf,
      { 'idempotency-key': key },
    );
    expect(changed).toBe(true);
    expect(r.status, await r.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(await priceSnapshot(c.caseId)).toEqual(before);
  expect(
    await f.db.prepare('SELECT version FROM sales_cases WHERE id=?').bind(c.caseId).first(),
  ).toEqual({ version: 1 });
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
});
