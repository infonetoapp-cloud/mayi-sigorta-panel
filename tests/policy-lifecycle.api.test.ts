// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import {
  enableCompanyRegistration,
  registrationNumber,
} from './support/customer-registration-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import { ensureRenewalForPolicy } from '../src/server/renewals/generation';
import type { CustomerDto, PolicyDto, CustomerAssignmentOptionDto } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  owner: string,
  ahmet: string,
  ayse: string,
  foreign: string;
let free: PolicyDto, blocked: PolicyDto, arrival: PolicyDto, double: PolicyDto;
const date = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function send(
  p: PolicyDto,
  suffix: string,
  body: unknown,
  actor = owner,
  key = crypto.randomUUID(),
) {
  return f.request('/api/policies/' + p.id + suffix, 'POST', actor, body, await f.csrf(actor), {
    'idempotency-key': key,
  });
}
async function current(p: PolicyDto, actor = owner) {
  return data<PolicyDto>(await f.request('/api/policies/' + p.id, 'GET', actor));
}
async function snapshot() {
  const tables = [
    'policies',
    'policy_parties',
    'policy_amendments',
    'policy_external_references',
    'renewal_opportunities',
    'tasks',
    'operation_receipts',
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  result.audit = (
    await f.db.prepare("SELECT * FROM audit_events WHERE outcome='SUCCESS' ORDER BY id").all()
  ).results;
  return JSON.stringify(result);
}
beforeAll(async () => {
  f = await localAuthFixture();
  async function login(id: string, type: 'OWNER' | 'MEMBER' = 'MEMBER', agency?: string) {
    const a = await f.seed(id, type, false, agency);
    if (['lc-ahmet', 'lc-ayse'].includes(id))
      await f.db.batch(
        createOnboardingTemplateGrants(id === 'lc-ahmet' ? 'yetkili_personel' : 'personel').map(
          (g) =>
            f.db
              .prepare(
                'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
              )
              .bind(crypto.randomUUID(), a.membershipId, g.permission_code, g.scope),
        ),
      );
    const r = await f.request('/api/auth/login', 'POST', undefined, {
      email: a.email,
      password: a.password,
    });
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie')!.split(';')[0]!;
  }
  owner = await login('lc-owner', 'OWNER');
  await enableCompanyRegistration(f, 'membership-lc-owner');
  ahmet = await login('lc-ahmet');
  ayse = await login('lc-ayse');
  foreign = await login('lc-foreign', 'OWNER', 'lc-foreign-agency');
  await f.seed('lc-inactive');
  await f.db
    .prepare(
      "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,permission_version=permission_version+1 WHERE id='membership-lc-inactive'",
    )
    .run();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('lc-i','agency-auth-test','LC','Insurer')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('lc-b','agency-auth-test','LC','Branch','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('lc-p','agency-auth-test','lc-i','lc-b','LC','Product')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('lc-pm','agency-auth-test','LC','Cash')",
    ),
  ]);
  const c = await data<CustomerDto>(
    await f.request(
      '/api/customers',
      'POST',
      owner,
      {
        type: 'COMPANY',
        companyTitle: 'Lifecycle Şirket',
        taxNumber: '9000000112',
        insurerNumber: registrationNumber('lc-i'),
      },
      await f.csrf(owner),
      { 'idempotency-key': crypto.randomUUID() },
    ),
    201,
  );
  async function policy(number: string, end: number) {
    return data<PolicyDto>(
      await f.request(
        '/api/policies',
        'POST',
        owner,
        {
          customerId: c.id,
          insurerId: 'lc-i',
          branchId: 'lc-b',
          productId: 'lc-p',
          paymentMethodId: 'lc-pm',
          policyNumber: number,
          startDate: date(-10),
          endDate: date(end),
          grossPremium: '1234.56',
          currency: 'TRY',
          installmentCount: null,
        },
        await f.csrf(owner),
        { 'idempotency-key': crypto.randomUUID() },
      ),
      201,
    );
  }
  free = await policy('LC-FREE', 400);
  blocked = await policy('LC-BLOCKED', 5);
  arrival = await policy('LC-ARRIVAL', 40);
  double = await policy('LC-DOUBLE', 400);
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('returns only active same-agency assignment options to effective AGENCY actors', async () => {
  for (const actor of [owner, ahmet]) {
    const rows = await data<CustomerAssignmentOptionDto[]>(
      await f.request('/api/policies/' + free.id + '/assignment-options', 'GET', actor),
    );
    expect(rows.some((r) => r.membershipId === 'membership-lc-ahmet')).toBe(true);
    expect(
      rows.some((r) =>
        ['membership-lc-inactive', 'membership-lc-foreign'].includes(r.membershipId),
      ),
    ).toBe(false);
  }
  const r = await f.request('/api/policies/' + free.id + '/assignment-options', 'GET', ayse);
  expect(r.status).toBe(403);
  expect(await r.json()).not.toHaveProperty('data');
});
it('assigns explicitly with policy CAS, preserves task/renewal ownership and returns exact historical replay', async () => {
  const renewals = JSON.stringify(
      (await f.db.prepare('SELECT * FROM renewal_opportunities ORDER BY id').all()).results,
    ),
    tasks = JSON.stringify((await f.db.prepare('SELECT * FROM tasks ORDER BY id').all()).results);
  const key = crypto.randomUUID(),
    body = { expectedVersion: free.version, assigneeMembershipId: 'membership-lc-ahmet' };
  const assigned = await data<PolicyDto>(await send(free, '/assign', body, owner, key));
  expect(assigned.assigneeMembershipId).toBe(body.assigneeMembershipId);
  await data(
    await send(
      free,
      '/assign',
      { expectedVersion: assigned.version, assigneeMembershipId: 'membership-lc-ayse' },
      ahmet,
    ),
  );
  const before = await snapshot();
  expect(await data<PolicyDto>(await send(free, '/assign', body, owner, key))).toEqual(assigned);
  expect((await current(free)).assigneeMembershipId).toBe('membership-lc-ayse');
  expect(await snapshot()).toBe(before);
  expect(
    JSON.stringify(
      (await f.db.prepare('SELECT * FROM renewal_opportunities ORDER BY id').all()).results,
    ),
  ).toBe(renewals);
  expect(
    JSON.stringify((await f.db.prepare('SELECT * FROM tasks ORDER BY id').all()).results),
  ).toBe(tasks);
});
it('rejects inactive/foreign recipients and ASSIGNED rather than AGENCY assignment authority without effects', async () => {
  const before = await snapshot();
  for (const id of ['membership-lc-inactive', 'membership-lc-foreign'])
    expect(
      (
        await send(free, '/assign', {
          expectedVersion: (await current(free)).version,
          assigneeMembershipId: id,
        })
      ).status,
    ).toBe(409);
  expect(
    (
      await send(
        free,
        '/assign',
        {
          expectedVersion: (await current(free)).version,
          assigneeMembershipId: 'membership-lc-ayse',
        },
        ayse,
      )
    ).status,
  ).toBe(403);
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('lc-assigned','membership-lc-ayse','policy.assign','ASSIGNED')",
    )
    .run();
  try {
    expect(
      (await f.request('/api/policies/' + free.id + '/assignment-options', 'GET', ayse)).status,
    ).toBe(403);
    expect(
      (
        await send(
          free,
          '/assign',
          {
            expectedVersion: (await current(free)).version,
            assigneeMembershipId: 'membership-lc-owner',
          },
          ayse,
        )
      ).status,
    ).toBe(403);
  } finally {
    await f.db.prepare("DELETE FROM membership_permissions WHERE id='lc-assigned'").run();
  }
  expect(await snapshot()).toBe(before);
});
it('preserves a previously assigned now-suspended membership in historical reads without offering it as an active replacement', async () => {
  await f.seed('lc-historical');
  expect(
    (
      await send(free, '/assign', {
        expectedVersion: (await current(free)).version,
        assigneeMembershipId: 'membership-lc-historical',
      })
    ).status,
  ).toBe(200);
  await f.db
    .prepare(
      "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,permission_version=permission_version+1 WHERE id='membership-lc-historical'",
    )
    .run();
  expect((await current(free)).assigneeMembershipId).toBe('membership-lc-historical');
  const result = await f.request('/api/policies/' + free.id + '/assignment-options', 'GET', owner);
  expect(result.status).toBe(200);
  expect(
    ((await result.json()) as { data: { membershipId: string }[] }).data.some(
      (m) => m.membershipId === 'membership-lc-historical',
    ),
  ).toBe(false);
});
it('rejects archive against real open renewal and task dependencies without any persisted changes', async () => {
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM renewal_opportunities WHERE expiring_policy_id=?')
      .bind(blocked.id)
      .first<{ n: number }>())!.n,
  ).toBe(1);
  expect(
    (await f.db
      .prepare(
        "SELECT count(*) n FROM tasks t JOIN renewal_opportunities r ON r.id=t.renewal_id WHERE r.expiring_policy_id=? AND t.status='OPEN'",
      )
      .bind(blocked.id)
      .first<{ n: number }>())!.n,
  ).toBeGreaterThan(0);
  const before = await snapshot();
  for (const actor of [owner, ahmet]) {
    const r = await send(
      blocked,
      '/archive',
      { expectedVersion: blocked.version, reasonCode: 'HISTORICAL_RECORD' },
      actor,
    );
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: 'OPEN_DEPENDENCIES' } });
  }
  expect(await snapshot()).toBe(before);
});
function archiveBarrier(expected: number) {
  const original = f.env.DB,
    statements = new Set<D1PreparedStatement>();
  let count = 0;
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      arrived = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.env.DB = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/UPDATE policies\s+SET archived_at=/.test(sql)) return statement;
          return new Proxy(statement, {
            get(stmt, field) {
              if (field === 'bind')
                return (...values: unknown[]) => {
                  const bound = stmt.bind(...values);
                  statements.add(bound);
                  return bound;
                };
              const value = Reflect.get(stmt, field);
              return typeof value === 'function' ? value.bind(stmt) : value;
            },
          });
        };
      if (property === 'batch')
        return async (items: D1PreparedStatement[]) => {
          if (items.some((s) => statements.has(s))) {
            count++;
            if (count === expected) arrived();
            await gate;
          }
          return target.batch(items);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    ready,
    release,
    restore() {
      f.env.DB = original;
    },
  };
}
it('atomically rejects a renewal/task arriving after archive preflight but before its batch', async () => {
  const barrier = archiveBarrier(1);
  let pending: Promise<Response> | undefined;
  try {
    pending = send(arrival, '/archive', {
      expectedVersion: arrival.version,
      reasonCode: 'HISTORICAL_RECORD',
    });
    await barrier.ready;
    await f.db
      .prepare(
        "INSERT INTO agency_settings(id,agency_id,default_insurer_id,timezone,renewal_window_days) VALUES('lc-settings','agency-auth-test','lc-i','Europe/Istanbul',60)",
      )
      .run();
    expect(await ensureRenewalForPolicy(f.db, 'agency-auth-test', arrival.id)).toBe('CREATED');
    const before = await snapshot();
    barrier.release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: 'OPEN_DEPENDENCIES' } });
    expect(await snapshot()).toBe(before);
  } finally {
    barrier.release();
    if (pending) await pending;
    barrier.restore();
  }
});
it('archives a genuinely dependency-free policy, preserves original fields, and safely replays without double archive', async () => {
  const p = await current(free);
  const staleBefore = await snapshot();
  expect(
    (await send(free, '/archive', { expectedVersion: 1, reasonCode: 'HISTORICAL_RECORD' })).status,
  ).toBe(409);
  expect(await snapshot()).toBe(staleBefore);
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM renewal_opportunities WHERE expiring_policy_id=?')
      .bind(free.id)
      .first<{ n: number }>())!.n,
  ).toBe(0);
  const key = crypto.randomUUID(),
    body = { expectedVersion: p.version, reasonCode: 'HISTORICAL_RECORD' };
  const result = await data<PolicyDto>(await send(free, '/archive', body, ahmet, key));
  expect(result.archivedAt).not.toBeNull();
  for (const field of [
    'status',
    'startDate',
    'endDate',
    'grossPremiumMinor',
    'currency',
    'assigneeMembershipId',
  ] as const)
    expect(result[field]).toBe(p[field]);
  const before = await snapshot();
  expect(await data(await send(free, '/archive', body, ahmet, key))).toEqual(result);
  expect((await send(free, '/archive', { ...body, expectedVersion: result.version })).status).toBe(
    409,
  );
  expect(
    (
      await send(free, '/assign', {
        expectedVersion: result.version,
        assigneeMembershipId: 'membership-lc-owner',
      })
    ).ok,
  ).toBe(false);
  expect((await current(free, ayse)).archivedAt).not.toBeNull();
  for (const [suffix, fields] of [
    ['/parties', { customerId: free.customerId, role: 'INSURED' }],
    [
      '/amendments',
      {
        externalReference: 'ARCHIVE-REJECT',
        effectiveDate: date(0),
        description: 'Valid archived-parent probe',
      },
    ],
    ['/external-references', { sourceNamespace: 'lifecycle', externalKey: 'ARCHIVE-REJECT' }],
  ] as const)
    expect([403, 409]).toContain(
      (await send(free, suffix, { ...fields, expectedVersion: result.version })).status,
    );
  expect([403, 409]).toContain(
    (
      await f.request(
        '/api/policies/' + free.id,
        'PATCH',
        owner,
        { expectedVersion: result.version, policyNumber: 'ARCHIVE-REJECT' },
        await f.csrf(owner),
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  );
  expect(await snapshot()).toBe(before);
});
it('allows exactly one of two archive batches with identical initial CAS and rolls back losing evidence', async () => {
  const barrier = archiveBarrier(2);
  let requests: Promise<Response>[] = [];
  const beforeCount = (await f.db
    .prepare('SELECT count(*) n FROM operation_receipts')
    .first<{ n: number }>())!.n;
  const beforeAudit = (await f.db
    .prepare("SELECT count(*) n FROM audit_events WHERE outcome='SUCCESS'")
    .first<{ n: number }>())!.n;
  try {
    requests = [
      send(double, '/archive', {
        expectedVersion: double.version,
        reasonCode: 'HISTORICAL_RECORD',
      }),
      send(double, '/archive', { expectedVersion: double.version, reasonCode: 'DUPLICATE_RECORD' }),
    ];
    await barrier.ready;
    barrier.release();
    expect((await Promise.all(requests)).map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await current(double)).version).toBe(double.version + 1);
    expect(
      (await f.db.prepare('SELECT count(*) n FROM operation_receipts').first<{ n: number }>())!.n,
    ).toBe(beforeCount + 1);
    expect(
      (await f.db
        .prepare("SELECT count(*) n FROM audit_events WHERE outcome='SUCCESS'")
        .first<{ n: number }>())!.n,
    ).toBe(beforeAudit + 1);
  } finally {
    barrier.release();
    await Promise.all(requests);
    barrier.restore();
  }
});
it('denies foreign missing-permission revoked-session and HEALTH lifecycle operations without disclosure or effects', async () => {
  const before = await snapshot();
  for (const actor of [foreign, ayse]) {
    for (const suffix of ['/assign', '/archive'])
      expect(
        (
          await send(
            blocked,
            suffix,
            {
              expectedVersion: blocked.version,
              ...(suffix === '/assign'
                ? { assigneeMembershipId: 'membership-lc-owner' }
                : { reasonCode: 'HISTORICAL_RECORD' }),
            },
            actor,
          )
        ).status,
      ).toBe(actor === foreign ? 404 : 403);
    const r = await f.request('/api/policies/' + blocked.id + '/assignment-options', 'GET', actor);
    expect(r.status).toBe(actor === foreign ? 404 : 403);
    expect(await r.json()).not.toHaveProperty('data');
  }
  expect(await snapshot()).toBe(before);
  const csrf = await f.csrf(ahmet);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=?')
    .bind(Date.now(), 'lc-ahmet')
    .run();
  for (const suffix of ['/assign', '/archive'])
    expect(
      (
        await f.request(
          '/api/policies/' + blocked.id + suffix,
          'POST',
          ahmet,
          {
            expectedVersion: blocked.version,
            ...(suffix === '/assign'
              ? { assigneeMembershipId: 'membership-lc-owner' }
              : { reasonCode: 'HISTORICAL_RECORD' }),
          },
          csrf,
          { 'idempotency-key': crypto.randomUUID() },
        )
      ).status,
    ).toBe(401);
  expect(await snapshot()).toBe(before);
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('lc-h','agency-auth-test','H','Health','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('lc-hp','agency-auth-test','lc-i','lc-h','H','Health')",
    ),
    f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) SELECT 'lc-health',agency_id,customer_id,insurer_id,'lc-hp','lc-h',payment_method_id,assignee_membership_id,'HIDDEN','HIDDEN',start_date,end_date,gross_premium_minor,currency FROM policies WHERE id=?",
      )
      .bind(blocked.id),
  ]);
  const hbefore = await snapshot(),
    h = { ...blocked, id: 'lc-health', version: 1 };
  for (const suffix of ['/assign', '/archive'])
    expect(
      (
        await send(h, suffix, {
          expectedVersion: 1,
          ...(suffix === '/assign'
            ? { assigneeMembershipId: 'membership-lc-owner' }
            : { reasonCode: 'HISTORICAL_RECORD' }),
        })
      ).status,
    ).toBe(403);
  expect((await f.request('/api/policies/lc-health/assignment-options', 'GET', owner)).status).toBe(
    403,
  );
  expect(await snapshot()).toBe(hbefore);
});
