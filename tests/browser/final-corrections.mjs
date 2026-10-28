/* global fetch,document,innerWidth */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const out = 'final-evidence/browser';
const report = { checks: [], screens: [], money: [], layouts: [] };
let p,
  b,
  stage = 'setup';
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function shot(page, name) {
  await page.screenshot({ path: out + '/' + name + '.png', fullPage: true });
  report.screens.push(name + '.png');
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  report.layouts.push({ name, ...geometry });
  assert.ok(geometry.scrollWidth <= geometry.width + 1);
}
async function api(page, path) {
  return page.evaluate(async (path) => {
    const r = await fetch(path);
    return { status: r.status, ...(await r.json()) };
  }, path);
}
async function login(page, actor) {
  await page.goto(p.origin);
  await page.getByLabel('E-posta', { exact: true }).fill(p.users[actor].email);
  await page.getByLabel('Şifre', { exact: true }).fill(p.passwords[actor]);
  await click(page, 'Giriş Yap');
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
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
  page.setDefaultTimeout(20000);
  await login(page, 0);
  stage = 'money-create';
  await page.goto(p.origin + '/policies/legacy');
  await click(page, '+ Yeni Poliçe');
  await page.getByLabel('Poliçe Numarası', { exact: true }).fill('FINAL-LEGACY-MONEY');
  await page.getByLabel('Başlangıç Tarihi', { exact: true }).fill('2026-01-01');
  await page
    .getByLabel('Bitiş Tarihi', { exact: true })
    .fill(new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10));
  await page.getByLabel('Müşteri', { exact: true }).selectOption('demo-customer-0');
  await page.getByLabel('Brüt Prim', { exact: true }).fill('12.500,50');
  let rwait = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/policies'),
  );
  await click(page, 'Poliçeyi Kaydet');
  let res = await rwait;
  assert.equal(res.status(), 201);
  assert.equal(res.request().postDataJSON().grossPremium, '12500.50');
  let dto = (await res.json()).data;
  const pid = dto.id;
  assert.equal(dto.grossPremiumMinor, 1250050);
  assert.equal(
    await p.demo.db
      .prepare('SELECT gross_premium_minor FROM policies WHERE id=?')
      .bind(pid)
      .first('gross_premium_minor'),
    1250050,
  );
  report.money.push({
    action: 'legacy-create',
    input: '12.500,50',
    canonical: '12500.50',
    minor: 1250050,
  });
  stage = 'money-update';
  await click(page, 'Poliçeyi Düzenle');
  await page.getByLabel('Brüt Prim', { exact: true }).fill('12.501,75');
  rwait = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/policies/' + pid),
  );
  await click(page, 'Değişiklikleri Kaydet');
  res = await rwait;
  assert.equal(res.status(), 200);
  assert.equal(res.request().postDataJSON().grossPremium, '12501.75');
  assert.equal(
    await p.demo.db
      .prepare('SELECT gross_premium_minor FROM policies WHERE id=?')
      .bind(pid)
      .first('gross_premium_minor'),
    1250175,
  );
  report.money.push({
    action: 'legacy-edit',
    input: '12.501,75',
    canonical: '12501.75',
    minor: 1250175,
  });
  stage = 'amendment';
  await click(page, 'Zeyil Ekle');
  await page.getByLabel('Zeyil Referansı', { exact: true }).fill('FINAL-Z-NEGATIVE');
  await page
    .getByLabel('Yürürlük Tarihi', { exact: true })
    .fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel('Zeyil Açıklaması', { exact: true }).fill('Sentetik kuruş farkı');
  await page.getByLabel('Prim Farkı', { exact: true }).fill('-0,50');
  rwait = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/amendments'),
  );
  await click(page, 'Zeyli Kaydet');
  res = await rwait;
  assert.equal(res.status(), 201);
  assert.equal(res.request().postDataJSON().premiumDifference, '-0.50');
  const aid = (await res.json()).data.id;
  assert.equal(
    await p.demo.db
      .prepare('SELECT premium_difference_minor FROM policy_amendments WHERE id=?')
      .bind(aid)
      .first('premium_difference_minor'),
    -50,
  );
  assert.equal(
    await p.demo.db
      .prepare('SELECT gross_premium_minor FROM policies WHERE id=?')
      .bind(pid)
      .first('gross_premium_minor'),
    1250175,
  );
  report.money.push({ action: 'amendment', input: '-0,50', canonical: '-0.50', minor: -50 });
  report.checks.push(
    'REAL_LEGACY_CREATE_EDIT_AMENDMENT_CANONICAL_REQUEST_AND_D1_NO_BASE_PREMIUM_CORRUPTION',
  );
  stage = 'invalid-money';
  await click(page, 'Poliçeyi Düzenle');
  await page.getByLabel('Brüt Prim', { exact: true }).fill('12.500');
  let invalidWrites = 0;
  const watch = (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith('/api/policies/' + pid))
      invalidWrites++;
  };
  page.on('request', watch);
  await click(page, 'Değişiklikleri Kaydet');
  await page.getByText(/Brüt prim biçimini/).waitFor();
  assert.equal(invalidWrites, 0);
  assert.equal(await page.getByLabel('Brüt Prim', { exact: true }).inputValue(), '12.500');
  await shot(page, 'legacy-invalid-money-1440');
  page.off('request', watch);
  await click(page, 'Vazgeç');
  report.checks.push('AMBIGUOUS_MONEY_REJECTED_LOCALLY_DRAFT_RETAINED_NO_PATCH');
  stage = 'grow-fixture';
  await p.demo.db.batch(
    Array.from({ length: 30 }, (_, i) =>
      p.demo.db
        .prepare(
          `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) SELECT ?,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,?,?,'2026-01-01','2027-01-01',gross_premium_minor,currency,'ACTIVE' FROM policies WHERE id=?`,
        )
        .bind(
          'final-search-' + String(i).padStart(2, '0'),
          'FINAL-SEARCH-' + String(i).padStart(2, '0'),
          'FINALSEARCH' + String(i).padStart(2, '0'),
          pid,
        ),
    ),
  );
  for (const actor of [0, 1, 2]) {
    stage = 'beyond20-actor-' + actor;
    const cp =
      actor === 0
        ? page
        : await (
            await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } })
          ).newPage();
    if (actor) await login(cp, actor);
    await cp.goto(p.origin + '/customers/demo-customer-0?section=policies');
    await cp.getByRole('searchbox', { name: 'Bu müşterinin tüm poliçelerinde ara' }).waitFor();
    const first = await api(
      cp,
      '/api/policies?customerId=demo-customer-0&pageSize=20&includeLabels=true',
    );
    assert.equal(first.status, 200);
    assert.equal(first.data.items.length, 20);
    assert.ok(!first.data.items.some((x) => x.id === 'final-search-29'));
    await cp
      .getByRole('searchbox', { name: 'Bu müşterinin tüm poliçelerinde ara' })
      .fill('FINAL-SEARCH-29');
    await click(cp, 'Poliçelerde ara');
    await cp.getByRole('link', { name: 'FINAL-SEARCH-29', exact: true }).waitFor();
    const found = await api(
      cp,
      '/api/policies?customerId=demo-customer-0&pageSize=20&includeLabels=true&customerSearch=FINAL-SEARCH-29',
    );
    assert.deepEqual(
      found.data.items.map((x) => x.id),
      ['final-search-29'],
    );
    for (const width of [1440, 1200, 768, 390]) {
      await cp.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await shot(cp, 'actor-' + actor + '-search-' + width);
    }
    await cp.getByRole('link', { name: 'FINAL-SEARCH-29', exact: true }).click();
    await cp.getByRole('heading', { name: 'FINAL-SEARCH-29', exact: true }).waitFor();
    assert.ok(cp.url().includes('/policies/final-search-29'));
    await cp.getByRole('link', { name: '← Müşterinin poliçe aramasına dön', exact: true }).click();
    await cp.getByRole('link', { name: 'FINAL-SEARCH-29', exact: true }).waitFor();
    assert.equal(
      await cp.getByRole('searchbox', { name: 'Bu müşterinin tüm poliçelerinde ara' }).inputValue(),
      'FINAL-SEARCH-29',
    );
    await cp.getByRole('link', { name: 'FINAL-SEARCH-29', exact: true }).click();
    await cp.getByRole('link', { name: 'Poliçe işlemleri (klasik)', exact: true }).click();
    await cp.getByRole('heading', { name: 'Poliçe Detayı', exact: true }).waitFor();
    assert.ok(cp.url().includes('policyId=final-search-29'));
    await cp.getByRole('button', { name: 'Poliçeyi Düzenle', exact: true }).waitFor();
    assert.equal(
      await cp.getByRole('button', { name: 'Poliçeyi Düzenle', exact: true }).count(),
      1,
    );
    for (const width of [1440, 768, 390]) {
      await cp.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await shot(cp, 'actor-' + actor + '-legacy-context-' + width);
    }
    report.checks.push(
      'ACTOR_' + actor + '_BEYOND20_SEARCH_EXACT_POLICY_LEGACY_HANDOFF_AND_SEARCH_RETURN',
    );
  }
  report.status = 'PASS';
  console.info(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      screens: report.screens.length,
      money: report.money,
    }),
  );
} catch (e) {
  report.status = 'FAIL';
  report.failure = { stage, error: String(e) };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
  await b?.close();
  await p?.close();
}
