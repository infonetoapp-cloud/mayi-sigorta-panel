/* global document, getComputedStyle, localStorage, sessionStorage */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const out = 'modernization-evidence/browser';
const report = { checks: [], screens: [], layouts: [], errors: [] };
let preview, browser;
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    font: getComputedStyle(document.body).fontFamily,
    headings: document.querySelectorAll('h1').length,
  }));
  report.layouts.push({ name, ...layout });
  assert.ok(layout.scroll <= layout.width + 1, `overflow: ${name}`);
  await page.screenshot({
    path: `${out}/${name}.png`,
    fullPage: true,
    mask: [page.locator('input[type=password], .temporary-secret, [data-sensitive=true]')],
  });
  report.screens.push(`${name}.png`);
  await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2));
}
try {
  await mkdir(out, { recursive: true });
  preview = await openOperationalPreview();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('pageerror', () => report.errors.push('runtime-error'));
  for (const width of [1440, 1200, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(preview.origin);
    await page.getByRole('heading', { name: 'Giriş Yap', exact: true }).waitFor();
    await capture(page, `login-${width}`);
  }
  await page.getByLabel('E-posta', { exact: true }).fill(preview.users[0].email);
  await page.getByLabel('Şifre', { exact: true }).fill('synthetic-invalid-login');
  await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'E-posta veya şifre hatalı.' }).waitFor();
  assert.equal(await page.getByLabel('Şifre', { exact: true }).inputValue(), '');
  await capture(page, 'login-error-390');
  report.checks.push('GENERIC_LOGIN_ERROR_CLEARS_PASSWORD');
  for (let actor = 0; actor < 2; actor++) {
    const c = actor === 0 ? context : await browser.newContext({ ignoreHTTPSErrors: true });
    const p = actor === 0 ? page : await c.newPage();
    await p.goto(preview.origin);
    await p.getByLabel('E-posta', { exact: true }).fill(preview.users[actor].email);
    await p.getByLabel('Şifre', { exact: true }).fill(preview.passwords[actor]);
    await p.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
    await p.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    for (const width of [1440, 1200, 768, 390]) {
      await p.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await p.goto(`${preview.origin}/customers/demo-customer-0/manage`);
      await p.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
      assert.equal(await p.getByRole('dialog').count(), 0);
      await capture(p, `customer-management-${actor}-${width}`);
      await p.getByRole('button', { name: 'Dış sistem kayıtları', exact: true }).click();
      await capture(p, `customer-references-${actor}-${width}`);
    }
    if (actor === 0) {
      await p.goto(`${preview.origin}/customers/new`);
      await p.getByLabel('Ad', { exact: true }).fill('Sentetik');
      await p.getByLabel('Soyad', { exact: true }).fill('Arşiv Denemesi');
      await p.getByRole('button', { name: 'Müşteriyi kaydet', exact: true }).click();
      await p.getByRole('heading', { name: 'Sentetik Arşiv Denemesi', exact: true }).waitFor();
      const id = new URL(p.url()).pathname.split('/')[2];
      await p.goto(`${preview.origin}/customers/${id}/manage`);
      await p.getByRole('button', { name: 'Arşivleme', exact: true }).click();
      await p.getByRole('button', { name: 'Müşteriyi Arşivle', exact: true }).click();
      await p
        .getByRole('combobox', { name: 'Arşiv Nedeni', exact: true })
        .selectOption('HISTORICAL_RECORD');
      const attempts = [];
      await p.route(`**/api/customers/${id}/archive`, async (route) => {
        const request = route.request();
        attempts.push({ body: request.postData(), key: request.headers()['idempotency-key'] });
        if (attempts.length === 1) {
          assert.equal((await route.fetch()).status(), 200);
          await route.abort('failed');
        } else await route.continue();
      });
      await p.getByRole('button', { name: 'Arşivlemeyi Onayla', exact: true }).click();
      await p.getByRole('button', { name: 'Tekrar Dene', exact: true }).waitFor();
      assert.equal(
        await p.getByRole('combobox', { name: 'Arşiv Nedeni', exact: true }).isDisabled(),
        true,
      );
      assert.equal(await p.getByRole('button', { name: 'Vazgeç', exact: true }).isDisabled(), true);
      await capture(p, 'customer-archive-uncertain-390');
      await p.getByRole('button', { name: 'Tekrar Dene', exact: true }).click();
      await p.getByRole('status').filter({ hasText: 'Bu müşteri arşivlenmiş.' }).waitFor();
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      const customer = await preview.demo.db
        .prepare('SELECT version, archived_at, archive_reason_code FROM customers WHERE id = ?')
        .bind(id)
        .first();
      assert.equal(customer.version, 2);
      assert.ok(customer.archived_at);
      assert.equal(customer.archive_reason_code, 'HISTORICAL_RECORD');
      await capture(p, 'customer-archive-verified-390');
      report.checks.push('OWNER_REAL_D1_ARCHIVE_COMMIT_DROP_EXACT_RETRY_ONE_VERSION');
    }
    await p.goto(`${preview.origin}/account/password`);
    await p.getByRole('heading', { name: 'Şifremi değiştir', exact: true }).waitFor();
    await capture(p, `account-${actor}-390`);
    assert.deepEqual(
      await p.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
      { local: 0, session: 0 },
    );
    report.checks.push(
      actor === 0
        ? 'OWNER_REAL_LOGIN_MODERN_CUSTOMER_ACCOUNT'
        : 'MEMBER_REAL_LOGIN_MODERN_CUSTOMER_ACCOUNT',
    );
  }
  assert.deepEqual(report.errors, []);
  report.checks.push('NO_RUNTIME_ERRORS_OR_BROWSER_CREDENTIAL_STORAGE');
  console.info('MODERN_EXPERIENCE_BROWSER_PASS');
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : 'unknown');
  process.exitCode = 1;
  console.error(
    'MODERN_EXPERIENCE_BROWSER_FAIL',
    error instanceof Error ? error.message : 'unknown',
  );
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  await preview?.close();
}
