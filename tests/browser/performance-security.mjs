/* global localStorage, sessionStorage */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const preview = await openOperationalPreview();
let browser;
const checks = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const nav = (name) =>
    page
      .getByRole('navigation', { name: 'Ana menü', exact: true })
      .getByRole('link', { name, exact: true });
  async function login(actor) {
    await page.goto(preview.origin);
    await page.getByLabel('E-posta', { exact: true }).fill(preview.users[actor].email);
    await page.getByLabel('Şifre', { exact: true }).fill(preview.passwords[actor]);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  }
  await login(0);
  await page.goto(preview.origin + '/policies?search=DEMO-0&searchMode=exact');
  await page.getByRole('link', { name: 'DEMO-0', exact: true }).waitFor();
  await nav('Müşteriler').click();
  await page.getByRole('button', { name: 'Çıkış Yap', exact: true }).click();
  await page.getByLabel('E-posta', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'DEMO-0', exact: true }).count(), 0);
  await login(2);
  assert.equal(await nav('Poliçeler').getAttribute('href'), '/policies');
  assert.equal(
    await page.getByRole('link', { name: 'Personel ve İzinler', exact: true }).count(),
    0,
  );
  checks.push('SAME_CONTEXT_LOGOUT_ACCOUNT_SWITCH_CLEARS_OWNER_TARGETS');
  await nav('Müşteriler').click();
  await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).waitFor();
  await preview.demo.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='demo-member-ayse' AND permission_code='customer.read'",
    )
    .run();
  await nav('Poliçeler').click();
  await page.getByRole('heading', { name: 'Poliçe portföyü', exact: true }).waitFor();
  await nav('Müşteriler').click();
  await page.getByRole('heading', { name: 'Erişim izni gerekli', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).count(), 0);
  checks.push('LIVE_PERMISSION_REVOKED_NEXT_READ_DENIES_NO_RETAINED_DTO');
  await page.getByRole('button', { name: 'Çıkış Yap', exact: true }).click();
  await page.getByLabel('E-posta', { exact: true }).waitFor();
  await login(0);
  await nav('Müşteriler').click();
  await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).waitFor();
  await preview.demo.db
    .prepare(
      "UPDATE local_sessions SET revoked_at=? WHERE membership_id='demo-member-owner' AND revoked_at IS NULL",
    )
    .bind(Date.now())
    .run();
  await nav('Poliçeler').click();
  await page.getByLabel('E-posta', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).count(), 0);
  checks.push('LIVE_SESSION_REVOKED_401_UNMOUNTS_PROTECTED_SHELL');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  checks.push('NO_BROWSER_PERSISTENCE');
  await writeFile(
    'performance-evidence/browser-live-security.json',
    JSON.stringify({ status: 'PASS', checks }, null, 2),
  );
} finally {
  await browser?.close();
  await preview.close();
}
