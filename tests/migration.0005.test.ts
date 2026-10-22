// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { historicalMigrationHash } from './support/migration-git-bytes';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import miniflare from 'miniflare';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');
const wranglerCli = resolve(rootDir, 'node_modules/wrangler/bin/wrangler.js');

describe('M2-T02 Migration 0005 & Database Invariant Verification', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  const HISTORICAL_HASHES: Record<string, string> = {
    '0000_good_hammerhead.sql': 'de803e199abed34fa71fde797260d7545367b979f9d09cac886826e4e3f95a5d',
    '0001_chunky_blazing_skull.sql':
      'd79c8922324764f154315f9888d7bd0765f3475d7b39f02b363f60f59366b48b',
    '0002_productive_arclight.sql':
      '3eb6b49de885c929cb2eb5d289241bd34956827f7d9d2d354d428a934df57a5f',
    '0003_lonely_zzzax.sql': '1a5f075b522724aedf0c51d19aed090ca9727c53bd43ef64e4517b69ad1de8a3',
    '0004_thankful_pixie.sql': 'b79a46d884eab9484abbaaf2251bf374fb21359448b6fd8583ba2ab32bd181d3',
  };

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000005',
        },
      }),
    );
    db = await mf.getD1Database('DB');
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  // 1. Historical migrations 0000-0004 are strictly unchanged
  it('verifies historical 0000-0004 migrations are unchanged (exact SHA-256 hash preservation)', () => {
    for (const [filename, expectedHash] of Object.entries(HISTORICAL_HASHES)) {
      const actualHash = historicalMigrationHash(rootDir, filename);
      expect(actualHash).toBe(expectedHash);
    }
  });

  // 2. 0004 -> 0005 upgrade and rerun through the deployment migration runner
  it('upgrades 0004 to 0005 with Wrangler metadata, preserves data, and reruns as a true no-op', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mayi-migration-0005-'));
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
        name: 'migration-0005-runner-test',
        compatibility_date: '2026-09-16',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'migration-0005-runner-test',
            database_id: '00000000-0000-0000-0000-000000000005',
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
      const through0004 = apply();
      expect(through0004.status, `${through0004.stdout}\n${through0004.stderr}`).toBe(0);

      const seed = execute(`
        INSERT INTO agencies (id, status, version) VALUES ('ag-mig5-1', 'PROVISIONING', 1);
        INSERT INTO users (id, status, version) VALUES ('usr-mig5-1', 'INACTIVE', 1);
        INSERT INTO agency_memberships (
          id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
          version, permission_version
        ) VALUES (
          'mem-mig5-1', 'ag-mig5-1', 'usr-mig5-1', 'OWNER', 'INVITED',
          'mig5@test.com', '2099-01-01T00:00:00.000Z', 1, 1
        );
        INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
        VALUES ('ident-mig5-1', 'usr-mig5-1', 'https://test', 'sub-mig5-1', 'mig5@test.com', 'ACTIVE');
        UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = 'usr-mig5-1';
        UPDATE agency_memberships
        SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
            version = 2, permission_version = 2 WHERE id = 'mem-mig5-1';
        UPDATE agencies
        SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
            activated_at = '2026-09-17T00:00:00.000Z', version = 2 WHERE id = 'ag-mig5-1';
        INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
        VALUES ('cust-mig5-1', 'ag-mig5-1', 'INDIVIDUAL', 'Müşteri 1', 'mem-mig5-1', 1);
      `);
      expect(seed.status, `${seed.stdout}\n${seed.stderr}`).toBe(0);

      copyFileSync(
        resolve(rootDir, 'db/migrations/0005_graceful_northstar.sql'),
        join(migrationsDir, '0005_graceful_northstar.sql'),
      );
      const upgrade = apply();
      expect(upgrade.status, `${upgrade.stdout}\n${upgrade.stderr}`).toBe(0);
      expect(upgrade.stdout).toContain('0005_graceful_northstar.sql');

      const verification = execute(
        `SELECT display_name, version FROM customers WHERE id = 'cust-mig5-1';
         SELECT name FROM d1_migrations ORDER BY id;`,
        true,
      );
      expect(verification.status, `${verification.stdout}\n${verification.stderr}`).toBe(0);
      const resultSets = JSON.parse(verification.stdout) as Array<{
        results: Array<Record<string, unknown>>;
      }>;
      expect(resultSets[0]?.results).toEqual([{ display_name: 'Müşteri 1', version: 1 }]);
      expect(resultSets[1]?.results.at(-1)).toEqual({ name: '0005_graceful_northstar.sql' });

      const rerun = apply();
      expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
      expect(rerun.stdout).toContain('No migrations to apply');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }

    // Initialize the Miniflare database once for the invariant tests below.
    for (const file of [...historicalFiles, '0005_graceful_northstar.sql']) {
      const sql = readFileSync(resolve(rootDir, 'db/migrations', file), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES ('ag-mig5-1', 'PROVISIONING', 1)")
      .run();
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES ('usr-mig5-1', 'INACTIVE', 1)")
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
      id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
    ) VALUES ('mem-mig5-1', 'ag-mig5-1', 'usr-mig5-1', 'OWNER', 'INVITED', 'mig5@test.com',
      '2099-01-01T00:00:00.000Z', 1, 1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO customers (
      id, agency_id, type, display_name, assignee_membership_id, version
    ) VALUES ('cust-mig5-1', 'ag-mig5-1', 'INDIVIDUAL', 'Müşteri 1', 'mem-mig5-1', 1)`,
      )
      .run();
  });

  // 3. Actual composite FK / CHECK / unique / trigger inventory
  it('verifies actual composite FK, triggers, and index inventory for 0005 in SQLite', async () => {
    // Columns inventory on customers table
    const columns = await db.prepare("PRAGMA table_info('customers')").all<{ name: string }>();
    const colNames = columns.results.map((c) => c.name);

    expect(colNames).toContain('identity_type');
    expect(colNames).toContain('identity_ciphertext');
    expect(colNames).toContain('identity_iv');
    expect(colNames).toContain('identity_tag');
    expect(colNames).toContain('identity_search_hash');
    expect(colNames).toContain('identity_key_version');

    // Composite FK inventory for external_customer_references: (agency_id, customer_id) -> customers(agency_id, id)
    const extFkList = await db
      .prepare("PRAGMA foreign_key_list('external_customer_references')")
      .all<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }>();

    const compositeExtFk = extFkList.results.filter((fk) => fk.table === 'customers');
    expect(compositeExtFk.length).toBe(2);
    const extFromCols = compositeExtFk.map((fk) => fk.from).sort();
    const extToCols = compositeExtFk.map((fk) => fk.to).sort();
    expect(extFromCols).toEqual(['agency_id', 'customer_id']);
    expect(extToCols).toEqual(['agency_id', 'id']);

    // Trigger inventory
    const triggers = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all<{ name: string }>();
    const triggerNames = triggers.results.map((t) => t.name);

    expect(triggerNames).toContain('ext_cust_refs_parent_guard');
    expect(triggerNames).toContain('ext_cust_refs_parent_update_guard');
    expect(triggerNames).toContain('customers_identity_type_guard');
    expect(triggerNames).toContain('customers_identity_type_update_guard');

    // Unique index on external_customer_references (agency_id, source_namespace, external_key)
    const uqIndex = await db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'ext_cust_refs_agency_source_key_uq'",
      )
      .first<{ name: string; sql: string }>();
    expect(uqIndex).toBeDefined();

    // Identity search hash index on customers
    const hmacIndex = await db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'customers_agency_identity_search_hash_idx'",
      )
      .first<{ name: string; sql: string }>();
    expect(hmacIndex).toBeDefined();
  });

  // 4. Cross-agency protection & duplicate rejection tests
  it('enforces cross-agency rejection and unique external references', async () => {
    // Seed agency 2
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES ('ag-mig5-2', 'PROVISIONING', 1)")
      .run();
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES ('usr-mig5-2', 'INACTIVE', 1)")
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
         ) VALUES ('mem-mig5-2', 'ag-mig5-2', 'usr-mig5-2', 'OWNER', 'INVITED', 'mig5-2@test.com', '2099-01-01T00:00:00.000Z', 1, 1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES ('ident-mig5-2', 'usr-mig5-2', 'https://test', 'sub-mig5-2', 'mig5-2@test.com', 'ACTIVE')`,
      )
      .run();
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = 'usr-mig5-2'")
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships
         SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z', version = 2, permission_version = 2
         WHERE id = 'mem-mig5-2'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agencies
         SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
             activated_at = '2026-09-17T00:00:00.000Z', version = 2
         WHERE id = 'ag-mig5-2'`,
      )
      .run();

    // Cross-agency insert into external_customer_references must fail
    await expect(
      db
        .prepare(
          `INSERT INTO external_customer_references (
             id, agency_id, customer_id, source_namespace, external_key
           ) VALUES ('ext-1', 'ag-mig5-2', 'cust-mig5-1', 'ALLIANZ', 'POL-123')`,
        )
        .run(),
    ).rejects.toThrow();

    // Valid insert
    await db
      .prepare(
        `INSERT INTO external_customer_references (
           id, agency_id, customer_id, source_namespace, external_key
         ) VALUES ('ext-1', 'ag-mig5-1', 'cust-mig5-1', 'ALLIANZ', 'POL-123')`,
      )
      .run();

    // Duplicate (agency_id, source_namespace, external_key) must fail
    await expect(
      db
        .prepare(
          `INSERT INTO external_customer_references (
             id, agency_id, customer_id, source_namespace, external_key
           ) VALUES ('ext-2', 'ag-mig5-1', 'cust-mig5-1', 'ALLIANZ', 'POL-123')`,
        )
        .run(),
    ).rejects.toThrow();
  });

  // 5. Customer identity type rules (INDIVIDUAL TCKN only, COMPANY VKN only)
  it('enforces identity type rules via triggers', async () => {
    // INDIVIDUAL with VKN must fail
    await expect(
      db
        .prepare(
          `UPDATE customers
           SET identity_type = 'VKN', identity_ciphertext = 'c', identity_iv = 'iv', identity_tag = 't', identity_search_hash = 'h', identity_key_version = 1
           WHERE id = 'cust-mig5-1'`,
        )
        .run(),
    ).rejects.toThrow('INVALID_CUSTOMER_IDENTITY_TYPE');

    // Incomplete envelope must fail
    await expect(
      db
        .prepare(
          `UPDATE customers
           SET identity_type = 'TCKN', identity_ciphertext = 'c'
           WHERE id = 'cust-mig5-1'`,
        )
        .run(),
    ).rejects.toThrow('CUSTOMER_IDENTITY_ENVELOPE_INCOMPLETE');

    // INDIVIDUAL with TCKN and complete envelope succeeds
    await expect(
      db
        .prepare(
          `UPDATE customers
           SET identity_type = 'TCKN', identity_ciphertext = 'c', identity_iv = 'iv', identity_tag = 't', identity_search_hash = 'h', identity_key_version = 1
           WHERE id = 'cust-mig5-1'`,
        )
        .run(),
    ).resolves.toBeDefined();

    // Clearing identity succeeds
    await expect(
      db
        .prepare(
          `UPDATE customers
           SET identity_type = NULL, identity_ciphertext = NULL, identity_iv = NULL, identity_tag = NULL, identity_search_hash = NULL, identity_key_version = NULL
           WHERE id = 'cust-mig5-1'`,
        )
        .run(),
    ).resolves.toBeDefined();
  });

  // 6. Drizzle no-drift verification
  it('verifies Drizzle schema has zero drift against migration snapshot', () => {
    const output = execSync('npx drizzle-kit generate', {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(output).toContain('No schema changes, nothing to migrate');
  });
});
