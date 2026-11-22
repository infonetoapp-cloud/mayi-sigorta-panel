// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/index';
import { localAuthFixture } from './support/local-auth-fixture';
import journal from '../db/migrations/meta/_journal.json';

let fixture: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string;
let member: string;
beforeAll(async () => {
  fixture = await localAuthFixture();
  await fixture.seed('ops-owner', 'OWNER');
  await fixture.seed('ops-member');
  owner = (await fixture.session('ops-owner')).cookie;
  member = (await fixture.session('ops-member')).cookie;
  await fixture.db
    .prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    .run();
  await fixture.db.batch(
    journal.entries.map(({ tag }) =>
      fixture.db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(`${tag}.sql`),
    ),
  );
}, 120000);
afterAll(async () => {
  await fixture?.mf.dispose();
});

function request(cookie?: string, backupAgeMs?: number) {
  const app = createApp({
    readBackupObservation:
      backupAgeMs === undefined
        ? undefined
        : async () => ({
            status: 'HEALTHY',
            checkedAt: Date.now() - 100,
            exportAt: Date.now() - backupAgeMs,
            reason: 'SYNTHETIC',
          }),
  });
  return app.request(
    'https://panel.mayisigorta.com/api/ops/readiness',
    { headers: cookie ? { cookie } : {} },
    fixture.env,
  );
}

it('requires a valid owner session and never exposes operational data to a member', async () => {
  for (const [cookie, status] of [
    [undefined, 401],
    [member, 403],
  ] as const) {
    const result = await request(cookie, 0);
    expect(result.status).toBe(status);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(await result.json()).not.toHaveProperty('data');
  }
});
it('reports database and schema separately and fails closed when backup evidence is missing', async () => {
  const result = await request(owner);
  expect(result.status).toBe(503);
  expect(await result.json()).toMatchObject({
    success: false,
    data: {
      database: 'OK',
      schema: 'OK',
      backup: 'UNKNOWN',
      backupAgeMinutes: null,
      renewals: 'IDLE',
      documentJobs: 'INACTIVE',
    },
  });
});
it('uses the verified observation timestamp and rejects stale backups', async () => {
  const current = await request(owner, 60_100);
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ data: { backup: 'OK', backupAgeMinutes: 1 } });
  const stale = await request(owner, 46 * 60_000);
  expect(stale.status).toBe(503);
  expect(await stale.json()).toMatchObject({ data: { backup: 'STALE', backupAgeMinutes: 46 } });
});
it('keeps production document worker and scheduler visible when employee access is off', async () => {
  const result = await createApp().request(
    'https://panel.mayisigorta.com/api/ops/readiness',
    { headers: { cookie: owner } },
    {
      ...fixture.env,
      DOCUMENTS_ENABLED: 'false',
      DOCUMENT_JOBS_ENABLED: 'true',
      DOCUMENT_CRON_ENABLED: 'true',
    },
  );
  expect(result.status).toBe(503);
  expect(await result.json()).toMatchObject({
    data: {
      documentJobs: 'UNKNOWN',
      documentAccessEnabled: false,
      documentWorkerEnabled: true,
      documentScheduleEnabled: true,
      documentLastSuccessAt: null,
    },
  });
});
it('reports schema drift separately and returns no false success', async () => {
  await fixture.db.prepare("UPDATE d1_migrations SET name='altered.sql' WHERE id=1").run();
  try {
    const result = await request(owner, 2000);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({
      data: { database: 'OK', schema: 'MISMATCH', backup: 'OK' },
    });
  } finally {
    await fixture.db
      .prepare('UPDATE d1_migrations SET name=? WHERE id=1')
      .bind(`${journal.entries[0]!.tag}.sql`)
      .run();
  }
});

it('reads validated backup evidence from the private service binding after owner authorization', async () => {
  const app = createApp();
  const fetchStatus = vi.fn(async (_input: string, _init: RequestInit) => {
    const checkedAt = Date.now();
    return Response.json({
      status: 'HEALTHY',
      reason: 'COHERENT_RECENT_COMPLETE',
      checkedAt,
      completeAt: checkedAt - 70_000,
      exportAt: checkedAt - 82_000,
    });
  });
  const env = { ...fixture.env, OPS_BACKUP_STATUS: { fetch: fetchStatus } };
  const route = 'https://panel.mayisigorta.com/api/ops/readiness';
  expect((await app.request(route, { headers: { cookie: member } }, env)).status).toBe(403);
  expect(fetchStatus).not.toHaveBeenCalled();
  const current = await app.request(route, { headers: { cookie: owner } }, env);
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ data: { backup: 'OK', backupAgeMinutes: 1 } });
  expect(fetchStatus.mock.calls[0]).toMatchObject([
    'https://backup-observer.invalid/internal/latest',
    { method: 'GET', redirect: 'error' },
  ]);
  fetchStatus.mockImplementationOnce(async () =>
    Response.json({ status: 'HEALTHY', checkedAt: Date.now(), reason: 'INCOMPLETE' }),
  );
  const malformed = await app.request(route, { headers: { cookie: owner } }, env);
  expect(malformed.status).toBe(503);
  expect(await malformed.json()).toMatchObject({ data: { backup: 'UNKNOWN' } });
});

it('returns a generic service-unavailable response when the session database is down', async () => {
  const response = await createApp().request(
    'https://panel.mayisigorta.com/api/ops/readiness',
    { headers: { cookie: owner } },
    {
      ...fixture.env,
      DB: {
        prepare: () => {
          throw new Error('synthetic db outage');
        },
      },
    },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    success: false,
    error: { code: 'SERVICE_UNAVAILABLE' },
  });
});
