// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
it('reconcile enqueue preserves default5 and binds canary1 immutably across replay', async () => {
  const { enqueueDocumentReconcile } = await import('../src/server/documents/reconcile');
  const make = () => {
    let budget: number | undefined;
    const db = {
      prepare(sql: string) {
        return {
          sql,
          args: [] as unknown[],
          bind(...args: unknown[]) {
            this.args = args;
            return this;
          },
          async first() {
            return {
              agency_id: 'synthetic',
              metadata_json: JSON.stringify({ versionId: 'synthetic-version' }),
              max_attempts: budget,
            };
          },
        };
      },
      async batch(s: { args: unknown[] }[]) {
        budget ??= s[0]!.args[2] as number;
        return [];
      },
    } as unknown as D1Database;
    return { db, budget: () => budget };
  };
  const ordinary = make();
  await enqueueDocumentReconcile(
    ordinary.db,
    'synthetic',
    { versionId: 'synthetic-version' },
    'operation',
  );
  expect(ordinary.budget()).toBe(5);
  const canary = make();
  await enqueueDocumentReconcile(
    canary.db,
    'synthetic',
    { versionId: 'synthetic-version' },
    'operation',
    1,
  );
  expect(canary.budget()).toBe(1);
  await expect(
    enqueueDocumentReconcile(
      canary.db,
      'synthetic',
      { versionId: 'synthetic-version' },
      'operation',
      5,
    ),
  ).rejects.toThrow('RECONCILE_TARGET_CONFLICT');
  expect(canary.budget()).toBe(1);
});
it('D1 admission lookup is outside application counter; subsequent queries are measured', async () => {
  const { metrics, countDatabase } = await import('../scripts/canary/metrics');
  let enabled = false;
  const m = metrics(),
    db = countDatabase(
      { prepare: () => ({ first: async () => 1 }) } as unknown as D1Database,
      m,
      () => enabled,
    );
  await db.prepare('scope-control').first();
  expect([m.d1Calls, m.d1Statements]).toEqual([0, 0]);
  enabled = true;
  await db.prepare('application').first();
  expect([m.d1Calls, m.d1Statements]).toEqual([1, 1]);
});
it('preparation CLI emits only closed/proposed files and denies remote flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mayi-p0-prepare-')),
    input = join(dir, 'resources.json');
  try {
    writeFileSync(
      input,
      JSON.stringify({
        databaseId: '00000000-0000-4000-8000-000000000081',
        databaseName: 'mayisigorta-m4-canary-test-db',
        primaryBucket: 'mayisigorta-m4-canary-test-primary',
        recoveryBucket: 'mayisigorta-m4-canary-test-recovery',
        queueName: 'mayisigorta-m4-canary-test-jobs',
        runId: '00000000-0000-4000-8000-000000000082',
      }),
    );
    const run = spawnSync(
      process.execPath,
      ['scripts/canary/prepare-cli.mjs', '--resources', input, '--out', dir],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    expect(
      JSON.parse(readFileSync(join(dir, 'canary-crm.closed.json'), 'utf8')).queues.consumers,
    ).toEqual([]);
    const denied = spawnSync(process.execPath, ['scripts/canary/prepare-cli.mjs', '--remote'], {
      encoding: 'utf8',
    });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('CANARY_PREPARATION_DENIED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('opaque permits are bound to exact env/message and cannot be serialized into a bypass', async () => {
  const { issueClosedCanaryPermit, isClosedCanaryPermit, assertClosedCanaryEnvironment } =
    await import('../src/server/documents/closed-canary');
  const id = '00000000-0000-4000-8000-000000000082',
    sha = 'a'.repeat(64),
    message = {
      jobId: id,
      jobType: 'DOCUMENT_BACKUP' as const,
      generation: 1,
      documentVersionId: id,
      inputSha256: sha,
    };
  const env = {
    DOCUMENTS_ENABLED: 'false',
    APP_ENV: 'test',
    CANARY_QUEUE_COMMISSIONED: 'true',
    CANARY_DATABASE_ID: '00000000-0000-4000-8000-000000000081',
    CANARY_PRIMARY_BUCKET: 'mayisigorta-m4-canary-test-primary',
    CANARY_RECOVERY_BUCKET: 'mayisigorta-m4-canary-test-recovery',
    CANARY_RUN_ID: id,
    CANARY_EXPECTED_SIZE: '1048576',
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            backup_job_id: id,
            reconcile_job_id: null,
            version_id: id,
            checksum: sha,
            size_bytes: 1048576,
          }),
        }),
      }),
    } as unknown as D1Database,
  };
  const batch = { messages: [{ body: message }] } as unknown as MessageBatch<typeof message>;
  for (const key of ['DOCUMENT_JOBS_ENABLED', 'DOCUMENT_CRON_ENABLED'])
    expect(() => assertClosedCanaryEnvironment({ ...env, [key]: 'true' })).toThrow(
      'CANARY_SCOPE_DENIED',
    );
  const permit = await issueClosedCanaryPermit(env, message);
  expect(isClosedCanaryPermit(JSON.parse(JSON.stringify(permit)), env, batch)).toBe(false);
  expect(isClosedCanaryPermit(permit, { ...env }, batch)).toBe(false);
  expect(
    isClosedCanaryPermit(permit, env, {
      messages: [{ body: { ...message, generation: 2 } }],
    } as unknown as MessageBatch<typeof message>),
  ).toBe(false);
  expect(isClosedCanaryPermit(permit, env, batch)).toBe(true);
  expect(isClosedCanaryPermit(permit, env, batch)).toBe(false);
});
it('future isolated config is closed by default and rejects production resource targets', async () => {
  const { buildCanaryConfig } = await import('../scripts/canary/config');
  const resources = {
    databaseId: '00000000-0000-4000-8000-000000000081',
    databaseName: 'mayisigorta-m4-canary-test-db',
    primaryBucket: 'mayisigorta-m4-canary-test-primary',
    recoveryBucket: 'mayisigorta-m4-canary-test-recovery',
    queueName: 'mayisigorta-m4-canary-test-jobs',
    runId: '00000000-0000-4000-8000-000000000082',
  };
  const cfg = buildCanaryConfig(resources);
  expect(cfg.crm.vars.DOCUMENTS_ENABLED).toBe('false');
  expect(cfg.crm.vars.DOCUMENT_JOBS_ENABLED).toBe('false');
  expect(cfg.crm.vars.DOCUMENT_CRON_ENABLED).toBe('false');
  expect(cfg.crm.queues.consumers).toEqual([]);
  expect(cfg.crm.triggers.crons).toEqual([]);
  expect(cfg.crm.workers_dev || cfg.crm.preview_urls).toBe(false);
  expect(() =>
    buildCanaryConfig({ ...resources, databaseId: '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d' }),
  ).toThrow();
  expect(() =>
    buildCanaryConfig({ ...resources, recoveryBucket: 'mayisigorta-crm-recovery' }),
  ).toThrow();
});
it('counterfactual provider receipts are only eligible for independent review; CPU/hash/size violations fail', async () => {
  const { assessProviderEvidence } = await import('../scripts/canary/contract');
  const id = '00000000-0000-4000-8000-000000000082',
    sha = 'a'.repeat(64),
    roles = ['PREPARE', 'BACKUP', 'LEAF_COPY', 'RECONCILE', 'LEAF_OBSERVE', 'HEALTH'];
  const receipt = {
    mode: 'PROVIDER',
    runId: id,
    sizeBytes: 1048576,
    sourceCommit: 'b'.repeat(40),
    accountPlan: 'WORKERS_FREE',
    isolationReadback: true,
    noProductionData: true,
    documentsEnabled: 'false',
    publicExposure: false,
    backupJobCount: 1,
    reconcileJobCount: 1,
    objectCount: 1,
    expectedHash: sha,
    verifiedHash: sha,
    verifiedSize: 1048576,
    completionAudit: 1,
    attempts: 1,
    retries: 0,
    redeliveries: 0,
    finalState: 'AVAILABLE',
    reconcileNoop: true,
    healthHealthy: true,
    contentLeak: false,
    executions: roles.map((role) => ({
      role,
      outcome: 'ok',
      invocationId: id,
      providerReceiptSha256: sha,
      cpuMs: 1,
      cpuLimitMs: 10,
      wallMs: 50,
      peakMemoryBytes: 1048576,
      memoryLimitBytes: 134217728,
      limitScope: 'CALLER_CONTEXT',
      limitsReadbackVerified: true,
    })),
  };
  expect(assessProviderEvidence(receipt)).toBe('ELIGIBLE_FOR_PROVIDER_REVIEW');
  expect(assessProviderEvidence({ ...receipt, verifiedSize: 20971520 })).toBe('FAIL');
  expect(assessProviderEvidence({ ...receipt, verifiedHash: 'c'.repeat(64) })).toBe('FAIL');
  expect(
    assessProviderEvidence({
      ...receipt,
      executions: receipt.executions.map((x) => ({ ...x, cpuMs: 11 })),
    }),
  ).toBe('FAIL');
  expect(
    assessProviderEvidence({
      ...receipt,
      executions: receipt.executions.map((x) => ({ ...x, peakMemoryBytes: 134217728 })),
    }),
  ).toBe('FAIL');
});
it('future provider receipt cannot accept local numbers or missing provider CPU/memory', async () => {
  const { assessProviderEvidence } = await import('../scripts/canary/contract');
  expect(assessProviderEvidence({ mode: 'LOCAL', pass: true, cpuMs: 1 })).toBe('NOT_PROVEN');
  expect(assessProviderEvidence({ mode: 'PROVIDER', pass: true })).toBe('NOT_PROVEN');
});
it('backup Boolean fixture rejects query error, no-data and fractional resampling rather than silent healthy', async () => {
  const { evaluateBackupWindow, interpretFreshnessScalar } =
    await import('../scripts/canary/backup-alert');
  const now = 18000000;
  expect(evaluateBackupWindow([now - 1], now)).toBe('NO_ALERT');
  expect(evaluateBackupWindow([], now)).toBe('ALERT');
  expect(evaluateBackupWindow([now - 2700000 + 1], now)).toBe('NO_ALERT');
  expect(evaluateBackupWindow([now - 2700000 - 1], now)).toBe('ALERT');
  expect(interpretFreshnessScalar(null)).toBe('DIAGNOSTIC');
  expect(interpretFreshnessScalar({ error: true })).toBe('DIAGNOSTIC');
  for (const n of [0.25, 0.4, NaN]) expect(interpretFreshnessScalar(n)).toBe('DIAGNOSTIC');
});
it('private Queue kickoff is bounded, closed and cannot choose data/resources', async () => {
  const { parseCanaryStart } = await import('../scripts/canary/contract');
  const base = {
    kind: 'P0_SYNTHETIC_START',
    runId: '00000000-0000-4000-8000-000000000082',
    sizeBytes: 1048576,
  };
  expect(parseCanaryStart(base, base.runId)).toEqual(base);
  for (const body of [
    { ...base, sizeBytes: 20971521 },
    { ...base, body: 'content' },
    { ...base, bucket: 'mayisigorta-crm-recovery' },
    { ...base, runId: 'wrong' },
  ])
    expect(() => parseCanaryStart(body, base.runId)).toThrow();
});
it('closed canary refuses opaque forgery and production resources before DB work', async () => {
  const { issueClosedCanaryPermit, isClosedCanaryPermit } =
    await import('../src/server/documents/closed-canary');
  let calls = 0;
  const env = {
    DOCUMENTS_ENABLED: 'false',
    APP_ENV: 'production',
    DB: {
      prepare() {
        calls++;
        throw Error();
      },
    },
  };
  await expect(issueClosedCanaryPermit(env as never, { jobId: 'x' } as never)).rejects.toThrow(
    'CANARY_SCOPE_DENIED',
  );
  expect(calls).toBe(0);
  expect(isClosedCanaryPermit({}, env as never, {} as never)).toBe(false);
});
