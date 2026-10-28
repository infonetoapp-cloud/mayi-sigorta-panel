/* global fetch,document,innerWidth */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const out = process.env.MAYI_ACCEPTANCE_EVIDENCE_DIR ?? 'acceptance-evidence/legacy';
const report = { checks: [], screens: [], findings: [] };
let p,
  b,
  stage = 'setup';
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function get(page, path) {
  return page.evaluate(async (path) => {
    const r = await fetch(path);
    return { status: r.status, ...(await r.json()) };
  }, path);
}
async function shot(page, name) {
  await page.screenshot({ path: out + '/' + name + '.png', fullPage: true });
  report.screens.push(name + '.png');
}
try {
  await mkdir(out, { recursive: true });
  p = await openOperationalPreview();
  b = await chromium.launch({ channel: 'msedge', headless: true });
  const c = await b.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    page = await c.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(p.origin);
  await page.getByLabel('E-posta', { exact: true }).fill(p.users[0].email);
  await page.getByLabel('Şifre', { exact: true }).fill(p.passwords[0]);
  await click(page, 'Giriş Yap');
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  stage = 'legacy-note';
  await page.goto(p.origin + '/customers/demo-customer-0/advanced');
  await click(page, 'Yenileme kayıtlarını aç');
  const rows = (await get(page, '/api/customers/demo-customer-0/renewals')).data.items;
  const target = rows.find((r) => r.policyNumber === 'DEMO-0');
  assert.ok(target);
  await click(page, 'DEMO-0 — yenileme görüşmelerini ve teklifleri aç');
  await click(page, 'İletişim, teklif ve sonuçları aç: Deniz Yılmaz');
  const hist = await get(page, '/api/renewals/' + target.id + '/interactions');
  console.info(JSON.stringify({ interactionRead: hist.status, code: hist.error?.code }));
  await page.getByRole('combobox', { name: /^Görüşme sonucu: Deniz Yılmaz/ }).selectOption('NOTE');
  await page
    .getByRole('combobox', { name: /^İletişim kanalı: Deniz Yılmaz/ })
    .selectOption('OTHER');
  await page
    .getByLabel('Not: Deniz Yılmaz', { exact: true })
    .fill('Legacy kayıp yanıt doğrulaması');
  const path = '/api/renewals/' + target.id + '/interactions';
  const attempts = [];
  let lost = true;
  await page.route('**' + path, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    const r = await route.fetch();
    if (!r.ok()) {
      report.findings.push({ kind: 'unexpected-note-status', status: r.status() });
      return route.fulfill({ response: r });
    }
    if (lost) {
      lost = false;
      await route.abort('failed');
    } else await route.fulfill({ response: r });
  });
  await click(page, 'Görüşmeyi kaydet: Deniz Yılmaz');
  await page
    .getByRole('button', { name: 'Aynı görüşme isteğini yeniden dene: Deniz Yılmaz', exact: true })
    .waitFor();
  await click(page, 'DEMO-0 — yenileme görüşmelerini ve teklifleri kapat');
  assert.equal(
    await page.locator('textarea').filter({ visible: true }).inputValue(),
    'Legacy kayıp yanıt doğrulaması',
  );
  await shot(page, 'pending-keeps-workspace');
  await click(page, 'Müşteri detayını kapat');
  await page.getByText(/İşlemin sonucu henüz kesinleşmedi/).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Deniz Yılmaz', exact: true }).count(), 1);
  await page
    .getByRole('link', { name: 'Modern müşteri profiline dön', exact: true })
    .evaluate((a) => a.click());
  assert.ok(page.url().endsWith('/customers/demo-customer-0/advanced'));
  assert.equal(
    await page.locator('textarea').filter({ visible: true }).inputValue(),
    'Legacy kayıp yanıt doğrulaması',
  );
  await shot(page, 'pending-parent-close-escape-route-held');
  await click(page, 'Aynı görüşme isteğini yeniden dene: Deniz Yılmaz');
  await page.getByText('Not kaydedildi.', { exact: true }).waitFor();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(
    await p.demo.db
      .prepare('SELECT count(*) n FROM renewal_interactions WHERE renewal_id=? AND note=?')
      .bind(target.id, 'Legacy kayıp yanıt doğrulaması')
      .first('n'),
    1,
  );
  await page.unroute('**' + path);
  report.checks.push(
    'REAL_LEGACY_NOTE_COMMIT_LOST_RESPONSE_EXACT_RETRY_SINGLE_D1_ROW_SELECTION_LOCK',
  );
  stage = 'legacy-modal';
  const outcomeSelect = await page
    .getByRole('combobox', { name: /^Görüşme sonucu: Deniz Yılmaz/ })
    .elementHandle();
  await page.waitForFunction((select) => !select.disabled, outcomeSelect);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await page.waitForURL('**/customers/demo-customer-0');
  await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
  assert.ok(page.url().endsWith('/customers/demo-customer-0'));
  assert.equal(await page.locator('[role=dialog],dialog[open]').count(), 0);
  report.checks.push('PARENT_CLOSE_ESCAPE_ROUTE_HOLD_UNCERTAIN_AND_CLEAN_CLOSE_TO_PROFILE');
  await shot(page, 'legacy-clean-close-profile-mobile');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  stage = 'legacy-policy-money';
  await page.goto(p.origin + '/policies/legacy');
  await click(page, '+ Yeni Poliçe');
  await page.getByLabel('Brüt Prim', { exact: true }).fill('12.500,50');
  const form = page.locator('form').filter({ has: page.getByLabel('Brüt Prim', { exact: true }) });
  await page.getByLabel('Poliçe Numarası', { exact: true }).fill('ACCEPT-LEGACY-MONEY');
  await page.getByLabel('Başlangıç Tarihi', { exact: true }).fill('2026-01-01');
  await page
    .getByLabel('Bitiş Tarihi', { exact: true })
    .fill(new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10));
  const customer = page.getByLabel('Müşteri', { exact: true });
  if (await customer.count()) await customer.selectOption('demo-customer-0');
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/policies'),
  );
  await form.getByRole('button', { name: 'Poliçeyi Kaydet', exact: true }).click();
  const r = await response;
  assert.equal(r.status(), 201);
  assert.equal(JSON.parse(r.request().postData()).grossPremium, '12500.50');
  const created = (await r.json()).data;
  assert.equal(
    await p.demo.db
      .prepare('SELECT gross_premium_minor FROM policies WHERE id=?')
      .bind(created.id)
      .first('gross_premium_minor'),
    1250050,
  );
  await shot(page, 'legacy-money-saved');
  report.checks.push('LEGACY_POLICY_TURKISH_MONEY_CANONICAL_PAYLOAD_AND_D1_MINOR_PERSISTENCE');
  report.status = 'PASS';
} catch (e) {
  report.status = 'FAIL';
  report.failure = { stage, error: String(e) };
  const pages = b?.contexts().flatMap((c) => c.pages()) ?? [];
  if (pages[0]) {
    report.dom = await pages[0].locator('main').innerText();
    await shot(pages[0], 'failure');
  }
  process.exitCode = 1;
} finally {
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
  await b?.close();
  await p?.close();
  console.info(
    JSON.stringify({ status: report.status, checks: report.checks, failure: report.failure }),
  );
}
