// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import miniflare from 'miniflare';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');

async function createDatabase() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response()}}',
      d1Databases: { DB: crypto.randomUUID() },
    }),
  );
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^000[0-8]_.*\.sql$/.test(name))
    .sort()) {
    for (const statement of readFileSync(resolve(root, 'db/migrations', file), 'utf8')
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  await db.prepare("INSERT INTO agencies(id,status) VALUES('a','PROVISIONING')").run();
  await db.prepare("INSERT INTO users(id,status) VALUES('u','INACTIVE')").run();
  await db
    .prepare(
      "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','u@test.test','2099-01-01Z')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Seed','S','E','m')",
    )
    .run();
  await db
    .prepare("INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Insurer')")
    .run();
  await db
    .prepare("INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Branch')")
    .run();
  await db
    .prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('p','a','i','b','P','Product')",
    )
    .run();
  await db
    .prepare("INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pm','a','PM','Cash')")
    .run();
  return { mf, db };
}

async function insertPolicy(db: D1Database, id: string, policyNumber: string, normalized: string) {
  await db
    .prepare(
      `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,
      policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
     VALUES(?, 'a','c','i','p','b','pm','m', ?, ?, '2026-01-01','2026-12-31',1,'TRY')`,
    )
    .bind(id, policyNumber, normalized)
    .run();
}

const migration = readFileSync(
  resolve(root, 'db/migrations/0009_turkish_policy_number_casefold.sql'),
  'utf8',
);

describe('M2 Turkish policy-number normalization migration 0009', () => {
  it('backfills legacy dotted-I values and is a no-op once canonical', async () => {
    const { mf, db } = await createDatabase();
    try {
      await insertPolicy(db, 'p-legacy', 'İLK-2026/001', 'İLK2026001');
      await db.prepare(migration).run();
      const normalized = await db
        .prepare("SELECT normalized_policy_number FROM policies WHERE id='p-legacy'")
        .first<{ normalized_policy_number: string }>();
      expect(normalized?.normalized_policy_number).toBe('ILK2026001');
      const rerun = await db.prepare(migration).run();
      expect(rerun.meta.changes).toBe(0);
    } finally {
      await mf.dispose();
    }
  });

  it('rejects a canonicalization collision atomically under the candidate unique constraint', async () => {
    const { mf, db } = await createDatabase();
    try {
      await insertPolicy(db, 'p-ascii', 'ILK-2026/001', 'ILK2026001');
      await insertPolicy(db, 'p-dotted', 'İLK-2026/001', 'İLK2026001');
      await expect(db.prepare(migration).run()).rejects.toThrow();
      const rows = await db
        .prepare('SELECT id,normalized_policy_number FROM policies ORDER BY id')
        .all<{ id: string; normalized_policy_number: string }>();
      expect(rows.results).toEqual([
        { id: 'p-ascii', normalized_policy_number: 'ILK2026001' },
        { id: 'p-dotted', normalized_policy_number: 'İLK2026001' },
      ]);
    } finally {
      await mf.dispose();
    }
  });

  it('passes Wrangler local clean, upgrade-with-preserved-data, and rerun no-op acceptance', () => {
    const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
    const migrationFiles = readdirSync(resolve(root, 'db/migrations'))
      .filter((file) => /^000[0-9]_.*\.sql$/.test(file))
      .sort();
    const legacyFiles = migrationFiles.filter((file) => !file.startsWith('0009_'));
    for (const mode of ['clean', 'upgrade'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `m2-policy-0009-${mode}-`));
      const migrations = join(dir, 'migrations');
      const state = join(dir, 'state');
      const config = join(dir, 'wrangler.jsonc');
      mkdirSync(migrations);
      mkdirSync(state);
      for (const file of mode === 'clean' ? migrationFiles : legacyFiles) {
        copyFileSync(resolve(root, 'db/migrations', file), join(migrations, file));
      }
      writeFileSync(
        config,
        JSON.stringify({
          name: 'm2-policy-0009',
          compatibility_date: '2026-09-16',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'policy-0009',
              database_id: '00000000-0000-0000-0000-000000000029',
              migrations_dir: migrations,
            },
          ],
        }),
      );
      const run = (args: string[]) =>
        spawnSync(process.execPath, [wrangler, ...args, '--config', config], {
          cwd: root,
          encoding: 'utf8',
        });
      const apply = () =>
        run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
      try {
        let result = apply();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        if (mode === 'upgrade') {
          const seed = [
            "INSERT INTO agencies(id,status)VALUES('a','PROVISIONING')",
            "INSERT INTO users(id,status)VALUES('u','INACTIVE')",
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)VALUES('m','a','u','OWNER','INVITED','u@test.test','2099-01-01Z')",
            "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)VALUES('c','a','INDIVIDUAL','Seed','S','E','m')",
            "INSERT INTO insurers(id,agency_id,code,name)VALUES('i','a','I','Insurer')",
            "INSERT INTO insurance_branches(id,agency_id,code,name)VALUES('b','a','B','Branch')",
            "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)VALUES('p','a','i','b','P','Product')",
            "INSERT INTO payment_methods(id,agency_id,code,name)VALUES('pm','a','PM','Cash')",
            "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)VALUES('pol','a','c','i','p','b','pm','m','İLK-2026/001','İLK2026001','2026-01-01','2026-12-31',1,'TRY')",
          ].join(';');
          const seeded = run([
            'd1',
            'execute',
            'DB',
            '--local',
            '--persist-to',
            state,
            '--command',
            seed,
          ]);
          expect(seeded.status, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
          const normalization = migrationFiles.find((file) => file.startsWith('0009_'))!;
          copyFileSync(
            resolve(root, 'db/migrations', normalization),
            join(migrations, normalization),
          );
          result = apply();
          expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
          const query = run([
            'd1',
            'execute',
            'DB',
            '--local',
            '--persist-to',
            state,
            '--command',
            "SELECT normalized_policy_number FROM policies WHERE id='pol'",
            '--json',
          ]);
          expect(query.status, query.stderr).toBe(0);
          expect(query.stdout).toContain('ILK2026001');
        }
        result = apply();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('No migrations to apply');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 180_000);
});
