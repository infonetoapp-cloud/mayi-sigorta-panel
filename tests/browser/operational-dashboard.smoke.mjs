// Real local UI/auth/API/D1. No external origin or resource provisioning.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
let preview,
  browser,
  stage = 'setup';
const results = [];
try {
  await mkdir('dashboard-evidence', { recursive: true });
  preview = await openOperationalPreview();
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  for (const [index, user] of preview.users.entries())
    for (const width of [1440, 768, 360]) {
      stage = `${index}-${width}`;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 1000 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const issues = [];
      const urls = [];
      page.on('pageerror', () => issues.push('runtime'));
      page.on('console', (m) => {
        if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
          issues.push('csp');
      });
      page.on('request', (r) => {
        const u = new globalThis.URL(r.url());
        if (u.pathname.startsWith('/api/')) urls.push(u.pathname + u.search);
      });
      const login = await context.request.post(preview.origin + '/api/auth/login', {
        headers: { origin: preview.origin },
        data: { email: user.email, password: preview.passwords[index] },
      });
      assert.equal(login.status(), 200);
      await page.goto(preview.origin + '/');
      await page.getByRole('link', { name: /Geciken görevler: / }).waitFor();
      await page.getByRole('heading', { name: 'Yaklaşan poliçe vadeleri', exact: true }).waitFor();
      assert(urls.includes('/api/tasks/statistics?view=' + (index === 0 ? 'team' : 'self')));
      if (index !== 0) {
        assert.equal(
          urls.some((u) => u.includes('view=team')),
          false,
        );
        assert.equal(
          await page.getByRole('button', { name: 'Atanmamış takipler', exact: true }).count(),
          0,
        );
      }
      await page.getByRole('button', { name: 'Tüm takipler', exact: true }).click();
      await page.locator('#renewal-followups .dashboard-records a').first().waitFor();
      const first = await page
        .locator('#renewal-followups .dashboard-records a')
        .first()
        .getAttribute('href');
      assert(first.includes('task=') && first.includes('queue=WORK'));
      const geometry = await page.evaluate(() => ({
        overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth + 1,
        columns: globalThis
          .getComputedStyle(globalThis.document.querySelector('.dashboard-panels'))
          .gridTemplateColumns.split(' ').length,
      }));
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.columns, width <= 1000 ? 1 : 2);
      assert.deepEqual(issues, []);
      await page.screenshot({
        path: `dashboard-evidence/dashboard-${index}-${width}.png`,
        fullPage: true,
      });
      await page.locator('#renewal-followups .dashboard-records a').first().click();
      await page.waitForURL('**/today-work?**task=**');
      await page.getByRole('heading', { name: /Bugünkü İşler/ }).waitFor();
      await page.goto(preview.origin + '/');
      await page.getByRole('button', { name: '30 günlük vadeler', exact: true }).click();
      await page.getByRole('link', { name: 'Bu aralıktaki poliçeleri aç', exact: true }).click();
      await page.waitForURL('**/policies?**endFrom=**');
      assert.equal(new globalThis.URL(page.url()).searchParams.get('status'), 'ACTIVE');
      await page.getByRole('heading', { name: 'Poliçeler', exact: true }).waitFor();
      results.push({
        actor: user.id,
        width,
        realLogin: true,
        authorizedSummary: true,
        followupDeepLink: true,
        expirationFilteredLink: true,
        ...geometry,
        runtimeCspErrors: issues.length,
      });
      await context.close();
    }
  await writeFile(
    'dashboard-evidence/browser-results.json',
    JSON.stringify({ mode: 'REAL_LOCAL_SYNTHETIC_APP_ONLY', results }, null, 2),
  );
  console.info(JSON.stringify({ status: 'PASS', cells: results.length }));
} catch (error) {
  console.error(
    'DASHBOARD_BROWSER_FAILED',
    stage,
    error instanceof Error ? error.message : 'unknown',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await preview?.close();
}
