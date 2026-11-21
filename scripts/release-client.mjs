import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { info, error } from 'node:console';

const root = resolve(import.meta.dirname, '..');
const client = resolve(root, 'dist/client');
const receipt = resolve(root, 'dist/client-release.json');
const sourceDirectories = ['src', 'public', 'db/migrations'];
const sourceFiles = [
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'wrangler.jsonc',
  'scripts/release-client.mjs',
];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fileHash = (path) => sha256(readFileSync(path));
const entries = (paths, base) =>
  Object.fromEntries(
    paths.sort().map((path) => [relative(base, path).split(sep).join('/'), fileHash(path)]),
  );

function descend(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const child = join(directory, item.name);
    if (item.isDirectory()) return descend(child);
    if (!item.isFile()) throw new Error('Release inputs must be regular files.');
    return child;
  });
}
function readSource() {
  const paths = [
    ...sourceDirectories.flatMap((path) => descend(resolve(root, path))),
    ...sourceFiles.map((path) => resolve(root, path)),
  ];
  return sha256(JSON.stringify(entries(paths, root)));
}
function readOutput(directory) {
  const content = entries(descend(directory), directory);
  const html = readFileSync(join(directory, 'index.html'), 'utf8');
  const references = Array.from(
    html.matchAll(/(?:src|href)="\/(assets\/[^"?#]+)"/g),
    (match) => match[1],
  );
  if (
    !references.some((path) => path.endsWith('.js')) ||
    !references.some((path) => path.endsWith('.css')) ||
    references.some((path) => !content[path])
  ) {
    throw new Error('Release HTML references a missing client entry.');
  }
  return { hash: sha256(JSON.stringify(content)), files: Object.keys(content).length, references };
}

try {
  const [mode, assetDirectory, ...extra] = process.argv.slice(2);
  if (!['build', 'verify'].includes(mode) || extra.length || (mode === 'build' && assetDirectory))
    throw new Error('Usage: release-client.mjs build | verify [asset directory]');
  if (mode === 'build') {
    const before = readSource();
    const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (build.status !== 0) throw new Error('Client build failed.');
    if (before !== readSource()) throw new Error('Release source changed during build.');
    const summary = { source: before, bundle: readOutput(client) };
    writeFileSync(receipt, JSON.stringify(summary, null, 2) + '\n');
    info(JSON.stringify(summary));
  } else {
    const expected = JSON.parse(readFileSync(receipt, 'utf8'));
    const actual = {
      source: readSource(),
      bundle: readOutput(assetDirectory ? resolve(assetDirectory) : client),
    };
    if (actual.source !== expected.source || actual.bundle.hash !== expected.bundle.hash)
      throw new Error('Release source or built assets differ from the verified receipt.');
    info(JSON.stringify(actual));
  }
} catch (cause) {
  error(cause instanceof Error ? cause.message : 'Release verification failed.');
  process.exitCode = 1;
}
