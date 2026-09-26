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
const targetMigration = migrationFiles.find((file) => file.startsWith('0013_'));
if (!targetMigration) throw new Error('M3 communications migration 0013 is missing.');
const migrationsThrough0013 = migrationFiles.filter((file) => Number(file.slice(0, 4)) <= 13);

function createRunner(mode: 'clean' | 'upgrade') {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const dir = mkdtempSync(join(tmpdir(), `m3-migration-0013-${mode}-`));
  const migrations = join(dir, 'migrations');
  const state = join(dir, 'state');
  const config = join(dir, 'wrangler.jsonc');
  mkdirSync(migrations);
  mkdirSync(state);
  const initial =
    mode === 'clean'
      ? migrationsThrough0013
      : migrationsThrough0013.filter((name) => name !== targetMigration);
  for (const file of initial)
    copyFileSync(resolve(root, 'db/migrations', file), join(migrations, file));
  writeFileSync(
    config,
    JSON.stringify({
      name: `m3-migration-0013-${mode}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: `m3-migration-0013-${mode}`,
          database_id: '00000000-0000-0000-0000-000000000113',
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
    installTarget: () =>
      copyFileSync(
        resolve(root, 'db/migrations', targetMigration!),
        join(migrations, targetMigration!),
      ),
    execute: (sql: string): CommandResult =>
      run(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', sql, '--json']),
  };
}

const seed = [
  "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING')",
  "INSERT INTO users(id,status) VALUES('u','INACTIVE')",
  "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','u@test.test','2099-01-01T00:00:00.000Z')",
  "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,company_title,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Individual A','A','Customer',NULL,'m'),('co','a','COMPANY','Company A',NULL,NULL,'Company A','m')",
  "INSERT INTO company_contacts(id,agency_id,customer_id,first_name,last_name,role,status) VALUES('cc','a','co','Alex','Contact','Manager','ACTIVE')",
  "INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Insurer')",
  "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Branch')",
  "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('p','a','i','b','P','Product')",
  "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pm','a','PM','Cash')",
  "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('old-i','a','c','i','p','b','pm','m','OLD-I','OLDI','2025-10-25','2026-10-24',10000,'TRY'),('old-c','a','co','i','p','b','pm','m','OLD-C','OLDC','2025-10-25','2026-10-24',10000,'TRY'),('new-i','a','c','i','p','b','pm','m','NEW-I','NEWI','2026-10-25','2027-10-24',10000,'TRY')",
  "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state,version) VALUES('r-i','a','old-i','m','CONTACT_PENDING',1),('r-c','a','old-c','m','CONTACT_PENDING',1)",
  "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at) VALUES('history-i','a','r-i',NULL,'CONTACT_PENDING','SYSTEM','GENERATED','2026-01-01T00:00:00.000Z')",
].join(';');

function expectSuccess(result: CommandResult): void {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function queryRows(stdout: string): string {
  const results = JSON.parse(stdout) as Array<{ success: boolean; results: unknown }>;
  return JSON.stringify(results.map(({ success, results: rows }) => ({ success, results: rows })));
}

describe('M3 migration 0013 renewal communications', () => {
  it('clean applies and reruns as a no-op with the new immutable evidence tables', () => {
    const runner = createRunner('clean');
    try {
      expectSuccess(runner.apply());
      expectSuccess(runner.execute(seed));
      const inventory = runner.execute(
        `SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN
         ('renewal_quotes','renewal_quote_versions','renewal_quote_events','renewal_interactions')`,
      );
      expectSuccess(inventory);
      expect(inventory.stdout).toContain('4');
      const rerun = runner.apply();
      expectSuccess(rerun);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('upgrades 0012 data without changing prior Renewal, Policy, link, or history evidence', () => {
    const runner = createRunner('upgrade');
    try {
      expectSuccess(runner.apply());
      expectSuccess(runner.execute(seed));
      const receiptParents = runner.execute(
        `SELECT
           (SELECT count(*) FROM agencies WHERE id='a') AS agency,
           (SELECT count(*) FROM users WHERE id='u') AS user,
           (SELECT count(*) FROM agency_memberships WHERE id='m' AND agency_id='a' AND user_id='u') AS membership`,
      );
      expectSuccess(receiptParents);
      expect(receiptParents.stdout).toContain('"agency": 1');
      expect(receiptParents.stdout).toContain('"user": 1');
      expect(receiptParents.stdout).toContain('"membership": 1');
      expectSuccess(
        runner.execute(
          `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
            status,response_status,response_body)
           VALUES('op-0012','a','u','m','renewal.policy_links.allocate','key-0012','${'a'.repeat(64)}',
             'COMPLETED',201,'{"operationId":"op-0012","reasonCode":"SEED","ownerRequired":false,"authorizedTargets":[],"links":[{"id":"link-i","renewalId":"r-i","newPolicyId":"new-i","allocatedNewPremiumMinor":10000,"currency":"TRY","differentPolicyholderReasonCode":null}],"supersededLinkIds":[]}');
           `,
        ),
      );
      expectSuccess(
        runner.execute(
          `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,created_by_membership_id)
           VALUES('link-i','a','r-i','new-i',10000,'TRY','op-0012','m')`,
        ),
      );
      const before = runner.execute(
        `SELECT (SELECT count(*) FROM customers) AS customers,
                (SELECT count(*) FROM policies) AS policies,
                (SELECT count(*) FROM renewal_opportunities) AS renewals,
                (SELECT count(*) FROM renewal_state_history) AS histories,
                (SELECT count(*) FROM renewal_policy_links) AS links,
                (SELECT id FROM renewal_policy_links WHERE id='link-i') AS link_id,
                (SELECT allocated_new_premium_minor FROM renewal_policy_links WHERE id='link-i') AS allocated`,
      );
      expectSuccess(before);
      runner.installTarget();
      expectSuccess(runner.apply());
      const after = runner.execute(
        `SELECT (SELECT count(*) FROM customers) AS customers,
                (SELECT count(*) FROM policies) AS policies,
                (SELECT count(*) FROM renewal_opportunities) AS renewals,
                (SELECT count(*) FROM renewal_state_history) AS histories,
                (SELECT count(*) FROM renewal_policy_links) AS links,
                (SELECT id FROM renewal_policy_links WHERE id='link-i') AS link_id,
                (SELECT allocated_new_premium_minor FROM renewal_policy_links WHERE id='link-i') AS allocated`,
      );
      expectSuccess(after);
      expect(queryRows(after.stdout)).toEqual(queryRows(before.stdout));
      const rerun = runner.apply();
      expectSuccess(rerun);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('enforces immutable sent versions, exact send/accept evidence, and CompanyContact context', () => {
    const runner = createRunner('clean');
    try {
      expectSuccess(runner.apply());
      expectSuccess(runner.execute(seed));
      expectSuccess(
        runner.execute(
          `INSERT INTO renewal_quotes(id,agency_id,renewal_id,status,version,created_by_user_id,created_by_membership_id)
           VALUES('q-i','a','r-i','DRAFT',1,'u','m');
           INSERT INTO renewal_quote_versions
           (id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,
            start_date,end_date,valid_until,gross_premium_minor,currency,created_by_user_id,created_by_membership_id)
           VALUES('qv-i','a','q-i',1,'i','p','b','pm','2026-10-25','2027-10-24',
             '2026-09-30T00:00:00.000Z',10000,'TRY','u','m');
           UPDATE renewal_quotes SET current_version_id='qv-i' WHERE id='q-i';
           INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
            status,response_status,response_body)
           VALUES('send-op','a','u','m','renewal.quote.send','send-key','${'b'.repeat(64)}',
             'COMPLETED',201,'{}');
           INSERT INTO renewal_quote_events
           (id,agency_id,quote_id,quote_version_id,event,operation_receipt_id,actor_user_id,actor_membership_id,occurred_at)
           VALUES('send-event','a','q-i','qv-i','SENT','send-op','u','m','2026-09-24T00:00:00.000Z');
           UPDATE renewal_quotes SET status='SENT',version=version+1 WHERE id='q-i'`,
        ),
      );
      const immutableVersion = runner.execute(
        "UPDATE renewal_quote_versions SET gross_premium_minor=1 WHERE id='qv-i'",
      );
      expect(immutableVersion.status).not.toBe(0);
      const sendWithoutEvidence = runner.execute(
        `INSERT INTO renewal_quotes(id,agency_id,renewal_id,status,version,created_by_user_id,created_by_membership_id)
         VALUES('q-no-evidence','a','r-i','DRAFT',1,'u','m');
         UPDATE renewal_quotes SET status='SENT' WHERE id='q-no-evidence'`,
      );
      expect(sendWithoutEvidence.status).not.toBe(0);
      const companyWithoutContact = runner.execute(
        `INSERT INTO renewal_interactions
         (id,agency_id,renewal_id,customer_id,outcome,channel,occurred_at,actor_user_id,actor_membership_id)
         VALUES('company-contact-missing','a','r-c','co','CONTACT_CONFIRMED','PHONE',
           '2026-09-24T00:00:00.000Z','u','m')`,
      );
      expect(companyWithoutContact.status).not.toBe(0);
      const validAttempt = runner.execute(
        `INSERT INTO renewal_interactions
         (id,agency_id,renewal_id,customer_id,company_contact_id,outcome,channel,occurred_at,actor_user_id,actor_membership_id)
         VALUES('company-attempt','a','r-c','co','cc','ATTEMPT_NO_RESPONSE','PHONE',
           '2026-09-24T01:00:00.000Z','u','m')`,
      );
      expectSuccess(validAttempt);
      const confirmed = runner.execute(
        `INSERT INTO renewal_interactions
         (id,agency_id,renewal_id,customer_id,outcome,channel,occurred_at,actor_user_id,actor_membership_id)
         VALUES('individual-confirmed','a','r-i','c','CONTACT_CONFIRMED','PHONE',
           '2026-09-24T02:00:00.000Z','u','m')`,
      );
      expectSuccess(confirmed);
      const semantics = runner.execute(
        `SELECT outcome,company_contact_id FROM renewal_interactions ORDER BY id`,
      );
      expectSuccess(semantics);
      expect(semantics.stdout).toContain('ATTEMPT_NO_RESPONSE');
      expect(semantics.stdout).toContain('CONTACT_CONFIRMED');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  }, 180_000);
});
