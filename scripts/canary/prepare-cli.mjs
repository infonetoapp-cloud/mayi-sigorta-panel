// LOCAL preparation only: no credentials, network, provider calls or deploy.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--resources' || args[2] !== '--out') throw Error();
  const resources = JSON.parse(readFileSync(resolve(args[1]), 'utf8'));
  const built = await build({
    entryPoints: ['scripts/canary/config.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
  );
  const closed = module.buildCanaryConfig(resources),
    proposed = module.buildCanaryConfig(resources, true),
    out = resolve(args[3]);
  mkdirSync(out, { recursive: true });
  const files = {
    'canary-crm.closed.json': closed.crm,
    'canary-leaf.closed.json': closed.leaf,
    'canary-crm.commissioned-PROPOSED.json': proposed.crm,
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(
      resolve(out, name),
      JSON.stringify(
        {
          ...value,
          main: resolve(value.main),
          ...('d1_databases' in value
            ? {
                d1_databases: value.d1_databases.map((d) => ({
                  ...d,
                  migrations_dir: resolve(d.migrations_dir),
                })),
              }
            : {}),
        },
        null,
        2,
      ),
    );
  console.info(
    JSON.stringify({
      mode: 'LOCAL_PREPARATION_ONLY',
      files: Object.keys(files),
      DOCUMENTS_ENABLED: 'false',
      remoteActions: 0,
      proposalIsNotAuthorization: true,
    }),
  );
} catch {
  console.error('CANARY_PREPARATION_DENIED');
  process.exitCode = 1;
}
