// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runRecovery, RECOVERY_TARGET_NAME } from '../scripts/recovery/executor';
import {
  retainSyntheticBundle,
  readRecoveryBundle,
  sha256,
  canonical,
  verifyRecoverySnapshot,
  readCurrentAuthority,
  verifyCurrentAuthority,
} from '../scripts/recovery/executor-bundle';

const root = mkdtempSync(join(tmpdir(), 'mayi-ops001-executor-'));
let pins: Awaited<ReturnType<typeof retainSyntheticBundle>>;
const target = {
  accountId: 'af9fc98cb8d5f5508d58057bc794d863',
  name: RECOVERY_TARGET_NAME,
  uuid: '12345678-1234-4234-8234-123456789012',
  jurisdiction: 'eu' as const,
  createdAt: new Date().toISOString(),
};
let serial = 0;
const options = () => ({
  mode: 'SIMULATE_LOCAL',
  bundleDirectory: join(root, 'bundle'),
  manifestSha256: pins.manifestSha256,
  authorityPath: join(root, 'bundle', 'current-authority.json'),
  authoritySha256: pins.authoritySha256,
  runDirectory: join(root, `run-${++serial}`),
  target,
});
beforeAll(async () => {
  pins = await retainSyntheticBundle(join(root, 'bundle'));
  writeFileSync(
    join(root, 'bundle-hashes.json'),
    JSON.stringify(
      { scope: 'RETAINED_LOCAL_SYNTHETIC_SECRET_LIKE', directory: join(root, 'bundle'), ...pins },
      null,
      2,
    ),
  );
}, 180000);
afterAll(() => {
  // Retain raw synthetic SQL privately for the next operator gate. Never print rows/tokens.
  writeFileSync(
    join(root, 'retained-location.json'),
    JSON.stringify({ directory: root, remoteOperations: 0 }, null, 2),
  );
});

it('defaults to a dry-run with zero remote capabilities', async () => {
  expect(await runRecovery()).toMatchObject({
    code: 'OFFLINE_DRY_RUN',
    remoteOperations: 0,
    publication: 'SEALED',
    apiAuthorization: 'NOT_EXECUTED',
  });
});
it('performs real local SQLite import, exact verification and current-authority reconciliation', async () => {
  const op = options();
  const result = await runRecovery(op);
  expect(result).toMatchObject({
    code: 'LOCAL_SIMULATION_VERIFIED_SEALED',
    state: 'RECONCILED',
    importAttempts: 1,
    deleteAttempts: 0,
    remoteOperations: 0,
    apiAuthorization: 'NOT_EXECUTED',
  });
  const resumed = await runRecovery(op);
  expect(resumed.code).toBe('LOCAL_SIMULATION_VERIFIED_SEALED');
  expect(resumed.importAttempts).toBe(1);
  expect(await runRecovery({ ...op, action: 'cleanup' })).toMatchObject({
    code: 'LOCAL_SIMULATION_CLEANED',
    deleteAttempts: 1,
  });
  expect(await runRecovery({ ...op, action: 'cleanup' })).toMatchObject({
    code: 'LOCAL_SIMULATION_CLEANED',
    deleteAttempts: 1,
  });
});
it('validates a bundle in memory without creating a run or database', async () => {
  expect(await runRecovery({ ...options(), mode: 'OFFLINE_DRY_RUN' })).toMatchObject({
    code: 'OFFLINE_DRY_RUN',
    sqlVerification: { tables: 46, rows: 114, migrations: 23 },
  });
});
it.each([
  ['missing manifest', () => ({ bundleDirectory: join(root, 'missing') })],
  ['wrong manifest hash', () => ({ manifestSha256: '0'.repeat(64) })],
  ['wrong account', () => ({ target: { ...target, accountId: '0'.repeat(32) } })],
  [
    'production UUID',
    () => ({ target: { ...target, uuid: '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d' } }),
  ],
  ['wrong jurisdiction', () => ({ target: { ...target, jurisdiction: 'us' } })],
  ['production config injection', () => ({ config: 'wrangler.jsonc', env: 'production' })],
  ['wrong authority hash', () => ({ authoritySha256: '0'.repeat(64) })],
] as const)('fails closed on %s', async (_name, change) => {
  const result = await runRecovery({ ...options(), ...change() });
  expect(result.code).not.toMatch(/VERIFIED|CLEANED|OFFLINE_DRY_RUN/);
  expect(result.remoteOperations).toBe(0);
  expect(result.importAttempts).toBeUndefined();
});
it.each([
  ['importTimeout', 'IMPORT_RESULT_UNKNOWN'],
  ['partialImport', 'SCHEMA_MISMATCH'],
  ['corruptMoney', 'RESTORE_ROWS_MISMATCH'],
  ['reconcileFailure', 'REVOCATION_RECONCILIATION_FAILED'],
  ['wrongIdentity', 'TARGET_IDENTITY_MISMATCH'],
] as const)(
  'preserves failure evidence for %s without destructive retries',
  async (fault, code) => {
    const op = options();
    const result = await runRecovery({ ...op, simulationFault: fault });
    expect(result.code).toBe(code);
    expect(result.publication).toBe('SEALED');
    expect(result.remoteOperations).toBe(0);
    const db = new DatabaseSync(join(op.runDirectory, 'journal.sqlite'));
    try {
      expect(
        db.prepare("SELECT count(*) AS n FROM events WHERE outcome IN ('FAILED','UNKNOWN')").get()!
          .n,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    if (fault === 'importTimeout' || fault === 'reconcileFailure') {
      const resumed = await runRecovery(op);
      expect(resumed.code).not.toBe('LOCAL_SIMULATION_VERIFIED_SEALED');
      expect(resumed.importAttempts).toBe(1);
      expect(resumed.deleteAttempts).toBe(0);
    }
  },
);
it.each(['afterImportEffect', 'afterReconcileEffect'] as const)(
  'resumes %s by readback, never by replaying uncertain effects',
  async (fault) => {
    const op = options();
    expect((await runRecovery({ ...op, simulationFault: fault })).code).toBe(
      'SIMULATED_INTERRUPTION',
    );
    expect(await runRecovery(op)).toMatchObject({
      code: 'LOCAL_SIMULATION_VERIFIED_SEALED',
      importAttempts: 1,
      deleteAttempts: 0,
    });
  },
);
it('does not retry an ambiguous deletion even when invoked again', async () => {
  const op = options();
  await runRecovery(op);
  expect(
    await runRecovery({ ...op, action: 'cleanup', simulationFault: 'deleteUnknown' }),
  ).toMatchObject({ code: 'DELETE_RESULT_UNKNOWN', deleteAttempts: 1 });
  expect(await runRecovery({ ...op, action: 'cleanup' })).toMatchObject({
    code: 'DELETE_RESULT_UNKNOWN',
    deleteAttempts: 1,
  });
});
it('reconciles an interrupted deletion through absence readback only', async () => {
  const op = options();
  await runRecovery(op);
  expect(
    (await runRecovery({ ...op, action: 'cleanup', simulationFault: 'afterDeleteEffect' })).code,
  ).toBe('SIMULATED_INTERRUPTION');
  expect(await runRecovery({ ...op, action: 'cleanup' })).toMatchObject({
    code: 'LOCAL_SIMULATION_CLEANED',
    deleteAttempts: 1,
  });
});
it('rejects wrong owned UUID and refuses cleanup before any import', async () => {
  const op = options();
  expect((await runRecovery({ ...op, action: 'cleanup' })).code).toBe('CLEANUP_NOT_AUTHORIZED');
  expect(
    (
      await runRecovery({
        ...op,
        target: { ...target, uuid: '22345678-1234-4234-8234-123456789012' },
      })
    ).code,
  ).toBe('RUN_BINDING_MISMATCH');
  writeFileSync(
    join(op.runDirectory, 'owned-identity.json'),
    canonical({ ...target, uuid: '22345678-1234-4234-8234-123456789012' }),
  );
  expect((await runRecovery({ ...op, action: 'cleanup' })).code).toBe('TARGET_IDENTITY_MISMATCH');
});
it('detects a changed revocation ledger and pins it independently of the old SQL', async () => {
  const op = options();
  const text = JSON.parse(readFileSync(op.authorityPath, 'utf8'));
  text.memberships[0].permission_version += 10;
  const path = join(root, 'bad-ledger.json');
  writeFileSync(path, canonical(text));
  expect(
    (await runRecovery({ ...op, authorityPath: path, authoritySha256: sha256(canonical(text)) }))
      .code,
  ).toBe('AUTHORITY_VERSION_INVALID');
});
it('keeps manifest hashing deterministic for the exact retained bytes', () => {
  const dir = join(root, 'bundle'),
    bundle = readRecoveryBundle(dir, pins.manifestSha256);
  expect(sha256(readFileSync(join(dir, 'native.sql')))).toBe(pins.sourceSha256);
  expect(sha256(readFileSync(join(dir, 'derived.sql')))).toBe(pins.derivedSha256);
  expect(pins.sourceSha256).not.toBe(pins.derivedSha256);
  expect(sha256(canonical(bundle.manifest))).toBe(pins.manifestSha256);
});
it('cannot enable remote IO even with a structurally bound future approval', async () => {
  const op = options(),
    now = Date.now();
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    const approval = {
      kind: 'OWNER_REMOTE_RECOVERY_APPROVAL_V1',
      owner: 'Synthetic operator',
      target,
      manifestSha256: pins.manifestSha256,
      authoritySha256: pins.authoritySha256,
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      allowImport: true,
      allowOwnedCleanup: true,
      allowProviderManagedStaging: true,
      allowProduction: false,
      allowDeploy: false,
    };
    expect(
      await runRecovery({ ...op, mode: 'EXECUTE_REMOTE', authorization: approval }),
    ).toMatchObject({ code: 'REMOTE_PROVIDER_CLI_REQUIRED', remoteOperations: 0 });
    expect(
      (
        await runRecovery({
          ...op,
          mode: 'EXECUTE_REMOTE',
          authorization: { ...approval, expiresAt: new Date(now - 500).toISOString() },
        })
      ).code,
    ).toBe('RECOVERY_VALIDATION_FAILED');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
it('refuses concurrent ownership and cannot recover a live process lock', async () => {
  const op = options();
  mkdirSync(op.runDirectory);
  writeFileSync(
    join(op.runDirectory, 'executor.lock'),
    JSON.stringify({ pid: process.pid, nonce: 'synthetic-lock' }),
  );
  expect((await runRecovery(op)).code).toBe('RUN_LOCKED');
  expect((await runRecovery({ ...op, recoverDeadLock: true })).code).toBe('LOCK_RECOVERY_DENIED');
});
it('enforces a persistent operation budget but reserves explicit cleanup capacity', async () => {
  const op = options();
  expect((await runRecovery(op)).code).toBe('LOCAL_SIMULATION_VERIFIED_SEALED');
  const db = new DatabaseSync(join(op.runDirectory, 'journal.sqlite'));
  db.exec('UPDATE control SET operations=300');
  db.close();
  expect((await runRecovery(op)).code).toBe('OPERATION_BUDGET_EXCEEDED');
  expect((await runRecovery({ ...op, action: 'cleanup' })).code).toBe('LOCAL_SIMULATION_CLEANED');
});
it('does not trust a stale CLEANED status when a target file reappears', async () => {
  const op = options();
  await runRecovery(op);
  await runRecovery({ ...op, action: 'cleanup' });
  writeFileSync(join(op.runDirectory, 'target.sqlite'), 'unexpected');
  expect((await runRecovery({ ...op, action: 'cleanup' })).code).toBe('DELETE_RESULT_UNKNOWN');
  expect(readFileSync(join(op.runDirectory, 'target.sqlite'), 'utf8')).toBe('unexpected');
});
it('rejects damaged bundle files and a malformed rehashed manifest', async () => {
  const op = options(),
    dir = join(root, 'damaged');
  cpSync(op.bundleDirectory, dir, { recursive: true });
  writeFileSync(join(dir, 'derived.sql'), 'DROP TABLE users;');
  expect((await runRecovery({ ...op, bundleDirectory: dir })).code).toBe(
    'BUNDLE_FILE_HASH_MISMATCH',
  );
  writeFileSync(join(dir, 'bundle-manifest.json'), '{"classification":"REAL"}');
  expect(
    (
      await runRecovery({
        ...op,
        bundleDirectory: dir,
        manifestSha256: sha256('{"classification":"REAL"}'),
      })
    ).code,
  ).toBe('RECOVERY_VALIDATION_FAILED');
});
it('rejects future backup watermarks and altered migration hashes before touching a target', async () => {
  for (const kind of ['future', 'migration']) {
    const op = options(),
      dir = join(root, kind);
    cpSync(op.bundleDirectory, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'bundle-manifest.json'), 'utf8'));
    if (kind === 'future') manifest.snapshotCompletedAt = '2099-01-01T00:00:00.000Z';
    else manifest.migrationSources[0].sourceSha256 = '0'.repeat(64);
    const text = canonical(manifest);
    writeFileSync(join(dir, 'bundle-manifest.json'), text);
    expect(
      (await runRecovery({ ...op, bundleDirectory: dir, manifestSha256: sha256(text) })).code,
    ).toBe(kind === 'future' ? 'SNAPSHOT_TIME_INVALID' : 'MIGRATION_HISTORY_MISMATCH');
    expect(existsSync(op.runDirectory)).toBe(false);
  }
});
it('exercises the built CLI default and option rejection without any remote capability', () => {
  const script = 'scripts/recovery/executor-cli.mjs';
  const dry = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
  expect(dry.status).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ code: 'OFFLINE_DRY_RUN', remoteOperations: 0 });
  const denied = spawnSync(process.execPath, [script, '--remote'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  expect(denied.status).toBe(1);
  expect(JSON.parse(denied.stderr.trim())).toMatchObject({
    code: 'OFFLINE_EXECUTOR_FAILED',
    remoteOperations: 0,
  });
});
it('resumes durable import intent from a separate CLI process without a second import', async () => {
  const op = options();
  expect((await runRecovery({ ...op, simulationFault: 'afterImportEffect' })).code).toBe(
    'SIMULATED_INTERRUPTION',
  );
  const path = join(root, 'resume-options.json');
  writeFileSync(path, JSON.stringify(op));
  const resumed = spawnSync(
    process.execPath,
    ['scripts/recovery/executor-cli.mjs', '--options', path],
    { encoding: 'utf8', timeout: 60000 },
  );
  expect(resumed.status).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({
    code: 'LOCAL_SIMULATION_VERIFIED_SEALED',
    importAttempts: 1,
    remoteOperations: 0,
    apiAuthorization: 'NOT_EXECUTED',
  });
});
it('requires explicit recovery of a proven dead local process lock', async () => {
  const op = options();
  mkdirSync(op.runDirectory);
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', timeout: 10000 });
  expect(child.status).toBe(0);
  writeFileSync(
    join(op.runDirectory, 'executor.lock'),
    JSON.stringify({ pid: child.pid, nonce: 'dead-child' }),
  );
  expect((await runRecovery(op)).code).toBe('RUN_LOCKED');
  expect((await runRecovery({ ...op, recoverDeadLock: true })).code).toBe(
    'LOCAL_SIMULATION_VERIFIED_SEALED',
  );
});
it('preserves the original run deadline across restarts', async () => {
  const op = options();
  await runRecovery(op);
  const db = new DatabaseSync(join(op.runDirectory, 'journal.sqlite'));
  db.prepare('UPDATE control SET started_at=?').run(Date.now() - 16 * 60 * 1000);
  db.close();
  expect((await runRecovery(op)).code).toBe('OPERATION_BUDGET_EXCEEDED');
  expect((await runRecovery({ ...op, action: 'cleanup' })).code).toBe('LOCAL_SIMULATION_CLEANED');
});
it('does not reuse a reconciled checkpoint after later business data corruption', async () => {
  const op = options();
  expect((await runRecovery(op)).code).toBe('LOCAL_SIMULATION_VERIFIED_SEALED');
  const db = new DatabaseSync(join(op.runDirectory, 'target.sqlite'));
  db.exec(
    "UPDATE policies SET gross_premium_minor=gross_premium_minor+1,version=version+1 WHERE id='synthetic-policy-00'",
  );
  db.close();
  expect((await runRecovery(op)).code).toBe('RESTORE_ROWS_MISMATCH');
});
it('verifies rollback on missing parent and idempotent reconciled SQL state locally', async () => {
  const op = options();
  await runRecovery(op);
  const db = new DatabaseSync(join(op.runDirectory, 'target.sqlite'));
  try {
    const before = db
      .prepare("SELECT gross_premium_minor FROM policies WHERE id='synthetic-policy-00'")
      .get();
    db.exec('BEGIN');
    try {
      db.exec(
        "UPDATE policies SET gross_premium_minor=gross_premium_minor+1,version=version+1 WHERE id='synthetic-policy-00'; INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('bad','synthetic-auth-agency','missing','synthetic-branch','BAD','Synthetic')",
      );
      throw Error('EXPECTED_REJECTION');
    } catch (error) {
      db.exec('ROLLBACK');
      expect(String(error)).toContain('CROSS_AGENCY_OR_MISSING_INSURER_PROHIBITED');
    }
    expect(
      db.prepare("SELECT gross_premium_minor FROM policies WHERE id='synthetic-policy-00'").get(),
    ).toEqual(before);
    const bundle = readRecoveryBundle(op.bundleDirectory, pins.manifestSha256),
      authority = readCurrentAuthority(op.authorityPath, pins.authoritySha256, bundle);
    expect(
      await verifyCurrentAuthority((sql) => db.prepare(sql).all(), authority, bundle),
    ).toMatchObject({ level: 'SQL_ONLY', apiAuthorization: 'NOT_EXECUTED' });
    await expect(verifyRecoverySnapshot((sql) => db.prepare(sql).all(), bundle)).rejects.toThrow(
      'RESTORE_ROWS_MISMATCH',
    );
  } finally {
    db.close();
  }
});
