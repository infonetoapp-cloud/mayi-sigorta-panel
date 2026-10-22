// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { historicalMigrationHash } from './support/migration-git-bytes';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
const root = resolve(__dirname, '..'),
  wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
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
};
describe('M2-T04 migration 0007', () => {
  it('preserves hashes 0000-0006', () => {
    for (const [f, h] of Object.entries(hashes)) expect(historicalMigrationHash(root, f)).toBe(h);
  });
  it('upgrades 0006 to 0007, preserves prior seeds, clean-applies and reruns no-op', () => {
    for (const mode of ['upgrade', 'clean'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `m2t04-${mode}-`)),
        migs = join(dir, 'migrations'),
        state = join(dir, 'state'),
        config = join(dir, 'wrangler.jsonc');
      mkdirSync(migs);
      mkdirSync(state);
      const old = Object.keys(hashes);
      for (const f of mode === 'upgrade'
        ? old
        : [...old, readdirSync(resolve(root, 'db/migrations')).find((f) => f.startsWith('0007_'))!])
        copyFileSync(resolve(root, 'db/migrations', f), join(migs, f));
      writeFileSync(
        config,
        JSON.stringify({
          name: 'm2t04-migration',
          compatibility_date: '2026-09-16',
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'm2t04',
              database_id: '00000000-0000-0000-0000-000000000027',
              migrations_dir: migs,
            },
          ],
        }),
      );
      const run = (a: string[]) =>
        spawnSync(process.execPath, [wrangler, ...a, '--config', config], {
          cwd: root,
          encoding: 'utf8',
        });
      const apply = () =>
        run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
      try {
        let r = apply();
        expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
        if (mode === 'upgrade') {
          const seed = run([
            'd1',
            'execute',
            'DB',
            '--local',
            '--persist-to',
            state,
            '--command',
            "INSERT INTO agencies(id,status)VALUES('a','PROVISIONING');INSERT INTO users(id,status)VALUES('u','INACTIVE');INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)VALUES('m','a','u','OWNER','INVITED','x@y.zz','2099-01-01Z');INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)VALUES('c','a','INDIVIDUAL','Seed','S','E','m');INSERT INTO insurers(id,agency_id,code,name)VALUES('i','a','I','Seed Insurer');",
          ]);
          expect(seed.status, seed.stderr).toBe(0);
          const f = readdirSync(resolve(root, 'db/migrations')).find((x) => x.startsWith('0007_'))!;
          copyFileSync(resolve(root, 'db/migrations', f), join(migs, f));
          r = apply();
          expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
          const q = run([
            'd1',
            'execute',
            'DB',
            '--local',
            '--persist-to',
            state,
            '--command',
            "SELECT display_name FROM customers WHERE id='c';SELECT name FROM insurers WHERE id='i';SELECT name FROM sqlite_master WHERE type='table' AND name='policies';",
            '--json',
          ]);
          expect(q.status, q.stderr).toBe(0);
          expect(q.stdout).toContain('Seed');
          expect(q.stdout).toContain('policies');
        }
        r = apply();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('No migrations to apply');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 180_000);
  it('has no Drizzle schema drift', () => {
    expect(execSync('npx drizzle-kit generate', { cwd: root, encoding: 'utf8' })).toContain(
      'No schema changes',
    );
  });
});
