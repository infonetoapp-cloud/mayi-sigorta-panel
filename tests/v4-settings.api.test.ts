// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, editor: string, member: string, foreign: string;
beforeAll(async () => {
  f = await localAuthFixture();
  f.env.DB = { prepare: f.db.prepare.bind(f.db), batch: f.db.batch.bind(f.db) } as D1Database;
  await f.seed('settings-owner', 'OWNER');
  const e = await f.seed('settings-editor');
  await f.seed('settings-member');
  await f.seed('settings-foreign', 'OWNER', false, 'settings-other');
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'agency.settings.manage','UNSCOPED')",
    )
    .bind(crypto.randomUUID(), e.membershipId)
    .run();
  owner = (await f.session('settings-owner')).cookie;
  editor = (await f.session('settings-editor')).cookie;
  member = (await f.session('settings-member')).cookie;
  foreign = (await f.session('settings-foreign')).cookie;
});
afterAll(async () => {
  await f?.mf.dispose();
});
async function current(cookie = owner) {
  return (
    (await (await f.request('/api/agency/settings', 'GET', cookie)).json()) as {
      data: {
        version: number;
        renewalWindowDays: number;
        timezone: string;
        defaultInsurerId: string | null;
      };
    }
  ).data;
}
async function write(body: unknown, cookie = owner, key = crypto.randomUUID()) {
  return f.request('/api/agency/settings', 'PATCH', cookie, body, await f.csrf(cookie), {
    'idempotency-key': key,
  });
}
it('derives operational edit capability from the exact server action for OWNER, delegated and ordinary MEMBER', async () => {
  for (const [cookie, canManage] of [
    [owner, true],
    [editor, true],
    [member, false],
  ] as const) {
    const r = await f.request('/api/agency/settings/capabilities', 'GET', cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(((await r.json()) as { data: unknown }).data).toEqual({ canManage });
  }
});
it('allows active MEMBER reading while rejecting writes without the exact permission and enforces CSRF', async () => {
  expect((await f.request('/api/agency/settings', 'GET', member)).status).toBe(200);
  expect((await write({ expectedVersion: 1, renewalWindowDays: 44 }, member)).status).toBe(403);
  expect(
    (
      await f.request(
        '/api/agency/settings',
        'PATCH',
        owner,
        { expectedVersion: 1, renewalWindowDays: 44 },
        undefined,
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(403);
  expect((await f.request('/api/agency/settings', 'GET')).status).toBe(401);
});
it('persists delegated edits, replays one logical write once, and does not cross the agency boundary', async () => {
  const s = await current();
  const key = crypto.randomUUID();
  const body = { expectedVersion: s.version, renewalWindowDays: 44 };
  expect((await write(body, editor, key)).status).toBe(200);
  expect((await write(body, editor, key)).status).toBe(200);
  expect((await current(member)).renewalWindowDays).toBe(44);
  expect((await current(foreign)).renewalWindowDays).toBe(30);
  expect(
    await f.db
      .prepare('SELECT count(*) n FROM audit_events WHERE idempotency_key=?')
      .bind(key)
      .first('n'),
  ).toBe(1);
  expect(
    await f.db
      .prepare('SELECT count(*) n FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first('n'),
  ).toBe(1);
  expect((await write({ ...body, renewalWindowDays: 45 }, editor, key)).status).toBe(409);
});
it('rejects fractional, out of range, malformed timezone and authority-injection input without changing settings', async () => {
  const s = await current();
  for (const fields of [
    { renewalWindowDays: 0 },
    { renewalWindowDays: 121 },
    { renewalWindowDays: 1.5 },
    { timezone: 'Mars/Mayi' },
    { agencyId: 'settings-other', renewalWindowDays: 20 },
  ])
    expect((await write({ expectedVersion: s.version, ...fields })).status).toBe(400);
  expect(await current()).toEqual(s);
});
it('rendezvous two competing D1 commits and rejects one version without partial effect', async () => {
  const s = await current();
  const csrf = await f.csrf(owner);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(f.env.DB, 'batch').mockImplementation(async (...args) => {
    if (++arrivals === 2) release();
    await barrier;
    return f.db.batch(...args);
  });
  let results: Response[];
  try {
    results = await Promise.all(
      [46, 47].map((renewalWindowDays) =>
        f.request(
          '/api/agency/settings',
          'PATCH',
          owner,
          { expectedVersion: s.version, renewalWindowDays },
          csrf,
          { 'idempotency-key': crypto.randomUUID() },
        ),
      ),
    );
  } finally {
    spy.mockRestore();
  }
  expect(arrivals).toBe(2);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await current()).version).toBe(s.version + 1);
});
it('validates same-agency active default insurer and preserves the old insurer on ordinary changes', async () => {
  const create = async (cookie: string, code: string) => {
    const r = await f.request(
      '/api/catalogs/insurers',
      'POST',
      cookie,
      { code, name: 'Sentetik ' + code },
      await f.csrf(cookie),
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  const ours = await create(owner, 'SETTINGS_LOCAL'),
    other = await create(foreign, 'SETTINGS_FOREIGN');
  let s = await current();
  expect((await write({ expectedVersion: s.version, defaultInsurerId: other })).status).toBe(409);
  expect((await write({ expectedVersion: s.version, defaultInsurerId: ours })).status).toBe(200);
  s = await current();
  expect(s.defaultInsurerId).toBe(ours);
  expect((await write({ expectedVersion: s.version, defaultInsurerId: null })).status).toBe(200);
  expect(
    await f.db.prepare('SELECT status FROM insurers WHERE id=?').bind(ours).first('status'),
  ).toBe('ACTIVE');
});
it('rechecks revoked permission for both capability and completed replay', async () => {
  const s = await current(),
    key = crypto.randomUUID(),
    body = { expectedVersion: s.version, renewalWindowDays: 48 };
  expect((await write(body, editor, key)).status).toBe(200);
  await f.db
    .prepare("DELETE FROM membership_permissions WHERE membership_id='membership-settings-editor'")
    .run();
  expect((await f.request('/api/agency/settings/capabilities', 'GET', editor)).status).toBe(200);
  expect(
    (
      (await (await f.request('/api/agency/settings/capabilities', 'GET', editor)).json()) as {
        data: { canManage: boolean };
      }
    ).data.canManage,
  ).toBe(false);
  expect((await write(body, editor, key)).status).toBe(403);
  expect((await current()).renewalWindowDays).toBe(48);
});
it('rejects revoked real cookie sessions for settings read, capability, and write', async () => {
  const session = await f.session('settings-owner'),
    csrf = await f.csrf(session.cookie);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), session.hash)
    .run();
  expect((await f.request('/api/agency/settings', 'GET', session.cookie)).status).toBe(401);
  expect((await f.request('/api/agency/settings/capabilities', 'GET', session.cookie)).status).toBe(
    401,
  );
  expect(
    (
      await f.request(
        '/api/agency/settings',
        'PATCH',
        session.cookie,
        { expectedVersion: 1, renewalWindowDays: 5 },
        csrf,
        { 'idempotency-key': crypto.randomUUID() },
      )
    ).status,
  ).toBe(401);
});
