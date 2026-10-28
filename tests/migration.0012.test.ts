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
const migrationsThrough0012 = migrationFiles.filter((file) => Number(file.slice(0, 4)) <= 12);
const linkMigration = migrationsThrough0012.find((file) => file.startsWith('0012_'));
if (!linkMigration) throw new Error('M3 RenewalPolicyLink migration 0012 is missing.');

function createRunner(mode: 'clean' | 'upgrade') {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const dir = mkdtempSync(join(tmpdir(), `m3-migration-0012-${mode}-`));
  const migrations = join(dir, 'migrations');
  const state = join(dir, 'state');
  const config = join(dir, 'wrangler.jsonc');
  mkdirSync(migrations);
  mkdirSync(state);
  const initialMigrations =
    mode === 'clean'
      ? migrationsThrough0012
      : migrationsThrough0012.filter((name) => name !== linkMigration);
  for (const file of initialMigrations) {
    copyFileSync(resolve(root, 'db/migrations', file), join(migrations, file));
  }
  writeFileSync(
    config,
    JSON.stringify({
      name: `m3-migration-0012-${mode}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: `m3-migration-0012-${mode}`,
          database_id: '00000000-0000-0000-0000-000000000112',
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
    migrations,
    apply: () => run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]),
    installLinkMigration: () =>
      copyFileSync(
        resolve(root, 'db/migrations', linkMigration!),
        join(migrations, linkMigration!),
      ),
    execute: (sql: string): CommandResult =>
      run(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', sql, '--json']),
  };
}

const seed = [
  "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING')",
  "INSERT INTO users(id,status) VALUES('u','INACTIVE')",
  "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','u@test.test','2099-01-01T00:00:00.000Z')",
  "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Customer A','A','Customer','m'),('c2','a','INDIVIDUAL','Customer B','B','Customer','m')",
  "INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Insurer')",
  "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Branch')",
  "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('p','a','i','b','P','Product')",
  "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pm','a','PM','Cash')",
  "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('old-a','a','c','i','p','b','pm','m','OLD-A','OLDA','2025-10-25','2026-10-24',10000,'TRY'),('old-b','a','c','i','p','b','pm','m','OLD-B','OLDB','2025-10-26','2026-10-25',7000,'TRY'),('old-c','a','c','i','p','b','pm','m','OLD-C','OLDC','2025-10-27','2026-10-26',8000,'TRY'),('old-under','a','c','i','p','b','pm','m','OLD-D','OLDD','2025-10-28','2026-10-27',5000,'TRY'),('old-free','a','c','i','p','b','pm','m','OLD-F','OLDF','2025-10-29','2026-10-28',0,'TRY'),('old-different','a','c','i','p','b','pm','m','OLD-X','OLDX','2025-10-30','2026-10-29',1000,'TRY'),('new-a1','a','c','i','p','b','pm','m','NEW-A1','NEWA1','2026-10-25','2027-10-24',6000,'TRY'),('new-a2','a','c','i','p','b','pm','m','NEW-A2','NEWA2','2026-10-26','2027-10-25',4000,'TRY'),('new-merged','a','c','i','p','b','pm','m','NEW-M','NEWM','2026-10-27','2027-10-26',15000,'TRY'),('new-under','a','c','i','p','b','pm','m','NEW-U','NEWU','2026-10-28','2027-10-27',10000,'TRY'),('new-free','a','c','i','p','b','pm','m','NEW-F','NEWF','2026-10-29','2027-10-28',0,'TRY'),('new-different','a','c2','i','p','b','pm','m','NEW-X','NEWX','2026-10-30','2027-10-29',1000,'TRY')",
  "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state,version) VALUES('r-a','a','old-a','m','CONTACT_PENDING',1),('r-b','a','old-b','m','CONTACT_PENDING',1),('r-c','a','old-c','m','CONTACT_PENDING',1),('r-under','a','old-under','m','CONTACT_PENDING',1),('r-free','a','old-free','m','CONTACT_PENDING',1),('r-different','a','old-different','m','CONTACT_PENDING',1),('r-cycle','a','new-a1','m','CONTACT_PENDING',1)",
  "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at) VALUES('initial','a','r-a',NULL,'CONTACT_PENDING','SYSTEM','GENERATED','2026-01-01T00:00:00.000Z')",
  "INSERT INTO agencies(id,status) VALUES('b','PROVISIONING')",
  "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m-b','b','u','OWNER','INVITED','foreign@test.test','2099-01-01T00:00:00.000Z')",
  "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c-b','b','INDIVIDUAL','Foreign Customer','Foreign','Customer','m-b')",
  "INSERT INTO insurers(id,agency_id,code,name) VALUES('i-b','b','I-B','Foreign Insurer')",
  "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b-b','b','B-B','Foreign Branch')",
  "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('p-b','b','i-b','b-b','P-B','Foreign Product')",
  "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pm-b','b','PM-B','Foreign Cash')",
  "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('new-foreign','b','c-b','i-b','p-b','b-b','pm-b','m-b','FOREIGN-NEW','FOREIGNNEW','2026-10-25','2027-10-24',10000,'TRY')",
].join(';');

function assertLinkConstraints(execute: (sql: string) => CommandResult) {
  const receiptSeed = execute(
    `INSERT INTO operation_receipts
       (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body)
     VALUES('op-base','a','u','m','renewal.policy_links.allocate','key-base','${'a'.repeat(64)}','COMPLETED',201,'{}'),
           ('op-different','a','u','m','renewal.policy_links.allocate','key-different','${'b'.repeat(64)}','COMPLETED',201,'{}'),
           ('op-correction','a','u','m','renewal.policy_links.allocate','key-correction','${'c'.repeat(64)}','COMPLETED',201,'{}')`,
  );
  expect(receiptSeed.status, `${receiptSeed.stdout}\n${receiptSeed.stderr}`).toBe(0);
  const validLinks = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-a1','a','r-a','new-a1',6000,'TRY','op-base','m'),('link-a2','a','r-a','new-a2',4000,'TRY','op-base','m'),('link-b-merged','a','r-b','new-merged',7000,'TRY','op-base','m'),('link-c-merged','a','r-c','new-merged',8000,'TRY','op-base','m'),('link-under','a','r-under','new-under',5000,'TRY','op-base','m'),('link-free','a','r-free','new-free',0,'TRY','op-base','m')",
  );
  expect(validLinks.status, `${validLinks.stdout}\n${validLinks.stderr}`).toBe(0);
  const mergedTotal = execute(
    "SELECT sum(allocated_new_premium_minor) AS total FROM renewal_policy_links WHERE agency_id='a' AND new_policy_id='new-merged' AND status='ACTIVE'",
  );
  expect(mergedTotal.status, `${mergedTotal.stdout}\n${mergedTotal.stderr}`).toBe(0);
  expect(mergedTotal.stdout).toContain('15000');

  const duplicate = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-a1-duplicate','a','r-a','new-a1',1,'TRY','op-base','m')",
  );
  expect(duplicate.status).not.toBe(0);
  const overflow = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-overflow','a','r-b','new-a1',1,'TRY','op-base','m')",
  );
  expect(overflow.status).not.toBe(0);
  const wrongCurrency = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-currency','a','r-b','new-a2',1,'USD','op-base','m')",
  );
  expect(wrongCurrency.status).not.toBe(0);
  const crossAgencyTarget = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-cross-agency','a','r-a','new-foreign',1,'TRY','op-base','m')",
  );
  expect(crossAgencyTarget.status).not.toBe(0);
  const selfLink = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-self','a','r-a','old-a',0,'TRY','op-base','m')",
  );
  expect(selfLink.status).not.toBe(0);
  const cyclicLink = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-cycle','a','r-cycle','old-a',0,'TRY','op-base','m')",
  );
  expect(cyclicLink.status).not.toBe(0);
  const missingDifferentCustomerReason = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-different-missing','a','r-different','new-different',1000,'TRY','op-base','m')",
  );
  expect(missingDifferentCustomerReason.status).not.toBe(0);
  const differentCustomerReason = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,different_policyholder_reason_code,allocation_operation_id,created_by_membership_id) VALUES('link-different','a','r-different','new-different',1000,'TRY','OWNER_REVIEWED_POLICYHOLDER_VARIANCE','op-different','m')",
  );
  expect(
    differentCustomerReason.status,
    `${differentCustomerReason.stdout}\n${differentCustomerReason.stderr}`,
  ).toBe(0);

  const supersede = execute(
    "UPDATE renewal_policy_links SET status='SUPERSEDED',superseded_at='2099-01-01T00:00:00.000Z',superseded_by_membership_id='m',supersede_reason_code='ALLOCATION_CORRECTED',superseded_operation_id='op-correction' WHERE id='link-a1'",
  );
  expect(supersede.status, `${supersede.stdout}\n${supersede.stderr}`).toBe(0);
  const replacement = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,supersedes_link_id,allocation_operation_id,created_by_membership_id) VALUES('link-a1-v2','a','r-a','new-a1',6000,'TRY','link-a1','op-correction','m')",
  );
  expect(replacement.status, `${replacement.stdout}\n${replacement.stderr}`).toBe(0);
  const oldLinkMutation = execute(
    "UPDATE renewal_policy_links SET allocated_new_premium_minor=1 WHERE id='link-a1'",
  );
  expect(oldLinkMutation.status).not.toBe(0);
  const oldLinkDelete = execute("DELETE FROM renewal_policy_links WHERE id='link-a1'");
  expect(oldLinkDelete.status).not.toBe(0);
  const activeRows = execute(
    "SELECT count(*) AS count FROM renewal_policy_links WHERE agency_id='a' AND renewal_id='r-a' AND new_policy_id='new-a1' AND status='ACTIVE'",
  );
  expect(activeRows.stdout).toContain('1');

  const wonComplete = execute(
    "UPDATE renewal_opportunities SET state='WON',closed_at='2099-01-01T00:00:00.000Z',closed_by_membership_id='m',version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id='r-a'",
  );
  const renewalTimestamps = execute(
    "SELECT created_at,updated_at FROM renewal_opportunities WHERE id='r-a'",
  );
  expect(
    wonComplete.status,
    `${wonComplete.stdout}\n${wonComplete.stderr}\n${renewalTimestamps.stdout}`,
  ).toBe(0);
  const wonMerge = execute(
    "UPDATE renewal_opportunities SET state='WON',closed_at='2099-01-01T00:00:00.000Z',closed_by_membership_id='m',version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id='r-b'",
  );
  expect(wonMerge.status, `${wonMerge.stdout}\n${wonMerge.stderr}`).toBe(0);
  const linkedOpenMergeSupersede = execute(
    "UPDATE renewal_policy_links SET status='SUPERSEDED',superseded_at='2099-01-02T00:00:00.000Z',superseded_by_membership_id='m',supersede_reason_code='ALLOCATION_REVIEW',superseded_operation_id='op-correction' WHERE id='link-c-merged'",
  );
  expect(linkedOpenMergeSupersede.status).not.toBe(0);
  const wonPremiumIncrease = execute(
    "UPDATE policies SET gross_premium_minor=12000,version=version+1,updated_at='2099-01-02T00:00:00.000Z' WHERE id='new-a1'",
  );
  expect(wonPremiumIncrease.status).not.toBe(0);
  const unsecuredWonReopen = execute(
    "UPDATE renewal_opportunities SET state='CONTACT_PENDING',closed_at=NULL,closed_by_membership_id=NULL,version=version+1,updated_at='2099-01-02T00:00:00.000Z' WHERE id='r-a'",
  );
  expect(unsecuredWonReopen.status).not.toBe(0);
  const unsecuredWonLinkChange = execute(
    "UPDATE renewal_policy_links SET status='SUPERSEDED',superseded_at='2099-01-02T00:00:00.000Z',superseded_by_membership_id='m',supersede_reason_code='UNSECURED_CHANGE',superseded_operation_id='op-correction' WHERE id='link-a1-v2'",
  );
  expect(unsecuredWonLinkChange.status).not.toBe(0);
  const unsecuredWonLinkInsert = execute(
    "INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id) VALUES('link-won-add','a','r-a','new-free',0,'TRY','op-base','m')",
  );
  expect(unsecuredWonLinkInsert.status).not.toBe(0);
  const linkedPremiumDecrease = execute(
    "UPDATE policies SET gross_premium_minor=4000,version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id='new-under'",
  );
  expect(linkedPremiumDecrease.status).not.toBe(0);
  const linkedCurrencyChange = execute(
    "UPDATE policies SET currency='USD',version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id='new-under'",
  );
  expect(linkedCurrencyChange.status).not.toBe(0);
  const wonPartial = execute(
    "UPDATE renewal_opportunities SET state='WON',closed_at='2099-01-01T00:00:00.000Z',closed_by_membership_id='m',version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id='r-under'",
  );
  expect(wonPartial.status).not.toBe(0);
}

function queryRows(stdout: string): string {
  const results = JSON.parse(stdout) as Array<{ success: boolean; results: unknown }>;
  return JSON.stringify(results.map(({ success, results: rows }) => ({ success, results: rows })));
}

describe('M3 migration 0012 RenewalPolicyLink', () => {
  it('clean-applies allocation/link constraints and reruns as a no-op', () => {
    const runner = createRunner('clean');
    try {
      const applied = runner.apply();
      expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
      const seeded = runner.execute(seed);
      expect(seeded.status, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
      const inventory = runner.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger') AND (name LIKE 'renewal_policy_link%' OR name LIKE 'renewal_won_%') ORDER BY name",
      );
      expect(inventory.status, `${inventory.stdout}\n${inventory.stderr}`).toBe(0);
      for (const name of [
        'renewal_policy_links',
        'renewal_policy_links_active_logical_uq',
        'renewal_policy_links_validate_insert',
        'renewal_policy_links_supersede_only',
        'renewal_policy_links_no_delete',
        'renewal_policy_links_won_premium_immutable',
        'renewal_policy_links_won_policy_insert_lock',
        'renewal_policy_links_won_policy_update_lock',
        'renewal_won_reopen_requires_correction_history',
        'renewal_won_links_required',
      ]) {
        expect(inventory.stdout).toContain(name);
      }
      assertLinkConstraints(runner.execute);
      const rerun = runner.apply();
      expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('upgrades 0011 data without loss and applies the link schema forward-only', () => {
    const runner = createRunner('upgrade');
    try {
      const applied = runner.apply();
      expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
      const seeded = runner.execute(seed);
      expect(seeded.status, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
      const preservationQuery = `SELECT (SELECT count(*) FROM agencies) AS agencies,
                (SELECT count(*) FROM customers) AS customers,
                (SELECT count(*) FROM policies) AS policies,
                (SELECT count(*) FROM renewal_opportunities) AS renewals,
                (SELECT count(*) FROM renewal_state_history) AS histories;
         SELECT id,type,display_name,first_name,last_name,company_title,assignee_membership_id,version
           FROM customers ORDER BY id;
         SELECT id,customer_id,policy_number,normalized_policy_number,start_date,end_date,
                gross_premium_minor,currency,version FROM policies ORDER BY id;
         SELECT id,expiring_policy_id,state,version,closed_at,loss_reason_id,void_reason_code
           FROM renewal_opportunities ORDER BY id;
         SELECT id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at
           FROM renewal_state_history ORDER BY id`;
      const beforeMigration = runner.execute(preservationQuery);
      expect(beforeMigration.status, `${beforeMigration.stdout}\n${beforeMigration.stderr}`).toBe(
        0,
      );
      runner.installLinkMigration();
      const upgraded = runner.apply();
      expect(upgraded.status, `${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
      const preserved = runner.execute(preservationQuery);
      expect(preserved.status, `${preserved.stdout}\n${preserved.stderr}`).toBe(0);
      expect(queryRows(preserved.stdout)).toEqual(queryRows(beforeMigration.stdout));
      assertLinkConstraints(runner.execute);
      const rerun = runner.apply();
      expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  }, 180_000);
});
