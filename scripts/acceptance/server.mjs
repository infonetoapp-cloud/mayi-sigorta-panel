import console from 'node:console';
import process from 'node:process';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { demoCertificate, serveDemo } from '../demo/https-server.mjs';
const directory = resolve('node_modules/.cache/acceptance');
await mkdir(directory, { recursive: true });
const bundle = resolve(directory, 'application.mjs');
await build({
  entryPoints: ['scripts/demo/application.ts'],
  outfile: bundle,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'silent',
});
const { openDemo, DEMO_USERS } = await import(pathToFileURL(bundle).href);
const passwords = DEMO_USERS.map(() => randomBytes(24).toString('hex'));
const demo = await openDemo(passwords),
  tls = await demoCertificate();
const server = await serveDemo(demo, tls);
await writeFile(
  resolve(directory, 'accounts.json'),
  JSON.stringify(DEMO_USERS.map((u, i) => ({ email: u.email, password: passwords[i] }))),
  { mode: 0o600 },
);
console.info(
  'ACCEPTANCE_READY https://localhost:8443; isolated in-memory D1; real application APIs',
);
process.once('SIGINT', async () => {
  await server.close();
  await demo.dispose();
  await tls.dispose();
  process.exit(0);
});
