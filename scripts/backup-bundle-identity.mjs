import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
const sources = [
  'src/server/d1-backup/core.ts',
  'src/server/d1-backup/diagnostic.ts',
  'src/server/d1-backup/provider.ts',
  'src/server/d1-backup/scheduler.ts',
  'src/server/d1-backup/worker.ts',
  'wrangler.backup.json',
  'package-lock.json',
  'scripts/backup-bundle-identity.mjs',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries(sources.map((path) => [path, sha(readFileSync(path))]));
const [first, second] = process.argv.slice(2);
if (!first || !second) throw new Error('Provide two dry-run output directories');
const bundleSha256 = sha(readFileSync(join(first, 'worker.js')));
const repeatedBundleSha256 = sha(readFileSync(join(second, 'worker.js')));
if (bundleSha256 !== repeatedBundleSha256) throw new Error('NONDETERMINISTIC_BUNDLE');
console.info(
  JSON.stringify(
    {
      version: 'mayi-backup-build-identity-v1',
      wrangler: JSON.parse(readFileSync('node_modules/wrangler/package.json', 'utf8')).version,
      node: process.version,
      sourceHashes,
      sourceIdentitySha256: sha(JSON.stringify(sourceHashes)),
      bundleSha256,
      repeatedBundleSha256,
      reproducible: true,
    },
    null,
    2,
  ),
);
