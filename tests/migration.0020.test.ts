// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const checkpoint = 'd4c386b0e825e88394cd401036144562cd5b105d';
const migration = '0020_local_authentication.sql';
const files = readdirSync('db/migrations')
  .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n <= migration)
  .sort();
const seed = `INSERT INTO agencies(id,status) VALUES('auth-upgrade','PROVISIONING');
INSERT INTO users(id,status) VALUES('auth-legacy','ACTIVE');
INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email) VALUES('auth-legacy-id','auth-legacy','https://historical.invalid','immutable-legacy-subject','legacy@example.invalid');
INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('auth-legacy-member','auth-upgrade','auth-legacy','OWNER','INVITED','legacy@example.invalid','2099-01-01T00:00:00.000Z');
UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id='auth-legacy-member';
UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',activated_at='2026-01-01T00:00:00.000Z',version=version+1 WHERE id='auth-upgrade';
INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('auth-legacy-sensitive','auth-legacy-member','sensitive.identity.read','UNSCOPED');
INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('auth-preserved-customer','auth-upgrade','INDIVIDUAL','Synthetic Customer','Synthetic','Customer','auth-legacy-member');`;
describe('0020 additive native D1 migration acceptance', () => {
  it.each(['fresh', '0019-upgrade'] as const)(
    '%s preserves historical identity, authorization and domain rows and reruns no-op',
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'mayi-auth-0020-'));
      try {
        const migrations = join(directory, 'migrations');
        mkdirSync(migrations);
        const config = join(directory, 'wrangler.json');
        writeFileSync(
          config,
          JSON.stringify({
            name: 'mayi-auth-migration-local',
            compatibility_date: '2026-09-01',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'auth-synthetic',
                database_id: '00000000-0000-4000-8000-000000000020',
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
            { encoding: 'utf8', timeout: 120000 },
          );
        const ok = (r: ReturnType<typeof run>) =>
          expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
        const apply = () => run(['d1', 'migrations', 'apply', 'DB']);
        const sql = (command: string) =>
          run(['d1', 'execute', 'DB', '--command', command, '--json']);
        for (const n of files.filter((n) => mode === 'fresh' || n !== migration))
          copyFileSync(resolve('db/migrations', n), join(migrations, n));
        ok(apply());
        ok(sql(seed));
        const proof =
          'SELECT id,user_id,issuer,subject,verified_email,status,version FROM auth_identities; SELECT id,agency_id,user_id,type,status,version,permission_version FROM agency_memberships; SELECT * FROM membership_permissions; SELECT * FROM customers; SELECT id,status,version FROM agencies';
        const before = sql(proof);
        ok(before);
        if (mode === '0019-upgrade') {
          copyFileSync(resolve('db/migrations', migration), join(migrations, migration));
          ok(apply());
        }
        const after = sql(proof);
        ok(after);
        const rows = (r: ReturnType<typeof run>) =>
          JSON.parse(r.stdout).map((p: { results: unknown }) => p.results);
        expect(rows(after)).toEqual(rows(before));
        const inventory = sql(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_credentials','local_sessions','credential_operation_receipts') ORDER BY name; SELECT email_provenance FROM auth_identities; SELECT count(*) n FROM local_credentials; PRAGMA foreign_key_check",
        );
        ok(inventory);
        expect(rows(inventory)).toEqual([
          [
            { name: 'credential_operation_receipts' },
            { name: 'local_credentials' },
            { name: 'local_sessions' },
          ],
          [{ email_provenance: 'LEGACY_EXTERNAL' }],
          [{ n: 0 }],
          [],
        ]);
        const again = apply();
        ok(again);
        expect(again.stdout).toContain('No migrations to apply');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180000,
  );
  it('keeps 39 historical SQL/snapshot files byte-identical and appends 0020 after the immutable journal prefix', () => {
    let count = 0;
    for (const dir of ['db/migrations', 'db/migrations/meta'])
      for (const n of readdirSync(dir).filter(
        (n) => /^\d{4}_/.test(n) && Number(n.slice(0, 4)) <= 19,
      )) {
        const committed = spawnSync('git', ['show', `${checkpoint}:${dir}/${n}`]);
        expect(committed.status).toBe(0);
        expect(readFileSync(resolve(dir, n))).toEqual(committed.stdout);
        count++;
      }
    expect(count).toBe(39);
    const old = spawnSync('git', ['show', `${checkpoint}:db/migrations/meta/_journal.json`], {
      encoding: 'utf8',
    });
    expect(old.status).toBe(0);
    const prefix = JSON.parse(old.stdout).entries;
    const entries = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8')).entries;
    expect(entries.slice(0, prefix.length)).toEqual(prefix);
    expect(entries[prefix.length]?.tag).toBe('0020_local_authentication');
  });
});
