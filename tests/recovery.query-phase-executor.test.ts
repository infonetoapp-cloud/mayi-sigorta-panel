// @vitest-environment node
import { beforeAll, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueryRecovery } from '../scripts/recovery/query-phase-executor';
import {
  retainSyntheticBundle,
  readRecoveryBundle,
  readCurrentAuthority,
  verifyCurrentAuthority,
  type RecoveryBundle,
  type CurrentAuthority,
} from '../scripts/recovery/executor-bundle';
import { currentAuthorityImportSql } from '../scripts/recovery/provider-runner';
let bundle: RecoveryBundle, authority: CurrentAuthority;
beforeAll(async () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'mayi-query-phase-bundle-')), 'bundle');
  const pins = await retainSyntheticBundle(directory);
  bundle = readRecoveryBundle(directory, pins.manifestSha256);
  authority = readCurrentAuthority(
    join(directory, 'current-authority.json'),
    pins.authoritySha256,
    bundle,
  );
}, 180000);
function harness(failurePhase: string, beforeEffect = false) {
  const target = new DatabaseSync(':memory:');
  const attempts: string[] = [];
  let lose = true;
  const input = {
    directory: mkdtempSync(join(tmpdir(), 'mayi-query-resume-')),
    targetBinding: 'synthetic-owned-only',
    derived: bundle.derived,
    authoritySql: currentAuthorityImportSql(authority),
    query: async (sql: string) => target.prepare(sql).all(),
    write: async (name: string, batch: readonly { sql: string }[]) => {
      attempts.push(name);
      if (name === failurePhase && lose && beforeEffect) {
        lose = false;
        throw Error('SYNTHETIC_REQUEST_LOST');
      }
      target.exec('BEGIN;');
      try {
        for (const row of batch) target.exec(row.sql);
        target.exec('COMMIT;');
      } catch (error) {
        target.exec('ROLLBACK;');
        throw error;
      }
      if (name === failurePhase && lose) {
        lose = false;
        throw Error('SYNTHETIC_RESPONSE_LOST');
      }
    },
  };
  return { target, attempts, input };
}
it.each(['schema', 'data', 'guards', 'authority'])(
  'resumes a lost %s response by exact readback without executing any batch twice',
  async (phase) => {
    const { target, attempts, input } = harness(phase);
    try {
      await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
      expect(await runQueryRecovery(input)).toMatchObject({
        publication: 'SEALED',
        phasesConfirmed: 4,
      });
      expect(attempts).toEqual(['schema', 'data', 'guards', 'authority']);
      expect(await verifyCurrentAuthority(input.query, authority, bundle)).toMatchObject({
        publication: 'SEALED',
      });
      await runQueryRecovery(input);
      expect(attempts).toHaveLength(4);
    } finally {
      target.close();
    }
  },
);
it('never retries an ambiguous batch whose effect is absent', async () => {
  const { target, attempts, input } = harness('schema', true);
  try {
    await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
    await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
    expect(attempts).toEqual(['schema']);
    expect(target.prepare('SELECT count(*) AS n FROM sqlite_schema').get()!.n).toBe(0);
  } finally {
    target.close();
  }
});
it('does not advance a corrupted populated checkpoint after response loss', async () => {
  const { target, attempts, input } = harness('data');
  try {
    await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
    target.exec(
      "UPDATE policies SET gross_premium_minor=gross_premium_minor+1 WHERE id='synthetic-policy-00'",
    );
    await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
    expect(attempts).toEqual(['schema', 'data']);
  } finally {
    target.close();
  }
});
it('binds the journal to the exact target and phase payloads', async () => {
  const { target, attempts, input } = harness('data');
  try {
    await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
    await expect(runQueryRecovery({ ...input, targetBinding: 'another-target' })).rejects.toThrow(
      'QUERY_RUN_BINDING_MISMATCH',
    );
    expect(attempts).toEqual(['schema', 'data']);
  } finally {
    target.close();
  }
});
it('recovers only an explicitly requested dead-process lock and resumes by exact readback', async () => {
  const { target, attempts, input } = harness('data');
  try {
    await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
    const child = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    writeFileSync(
      join(input.directory, 'executor.lock'),
      JSON.stringify({ pid: child.pid, nonce: 'synthetic-crash' }),
    );
    await expect(runQueryRecovery(input)).rejects.toThrow('RUN_LOCKED');
    expect(await runQueryRecovery({ ...input, recoverDeadLock: true })).toMatchObject({
      phasesConfirmed: 4,
    });
    expect(attempts).toEqual(['schema', 'data', 'guards', 'authority']);
  } finally {
    target.close();
  }
});
it('does not break a live process lock even when recovery was requested', async () => {
  const { target, attempts, input } = harness('data');
  try {
    writeFileSync(
      join(input.directory, 'executor.lock'),
      JSON.stringify({ pid: process.pid, nonce: 'synthetic-live' }),
    );
    await expect(runQueryRecovery({ ...input, recoverDeadLock: true })).rejects.toThrow(
      'LOCK_RECOVERY_DENIED',
    );
    expect(attempts).toEqual([]);
  } finally {
    target.close();
  }
});
