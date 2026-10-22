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
import { historicalMigrationBytes } from './support/migration-git-bytes';
const root = process.cwd();
const migration = '0019_m4_internal_document_validation.sql';
const files = readdirSync('db/migrations')
  .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= 19)
  .sort();
const seed = `INSERT INTO agencies(id,status) VALUES('internal-agency','PROVISIONING');
INSERT INTO users(id,status) VALUES('internal-user','INACTIVE');
INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('internal-member','internal-agency','internal-user','OWNER','INVITED','synthetic@example.test','2099-01-01T00:00:00.000Z');
INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('internal-customer','internal-agency','INDIVIDUAL','Synthetic','Synthetic','Customer','internal-member');
INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id) VALUES('internal-document','internal-agency','CUSTOMER','internal-customer','internal-user','internal-member');
INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id) VALUES('internal-version','internal-agency','internal-document',1,'quarantine/00000000-0000-4000-8000-000000000019','${'a'.repeat(64)}',369,'synthetic.pdf','application/pdf','internal-user','internal-member');`;
const ok = (r: ReturnType<typeof spawnSync>) =>
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
describe('0019 forward structural acceptance', () => {
  it.each(['clean', 'upgrade'] as const)(
    'real local Wrangler %s apply, preserved seed, strict acceptance and rerun no-op',
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'mayi-internal-migration-'));
      try {
        const migrations = join(directory, 'migrations');
        mkdirSync(migrations);
        const config = join(directory, 'wrangler.json');
        writeFileSync(
          config,
          JSON.stringify({
            name: 'mayi-internal-migration',
            compatibility_date: '2026-09-01',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'internal-local',
                database_id: '00000000-0000-0000-0000-000000000019',
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
        const sql = (s: string) => run(['d1', 'execute', 'DB', '--command', s, '--json']);
        for (const n of files.filter((n) => mode === 'clean' || n !== migration))
          copyFileSync(resolve('db/migrations', n), join(migrations, n));
        ok(apply());
        ok(sql(seed));
        const proof = `SELECT id,agency_id,type,display_name FROM customers;SELECT id,type,status,permission_version FROM agency_memberships;SELECT id,status,sha256,object_key FROM document_versions;SELECT * FROM document_scan_evidence`;
        const before = sql(proof);
        ok(before);
        if (mode === 'upgrade') {
          copyFileSync(resolve('db/migrations', migration), join(migrations, migration));
          ok(apply());
          const after = sql(proof);
          ok(after);
          expect(
            JSON.parse(String(after.stdout)).map((v: { results: unknown }) => v.results),
          ).toEqual(JSON.parse(String(before.stdout)).map((v: { results: unknown }) => v.results));
        }
        const accept = (result: string) =>
          `UPDATE document_versions SET status='BACKUP_PENDING',validation_version='m4-content-inspection-v1',validation_result='${result}' WHERE id='internal-version'`;
        expect(sql(accept('{"valid":true,"format":"PDF","pageCount":1}')).status).not.toBe(0);
        ok(
          sql(
            `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256) VALUES('internal-backup','internal-agency','DOCUMENT_BACKUP','internal-version','${'a'.repeat(64)}')`,
          ),
        );
        for (const result of [
          'null',
          '{"valid":true,"format":"PDF","pageCount":0}',
          '{"valid":true,"format":"PNG","width":1,"height":1,"pixelCount":1,"decompressedBytes":1}',
          '{"valid":true,"format":"PDF","pageCount":1,"vba":true}',
        ])
          expect(sql(accept(result)).status).not.toBe(0);
        ok(sql(accept('{"valid":true,"format":"PDF","pageCount":1}')));
        expect(
          sql(
            `UPDATE document_versions SET validation_result='{"valid":true,"format":"PDF","pageCount":2}' WHERE id='internal-version'`,
          ).status,
        ).not.toBe(0);
        expect(
          sql("UPDATE document_versions SET status='AVAILABLE' WHERE id='internal-version'").status,
        ).not.toBe(0);
        const state = sql(
          `SELECT status,validation_version FROM document_versions WHERE id='internal-version';SELECT count(*) AS count FROM document_scan_evidence;PRAGMA foreign_key_check`,
        );
        ok(state);
        const result = JSON.parse(String(state.stdout));
        expect(result[0].results).toEqual([
          { status: 'BACKUP_PENDING', validation_version: 'm4-content-inspection-v1' },
        ]);
        expect(result[1].results).toEqual([{ count: 0 }]);
        expect(result[2].results).toEqual([]);
        const again = apply();
        ok(again);
        expect(`${again.stdout}\n${again.stderr}`).toContain('No migrations to apply');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180000,
  );
  it('keeps accepted 0000–0018 SQL/snapshots and the prior journal entries byte-identical', () => {
    for (const dir of ['db/migrations', 'db/migrations/meta'])
      for (const n of readdirSync(dir).filter(
        (n) => /^\d{4}_/u.test(n) && Number(n.slice(0, 4)) <= 18,
      )) {
        const committed = spawnSync(
          'git',
          ['show', `5d71586a0a18189b726b55f7899fd5d5dd55d3fd:${dir}/${n}`],
          { cwd: root },
        );
        expect(committed.status).toBe(0);
        expect(historicalMigrationBytes(root, `${dir}/${n}`)).toEqual(committed.stdout);
      }
    const old = spawnSync(
      'git',
      ['show', '5d71586a0a18189b726b55f7899fd5d5dd55d3fd:db/migrations/meta/_journal.json'],
      { cwd: root, encoding: 'utf8' },
    );
    ok(old);
    const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8'));
    const prefix = JSON.parse(String(old.stdout)).entries;
    expect(journal.entries.slice(0, prefix.length)).toEqual(prefix);
    expect(journal.entries[prefix.length].tag).toBe('0019_m4_internal_document_validation');
  });
});
