// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, member: string, foreign: string;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('num-owner', 'OWNER');
  await f.seed('num-member');
  await f.seed('num-foreign', 'OWNER', false, 'num-foreign-agency');
  owner = (await f.session('num-owner')).cookie;
  member = (await f.session('num-member')).cookie;
  foreign = (await f.session('num-foreign')).cookie;
  for (const permission of ['customer.read', 'customer.update'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-num-member', permission, 'ASSIGNED')
      .run();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('num-i','agency-auth-test','NUM','Anadolu Sigorta')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('num-j','agency-auth-test','NUM2','Allianz')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('num-foreign-i','num-foreign-agency','NUM','Yabancı Şirket')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function customer(id: string, assigned = 'membership-num-member') {
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,'agency-auth-test','INDIVIDUAL','Sentetik Kişi','Sentetik','Kişi',?)",
    )
    .bind(id, assigned)
    .run();
  return id;
}
async function put(
  id: string,
  number: string,
  insurer = 'num-i',
  version = 1,
  key = crypto.randomUUID(),
  cookie = owner,
) {
  return f.request(
    `/api/customers/${id}/insurer-numbers/${insurer}`,
    'PUT',
    cookie,
    { expectedVersion: version, customerNumber: number },
    await f.csrf(cookie),
    { 'idempotency-key': key },
  );
}
it('stores leading zeros per company, corrects the same row and preserves CAS, uniqueness and exact replay', async () => {
  const id = await customer('num-c1');
  const other = await customer('num-c2');
  const key = crypto.randomUUID();
  const created = await put(id, '000123', 'num-i', 1, key);
  expect(created.status).toBe(200);
  const receipt = await created.json();
  expect((await put(id, 'DIFFERENT', 'num-i', 1, key)).status).toBe(409);
  expect(await (await put(id, '000123', 'num-i', 1, key)).json()).toMatchObject({
    data: (receipt as { data: unknown }).data,
  });
  expect((await put(id, 'A-0003', 'num-j', 2)).status).toBe(200);
  expect((await put(other, '000123')).status).toBe(409);
  expect((await put(id, '000999', 'num-i', 1)).status).toBe(409);
  expect((await put(id, '000999', 'num-i', 3)).status).toBe(200);
  expect(
    await f.db
      .prepare(
        "SELECT count(*) n FROM external_customer_references WHERE customer_id=? AND source_namespace='insurer:num-i'",
      )
      .bind(id)
      .first(),
  ).toEqual({ n: 1 });
  const read = await f.request(`/api/customers/${id}/insurer-numbers`, 'GET', member);
  expect(((await read.json()) as { data: unknown }).data).toEqual([
    { insurerId: 'num-j', insurerName: 'Allianz', customerNumber: 'A-0003' },
    { insurerId: 'num-i', insurerName: 'Anadolu Sigorta', customerNumber: '000999' },
  ]);
  expect((await put(other, '000123')).status).toBe(200);
  const legacy = await f.request(
    `/api/customers/${other}/external-references`,
    'POST',
    owner,
    { expectedVersion: 2, sourceNamespace: 'LEGACY_MANUAL', externalKey: 'L-001' },
    await f.csrf(owner),
    { 'idempotency-key': crypto.randomUUID() },
  );
  expect(legacy.status).toBe(201);
});
it('enforces customer assignment, agency, active company, archived parent, CSRF and reserved namespace', async () => {
  const id = await customer('num-protected', 'membership-num-owner');
  expect((await put(id, '1', 'num-i', 1, crypto.randomUUID(), member)).status).toBe(403);
  expect((await f.request(`/api/customers/${id}/insurer-numbers`, 'GET', member)).status).toBe(404);
  expect((await f.request(`/api/customers/${id}/insurer-numbers`, 'GET', foreign)).status).toBe(
    404,
  );
  expect((await put(id, '1', 'num-foreign-i')).status).toBe(400);
  for (const number of ['', 'X'.repeat(101), 'A\u0000B'])
    expect((await put(id, number)).status).toBe(400);
  expect(
    (
      await f.request(
        `/api/customers/${id}/insurer-numbers/num-i`,
        'PUT',
        owner,
        { expectedVersion: 1, customerNumber: '1' },
        undefined,
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(
        `/api/customers/${id}/external-references`,
        'POST',
        owner,
        { expectedVersion: 1, sourceNamespace: 'insurer:num-i', externalKey: '1' },
        await f.csrf(owner),
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(400);
  const archived = await f.request(
    `/api/customers/${id}/archive`,
    'POST',
    owner,
    { expectedVersion: 1, reasonCode: 'TEST_COMPLETE' },
    await f.csrf(owner),
    { 'idempotency-key': crypto.randomUUID() },
  );
  expect(archived.status).toBe(200);
  expect((await put(id, '1', 'num-i', 2)).status).toBe(409);
});
it('replays a confirmed write after company deactivation but rejects new writes and limits directory fields', async () => {
  const id = await customer('num-replay');
  const key = crypto.randomUUID();
  expect((await put(id, '001', 'num-j', 1, key)).status).toBe(200);
  await f.db
    .prepare("UPDATE insurers SET status='INACTIVE',version=version+1 WHERE id='num-j'")
    .run();
  expect((await put(id, '001', 'num-j', 1, key)).status).toBe(200);
  expect((await put(id, '002', 'num-j', 2)).status).toBe(400);
  const options = await f.request(`/api/customers/${id}/insurer-number-options`, 'GET', member);
  expect(((await options.json()) as { data: unknown }).data).toEqual({
    items: [{ id: 'num-i', name: 'Anadolu Sigorta' }],
    nextCursor: null,
  });
});
it('rolls back data, receipt and audit if the company becomes inactive before the atomic write', async () => {
  const id = await customer('num-race');
  const original = f.env.DB;
  let changed = false;
  const key = crypto.randomUUID();
  f.env.DB = new Proxy(original, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: Parameters<D1Database['batch']>[0]) => {
          if (!changed) {
            changed = true;
            await original
              .prepare("UPDATE insurers SET status='INACTIVE',version=version+1 WHERE id='num-i'")
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    expect((await put(id, '009', 'num-i', 1, key)).status).toBe(409);
    expect(changed).toBe(true);
    for (const table of ['operation_receipts', 'audit_events'])
      expect(
        await f.db
          .prepare(`SELECT count(*) n FROM ${table} WHERE idempotency_key=?`)
          .bind(key)
          .first(),
      ).toEqual({ n: 0 });
    expect(await f.db.prepare('SELECT version FROM customers WHERE id=?').bind(id).first()).toEqual(
      { version: 1 },
    );
    expect(
      await f.db
        .prepare('SELECT count(*) n FROM external_customer_references WHERE customer_id=?')
        .bind(id)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    f.env.DB = original;
  }
});
