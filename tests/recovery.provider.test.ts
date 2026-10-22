// @vitest-environment node
import { beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runProviderRecovery, providerPlan } from '../scripts/recovery/provider-runner';
import { retainSyntheticBundle } from '../scripts/recovery/executor-bundle';
const root = mkdtempSync(join(tmpdir(), 'mayi-provider-tests-'));
let pins: Awaited<ReturnType<typeof retainSyntheticBundle>>,
  serial = 0;
beforeAll(async () => {
  pins = await retainSyntheticBundle(join(root, 'bundle'));
  writeFileSync(
    join(root, 'bundle-hashes.json'),
    JSON.stringify({ directory: join(root, 'bundle'), ...pins }, null, 2),
  );
}, 180000);
function scenario(fault = 'none') {
  const id = ++serial,
    fakeDirectory = join(root, `fake-${id}`);
  mkdirSync(fakeDirectory);
  writeFileSync(join(fakeDirectory, 'fake-config.json'), JSON.stringify({ fault }));
  const options = {
    mode: 'SIMULATE_PROVIDER',
    bundleDirectory: join(root, 'bundle'),
    manifestSha256: pins.manifestSha256,
    authorityPath: join(root, 'bundle', 'current-authority.json'),
    authoritySha256: pins.authoritySha256,
    runId: crypto.randomUUID(),
    runDirectory: join(root, `run-${id}`),
    fakeDirectory,
  };
  const plan = providerPlan(options),
    now = Date.now();
  return {
    ...options,
    approval: {
      kind: 'OWNER_OPS001_PROVIDER_V1',
      owner: 'Synthetic operator',
      planSha256: plan.planSha256,
      capacityReceiptSha256: '0'.repeat(64),
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 600000).toISOString(),
      allowCreate: true,
      allowImport: true,
      allowReconcile: true,
      allowOwnedCleanup: true,
      allowProviderManagedStaging: true,
      allowProduction: false,
      allowDeploy: false,
    },
  };
}
function state(options: ReturnType<typeof scenario>) {
  return JSON.parse(readFileSync(join(options.fakeDirectory, 'fake-state.json'), 'utf8')) as {
    create: number;
    ingest: number;
    reconcile: number;
    delete: number;
    calls: unknown[];
    resources: unknown[];
    queryBatches: string[];
  };
}
it('defaults to offline before any provider process or HTTP request', async () => {
  expect(await runProviderRecovery()).toMatchObject({
    code: 'OFFLINE_DRY_RUN',
    remoteOperations: 0,
    publication: 'SEALED',
  });
});
it('integrates the query batch lifecycle with exact verification and owned cleanup', async () => {
  const op = { ...scenario(), restoreTransport: 'QUERY_BATCH' };
  op.approval.planSha256 = providerPlan(op).planSha256;
  expect(await runProviderRecovery(op)).toMatchObject({
    code: 'SIMULATED_PROVIDER_VERIFIED_SEALED',
    sqlVerification: 'PASS',
    publication: 'SEALED',
  });
  expect(state(op)).toMatchObject({ create: 1, ingest: 0, reconcile: 0, delete: 0 });
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe('PROVIDER_CLEANED');
  expect(state(op)).toMatchObject({ delete: 1, resources: [] });
}, 120000);
it('resumes a lost query response through exact checkpoint readback without duplicating a batch', async () => {
  const op = { ...scenario('queryResponseLost'), restoreTransport: 'QUERY_BATCH' };
  op.approval.planSha256 = providerPlan(op).planSha256;
  expect((await runProviderRecovery(op)).code).toBe('QUERY_PHASE_RESULT_UNKNOWN');
  expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
  expect(state(op).queryBatches).toEqual(['schema', 'data', 'guards', 'authority']);
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe('PROVIDER_CLEANED');
  expect(state(op).delete).toBe(1);
}, 120000);
it.each(['queryNoEffect', 'queryCorrupt'])(
  'leaves %s sealed without reapplying or unsafe deletion',
  async (fault) => {
    const op = { ...scenario(fault), restoreTransport: 'QUERY_BATCH' };
    op.approval.planSha256 = providerPlan(op).planSha256;
    expect((await runProviderRecovery(op)).code).toBe('QUERY_PHASE_RESULT_UNKNOWN');
    expect((await runProviderRecovery(op)).code).toBe('QUERY_PHASE_RESULT_UNKNOWN');
    expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(
      'QUERY_PHASE_RESULT_UNKNOWN',
    );
    expect(state(op).queryBatches).toEqual(['schema', 'data']);
    expect(state(op).delete).toBe(0);
  },
  120000,
);
it('cleans a proved partial query restore without applying its remaining phases', async () => {
  const op = { ...scenario('queryResponseLost'), restoreTransport: 'QUERY_BATCH' };
  op.approval.planSha256 = providerPlan(op).planSha256;
  expect((await runProviderRecovery(op)).code).toBe('QUERY_PHASE_RESULT_UNKNOWN');
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe('PROVIDER_CLEANED');
  expect(state(op).queryBatches).toEqual(['schema', 'data']);
  expect(state(op)).toMatchObject({ delete: 1, resources: [] });
}, 120000);
it('runs the standalone query CLI dry-run with a fresh fixture and no historical files', () => {
  const op = { ...scenario(), mode: 'OFFLINE_DRY_RUN', restoreTransport: 'QUERY_BATCH' };
  const path = join(root, 'query-dry-run.json');
  writeFileSync(path, JSON.stringify(op), { flag: 'wx' });
  const child = spawnSync(
    process.execPath,
    ['scripts/recovery/provider-cli.mjs', '--options', path],
    { encoding: 'utf8', timeout: 30000 },
  );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    code: 'OFFLINE_DRY_RUN',
    providerRequests: 0,
    remoteOperations: 0,
    plan: {
      restoreTransport: 'QUERY_BATCH',
      fileImports: 0,
      queryBatches: 4,
      publication: 'SEALED',
    },
  });
  expect(existsSync(op.runDirectory)).toBe(false);
});
it('executes the actual provider adapter lifecycle against an isolated fake provider process', async () => {
  const op = scenario();
  expect(await runProviderRecovery(op)).toMatchObject({
    code: 'SIMULATED_PROVIDER_VERIFIED_SEALED',
    remoteOperations: 0,
    sqlVerification: 'PASS',
    apiAuthorization: 'NOT_EXECUTED',
  });
  expect(state(op)).toMatchObject({ create: 1, ingest: 1, reconcile: 1, delete: 0 });
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe('PROVIDER_CLEANED');
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe('PROVIDER_CLEANED');
  expect(state(op)).toMatchObject({ delete: 1, resources: [] });
  writeFileSync(
    join(root, 'lifecycle-summary.json'),
    JSON.stringify(
      {
        scope: 'OFFLINE_PROCESS_SIMULATION',
        fakeRoot: root,
        actualCloudflareRequests: 0,
        create: state(op).create,
        orderedImport: state(op).ingest,
        reconcile: state(op).reconcile,
        delete: state(op).delete,
        publication: 'SEALED',
        apiAuthorization: 'NOT_EXECUTED',
      },
      null,
      2,
    ),
  );
}, 60000);
it.each([
  ['wrongAccount', 'ACCOUNT_IDENTITY_MISMATCH'],
  ['wrongJurisdiction', 'PROVIDER_VALIDATION_FAILED'],
  ['wrongUuid', 'TARGET_IDENTITY_MISMATCH'],
  ['collision', 'RESOURCE_NAME_COLLISION'],
  ['partialImport', 'SCHEMA_MISMATCH'],
  ['fingerprintMismatch', 'RESTORE_ROWS_MISMATCH'],
  ['reconcileFailure', 'IMPORT_PROVIDER_FAILED'],
])(
  'rejects %s without an automatic destructive retry',
  async (fault, expected) => {
    const op = scenario(fault);
    const result = await runProviderRecovery(op);
    expect(result.code).toBe(expected);
    expect(result.remoteOperations).toBe(0);
    expect(state(op).create).toBeLessThanOrEqual(1);
    expect(state(op).ingest).toBeLessThanOrEqual(1);
    expect(state(op).reconcile).toBeLessThanOrEqual(1);
    expect(state(op).delete).toBe(0);
  },
  60000,
);
it('never adopts a name-matched database after create response loss', async () => {
  const op = scenario('createLost');
  expect((await runProviderRecovery(op)).code).toBe('PROVIDER_RESPONSE_LOST');
  expect((await runProviderRecovery(op)).code).toBe('CREATE_OWNERSHIP_AMBIGUOUS');
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(
    'CREATE_OWNERSHIP_AMBIGUOUS',
  );
  expect(state(op)).toMatchObject({ create: 1, ingest: 0, delete: 0 });
});
it('leaves an ambiguous import sealed and does not re-ingest or delete it', async () => {
  const op = scenario('importUnknown');
  expect((await runProviderRecovery(op)).code).toBe('IMPORT_RESULT_UNKNOWN');
  expect((await runProviderRecovery(op)).code).toBe('IMPORT_RESULT_UNKNOWN');
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(
    'IMPORT_RESULT_UNKNOWN',
  );
  expect(state(op)).toMatchObject({ create: 1, ingest: 1, reconcile: 0, delete: 0 });
});
it.each(['importResponseLost', 'reconcileResponseLost', 'activeImport'])(
  'settles %s through provider status and exact readback, never a second ingest',
  async (fault) => {
    const op = scenario(fault);
    expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
    expect(state(op)).toMatchObject({ create: 1, ingest: 1, reconcile: 1 });
  },
  60000,
);
it.each(['deleteFailure', 'deleteResponseLost'])(
  'handles %s without retrying DELETE',
  async (fault) => {
    const op = scenario(fault);
    expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
    const expected = fault === 'deleteFailure' ? 'DELETE_RESULT_UNKNOWN' : 'PROVIDER_CLEANED';
    expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(expected);
    expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(expected);
    expect(state(op).delete).toBe(1);
  },
  60000,
);
it.each(['created', 'ingested', 'reconciled', 'deleted'])(
  'resumes an interrupted %s checkpoint without replaying writes',
  async (checkpoint) => {
    const op = scenario();
    if (checkpoint === 'deleted')
      expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
    const action = checkpoint === 'deleted' ? 'cleanup' : 'restore';
    expect(
      (await runProviderRecovery({ ...op, action, simulateInterruption: checkpoint })).code,
    ).toBe('SIMULATED_PROCESS_INTERRUPTION');
    expect((await runProviderRecovery({ ...op, action })).code).toBe(
      checkpoint === 'deleted' ? 'PROVIDER_CLEANED' : 'SIMULATED_PROVIDER_VERIFIED_SEALED',
    );
    expect(state(op)).toMatchObject({
      create: 1,
      ingest: 1,
      reconcile: 1,
      delete: checkpoint === 'deleted' ? 1 : 0,
    });
  },
  60000,
);
it('requires an out-of-band live capability, not merely an authorization file', async () => {
  const op = scenario(),
    fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('NETWORK_FORBIDDEN'));
  try {
    const { approval: _approval, ...without } = op;
    expect((await runProviderRecovery(without)).code).toBe('OWNER_APPROVAL_REQUIRED');
    expect((await runProviderRecovery({ ...op, mode: 'EXECUTE_REMOTE' })).code).toBe(
      'LIVE_CONFIRMATION_REQUIRED',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(op.fakeDirectory, 'fake-state.json'))).toBe(false);
  } finally {
    fetch.mockRestore();
  }
});
it('does not turn a masked authorization 404 into successful absence proof', async () => {
  const op = scenario('maskedAuth404');
  expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(
    'OWNERSHIP_READBACK_FAILED',
  );
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(
    'OWNERSHIP_READBACK_FAILED',
  );
  expect(state(op).delete).toBe(1);
}, 60000);
it('detects business drift after a reconciled resume checkpoint', async () => {
  const op = scenario();
  expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
  const db = new DatabaseSync(join(op.fakeDirectory, 'target.sqlite'));
  db.exec(
    "UPDATE policies SET gross_premium_minor=gross_premium_minor+1,version=version+1 WHERE id='synthetic-policy-00'",
  );
  db.close();
  expect((await runProviderRecovery(op)).code).toBe('RESTORE_ROWS_MISMATCH');
  expect(state(op)).toMatchObject({ ingest: 1, reconcile: 1, delete: 0 });
}, 60000);
it('logs only bounded metadata and fingerprints, never SQL or signed upload URLs', async () => {
  const op = scenario();
  expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
  const db = new DatabaseSync(join(op.runDirectory, 'provider-journal.sqlite'), { readOnly: true });
  try {
    const persisted = JSON.stringify({
      events: db.prepare('SELECT * FROM events').all(),
      session: db.prepare('SELECT body FROM session').get(),
    });
    expect(persisted).not.toMatch(
      /upload_url|signature=|INSERT INTO|UPDATE agency_memberships|synthetic-verifier|Bearer /,
    );
  } finally {
    db.close();
  }
}, 60000);
it('runs the built provider CLI in default offline mode', () => {
  const result = spawnSync(process.execPath, ['scripts/recovery/provider-cli.mjs'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ code: 'OFFLINE_DRY_RUN', remoteOperations: 0 });
});
it('bounds endless provider polling across process restarts', async () => {
  const op = scenario('endlessPoll');
  expect((await runProviderRecovery(op)).code).toBe('IMPORT_RESULT_UNKNOWN');
  expect((await runProviderRecovery(op)).code).toBe('IMPORT_RESULT_UNKNOWN');
  const db = new DatabaseSync(join(op.runDirectory, 'provider-journal.sqlite'));
  try {
    const data = JSON.parse(String(db.prepare('SELECT body FROM session').get()!.body));
    expect(data.jobs.restore.polls).toBe(30);
  } finally {
    db.close();
  }
  expect(state(op)).toMatchObject({ ingest: 1, reconcile: 0, delete: 0 });
}, 60000);
it.each(['uploadResponseLost', 'uploadPartial', 'uploadBadEtag'])(
  'does not repeat %s and permits only explicit owned D1 cleanup',
  async (fault) => {
    const op = scenario(fault);
    expect((await runProviderRecovery(op)).code).toBe(
      fault === 'uploadBadEtag' ? 'UPLOAD_ETAG_MISMATCH' : 'PROVIDER_RESPONSE_LOST',
    );
    expect((await runProviderRecovery(op)).code).toBe('IMPORT_RESULT_UNKNOWN');
    expect(state(op)).toMatchObject({ ingest: 0, reconcile: 0, delete: 0 });
    expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe('PROVIDER_CLEANED');
    expect(state(op)).toMatchObject({ delete: 1 });
    expect(state(op).calls.filter((c) => (c as { kind: string }).kind === 'upload')).toHaveLength(
      1,
    );
  },
);
it('rechecks the pinned UUID before cleanup and never deletes a mismatched identity', async () => {
  const op = scenario();
  expect((await runProviderRecovery(op)).code).toBe('SIMULATED_PROVIDER_VERIFIED_SEALED');
  writeFileSync(join(op.fakeDirectory, 'fake-config.json'), JSON.stringify({ fault: 'wrongUuid' }));
  expect((await runProviderRecovery({ ...op, action: 'cleanup' })).code).toBe(
    'TARGET_IDENTITY_MISMATCH',
  );
  expect(state(op).delete).toBe(0);
}, 60000);
it('uses durable journal readback when resumed through the separately built CLI process', async () => {
  const op = scenario();
  expect((await runProviderRecovery({ ...op, simulateInterruption: 'ingested' })).code).toBe(
    'SIMULATED_PROCESS_INTERRUPTION',
  );
  const path = join(root, 'provider-resume-options.json');
  writeFileSync(path, JSON.stringify(op));
  const child = spawnSync(
    process.execPath,
    ['scripts/recovery/provider-cli.mjs', '--options', path],
    { encoding: 'utf8', timeout: 60000 },
  );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    code: 'SIMULATED_PROVIDER_VERIFIED_SEALED',
    remoteOperations: 0,
  });
  expect(state(op)).toMatchObject({ create: 1, ingest: 1, reconcile: 1 });
}, 60000);
