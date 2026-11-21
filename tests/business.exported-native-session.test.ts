// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
// Node cannot resolve the workerd-only base class of the separately re-exported
// DO. Stub that UNUSED runtime base only; no auth/resolver/Worker dependency is
// injected. This is exported-handler + native D1 proof, not workerd KDF proof.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import worker from '../src/server/worker';
import { localAuthFixture } from './support/local-auth-fixture';
import {
  enableCompanyRegistration,
  registrationNumber,
  seedRegistrationInsurer,
} from './support/customer-registration-fixture';
import {
  randomSessionToken,
  hashSessionToken,
  sessionInsert,
  sessionCookie,
  type SessionRow,
} from '../src/server/auth/session';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const origin = 'https://panel.mayisigorta.com';
const insurer = 'exported-registration-insurer';
beforeAll(async () => {
  f = await localAuthFixture();
  const actor = await f.seed('exported-owner', 'OWNER');
  await enableCompanyRegistration(f, actor.membershipId);
  await seedRegistrationInsurer(f.db, actor.agencyId, insurer);
  f.env.DB = { prepare: f.db.prepare.bind(f.db), batch: f.db.batch.bind(f.db) } as D1Database;
});
afterAll(async () => {
  await f?.mf.dispose();
});
async function request(
  path: string,
  method = 'GET',
  cookie?: string,
  body?: unknown,
  csrf?: string,
  key?: string,
  headers: Record<string, string> = {},
) {
  return worker.fetch(
    new Request(new URL(path, origin), {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    f.env,
    {} as ExecutionContext,
  );
}
async function context(id = 'exported-owner') {
  const session = await f.session(id);
  const issued = await request('/api/csrf-token', 'GET', session.cookie);
  expect(issued.status).toBe(200);
  const parsed = (await issued.json()) as { data: { token: string } };
  return { ...session, csrf: parsed.data.token };
}
async function totals() {
  return Promise.all(
    ['customers', 'company_contacts', 'operation_receipts', 'audit_events'].map(
      async (table) =>
        (await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n,
    ),
  );
}
let nextTaxNumber = 9000000400;
const companyRegistration = () => ({
  type: 'COMPANY',
  companyTitle: 'Synthetic Native Company İ雪',
  taxNumber: String(nextTaxNumber++),
  insurerNumber: registrationNumber(insurer),
});
it('default exported Worker NORMAL -> me -> CSRF -> company/contact/read; exact retry one effect/receipt/audit', async () => {
  const c = await context();
  const company = companyRegistration();
  const me = await request('/api/me', 'GET', c.cookie);
  expect(me.status).toBe(200);
  const before = await totals(),
    key = crypto.randomUUID();
  const created = await request('/api/customers', 'POST', c.cookie, company, c.csrf, key);
  expect(created.status).toBe(201);
  const first = (await created.json()) as { data: { id: string; version: number } };
  const retry = await request('/api/customers', 'POST', c.cookie, company, c.csrf, key);
  expect([200, 201].includes(retry.status)).toBe(true);
  const replay = (await retry.json()) as { data: { id: string } };
  expect(first.data.id === replay.data.id).toBe(true);
  const after = await totals();
  expect(after.map((v, i) => v - before[i]!)).toEqual([1, 0, 1, 1]);
  const conflict = await request(
    '/api/customers',
    'POST',
    c.cookie,
    { ...company, companyTitle: 'Different payload' },
    c.csrf,
    key,
  );
  expect(conflict.status).toBe(409);
  const contactKey = crypto.randomUUID(),
    payload = { firstName: 'Synthetic', lastName: 'Contact', isPrimary: true };
  const contact = await request(
    `/api/customers/${first.data.id}/contacts`,
    'POST',
    c.cookie,
    payload,
    c.csrf,
    contactKey,
  );
  expect(contact.status).toBe(201);
  const contactRetry = await request(
    `/api/customers/${first.data.id}/contacts`,
    'POST',
    c.cookie,
    payload,
    c.csrf,
    contactKey,
  );
  expect([200, 201].includes(contactRetry.status)).toBe(true);
  const afterContact = await totals();
  expect(afterContact.map((v, i) => v - after[i]!)).toEqual([0, 1, 1, 1]);
  const read = await request(`/api/customers/${first.data.id}`, 'GET', c.cookie);
  expect(read.status).toBe(200);
  expect(read.headers.get('cache-control')?.includes('no-store')).toBe(true);
  const update = await request(
    `/api/customers/${first.data.id}`,
    'PATCH',
    c.cookie,
    { expectedVersion: first.data.version, companyTitle: 'Synthetic Updated' },
    c.csrf,
    crypto.randomUUID(),
  );
  expect(update.status).toBe(200);
  const stale = await request(
    `/api/customers/${first.data.id}`,
    'PATCH',
    c.cookie,
    { expectedVersion: first.data.version, companyTitle: 'Stale overwrite' },
    c.csrf,
    crypto.randomUUID(),
  );
  expect(stale.status).toBe(409);
});
it('default composition rejects missing/wrong-session CSRF, PHP sibling origin and alternate host without business effects', async () => {
  const company = companyRegistration();
  const c = await context(),
    other = await context();
  const before = await totals();
  for (const [csrf, extra] of [
    [undefined, {}],
    [other.csrf, {}],
    [c.csrf, { origin: 'https://mayisigorta.com' }],
  ] as Array<[string | undefined, Record<string, string>]>)
    expect(
      (await request('/api/customers', 'POST', c.cookie, company, csrf, crypto.randomUUID(), extra))
        .status,
    ).toBe(403);
  expect(
    (
      await request(
        'https://alternate.example.invalid/api/customers',
        'POST',
        c.cookie,
        company,
        c.csrf,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(403);
  expect(await totals()).toEqual(before);
});
it('default composition denies absent/revoked/expired/ACTIVATION session without mutation', async () => {
  const before = await totals();
  expect((await request('/api/me')).status).toBe(401);
  const revoked = await context();
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), revoked.hash)
    .run();
  expect((await request('/api/me', 'GET', revoked.cookie)).status).toBe(401);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 43200001);
  let expired: Awaited<ReturnType<typeof f.session>>;
  try {
    expired = await f.session('exported-owner');
  } finally {
    clock.mockRestore();
  }
  expect((await request('/api/me', 'GET', expired.cookie)).status).toBe(401);
  const temporary = await f.seed('exported-temp', 'MEMBER', true);
  const row = await f.db
    .prepare(
      'SELECT c.user_id,c.identity_id,m.id membership_id,c.credential_version,m.permission_version FROM local_credentials c JOIN agency_memberships m ON m.user_id=c.user_id WHERE c.user_id=?',
    )
    .bind(temporary.id)
    .first<SessionRow>();
  const token = randomSessionToken(),
    now = Date.now();
  await sessionInsert(
    f.db,
    await hashSessionToken(token),
    row!,
    'ACTIVATION',
    now,
    now + 600000,
  ).run();
  expect((await request('/api/customers', 'GET', sessionCookie(token, now + 600000))).status).toBe(
    401,
  );
  expect(await totals()).toEqual(before);
});
it('default composition rechecks authorization on receipt replay and hides unassigned/cross-agency customers', async () => {
  const root = await context();
  const created = await request(
    '/api/customers',
    'POST',
    root.cookie,
    companyRegistration(),
    root.csrf,
    crypto.randomUUID(),
  );
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { data: { id: string } }).data.id;
  const member = await f.seed('exported-member');
  await enableCompanyRegistration(f, member.membershipId);
  for (const [code, scope] of [
    ['customer.read', 'ASSIGNED'],
    ['customer.update', 'ASSIGNED'],
    ['customer.create', 'UNSCOPED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), member.membershipId, code, scope)
      .run();
  const c = await context(member.id);
  expect((await request(`/api/customers/${id}`, 'GET', c.cookie)).status).toBe(404);
  const company = companyRegistration();
  const key = crypto.randomUUID(),
    own = await request('/api/customers', 'POST', c.cookie, company, c.csrf, key);
  expect(own.status).toBe(201);
  const ownId = ((await own.json()) as { data: { id: string } }).data.id;
  expect((await request(`/api/customers/${ownId}`, 'GET', c.cookie)).status).toBe(200);
  const foreign = await f.seed('exported-other-owner', 'OWNER', false, 'agency-exported-other');
  const fc = await context(foreign.id);
  expect((await request(`/api/customers/${ownId}`, 'GET', fc.cookie)).status).toBe(404);
  await f.db
    .prepare(
      'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
    )
    .bind(member.membershipId)
    .run();
  const before = await totals();
  expect((await request('/api/customers', 'POST', c.cookie, company, c.csrf, key)).status).toBe(
    401,
  );
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='customer.create'",
    )
    .bind(member.membershipId)
    .run();
  const renewed = await context(member.id);
  expect(
    (await request('/api/customers', 'POST', renewed.cookie, company, renewed.csrf, key)).status,
  ).toBe(403);
  expect(await totals()).toEqual(before);
});
it('actual default Worker final mutation batch session revoke rolls back business+receipt+SUCCESS audit', async () => {
  const c = await context(),
    before = await totals();
  const batch = f.env.DB.batch.bind(f.env.DB),
    prepare = f.env.DB.prepare.bind(f.env.DB);
  let businessPrepared = false,
    arrivals = 0;
  const p = vi.spyOn(f.env.DB, 'prepare').mockImplementation((sql) => {
    if (sql.includes('INSERT INTO audit_events')) businessPrepared = true;
    return prepare(sql);
  });
  const b = vi.spyOn(f.env.DB, 'batch').mockImplementation(async (statements) => {
    if (businessPrepared) {
      arrivals++;
      businessPrepared = false;
      await f.db
        .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
        .bind(Date.now(), c.hash)
        .run();
    }
    return batch(statements);
  });
  try {
    const response = await request(
      '/api/customers',
      'POST',
      c.cookie,
      companyRegistration(),
      c.csrf,
      crypto.randomUUID(),
    );
    expect(response.status).toBe(409);
    expect(arrivals).toBe(1);
    expect(await totals()).toEqual(before);
  } finally {
    b.mockRestore();
    p.mockRestore();
  }
});
