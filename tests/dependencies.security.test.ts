// @vitest-environment node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import { historicalMigrationHash } from './support/migration-git-bytes';

it('pins compatible security patches without upgrading the accepted Wrangler/workerd generation', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  expect(manifest.dependencies.hono).toBe('4.13.11');
  expect(manifest.devDependencies.vite).toBe('8.3.3');
  expect(manifest.devDependencies.vitest).toBe('5.0.3');
  expect(manifest.devDependencies.wrangler).toBe('4.133.0');
  expect(manifest.overrides.miniflare).toEqual({ sharp: '0.35.5', undici: '7.29.1' });
  const packages = lock.packages as Record<string, { version?: string }>;
  for (const [name, entry] of Object.entries(packages)) {
    if (name.endsWith('/sharp')) expect(entry.version).toBe('0.35.5');
    if (name.endsWith('/undici')) expect(entry.version).toBe('7.29.1');
    if (name.endsWith('/@vitest/mocker')) expect(entry.version).toBe('5.0.3');
  }
  expect(packages['node_modules/miniflare']?.version).toBe('5.20260916.0-alpha');
  expect(packages['node_modules/workerd']?.version).toBe('1.20260916.1');
});
it('loads the patched native sharp/libvips and converts a bounded synthetic SVG', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
  );
  const output = await sharp(svg, { limitInputPixels: 16 }).png().toBuffer();
  const metadata = await sharp(output).metadata();
  expect(metadata.format).toBe('png');
  expect(metadata.width).toBe(2);
  expect(metadata.height).toBe(2);
});

it('preserves the exact historical Git-blob SHA while checking the current checkout filter', () => {
  expect(historicalMigrationHash(process.cwd(), '0000_good_hammerhead.sql')).toBe(
    'de803e199abed34fa71fde797260d7545367b979f9d09cac886826e4e3f95a5d',
  );
});
it('rejects a modified historical migration before accepting its committed hash', () => {
  const calls: string[][] = [];
  const path = 'db/migrations/0000_good_hammerhead.sql';
  const changed = execFileSync('git', ['hash-object', `--path=${path}`, '--stdin'], {
    input: Buffer.concat([readFileSync(path), Buffer.from('\n-- synthetic tamper probe\n')]),
  });
  expect(() =>
    historicalMigrationHash('.', '0000_good_hammerhead.sql', (args) => {
      calls.push(args);
      return args[0] === 'hash-object' ? changed : execFileSync('git', args);
    }),
  ).toThrow('HISTORICAL_MIGRATION_WORKTREE_DRIFT');
  expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'hash-object']);
});
it('rejects non-migration paths without reading Git or credential files', () => {
  let called = false;
  expect(() =>
    historicalMigrationHash('.', '../.env', () => {
      called = true;
      return Buffer.from('');
    }),
  ).toThrow('MIGRATION_FILENAME_DENIED');
  expect(called).toBe(false);
});
