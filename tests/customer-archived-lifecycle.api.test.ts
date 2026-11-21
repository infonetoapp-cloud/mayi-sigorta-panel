// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import {
  enableCompanyRegistration,
  registrationNumber,
  seedRegistrationInsurer,
} from './support/customer-registration-fixture';
import type { CustomerDto, CompanyContactDto } from '../src/shared/types';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, foreign: string, denied: string;
const kinds = ['create', 'update', 'set_primary', 'deactivate', 'identity', 'reference'] as const;
type Kind = (typeof kinds)[number] | 'assign';
interface Operation {
  path: string;
  method: string;
  body: Record<string, unknown>;
  key: string;
}
let nextTaxNumber = 9000000200;
async function send(op: Operation, cookie = owner, csrf?: string) {
  return f.request(op.path, op.method, cookie, op.body, csrf ?? (await f.csrf(cookie)), {
    'idempotency-key': op.key,
  });
}
function operation(path: string, method: string, body: Record<string, unknown>): Operation {
  return { path, method, body, key: crypto.randomUUID() };
}
async function data<T>(response: Response, status: number) {
  expect(response.status).toBe(status);
  return ((await response.json()) as { data: T }).data;
}
async function setup(kind: Kind) {
  const customer = await data<CustomerDto>(
    await send(
      operation('/api/customers', 'POST', {
        type: 'COMPANY',
        companyTitle: 'Sentetik yaşam döngüsü',
        taxNumber: String(nextTaxNumber++),
        insurerNumber: registrationNumber('archive-registration-insurer'),
      }),
    ),
    201,
  );
  const path = `/api/customers/${customer.id}`;
  const primary = await data<CompanyContactDto>(
    await send(
      operation(path + '/contacts', 'POST', {
        firstName: 'Sentetik',
        lastName: 'Birincil',
        isPrimary: true,
      }),
    ),
    201,
  );
  const secondary = await data<CompanyContactDto>(
    await send(
      operation(path + '/contacts', 'POST', { firstName: 'Sentetik', lastName: 'İkinci' }),
    ),
    201,
  );
  // Generated synthetic identity, never logged or included in test assertion diffs.
  const value = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => String(b % 10)).join(
    '',
  );
  await data(
    await send(
      operation(path + '/identity', 'PUT', {
        expectedVersion: customer.version,
        identityType: 'VKN',
        identityValue: value,
      }),
    ),
    200,
  );
  const current = await data<CustomerDto>(await f.request(path, 'GET', owner), 200);
  const op =
    kind === 'create'
      ? operation(path + '/contacts', 'POST', {
          firstName: 'Yeni',
          lastName: 'Yetkili',
          isPrimary: true,
        })
      : kind === 'update'
        ? operation(path + '/contacts/' + secondary.id, 'PATCH', {
            expectedVersion: secondary.version,
            role: 'Yeni görev',
          })
        : kind === 'set_primary'
          ? operation(path + '/contacts/' + secondary.id + '/set-primary', 'POST', {
              expectedVersion: secondary.version,
            })
          : kind === 'deactivate'
            ? operation(path + '/contacts/' + primary.id + '/deactivate', 'POST', {
                expectedVersion: primary.version,
              })
            : kind === 'identity'
              ? operation(path + '/identity', 'PUT', {
                  expectedVersion: current.version,
                  identityType: 'VKN',
                  identityValue: String(nextTaxNumber++),
                })
              : kind === 'reference'
                ? operation(path + '/external-references', 'POST', {
                    expectedVersion: current.version,
                    sourceNamespace: 'SYNTHETIC',
                    externalKey: crypto.randomUUID(),
                  })
                : operation(path + '/assign', 'POST', {
                    expectedVersion: current.version,
                    assigneeMembershipId: 'membership-archive-denied',
                  });
  return { id: customer.id, path, current, op };
}
async function archive(s: Awaited<ReturnType<typeof setup>>) {
  const current = await data<CustomerDto>(await f.request(s.path, 'GET', owner), 200);
  await data(
    await send(
      operation(s.path + '/archive', 'POST', {
        expectedVersion: current.version,
        reasonCode: 'TEST_CLOSED',
      }),
    ),
    200,
  );
}
async function snapshot(id: string) {
  const [parent, contacts, refs, receipts, audits] = await Promise.all([
    f.db.prepare('SELECT * FROM customers WHERE id=?').bind(id).first(),
    f.db.prepare('SELECT * FROM company_contacts WHERE customer_id=? ORDER BY id').bind(id).all(),
    f.db
      .prepare('SELECT * FROM external_customer_references WHERE customer_id=? ORDER BY id')
      .bind(id)
      .all(),
    f.db.prepare('SELECT count(*) count FROM operation_receipts').first(),
    f.db.prepare("SELECT count(*) count FROM audit_events WHERE outcome='SUCCESS'").first(),
  ]);
  // Equality is asserted as a boolean so encrypted identity metadata never leaks in diffs.
  return JSON.stringify({
    parent,
    contacts: contacts.results,
    refs: refs.results,
    receipts,
    audits,
  });
}
beforeAll(async () => {
  f = await localAuthFixture();
  const ownerActor = await f.seed('archive-owner', 'OWNER');
  await enableCompanyRegistration(f, ownerActor.membershipId);
  await seedRegistrationInsurer(f.db, ownerActor.agencyId, 'archive-registration-insurer');
  await f.seed('archive-denied');
  await f.seed('archive-foreign', 'OWNER', false, 'archive-foreign-agency');
  owner = (await f.session('archive-owner')).cookie;
  denied = (await f.session('archive-denied')).cookie;
  foreign = (await f.session('archive-foreign')).cookie;
});
afterAll(async () => {
  await f?.mf.dispose();
});

it.each(kinds)(
  'keeps active %s and historical exact replay with current authorization',
  async (kind) => {
    const s = await setup(kind),
      status = kind === 'create' || kind === 'reference' ? 201 : 200;
    const original = await data<unknown>(await send(s.op), status);
    const active = await snapshot(s.id);
    expect(JSON.stringify(await data(await send(s.op), status)) === JSON.stringify(original)).toBe(
      true,
    );
    expect((await snapshot(s.id)) === active).toBe(true);
    await archive(s);
    const before = await snapshot(s.id);
    expect(JSON.stringify(await data(await send(s.op), status)) === JSON.stringify(original)).toBe(
      true,
    );
    expect((await snapshot(s.id)) === before).toBe(true);
    expect([401, 403, 404]).toContain((await send(s.op, foreign)).status);
    expect([401, 403, 404]).toContain((await send(s.op, denied)).status);
    const session = await f.session('archive-owner');
    const csrf = await f.csrf(session.cookie);
    await f.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
      .bind(Date.now(), session.hash)
      .run();
    expect((await send(s.op, session.cookie, csrf)).status).toBe(401);
    expect((await snapshot(s.id)) === before).toBe(true);
    expect((await f.request(s.path, 'GET', owner)).status).toBe(200);
    expect((await f.request(s.path + '/external-references', 'GET', owner)).status).toBe(200);
  },
);

async function holdBusinessBatch(action: string) {
  const original = f.env.DB;
  const matched = new WeakSet<D1PreparedStatement>();
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  f.env.DB = new Proxy(original, {
    get(target, field) {
      if (field === 'prepare')
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!/INSERT INTO operation_receipts/.test(sql)) return stmt;
          return new Proxy(stmt, {
            get(statement, property) {
              if (property === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  if (values[4] === action) matched.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, property);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (field === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!held && statements.some((statement) => matched.has(statement))) {
            held = true;
            arrived();
            await gate;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, field);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    ready,
    release,
    restore: () => {
      f.env.DB = original;
    },
  };
}
it.each([...kinds, 'assign'] as const)(
  'cannot commit %s after an archive wins the post-preflight race',
  async (kind) => {
    const s = await setup(kind),
      csrf = await f.csrf(owner);
    const action =
      kind === 'identity'
        ? 'customer.identity.update'
        : kind === 'reference'
          ? 'customer.external_reference.create'
          : kind === 'assign'
            ? 'customer.assign'
            : `company_contact.${kind}`;
    const barrier = await holdBusinessBatch(action);
    let pending: Promise<Response> | undefined;
    try {
      pending = send(s.op, owner, csrf);
      await Promise.race([
        barrier.ready,
        pending.then(() => {
          throw new Error('BUSINESS_BATCH_NOT_REACHED');
        }),
      ]);
      await archive(s);
      const before = await snapshot(s.id);
      barrier.release();
      expect((await pending).status).toBe(409);
      expect((await snapshot(s.id)) === before).toBe(true);
      expect(
        await f.db
          .prepare('SELECT count(*) count FROM operation_receipts WHERE idempotency_key=?')
          .bind(s.op.key)
          .first(),
      ).toEqual({ count: 0 });
    } finally {
      barrier.release();
      await pending;
      barrier.restore();
    }
  },
);
it('rolls back an active multi-statement primary reset when the target contact CAS fails', async () => {
  const s = await setup('set_primary');
  s.op.body.expectedVersion = 99;
  const before = await snapshot(s.id);
  expect((await send(s.op)).status).toBe(409);
  expect((await snapshot(s.id)) === before).toBe(true);
});
it('keeps assign protected by its existing service guard and customer CAS without a source change', async () => {
  const s = await setup('assign');
  const result = await data(await send(s.op), 200);
  await archive(s);
  const before = await snapshot(s.id);
  expect(JSON.stringify(await data(await send(s.op), 200)) === JSON.stringify(result)).toBe(true);
  const latest = await data<CustomerDto>(await f.request(s.path, 'GET', owner), 200);
  const fresh = {
    ...s.op,
    key: crypto.randomUUID(),
    body: { ...s.op.body, expectedVersion: latest.version },
  };
  expect((await send(fresh)).status).toBe(400);
  expect((await snapshot(s.id)) === before).toBe(true);
});

it('reconciles a concurrent completed receipt before the archived-parent assertion without rewriting', async () => {
  const s = await setup('create'),
    csrf = await f.csrf(owner);
  const barrier = await holdBusinessBatch('company_contact.create');
  let pending: Promise<Response> | undefined;
  try {
    pending = send(s.op, owner, csrf);
    await Promise.race([
      barrier.ready,
      pending.then(() => {
        throw new Error('BUSINESS_BATCH_NOT_REACHED');
      }),
    ]);
    const completed = await data(await send(s.op), 201);
    await archive(s);
    const before = await snapshot(s.id);
    barrier.release();
    expect(JSON.stringify(await data(await pending, 201)) === JSON.stringify(completed)).toBe(true);
    expect((await snapshot(s.id)) === before).toBe(true);
  } finally {
    barrier.release();
    await pending;
    barrier.restore();
  }
});
it('requires company VKN, rejects archived replacement, and rechecks the sensitive grant before replay', async () => {
  const s = await setup('identity');
  const active = await snapshot(s.id);
  const clear = operation(s.path + '/identity', 'PUT', {
    expectedVersion: s.current.version,
    clear: true,
  });
  expect((await send(clear)).status).toBe(400);
  expect((await snapshot(s.id)) === active).toBe(true);
  const original = await data(await send(s.op), 200);
  await archive(s);
  const before = await snapshot(s.id);
  const replacement = operation(s.path + '/identity', 'PUT', {
    expectedVersion: s.current.version + 2,
    identityType: 'VKN',
    identityValue: Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
      String(byte % 10),
    ).join(''),
  });
  expect((await send(replacement)).status).toBe(409);
  expect((await snapshot(s.id)) === before).toBe(true);
  const grant = await f.db
    .prepare(
      "SELECT id,membership_id,permission_code,scope FROM membership_permissions WHERE membership_id='membership-archive-owner' AND permission_code='sensitive.identity.write'",
    )
    .first<{ id: string; membership_id: string; permission_code: string; scope: string }>();
  try {
    await f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grant!.id).run();
    expect([401, 403, 404]).toContain((await send(s.op)).status);
    expect((await snapshot(s.id)) === before).toBe(true);
  } finally {
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(grant!.id, grant!.membership_id, grant!.permission_code, grant!.scope)
      .run();
  }
  expect(JSON.stringify(await data(await send(s.op), 200)) === JSON.stringify(original)).toBe(true);
});

it.each(kinds)(
  'rejects new archived %s with current versions and zero persisted effects',
  async (kind) => {
    const s = await setup(kind);
    await archive(s);
    if (kind === 'identity' || kind === 'reference')
      s.op.body.expectedVersion = s.current.version + 1;
    const before = await snapshot(s.id);
    const response = await send(s.op);
    expect(response.status).toBe(409);
    expect((await snapshot(s.id)) === before).toBe(true);
    expect(
      await f.db
        .prepare('SELECT count(*) count FROM operation_receipts WHERE idempotency_key=?')
        .bind(s.op.key)
        .first(),
    ).toEqual({ count: 0 });
    expect((await f.request(s.path, 'GET', owner)).status).toBe(200);
  },
);
