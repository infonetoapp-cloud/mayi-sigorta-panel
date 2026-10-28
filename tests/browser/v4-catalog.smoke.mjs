/* global fetch,document,innerWidth,crypto */
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
let p,
  b,
  stage = 'setup';
const out = 'catalog-evidence/final';
const report = { checks: [], screens: [], errors: [] };
async function api(page, path, method = 'GET', body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const headers = {};
      if (method !== 'GET') {
        const c = await (await fetch('/api/csrf-token')).json();
        headers['x-csrf-token'] = c.data.token;
        headers['content-type'] = 'application/json';
        headers['idempotency-key'] = crypto.randomUUID();
      }
      const r = await fetch(path, {
        method,
        headers,
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const j = await r.json();
      return { status: r.status, data: j.data, code: j.error?.code };
    },
    { path, method, body },
  );
}
async function button(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
}
async function tab(page, name) {
  await button(page, name);
  await page.locator('.catalog-table[aria-busy=false]').waitFor();
}
async function snap(page, name) {
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.equal(await page.locator('.temporary-secret').count(), 0);
  await page.screenshot({
    path: out + '/' + name + '.png',
    fullPage: true,
    mask: [page.locator('[data-sensitive=true]')],
  });
  report.screens.push(name + '.png');
}
async function create(page, code, name, extra) {
  await button(page, 'Yeni kayıt');
  await page.getByLabel('Kod', { exact: true }).fill(code);
  await page.getByLabel('Ad', { exact: true }).fill(name);
  if (extra) await extra();
  await button(page, 'Kaydet');
  await page
    .getByText('Kayıt kaydedildi. Güncel katalog listesi yenilendi.', { exact: true })
    .waitFor();
}
async function edit(page, name) {
  await page
    .getByRole('row')
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByRole('button', { name: 'Düzenle', exact: true })
    .click();
}
async function cancel(page) {
  await button(page, 'Vazgeç');
  if (await page.getByRole('button', { name: 'Ayrılmayı onayla', exact: true }).count())
    await button(page, 'Ayrılmayı onayla');
}
async function login(page, i) {
  await page.goto(p.origin + '/');
  await page.getByLabel('E-posta', { exact: true }).fill(p.users[i].email);
  await page.getByLabel('Şifre', { exact: true }).fill(p.passwords[i]);
  await button(page, 'Giriş Yap');
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
}
try {
  await mkdir(out, { recursive: true });
  p = await openOperationalPreview();
  b = await chromium.launch({ channel: 'msedge', headless: true });
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const c = await b.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    const page = await c.newPage();
    page.setDefaultTimeout(18000);
    page.on('pageerror', () => report.errors.push('runtime'));
    await login(page, i);
    pages.push(page);
  }
  const [o, a, ordinary] = pages;
  stage = 'full-staff-combined';
  await o.goto(p.origin + '/personnel');
  const personnel = (await api(o, '/api/personnel')).data.personnel;
  const target = personnel.find((x) => x.id === 'demo-member-ahmet');
  await o
    .getByRole('row')
    .filter({ has: o.getByText(target.login_email, { exact: true }) })
    .getByRole('button', { name: 'İzinleri düzenle', exact: true })
    .click();
  await button(o, 'Tam Yetki Ver');
  await button(o, 'Kaydet');
  const dialog = o.getByRole('dialog', {
    name: 'Devam etmek için şifrenizi tekrar girin',
    exact: true,
  });
  await dialog.waitFor();
  await dialog.getByLabel('Şifre', { exact: true }).fill(p.passwords[0]);
  await dialog.getByRole('button', { name: 'Doğrula', exact: true }).click();
  await o
    .getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
      exact: true,
    })
    .waitFor();
  await login(a, 1);
  await a.goto(p.origin + '/catalogs');
  await a.getByRole('button', { name: 'Yeni kayıt', exact: true }).waitFor();
  assert.equal((await api(a, '/api/personnel')).status, 403);
  await ordinary.goto(p.origin + '/catalogs');
  await ordinary.getByText(/Salt okunur/).waitFor();
  assert.equal(await ordinary.getByRole('button', { name: 'Yeni kayıt', exact: true }).count(), 0);
  assert.equal(
    (await api(ordinary, '/api/catalogs/insurers', 'POST', { code: 'DENY', name: 'Sentetik ret' }))
      .status,
    403,
  );
  report.checks.push(
    'OWNER_ONE_CLICK_FULL_MEMBER_EMPTY_REASON_REAL_SAVE_MEMBER_CATALOG_ALLOW_ORDINARY_DENY',
  );
  stage = 'catalog-create';
  await create(a, 'V4INS', 'Sentetik Anadolu Partner');
  const insurer = (await api(a, '/api/catalogs/insurers')).data.find((x) => x.code === 'V4INS');
  assert.ok(insurer);
  await tab(a, 'Branşlar');
  await create(a, 'V4BRANCH', 'Sentetik Konut Branşı');
  const branch = (await api(a, '/api/catalogs/branches')).data.find((x) => x.code === 'V4BRANCH');
  await create(a, 'V4BRANCH2', 'Sentetik İşyeri Branşı');
  const branch2 = (await api(a, '/api/catalogs/branches')).data.find((x) => x.code === 'V4BRANCH2');
  await tab(a, 'Ürünler');
  await create(a, 'V4PRODUCT', 'Sentetik Evim Güvende', async () => {
    assert.equal(await a.getByLabel('Sigorta şirketi', { exact: true }).inputValue(), '');
    assert.equal(await a.getByLabel('Branş', { exact: true }).inputValue(), '');
    await a.getByLabel('Sigorta şirketi', { exact: true }).selectOption(insurer.id);
    await a.getByLabel('Branş', { exact: true }).selectOption(branch.id);
  });
  const product = (await api(a, '/api/catalogs/products')).data.find((x) => x.code === 'V4PRODUCT');
  assert.equal(product.insurerId, insurer.id);
  assert.equal(product.branchId, branch.id);
  await tab(a, 'Ödeme Yöntemleri');
  await create(a, 'V4PAY', 'Sentetik 6 Taksit', async () => {
    await a.getByLabel('Taksit destekler', { exact: true }).check();
    await a.getByLabel('En fazla taksit', { exact: true }).fill('6');
  });
  const payment = (await api(a, '/api/catalogs/payment-methods')).data.find(
    (x) => x.code === 'V4PAY',
  );
  assert.equal(payment.maxInstallments, 6);
  await tab(a, 'Kayıp Nedenleri');
  await create(a, 'V4LOSS', 'Sentetik fiyat tercihi');
  report.checks.push('FIVE_REAL_CATALOG_CREATE_SUPPORTED_PRODUCT_RELATIONSHIPS_AND_PAYMENT_LIMITS');
  stage = 'responsive';
  await tab(a, 'Ürünler');
  for (const width of [1440, 1200, 768, 390]) {
    await a.setViewportSize({ width, height: 1000 });
    assert.equal(await a.locator('h1').count(), 1);
    assert.equal(await a.locator('main').count(), 1);
    assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await snap(a, 'products-' + width);
    await edit(a, 'Sentetik Evim Güvende');
    await snap(a, 'product-edit-' + width);
    await button(a, 'Vazgeç');
  }
  await a.setViewportSize({ width: 1440, height: 1000 });
  await a.getByLabel('Sigortacı filtresi', { exact: true }).selectOption(insurer.id);
  await a.getByLabel('Branş filtresi', { exact: true }).selectOption(branch.id);
  await a.getByLabel('Katalogda ara', { exact: true }).fill('Anadolu');
  assert.equal(await a.locator('.catalog-table tbody tr').count(), 1);
  await a.getByLabel('Katalogda ara', { exact: true }).fill('bulunamaz');
  await a.getByText('Aramanızla eşleşen kayıt yok', { exact: true }).waitFor();
  await snap(a, 'empty-filter');
  await button(a, 'Filtreleri temizle');
  report.checks.push(
    'FOUR_VIEWPORTS_SINGLE_MAIN_HEADING_NO_MAJOR_OVERFLOW_SEARCH_RELATION_FILTERS',
  );
  stage = 'draft-navigation';
  await edit(a, 'Sentetik Evim Güvende');
  await a.getByLabel('Ad', { exact: true }).fill('Korunan ürün taslağı');
  await button(a, 'Sigorta Şirketleri');
  await a.getByRole('dialog').waitFor();
  await button(a, 'Bu ekranda kal');
  assert.equal(await a.getByLabel('Ad', { exact: true }).inputValue(), 'Korunan ürün taslağı');
  await a.getByRole('link', { name: 'Poliçeler', exact: true }).click();
  await a.getByRole('dialog').waitFor();
  await button(a, 'Bu ekranda kal');
  await cancel(a);
  report.checks.push('TAB_AND_CROSS_MODULE_DIRTY_NAVIGATION_PROTECTION');
  stage = 'duplicate-validation';
  await tab(a, 'Sigorta Şirketleri');
  await button(a, 'Yeni kayıt');
  await a.getByLabel('Kod', { exact: true }).fill('V4INS');
  await a.getByLabel('Ad', { exact: true }).fill('Sentetik yinelenen');
  await button(a, 'Kaydet');
  await a.getByRole('alert').waitFor();
  assert.equal(
    await p.demo.db.prepare("SELECT count(*) n FROM insurers WHERE code='V4INS'").first('n'),
    1,
  );
  await snap(a, 'duplicate');
  await cancel(a);
  assert.equal(
    (
      await api(a, '/api/catalogs/products', 'POST', {
        code: 'BADREL',
        name: 'Hatalı ürün',
        insurerId: insurer.id,
        branchId: 'missing',
      })
    ).status,
    409,
  );
  report.checks.push('DUPLICATE_AND_INVALID_RELATION_REAL_REJECTION_NO_DUPLICATE_ROWS');
  stage = 'lost-response';
  let drop = true;
  const writes = [];
  await a.route('**/api/catalogs/insurers', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    writes.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    const response = await route.fetch();
    if (drop) {
      drop = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await button(a, 'Yeni kayıt');
  await a.getByLabel('Kod', { exact: true }).fill('V4LOST');
  await a.getByLabel('Ad', { exact: true }).fill('Sentetik Kurtarılan Sigortacı');
  await button(a, 'Kaydet');
  await a.getByRole('button', { name: 'Aynı isteği yeniden dene', exact: true }).waitFor();
  assert.equal(await a.getByLabel('Ad', { exact: true }).isDisabled(), true);
  await button(a, 'Çıkış Yap');
  assert.equal(await a.getByRole('dialog').count(), 0);
  await button(a, 'Aynı isteği yeniden dene');
  await a
    .getByText('Kayıt kaydedildi. Güncel katalog listesi yenilendi.', { exact: true })
    .waitFor();
  assert.equal(writes.length, 2);
  assert.ok(writes[0].body === writes[1].body && writes[0].key === writes[1].key);
  assert.equal(
    await p.demo.db.prepare("SELECT count(*) n FROM insurers WHERE code='V4LOST'").first('n'),
    1,
  );
  await a.unroute('**/api/catalogs/insurers');
  report.checks.push('COMMITTED_RESPONSE_LOSS_IDENTICAL_BODY_KEY_SINGLE_EFFECT_AND_LOGOUT_HOLD');
  stage = 'conflict';
  await edit(a, 'Sentetik Anadolu Partner');
  await a.getByLabel('Ad', { exact: true }).fill('Eski taslak adı');
  await o.goto(p.origin + '/catalogs');
  await edit(o, 'Sentetik Anadolu Partner');
  await o.getByLabel('Ad', { exact: true }).fill('Sentetik Anadolu Güncel');
  await button(o, 'Güncelle');
  await o
    .getByText('Kayıt kaydedildi. Güncel katalog listesi yenilendi.', { exact: true })
    .waitFor();
  await button(a, 'Güncelle');
  await a.getByRole('alert').waitFor();
  assert.equal(await a.getByLabel('Ad', { exact: true }).inputValue(), 'Eski taslak adı');
  await button(a, 'Güncel kaydı karşılaştır');
  await a.getByText(/Sunucudaki güncel ad: Sentetik Anadolu Güncel/).waitFor();
  await snap(a, 'conflict-compare');
  await cancel(a);
  await button(a, 'Listeyi yenile');
  await a.getByText('Sentetik Anadolu Güncel', { exact: true }).waitFor();
  report.checks.push('TWO_AUTHENTICATED_EDITORS_STALE_CAS_CURRENT_COMPARISON_PRESERVED_DRAFT');
  stage = 'policy-create';
  await a.goto(p.origin + '/policies/new?customerId=demo-customer-0');
  await a.getByRole('form', { name: 'Poliçe sözleşme formu', exact: true }).waitFor();
  await a.getByLabel('Sigorta şirketi', { exact: true }).selectOption(insurer.id);
  await a.getByLabel('Branş', { exact: true }).selectOption(branch.id);
  await a.getByLabel('Ürün', { exact: true }).selectOption(product.id);
  await a.getByLabel('Ödeme yöntemi', { exact: true }).selectOption(payment.id);
  await a.getByLabel('Taksit sayısı', { exact: true }).fill('6');
  await a.getByLabel('Poliçe numarası', { exact: true }).fill('V4CATALOGPOLICY');
  await a.getByLabel('Başlangıç tarihi', { exact: true }).fill('2026-01-01');
  await a.getByLabel('Bitiş tarihi', { exact: true }).fill('2027-01-01');
  await a.getByLabel('Brüt prim', { exact: true }).fill('12.500,50');
  await a.getByLabel('ISO para birimi', { exact: true }).fill('TRY');
  await button(a, 'Poliçeyi oluştur');
  await a.getByRole('heading', { name: 'V4CATALOGPOLICY', exact: true }).waitFor();
  const policyId = new URL(a.url()).pathname.split('/').pop();
  const policy = (await api(a, '/api/policies/' + policyId)).data;
  assert.equal(policy.productId, product.id);
  assert.equal(policy.insurerId, insurer.id);
  assert.equal(policy.branchId, branch.id);
  assert.equal(policy.grossPremiumMinor, 1250050);
  await a.goto(p.origin + '/policies/' + policyId + '/edit');
  await a.getByLabel('Brüt prim', { exact: true }).fill('13.000,75');
  await button(a, 'Değişiklikleri kaydet');
  await a.getByRole('heading', { name: 'V4CATALOGPOLICY', exact: true }).waitFor();
  assert.equal((await api(a, '/api/policies/' + policyId)).data.grossPremiumMinor, 1300075);
  report.checks.push('EXISTING_REAL_POLICY_CREATE_AND_EDIT_NEW_CATALOG_IDS_EXACT_MINOR_UNITS');
  stage = 'historical-relations';
  await a.goto(p.origin + '/catalogs');
  await tab(a, 'Ürünler');
  await edit(a, 'Sentetik Evim Güvende');
  await a.getByLabel('Branş', { exact: true }).selectOption(branch2.id);
  const branchResponse = a.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && r.url().endsWith('/api/catalogs/products/' + product.id),
  );
  await button(a, 'Güncelle');
  assert.equal((await branchResponse).status(), 409);
  await a.getByRole('alert').waitFor();
  assert.equal((await api(a, '/api/catalogs/products/' + product.id)).data.branchId, branch.id);
  assert.equal((await api(a, '/api/policies/' + policyId)).data.branchId, branch.id);
  await cancel(a);
  const productRow = a
    .getByRole('row')
    .filter({ has: a.getByText('Sentetik Evim Güvende', { exact: true }) });
  await productRow.getByRole('button', { name: 'Pasifleştir', exact: true }).click();
  await a.getByRole('dialog').waitFor();
  await button(a, 'Pasifleştirmeyi onayla');
  await a
    .getByText('Kayıt pasifleştirildi. Geçmiş poliçe bağlantıları korunur.', { exact: true })
    .waitFor();
  await a.getByLabel('Pasif kayıtları göster', { exact: true }).check();
  await a.getByText('Sentetik Evim Güvende', { exact: true }).waitFor();
  await snap(a, 'inactive-history');
  assert.equal((await api(a, '/api/policies/' + policyId)).data.productId, product.id);
  assert.equal(
    (await api(a, '/api/catalogs/selectable')).data.products.some((x) => x.id === product.id),
    false,
  );
  report.checks.push('USED_PRODUCT_BRANCH_CHANGE_DENIED_AND_DEACTIVATION_PRESERVES_HISTORY');
  assert.deepEqual(report.errors, []);
  assert.deepEqual((await p.demo.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  report.status = 'PASS';
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
  console.info(
    JSON.stringify({
      status: 'PASS',
      groups: report.checks.length,
      screens: report.screens.length,
      errors: report.errors.length,
    }),
  );
} catch (error) {
  await writeFile(
    out + '/failure.json',
    JSON.stringify({ status: 'FAIL', stage, kind: error?.name, checks: report.checks }, null, 2),
  );
  console.error(
    'V4_CATALOG_FAIL',
    stage,
    error?.name,
    String(error?.stack ?? '')
      .split('\n')
      .filter((x) => x.includes('v4-catalog.smoke.mjs:'))
      .pop(),
  );
  process.exitCode = 1;
} finally {
  await b?.close();
  await p?.close();
}
