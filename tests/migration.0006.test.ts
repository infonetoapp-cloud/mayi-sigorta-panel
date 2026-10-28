// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import miniflare from 'miniflare';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');
const wranglerCli = resolve(rootDir, 'node_modules/wrangler/bin/wrangler.js');

describe('M2-T03 Migration 0006 & Database Invariant Verification', () => {
  let mf: miniflare.Miniflare;

  const HISTORICAL_HASHES: Record<string, string> = {
    '0000_good_hammerhead.sql': 'de803e199abed34fa71fde797260d7545367b979f9d09cac886826e4e3f95a5d',
    '0001_chunky_blazing_skull.sql':
      'd79c8922324764f154315f9888d7bd0765f3475d7b39f02b363f60f59366b48b',
    '0002_productive_arclight.sql':
      '3eb6b49de885c929cb2eb5d289241bd34956827f7d9d2d354d428a934df57a5f',
    '0003_lonely_zzzax.sql': '1a5f075b522724aedf0c51d19aed090ca9727c53bd43ef64e4517b69ad1de8a3',
    '0004_thankful_pixie.sql': 'b79a46d884eab9484abbaaf2251bf374fb21359448b6fd8583ba2ab32bd181d3',
    '0005_graceful_northstar.sql':
      'f5c1717b78c0d7fe9f5b3576616283311709d35e29eb24a7d786b8b1cc7dfd51',
  };

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000006',
        },
      }),
    );
    await mf.getD1Database('DB');
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  // 1. Historical migrations 0000-0005 are strictly unchanged
  it('verifies historical 0000-0005 migrations are unchanged (exact SHA-256 hash preservation)', () => {
    for (const [filename, expectedHash] of Object.entries(HISTORICAL_HASHES)) {
      const filePath = resolve(rootDir, 'db/migrations', filename);
      const content = readFileSync(filePath);
      const actualHash = createHash('sha256').update(content).digest('hex');
      expect(actualHash).toBe(expectedHash);
    }
  });

  // 2. 0005 -> 0006 upgrade and rerun through Wrangler runner
  it('upgrades 0005 to 0006 with Wrangler, preserves T01/T02 data, and reruns as a true no-op', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mayi-migration-0006-'));
    const migrationsDir = join(fixtureRoot, 'migrations');
    const persistenceDir = join(fixtureRoot, 'state');
    const configPath = join(fixtureRoot, 'wrangler.jsonc');
    mkdirSync(migrationsDir, { recursive: true });
    mkdirSync(persistenceDir, { recursive: true });

    const historicalFiles = Object.keys(HISTORICAL_HASHES);
    for (const file of historicalFiles) {
      copyFileSync(resolve(rootDir, 'db/migrations', file), join(migrationsDir, file));
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'migration-0006-runner-test',
        compatibility_date: '2026-09-16',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'migration-0006-runner-test',
            database_id: '00000000-0000-0000-0000-000000000006',
            migrations_dir: migrationsDir,
          },
        ],
      }),
    );

    const runWrangler = (args: string[]) =>
      spawnSync(process.execPath, [wranglerCli, ...args, '--config', configPath], {
        cwd: rootDir,
        encoding: 'utf8',
      });
    const apply = () =>
      runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistenceDir]);
    const execute = (sql: string, json = false) =>
      runWrangler([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        persistenceDir,
        '--command',
        sql,
        ...(json ? ['--json'] : []),
      ]);

    try {
      const through0005 = apply();
      expect(through0005.status, `${through0005.stdout}\n${through0005.stderr}`).toBe(0);

      // Seed T01 / T02 data
      const seed = execute(`
        INSERT INTO agencies (id, status, version) VALUES ('ag-mig6-1', 'PROVISIONING', 1);
        INSERT INTO users (id, status, version) VALUES ('usr-mig6-1', 'INACTIVE', 1);
        INSERT INTO agency_memberships (
          id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
          version, permission_version
        ) VALUES (
          'mem-mig6-1', 'ag-mig6-1', 'usr-mig6-1', 'OWNER', 'INVITED',
          'mig6@test.com', '2099-01-01T00:00:00.000Z', 1, 1
        );
        INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
        VALUES ('id-mig6-1', 'usr-mig6-1', 'https://test', 'sub-mig6-1', 'mig6@test.com', 'ACTIVE');
        UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = 'usr-mig6-1';
        UPDATE agency_memberships SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z', version = 2, permission_version = 2 WHERE id = 'mem-mig6-1';
        UPDATE agencies SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z', activated_at = '2026-09-17T00:00:00.000Z', version = 2 WHERE id = 'ag-mig6-1';

        INSERT INTO customers (
          id, agency_id, type, display_name, first_name, last_name, assignee_membership_id, version
        ) VALUES (
          'cust-mig6-1', 'ag-mig6-1', 'INDIVIDUAL', 'Ali Veli', 'Ali', 'Veli', 'mem-mig6-1', 1
        );
      `);
      expect(seed.status, `${seed.stdout}\n${seed.stderr}`).toBe(0);

      // Copy 0006 migration file
      const { readdirSync } = await import('node:fs');
      const migDir = resolve(rootDir, 'db/migrations');
      const mig0006 = readdirSync(migDir).find((f) => f.startsWith('0006_') && f.endsWith('.sql'));
      expect(mig0006).toBeDefined();
      copyFileSync(resolve(migDir, mig0006!), join(migrationsDir, mig0006!));

      // Apply 0006
      const apply0006 = apply();
      expect(apply0006.status, `${apply0006.stdout}\n${apply0006.stderr}`).toBe(0);

      // Verify T01/T02 seed data is preserved
      const verifySeed = execute(
        "SELECT id, display_name FROM customers WHERE id = 'cust-mig6-1';",
        true,
      );
      expect(verifySeed.status).toBe(0);
      const parsedSeed = JSON.parse(verifySeed.stdout);
      expect(parsedSeed[0].results[0].display_name).toBe('Ali Veli');

      // Verify rerun is a true no-op
      const rerun = apply();
      expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
      expect(rerun.stdout).toContain('No migrations to apply');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('applies 0000 through 0006 cleanly with the Wrangler migration runner', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mayi-migration-0006-clean-'));
    const migrationsDir = join(fixtureRoot, 'migrations');
    const persistenceDir = join(fixtureRoot, 'state');
    const configPath = join(fixtureRoot, 'wrangler.jsonc');
    mkdirSync(migrationsDir, { recursive: true });
    mkdirSync(persistenceDir, { recursive: true });

    const migrationFiles = [...Object.keys(HISTORICAL_HASHES), '0006_parched_proteus.sql'];
    for (const file of migrationFiles) {
      copyFileSync(resolve(rootDir, 'db/migrations', file), join(migrationsDir, file));
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'migration-0006-clean-runner-test',
        compatibility_date: '2026-09-16',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'migration-0006-clean-runner-test',
            database_id: '00000000-0000-0000-0000-000000000016',
            migrations_dir: migrationsDir,
          },
        ],
      }),
    );

    const runWrangler = (args: string[]) =>
      spawnSync(process.execPath, [wranglerCli, ...args, '--config', configPath], {
        cwd: rootDir,
        encoding: 'utf8',
      });

    try {
      const apply = runWrangler([
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--persist-to',
        persistenceDir,
      ]);
      expect(apply.status, `${apply.stdout}\n${apply.stderr}`).toBe(0);
      expect(apply.stdout).toContain('0006_parched_proteus.sql');

      const inventory = runWrangler([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        persistenceDir,
        '--command',
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('agency_settings', 'insurers', 'insurance_branches', 'insurance_products', 'payment_methods', 'loss_reasons')
         ORDER BY name;`,
        '--json',
      ]);
      expect(inventory.status, `${inventory.stdout}\n${inventory.stderr}`).toBe(0);
      const parsed = JSON.parse(inventory.stdout) as Array<{ results: Array<{ name: string }> }>;
      expect(parsed[0]?.results.map((row) => row.name)).toEqual([
        'agency_settings',
        'insurance_branches',
        'insurance_products',
        'insurers',
        'loss_reasons',
        'payment_methods',
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // 4. Drizzle schema has no drift
  it('verifies Drizzle schema matches migrations with no drift', () => {
    const driftCheck = execSync('npx drizzle-kit generate', {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(driftCheck).toContain('No schema changes');
  });
});
