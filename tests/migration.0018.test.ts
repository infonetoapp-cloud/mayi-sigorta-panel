// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const migration = '0018_document_backup_terminal_failure.sql';
const root = process.cwd();
const files = readdirSync('db/migrations')
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const seed = `
INSERT INTO agencies(id,status) VALUES('backup-seed-agency','PROVISIONING');
INSERT INTO users(id,status) VALUES('backup-seed-user','INACTIVE');
INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
VALUES('backup-seed-member','backup-seed-agency','backup-seed-user','OWNER','INVITED','synthetic@example.test','2099-01-01T00:00:00.000Z');
INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
VALUES('backup-seed-customer','backup-seed-agency','INDIVIDUAL','Synthetic','Synthetic','Customer','backup-seed-member');
INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id)
VALUES('backup-seed-document','backup-seed-agency','CUSTOMER','backup-seed-customer','backup-seed-user','backup-seed-member');
INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id)
VALUES('backup-seed-version','backup-seed-agency','backup-seed-document',1,'quarantine/00000000-0000-4000-8000-000000000018','${'a'.repeat(64)}',128,'synthetic.pdf','application/pdf','backup-seed-user','backup-seed-member');
INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
VALUES('backup-seed-job','backup-seed-agency','DOCUMENT_BACKUP','backup-seed-version','${'a'.repeat(64)}');
INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
VALUES('scan-seed-job','backup-seed-agency','DOCUMENT_SCAN','backup-seed-version','${'a'.repeat(64)}');
`;

function localRunner(directory: string) {
  const migrations = join(directory, 'migrations');
  mkdirSync(migrations);
  const config = join(directory, 'wrangler.json');
  writeFileSync(
    config,
    JSON.stringify({
      name: 'mayi-migration-backup-local',
      compatibility_date: '2026-09-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'backup-local',
          database_id: '00000000-0000-0000-0000-000000000018',
          migrations_dir: migrations,
        },
      ],
    }),
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        ...args,
        '--config',
        config,
        '--local',
        '--persist-to',
        join(directory, 'state'),
      ],
      { cwd: root, encoding: 'utf8', timeout: 120000 },
    );
  const apply = () => run(['d1', 'migrations', 'apply', 'DB']);
  const execute = (sql: string) => run(['d1', 'execute', 'DB', '--command', sql, '--json']);
  return { migrations, apply, execute };
}
function success(result: ReturnType<typeof spawnSync>) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}
function claimAndFail(jobId: string, code: string, runId: string) {
  return `UPDATE background_jobs SET status='RUNNING',attempt_count=1,lease_token_hash='${'b'.repeat(64)}',lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+150 seconds') WHERE id='${jobId}';
INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash) VALUES('${runId}','backup-seed-agency','${jobId}',1,'${'b'.repeat(64)}');
UPDATE background_job_runs SET status='PERMANENT_ERROR',reason_code='${code}',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${runId}';`;
}
function dead(jobId: string, code: string) {
  return `UPDATE background_jobs SET status='DEAD',last_error_code='${code}',lease_token_hash=NULL,lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${jobId}'`;
}

describe('0018 local forward-only backup terminal guard', () => {
  it('clean apply and rerun no-op preserve scan semantics, FK and immutable backup protections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mayi-backup-clean-'));
    try {
      const runner = localRunner(directory);
      for (const name of files)
        copyFileSync(resolve('db/migrations', name), join(runner.migrations, name));
      success(runner.apply());
      success(runner.execute(seed));
      success(
        runner.execute(claimAndFail('scan-seed-job', 'BACKUP_CHECKSUM_MISMATCH', 'scan-seed-run')),
      );
      expect(runner.execute(dead('scan-seed-job', 'BACKUP_CHECKSUM_MISMATCH')).status).not.toBe(0);
      success(runner.execute(claimAndFail('backup-seed-job', 'UNKNOWN_CODE', 'backup-seed-run')));
      expect(runner.execute(dead('backup-seed-job', 'UNKNOWN_CODE')).status).not.toBe(0);
      const integrity = runner.execute('PRAGMA foreign_key_check');
      success(integrity);
      expect(JSON.parse(String(integrity.stdout))[0].results).toEqual([]);
      const guard = runner.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'document_backup_copies_%'",
      );
      success(guard);
      expect(
        JSON.parse(String(guard.stdout))[0]
          .results.map((row: { name: string }) => row.name)
          .sort(),
      ).toEqual([
        'document_backup_copies_immutable_delete',
        'document_backup_copies_immutable_update',
        'document_backup_copies_insert_guard',
      ]);
      const again = runner.apply();
      success(again);
      expect(`${again.stdout}\n${again.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180000);
  it('0017 upgrade preserves exact rows and fixes the proven early permanent backup failure gap', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mayi-backup-upgrade-'));
    try {
      const runner = localRunner(directory);
      for (const name of files.filter((name) => name !== migration))
        copyFileSync(resolve('db/migrations', name), join(runner.migrations, name));
      success(runner.apply());
      success(runner.execute(seed));
      success(
        runner.execute(
          claimAndFail('backup-seed-job', 'BACKUP_CHECKSUM_MISMATCH', 'backup-seed-run'),
        ),
      );
      const prior = runner.execute(dead('backup-seed-job', 'BACKUP_CHECKSUM_MISMATCH'));
      expect(prior.status).not.toBe(0);
      expect(`${prior.stdout}\n${prior.stderr}`).toContain('BACKGROUND_JOB_DEAD_ATTEMPT_REQUIRED');
      const snapshotSql =
        'SELECT * FROM customers; SELECT * FROM agency_memberships; SELECT * FROM documents; SELECT * FROM document_versions; SELECT * FROM background_jobs; SELECT * FROM background_job_runs; SELECT * FROM document_scan_evidence; SELECT * FROM document_backup_copies';
      const before = runner.execute(snapshotSql);
      success(before);
      copyFileSync(resolve('db/migrations', migration), join(runner.migrations, migration));
      success(runner.apply());
      const after = runner.execute(snapshotSql);
      success(after);
      const rows = (output: unknown) =>
        (JSON.parse(String(output)) as Array<{ results: unknown }>).map((result) => result.results);
      expect(rows(after.stdout)).toEqual(rows(before.stdout));
      success(runner.execute(dead('backup-seed-job', 'BACKUP_CHECKSUM_MISMATCH')));
      const state = runner.execute(
        "SELECT status,attempt_count FROM background_jobs WHERE id='backup-seed-job'",
      );
      success(state);
      expect(JSON.parse(String(state.stdout))[0].results).toEqual([
        { status: 'DEAD', attempt_count: 1 },
      ]);
      const again = runner.apply();
      success(again);
      expect(`${again.stdout}\n${again.stderr}`).toContain('No migrations to apply');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180000);
  it('does not edit any accepted 0000–0017 SQL or metadata snapshot', () => {
    for (const name of files.filter((name) => name !== migration)) {
      const committed = spawnSync(
        'git',
        ['show', `81c21f2dcedaedf360b7c8597e60630742576e8d:db/migrations/${name}`],
        { cwd: root },
      );
      expect(committed.status).toBe(0);
      expect(readFileSync(resolve('db/migrations', name))).toEqual(committed.stdout);
    }
    for (const name of readdirSync('db/migrations/meta').filter((name) =>
      /^00(?:0[0-9]|1[0-7])_snapshot\.json$/u.test(name),
    )) {
      const committed = spawnSync(
        'git',
        ['show', `81c21f2dcedaedf360b7c8597e60630742576e8d:db/migrations/meta/${name}`],
        { cwd: root },
      );
      expect(committed.status).toBe(0);
      expect(readFileSync(resolve('db/migrations/meta', name))).toEqual(committed.stdout);
    }
  });
});
