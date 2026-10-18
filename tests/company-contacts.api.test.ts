// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { CompanyContactDto, CustomerDetailDto } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, ahmet: string, ayse: string, denied: string, foreign: string, path: string;
let first: CompanyContactDto, second: CompanyContactDto;
async function send(
  suffix: string,
  method: string,
  body: unknown,
  cookie = owner,
  key = crypto.randomUUID(),
  csrf?: string,
) {
  return f.request(path + suffix, method, cookie, body, csrf ?? (await f.csrf(cookie)), {
    'idempotency-key': key,
  });
}
async function data<T>(response: Response, status: number): Promise<T> {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}
async function current(cookie = owner) {
  return data<CustomerDetailDto>(await f.request(path, 'GET', cookie), 200);
}
async function snapshot() {
  return JSON.stringify({
    customer: await f.db
      .prepare('SELECT * FROM customers WHERE id=?')
      .bind(path.split('/').at(-1))
      .first(),
    contacts: (
      await f.db
        .prepare('SELECT * FROM company_contacts WHERE customer_id=? ORDER BY id')
        .bind(path.split('/').at(-1))
        .all()
    ).results,
    receipts: await f.db.prepare('SELECT count(*) count FROM operation_receipts').first(),
    audit: await f.db
      .prepare("SELECT count(*) count FROM audit_events WHERE outcome='SUCCESS'")
      .first(),
  });
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('contacts-owner', 'OWNER');
  for (const id of ['contacts-ahmet', 'contacts-ayse']) {
    const member = await f.seed(id);
    await f.db.batch(
      createOnboardingTemplateGrants('personel').map((grant) =>
        f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), member.membershipId, grant.permission_code, grant.scope),
      ),
    );
  }
  await f.seed('contacts-denied');
  await f.seed('contacts-foreign', 'OWNER', false, 'contacts-foreign-agency');
  owner = (await f.session('contacts-owner')).cookie;
  ahmet = (await f.session('contacts-ahmet')).cookie;
  ayse = (await f.session('contacts-ayse')).cookie;
  denied = (await f.session('contacts-denied')).cookie;
  foreign = (await f.session('contacts-foreign')).cookie;
  const company = await data<{ id: string }>(
    await f.request(
      '/api/customers',
      'POST',
      owner,
      { type: 'COMPANY', companyTitle: 'Sentetik Ortak Şirket' },
      await f.csrf(owner),
      { 'idempotency-key': crypto.randomUUID() },
    ),
    201,
  );
  path = '/api/customers/' + company.id;
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('allows OWNER and two ordinary employees to collaborate on contacts with exact mutation replay', async () => {
  first = await data(
    await send('/contacts', 'POST', { firstName: 'İlk', lastName: 'Yetkili', isPrimary: true }),
    201,
  );
  const createKey = crypto.randomUUID(),
    createBody = { firstName: 'Ortak', lastName: 'Yetkili', role: 'Finans' };
  second = await data(await send('/contacts', 'POST', createBody, ahmet, createKey), 201);
  expect(
    (
      await data<CompanyContactDto>(
        await send('/contacts', 'POST', createBody, ahmet, createKey),
        201,
      )
    ).id,
  ).toBe(second.id);
  second = await data(
    await send(
      '/contacts/' + second.id,
      'PATCH',
      { expectedVersion: second.version, email: 'shared@demo.invalid' },
      ayse,
    ),
    200,
  );
  const primaryKey = crypto.randomUUID(),
    primaryBody = { expectedVersion: second.version };
  second = await data(
    await send('/contacts/' + second.id + '/set-primary', 'POST', primaryBody, ayse, primaryKey),
    200,
  );
  await data(
    await send('/contacts/' + second.id + '/set-primary', 'POST', primaryBody, ayse, primaryKey),
    200,
  );
  expect(
    (await current(ahmet))
      .contacts!.filter((c) => c.status === 'ACTIVE' && c.isPrimary)
      .map((c) => c.id),
  ).toEqual([second.id]);
  const deactivateKey = crypto.randomUUID(),
    deactivateBody = { expectedVersion: second.version };
  second = await data(
    await send(
      '/contacts/' + second.id + '/deactivate',
      'POST',
      deactivateBody,
      ahmet,
      deactivateKey,
    ),
    200,
  );
  await data(
    await send(
      '/contacts/' + second.id + '/deactivate',
      'POST',
      deactivateBody,
      ahmet,
      deactivateKey,
    ),
    200,
  );
  const history = await current(ayse);
  expect(history.contacts).toHaveLength(2);
  expect(history.contacts!.find((c) => c.id === second.id)).toMatchObject({
    status: 'INACTIVE',
    isPrimary: false,
    email: 'shared@demo.invalid',
  });
  first = await data(
    await send('/contacts/' + first.id + '/set-primary', 'POST', {
      expectedVersion: first.version,
    }),
    200,
  );
});
it('keeps competing expected-version updates and primary reset rollback atomic', async () => {
  const csrf = await f.csrf(ayse),
    target = (await current()).contacts!.find((c) => c.id === first.id)!;
  const outcomes = await Promise.all(
    ['A', 'B'].map((role) =>
      send(
        '/contacts/' + first.id,
        'PATCH',
        { expectedVersion: target.version, role },
        ayse,
        crypto.randomUUID(),
        csrf,
      ),
    ),
  );
  expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
  const other = await data<CompanyContactDto>(
    await send('/contacts', 'POST', { firstName: 'Üçüncü', lastName: 'Yetkili' }),
    201,
  );
  const before = await snapshot();
  expect(
    (
      await send('/contacts/' + other.id + '/set-primary', 'POST', {
        expectedVersion: other.version + 1,
      })
    ).status,
  ).toBe(409);
  expect((await snapshot()) === before).toBe(true);
  expect(
    (await current()).contacts!.filter((c) => c.status === 'ACTIVE' && c.isPrimary),
  ).toHaveLength(1);
});
it('denies cross-agency, ungranted and revoked-session contact writes without effects', async () => {
  const before = await snapshot();
  for (const cookie of [foreign, denied]) {
    expect((await f.request(path, 'GET', cookie)).status).toBe(404);
    expect(
      (await send('/contacts', 'POST', { firstName: 'Denied', lastName: 'Write' }, cookie)).status,
    ).toBe(404);
  }
  const revoked = await f.session('contacts-ahmet'),
    csrf = await f.csrf(revoked.cookie);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), revoked.hash)
    .run();
  expect(
    (
      await send(
        '/contacts',
        'POST',
        { firstName: 'Denied', lastName: 'Write' },
        revoked.cookie,
        crypto.randomUUID(),
        csrf,
      )
    ).status,
  ).toBe(401);
  expect((await snapshot()) === before).toBe(true);
});
it('retains archived history while rejecting every new company-contact write', async () => {
  const company = await current();
  await data(
    await send('/archive', 'POST', { expectedVersion: company.version, reasonCode: 'DEMO_CLOSED' }),
    200,
  );
  const before = await snapshot(),
    target = (await current()).contacts!.find((c) => c.id === first.id)!;
  for (const [suffix, method, payload] of [
    ['/contacts', 'POST', { firstName: 'New', lastName: 'Denied', isPrimary: true }],
    ['/contacts/' + target.id, 'PATCH', { expectedVersion: target.version, role: 'Denied' }],
    ['/contacts/' + target.id + '/set-primary', 'POST', { expectedVersion: target.version }],
    ['/contacts/' + target.id + '/deactivate', 'POST', { expectedVersion: target.version }],
  ] as const)
    expect((await send(suffix, method, payload)).status).toBe(409);
  expect((await snapshot()) === before).toBe(true);
  expect((await current(ayse)).contacts).toHaveLength(3);
});
