// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

const root = resolve(__dirname, '..');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const hashes: Record<string, string> = {
  '0000_good_hammerhead.sql': 'de803e199abed34fa71fde797260d7545367b979f9d09cac886826e4e3f95a5d',
  '0001_chunky_blazing_skull.sql':
    'd79c8922324764f154315f9888d7bd0765f3475d7b39f02b363f60f59366b48b',
  '0002_productive_arclight.sql':
    '3eb6b49de885c929cb2eb5d289241bd34956827f7d9d2d354d428a934df57a5f',
  '0003_lonely_zzzax.sql': '1a5f075b522724aedf0c51d19aed090ca9727c53bd43ef64e4517b69ad1de8a3',
  '0004_thankful_pixie.sql': 'b79a46d884eab9484abbaaf2251bf374fb21359448b6fd8583ba2ab32bd181d3',
  '0005_graceful_northstar.sql': 'f5c1717b78c0d7fe9f5b3576616283311709d35e29eb24a7d786b8b1cc7dfd51',
  '0006_parched_proteus.sql': 'd6cd62cbb4b3fc9980e415f1de32431e65830f89a7415d2e64ba393209fafdf7',
  '0007_robust_scalphunter.sql': 'cefdc12a212eca76860b4b5504419210522a10ebdf130af46516d089981ce284',
};

describe('M2-T05 migration 0008', () => {
  it('preserves historical SQL and creates exactly one 0008', () => {
    for (const [file, expected] of Object.entries(hashes)) {
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, 'db/migrations', file)))
          .digest('hex'),
      ).toBe(expected);
    }
    expect(
      readdirSync(resolve(root, 'db/migrations')).filter((file) => file.startsWith('0008_')),
    ).toHaveLength(1);
    expect(
      readdirSync(resolve(root, 'db/migrations')).filter((file) => file.startsWith('0009_')),
    ).toEqual([]);
    const migration = readFileSync(
      resolve(
        root,
        'db/migrations',
        readdirSync(resolve(root, 'db/migrations')).find((file) => file.startsWith('0008_'))!,
      ),
      'utf8',
    );
    expect(migration).toContain(
      'FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`)',
    );
    expect(migration).toContain(
      'FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`)',
    );
    expect(migration).toContain('policy_parties_archived_customer_guard_insert');
    expect(migration).toContain(
      'BEFORE UPDATE OF customer_id,agency_id,archived_at,archived_by_membership_id,archive_reason',
    );
    expect(migration).toContain('policies_archive_reason_code_guard_insert');
    for (const forbidden of [
      'renewal_opportunities',
      'renewal_policy_links',
      'tasks',
      'quotes',
      'documents',
    ]) {
      expect(migration).not.toMatch(new RegExp(`CREATE TABLE [^\\n]*${forbidden}`, 'i'));
    }
  });

  it('upgrades 0007 to 0008 with seeds preserved, clean-applies, and reruns as a true no-op', () => {
    for (const mode of ['upgrade', 'clean'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `m2t05-${mode}-`));
      const migrations = join(dir, 'migrations');
      const state = join(dir, 'state');
      const config = join(dir, 'wrangler.jsonc');
      mkdirSync(migrations);
      mkdirSync(state);
      const old = Object.keys(hashes);
      const migration0008 = readdirSync(resolve(root, 'db/migrations')).find((file) =>
        file.startsWith('0008_'),
      )!;
      for (const file of mode === 'upgrade' ? old : [...old, migration0008]) {
        copyFileSync(resolve(root, 'db/migrations', file), join(migrations, file));
      }
      writeFileSync(
        config,
        JSON.stringify({
          name: 'm2t05-migration',
          compatibility_date: '2026-09-16',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'm2t05',
              database_id: '00000000-0000-0000-0000-000000000028',
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
          const seedSql =
            "INSERT INTO agencies(id,status)VALUES('a','PROVISIONING');" +
            "INSERT INTO users(id,status)VALUES('u','INACTIVE');" +
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)VALUES('m','a','u','OWNER','INVITED','x@y.zz','2099-01-01Z');" +
            "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)VALUES('c','a','INDIVIDUAL','Seed','S','E','m');" +
            "INSERT INTO insurers(id,agency_id,code,name)VALUES('i','a','I','Insurer');" +
            "INSERT INTO insurance_branches(id,agency_id,code,name)VALUES('b','a','B','Branch');" +
            "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)VALUES('p','a','i','b','P','Product');" +
            "INSERT INTO payment_methods(id,agency_id,code,name)VALUES('pm','a','PM','Cash');" +
            "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)VALUES('pol','a','c','i','p','b','pm','m','N','N','2026-01-01','2026-12-31',1,'TRY');";
          const seed = run([
            'd1',
            'execute',
            'DB',
            '--local',
            '--persist-to',
            state,
            '--command',
            seedSql,
          ]);
          expect(seed.status, seed.stderr).toBe(0);
          copyFileSync(
            resolve(root, 'db/migrations', migration0008),
            join(migrations, migration0008),
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
            "SELECT display_name FROM customers WHERE id='c';SELECT policy_number FROM policies WHERE id='pol';SELECT name FROM sqlite_master WHERE type='table' AND name IN ('policy_parties','policy_amendments','policy_external_references') ORDER BY name;",
            '--json',
          ]);
          expect(query.status, query.stderr).toBe(0);
          expect(query.stdout).toContain('Seed');
          expect(query.stdout).toContain('policy_parties');
          expect(query.stdout).toContain('policy_amendments');
          expect(query.stdout).toContain('policy_external_references');
        }
        result = apply();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('No migrations to apply');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('has no Drizzle drift after 0008', () => {
    expect(execSync('npx drizzle-kit generate', { cwd: root, encoding: 'utf8' })).toContain(
      'No schema changes',
    );
  });
});
