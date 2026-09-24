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
const migrationsThrough0011 = migrationFiles.filter((file) => Number(file.slice(0, 4)) <= 11);
const terminalMigration = migrationsThrough0011.find((file) => file.startsWith('0011_'));
if (!terminalMigration) throw new Error('M3 terminal evidence migration 0011 is missing.');

function createRunner(mode: 'clean' | 'upgrade') {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const dir = mkdtempSync(join(tmpdir(), `m3-migration-0011-${mode}-`));
  const migrations = join(dir, 'migrations');
  const state = join(dir, 'state');
  const config = join(dir, 'wrangler.jsonc');
  mkdirSync(migrations);
  mkdirSync(state);
  for (const file of mode === 'clean'
    ? migrationsThrough0011
    : migrationsThrough0011.filter((name) => name !== terminalMigration)) {
    copyFileSync(resolve(root, 'db/migrations', file), join(migrations, file));
  }
  writeFileSync(
    config,
    JSON.stringify({
      name: `m3-migration-0011-${mode}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: `m3-migration-0011-${mode}`,
          database_id: '00000000-0000-0000-0000-000000000111',
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
  const apply = () => run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
  const execute = (sql: string, json = false): CommandResult =>
    run([
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      state,
      '--command',
      sql,
      ...(json ? ['--json'] : []),
    ]);
  return { apply, execute, migrations, state, dir };
}

const seed = [
  "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING')",
  "INSERT INTO users(id,status) VALUES('u','INACTIVE')",
  "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','u@test.test','2099-01-01T00:00:00.000Z')",
  "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Seed','S','E','m')",
  "INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Insurer')",
  "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Branch')",
  "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('p','a','i','b','P','Product')",
  "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pm','a','PM','Cash')",
  "INSERT INTO loss_reasons(id,agency_id,code,name,status,version) VALUES('lr-other','a','OTHER','Other','ACTIVE',1),('lr-price','a','PRICE','Price','ACTIVE',1)",
  "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('pol','a','c','i','p','b','pm','m','POL-1','POL1','2026-01-01','2026-10-24',10000,'TRY')",
  "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state,version) VALUES('r','a','pol','m','CONTACT_PENDING',1)",
  "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at) VALUES('initial','a','r',NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')",
].join(';');

function assertTerminalHistoryInvariants(execute: (sql: string, json?: boolean) => CommandResult) {
  const lost = execute(
    "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at,loss_reason_id,loss_reason_notes) VALUES('lost','a','r','CONTACT_PENDING','LOST','USER','u','m','LOST','2026-09-24T06:01:00.000Z','lr-other','Retained OTHER explanation')",
  );
  expect(lost.status, `${lost.stdout}\n${lost.stderr}`).toBe(0);
  const preserved = execute(
    "SELECT loss_reason_id,loss_reason_notes,void_reason_code FROM renewal_state_history WHERE id='lost'",
    true,
  );
  expect(preserved.status, `${preserved.stdout}\n${preserved.stderr}`).toBe(0);
  expect(preserved.stdout).toContain('Retained OTHER explanation');
  expect(preserved.stdout).toContain('lr-other');

  const validVoid = execute(
    "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at,void_reason_code) VALUES('voided','a','r','CONTACT_PENDING','VOIDED','USER','u','m','DUPLICATE','2026-09-24T06:02:00.000Z','DUPLICATE')",
  );
  expect(validVoid.status, `${validVoid.stdout}\n${validVoid.stderr}`).toBe(0);

  const missingLostEvidence = execute(
    "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at) VALUES('lost-missing','a','r','CONTACT_PENDING','LOST','USER','u','m','LOST','2026-09-24T06:03:00.000Z')",
  );
  expect(missingLostEvidence.status).not.toBe(0);
  const commercialVoid = execute(
    "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at,void_reason_code) VALUES('void-commercial','a','r','CONTACT_PENDING','VOIDED','USER','u','m','PRICE','2026-09-24T06:04:00.000Z','PRICE')",
  );
  expect(commercialVoid.status).not.toBe(0);
  const noteOnNonOther = execute(
    "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at,loss_reason_id,loss_reason_notes) VALUES('lost-price-note','a','r','CONTACT_PENDING','LOST','USER','u','m','LOST','2026-09-24T06:05:00.000Z','lr-price','Must not appear for catalog reason')",
  );
  expect(noteOnNonOther.status).not.toBe(0);
  const foreignReason = execute(
    "INSERT INTO agencies(id,status) VALUES('foreign','PROVISIONING'); INSERT INTO loss_reasons(id,agency_id,code,name,status,version) VALUES('foreign-reason','foreign','OTHER','Other','ACTIVE',1)",
  );
  expect(foreignReason.status, `${foreignReason.stdout}\n${foreignReason.stderr}`).toBe(0);
  const crossAgencyReason = execute(
    "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,actor_membership_id,reason_code,created_at,loss_reason_id,loss_reason_notes) VALUES('cross-agency-reason','a','r','CONTACT_PENDING','LOST','USER','u','m','LOST','2026-09-24T06:06:00.000Z','foreign-reason','Not allowed')",
  );
  expect(crossAgencyReason.status).not.toBe(0);
  const deleteReferencedReason = execute("DELETE FROM loss_reasons WHERE id='lr-other'");
  expect(deleteReferencedReason.status).not.toBe(0);
  const rewriteReferencedReason = execute(
    "UPDATE loss_reasons SET code='OTHER_RENAMED' WHERE id='lr-other'",
  );
  expect(rewriteReferencedReason.status).not.toBe(0);
  const mutateEvidence = execute(
    "UPDATE renewal_state_history SET loss_reason_notes='changed' WHERE id='lost'",
  );
  expect(mutateEvidence.status).not.toBe(0);
  const deleteEvidence = execute("DELETE FROM renewal_state_history WHERE id='lost'");
  expect(deleteEvidence.status).not.toBe(0);
}

describe('M3 migration 0011 terminal outcome evidence', () => {
  it('clean-applies, validates terminal reason evidence, and reruns as a no-op', () => {
    const runner = createRunner('clean');
    try {
      const applied = runner.apply();
      expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
      const seeded = runner.execute(seed);
      expect(seeded.status, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
      assertTerminalHistoryInvariants(runner.execute);
      const rerun = runner.apply();
      expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  });

  it('upgrades from 0010 without changing existing history and preserves seed rows', () => {
    const runner = createRunner('upgrade');
    try {
      const applied = runner.apply();
      expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
      const seeded = runner.execute(seed);
      expect(seeded.status, `${seeded.stdout}\n${seeded.stderr}`).toBe(0);
      const before = runner.execute(
        "SELECT count(*) AS renewals FROM renewal_opportunities WHERE id='r'; SELECT count(*) AS history FROM renewal_state_history WHERE id='initial'",
        true,
      );
      expect(before.status, `${before.stdout}\n${before.stderr}`).toBe(0);
      copyFileSync(
        resolve(root, 'db/migrations', terminalMigration),
        join(runner.migrations, terminalMigration),
      );
      const upgrade = runner.apply();
      expect(upgrade.status, `${upgrade.stdout}\n${upgrade.stderr}`).toBe(0);
      const preserved = runner.execute(
        "SELECT loss_reason_id,loss_reason_notes,void_reason_code FROM renewal_state_history WHERE id='initial'; SELECT count(*) AS renewals FROM renewal_opportunities WHERE id='r'",
        true,
      );
      expect(preserved.status, `${preserved.stdout}\n${preserved.stderr}`).toBe(0);
      expect(preserved.stdout).toContain('"renewals": 1');
      expect(preserved.stdout).toMatch(/"loss_reason_id"\s*:\s*null/);
      assertTerminalHistoryInvariants(runner.execute);
    } finally {
      rmSync(runner.dir, { recursive: true, force: true });
    }
  });
});
