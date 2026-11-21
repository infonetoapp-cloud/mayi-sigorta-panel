// @vitest-environment node
import { beforeAll, afterAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import type { CustomerDto } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, member: string;
const individual = { type: 'INDIVIDUAL', firstName: 'Sentetik', lastName: 'Kişi' };
async function write(
  data: Record<string, unknown>,
  id?: string,
  key = crypto.randomUUID(),
  cookie = owner,
) {
  return f.request(
    '/api/customers' + (id ? '/' + id : ''),
    id ? 'PATCH' : 'POST',
    cookie,
    id
      ? data
      : {
          insurerNumber: { insurerId: 'reference-insurer', customerNumber: key },
          ...(data.type === 'COMPANY' ? { taxNumber: '0012345678' } : {}),
          ...data,
        },
    await f.csrf(cookie),
    { 'idempotency-key': key },
  );
}
async function dto(response: Response) {
  return ((await response.json()) as { data: CustomerDto }).data;
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('reference-owner', 'OWNER');
  await f.seed('reference-member');
  await f.seed('reference-other', 'OWNER', false, 'agency-other');
  await f.seed('reference-denied');
  f.env.IDENTITY_ENCRYPTION_KEY = '11'.repeat(32);
  f.env.IDENTITY_HMAC_KEY = '22'.repeat(32);
  f.env.IDENTITY_KEY_VERSION = '1';
  await f.db
    .prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('reference-insurer','agency-auth-test','REF','Sentetik Sigorta')",
    )
    .run();
  for (const permission of ['sensitive.identity.read', 'sensitive.identity.write'])
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,'UNSCOPED')",
      )
      .bind(crypto.randomUUID(), 'membership-reference-owner', permission)
      .run();
  await f.db
    .prepare(
      "UPDATE users SET display_name='Abdurrahman Işık',version=version+1 WHERE id='reference-member'",
    )
    .run();
  for (const [permission, scope] of [
    ['customer.read', 'ASSIGNED'],
    ['customer.create', 'UNSCOPED'],
    ['customer.update', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-reference-member', permission, scope)
      .run();
  owner = (await f.session('reference-owner')).cookie;
  member = (await f.session('reference-member')).cookie;
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('uses real employee names, limited directory data and rejects another agency or inactive employee', async () => {
  const response = await f.request('/api/customers/reference-options', 'GET', member);
  expect(response.status).toBe(200);
  const data = (await response.json()) as { data: { items: Record<string, unknown>[] } };
  expect(data.data.items).toContainEqual({
    membershipId: 'membership-reference-member',
    displayName: 'Abdurrahman Işık',
  });
  expect(
    data.data.items.every((p) => Object.keys(p).sort().join() === 'displayName,membershipId'),
  ).toBe(true);
  expect(data.data.items.some((p) => p.membershipId === 'membership-reference-other')).toBe(false);
  const denied = (await f.session('reference-denied')).cookie;
  expect((await f.request('/api/customers/reference-options', 'GET', denied)).status).toBe(403);
  expect(
    (await write({ ...individual, referenceMembershipId: 'membership-reference-other' })).status,
  ).toBe(400);
});
it('persists employee identity and birthday without changing assignment; filters both types in SQL with Turkish names', async () => {
  const customer = await dto(
    await write(
      {
        ...individual,
        birthDate: '1990-02-28',
        referenceMembershipId: 'membership-reference-member',
      },
      undefined,
      crypto.randomUUID(),
      member,
    ),
  );
  expect(customer.referenceName).toBe('Abdurrahman Işık');
  expect(customer.birthDate).toBe('1990-02-28');
  expect(customer.assigneeMembershipId).toBe('membership-reference-member');
  const company = await dto(
    await write({
      type: 'COMPANY',
      companyTitle: 'Sentetik Şirket',
      referenceName: 'Abdurrahman Işık',
    }),
  );
  const list = await f.request(
    '/api/customers?reference=ABDURRAHMAN%20I%C5%9EIK&limit=1',
    'GET',
    owner,
  );
  const page = (await list.json()) as {
    data: { items: CustomerDto[]; nextCursor: string; hasMore: boolean };
  };
  expect(page.data.items).toHaveLength(1);
  expect(page.data.hasMore).toBe(true);
  const second = await f.request(
    '/api/customers?reference=ABDURRAHMAN%20I%C5%9EIK&limit=1&cursor=' +
      encodeURIComponent(page.data.nextCursor),
    'GET',
    owner,
  );
  const other = ((await second.json()) as { data: { items: CustomerDto[] } }).data.items[0]!;
  expect(new Set([page.data.items[0]!.id, other.id])).toEqual(new Set([customer.id, company.id]));
  const exact = await f.request(
    '/api/customers?referenceMembershipId=membership-reference-member',
    'GET',
    owner,
  );
  expect(
    ((await exact.json()) as { data: { items: CustomerDto[] } }).data.items.map((p) => p.id),
  ).toEqual([customer.id]);
  const filtered = await f.request('/api/customers?reference=Abdurrahman', 'GET', member);
  expect(
    ((await filtered.json()) as { data: { items: CustomerDto[] } }).data.items.some(
      (p) => p.id === company.id,
    ),
  ).toBe(false);
});
it('rejects malformed/future/company dates and authority payloads without receipts or writes', async () => {
  for (const birthDate of ['2023-02-29', '2024-02-30', '2999-01-01', '01.01.1990', '0000-01-01'])
    expect((await write({ ...individual, birthDate })).status).toBe(400);
  expect(
    (await write({ type: 'COMPANY', companyTitle: 'Şirket', birthDate: '1990-01-01' })).status,
  ).toBe(400);
  expect((await write({ ...individual, referenceName: '  ' })).status).toBe(400);
  expect(
    (await write({ ...individual, assigneeMembershipId: 'membership-reference-member' })).status,
  ).toBe(400);
});
it('rolls back a customer write and its evidence if the selected employee changes after preflight', async () => {
  const original = f.env.DB;
  const writes = new WeakSet<D1PreparedStatement>();
  let changed = false;
  const key = crypto.randomUUID();
  f.env.DB = new Proxy(original, {
    get(target, field) {
      if (field === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('INSERT INTO customers')) return statement;
          return new Proxy(statement, {
            get(stmt, operation) {
              if (operation === 'bind')
                return (...values: unknown[]) => {
                  const bound = stmt.bind(...values);
                  writes.add(bound);
                  return bound;
                };
              const value = Reflect.get(stmt, operation);
              return typeof value === 'function' ? value.bind(stmt) : value;
            },
          });
        };
      if (field === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!changed && statements.some((s) => writes.has(s))) {
            changed = true;
            await f.db
              .prepare(
                "UPDATE users SET display_name='Yeni Ad',version=version+1 WHERE id='reference-member'",
              )
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, field);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const response = await write(
      { ...individual, referenceMembershipId: 'membership-reference-member' },
      undefined,
      key,
    );
    expect(changed).toBe(true);
    expect(response.ok).toBe(false);
    expect(
      await f.db
        .prepare('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?')
        .bind(key)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await f.db
        .prepare('SELECT count(*) n FROM audit_events WHERE idempotency_key=?')
        .bind(key)
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    f.env.DB = original;
    await f.db
      .prepare(
        "UPDATE users SET display_name='Abdurrahman Işık',version=version+1 WHERE id='reference-member'",
      )
      .run();
  }
});
it('preserves exact replay after reference deactivation and CAS, manual replacement, clearing and archive denial', async () => {
  const key = crypto.randomUUID();
  const payload = {
    ...individual,
    referenceMembershipId: 'membership-reference-member',
    birthDate: '2000-02-29',
  };
  const created = await dto(await write(payload, undefined, key));
  const patch = {
    expectedVersion: created.version,
    referenceName: 'Dış Referans',
    referenceMembershipId: null,
    birthDate: null,
  };
  const patchKey = crypto.randomUUID();
  expect((await write(patch, created.id, patchKey)).status).toBe(200);
  expect((await write({ ...patch, referenceName: 'Farklı' }, created.id)).status).toBe(409);
  await f.db
    .prepare(
      "UPDATE agency_memberships SET status='INACTIVE',inactivated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,permission_version=permission_version+1 WHERE id='membership-reference-member'",
    )
    .run();
  expect((await write(payload, undefined, key)).status).toBe(201);
  expect((await write(payload)).status).toBe(400);
  expect((await write(patch, created.id, patchKey)).status).toBe(200);
  const current = await dto(await f.request('/api/customers/' + created.id, 'GET', owner));
  expect(current).toMatchObject({
    referenceName: 'Dış Referans',
    referenceMembershipId: null,
    birthDate: null,
  });
  expect(
    (await write({ expectedVersion: current.version, referenceName: null }, created.id)).status,
  ).toBe(200);
  const cleared = await dto(await f.request('/api/customers/' + created.id, 'GET', owner));
  const archived = await f.request(
    '/api/customers/' + created.id + '/archive',
    'POST',
    owner,
    { expectedVersion: cleared.version, reasonCode: 'TEST_COMPLETE' },
    await f.csrf(owner),
    { 'idempotency-key': crypto.randomUUID() },
  );
  expect(archived.status).toBe(200);
  expect(
    (
      await write(
        { expectedVersion: cleared.version + 1, referenceName: 'Arşiv sonrası' },
        created.id,
      )
    ).status,
  ).toBe(409);
});
