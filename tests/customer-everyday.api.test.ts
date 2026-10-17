// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { CustomerDto } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, employee: string, denied: string;
const body = {
  type: 'INDIVIDUAL',
  firstName: 'Sentetik',
  lastName: 'Müşteri',
  email: null,
  phone: null,
  address: null,
};
async function write(
  path: string,
  method: 'POST' | 'PATCH',
  data: unknown,
  cookie = owner,
  key = crypto.randomUUID(),
) {
  return f.request(path, method, cookie, data, await f.csrf(cookie), { 'idempotency-key': key });
}
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('everyday-owner', 'OWNER');
  const user = await f.seed('everyday-member');
  await f.seed('everyday-denied');
  await f.db.batch(
    createOnboardingTemplateGrants('personel').map((grant) =>
      f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), user.membershipId, grant.permission_code, grant.scope),
    ),
  );
  owner = (await f.session('everyday-owner')).cookie;
  employee = (await f.session('everyday-member')).cookie;
  denied = (await f.session('everyday-denied')).cookie;
});
afterAll(async () => {
  await f?.mf.dispose();
});
async function state(id: string, key: string) {
  return {
    customer: await f.db
      .prepare(
        'SELECT display_name,email,phone,address,version,updated_at,archived_at,archived_by_membership_id,archive_reason_code FROM customers WHERE id=?',
      )
      .bind(id)
      .first(),
    receipt: await f.db
      .prepare('SELECT count(*) count FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
    audit: await f.db
      .prepare(
        "SELECT count(*) count FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'",
      )
      .bind(key)
      .first(),
  };
}
it('holds PATCH after all preflights while a real archive commits, then rolls back all PATCH evidence', async () => {
  const customer = (
    (await (await write('/api/customers', 'POST', body)).json()) as { data: CustomerDto }
  ).data;
  const path = `/api/customers/${customer.id}`,
    key = crypto.randomUUID();
  const token = await f.csrf(owner);
  const original = f.env.DB;
  const updates = new WeakSet<D1PreparedStatement>();
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  f.env.DB = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/UPDATE customers\s+SET display_name/.test(sql)) return statement;
          return new Proxy(statement, {
            get(stmt, field) {
              if (field === 'bind')
                return (...values: unknown[]) => {
                  const bound = stmt.bind(...values);
                  updates.add(bound);
                  return bound;
                };
              const value = Reflect.get(stmt, field);
              return typeof value === 'function' ? value.bind(stmt) : value;
            },
          });
        };
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!held && statements.some((statement) => updates.has(statement))) {
            held = true;
            arrived();
            await gate;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let pending: Promise<Response> | undefined;
  try {
    pending = f.request(
      path,
      'PATCH',
      owner,
      { expectedVersion: customer.version, email: 'racing@demo.invalid' },
      token,
      { 'idempotency-key': key },
    );
    await Promise.race([
      ready,
      pending.then(() => {
        throw new Error('PATCH_DID_NOT_REACH_BATCH_BARRIER');
      }),
    ]);
    expect(
      (
        await write(`${path}/archive`, 'POST', {
          expectedVersion: customer.version,
          reasonCode: 'RACE_CLOSED',
        })
      ).status,
    ).toBe(200);
    const before = await state(customer.id, key);
    release();
    expect((await pending).status).toBe(409);
    expect(await state(customer.id, key)).toEqual(before);
    expect(before.receipt).toEqual({ count: 0 });
    expect(before.audit).toEqual({ count: 0 });
    const history = await f.request(path, 'GET', employee);
    expect(history.status).toBe(200);
    expect(((await history.json()) as { data: CustomerDto }).data.archivedAt).toBeTruthy();
  } finally {
    release();
    await pending;
    f.env.DB = original;
  }
});
it('creates both customer types with exact replay and rejects changed-key payload reuse', async () => {
  for (const data of [
    body,
    {
      type: 'COMPANY',
      companyTitle: 'Sentetik Şirket',
      email: 'fiction@demo.invalid',
      phone: null,
      address: null,
    },
  ]) {
    const key = crypto.randomUUID();
    const first = await write('/api/customers', 'POST', data, employee, key);
    expect(first.status).toBe(201);
    const result = (await first.json()) as { data: CustomerDto };
    const replay = await write('/api/customers', 'POST', data, employee, key);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { data: CustomerDto }).data.id).toBe(result.data.id);
    const conflict = await write(
      '/api/customers',
      'POST',
      { ...data, email: 'different@demo.invalid' },
      employee,
      key,
    );
    expect(conflict.status).toBe(409);
    expect(
      await f.db
        .prepare('SELECT count(*) count FROM customers WHERE id=?')
        .bind(result.data.id)
        .first(),
    ).toEqual({ count: 1 });
  }
});
it('preserves CAS conflict, exact PATCH replay, and archive mutation denial', async () => {
  const created = await write('/api/customers', 'POST', body);
  const customer = ((await created.json()) as { data: CustomerDto }).data;
  const path = `/api/customers/${customer.id}`;
  const update = { expectedVersion: customer.version, email: 'updated@demo.invalid' },
    key = crypto.randomUUID();
  const first = await write(path, 'PATCH', update, employee, key);
  expect(first.status).toBe(200);
  const replay = await write(path, 'PATCH', update, employee, key);
  expect(replay.status).toBe(200);
  const stale = await write(
    path,
    'PATCH',
    { expectedVersion: customer.version, email: 'stale@demo.invalid' },
    owner,
  );
  expect(stale.status).toBe(409);
  const current = ((await (await f.request(path, 'GET', owner)).json()) as { data: CustomerDto })
    .data;
  expect(current.email).toBe('updated@demo.invalid');
  expect(current.version).toBe(customer.version + 1);
  expect(
    (
      await write(`${path}/archive`, 'POST', {
        expectedVersion: current.version,
        reasonCode: 'DEMO_CLOSED',
      })
    ).status,
  ).toBe(200);
  const blockedKey = crypto.randomUUID();
  const before = await state(customer.id, blockedKey);
  const blocked = await write(
    path,
    'PATCH',
    {
      expectedVersion: current.version + 1,
      address: 'Yazılmamalı',
    },
    owner,
    blockedKey,
  );
  expect(blocked.status).toBe(409);
  expect(await state(customer.id, blockedKey)).toEqual(before);
  expect(before.receipt).toEqual({ count: 0 });
  expect(before.audit).toEqual({ count: 0 });
  const replayState = await state(customer.id, key);
  const historicalReplay = await write(path, 'PATCH', update, employee, key);
  expect(historicalReplay.status).toBe(200);
  expect(await historicalReplay.json()).toMatchObject({
    data: { id: customer.id, email: 'updated@demo.invalid', version: customer.version + 1 },
  });
  expect(await state(customer.id, key)).toEqual(replayState);
  expect(replayState.receipt).toEqual({ count: 1 });
  expect(replayState.audit).toEqual({ count: 1 });
  const read = await f.request(path, 'GET', owner);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { data: CustomerDto }).data.archivedAt).toBeTruthy();
  const foreign = await f.seed('everyday-foreign', 'OWNER', false, 'agency-foreign-everyday');
  const foreignCookie = (await f.session(foreign.id)).cookie;
  expect((await f.request(path, 'GET', foreignCookie)).status).toBe(404);
  expect(
    (
      await write(
        path,
        'PATCH',
        { expectedVersion: current.version + 1, address: 'Foreign' },
        foreignCookie,
      )
    ).status,
  ).toBe(404);
  expect(await state(customer.id, key)).toEqual(replayState);
  const noAuthorityReplay = await write(path, 'PATCH', update, denied, key);
  expect(noAuthorityReplay.status).toBe(404);
  const grant = await f.db
    .prepare(
      "SELECT id,membership_id,permission_code,scope FROM membership_permissions WHERE membership_id='membership-everyday-member' AND permission_code='customer.update'",
    )
    .first<{ id: string; membership_id: string; permission_code: string; scope: string }>();
  const replayCsrf = await f.csrf(employee);
  try {
    await f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grant!.id).run();
    const revokedReplay = await f.request(path, 'PATCH', employee, update, replayCsrf, {
      'idempotency-key': key,
    });
    expect([401, 403, 404]).toContain(revokedReplay.status);
    expect(await state(customer.id, key)).toEqual(replayState);
  } finally {
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(grant!.id, grant!.membership_id, grant!.permission_code, grant!.scope)
      .run();
  }
  expect(
    await f.db.prepare('SELECT email,address FROM customers WHERE id=?').bind(customer.id).first(),
  ).toEqual({ email: 'updated@demo.invalid', address: null });
});
it('rejects create/update without grants and client-supplied authority fields', async () => {
  expect((await write('/api/customers', 'POST', body, denied)).status).toBe(403);
  expect((await write('/api/customers', 'POST', { ...body, agencyId: 'foreign' })).status).toBe(
    400,
  );
  const created = (
    (await (await write('/api/customers', 'POST', body)).json()) as { data: CustomerDto }
  ).data;
  expect(
    (
      await write(
        `/api/customers/${created.id}`,
        'PATCH',
        { expectedVersion: created.version, email: 'denied@demo.invalid' },
        denied,
      )
    ).status,
  ).toBe(404);
});
