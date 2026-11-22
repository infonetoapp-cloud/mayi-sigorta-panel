// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>, owner: string, denied: string;
const agency = 'agency-auth-test';
const individual = { type: 'INDIVIDUAL', firstName: 'Sentetik', lastName: 'Kişi' };
const company = { type: 'COMPANY', companyTitle: 'Sentetik Şirket', taxNumber: '0012345678' };
const number = (customerNumber: string, insurerId = 'reg-i') => ({ insurerId, customerNumber });
beforeAll(async () => {
  f = await localAuthFixture();
  f.env.IDENTITY_ENCRYPTION_KEY = '11'.repeat(32);
  f.env.IDENTITY_HMAC_KEY = '22'.repeat(32);
  f.env.IDENTITY_KEY_VERSION = '1';
  await f.seed('reg-owner', 'OWNER');
  await f.seed('reg-denied', 'OWNER');
  await f.seed('reg-foreign', 'OWNER', false, 'reg-foreign-agency');
  for (const permission of ['sensitive.identity.read', 'sensitive.identity.write'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-reg-owner', permission, 'UNSCOPED')
      .run();
  await f.db.batch([
    f.db
      .prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('reg-i',?,'REG','Sentetik Sigorta')",
      )
      .bind(agency),
    f.db
      .prepare(
        "INSERT INTO insurers(id,agency_id,code,name,status) VALUES('reg-inactive',?,'REG2','Pasif','INACTIVE')",
      )
      .bind(agency),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('reg-foreign-i','reg-foreign-agency','REG','Diğer')",
    ),
  ]);
  owner = (await f.session('reg-owner')).cookie;
  denied = (await f.session('reg-denied')).cookie;
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function create(payload: unknown, key = crypto.randomUUID(), cookie = owner) {
  return f.request('/api/customers', 'POST', cookie, payload, await f.csrf(cookie), {
    'idempotency-key': key,
  });
}
async function count() {
  return (await f.db.prepare('SELECT count(*) n FROM customers').first<{ n: number }>())!.n;
}
it('repairs missing legacy company identifiers through their existing authorized operations', async () => {
  const id = 'reg-legacy-company';
  const root = `/api/customers/${id}`;
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,company_title,assignee_membership_id) VALUES(?,?,'COMPANY','Eski Şirket','Eski Şirket','membership-reg-owner')",
    )
    .bind(id, agency)
    .run();

  const put = async (path: string, body: unknown, cookie = owner) =>
    f.request(root + path, 'PUT', cookie, body, await f.csrf(cookie), {
      'idempotency-key': crypto.randomUUID(),
    });
  const identity = { expectedVersion: 1, identityType: 'VKN', identityValue: '0009876543' };
  expect(await (await f.request(root, 'GET', owner)).json()).toMatchObject({
    data: { hasIdentity: false, version: 1 },
  });
  expect((await put('/identity', identity, denied)).status).toBe(403);
  expect((await put('/identity', identity)).status).toBe(200);
  expect(
    (await put('/insurer-numbers/reg-i', { expectedVersion: 2, customerNumber: '000LEGACY' }))
      .status,
  ).toBe(200);
  expect(await (await f.request(root, 'GET', owner)).json()).toMatchObject({
    data: { hasIdentity: true, identityMasked: '***', version: 3 },
  });
  expect(await (await f.request(root + '/insurer-numbers', 'GET', owner)).json()).toMatchObject({
    data: [expect.objectContaining({ insurerId: 'reg-i', customerNumber: '000LEGACY' })],
  });
});
it('requires a manual company customer number for both types and a 10-digit corporate tax number', async () => {
  const before = await count();
  for (const payload of [
    individual,
    company,
    { ...individual, insurerNumber: number('') },
    { type: 'COMPANY', companyTitle: 'Eksik Vergi', insurerNumber: number('001') },
    { ...company, taxNumber: '', insurerNumber: number('001') },
    { ...company, taxNumber: '123456789', insurerNumber: number('001') },
    { ...company, taxNumber: '12345678901', insurerNumber: number('001') },
    { ...individual, taxNumber: '0012345678', insurerNumber: number('001') },
    { ...individual, insurerNumber: number('001', 'reg-inactive') },
    { ...individual, insurerNumber: number('001', 'reg-foreign-i') },
  ])
    expect((await create(payload)).status).toBe(400);
  expect(await count()).toBe(before);
});
it('creates the customer, encrypted tax number and manual reference atomically and exactly replays', async () => {
  const person = await create({ ...individual, insurerNumber: number('000000-PERSON') });
  expect(person.status).toBe(201);
  expect(await person.json()).toMatchObject({ data: { hasIdentity: false, identityMasked: null } });
  const payload = { ...company, insurerNumber: number('000001/REG') },
    key = crypto.randomUUID();
  const response = await create(payload, key);
  expect(response.status, await response.clone().text()).toBe(201);
  const dto = (
    (await response.json()) as {
      data: { id: string; hasIdentity: boolean; identityMasked: string };
    }
  ).data;
  expect(dto.hasIdentity).toBe(true);
  expect(dto.identityMasked).toBe('***');
  expect(JSON.stringify(dto)).not.toContain(company.taxNumber);
  const clear = await f.request(
    `/api/customers/${dto.id}/identity`,
    'PUT',
    owner,
    { expectedVersion: 1, clear: true },
    await f.csrf(owner),
    { 'idempotency-key': crypto.randomUUID() },
  );
  expect(clear.status).toBe(400);
  const stored = await f.db
    .prepare('SELECT identity_type,identity_ciphertext FROM customers WHERE id=?')
    .bind(dto.id)
    .first<{ identity_type: string; identity_ciphertext: string }>();
  expect(stored!.identity_type).toBe('VKN');
  expect(stored!.identity_ciphertext).not.toContain(company.taxNumber);
  const references = await f.request(`/api/customers/${dto.id}/insurer-numbers`, 'GET', owner);
  expect(await references.json()).toMatchObject({
    data: [{ customerNumber: '000001/REG', insurerId: 'reg-i' }],
  });
  const replay = await create(payload, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ data: dto });
  expect((await create({ ...payload, taxNumber: '0012345679' }, key)).status).toBe(409);
  const receipts = await f.db
    .prepare('SELECT response_body FROM operation_receipts WHERE idempotency_key=?')
    .bind(key)
    .all<{ response_body: string }>();
  expect(JSON.stringify(receipts.results)).not.toContain(company.taxNumber);
  const before = await count();
  expect((await create({ ...individual, insurerNumber: number('000001/REG') })).status).toBe(409);
  expect(await count()).toBe(before);
});
it('preserves sensitive permissions and rolls customer/reference/receipt back when the last audit fails', async () => {
  expect(
    (await create({ ...company, insurerNumber: number('DENIED') }, crypto.randomUUID(), denied))
      .status,
  ).toBe(403);
  const before = await count(),
    key = crypto.randomUUID();
  await f.db.exec(
    "CREATE TRIGGER reg_fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='customer.create' BEGIN SELECT RAISE(ABORT,'synthetic registration audit failure'); END;",
  );
  try {
    expect((await create({ ...company, insurerNumber: number('ROLLBACK') }, key)).status).not.toBe(
      201,
    );
  } finally {
    await f.db.exec('DROP TRIGGER reg_fail_audit;');
  }
  expect(await count()).toBe(before);
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  expect(
    await f.db
      .prepare("SELECT id FROM external_customer_references WHERE external_key='ROLLBACK'")
      .first(),
  ).toBeNull();
});
