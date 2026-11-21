// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import miniflare from 'miniflare';
import {
  createSyntheticAuthBackup,
  authSchemaHash,
  AUTH_RESTORE_SCHEMA_HASH,
} from '../scripts/recovery/local-auth-restore-proof';
import {
  prepareNativeD1Restore,
  withPreparedRestoreFile,
  nativeExportSha256,
} from '../scripts/recovery/prepare-native-restore';
import { receiptFor } from './support/native-source-receipt';
import { canonicalizePayload } from '../src/server/mutations/canonical';

const schemaSql =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name";
function command(dir: string, file: string) {
  return spawnSync(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'execute',
      'DB',
      '--local',
      '--file',
      file,
      '--config',
      join(dir, 'local.json'),
      '--persist-to',
      join(dir, 'state'),
      '--yes',
    ],
    {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !k.startsWith('CLOUDFLARE_')),
        ),
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
        WRANGLER_LOG_PATH: join(dir, 'logs'),
      },
    },
  );
}
function target() {
  const dir = mkdtempSync(join(tmpdir(), 'mayi-ordered-native-'));
  writeFileSync(
    join(dir, 'local.json'),
    JSON.stringify({
      name: 'synthetic-ordered-local',
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'disposable-local',
          database_id: '00000000-0000-4000-8000-000000000987',
        },
      ],
    }),
  );
  return dir;
}
async function open(dir: string) {
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {}',
      cf: false,
      d1Databases: { DB: '00000000-0000-4000-8000-000000000987' },
      resourcePersistencePath: join(dir, 'state', 'v3'),
    }),
  );
  try {
    return { db: await mf.getD1Database('DB'), dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

it('native LOCAL raw missing-parent RED then same-source ordered full populated auth GREEN twice', async () => {
  const source = await createSyntheticAuthBackup();
  const raw = target(),
    green = target(),
    repeat = target();
  let runtime: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const native = source.nativeExportSql;
    const sourceHash = nativeExportSha256(Buffer.from(native));
    const membershipInsert = native.search(/INSERT INTO ["`]?agency_memberships["`]?/u);
    const usersCreate = native.search(/CREATE TABLE (?:IF NOT EXISTS )?["`]?users["`]?/u);
    expect(membershipInsert >= 0 && membershipInsert < usersCreate).toBe(true);
    const input = join(raw, 'immutable-native.sql');
    writeFileSync(input, native, { flag: 'wx' });
    const red = command(raw, input);
    expect(red.status !== 0 && !red.error).toBe(true);
    expect(
      /no such table[^\n]*users|referenced table[^\n]*users/iu.test(red.stdout + red.stderr),
    ).toBe(true);
    // LOCAL CLI import failure atomicity is observed, not assumed to equal remote.
    runtime = await open(raw);
    const failedTables = (await runtime.db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
      )
      .first<{ n: number }>())!.n;
    await runtime.dispose();
    runtime = undefined;
    const prepared = prepareNativeD1Restore(Buffer.from(native), receiptFor(native));
    expect(prepared.sourceExportSha256 === sourceHash).toBe(true);
    expect(
      prepared.derivedRestoreSha256 ===
        prepareNativeD1Restore(Buffer.from(native), receiptFor(native)).derivedRestoreSha256,
    ).toBe(true);
    let transport = '';
    await withPreparedRestoreFile(prepared, async (path) => {
      transport = path;
      for (const dir of [green, repeat]) {
        const result = command(dir, path);
        expect(result.status === 0 && !result.error).toBe(true);
        runtime = await open(dir);
        const db = runtime.db;
        const schema = (await db.prepare(schemaSql).all()).results as Parameters<
          typeof authSchemaHash
        >[0];
        expect(authSchemaHash(schema) === AUTH_RESTORE_SCHEMA_HASH).toBe(true);
        const inventory = schema.filter((r) => r.tbl_name !== 'd1_migrations');
        const counts = Object.fromEntries(
          ['table', 'index', 'trigger', 'view'].map((kind) => [
            kind,
            inventory.filter((r) => r.type === kind).length,
          ]),
        );
        expect(counts).toEqual({ table: 63, index: 243, trigger: 244, view: 3 });
        const history = (await db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all())
          .results;
        const reference = (
          await source.db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all()
        ).results;
        expect(
          history.length === 41 && canonicalizePayload(history) === canonicalizePayload(reference),
        ).toBe(true);
        expect((await db.prepare('PRAGMA foreign_key_check').all()).results.length).toBe(0);
        const rowCounts: Record<string, number> = {};
        for (const table of schema.filter((r) => r.type === 'table')) {
          const a = (await source.db.prepare(`SELECT * FROM "${table.name}"`).all()).results;
          const b = (await db.prepare(`SELECT * FROM "${table.name}"`).all()).results;
          const fingerprint = (rows: unknown[]) =>
            nativeExportSha256(
              Buffer.from(JSON.stringify(rows.map((row) => canonicalizePayload(row)).sort())),
            );
          expect(fingerprint(a) === fingerprint(b)).toBe(true);
          expect(a.length === b.length).toBe(true);
          rowCounts[table.name] = b.length;
        }
        for (const name of [
          'agencies',
          'users',
          'auth_identities',
          'agency_memberships',
          'local_credentials',
          'local_sessions',
          'system_audit_events',
        ])
          expect(rowCounts[name]! > 0).toBe(true);
        const invalid = await db
          .prepare(
            'SELECT count(*) AS n FROM local_sessions s JOIN local_credentials c ON c.user_id=s.user_id JOIN auth_identities i ON i.id=s.identity_id JOIN agency_memberships m ON m.id=s.membership_id WHERE i.user_id<>s.user_id OR c.identity_id<>s.identity_id OR m.user_id<>s.user_id OR (s.revoked_at IS NULL AND (s.credential_version<>c.credential_version OR s.permission_version<>m.permission_version OR c.login_enabled<>1))',
          )
          .first<{ n: number }>();
        expect(invalid!.n).toBe(0);
        const sessionKinds = (
          await db
            .prepare(
              'SELECT kind,revoked_at IS NOT NULL AS revoked,count(*) AS n FROM local_sessions GROUP BY kind,revoked',
            )
            .all()
        ).results;
        expect(
          sessionKinds.some((s) => s.revoked === 1) && sessionKinds.some((s) => s.revoked === 0),
        ).toBe(true);
        await runtime.dispose();
        runtime = undefined;
        writeFileSync(
          join(tmpdir(), 'mayi-ordered-native-safe-proof.json'),
          JSON.stringify({
            scope: 'LOCAL/SYNTHETIC/SEALED',
            rawMissingParentFailure: true,
            rawFailureApplicationTables: failedTables,
            rawFailureTargetDiscarded: true,
            sourceUnchanged: sourceHash === nativeExportSha256(Buffer.from(native)),
            sourceHashDistinctFromDerived:
              prepared.sourceExportSha256 !== prepared.derivedRestoreSha256,
            counts,
            migrations: 28,
            schemaHashExact: true,
            fkViolations: 0,
            rowCounts,
            allRowFingerprintsExact: true,
            authGraphCoherent: true,
            repeatDeterministic: true,
            remoteExecuted: false,
            productionRtoProven: false,
          }),
        );
      }
    });
    expect(existsSync(transport)).toBe(false);
    expect(nativeExportSha256(readFileSync(input)) === sourceHash).toBe(true);
    // Actual operator CLI: no target/default/remote path, source unchanged.
    const receipt = join(raw, 'receipt.json');
    writeFileSync(receipt, JSON.stringify(receiptFor(native)));
    const cli = spawnSync(
      process.execPath,
      [
        resolve('scripts/recovery/prepare-native-restore-cli.mjs'),
        '--source',
        input,
        '--receipt',
        receipt,
        '--local-proof',
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    expect(cli.status === 0).toBe(true);
    const output = JSON.parse(cli.stdout);
    expect(output.remoteExecuted).toBe(false);
    expect(output.temporaryDerivedRemoved).toBe(true);
    const denied = spawnSync(
      process.execPath,
      [resolve('scripts/recovery/prepare-native-restore-cli.mjs'), '--remote'],
      { encoding: 'utf8' },
    );
    expect(denied.status !== 0).toBe(true);
  } finally {
    await runtime?.dispose();
    await source.dispose();
    for (const dir of [raw, green, repeat]) rmSync(dir, { recursive: true, force: true });
  }
}, 240000);
