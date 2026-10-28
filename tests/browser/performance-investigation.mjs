/* global performance */
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { profileDatabase } from './performance-database.mjs';
import { seedPerformanceDataset } from './performance-dataset.mjs';
const label = process.argv[2] ?? 'before';
await mkdir('performance-evidence', { recursive: true });
const start = performance.now();
const database = [];
const preview = await openOperationalPreview({
  nativeRuntime: !label.startsWith('before'),
  instrumentDatabase: (db) => profileDatabase(db, database),
});
const startup = performance.now() - start;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const samples = [];
try {
  const counts = await seedPerformanceDataset(preview.demo.db, Number(process.argv[3] ?? 10));
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await context.request.post(preview.origin + '/api/auth/login', {
    headers: { origin: preview.origin },
    data: { email: preview.users[0].email, password: preview.passwords[0] },
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(preview.origin);
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  const routes = [
    ['/today-work', 'Bugünkü İşler'],
    ['/customers', 'Müşteriler'],
    ['/customers/demo-customer-0', 'Deniz Yılmaz'],
    ['/policies', 'Poliçe portföyü'],
    ['/policies/demo-policy-0', 'DEMO-0'],
    ['/personnel', 'Personel ve İzinler'],
    ['/catalogs', 'Kataloglar'],
    ['/agency-settings', 'Acente Ayarları'],
  ];
  for (let round = 0; round < 5; round++)
    for (const [path, heading] of routes) {
      const requests = [];
      const pending = new Set();
      let lastActivity = performance.now();
      const request = (r) => {
        if (r.url().includes('/api/')) {
          pending.add(r);
          lastActivity = performance.now();
        }
      };
      const response = async (r) => {
        if (!r.url().includes('/api/')) return;
        await r.finished();
        const timing = r.request().timing();
        requests.push({
          path: new URL(r.url()).pathname,
          status: r.status(),
          duration: timing.responseEnd,
          start: timing.startTime,
        });
        pending.delete(r.request());
        lastActivity = performance.now();
      };
      page.on('request', request);
      page.on('response', response);
      const t = performance.now();
      const dbStart = database.length;
      const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics;
      const link = page.locator(`a[href="${path}"]`).first();
      const navigationKind = (await link.count()) ? 'spa' : 'document';
      if (navigationKind === 'spa') await link.click();
      else await page.goto(preview.origin + path);
      await page.waitForURL((u) => u.pathname === path);
      await page
        .getByRole('heading', { name: heading, exact: true })
        .first()
        .waitFor({ timeout: 30000 });
      const visual = performance.now() - t;
      if (path === '/policies') {
        // A page response can precede React's authorized customer-name fan-out.
        // Network quiet alone must not attribute those child reads to the next route.
        await page.locator('tbody tr').first().waitFor({ timeout: 60000 });
        await page
          .getByText('Müşteri yükleniyor…', { exact: true })
          .first()
          .waitFor({ state: 'hidden', timeout: 60000 });
      }
      do {
        await page.waitForTimeout(100);
      } while (
        performance.now() - t < 30000 &&
        (requests.length === 0 || pending.size > 0 || performance.now() - lastActivity < 500)
      );
      const elapsed = lastActivity - t;
      assert.ok(requests.length > 0 && pending.size === 0, path + ' completed API requests');
      assert.ok(
        requests.every((r) => r.status < 500),
        path + ' no server errors',
      );
      const metricsAfter = (await cdp.send('Performance.getMetrics')).metrics;
      const metrics = Object.fromEntries(
        metricsAfter
          .filter((m) =>
            ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(
              m.name,
            ),
          )
          .map((m) => [
            m.name,
            (m.value - (metricsBefore.find((b) => b.name === m.name)?.value ?? 0)) * 1000,
          ]),
      );
      samples.push({
        round,
        path,
        visual,
        settled: elapsed,
        usable: Math.max(visual, elapsed),
        navigationKind,
        cumulativeMetricsValid: navigationKind === 'spa',
        requests,
        metrics,
        database: database.slice(dbStart),
      });
      console.info(
        round,
        path,
        Math.round(elapsed),
        requests.map((x) => `${x.path}:${Math.round(x.duration)}`).join(' '),
      );
      page.off('request', request);
      page.off('response', response);
      await writeFile(
        `performance-evidence/${label}.json`,
        JSON.stringify({ startup, counts, samples }, null, 2),
      );
    }
} finally {
  await browser.close();
  await preview.close();
}
