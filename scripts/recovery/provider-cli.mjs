// Default is offline. --live plus fresh interactive consent is a separate gate.
import { build } from 'esbuild';
import { readFileSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let liveStarted = false;
try {
  const args = process.argv.slice(2);
  if (
    args.length &&
    !(
      args[0] === '--options' &&
      typeof args[1] === 'string' &&
      (args.length === 2 || (args.length === 3 && args[2] === '--live'))
    )
  )
    throw Error('PROVIDER_CLI_ARGUMENTS_INVALID');
  process.chdir(root);
  mkdirSync('dist/recovery', { recursive: true });
  const outfile = resolve('dist/recovery/provider.mjs');
  await build({
    entryPoints: ['scripts/recovery/provider-runner.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
    plugins: [
      {
        name: 'bounded-decoder-entry',
        setup(api) {
          api.onResolve({ filter: /ordered-d1-import(?:\.ts)?$/ }, () => ({
            path: pathToFileURL(resolve(root, 'scripts/recovery/ordered-d1-import.ts')).href,
            external: true,
          }));
        },
      },
    ],
  });
  const tool = await import(pathToFileURL(outfile).href);
  let options = {};
  if (args.length) {
    const stat = lstatSync(args[1]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
      throw Error('OPTIONS_FILE_DENIED');
    options = JSON.parse(readFileSync(args[1], 'utf8'));
  }
  let wire;
  if (args[2] === '--live') {
    if (options.mode !== 'EXECUTE_REMOTE') throw Error('LIVE_MODE_REQUIRED');
    const plan = tool.providerPlan(options);
    // Separate task approval remains an operator prerequisite; the JSON file
    // and this flag alone cannot mint a capability or touch credentials.
    const operations =
      plan.descriptor.restoreTransport === 'QUERY_BATCH'
        ? 'CREATE FOUR_QUERY_BATCHES RECONCILE CLEANUP SEALED'
        : 'CREATE TWO_UPLOADS RECONCILE CLEANUP SEALED';
    const challenge = `OWNER AUTHORIZE ${plan.descriptor.accountId}/${plan.descriptor.name} ${plan.planSha256} ${operations}`;
    const permit = await tool.confirmLiveProvider(plan.planSha256, challenge);
    wire = tool.liveProviderWire(
      permit,
      plan.planSha256,
      process.env.CLOUDFLARE_API_TOKEN ?? '',
      plan.descriptor.uploadTransport,
    );
    liveStarted = true;
  }
  const result = await tool.runProviderRecovery(options, wire);
  console.info(JSON.stringify(result));
  if (
    ![
      'OFFLINE_DRY_RUN',
      'SIMULATED_PROVIDER_VERIFIED_SEALED',
      'REMOTE_PROVIDER_VERIFIED_SEALED',
      'PROVIDER_CLEANED',
    ].includes(result.code)
  )
    process.exitCode = 1;
} catch {
  console.error(
    JSON.stringify({
      code: 'PROVIDER_CLI_DENIED',
      remoteOperations: liveStarted ? 'UNKNOWN' : 0,
      publication: 'SEALED',
    }),
  );
  process.exitCode = 1;
}
