import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const root = join(import.meta.dirname, '../..');
const outfile = join(root, 'dist/release-audit/verify-backup-readback.mjs');
const decoder = pathToFileURL(join(import.meta.dirname, 'ordered-d1-import.ts')).href;
mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(import.meta.dirname, 'verify-backup-readback.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  plugins: [
    {
      name: 'separate-local-decoder',
      setup(builder) {
        // The decoder spawns its own source file with a constrained Node child.
        builder.onResolve({ filter: /ordered-d1-import(?:\.ts)?$/ }, () => ({
          path: decoder,
          external: true,
        }));
      },
    },
  ],
});
process.chdir(root);
await import(pathToFileURL(outfile).href);
