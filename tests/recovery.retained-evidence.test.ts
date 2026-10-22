// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const directory = 'docs/recovery/evidence/2026-10-22';
it('disables Git text conversion only for immutable recovery evidence', () => {
  const files = ['query-result.json', 'independent-absence.json', 'closeout.json', 'manifest.json'];
  const result = spawnSync(
    'git',
    [
      'check-attr',
      'text',
      '--',
      ...files.map((file) => join(directory, file).replaceAll('\\', '/')),
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(files.length);
  for (const line of result.stdout.trim().split(/\r?\n/))
    expect(line.endsWith(': text: unset')).toBe(true);
});
it('retains standard whitespace checks while recognizing immutable CRLF evidence', () => {
  const result = spawnSync(
    'git',
    ['check-attr', 'whitespace', '--', join(directory, 'manifest.json').replaceAll('\\', '/')],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  expect(
    result.stdout
      .trim()
      .endsWith(': whitespace: blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol'),
  ).toBe(true);
});
it('preserves the exact historical provider receipt bytes without credentials or backup SQL', () => {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
    kind: string;
    files: Array<{ path: string; sha256: string }>;
  };
  expect(manifest.kind).toBe('HISTORICAL_RECEIPTS_ONLY_NO_AUTHORITY');
  expect(manifest.files.map((file) => file.path).sort()).toEqual([
    'closeout.json',
    'independent-absence.json',
    'query-result.json',
  ]);
  for (const file of manifest.files) {
    const bytes = readFileSync(join(directory, file.path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    expect(new TextDecoder().decode(bytes)).not.toMatch(
      /Bearer\s|INSERT INTO|CREATE TABLE|"(?:token|password|verifier|headers)"/i,
    );
  }
});
it('keeps SQL recovery success separate from native-import failure and production acceptance', () => {
  const restored = JSON.parse(readFileSync(join(directory, 'query-result.json'), 'utf8'));
  const absent = JSON.parse(readFileSync(join(directory, 'independent-absence.json'), 'utf8'));
  const closed = JSON.parse(readFileSync(join(directory, 'closeout.json'), 'utf8'));
  expect(restored).toMatchObject({
    code: 'REMOTE_QUERY_VERIFIED_SEALED',
    snapshot: { tables: 46, rows: 114, migrations: 23, foreignKeyViolations: 0 },
    apiAuthorization: 'NOT_EXECUTED',
  });
  expect(absent).toMatchObject({
    uuid: restored.uuid,
    exactGet404: true,
    completeInventoryAbsent: true,
    deleteRetried: false,
  });
  expect(closed).toMatchObject({
    uuid: restored.uuid,
    historicalImportFailure: 'PRESERVED_D1_RESET_DO',
    productionRpoRto: 'NOT_CLAIMED',
    remoteFaultInjection: 'NOT_EXECUTED',
    providerManagedStagingAbsence: 'NOT_PROVEN',
  });
});
