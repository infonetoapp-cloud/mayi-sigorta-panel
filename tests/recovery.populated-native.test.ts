// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import miniflare from 'miniflare';
import {
  retainSyntheticBundle,
  readRecoveryBundle,
  readCurrentAuthority,
  verifyRecoverySnapshot,
  verifyCurrentAuthority,
} from '../scripts/recovery/executor-bundle';
import { currentAuthorityImportSql } from '../scripts/recovery/provider-runner';

it('restores the complete populated portfolio and current authority into real LOCAL D1', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-populated-native-'));
  const pins = await retainSyntheticBundle(join(directory, 'bundle'));
  const bundle = readRecoveryBundle(join(directory, 'bundle'), pins.manifestSha256);
  const authority = readCurrentAuthority(
    join(directory, 'bundle', 'current-authority.json'),
    pins.authoritySha256,
    bundle,
  );
  const config = join(directory, 'local.json');
  writeFileSync(
    config,
    JSON.stringify({
      name: 'ops001-populated-native-local',
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'synthetic-local-only',
          database_id: '00000000-0000-4000-8000-000000000987',
        },
      ],
    }),
  );
  const importFile = (body: string, name: string) => {
    const path = join(directory, name);
    writeFileSync(path, body, { flag: 'wx' });
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'd1',
        'execute',
        'DB',
        '--local',
        '--file',
        path,
        '--config',
        config,
        '--persist-to',
        join(directory, 'state'),
        '--yes',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('CLOUDFLARE_')),
          ),
          CI: 'true',
          WRANGLER_SEND_METRICS: 'false',
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
          WRANGLER_LOG_PATH: join(directory, 'logs'),
        },
      },
    );
    expect({ status: result.status, error: Boolean(result.error) }).toEqual({
      status: 0,
      error: false,
    });
  };
  const open = () =>
    new miniflare.Miniflare(
      miniflare.convertV4MiniflareOptions({
        modules: true,
        script: 'export default {}',
        cf: false,
        d1Databases: { DB: '00000000-0000-4000-8000-000000000987' },
        resourcePersistencePath: join(directory, 'state', 'v3'),
      }),
    );
  importFile(bundle.derived, 'restore.sql');
  let runtime = open();
  try {
    let db = await runtime.getD1Database('DB');
    const before = await verifyRecoverySnapshot(
      async (sql) => (await db.prepare(sql).all()).results,
      bundle,
    );
    expect(before).toMatchObject({
      tables: 46,
      rows: 114,
      migrations: 23,
      foreignKeyViolations: 0,
    });
    await runtime.dispose();
    importFile(currentAuthorityImportSql(authority), 'authority.sql');
    runtime = open();
    db = await runtime.getD1Database('DB');
    expect(
      await verifyCurrentAuthority(
        async (sql) => (await db.prepare(sql).all()).results,
        authority,
        bundle,
      ),
    ).toMatchObject({ publication: 'SEALED', apiAuthorization: 'NOT_EXECUTED' });
    writeFileSync(
      join(directory, 'native-proof.json'),
      JSON.stringify(
        {
          scope: 'REAL_LOCAL_D1_NOT_CLOUDFLARE_REMOTE',
          ...before,
          publication: 'SEALED',
          authorityReconciliation: 'PASS',
          sourceSha256: pins.sourceSha256,
          manifestSha256: pins.manifestSha256,
        },
        null,
        2,
      ),
    );
  } finally {
    await runtime.dispose();
  }
}, 240000);
