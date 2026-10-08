// @vitest-environment node
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { provisionInitialAgency, administerLocalOwner } from '../src/server/auth/admin';
import { localAuthFixture } from './support/local-auth-fixture';

vi.mock('../src/server/auth/password', async (original) => ({
  ...(await original<typeof import('../src/server/auth/password')>()),
  generateTemporaryPassword: () => 'SYNTHETIC-TEMPORARY-FIXTURE-ONLY',
}));
const remote = await import('../scripts/' + 'remote-auth-admin.mjs');
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const target = {
  mode: 'provision-agency' as const,
  accountId: 'a'.repeat(32),
  databaseId: '00000000-0000-4000-8000-000000000027',
  agencyId: 'synthetic-remote-agency',
  operationKey: 'synthetic-remote-operation',
};
const env = { CLOUDFLARE_EMAIL: 'synthetic@example.invalid', CLOUDFLARE_API_KEY: 'synthetic-key' };
type Query = { sql: string; params: (string | number | null)[] };
const calls: { batch?: Query[]; sql?: string; params?: Query['params'] }[] = [];
const fetch = vi.fn(async (url: string, init: RequestInit) => {
  expect(init.redirect).toBe('manual');
  expect(init.headers).toMatchObject({ 'X-Auth-Key': env.CLOUDFLARE_API_KEY });
  if (init.method === 'GET')
    return Response.json({
      success: true,
      result: url.endsWith('/user')
        ? { two_factor_authentication_enabled: true, two_factor_authentication_locked: true }
        : { uuid: target.databaseId },
    });
  const body = JSON.parse(init.body as string);
  calls.push(body);
  const statements: Query[] = body.batch ?? [body];
  try {
    // MOCK HTTP provider backed by disposable LOCAL native D1; not remote atomicity evidence.
    const results = await f.db.batch(statements.map((s) => f.db.prepare(s.sql).bind(...s.params)));
    return Response.json({ success: true, result: results });
  } catch {
    return Response.json({ success: false, result: null });
  }
});
beforeAll(async () => {
  f = await localAuthFixture();
});
afterAll(async () => {
  await f?.mf.dispose();
});

it('same agency primitive sends five statements once, preserves exact replay and rejects conflicts without auth effects', async () => {
  const db = (await remote.openRemoteAdminDatabase(target, env, fetch)) as D1Database;
  const first = await provisionInitialAgency(db, target);
  const firstBatch = calls[0]!.batch!;
  expect(firstBatch).toHaveLength(5);
  expect(calls).toHaveLength(1);
  expect(firstBatch.filter((s) => /INSERT INTO agencies/.test(s.sql))).toHaveLength(1);
  expect(firstBatch.filter((s) => /INSERT INTO system_audit_events/.test(s.sql))).toHaveLength(1);
  expect(
    firstBatch.some((s) =>
      /(?:INSERT INTO|UPDATE) (?:users|agency_memberships|auth_identities|local_credentials|local_sessions)/.test(
        s.sql,
      ),
    ),
  ).toBe(false);
  expect(await provisionInitialAgency(db, target)).toEqual(first);
  await expect(
    provisionInitialAgency(db, { ...target, agencyId: 'conflicting-agency' }),
  ).rejects.toThrow();
  await expect(
    provisionInitialAgency(db, { ...target, operationKey: 'conflicting-operation' }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(4); // one request per explicit operation, no retry
  for (const table of [
    'users',
    'agency_memberships',
    'auth_identities',
    'local_credentials',
    'local_sessions',
  ])
    expect(await f.db.prepare(`SELECT count(*) n FROM ${table}`).first()).toEqual({ n: 0 });
  expect(await f.db.prepare('SELECT count(*) n FROM agencies').first()).toEqual({ n: 1 });
  expect(await f.db.prepare('SELECT count(*) n FROM system_audit_events').first()).toEqual({
    n: 1,
  });
  expect(f.hasher.calls).toBe(0);
});

it('existing OWNER bootstrap/break-glass use the adapter without persisting synthetic plaintext', async () => {
  const db = (await remote.openRemoteAdminDatabase(target, env, fetch)) as D1Database;
  const owner = {
    ...target,
    mode: 'bootstrap' as const,
    ownerUserId: 'synthetic-owner',
    email: 'synthetic-owner@example.invalid',
    name: 'Synthetic Owner',
    operationKey: 'synthetic-bootstrap-operation',
  };
  const result = await administerLocalOwner(db, owner, f.hasher);
  expect(result.temporaryPassword).toBe('SYNTHETIC-TEMPORARY-FIXTURE-ONLY');
  expect(await f.db.prepare('SELECT must_change_password FROM local_credentials').first()).toEqual({
    must_change_password: 1,
  });
  await expect(administerLocalOwner(db, owner, f.hasher)).rejects.toThrow(
    'ONE_TIME_RESPONSE_UNAVAILABLE',
  );
  const recovery = await administerLocalOwner(
    db,
    { ...owner, mode: 'break-glass', operationKey: 'synthetic-breakglass-operation' },
    f.hasher,
  );
  expect(recovery.temporaryPassword).toBe(result.temporaryPassword);
  for (const table of ['local_credentials', 'system_audit_events', 'credential_operation_receipts'])
    expect(
      JSON.stringify((await f.db.prepare(`SELECT * FROM ${table}`).all()).results),
    ).not.toContain(result.temporaryPassword);
  expect(JSON.stringify(calls)).not.toContain(result.temporaryPassword);
});
