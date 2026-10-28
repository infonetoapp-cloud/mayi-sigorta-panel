import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
import { seedPerformanceDataset } from './performance-dataset.mjs';
const label = process.argv[2] ?? 'after-operations';
const preview = await openOperationalPreview({ nativeRuntime: !label.startsWith('before') });
let browser;
const samples = [];
try {
  await mkdir('performance-evidence', { recursive: true });
  const counts = await seedPerformanceDataset(preview.demo.db, 15000);
  const renewal = await preview.demo.db
    .prepare("SELECT id FROM renewal_opportunities WHERE expiring_policy_id='demo-policy-0'")
    .first('id');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  assert.equal(
    (
      await context.request.post(preview.origin + '/api/auth/login', {
        headers: { origin: preview.origin },
        data: { email: preview.users[0].email, password: preview.passwords[0] },
      })
    ).status(),
    200,
  );
  const page = await context.newPage();
  async function measure(name, act, round) {
    const requests = [],
      pending = new Set();
    let activity = performance.now();
    const onRequest = (r) => {
      if (r.url().includes('/api/')) {
        pending.add(r);
        activity = performance.now();
      }
    };
    const onResponse = async (r) => {
      if (!r.url().includes('/api/')) return;
      await r.finished();
      pending.delete(r.request());
      activity = performance.now();
      requests.push({
        path: new URL(r.url()).pathname,
        status: r.status(),
        duration: r.request().timing().responseEnd,
      });
    };
    const failed = (r) => {
      pending.delete(r);
      activity = performance.now();
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfailed', failed);
    const start = performance.now();
    await act();
    do {
      await page.waitForTimeout(100);
    } while (
      performance.now() - start < 60000 &&
      (requests.length === 0 || pending.size || performance.now() - activity < 500)
    );
    assert.ok(requests.length > 0 && pending.size === 0, name + ' request completion');
    assert.ok(
      requests.every((r) => r.status < 500),
      name + ' no server errors',
    );
    const sample = { round, name, ms: activity - start, requests };
    samples.push(sample);
    console.info(round, name, Math.round(sample.ms), requests.length);
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', failed);
    await writeFile(
      `performance-evidence/${label}.json`,
      JSON.stringify({ counts, samples }, null, 2),
    );
  }
  for (let round = 0; round < 5; round++) {
    await measure('customers-open', () => page.goto(preview.origin + '/customers'), round);
    await page.getByLabel('Müşteri ara', { exact: true }).fill('Performans');
    await measure(
      'customer-search',
      () => page.getByRole('button', { name: 'Ara', exact: true }).click(),
      round,
    );
    await page.getByLabel('Müşteri türü', { exact: true }).selectOption('INDIVIDUAL');
    await measure(
      'customer-filter',
      () => page.getByRole('button', { name: 'Ara', exact: true }).click(),
      round,
    );
    await measure(
      'customer-pagination',
      () => page.getByRole('button', { name: 'Sonraki sayfa', exact: true }).click(),
      round,
    );
    await measure('policy-open', () => page.goto(preview.origin + '/policies'), round);
    await page.getByLabel('Poliçe numarası', { exact: true }).fill('PERF-000100');
    await measure(
      'policy-search',
      () => page.getByRole('button', { name: 'Filtrele', exact: true }).click(),
      round,
    );
    await measure(
      'customer-management',
      () => page.goto(preview.origin + '/customers/demo-customer-0/manage'),
      round,
    );
    await measure(
      'policy-edit',
      () => page.goto(preview.origin + '/policies/demo-policy-0/edit'),
      round,
    );
    await measure(
      'renewal-quotes',
      () =>
        page.goto(
          preview.origin +
            '/policies/demo-policy-0?section=renewal&renewal=' +
            encodeURIComponent(renewal),
        ),
      round,
    );
    await page.getByRole('heading', { name: 'DEMO-0', exact: true }).waitFor();
  }
} finally {
  await browser?.close();
  await preview.close();
}
