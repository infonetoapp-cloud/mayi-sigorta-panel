// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  owner: string,
  full: string,
  ordinary: string,
  foreign: string;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('catalog-v4-owner', 'OWNER');
  const m = await f.seed('catalog-v4-full');
  await f.seed('catalog-v4-ordinary');
  await f.seed('catalog-v4-foreign', 'OWNER', false, 'catalog-other');
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'catalog.manage','UNSCOPED')",
    )
    .bind(crypto.randomUUID(), m.membershipId)
    .run();
  owner = (await f.session('catalog-v4-owner')).cookie;
  full = (await f.session('catalog-v4-full')).cookie;
  ordinary = (await f.session('catalog-v4-ordinary')).cookie;
  foreign = (await f.session('catalog-v4-foreign')).cookie;
});
afterAll(async () => {
  await f?.mf.dispose();
});
async function write(
  path: string,
  method: string,
  body: unknown,
  cookie = full,
  key = crypto.randomUUID(),
) {
  return f.request(path, method, cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}
it('catalog capability is actor-derived, never grants authority to an ordinary MEMBER', async () => {
  for (const [cookie, want] of [
    [owner, true],
    [full, true],
    [ordinary, false],
  ] as const) {
    const r = await f.request('/api/catalogs/capabilities', 'GET', cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(((await r.json()) as { data: { canManage: boolean } }).data.canManage).toBe(want);
  }
  expect(
    (await write('/api/catalogs/insurers', 'POST', { code: 'DENY', name: 'Sentetik' }, ordinary))
      .status,
  ).toBe(403);
});
it('authorized employee creates, replays and edits catalogs while foreign agency cannot resolve its identifier', async () => {
  const body = { code: 'V4CATALOG', name: 'Sentetik V4 Sigortacı' },
    key = crypto.randomUUID();
  const r = await write('/api/catalogs/insurers', 'POST', body, full, key);
  expect(r.status).toBe(201);
  const created = ((await r.json()) as { data: { id: string; version: number } }).data;
  expect((await write('/api/catalogs/insurers', 'POST', body, full, key)).status).toBe(201);
  expect(
    await f.db.prepare("SELECT count(*) n FROM insurers WHERE code='V4CATALOG'").first('n'),
  ).toBe(1);
  expect((await f.request('/api/catalogs/insurers/' + created.id, 'GET', foreign)).status).toBe(
    404,
  );
  expect(
    (
      await write(
        '/api/catalogs/insurers/' + created.id,
        'PATCH',
        { expectedVersion: 1, name: 'Başka acente' },
        foreign,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await write('/api/catalogs/insurers/' + created.id, 'PATCH', {
        expectedVersion: 1,
        name: 'Güncel sentetik ad',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await write('/api/catalogs/insurers/' + created.id, 'PATCH', {
        expectedVersion: 1,
        name: 'Eski taslak',
      })
    ).status,
  ).toBe(409);
  expect((await write('/api/catalogs/insurers', 'POST', body)).status).toBe(409);
  expect(
    (await write('/api/catalogs/insurers', 'POST', { code: 'invalid code', name: '' })).status,
  ).toBe(400);
});
