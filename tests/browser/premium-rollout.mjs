// Real optimized native React/API/D1 regression; no API DTO stubs or external services.
/* global document,innerWidth,getComputedStyle,crypto,fetch,localStorage,sessionStorage */
import console from 'node:console';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const preview = await openOperationalPreview();
let browser;
const checks = [],
  runtime = [];
try {
  assert.equal(preview.demo.runtime, 'workerd');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
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
  page.on('pageerror', () => runtime.push('pageerror'));
  const routes = [
    ['/', 'Genel Bakış'],
    ['/today-work', 'Bugünkü İşler'],
    ['/customers', 'Müşteriler'],
    ['/customers/demo-customer-0', 'Deniz Yılmaz'],
    ['/customers/new', 'Yeni müşteri'],
    ['/policies', 'Poliçe portföyü'],
    ['/policies/demo-policy-0', 'DEMO-0'],
    ['/policies/new?customerId=demo-customer-0', 'Yeni poliçe'],
    ['/personnel', 'Personel ve İzinler'],
    ['/catalogs', 'Kataloglar'],
    ['/agency-settings', 'Acente Ayarları'],
    ['/account/password', 'Şifremi değiştir'],
  ];
  async function nav(path) {
    await page.goto(preview.origin + path);
    await page.locator('main h1').waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('[role=status]')].some(
          (e) => e.checkVisibility() && /yükleniyor/.test(e.textContent),
        ),
    );
  }
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const [path] of routes) {
      await nav(path);
      assert.equal(await page.locator('.premium-ui').count(), 1);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        path + ' no document overflow',
      );
      const font = await page.locator('main h1').evaluate((e) => getComputedStyle(e).fontSize);
      assert.equal(font, width === 390 ? '24px' : '28px', path + ' heading contract');
    }
  }
  checks.push('36_REAL_AUTHENTICATED_ROUTE_VIEWPORTS_SHARED_SYSTEM_NO_DOCUMENT_OVERFLOW');
  await page.setViewportSize({ width: 1440, height: 900 });
  await nav('/customers');
  const heights = await page
    .locator('.customer-table tbody tr')
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height).sort((a, b) => a - b));
  assert.equal(heights[Math.floor(heights.length / 2)], 81);
  checks.push('DESKTOP_CUSTOMER_MEDIAN_ROW_REMAINS_81PX');
  await nav('/personnel');
  await page
    .getByRole('row')
    .filter({ hasText: 'ahmet@demo.invalid' })
    .getByRole('button', { name: 'İzinleri düzenle', exact: true })
    .click();
  await page.getByRole('button', { name: 'Tam Yetki Ver', exact: true }).click();
  const save = await page.getByRole('button', { name: 'Kaydet', exact: true }).boundingBox();
  assert(save.y + save.height <= 900);
  const comparison = page.getByRole('region', { name: 'İzin karşılaştırma tablosu', exact: true });
  await comparison.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await comparison.evaluate((e) => e === document.activeElement), true);
  assert.equal(await comparison.evaluate((e) => getComputedStyle(e).outlineWidth), '2px');
  assert.equal(
    await page
      .getByRole('button', { name: 'Tüm izinleri karşılaştır', exact: true })
      .evaluate((e) => getComputedStyle(e).borderTopWidth),
    '1px',
  );
  checks.push('FULL_PERMISSION_SAVE_VISIBLE_AND_COMPARISON_KEYBOARD_REGION_WITH_SURFACED_CONTROL');
  await nav('/today-work');
  const row = page.locator('.today-task-row').first();
  assert.equal(await row.locator('.task-row-action').textContent(), 'Aç ');
  await row.focus();
  assert.equal(await row.evaluate((e) => getComputedStyle(e).outlineWidth), '2px');
  await row.press('ArrowDown');
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('today-task-row')),
    true,
  );
  await row.click();
  assert.equal(await row.getAttribute('aria-pressed'), 'true');
  checks.push('TASK_ROWS_EXPLICIT_OPEN_FOCUS_ARROW_KEYS_AND_SELECTION');
  await page.getByRole('button', { name: 'Atanmamış işler', exact: true }).click();
  await page.getByText('Bu kuyrukta gösterilecek takip bulunmuyor.', { exact: true }).waitFor();
  assert.equal(await page.locator('.today-queue section > h3').count(), 0);
  assert.equal(await page.locator('.today-task-row').count(), 0);
  await page.getByRole('button', { name: 'Açık işlere dön', exact: true }).click();
  await page.locator('.today-task-row').first().waitFor();
  checks.push('REAL_EMPTY_QUEUE_NO_EMPTY_GROUPS_ACTIONABLE_RETURN');
  const api = async (path, method = 'GET', body) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const headers =
          method === 'GET'
            ? {}
            : {
                'content-type': 'application/json',
                'idempotency-key': crypto.randomUUID(),
                'x-csrf-token': (await (await fetch('/api/csrf-token')).json()).data.token,
              };
        const r = await fetch(path, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: r.status, data: (await r.json()).data };
      },
      { path, method, body },
    );
  const customer = (await api('/api/customers/demo-customer-0')).data;
  assert.equal(
    (
      await api('/api/customers/demo-customer-0', 'PATCH', {
        expectedVersion: customer.version,
        email: 'uzun.operasyon.sorumlusu.yenileme.musteri@example.invalid',
      })
    ).status,
    200,
  );
  const tasks = (await api('/api/tasks/today?limit=50')).data.items;
  const task = tasks.find((t) => t.customerId === 'demo-customer-0');
  assert(task);
  await page.setViewportSize({ width: 390, height: 844 });
  await nav('/today-work?task=' + task.taskId + '&queue=WORK&work=task');
  await page.locator('.task-contact-email dd').waitFor();
  const email = await page.locator('.task-contact-email dd').boundingBox();
  assert(email.width >= 300);
  assert(email.height <= 48);
  checks.push('MOBILE_LONG_EMAIL_FULL_WIDTH_READABLE_WITHOUT_HIDING');
  await page.getByRole('button', { name: 'Yeni takip planını aç', exact: true }).click();
  const form = page.getByRole('form', { name: 'Takip tamamlama formu', exact: true });
  await form.waitFor();
  assert.equal(await form.getByRole('checkbox').count(), 1);
  const submit = form.getByRole('button', { name: 'Takibi tamamla ve planla', exact: true });
  await page
    .getByLabel('Yeni takip zamanı (İstanbul)', { exact: true })
    .fill(new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 16));
  await submit.click();
  await page.getByText('İşlemi açıkça onaylayın.', { exact: true }).waitFor();
  assert.equal(await page.locator('.workflow-help').first().getAttribute('open'), null);
  checks.push('OPTIONAL_HELP_COLLAPSED_REQUIRED_BUSINESS_CONFIRMATION_STILL_VISIBLE');
  await context.close();
  const member = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  assert.equal(
    (
      await member.request.post(preview.origin + '/api/auth/login', {
        headers: { origin: preview.origin },
        data: { email: preview.users[2].email, password: preview.passwords[2] },
      })
    ).status(),
    200,
  );
  const mp = await member.newPage();
  await mp.goto(preview.origin + '/personnel');
  await mp.getByRole('heading', { name: 'Bu sayfaya erişiminiz yok', exact: true }).waitFor();
  assert.equal(await mp.getByRole('button', { name: 'Tam Yetki Ver', exact: true }).count(), 0);
  assert.deepEqual(await mp.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  checks.push('MEMBER_DENIED_AND_NO_BROWSER_PERSISTENCE');
  assert.deepEqual(runtime, []);
  checks.push('NO_RUNTIME_ERRORS');
  await mkdir('rollout-evidence', { recursive: true });
  await writeFile(
    'rollout-evidence/browser-design-regression.json',
    JSON.stringify({ status: 'PASS', runtime: preview.demo.runtime, checks }, null, 2),
  );
  console.info(JSON.stringify({ status: 'PASS', checks }));
} finally {
  await browser?.close();
  await preview.close();
}
