// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { administerLocalOwner, adminTargetSchema } from '../src/server/auth/admin';
import * as admin from '../src/server/auth/admin';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const target = (
  agencyId: string,
  ownerUserId: string,
  mode: 'bootstrap' | 'break-glass' = 'bootstrap',
) => ({
  mode,
  accountId: 'a'.repeat(32),
  databaseId: '00000000-0000-4000-8000-000000000027',
  agencyId,
  ownerUserId,
  email: `${ownerUserId}@example.invalid`,
  name: 'Synthetic Owner',
  operationKey: crypto.randomUUID(),
});
beforeAll(async () => {
  f = await localAuthFixture();
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('requires exact explicit targets with no defaults', () => {
  expect(adminTargetSchema.safeParse({ mode: 'bootstrap' }).success).toBe(false);
});
it('rejects local config account or D1 mismatch before opening the database', () => {
  const check = (
    admin as unknown as { assertLocalAdminBinding: (config: unknown, target: unknown) => void }
  ).assertLocalAdminBinding;
  const t = target('target-agency', 'target-owner');
  const config = {
    account_id: t.accountId,
    d1_databases: [{ binding: 'DB', database_id: t.databaseId, remote: false }],
  };
  expect(typeof check).toBe('function');
  expect(() => check(config, t)).not.toThrow();
  expect(() => check({ ...config, account_id: 'b'.repeat(32) }, t)).toThrow();
  expect(() =>
    check({ ...config, d1_databases: [{ binding: 'DB', database_id: crypto.randomUUID() }] }, t),
  ).toThrow();
  expect(() =>
    check({ ...config, d1_databases: [{ ...config.d1_databases[0], remote: true }] }, t),
  ).toThrow();
});
it('initial native D1 bootstrap is one-time, forced-change and audited without plaintext', async () => {
  const t = target('admin-initial', 'admin-first');
  await f.db
    .prepare("INSERT INTO agencies(id,status) VALUES(?,'PROVISIONING')")
    .bind(t.agencyId)
    .run();
  const result = await administerLocalOwner(f.db, t, f.hasher);
  const state = await f.db
    .prepare('SELECT must_change_password,login_email FROM local_credentials WHERE user_id=?')
    .bind(t.ownerUserId)
    .first();
  expect(state).toEqual({ must_change_password: 1, login_email: t.email });
  expect(
    (
      await f.request('/api/auth/login', 'POST', undefined, {
        email: t.email,
        password: result.temporaryPassword,
      })
    ).status,
  ).toBe(200);
  await expect(administerLocalOwner(f.db, t, f.hasher)).rejects.toThrow(
    'ONE_TIME_RESPONSE_UNAVAILABLE',
  );
  await expect(
    administerLocalOwner(f.db, { ...t, operationKey: crypto.randomUUID() }, f.hasher),
  ).rejects.toThrow('BOOTSTRAP_SETUP');
  expect(
    JSON.stringify(
      (await f.db.prepare('SELECT * FROM system_audit_events').all()).results,
    ).includes(result.temporaryPassword),
  ).toBe(false);
});
it('break-glass revokes sessions and preserves exact membership and permissions', async () => {
  const user = await f.seed('admin-recover', 'OWNER', false, 'admin-recover-agency');
  const session = await f.session(user.id);
  const before = await f.db
    .prepare('SELECT * FROM agency_memberships WHERE id=?')
    .bind(user.membershipId)
    .first();
  const result = await administerLocalOwner(
    f.db,
    target(user.agencyId, user.id, 'break-glass'),
    f.hasher,
  );
  expect((await f.request('/api/me', 'GET', session.cookie)).status).toBe(401);
  expect(
    await f.db
      .prepare('SELECT * FROM agency_memberships WHERE id=?')
      .bind(user.membershipId)
      .first(),
  ).toEqual(before);
  expect(
    (
      await f.request('/api/auth/login', 'POST', undefined, {
        email: user.email,
        password: user.password,
      })
    ).status,
  ).toBe(401);
  const login = await f.request('/api/auth/login', 'POST', undefined, {
    email: user.email,
    password: result.temporaryPassword,
  });
  expect(((await login.json()) as { data: { state: string } }).data.state).toBe('ACTIVATION');
  await expect(
    administerLocalOwner(
      f.db,
      { ...target(user.agencyId, user.id, 'break-glass'), email: 'wrong@example.invalid' },
      f.hasher,
    ),
  ).rejects.toThrow('EXACT_EXISTING_OWNER_REQUIRED');
});
it('administrative recovery has no employee-count cap', async () => {
  const user = await f.seed('admin-large-owner', 'OWNER', false, 'admin-large-agency');
  await f.db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO users(id,status) SELECT 'admin-large-'||x,'ACTIVE' FROM n",
    )
    .run();
  await f.db
    .prepare(
      "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at) SELECT 'member-'||id,?,id,'MEMBER','ACTIVE',id||'@example.invalid','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM users WHERE id GLOB 'admin-large-[0-9]*'",
    )
    .bind(user.agencyId)
    .run();
  expect(
    await administerLocalOwner(f.db, target(user.agencyId, user.id, 'break-glass'), f.hasher).then(
      () => true,
      () => false,
    ),
  ).toBe(true);
});
it('legacy bootstrap atomically rejects another owner appearing during KDF', async () => {
  const user = { id: 'admin-legacy', agencyId: 'admin-legacy-agency' };
  await f.db
    .prepare("INSERT INTO agencies(id,status) VALUES(?,'PROVISIONING')")
    .bind(user.agencyId)
    .run();
  await f.db.prepare("INSERT INTO users(id,status) VALUES(?,'ACTIVE')").bind(user.id).run();
  await f.db
    .prepare(
      "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email) VALUES(?,?,'https://synthetic.cloudflareaccess.com',?,?)",
    )
    .bind('admin-legacy-identity', user.id, 'admin-legacy-subject', `${user.id}@example.invalid`)
    .run();
  await f.db
    .prepare(
      "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES(?,?,?,'OWNER','INVITED',?,'2099-01-01T00:00:00.000Z')",
    )
    .bind('admin-legacy-member', user.agencyId, user.id, `${user.id}@example.invalid`)
    .run();
  await f.db
    .prepare(
      "UPDATE agency_memberships SET status='ACTIVE',activated_at=?,version=version+1,permission_version=permission_version+1 WHERE id='admin-legacy-member'",
    )
    .bind(new Date().toISOString())
    .run();
  await f.db
    .prepare(
      "UPDATE agencies SET status='ACTIVE',activated_at=?,bootstrap_completed_at=?,version=version+1 WHERE id=?",
    )
    .bind(new Date().toISOString(), new Date().toISOString(), user.agencyId)
    .run();
  const hasher = {
    ...f.hasher,
    hash: async (password: string) => {
      const value = await f.hasher.hash(password);
      await f.seed('admin-concurrent-owner', 'OWNER', false, user.agencyId);
      return value;
    },
  };
  expect(
    await administerLocalOwner(f.db, target(user.agencyId, user.id), hasher).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  expect(
    await f.db
      .prepare('SELECT user_id FROM local_credentials WHERE user_id=?')
      .bind(user.id)
      .first(),
  ).toBeNull();
});
