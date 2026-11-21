// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { verifyOperationalRecovery } from '../scripts/recovery/operational-data-proof';
import type { CustomerVehicle } from '../src/shared/vehicles';
import type { PolicyDetailDto } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>, owner: string, member: string, foreign: string;
const details = {
  plate: '34 DFL 537',
  brand: 'Mercedes',
  model: 'E200',
  modelYear: 2020,
  vin: 'W-000123',
  engineNumber: '000789',
  registrationSerial: 'AB123456',
};
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('vehicle-owner', 'OWNER');
  await f.seed('vehicle-member');
  await f.seed('vehicle-other', 'OWNER', false, 'vehicle-other-agency');
  owner = (await f.session('vehicle-owner')).cookie;
  member = (await f.session('vehicle-member')).cookie;
  foreign = (await f.session('vehicle-other')).cookie;
  for (const code of ['customer.read', 'customer.update', 'policy.read', 'policy.update'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-vehicle-member', code, 'ASSIGNED')
      .run();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('vehicle-i','agency-auth-test','VEH','Örnek Sigorta')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification,supports_vehicle_details) VALUES('vehicle-b','agency-auth-test','VEH','Kasko','GENERAL',1)",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('vehicle-product','agency-auth-test','vehicle-i','vehicle-b','VEH','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('vehicle-pay','agency-auth-test','VEH','Nakit')",
    ),
  ]);
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function customer(id: string, assignee = 'membership-vehicle-member') {
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,'agency-auth-test','INDIVIDUAL','Örnek Kişi','Örnek','Kişi',?)",
    )
    .bind(id, assignee)
    .run();
  return id;
}
async function write(
  path: string,
  body: unknown,
  cookie = owner,
  key = crypto.randomUUID(),
  method = 'PUT',
) {
  return f.request('/api/' + path, method, cookie, body, await f.csrf(cookie), {
    'idempotency-key': key,
  });
}
async function createVehicle(id: string, key = crypto.randomUUID(), cookie = owner) {
  const r = await write(
    `customers/${id}/vehicles`,
    { expectedVersion: 1, details, status: 'ACTIVE' },
    cookie,
    key,
    'POST',
  );
  expect(r.status).toBe(201);
  return ((await r.json()) as { data: CustomerVehicle }).data;
}
async function policy(customerId: string, number: string) {
  const r = await write(
    'policies',
    {
      customerId,
      insurerId: 'vehicle-i',
      productId: 'vehicle-product',
      branchId: 'vehicle-b',
      paymentMethodId: 'vehicle-pay',
      policyNumber: number,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      grossPremium: '123.45',
      currency: 'TRY',
      installmentCount: null,
    },
    owner,
    crypto.randomUUID(),
    'POST',
  );
  expect(r.status).toBe(201);
  return ((await r.json()) as { data: { id: string } }).data.id;
}
async function readPolicy(id: string) {
  const r = await f.request('/api/policies/' + id, 'GET', owner);
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: PolicyDetailDto }).data;
}
it('stores multiple vehicles, normalizes duplicate plates, preserves leading zeros and CAS/replay', async () => {
  const id = await customer('vehicle-c1'),
    key = crypto.randomUUID();
  const vehicle = await createVehicle(id, key, member);
  expect(vehicle.details.engineNumber).toBe('000789');
  expect(
    (
      await write(
        `customers/${id}/vehicles`,
        { expectedVersion: 1, details, status: 'ACTIVE' },
        member,
        key,
        'POST',
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await write(
        `customers/${id}/vehicles`,
        { expectedVersion: 2, details: { ...details, plate: '34dfl537' }, status: 'ACTIVE' },
        member,
        crypto.randomUUID(),
        'POST',
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await write(
        `customers/${id}/vehicles`,
        { expectedVersion: 2, details: { ...details, plate: '06 ABC 001' }, status: 'ACTIVE' },
        member,
        crypto.randomUUID(),
        'POST',
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await write(
        `customers/${id}/vehicles/${vehicle.id}`,
        {
          expectedVersion: 1,
          expectedVehicleVersion: 1,
          details: { ...details, model: 'Yeni' },
          status: 'ACTIVE',
        },
        member,
      )
    ).status,
  ).toBe(409);
  const read = await f.request(`/api/customers/${id}/vehicles`, 'GET', member);
  expect(((await read.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(2);
});
it('allows every vehicle field to be omitted and multiple unknown plates without inventing identifiers', async () => {
  const id = await customer('vehicle-optional');
  for (const version of [1, 2]) {
    const response = await write(
      `customers/${id}/vehicles`,
      { expectedVersion: version, details: {} },
      owner,
      crypto.randomUUID(),
      'POST',
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { data: CustomerVehicle }).data.details).toEqual({
      plate: null,
      brand: null,
      model: null,
      modelYear: null,
      vin: null,
      engineNumber: null,
      registrationSerial: null,
    });
  }
  expect(
    await f.db
      .prepare(
        'SELECT count(*) n FROM customer_vehicles WHERE customer_id=? AND normalized_plate IS NULL',
      )
      .bind(id)
      .first(),
  ).toEqual({ n: 2 });
});
it('copies only the selected customer vehicle and freezes old policy details across later vehicle edits', async () => {
  const id = await customer('vehicle-history'),
    other = await customer('vehicle-history-other');
  const vehicle = await createVehicle(id),
    alien = await createVehicle(other);
  const oldPolicy = await policy(id, 'VEH-OLD'),
    newPolicy = await policy(id, 'VEH-NEW');
  expect((await readPolicy(oldPolicy)).vehicle).toBeNull();
  const body = { expectedVersion: 1, vehicleId: vehicle.id, vehicleVersion: 1 },
    key = crypto.randomUUID();
  expect((await write(`policies/${oldPolicy}/vehicle`, body, owner, key)).status).toBe(200);
  expect(
    (await write(`policies/${newPolicy}/vehicle`, { ...body, vehicleId: alien.id })).status,
  ).toBe(409);
  expect(
    (
      await write(`customers/${id}/vehicles/${vehicle.id}`, {
        expectedVersion: 2,
        expectedVehicleVersion: 1,
        details: { ...details, plate: '34 YENI 99', model: 'E300' },
        status: 'ACTIVE',
      })
    ).status,
  ).toBe(200);
  expect((await readPolicy(oldPolicy)).vehicle?.details).toEqual(details);
  expect(
    (await write(`policies/${newPolicy}/vehicle`, { ...body, vehicleVersion: 1 })).status,
  ).toBe(409);
  expect(
    (await write(`policies/${newPolicy}/vehicle`, { ...body, vehicleVersion: 2 })).status,
  ).toBe(200);
  expect((await readPolicy(newPolicy)).vehicle?.details.model).toBe('E300');
  await verifyOperationalRecovery(
    async (sql) => (await f.db.prepare(sql).all<Record<string, unknown>>()).results,
  );
  expect(
    (
      await write(`customers/${id}/vehicles/${vehicle.id}`, {
        expectedVersion: 3,
        expectedVehicleVersion: 2,
        details: { ...details, plate: '34 YENI 99', model: 'E300' },
        status: 'INACTIVE',
      })
    ).status,
  ).toBe(200);
  expect((await write(`policies/${oldPolicy}/vehicle`, body, owner, key)).status).toBe(200);
  expect(
    (
      await write(`policies/${oldPolicy}/vehicle`, {
        expectedVersion: 2,
        vehicleId: vehicle.id,
        vehicleVersion: 3,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await write(`policies/${oldPolicy}/vehicle`, {
        expectedVersion: 2,
        vehicleId: null,
        vehicleVersion: null,
      })
    ).status,
  ).toBe(200);
  expect((await readPolicy(oldPolicy)).vehicle).toBeNull();
});
it('enforces agency/assignment, CSRF, bounded pages, input validation and archived parent denial', async () => {
  const id = await customer('vehicle-protected', 'membership-vehicle-owner');
  expect((await f.request(`/api/customers/${id}/vehicles`, 'GET', member)).status).toBe(404);
  expect((await f.request(`/api/customers/${id}/vehicles`, 'GET', foreign)).status).toBe(404);
  const denied = await write(
    `customers/${id}/vehicles`,
    { expectedVersion: 1, details, status: 'ACTIVE' },
    member,
    crypto.randomUUID(),
    'POST',
  );
  expect([403, 404]).toContain(denied.status);
  expect(
    (
      await f.request(
        `/api/customers/${id}/vehicles`,
        'POST',
        owner,
        { expectedVersion: 1, details },
        undefined,
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(403);
  for (const value of [
    { ...details, modelYear: 9999 },
    { ...details, plate: '??' },
    { ...details, vin: 'X'.repeat(51) },
  ])
    expect(
      (
        await write(
          `customers/${id}/vehicles`,
          { expectedVersion: 1, details: value, status: 'ACTIVE' },
          owner,
          crypto.randomUUID(),
          'POST',
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await write(
        `customers/${id}/archive`,
        { expectedVersion: 1, reasonCode: 'TEST_COMPLETE' },
        owner,
        crypto.randomUUID(),
        'POST',
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await write(
        `customers/${id}/vehicles`,
        { expectedVersion: 2, details, status: 'ACTIVE' },
        owner,
        crypto.randomUUID(),
        'POST',
      )
    ).status,
  ).toBe(409);
});
it('rolls back snapshot, parent version, receipt and audit when a vehicle changes just before the batch', async () => {
  const id = await customer('vehicle-race'),
    vehicle = await createVehicle(id),
    pid = await policy(id, 'VEH-RACE');
  const original = f.env.DB,
    key = crypto.randomUUID();
  let changed = false;
  f.env.DB = new Proxy(original, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: Parameters<D1Database['batch']>[0]) => {
          if (!changed) {
            changed = true;
            await original
              .prepare('UPDATE customer_vehicles SET version=version+1 WHERE id=?')
              .bind(vehicle.id)
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    expect(
      (
        await write(
          `policies/${pid}/vehicle`,
          { expectedVersion: 1, vehicleId: vehicle.id, vehicleVersion: 1 },
          owner,
          key,
        )
      ).status,
    ).toBe(409);
    expect(changed).toBe(true);
    expect((await readPolicy(pid)).version).toBe(1);
    expect((await readPolicy(pid)).vehicle).toBeNull();
    for (const table of ['operation_receipts', 'audit_events'])
      expect(
        await f.db
          .prepare(`SELECT count(*) n FROM ${table} WHERE idempotency_key=?`)
          .bind(key)
          .first(),
      ).toEqual({ n: 0 });
  } finally {
    f.env.DB = original;
  }
});

it('preserves an existing snapshot when a catalog user disables its branch and rechecks the flag during writes', async () => {
  const created = await write(
    'catalogs/branches',
    { code: 'UNKNOWN', name: 'Araç desteği belirsiz' },
    owner,
    crypto.randomUUID(),
    'POST',
  );
  expect(created.status).toBe(201);
  expect(
    ((await created.json()) as { data: { supportsVehicleDetails: boolean } }).data
      .supportsVehicleDetails,
  ).toBe(false);
  const id = await customer('vehicle-branch-change');
  const vehicle = await createVehicle(id);
  const existing = await policy(id, 'VEH-BRANCH-OLD');
  const next = await policy(id, 'VEH-BRANCH-NEW');
  const input = { expectedVersion: 1, vehicleId: vehicle.id, vehicleVersion: 1 };
  const originalKey = crypto.randomUUID();
  expect((await write(`policies/${existing}/vehicle`, input, owner, originalKey)).status).toBe(200);
  const snapshot = (await readPolicy(existing)).vehicle;
  const change = (expectedVersion: number, supportsVehicleDetails: boolean) =>
    write(
      'catalogs/branches/vehicle-b',
      { expectedVersion, name: 'Kasko', supportsVehicleDetails },
      owner,
      crypto.randomUUID(),
      'PATCH',
    );
  expect((await change(1, false)).status).toBe(200);
  expect((await change(1, true)).status).toBe(409);
  expect(await readPolicy(existing)).toMatchObject({
    branch: { supportsVehicleDetails: false },
    version: 2,
    vehicle: snapshot,
  });
  expect((await write(`policies/${next}/vehicle`, input)).status).toBe(409);
  expect(
    (
      await write(`policies/${existing}/vehicle`, {
        expectedVersion: 2,
        vehicleId: null,
        vehicleVersion: null,
      })
    ).status,
  ).toBe(409);
  expect((await write(`policies/${existing}/vehicle`, input, owner, originalKey)).status).toBe(200);
  expect((await change(2, true)).status).toBe(200);
  const original = f.env.DB;
  let changed = false;
  f.env.DB = new Proxy(original, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: Parameters<D1Database['batch']>[0]) => {
          if (!changed) {
            changed = true;
            await original
              .prepare(
                "UPDATE insurance_branches SET supports_vehicle_details=0,version=version+1 WHERE id='vehicle-b'",
              )
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    expect((await write(`policies/${next}/vehicle`, input)).status).toBe(409);
    expect(changed).toBe(true);
  } finally {
    f.env.DB = original;
  }
  expect(await readPolicy(next)).toMatchObject({ version: 1, vehicle: null });
  expect((await readPolicy(existing)).vehicle).toEqual(snapshot);
});
