// Local-only functional integration gate. No deploy, remote APIs or existing evidence overwrite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const directory = resolve(
  'node_modules/.cache/functional-rc',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(directory, { recursive: true });
const files = [
  'tests/customer-everyday.api.test.ts',
  'tests/customer-notes.api.test.ts',
  'tests/policy-forms.api.test.ts',
  'tests/policy-browsing.api.test.ts',
  'tests/task-context.api.test.ts',
  'tests/task-statistics.api.test.ts',
  'tests/renewal-terminal-task-identity.api.test.ts',
  'tests/renewal-quotes-modern.api.test.ts',
  'tests/renewal-terminal-modern.api.test.ts',
  'tests/renewal-won-create.api.test.ts',
  'tests/auth.personnel.test.ts',
  'tests/auth.personnel-retry.test.ts',
  'tests/ux003-money-input.test.ts',
  'tests/policy-portfolio-model.test.ts',
  'tests/policy-portfolio.ui.test.tsx',
  'tests/policy-pages.ui.test.tsx',
  'tests/policy-forms.ui.test.tsx',
  'tests/operational-dashboard.ui.test.tsx',
  'tests/dashboard-task-dates.api.test.ts',
  'tests/personnel-onboarding.ui.test.tsx',
  'tests/auth.standalone-reauth.test.tsx',
];
const formatFiles = [
  'scripts/verify-functional-rc.mjs',
  'scripts/demo/operational-preview.mjs',
  'index.html',
  'src/app/components/PersonnelPanel.tsx',
  'src/app/pages/OverviewPage.tsx',
  'src/app/pages/dashboard',
  'src/app/pages/policies/PolicyListPage.tsx',
  'src/app/pages/policies/PolicyDetailPage.tsx',
  'src/app/pages/policies/PolicyForm.tsx',
  'src/app/pages/policies/PolicyFormPage.tsx',
  'src/app/pages/policies/policy-portfolio.ts',
  'src/app/pages/policies/policy-portfolio.css',
  'src/server/tasks/service.ts',
  'src/server/tasks/validation.ts',
  'tests/policy-browsing.api.test.ts',
  'tests/policy-pages.ui.test.tsx',
  'tests/dashboard-task-dates.api.test.ts',
  'tests/operational-dashboard.ui.test.tsx',
  'tests/personnel-onboarding.ui.test.tsx',
  'tests/policy-portfolio-model.test.ts',
  'tests/policy-portfolio.ui.test.tsx',
  'tests/auth.standalone-reauth.test.tsx',
  'tests/browser/app-shell.smoke.mjs',
  'tests/browser/today-work.smoke.mjs',
  'tests/browser/task-operations.walkthrough.mjs',
  'tests/browser/renewal-interactions.walkthrough.mjs',
  'tests/browser/functional-business.smoke.mjs',
  'tests/browser/operational-dashboard.smoke.mjs',
  'tests/browser/policy-portfolio.smoke.mjs',
  'tests/browser/personnel-onboarding.smoke.mjs',
];
const steps = [];
function bin(name, command = name) {
  const base = resolve('node_modules', name);
  const manifest = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[command];
  assert.equal(typeof entry, 'string', 'Missing explicit package binary: ' + command);
  return resolve(base, entry);
}
function run(name, entry, args = [], evidence) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: { ...process.env, ...(evidence ? { MAYI_ACCEPTANCE_EVIDENCE_DIR: evidence } : {}) },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // Real D1 authorization/race suites can exceed 20 minutes in serial mode.
    timeout: 3600000,
  });
  writeFileSync(resolve(directory, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  steps.push({ name, exitCode: result.status, completed: !result.error && result.status === 0 });
  writeFileSync(resolve(directory, 'progress.json'), JSON.stringify({ steps, files }, null, 2));
  assert(!result.error && result.status === 0, name + ' failed; inspect its retained local log');
  console.info('PASS ' + name);
}
try {
  run('typecheck', bin('typescript', 'tsc'), ['--noEmit']);
  run('lint', bin('eslint'), ['.']);
  run('format', bin('prettier'), ['--check', ...formatFiles]);
  run('client-build', bin('vite'), ['build']);
  run('worker-dry-run', bin('wrangler'), ['deploy', '--dry-run', '--outdir', 'dist/server']);
  run('boundaries', 'scripts/verify-boundaries.ts');
  run('vitest', bin('vitest'), [
    'run',
    ...files,
    '--maxWorkers=1',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=' + resolve(directory, 'vitest.json'),
  ]);
  const tests = JSON.parse(readFileSync(resolve(directory, 'vitest.json'), 'utf8'));
  assert.equal(tests.testResults.length, files.length);
  assert.equal(tests.numFailedTests, 0);
  assert.equal(tests.numPendingTests, 0);
  run(
    'business-browser',
    'tests/browser/functional-business.smoke.mjs',
    [],
    resolve(directory, 'business'),
  );
  run(
    'personnel-browser',
    'tests/browser/personnel-onboarding.smoke.mjs',
    [],
    resolve(directory, 'personnel'),
  );
  const business = JSON.parse(
    readFileSync(resolve(directory, 'business/integrated-business-results.json'), 'utf8'),
  );
  const personnel = JSON.parse(
    readFileSync(resolve(directory, 'personnel/browser-results.json'), 'utf8'),
  );
  assert.equal(business.status, 'PASS');
  assert.equal(business.passed.length, 8);
  assert.equal(personnel.status, 'PASS_LOCAL_ONLY');
  assert.equal(personnel.groups.length, 12);
  const summary = {
    status: 'LOCAL_FUNCTIONAL_RC_PASS_NOT_PRODUCTION',
    files: files.length,
    passed: tests.numPassedTests,
    failed: tests.numFailedTests,
    skipped: tests.numPendingTests,
    businessGroups: business.passed.length,
    personnelGroups: personnel.groups.length,
    steps,
  };
  writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.info(JSON.stringify(summary));
} catch {
  process.exitCode = 1;
  console.error('FUNCTIONAL_RC_GATE_FAILED: local logs retained; no readiness claim.');
} finally {
  console.info('FUNCTIONAL_RC_EVIDENCE ' + directory);
}
