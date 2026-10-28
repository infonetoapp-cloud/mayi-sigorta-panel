// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as admin from '../src/server/auth/admin';
import * as password from '../src/server/auth/password';
import { localAuthFixture } from './support/local-auth-fixture';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
const target = {
  mode: 'provision-agency' as const,
  accountId: 'a'.repeat(32),
  databaseId: '00000000-0000-4000-8000-000000000027',
  agencyId: 'synthetic-first-agency',
  operationKey: 'synthetic-operation-001',
};
beforeEach(async () => {
  f = await localAuthFixture();
});
afterEach(async () => {
  await f?.mf.dispose();
});
it('fresh empty native D1 creates only one unactivated agency and immutable SYSTEM evidence', async () => {
  const provision = admin.provisionInitialAgency;
  expect(typeof provision).toBe('function');
  await provision(f.db, target);
  expect(
    await f.db
      .prepare('SELECT id,status,bootstrap_completed_at,activated_at,version FROM agencies')
      .first(),
  ).toEqual({
    id: target.agencyId,
    status: 'PROVISIONING',
    bootstrap_completed_at: null,
    activated_at: null,
    version: 1,
  });
  for (const table of [
    'users',
    'agency_memberships',
    'auth_identities',
    'local_credentials',
    'local_sessions',
  ])
    expect(await f.db.prepare(`SELECT count(*) n FROM ${table}`).first()).toEqual({ n: 0 });
  expect(f.hasher.calls).toBe(0);
  expect(
    await f.db
      .prepare(
        'SELECT action,system_actor_code,reason_code,outcome,target_type,target_id,idempotency_key FROM system_audit_events',
      )
      .first(),
  ).toEqual({
    action: 'auth.admin.provision-agency',
    system_actor_code: 'LOCAL_AUTH_OPERATOR',
    reason_code: 'OPERATOR_CONFIRMED',
    outcome: 'SUCCESS',
    target_type: 'agencies',
    target_id: target.agencyId,
    idempotency_key: `provision-agency:${target.operationKey}`,
  });
});

it('strict input rejects malformed exact identifiers, OWNER inputs and unknown fields before DB access', async () => {
  const invalid = [
    { agencyId: '' },
    { agencyId: 'a'.repeat(101) },
    { agencyId: '   ' },
    { accountId: 'malformed' },
    { databaseId: 'not-a-uuid' },
    { operationKey: 'short' },
    { operationKey: 'invalid/key' },
    { ownerUserId: 'forbidden' },
    { email: 'synthetic@example.invalid' },
    { password: 'forbidden-input' },
    { unknown: true },
    { mode: 'bootstrap' },
  ];
  for (const delta of invalid) {
    expect(admin.initialAgencyTargetSchema.safeParse({ ...target, ...delta }).success).toBe(false);
    await expect(
      admin.provisionInitialAgency(f.db, { ...target, ...delta } as admin.InitialAgencyTarget),
    ).rejects.toThrow();
  }
  expect(await f.db.prepare('SELECT count(*) n FROM agencies').first()).toEqual({ n: 0 });
});

it('local composition binds exact account/database and rejects remote bindings', () => {
  const config = {
    account_id: target.accountId,
    d1_databases: [{ binding: 'DB', database_id: target.databaseId }],
  };
  expect(() => admin.assertLocalAdminBinding(config, target)).not.toThrow();
  for (const configDelta of [
    { account_id: 'b'.repeat(32) },
    { d1_databases: [{ binding: 'DB', database_id: crypto.randomUUID() }] },
    { d1_databases: [{ binding: 'DB', database_id: target.databaseId, remote: true }] },
    { d1_databases: [...config.d1_databases, ...config.d1_databases] },
  ])
    expect(() => admin.assertLocalAdminBinding({ ...config, ...configDelta }, target)).toThrow();
});

it('exact completed retry has same result/correlation and only one agency/audit; conflicts fail closed', async () => {
  const first = await admin.provisionInitialAgency(f.db, target);
  expect(await admin.provisionInitialAgency(f.db, target)).toEqual(first);
  for (const delta of [
    { agencyId: 'different-agency' },
    { agencyId: 'different-agency', operationKey: 'different-operation' },
    { operationKey: 'different-operation' },
    { accountId: 'b'.repeat(32) },
    { databaseId: crypto.randomUUID() },
  ])
    await expect(admin.provisionInitialAgency(f.db, { ...target, ...delta })).rejects.toThrow(
      'OPTIMISTIC_CONCURRENCY_CONFLICT',
    );
  expect(await f.db.prepare('SELECT count(*) n FROM agencies').first()).toEqual({ n: 1 });
  expect(await f.db.prepare('SELECT count(*) n FROM system_audit_events').first()).toEqual({
    n: 1,
  });
  await expect(
    f.db.prepare("UPDATE system_audit_events SET reason_code='changed'").run(),
  ).rejects.toThrow('SYSTEM_AUDIT_IMMUTABLE');
  await expect(f.db.prepare('DELETE FROM system_audit_events').run()).rejects.toThrow(
    'SYSTEM_AUDIT_IMMUTABLE',
  );
});

it.each([target.agencyId, 'another-provisioning-agency'])(
  'rejects preexisting PROVISIONING %s without completed provisioning evidence',
  async (agencyId) => {
    await f.db
      .prepare("INSERT INTO agencies(id,status) VALUES(?,'PROVISIONING')")
      .bind(agencyId)
      .run();
    await expect(admin.provisionInitialAgency(f.db, target)).rejects.toThrow(
      'OPTIMISTIC_CONCURRENCY_CONFLICT',
    );
    expect(await f.db.prepare('SELECT count(*) n FROM system_audit_events').first()).toEqual({
      n: 0,
    });
  },
);

it('rejects same agency ACTIVE and rejects retry after real local OWNER bootstrap', async () => {
  await admin.provisionInitialAgency(f.db, target);
  expect(await f.db.prepare('SELECT count(*) n FROM agency_memberships').first()).toEqual({ n: 0 });
  expect(await f.db.prepare("SELECT id FROM users WHERE id='synthetic-owner'").first()).toBeNull();
  const result = await admin.administerLocalOwner(
    f.db,
    {
      ...target,
      mode: 'bootstrap',
      ownerUserId: 'synthetic-owner',
      email: 'synthetic-owner@example.invalid',
      name: 'Synthetic Owner',
      operationKey: 'separate-owner-operation',
    },
    f.hasher,
  );
  expect(result.temporaryPassword).toBeTruthy();
  expect(await f.db.prepare('SELECT status,version FROM agencies').first()).toEqual({
    status: 'ACTIVE',
    version: 2,
  });
  expect(await f.db.prepare('SELECT type,status FROM agency_memberships').first()).toEqual({
    type: 'OWNER',
    status: 'ACTIVE',
  });
  expect(f.hasher.calls).toBe(1);
  await expect(admin.provisionInitialAgency(f.db, target)).rejects.toThrow(
    'OPTIMISTIC_CONCURRENCY_CONFLICT',
  );
});

it('preexisting global User alone is not a fresh first commissioning', async () => {
  await f.db.prepare("INSERT INTO users(id,status) VALUES('preexisting-user','ACTIVE')").run();
  await expect(admin.provisionInitialAgency(f.db, target)).rejects.toThrow(
    'OPTIMISTIC_CONCURRENCY_CONFLICT',
  );
  expect(await f.db.prepare('SELECT count(*) n FROM agencies').first()).toEqual({ n: 0 });
});

it('preexisting AuthIdentity with its required global User fails closed without an agency', async () => {
  await f.db.prepare("INSERT INTO users(id,status) VALUES('preexisting-user','ACTIVE')").run();
  await f.db
    .prepare(
      "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email) VALUES('preexisting-identity','preexisting-user','urn:synthetic','subject','synthetic@example.invalid')",
    )
    .run();
  await expect(admin.provisionInitialAgency(f.db, target)).rejects.toThrow(
    'OPTIMISTIC_CONCURRENCY_CONFLICT',
  );
  expect(await f.db.prepare('SELECT count(*) n FROM agencies').first()).toEqual({ n: 0 });
});

it.each(['agency_memberships', 'local_credentials', 'local_sessions'])(
  'preexisting %s and FK prerequisites are never repaired/deleted',
  async (table) => {
    const user = await f.seed('preexisting-owner', 'OWNER', false, 'preexisting-agency');
    if (table === 'local_sessions') await f.session(user.id);
    const before = (await f.db.prepare(`SELECT * FROM ${table}`).all()).results;
    expect(before.length).toBeGreaterThan(0);
    await expect(admin.provisionInitialAgency(f.db, target)).rejects.toThrow(
      'OPTIMISTIC_CONCURRENCY_CONFLICT',
    );
    expect((await f.db.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(before);
    expect(await f.db.prepare('SELECT count(*) n FROM system_audit_events').first()).toEqual({
      n: 0,
    });
  },
);

it.each(['different', 'same'])(
  'two concurrent %s attempts have at most one durable agency/audit effect',
  async (kind) => {
    const other =
      kind === 'same'
        ? target
        : { ...target, agencyId: 'competing-agency', operationKey: 'competing-operation' };
    const results = await Promise.allSettled([
      admin.provisionInitialAgency(f.db, target),
      admin.provisionInitialAgency(f.db, other),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(kind === 'same' ? 2 : 1);
    if (kind === 'same') expect(results[0]).toEqual(results[1]);
    expect(await f.db.prepare('SELECT count(*) n FROM agencies').first()).toEqual({ n: 1 });
    expect(await f.db.prepare('SELECT count(*) n FROM system_audit_events').first()).toEqual({
      n: 1,
    });
    expect(await f.db.prepare('SELECT count(*) n FROM d1_cas_assertions').first()).toEqual({
      n: 0,
    });
  },
);

it.each(['system_audit_events', 'agencies'])(
  '%s insert failure rolls back all effect, then exact retry succeeds',
  async (table) => {
    await f.db
      .prepare(
        `CREATE TRIGGER synthetic_insert_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'SYNTHETIC_INSERT_FAILURE'); END`,
      )
      .run();
    await expect(admin.provisionInitialAgency(f.db, target)).rejects.toThrow(
      'SYNTHETIC_INSERT_FAILURE',
    );
    expect(await f.db.prepare('SELECT count(*) n FROM agencies').first()).toEqual({ n: 0 });
    expect(await f.db.prepare('SELECT count(*) n FROM system_audit_events').first()).toEqual({
      n: 0,
    });
    await f.db.prepare('DROP TRIGGER synthetic_insert_failure').run();
    expect((await admin.provisionInitialAgency(f.db, target)).outcome).toBe('COMPLETED');
  },
);

it('final atomic assertion rejects auth state injected during agency INSERT and rolls everything back', async () => {
  await f.db
    .prepare(
      "CREATE TRIGGER synthetic_auth_race AFTER INSERT ON agencies BEGIN INSERT INTO users(id,status) VALUES('unexpected-user','ACTIVE'); END",
    )
    .run();
  await expect(admin.provisionInitialAgency(f.db, target)).rejects.toThrow(
    'BUSINESS_MUTATION_FAILED',
  );
  for (const table of ['agencies', 'users', 'system_audit_events'])
    expect(await f.db.prepare(`SELECT count(*) n FROM ${table}`).first()).toEqual({ n: 0 });
});

it('provisioning invokes neither password generation nor Cloudflare fetch', async () => {
  const generator = vi.spyOn(password, 'generateTemporaryPassword');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    await admin.provisionInitialAgency(f.db, target);
    expect(generator).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(f.hasher.calls).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
});
