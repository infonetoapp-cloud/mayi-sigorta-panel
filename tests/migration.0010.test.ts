// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(__dirname, '..');
const migrationFiles = readdirSync(resolve(root, 'db/migrations'))
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .sort();
const migrationsThrough0010 = migrationFiles.filter((file) => Number(file.slice(0, 4)) <= 10);
function getLatestMigration(): string {
  const file = migrationFiles.find((name) => name.startsWith('0010_'));
  if (!file) throw new Error('M3 migration 0010 is missing.');
  return file;
}

function runMigrationAcceptance(mode: 'clean' | 'upgrade') {
  const latestMigration = getLatestMigration();
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const dir = mkdtempSync(join(tmpdir(), `m3-migration-0010-${mode}-`));
  const migrations = join(dir, 'migrations');
  const state = join(dir, 'state');
  const config = join(dir, 'wrangler.jsonc');
  mkdirSync(migrations);
  mkdirSync(state);
  for (const file of mode === 'clean'
    ? migrationsThrough0010
    : migrationsThrough0010.filter((name) => name !== latestMigration)) {
    copyFileSync(resolve(root, 'db/migrations', file), join(migrations, file));
  }
  writeFileSync(
    config,
    JSON.stringify({
      name: `m3-migration-0010-${mode}`,
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: `m3-migration-0010-${mode}`,
          database_id: '00000000-0000-0000-0000-000000000110',
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
  try {
    let applied = apply();
    expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    if (mode === 'upgrade') {
      const seed = [
        "INSERT INTO agencies(id,status,bootstrap_completed_at,activated_at) VALUES('a','PROVISIONING',NULL,NULL)",
        "INSERT INTO users(id,status) VALUES('u','INACTIVE')",
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','u@test.test','2099-01-01T00:00:00.000Z')",
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Seed','S','E','m')",
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Insurer')",
        "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Branch')",
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('p','a','i','b','P','Product')",
        "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pm','a','PM','Cash')",
        "INSERT INTO agency_settings(id,agency_id,default_insurer_id) VALUES('s','a','i')",
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('pol','a','c','i','p','b','pm','m','POL-1','POL1','2026-01-01','2026-10-24',10000,'TRY')",
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
      copyFileSync(
        resolve(root, 'db/migrations', latestMigration),
        join(migrations, latestMigration),
      );
      applied = apply();
      expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
      const preserved = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "SELECT count(*) AS policies FROM policies WHERE id='pol'; SELECT count(*) AS customers FROM customers WHERE id='c'",
        '--json',
      ]);
      expect(preserved.status, `${preserved.stdout}\n${preserved.stderr}`).toBe(0);
      expect(preserved.stdout).toContain('"policies": 1');
      expect(preserved.stdout).toContain('"customers": 1');

      const inspect = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name IN ('renewal_opportunities','renewal_opportunities_expiring_policy_uq','renewal_opportunities_assignee_state_idx','renewal_state_history_no_update','system_audit_events_no_update','tasks_open_renewal_followup_uq','tasks_renewal_customer_insert','policies_archive_open_renewal_guard','policies_terminal_status_open_renewal_guard','audit_event_records') ORDER BY name",
        '--json',
      ]);
      expect(inspect.status, `${inspect.stdout}\n${inspect.stderr}`).toBe(0);
      for (const name of [
        'renewal_opportunities',
        'renewal_opportunities_expiring_policy_uq',
        'renewal_opportunities_assignee_state_idx',
        'renewal_state_history_no_update',
        'system_audit_events_no_update',
        'tasks_open_renewal_followup_uq',
        'tasks_renewal_customer_insert',
        'policies_archive_open_renewal_guard',
        'policies_terminal_status_open_renewal_guard',
        'audit_event_records',
      ]) {
        expect(inspect.stdout).toContain(name);
      }

      const constrained = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state,version) VALUES('r','a','pol','m','CONTACT_PENDING',1); INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code) VALUES('h','a','r',NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING'); INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,status,actor_kind) VALUES('t','a','c','r','RENEWAL_FOLLOWUP','Follow up','2026-09-24T06:00:00.000Z','OPEN','SYSTEM'); INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code) VALUES('audit','a','renewal-generation','renewal.generate','renewal_opportunities','r','corr','gen-r','SUCCESS','POLICY_EXPIRING')",
      ]);
      expect(constrained.status, `${constrained.stdout}\n${constrained.stderr}`).toBe(0);

      const otherMembership = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO agencies(id,status) VALUES('other-agency','PROVISIONING'); INSERT INTO users(id,status) VALUES('other-user','INACTIVE'); INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at) VALUES('other-member','other-agency','other-user','OWNER','INVITED',1,'other@example.test','2099-01-01T00:00:00.000Z')",
      ]);
      expect(otherMembership.status, `${otherMembership.stdout}\n${otherMembership.stderr}`).toBe(
        0,
      );
      const crossAgencyAssignee = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "UPDATE renewal_opportunities SET assignee_membership_id='other-member' WHERE agency_id='a' AND id='r'",
      ]);
      expect(crossAgencyAssignee.status).not.toBe(0);
      expect(`${crossAgencyAssignee.stdout}\n${crossAgencyAssignee.stderr}`).toContain(
        'FOREIGN KEY',
      );

      const archiveWithOpenRenewal = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "UPDATE policies SET archived_at='2026-09-24T00:00:00.000Z',archived_by_membership_id='m',archive_reason='TEST' WHERE id='pol'",
      ]);
      expect(archiveWithOpenRenewal.status).not.toBe(0);
      expect(archiveWithOpenRenewal.stderr).toContain('POLICY_OPEN_DEPENDENCIES');

      const cancelWithOpenRenewal = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "UPDATE policies SET status='CANCELLED',version=version+1 WHERE id='pol'",
      ]);
      expect(cancelWithOpenRenewal.status).not.toBe(0);
      expect(cancelWithOpenRenewal.stderr).toContain('POLICY_OPEN_DEPENDENCIES');

      const view = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "SELECT actor_kind,actor_user_id,system_actor_code FROM audit_event_records WHERE id='audit'",
        '--json',
      ]);
      expect(view.status, `${view.stdout}\n${view.stderr}`).toBe(0);
      expect(view.stdout).toContain('SYSTEM');
      expect(view.stdout).toContain('renewal-generation');

      const duplicate = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,state,version) VALUES('r2','a','pol','CONTACT_PENDING',1)",
      ]);
      expect(duplicate.status).not.toBe(0);
      const duplicateTask = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,status,actor_kind) VALUES('t2','a','c','r','RENEWAL_FOLLOWUP','Follow up again','2026-09-24T06:00:00.000Z','OPEN','SYSTEM')",
      ]);
      expect(duplicateTask.status).not.toBe(0);
      const secondPolicy = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('pol2','a','c','i','p','b','pm','m','POL-2','POL2','2026-01-01','2026-12-31',10000,'TRY')",
      ]);
      expect(secondPolicy.status).toBe(0);
      const invalidVoid = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,state,closed_at,closed_by_membership_id,version,void_reason_code) VALUES('bad-void','a','pol2','VOIDED','2026-09-24T03:00:00.000Z','m',1,NULL)",
      ]);
      expect(invalidVoid.status).not.toBe(0);
      const invalidLost = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,state,closed_at,closed_by_membership_id,version,loss_reason_id) VALUES('bad-lost','a','pol2','LOST','2026-09-24T03:00:00.000Z','m',1,NULL)",
      ]);
      expect(invalidLost.status).not.toBe(0);
      const mismatch = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,status,actor_kind) VALUES('bad-task','a','other-customer','r','RENEWAL_FOLLOWUP','Follow up','2026-09-24T06:00:00.000Z','OPEN','SYSTEM')",
      ]);
      expect(mismatch.status).not.toBe(0);
      const immutable = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "UPDATE renewal_state_history SET reason_code='changed' WHERE id='h'",
      ]);
      expect(immutable.status).not.toBe(0);
      const auditImmutable = run([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--command',
        "DELETE FROM system_audit_events WHERE id='audit'",
      ]);
      expect(auditImmutable.status).not.toBe(0);
    }
    applied = apply();
    expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(applied.stdout).toContain('No migrations to apply');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('M3 migration 0010 renewal foundation', () => {
  it('clean-applies and reruns as a no-op', () => {
    runMigrationAcceptance('clean');
  });

  it('upgrades 0009 with seed preservation, constraints and immutable event evidence', () => {
    runMigrationAcceptance('upgrade');
  }, 180_000);
});
