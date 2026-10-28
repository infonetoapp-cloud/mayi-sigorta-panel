// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

type CommandResult = { status: number | null; stdout: string; stderr: string };
const root = resolve(__dirname, '..');
const migrationFiles = readdirSync(resolve(root, 'db/migrations'))
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .sort();
const targetMigration = migrationFiles.find((file) => file.startsWith('0014_'));
if (!targetMigration) throw new Error('M3 WON premium correction migration 0014 is missing.');
const migrationsThrough0014 = migrationFiles.filter((file) => Number(file.slice(0, 4)) <= 14);

function createRunner(mode: 'clean' | 'upgrade') {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const dir = mkdtempSync(join(tmpdir(), `m3-migration-0014-${mode}-`));
  const migrations = join(dir, 'migrations');
  const state = join(dir, 'state');
  const config = join(dir, 'wrangler.jsonc');
  mkdirSync(migrations);
  mkdirSync(state);
  const initial =
    mode === 'clean'
      ? migrationsThrough0014
      : migrationsThrough0014.filter((name) => name !== targetMigration);
  for (const file of initial)
    copyFileSync(resolve(root, 'db/migrations', file), join(migrations, file));
  writeFileSync(
    config,
    JSON.stringify({
      name: `m3-migration-0014-${mode}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: `m3-migration-0014-${mode}`,
          database_id: '00000000-0000-0000-0000-000000000114',
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
  return {
    dir,
    apply: () => run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]),
    installTarget: () =>
      copyFileSync(
        resolve(root, 'db/migrations', targetMigration!),
        join(migrations, targetMigration!),
      ),
    execute: (sql: string): CommandResult =>
      run(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', sql, '--json']),
  };
}

const seedWonPolicy = [
  "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING')",
  "INSERT INTO users(id,status) VALUES('u','INACTIVE')",
  `INSERT INTO agency_memberships
     (id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
   VALUES('m','a','u','OWNER','INVITED','u@test.test','2099-01-01T00:00:00.000Z')`,
  `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
   VALUES('c','a','INDIVIDUAL','Customer A','A','Customer','m')`,
  "INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Insurer')",
  `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
   VALUES('b','a','B','Branch','GENERAL')`,
  `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
   VALUES('p','a','i','b','P','Product')`,
  "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pm','a','PM','Cash')",
  `INSERT INTO policies
     (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
      assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
      gross_premium_minor,currency,version)
   VALUES('old','a','c','i','p','b','pm','m','OLD-POLICY','OLDPOLICY',
     '2025-10-25','2026-10-24',10000,'TRY',1),
         ('new','a','c','i','p','b','pm','m','NEW-POLICY','NEWPOLICY',
     '2026-10-25','2027-10-24',10000,'TRY',1)`,
  `INSERT INTO renewal_opportunities
     (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
   VALUES('r','a','old','m','CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z',
     '2026-09-24T06:00:00.000Z')`,
  `INSERT INTO renewal_state_history
     (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
   VALUES('h0','a','r',NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
  `INSERT INTO operation_receipts
     (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
      status,response_status,response_body)
   VALUES('allocation','a','u','m','renewal.policy_links.allocate','allocation-key','${'a'.repeat(64)}',
     'COMPLETED',201,'{}'),
         ('correction','a','u','m','renewal.won.premium.correct','correction-key','${'b'.repeat(64)}',
     'COMPLETED',200,'{}')`,
  `INSERT INTO renewal_policy_links
     (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
      allocation_operation_id,created_by_membership_id,created_at)
   VALUES('link','a','r','new',10000,'TRY','allocation','m','2026-09-24T06:00:00.000Z')`,
  `UPDATE renewal_opportunities
   SET state='WON',closed_at='2026-09-24T06:00:00.000Z',closed_by_membership_id='m',
       version=2,updated_at='2026-09-24T06:00:00.000Z'
   WHERE id='r'`,
].join(';');

function expectSuccess(result: CommandResult): void {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function stableQueryOutput(result: CommandResult): unknown {
  const output = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  return output.map((item) =>
    Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'meta')),
  );
}

function expectMigrationInventory(execute: (sql: string) => CommandResult): void {
  const result = execute(
    `SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')
       AND (name LIKE 'renewal_won_policy_premium_correction%'
         OR name IN ('renewal_policy_links_won_policy_update_lock',
                     'renewal_policy_links_won_insert_requires_correction',
                     'renewal_policy_links_won_supersede_requires_correction'))
     ORDER BY name`,
  );
  expectSuccess(result);
  for (const name of [
    'renewal_won_policy_premium_corrections',
    'renewal_won_policy_premium_correction_links',
    'renewal_won_policy_premium_corrections_agency_id_id_uq',
    'renewal_won_policy_premium_corrections_policy_idx',
    'renewal_won_policy_premium_correction_links_agency_id_id_uq',
    'renewal_won_policy_premium_correction_links_operation_old_uq',
    'renewal_won_policy_premium_correction_links_operation_new_uq',
    'renewal_won_policy_premium_corrections_insert_guard',
    'renewal_won_policy_premium_correction_links_insert_guard',
    'renewal_won_policy_premium_corrections_immutable_update',
    'renewal_won_policy_premium_corrections_immutable_delete',
    'renewal_won_policy_premium_correction_links_immutable_update',
    'renewal_won_policy_premium_correction_links_immutable_delete',
    'renewal_policy_links_won_policy_update_lock',
    'renewal_policy_links_won_insert_requires_correction',
    'renewal_policy_links_won_supersede_requires_correction',
    'renewal_won_policy_premium_correction_guard',
  ]) {
    expect(result.stdout).toContain(name);
  }
}

const preservedWonEvidence = `SELECT
  (SELECT count(*) FROM agencies WHERE id='a') AS agencies,
  (SELECT count(*) FROM customers WHERE id='c') AS customers,
  (SELECT count(*) FROM policies) AS policies,
  (SELECT id || ':' || state || ':' || version FROM renewal_opportunities WHERE id='r') AS renewal,
  (SELECT id || ':' || status || ':' || allocated_new_premium_minor FROM renewal_policy_links WHERE id='link') AS link,
  (SELECT id || ':' || to_state FROM renewal_state_history WHERE id='h0') AS history,
  (SELECT count(*) FROM operation_receipts WHERE id IN ('allocation','correction')) AS receipts`;

function verifyWonPremiumCorrection(execute: (sql: string) => CommandResult): void {
  const uncorrectedPremium = execute(
    "UPDATE policies SET gross_premium_minor=11000,version=version+1 WHERE id='new'",
  );
  expect(uncorrectedPremium.status).not.toBe(0);

  expectSuccess(
    execute(
      `INSERT INTO renewal_won_policy_premium_corrections
       (id,agency_id,policy_id,actor_membership_id,expected_policy_version,previous_premium_minor,
        corrected_premium_minor,reason_code,created_at)
       VALUES('correction','a','new','m',1,10000,12000,'PREMIUM_RECONCILIATION',
         '2026-09-24T07:00:00.000Z')`,
    ),
  );
  expectSuccess(
    execute(
      `INSERT INTO renewal_won_policy_premium_correction_links
       (id,agency_id,operation_id,old_link_id,new_link_id,renewal_id,policy_id,
        allocated_premium_minor,currency,different_policyholder_reason_code)
       VALUES('correction-link','a','correction','link','link-v2','r','new',12000,'TRY',NULL)`,
    ),
  );
  expectSuccess(
    execute(
      `UPDATE renewal_policy_links
       SET status='SUPERSEDED',superseded_at='2026-09-24T07:00:00.000Z',
           superseded_by_membership_id='m',supersede_reason_code='WON_PREMIUM_CORRECTED',
           superseded_operation_id='correction'
       WHERE id='link' AND status='ACTIVE'`,
    ),
  );
  expectSuccess(
    execute(
      `UPDATE policies SET gross_premium_minor=12000,version=2,
         updated_at='2026-09-24T07:00:00.000Z' WHERE id='new' AND version=1`,
    ),
  );
  expectSuccess(
    execute(
      `INSERT INTO renewal_policy_links
       (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
        supersedes_link_id,allocation_operation_id,different_policyholder_reason_code,
        created_by_membership_id,created_at)
       VALUES('link-v2','a','r','new',12000,'TRY','link','correction',NULL,'m',
         '2026-09-24T07:00:00.000Z')`,
    ),
  );
  const corrected = execute(
    `SELECT p.id,p.gross_premium_minor,p.version,
       (SELECT count(*) FROM renewal_policy_links WHERE id='link' AND status='SUPERSEDED'
         AND superseded_operation_id='correction') AS old_link,
       (SELECT count(*) FROM renewal_policy_links WHERE id='link-v2' AND status='ACTIVE'
         AND supersedes_link_id='link' AND allocated_new_premium_minor=12000) AS new_link,
       (SELECT sum(allocated_new_premium_minor) FROM renewal_policy_links
         WHERE new_policy_id='new' AND status='ACTIVE') AS active_allocation
     FROM policies p WHERE p.id='new'`,
  );
  expectSuccess(corrected);
  expect(corrected.stdout).toContain('"gross_premium_minor": 12000');
  expect(corrected.stdout).toContain('"version": 2');
  expect(corrected.stdout).toContain('"old_link": 1');
  expect(corrected.stdout).toContain('"new_link": 1');
  expect(corrected.stdout).toContain('"active_allocation": 12000');

  for (const invalid of [
    "UPDATE renewal_won_policy_premium_corrections SET reason_code='CHANGED' WHERE id='correction'",
    "DELETE FROM renewal_won_policy_premium_corrections WHERE id='correction'",
    "UPDATE renewal_won_policy_premium_correction_links SET allocated_premium_minor=1 WHERE id='correction-link'",
    "DELETE FROM renewal_won_policy_premium_correction_links WHERE id='correction-link'",
    `INSERT INTO renewal_won_policy_premium_correction_links
       (id,agency_id,operation_id,old_link_id,new_link_id,renewal_id,policy_id,allocated_premium_minor,currency)
     VALUES('duplicate-old','a','correction','link','different-new','r','new',12000,'TRY')`,
    `INSERT INTO renewal_won_policy_premium_correction_links
       (id,agency_id,operation_id,old_link_id,new_link_id,renewal_id,policy_id,allocated_premium_minor,currency)
     VALUES('duplicate-new','a','correction','link-v2','link-v2','r','new',12000,'TRY')`,
    `INSERT INTO renewal_won_policy_premium_correction_links
       (id,agency_id,operation_id,old_link_id,new_link_id,renewal_id,policy_id,allocated_premium_minor,currency)
     VALUES('cross-agency-map','foreign','correction','link','foreign-link','r','new',12000,'TRY')`,
  ]) {
    expect(execute(invalid).status).not.toBe(0);
  }
}

describe('M3 migration 0014 WON premium correction evidence', () => {
  it('clean applies correction tables, guard triggers, constraints, and reruns as a no-op', () => {
    const runner = createRunner('clean');
    try {
      expectSuccess(runner.apply());
      expectSuccess(runner.execute(seedWonPolicy));
      expectMigrationInventory(runner.execute);
      const foreignKeys = runner.execute(
        "PRAGMA foreign_key_list('renewal_won_policy_premium_correction_links')",
      );
      expectSuccess(foreignKeys);
      expect(foreignKeys.stdout).toContain('renewal_policy_links');
      expect(foreignKeys.stdout).toContain('renewal_opportunities');
      expect(foreignKeys.stdout).toContain('policies');
      verifyWonPremiumCorrection(runner.execute);
      const rerun = runner.apply();
      expectSuccess(rerun);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('upgrades accepted 0013 WON/link history without data loss before recording old/new premium evidence', () => {
    const runner = createRunner('upgrade');
    try {
      expectSuccess(runner.apply());
      expectSuccess(runner.execute(seedWonPolicy));
      const before = runner.execute(preservedWonEvidence);
      expectSuccess(before);
      runner.installTarget();
      expectSuccess(runner.apply());
      const after = runner.execute(preservedWonEvidence);
      expectSuccess(after);
      expect(stableQueryOutput(after)).toEqual(stableQueryOutput(before));
      expectMigrationInventory(runner.execute);
      verifyWonPremiumCorrection(runner.execute);
      const rerun = runner.apply();
      expectSuccess(rerun);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  }, 180_000);
});
