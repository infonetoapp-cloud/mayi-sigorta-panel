// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
function config(text: string) {
  return JSON.parse(text.replace(/\/\/[^\n]*/g, '').replace(/,\s*([}\]])/g, '$1'));
}
it('preserves existing bindings and declares only a private Free SQLite KDF class in source', () => {
  const current = config(readFileSync('wrangler.jsonc', 'utf8'));
  const before = config(
    execFileSync('git', ['show', 'e1c93f6cbb4552961d042da250fb8cf371f38c62:wrangler.jsonc'], {
      encoding: 'utf8',
    }),
  );
  expect(current.durable_objects.bindings).toEqual([
    { name: 'PASSWORD_KDF', class_name: 'PasswordKdfDurableObject' },
  ]);
  expect(current.migrations).toEqual([
    { tag: 'password-kdf-v2', new_sqlite_classes: ['PasswordKdfDurableObject'] },
  ]);
  expect(current.env.foundation.durable_objects).toEqual(current.durable_objects);
  for (const key of [
    'workers_dev',
    'preview_urls',
    'vars',
    'd1_databases',
    'r2_buckets',
    'queues',
    'triggers',
    'ratelimits',
  ])
    expect(current[key]).toEqual(before[key]);
  expect(current.workers_dev).toBe(false);
  expect(current.preview_urls).toBe(false);
  expect(current.vars.DOCUMENTS_ENABLED).toBe('false');
  const migration = readFileSync('db/migrations/0020_local_authentication.sql', 'utf8');
  expect(migration.includes('`verifier` text NOT NULL')).toBe(true);
  expect(
    migration ===
      execFileSync(
        'git',
        [
          'show',
          'e1c93f6cbb4552961d042da250fb8cf371f38c62:db/migrations/0020_local_authentication.sql',
        ],
        { encoding: 'utf8' },
      ).replace(/\r\n/g, '\n') ||
      migration.replace(/\r\n/g, '\n') ===
        execFileSync(
          'git',
          [
            'show',
            'e1c93f6cbb4552961d042da250fb8cf371f38c62:db/migrations/0020_local_authentication.sql',
          ],
          { encoding: 'utf8' },
        ),
  ).toBe(true);
});
it('keeps derivation out of HTTP composition and DO has no storage or logging', () => {
  for (const name of ['routes.ts', 'personnel.ts', 'password-do-adapter.ts']) {
    const code = readFileSync('src/server/auth/' + name, 'utf8');
    expect(code.includes('productionPasswordHasher')).toBe(false);
    expect(code.includes('node:crypto')).toBe(false);
    expect(code.includes('password-admin')).toBe(false);
    expect(code.includes('password-scrypt')).toBe(false);
  }
  const object = readFileSync('src/server/auth/password-do.ts', 'utf8');
  expect(object.includes('.storage')).toBe(false);
  expect(object.includes('console.')).toBe(false);
  expect(object.includes('fetch(')).toBe(false);
});
