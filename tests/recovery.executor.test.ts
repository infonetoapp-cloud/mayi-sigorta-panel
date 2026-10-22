// @vitest-environment node
import { expect, it } from 'vitest';
import { runRecovery } from '../scripts/recovery/executor';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('rejects remote execution before opening files or invoking any transport', async () => {
  const result = await runRecovery({ mode: 'EXECUTE_REMOTE' });
  expect(result.code).toBe('REMOTE_AUTHORIZATION_REQUIRED');
  expect(result.remoteOperations).toBe(0);
});

it('denies ATTACH at the internal local import boundary without touching another file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-ops001-attach-deny-'));
  const other = join(directory, 'other-synthetic.sqlite');
  const imported = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      'scripts/recovery/executor-import-local.mjs',
      join(directory, 'target.sqlite'),
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      input: JSON.stringify({
        sql: `ATTACH DATABASE '${other.replaceAll("'", "''")}' AS other;CREATE TABLE other.probe(id INTEGER);`,
        fault: 'none',
      }),
    },
  );
  expect(imported.status).toBe(1);
  expect(existsSync(other)).toBe(false);
});
