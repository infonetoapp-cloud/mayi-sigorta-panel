// @vitest-environment node
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
  preparePhasedD1Restore,
  createLocalPhaseSession,
  withPhasedRestoreFiles,
} from '../scripts/recovery/phased-d1-restore';
import { inspectForeignKeyGraph, describeOrderedImport } from '../scripts/recovery/schema-graph';
import { nativeExportSha256 } from '../scripts/recovery/prepare-native-restore';
import { canonicalizePayload } from '../src/server/mutations/canonical';
import { receiptFor } from './support/native-source-receipt';
const ID = '00000000-0000-4000-8000-000000000987';
const schemaSql =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB '_cf_*' AND name<>'sqlite_sequence' ORDER BY type,name";
function target() {
  const dir = mkdtempSync(join(tmpdir(), 'mayi-compat-local-'));
  writeFileSync(
    join(dir, 'local.json'),
    JSON.stringify({
      name: 'synthetic-compatibility-only',
      compatibility_date: '2026-09-01',
      d1_databases: [
        { binding: 'DB', database_name: 'synthetic-disposable-recovery', database_id: ID },
      ],
    }),
  );
  return dir;
}
function command(dir: string, path: string) {
  return spawnSync(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'execute',
      'DB',
      '--local',
      '--config',
      join(dir, 'local.json'),
      '--persist-to',
      join(dir, 'state'),
      '--file',
      path,
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
async function open(dir: string) {
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {}',
      cf: false,
      d1Databases: { DB: ID },
      resourcePersistencePath: join(dir, 'state', 'v3'),
    }),
  );
  try {
    return { db: await mf.getD1Database('DB'), dispose: () => mf.dispose() };
  } catch (e) {
    await mf.dispose();
    throw e;
  }
}

it('proves A/B/C LOCAL current-schema synthetic auth transports and captures safe graph/structure', async () => {
  const source = await createSyntheticAuthBackup();
  const dirs = [target(), target(), target(), target()];
  let runtime: Awaited<ReturnType<typeof open>> | undefined;
  const summary: Record<string, unknown> = {
    scope: 'LOCAL/SYNTHETIC ONLY; no private995313 SQL retrieved',
    remoteCalls: 0,
    D1_RESET_DO_Reproduced: false,
  };
  try {
    const native = source.nativeExportSql;
    const pkg = preparePhasedD1Restore(Buffer.from(native), receiptFor(native));
    expect(pkg.phases.map((p) => p.sha256)).toEqual(
      preparePhasedD1Restore(Buffer.from(native), receiptFor(native)).phases.map((p) => p.sha256),
    );
    const migrationFiles = readdirSync('db/migrations')
      .filter((f) => /^\d{4}_.+\.sql$/u.test(f))
      .sort();
    const reference = new DatabaseSync(':memory:');
    for (const file of migrationFiles)
      reference.exec(readFileSync(resolve('db/migrations', file), 'utf8'));
    summary.canonicalGraph = inspectForeignKeyGraph(reference);
    reference.close();
    const decoded = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: false,
      allowExtension: false,
    });
    try {
      decoded.exec(pkg.singleDerivedSql);
      summary.materializedSyntheticGraph = inspectForeignKeyGraph(decoded, true);
    } finally {
      decoded.close();
    }
    summary.singleImportStructure = describeOrderedImport(pkg.singleDerivedSql);
    summary.sourceSyntheticSHA256 = pkg.sourceExportSha256;
    summary.singleSyntheticDerivedSHA256 = pkg.singleDerivedSha256;
    summary.phaseHashes = pkg.phases.map((p) => ({
      ordinal: p.ordinal,
      sha256: p.sha256,
      bytes: p.bytes,
    }));
    const validateDataOnly = async (db: D1Database) => {
      const tables = (await source.db.prepare(schemaSql).all()).results.filter(
        (r) => r.type === 'table',
      );
      for (const table of tables) {
        const a = (await source.db.prepare(`SELECT * FROM "${table.name}"`).all()).results;
        const b = (await db.prepare(`SELECT * FROM "${table.name}"`).all()).results;
        const hash = (rows: unknown[]) =>
          nativeExportSha256(
            Buffer.from(JSON.stringify(rows.map((r) => canonicalizePayload(r)).sort())),
          );
        expect(a.length === b.length && hash(a) === hash(b)).toBe(true);
      }
    };
    const validate = async (db: D1Database) => {
      const schema = (await db.prepare(schemaSql).all()).results as Parameters<
        typeof authSchemaHash
      >[0];
      const schemaExact = authSchemaHash(schema) === AUTH_RESTORE_SCHEMA_HASH;
      const history = (await db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all())
        .results;
      const expectedHistory = (
        await source.db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all()
      ).results;
      expect(history.map((migration) => migration.name)).toEqual(migrationFiles);
      expect(history).toEqual(expectedHistory);
      let rowsExact = true;
      for (const table of schema.filter((r) => r.type === 'table')) {
        const a = (await source.db.prepare(`SELECT * FROM "${table.name}"`).all()).results;
        const b = (await db.prepare(`SELECT * FROM "${table.name}"`).all()).results;
        const hash = (rows: unknown[]) =>
          nativeExportSha256(
            Buffer.from(JSON.stringify(rows.map((r) => canonicalizePayload(r)).sort())),
          );
        rowsExact &&= hash(a) === hash(b) && a.length === b.length;
      }
      const fk = (await db.prepare('PRAGMA foreign_key_check').all()).results.length;
      const relation = await db
        .prepare(
          "SELECT count(*) AS n FROM local_credentials c LEFT JOIN auth_identities i ON i.id=c.identity_id AND i.user_id=c.user_id LEFT JOIN agency_memberships m ON m.user_id=c.user_id WHERE i.id IS NULL OR m.id IS NULL OR i.issuer<>'urn:mayisigorta:local-auth:v1' OR i.email_provenance<>'OWNER_PROVISIONED' OR c.login_email<>i.verified_email",
        )
        .first<{ n: number }>();
      const sessions = await db
        .prepare(
          "SELECT count(*) AS n FROM local_sessions s WHERE NOT EXISTS(SELECT 1 FROM local_credentials c JOIN auth_identities i ON i.id=c.identity_id JOIN agency_memberships m ON m.id=s.membership_id JOIN users u ON u.id=c.user_id JOIN agencies a ON a.id=m.agency_id WHERE c.user_id=s.user_id AND i.user_id=s.user_id AND c.identity_id=s.identity_id AND m.user_id=s.user_id AND (s.revoked_at IS NOT NULL OR (s.credential_version=c.credential_version AND s.permission_version=m.permission_version AND c.login_enabled=1 AND i.status='ACTIVE' AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE')))",
        )
        .first<{ n: number }>();
      const counts = Object.fromEntries(
        ['table', 'index', 'trigger', 'view'].map((kind) => [
          kind,
          schema.filter((r) => r.tbl_name !== 'd1_migrations' && r.type === kind).length,
        ]),
      );
      expect(counts).toEqual({ table: 63, index: 243, trigger: 244, view: 3 });
      expect(schemaExact, 'schema fingerprint').toBe(true);
      expect(rowsExact, 'restored table contents').toBe(true);
      expect(relation!.n, 'authentication relationships').toBe(0);
      expect(sessions!.n, 'session relationships').toBe(0);
      expect(fk, 'foreign key violations').toBe(0);
      return {
        foreignKeyViolations: fk,
        schemaExact,
        rowsExact,
        domainExact: relation!.n === 0 && sessions!.n === 0,
      };
    };
    // Strategy A control: one unchanged canonical local import.
    const a = join(dirs[0]!, 'A.sql');
    writeFileSync(a, pkg.singleDerivedSql);
    const ra = command(dirs[0]!, a);
    expect(ra.status === 0 && !ra.error).toBe(true);
    runtime = await open(dirs[0]!);
    await validate(runtime.db);
    await runtime.dispose();
    runtime = undefined;
    summary.strategyA = 'PASS_NATIVE_LOCAL';
    // Strategy B: three separately committed local files, one target-bound session.
    const binding = {
      mode: 'LOCAL_ONLY',
      purpose: 'DISPOSABLE_RECOVERY',
      accountId: 'synthetic-account',
      name: 'synthetic-disposable-recovery',
      uuid: ID,
    };
    const session = createLocalPhaseSession(pkg, binding, pkg.sourceExportSha256);
    await withPhasedRestoreFiles(pkg, async (paths) => {
      for (const phase of pkg.phases) {
        const path = paths[phase.ordinal - 1]!;
        expect(nativeExportSha256(readFileSync(path)) === phase.sha256).toBe(true);
        await session.runPhase(
          phase.ordinal,
          binding,
          phase.sha256,
          pkg.sourceExportSha256,
          async () => {
            const r = command(dirs[1]!, path);
            expect(r.status === 0 && !r.error).toBe(true);
          },
          async () => {
            const readback = await open(dirs[1]!);
            try {
              const foreignKeyViolations = (
                await readback.db.prepare('PRAGMA foreign_key_check').all()
              ).results.length;
              const actual = (await readback.db.prepare(schemaSql).all()).results as Parameters<
                typeof authSchemaHash
              >[0];
              const expected = (await source.db.prepare(schemaSql).all()).results as Parameters<
                typeof authSchemaHash
              >[0];
              const selected =
                phase.ordinal === 3
                  ? expected
                  : expected.filter((r) => r.type === 'table' || r.type === 'index');
              const phaseStateExact = authSchemaHash(actual) === authSchemaHash(selected);
              if (phase.ordinal === 2) await validateDataOnly(readback.db);
              return { foreignKeyViolations, phaseStateExact };
            } finally {
              await readback.dispose();
            }
          },
        );
      }
      runtime = await open(dirs[1]!);
      await session.validate(binding, async () => validate(runtime!.db));
      await runtime.dispose();
      runtime = undefined;
    });
    expect(session.status()).toBe('VERIFIED_SEALED');
    summary.strategyB = 'PASS_NATIVE_LOCAL_3_TRANSACTIONS';
    // Strategy C EXPERIMENT ONLY. Never a preparation default or remote option.
    const experiment = pkg.singleDerivedSql.replace(
      /^PRAGMA defer_foreign_keys=ON;/u,
      'PRAGMA foreign_keys=OFF;',
    );
    expect(experiment !== pkg.singleDerivedSql).toBe(true);
    const c = join(dirs[2]!, 'C-experimental.sql');
    writeFileSync(c, experiment);
    const rc = command(dirs[2]!, c);
    expect(!rc.error && rc.status !== null).toBe(true);
    runtime = await open(dirs[2]!);
    if (rc.status === 0) await validate(runtime.db);
    else
      expect(/FOREIGN KEY|not authorized|not supported/iu.test(rc.stdout + rc.stderr)).toBe(true);
    const fkSetting = await runtime.db
      .prepare('PRAGMA foreign_keys')
      .first<{ foreign_keys: number }>();
    await runtime.dispose();
    runtime = undefined;
    summary.strategyC = {
      positiveNativeLocal: rc.status === 0 ? 'PASS_AFTER_FULL_VALIDATION' : 'REJECTED_LOCAL_IMPORT',
      foreignKeysSettingAfterImport: fkSetting!.foreign_keys,
      remoteSupported: false,
    };
    // Does local D1 actually disable enforcement? Negative control must reject.
    const bad = join(dirs[3]!, 'C-negative.sql');
    writeFileSync(
      bad,
      'PRAGMA foreign_keys=OFF;CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id));INSERT INTO child VALUES(1,999);',
    );
    const badResult = command(dirs[3]!, bad);
    expect(!badResult.error && badResult.status !== null).toBe(true);
    if (badResult.status === 0) {
      runtime = await open(dirs[3]!);
      const violations = (await runtime.db.prepare('PRAGMA foreign_key_check').all()).results
        .length;
      expect(violations).toBe(1);
      await runtime.dispose();
      runtime = undefined;
      summary.CInvalidFKRejectedByNativeImport = false;
      summary.CFinalValidationRejects = true;
      summary.COffEffectiveDuringNativeImport = true;
    } else {
      expect(
        /FOREIGN KEY|not authorized|not supported/iu.test(badResult.stdout + badResult.stderr),
      ).toBe(true);
      summary.CInvalidFKRejectedByNativeImport = true;
      summary.COffEffectiveDuringNativeImport = false;
    }
    // SQLite without an enclosing implicit transaction DOES honor OFF. Final check catches corruption.
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(
        'PRAGMA foreign_keys=OFF;CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id));INSERT INTO child VALUES(1,999);',
      );
      expect(sqlite.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(0);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all().length).toBe(1);
      summary.CSQLiteOnlyHonorsOff = true;
    } finally {
      sqlite.close();
    }
    summary.sourceUnchanged = pkg.sourceExportSha256 === nativeExportSha256(Buffer.from(native));
    summary.currentSchemaHash = AUTH_RESTORE_SCHEMA_HASH;
    summary.restoredMigrations = migrationFiles.length;
    summary.everyAcceptedStrategyFKSchemaRowsDomainValidation = true;
    summary.productionRecoveryStatus = 'OPEN';
    writeFileSync(
      join(tmpdir(), 'mayi-recovery-compatibility-safe-summary.json'),
      JSON.stringify(summary, null, 2),
    );
  } finally {
    await runtime?.dispose();
    await source.dispose();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}, 300000);
