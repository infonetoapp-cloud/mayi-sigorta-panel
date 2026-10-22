// @vitest-environment node
import { beforeAll, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import miniflare from 'miniflare';
import { queryRestorePlan } from '../scripts/recovery/query-restore-plan';
import { runQueryRecovery } from '../scripts/recovery/query-phase-executor';
import {
  retainSyntheticBundle,
  readRecoveryBundle,
  readCurrentAuthority,
  verifyRecoverySnapshot,
  verifyCurrentAuthority,
  type RecoveryBundle,
  type CurrentAuthority,
} from '../scripts/recovery/executor-bundle';
import { currentAuthorityImportSql } from '../scripts/recovery/provider-runner';
let bundle: RecoveryBundle, authority: CurrentAuthority;
beforeAll(async () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'mayi-query-native-bundle-')), 'bundle');
  const pins = await retainSyntheticBundle(directory);
  const options = {
    bundleDirectory: directory,
    manifestSha256: pins.manifestSha256,
    authorityPath: join(directory, 'current-authority.json'),
    authoritySha256: pins.authoritySha256,
  };
  bundle = readRecoveryBundle(options.bundleDirectory, options.manifestSha256);
  authority = readCurrentAuthority(options.authorityPath, options.authoritySha256, bundle);
}, 180000);
it('runs complete statements in native D1 batch phases without import or a SQL splitter on trigger bodies', async () => {
  const plan = queryRestorePlan(bundle.derived, currentAuthorityImportSql(authority));
  const runtime = new miniflare.Miniflare(
    miniflare.convertV4MiniflareOptions({
      modules: true,
      script: 'export default {}',
      cf: false,
      d1Databases: { DB: '00000000-0000-4000-8000-000000000903' },
    }),
  );
  try {
    const db = await runtime.getD1Database('DB');
    for (const phase of plan.slice(0, 3))
      await db.batch(phase.batch.map(({ sql }) => db.prepare(sql)));
    expect(
      await verifyRecoverySnapshot(async (sql) => (await db.prepare(sql).all()).results, bundle),
    ).toMatchObject({ tables: 46, rows: 114, migrations: 23 });
    await db.batch(plan[3]!.batch.map(({ sql }) => db.prepare(sql)));
    expect(
      await verifyCurrentAuthority(
        async (sql) => (await db.prepare(sql).all()).results,
        authority,
        bundle,
      ),
    ).toMatchObject({ publication: 'SEALED' });
    expect(plan.map((p) => p.name)).toEqual(['schema', 'data', 'guards', 'authority']);
  } finally {
    await runtime.dispose();
  }
}, 120000);
it('resumes an ambiguous authority response on real LOCAL D1 using the exact deterministic checkpoint', async () => {
  const runtime = new miniflare.Miniflare(
    miniflare.convertV4MiniflareOptions({
      modules: true,
      script: 'export default {}',
      cf: false,
      d1Databases: { DB: '00000000-0000-4000-8000-000000000904' },
    }),
  );
  try {
    const db = await runtime.getD1Database('DB');
    const attempts: string[] = [];
    const input = {
      directory: mkdtempSync(join(tmpdir(), 'mayi-native-query-journal-')),
      targetBinding: 'synthetic-local-d1-only',
      derived: bundle.derived,
      authoritySql: currentAuthorityImportSql(authority),
      query: async (sql: string) => (await db.prepare(sql).all()).results,
      write: async (name: string, batch: readonly { sql: string }[]) => {
        attempts.push(name);
        await db.batch(batch.map((row) => db.prepare(row.sql)));
        if (name === 'authority') throw Error('SYNTHETIC_RESPONSE_LOST');
      },
    };
    await expect(runQueryRecovery(input)).rejects.toThrow('QUERY_PHASE_RESULT_UNKNOWN');
    expect(await runQueryRecovery(input)).toMatchObject({
      publication: 'SEALED',
      phasesConfirmed: 4,
    });
    expect(attempts).toEqual(['schema', 'data', 'guards', 'authority']);
    expect(await verifyCurrentAuthority(input.query, authority, bundle)).toMatchObject({
      publication: 'SEALED',
    });
  } finally {
    await runtime.dispose();
  }
}, 120000);
