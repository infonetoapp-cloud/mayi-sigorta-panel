// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
// Unused DO re-export base only: real default handler/native D1, not KDF proof.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import worker from '../src/server/worker';
import { localAuthFixture } from './support/local-auth-fixture';
let fixture: Awaited<ReturnType<typeof localAuthFixture>>;
// Trusted future observation clock allows real SQL lease-claim guards to stay
// intact while the monitor observes expiry; never disable a state trigger.
const now = Date.now() + 3600000;
const iso = (ms: number) => new Date(ms).toISOString();
beforeAll(async () => {
  fixture = await localAuthFixture();
  await fixture.db
    .prepare("INSERT INTO agencies(id,status) VALUES('health-agency','PROVISIONING')")
    .run();
  await fixture.seed('health-owner', 'OWNER', false, 'health-doc-agency');
}, 180000);
afterAll(async () => {
  await fixture?.mf.dispose();
});
async function reconcileJob(
  id: string,
  status = 'DEAD',
  available = now - 7200000,
  runStatus = 'PERMANENT_ERROR',
) {
  await fixture.db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,max_attempts,available_at,created_at,updated_at) VALUES(?,'health-agency','DOCUMENT_RECONCILE',1,?,?,?)`,
    )
    .bind(id, iso(available), iso(now - 7200000), iso(now))
    .run();
  if (status === 'QUEUED') return;
  await fixture.db
    .prepare(
      "UPDATE background_jobs SET status='RUNNING',attempt_count=1,lease_token_hash=?,lease_expires_at=? WHERE id=?",
    )
    .bind('1'.repeat(64), iso(now - 1), id)
    .run();
  await fixture.db
    .prepare(
      "INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash) VALUES(?,'health-agency',?,1,?)",
    )
    .bind('run-' + id, id, '1'.repeat(64))
    .run();
  if (status === 'RUNNING') return;
  await fixture.db
    .prepare(
      "UPDATE background_job_runs SET status=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=?",
    )
    .bind(runStatus, id)
    .run();
  await fixture.db
    .prepare(
      'UPDATE background_jobs SET status=?,completed_at=?,lease_token_hash=NULL,lease_expires_at=NULL WHERE id=?',
    )
    .bind(status, iso(now), id)
    .run();
}
it('counts durable DEAD reconcile work without returning job identifiers or error text', async () => {
  await reconcileJob('synthetic-dead');
  const module = await import('../src/server/documents/health').catch(() => null);
  expect(module).not.toBeNull();
  const snapshot = await module!.evaluateDocumentHealth(fixture.db, now);
  expect(snapshot.counts.dead).toBe(1);
  expect(JSON.stringify(snapshot).includes('synthetic-dead')).toBe(false);
});

it('separates due work, fifteen-minute stall, expired lease and COMPLETED investigation', async () => {
  const { evaluateDocumentHealth } = await import('../src/server/documents/health');
  const before = await evaluateDocumentHealth(fixture.db, now);
  await reconcileJob('synthetic-due', 'QUEUED', now);
  await reconcileJob('synthetic-future', 'QUEUED', now + 1);
  await reconcileJob('synthetic-stalled', 'QUEUED', now - 900001);
  await reconcileJob('synthetic-boundary', 'QUEUED', now - 900000);
  await reconcileJob('synthetic-expired', 'RUNNING');
  await reconcileJob('synthetic-investigation', 'COMPLETED');
  await fixture.db
    .prepare(
      "UPDATE background_jobs SET last_error_code='RECONCILE_OBJECT_INTEGRITY_INVALID' WHERE id='synthetic-investigation'",
    )
    .run();
  const after = await evaluateDocumentHealth(fixture.db, now);
  expect(after.counts.due - before.counts.due).toBe(3);
  expect(after.counts.stalledDue - before.counts.stalledDue).toBe(1);
  expect(after.counts.expiredLeases - before.counts.expiredLeases).toBe(1);
  expect(after.counts.completedInvestigations - before.counts.completedInvestigations).toBe(1);
  expect(JSON.stringify(after).includes('RECONCILE_OBJECT_INTEGRITY_INVALID')).toBe(false);
});

it('does not confuse completed successful reconcile runs with permanent investigation evidence', async () => {
  const { evaluateDocumentHealth } = await import('../src/server/documents/health');
  const before = await evaluateDocumentHealth(fixture.db, now);
  await reconcileJob('synthetic-success-with-marker', 'COMPLETED', now - 7200000, 'SUCCEEDED');
  await fixture.db
    .prepare(
      "UPDATE background_jobs SET last_error_code='QUEUE_DELIVERY_EXHAUSTED' WHERE id='synthetic-success-with-marker'",
    )
    .run();
  const after = await evaluateDocumentHealth(fixture.db, now);
  expect(after.counts.completedInvestigations - before.counts.completedInvestigations).toBe(0);
});
async function pendingVersion(at: number, finalize = true) {
  const db = fixture.db,
    id = crypto.randomUUID(),
    version = crypto.randomUUID(),
    customer = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,company_title,assignee_membership_id) VALUES(?,'health-doc-agency','COMPANY','Synthetic health','Synthetic health','membership-health-owner')",
    )
    .bind(customer)
    .run();
  await db
    .prepare(
      "INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id) VALUES(?,'health-doc-agency','CUSTOMER',?,'health-owner','membership-health-owner')",
    )
    .bind(id, customer)
    .run();
  await db
    .prepare(
      "INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id) VALUES(?,'health-doc-agency',?,1,?,?,1,'synthetic.pdf','application/pdf','health-owner','membership-health-owner')",
    )
    .bind(version, id, 'quarantine/' + crypto.randomUUID(), '2'.repeat(64))
    .run();
  if (finalize) {
    await db
      .prepare(
        "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,available_at,created_at,updated_at) VALUES(?,'health-doc-agency','DOCUMENT_BACKUP',?,?,?,?,?)",
      )
      .bind(crypto.randomUUID(), version, '2'.repeat(64), iso(at), iso(at), iso(at))
      .run();
    await db
      .prepare(
        "UPDATE document_versions SET status='BACKUP_PENDING',validation_version='m4-content-inspection-v1',validation_result=?,updated_at=? WHERE id=?",
      )
      .bind(JSON.stringify({ format: 'PDF', pageCount: 1, valid: true }), iso(at), version)
      .run();
  }
  return version;
}
it('makes stale unfinalized upload reservations visible separately from backups', async () => {
  const { evaluateDocumentHealth } = await import('../src/server/documents/health');
  const before = await evaluateDocumentHealth(fixture.db, now);
  await pendingVersion(now - 1800000, false);
  const after = await evaluateDocumentHealth(fixture.db, now);
  expect(
    (after.counts as unknown as Record<string, number>).overdueUploads! -
      (before.counts as unknown as Record<string, number>).overdueUploads!,
  ).toBe(1);
});
it('counts only BACKUP_PENDING older than fifteen minutes, not reservation age', async () => {
  const { evaluateDocumentHealth } = await import('../src/server/documents/health');
  const before = await evaluateDocumentHealth(fixture.db, now);
  await pendingVersion(now - 900001);
  await pendingVersion(now - 900000);
  await pendingVersion(now - 899999);
  await pendingVersion(now - 1800000, false);
  const after = await evaluateDocumentHealth(fixture.db, now);
  expect(after.counts.overdueBackups - before.counts.overdueBackups).toBe(1);
});

it('leaves historical SCAN jobs outside active due/backlog metrics', async () => {
  const { evaluateDocumentHealth } = await import('../src/server/documents/health');
  const before = await evaluateDocumentHealth(fixture.db, now);
  const version = await pendingVersion(now, false);
  await fixture.db
    .prepare(
      "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,available_at) VALUES(?,'health-doc-agency','DOCUMENT_SCAN',?,?,?)",
    )
    .bind(crypto.randomUUID(), version, '2'.repeat(64), iso(now - 7200000))
    .run();
  const after = await evaluateDocumentHealth(fixture.db, now);
  expect(after.counts.due - before.counts.due).toBe(0);
  expect(after.counts.stalledDue - before.counts.stalledDue).toBe(0);
});
it('default five-minute scheduled handler alerts without Queue and cannot write D1', async () => {
  await reconcileJob('synthetic-scheduled-dead');
  const fingerprint = async () =>
    JSON.stringify(
      await Promise.all(
        ['background_jobs', 'background_job_runs', 'document_versions', 'system_audit_events'].map(
          async (table) =>
            (await fixture.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results,
        ),
      ),
    );
  const before = await fingerprint();
  let reads = 0;
  const readonly = {
    prepare: (sql: string) => {
      expect(/^\s*(WITH|SELECT)\b/u.test(sql)).toBe(true);
      reads++;
      return fixture.db.prepare(sql);
    },
    batch: () => {
      throw new Error('READ_ONLY_MONITOR');
    },
  } as unknown as D1Database;
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const work: Promise<unknown>[] = [];
  try {
    worker.scheduled(
      { cron: '*/5 * * * *', scheduledTime: now } as ScheduledController,
      { DB: readonly, DOCUMENT_CRON_ENABLED: 'true' } as never,
      { waitUntil: (p: Promise<unknown>) => work.push(p) } as unknown as ExecutionContext,
    );
    expect(work.length).toBe(1);
    await Promise.all(work);
    expect(reads).toBe(1);
    expect(logs.mock.calls.length).toBe(1);
    const event = JSON.parse(String(logs.mock.calls[0]![0])) as {
      code: string;
      counts: { dead: number };
      scope: string;
    };
    expect(event.code).toBe('DOCUMENT_DURABLE_BACKLOG');
    expect(event.counts.dead > 0).toBe(true);
    expect(event.scope).toBe('ALL_AGENCIES_OPERATIONS_ONLY');
    expect(JSON.stringify(event).includes('synthetic-scheduled-dead')).toBe(false);
    expect((await fingerprint()) === before).toBe(true);
  } finally {
    logs.mockRestore();
  }
});

it.each([
  ['*/5 * * * *', 'false'],
  ['*/5 * * * *', undefined],
  ['*/5 * * * *', 'TRUE'],
  ['*/10 * * * *', 'true'],
])('cron/documents gate %s/%s performs zero work', async (cron, enabled) => {
  const db = {
    prepare: () => {
      throw new Error('UNEXPECTED_MONITOR_READ');
    },
  } as unknown as D1Database;
  const work: Promise<unknown>[] = [];
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    worker.scheduled(
      { cron } as ScheduledController,
      { DB: db, DOCUMENT_CRON_ENABLED: enabled } as never,
      { waitUntil: (p: Promise<unknown>) => work.push(p) } as unknown as ExecutionContext,
    );
    expect(work.length).toBe(0);
    expect(logs.mock.calls.length).toBe(0);
  } finally {
    logs.mockRestore();
  }
});
const healthyRow = {
  dead: 0,
  due: 0,
  stalledDue: 0,
  expiredLeases: 0,
  completedInvestigations: 0,
  overdueBackups: 0,
  overdueUploads: 0,
};
const resultDb = (row: unknown) =>
  ({ prepare: () => ({ bind: () => ({ first: async () => row }) }) }) as unknown as D1Database;
it('healthy and merely due snapshots remain silent; same slot keys are deterministic, not durable dedupe', async () => {
  const { runDocumentHealthMonitoring } = await import('../src/server/documents/health');
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await runDocumentHealthMonitoring(resultDb(healthyRow), now);
    await runDocumentHealthMonitoring(resultDb({ ...healthyRow, due: 2 }), now);
    expect(logs.mock.calls.length).toBe(0);
    const slot = Math.floor(now / 300000) * 300000;
    await runDocumentHealthMonitoring(resultDb({ ...healthyRow, dead: 1 }), slot);
    await runDocumentHealthMonitoring(resultDb({ ...healthyRow, dead: 1 }), slot + 1);
    await runDocumentHealthMonitoring(resultDb({ ...healthyRow, dead: 1 }), slot + 300000);
    const events = logs.mock.calls.map((c) => JSON.parse(String(c[0])) as { eventKey: string });
    expect(events[0]!.eventKey === events[1]!.eventKey).toBe(true);
    expect(events[0]!.eventKey !== events[2]!.eventKey).toBe(true);
    expect(events.length).toBe(3);
  } finally {
    logs.mockRestore();
  }
});
it('caps aggregate payload while flagging truncated counts and rejecting malformed results', async () => {
  const { evaluateDocumentHealth } = await import('../src/server/documents/health');
  const result = await evaluateDocumentHealth(resultDb({ ...healthyRow, due: 1001 }), now);
  expect(result.counts.due).toBe(1000);
  expect(result.truncated).toBe(true);
  for (const row of [
    null,
    { ...healthyRow, dead: -1 },
    { ...healthyRow, due: 0.5 },
    { ...healthyRow, due: 1002 },
    { ...healthyRow, dead: '1' },
    { dead: 0 },
  ])
    await expect(evaluateDocumentHealth(resultDb(row), now)).rejects.toThrow(
      'DOCUMENT_HEALTH_RESULT_INVALID',
    );
  await expect(evaluateDocumentHealth(resultDb(healthyRow), NaN)).rejects.toThrow(
    'DOCUMENT_HEALTH_CLOCK_INVALID',
  );
});
it('caps monitoring wait when the D1 read never resolves and clears its timer', async () => {
  const { runDocumentHealthMonitoring } = await import('../src/server/documents/health');
  const db = {
    prepare: () => ({ bind: () => ({ first: () => new Promise(() => undefined) }) }),
  } as unknown as D1Database;
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers();
  try {
    let error: Error | undefined;
    void runDocumentHealthMonitoring(db, now).catch((e: unknown) => {
      error = e as Error;
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(error?.message).toBe('DOCUMENT_HEALTH_READ_FAILED');
    expect(vi.getTimerCount()).toBe(0);
    expect(logs.mock.calls.length).toBe(1);
  } finally {
    vi.useRealTimers();
    logs.mockRestore();
  }
});
it('sanitizes a failing log sink instead of retaining its error or cause', async () => {
  const { runDocumentHealthMonitoring } = await import('../src/server/documents/health');
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('synthetic-private-sink-detail');
  });
  try {
    const error = await runDocumentHealthMonitoring(resultDb({ ...healthyRow, dead: 1 }), now).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe('DOCUMENT_HEALTH_SINK_FAILED');
    expect(error?.cause).toBeUndefined();
    expect(error?.stack?.includes('synthetic-private-sink-detail')).toBe(false);
  } finally {
    logs.mockRestore();
  }
});
it('sanitizes D1 failure in scheduled log and rejection, without swallowing failure', async () => {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          throw new Error('synthetic-confidential-provider-detail');
        },
      }),
    }),
  } as unknown as D1Database;
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    work: Promise<unknown>[] = [];
  try {
    worker.scheduled(
      { cron: '*/5 * * * *' } as ScheduledController,
      { DB: db, DOCUMENT_CRON_ENABLED: 'true' } as never,
      { waitUntil: (p: Promise<unknown>) => work.push(p) } as unknown as ExecutionContext,
    );
    const error = await Promise.all(work).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe('DOCUMENT_HEALTH_READ_FAILED');
    expect(error?.cause).toBeUndefined();
    expect(error?.stack?.includes('synthetic-confidential-provider-detail')).toBe(false);
    expect(logs.mock.calls.length).toBe(1);
    const text = JSON.stringify(logs.mock.calls);
    expect(text.includes('synthetic-confidential-provider-detail')).toBe(false);
    expect(text.includes('DOCUMENT_HEALTH_READ_FAILED')).toBe(true);
  } finally {
    logs.mockRestore();
  }
});
