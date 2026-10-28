// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>, owner: string, member: string, target: string;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('v4-owner', 'OWNER');
  await f.seed('v4-member');
  for (let i = 0; i < 51; i++) await f.seed('v4-page-' + String(i).padStart(3, '0'));
  const t = await f.seed('zzz-v4-target');
  target = t.membershipId;
  await f.db
    .prepare('UPDATE users SET display_name=?,version=version+1 WHERE id=?')
    .bind('Çağla IŞIK', 'zzz-v4-target')
    .run();
  await f.seed('v4-foreign', 'OWNER', false, 'foreign-v4-agency');
  await f.db
    .prepare('UPDATE users SET display_name=?,version=version+1 WHERE id=?')
    .bind('Çağla IŞIK', 'v4-foreign')
    .run();
  owner = (await f.session('v4-owner')).cookie;
  member = (await f.session('v4-member')).cookie;
}, 120000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('searches authorized personnel beyond the loaded first page and keeps an existing foreign agency invisible', async () => {
  const first = await f.request('/api/personnel?page_size=50', 'GET', owner);
  const a = (await first.json()) as { data: { personnel: { id: string }[]; nextCursor: string } };
  expect(a.data.personnel).toHaveLength(50);
  expect(a.data.personnel.some((p) => p.id === target)).toBe(false);
  const r = await f.request(
    '/api/personnel?search=' + encodeURIComponent('ÇAĞLA IŞIK'),
    'GET',
    owner,
  );
  expect(r.status).toBe(200);
  const d = (await r.json()) as typeof a;
  expect(d.data.personnel.map((p) => p.id)).toEqual([target]);
});
it('supports email search while MEMBER management search is denied', async () => {
  expect((await f.request('/api/personnel?search=v4-owner', 'GET', member)).status).toBe(403);
  const r = await f.request('/api/personnel?search=zzz-v4-target%40example.invalid', 'GET', owner);
  expect(r.status).toBe(200);
  const d = (await r.json()) as { data: { personnel: { id: string }[] } };
  expect(d.data.personnel.map((p) => p.id)).toEqual([target]);
});
it('treats SQL and wildcard-looking search strings as literal bounded input', async () => {
  for (const q of ["' OR 1=1 --", '%', '_']) {
    const r = await f.request('/api/personnel?search=' + encodeURIComponent(q), 'GET', owner);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { data: { personnel: unknown[] } };
    expect(d.data.personnel).toHaveLength(0);
  }
  expect((await f.request('/api/personnel?search=' + 'x'.repeat(121), 'GET', owner)).status).toBe(
    400,
  );
});
