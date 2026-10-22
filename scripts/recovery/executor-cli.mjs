// Offline bootstrap only. Builds a local Node tool; never calls Wrangler/cloud APIs.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import process from 'node:process';
import console from 'node:console';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  const args = process.argv.slice(2);
  if (
    args.length &&
    !(args.length === 2 && ['--options', '--generate-synthetic'].includes(args[0]))
  )
    throw Error('CLI_ARGUMENTS_INVALID');
  process.chdir(root);
  const outdir = resolve('dist/recovery');
  mkdirSync(outdir, { recursive: true });
  const outfile = resolve(outdir, 'executor.mjs');
  await build({
    entryPoints: ['scripts/recovery/executor.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    // Keep the decoder's import.meta child entry narrow. Bundling the full CRM /
    // Miniflare graph into its 128MiB child would invalidate that resource cap.
    plugins: [
      {
        name: 'preserve-bounded-decoder-entry',
        setup(api) {
          api.onResolve({ filter: /ordered-d1-import(?:\.ts)?$/ }, () => ({
            path: pathToFileURL(resolve(root, 'scripts/recovery/ordered-d1-import.ts')).href,
            external: true,
          }));
        },
      },
    ],
    logLevel: 'silent',
  });
  const tool = await import(pathToFileURL(outfile).href);
  if (args[0] === '--generate-synthetic') {
    // Explicit local generation, separate from default read-only dry-run.
    const generated = await tool.retainSyntheticBundle(resolve(args[1]));
    console.info(
      JSON.stringify({
        code: 'LOCAL_SYNTHETIC_BUNDLE_RETAINED',
        remoteOperations: 0,
        ...generated,
      }),
    );
  } else {
    let options = {};
    if (args[0] === '--options') {
      const stat = lstatSync(args[1]);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw Error('OPTIONS_FILE_DENIED');
      options = JSON.parse(readFileSync(args[1], 'utf8'));
    }
    const result = await tool.runRecovery(options);
    console.info(JSON.stringify(result));
    if (
      !['OFFLINE_DRY_RUN', 'LOCAL_SIMULATION_VERIFIED_SEALED', 'LOCAL_SIMULATION_CLEANED'].includes(
        result.code,
      )
    )
      process.exitCode = 1;
  }
} catch {
  console.error(
    JSON.stringify({ code: 'OFFLINE_EXECUTOR_FAILED', remoteOperations: 0, publication: 'SEALED' }),
  );
  process.exitCode = 1;
}
