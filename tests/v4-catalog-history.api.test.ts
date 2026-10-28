// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDemo, DEMO_ORIGIN, DEMO_USERS } from '../scripts/demo/application';
let d: Awaited<ReturnType<typeof openDemo>>, cookie: string;
beforeAll(async () => {
  const secrets = DEMO_USERS.map(() => randomUUID() + randomUUID());
  d = await openDemo(secrets);
  const r = await d.fetch(
    new Request(DEMO_ORIGIN + '/api/auth/login', {
      method: 'POST',
      headers: { origin: DEMO_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_USERS[0]!.email, password: secrets[0] }),
    }),
  );
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  secrets.fill('');
}, 120000);
afterAll(async () => {
  await d?.dispose();
});
async function call(path: string, method = 'GET', body?: unknown) {
  const headers: Record<string, string> = {
    cookie,
    origin: DEMO_ORIGIN,
    'content-type': 'application/json',
  };
  if (method !== 'GET') {
    const c = (await (await call('/api/csrf-token')).json()) as { data: { token: string } };
    headers['x-csrf-token'] = c.data.token;
    headers['idempotency-key'] = randomUUID();
  }
  return d.fetch(
    new Request(DEMO_ORIGIN + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
it('used product branch change is an actionable conflict and never rewrites historical policy ids', async () => {
  const r = await call('/api/catalogs/branches', 'POST', {
    code: 'V4HISTORY',
    name: 'Sentetik Ek Branş',
  });
  expect(r.status).toBe(201);
  const branch = ((await r.json()) as { data: { id: string } }).data;
  const p = (await (await call('/api/catalogs/products/demo-product')).json()) as {
    data: { version: number; branchId: string };
  };
  const changed = await call('/api/catalogs/products/demo-product', 'PATCH', {
    expectedVersion: p.data.version,
    name: 'Sentetik değişiklik',
    branchId: branch.id,
  });
  expect(changed.status).toBe(409);
  expect(((await changed.json()) as { error: { code: string } }).error.code).toBe(
    'CATALOG_RELATION_IN_USE',
  );
  expect(
    await d.db
      .prepare("SELECT branch_id FROM policies WHERE id='demo-policy-0'")
      .first('branch_id'),
  ).toBe('demo-branch');
  expect(
    await d.db
      .prepare("SELECT branch_id FROM insurance_products WHERE id='demo-product'")
      .first('branch_id'),
  ).toBe('demo-branch');
  expect((await d.db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
});
