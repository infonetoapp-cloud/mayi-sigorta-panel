/* global document, fetch, crypto, getComputedStyle, localStorage, sessionStorage */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const mode = process.env.MAYI_COMPLETION_MODE ?? 'operations';
const out = (process.env.MAYI_COMPLETION_OUT ?? 'completion-evidence/browser') + '/' + mode;
const result = { checks: [], screens: [], layouts: [], errors: [], external: [] };
let preview,
  browser,
  stage = 'setup';
const button = (p, name) => p.getByRole('button', { name, exact: true });
async function api(p, path, method = 'GET', body) {
  return p.evaluate(
    async ({ path, method, body }) => {
      const headers = {};
      if (method !== 'GET') {
        const token = (await (await fetch('/api/csrf-token')).json()).data.token;
        headers['x-csrf-token'] = token;
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
async function snap(p, name) {
  await p.evaluate(() => document.fonts.ready);
  const layout = await p.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    headings: document.querySelectorAll('h1').length,
    font: getComputedStyle(document.body).fontFamily,
  }));
  result.layouts.push({ name, ...layout });
  assert.ok(layout.scroll <= layout.width + 1, `overflow ${name}`);
  assert.equal(await p.getByRole('link', { name: /klasik|eski ekran/i }).count(), 0);
  await p.screenshot({
    path: `${out}/${name}.png`,
    fullPage: true,
    mask: [p.locator('input[type=password], [data-sensitive=true], .temporary-secret')],
  });
  result.screens.push(`${name}.png`);
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
}
async function login(p, actor) {
  await p.goto(preview.origin);
  await p.getByLabel('E-posta', { exact: true }).fill(preview.users[actor].email);
  await p.getByLabel('Şifre', { exact: true }).fill(preview.passwords[actor]);
  await button(p, 'Giriş Yap').click();
  await p.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
}
async function check(name) {
  result.checks.push(name);
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
}
try {
  await mkdir(out, { recursive: true });
  preview = await openOperationalPreview();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const pages = [];
  for (let actor = 0; actor < 3; actor++) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    const p = await context.newPage();
    p.setDefaultTimeout(20000);
    p.on('pageerror', () => result.errors.push({ stage, kind: 'runtime' }));
    p.on('request', (r) => {
      if (new URL(r.url()).origin !== preview.origin) result.external.push(new URL(r.url()).origin);
    });
    await login(p, actor);
    pages.push(p);
  }
  const [owner, full, ordinary] = pages;
  stage = 'full-grant';
  await owner.goto(preview.origin + '/personnel');
  const people = (await api(owner, '/api/personnel')).data.personnel;
  const target = people.find((p) => p.id === 'demo-member-ahmet');
  await owner
    .getByRole('row')
    .filter({ has: owner.getByText(target.login_email, { exact: true }) })
    .getByRole('button', { name: 'İzinleri düzenle', exact: true })
    .click();
  await button(owner, 'Tam Yetki Ver').click();
  await button(owner, 'Kaydet').click();
  const reauth = owner.getByRole('dialog', {
    name: 'Devam etmek için şifrenizi tekrar girin',
    exact: true,
  });
  await reauth
    .or(
      owner.getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
        exact: true,
      }),
    )
    .waitFor();
  if (await reauth.isVisible()) {
    await reauth.getByLabel('Şifre', { exact: true }).fill(preview.passwords[0]);
    await reauth.getByRole('button', { name: 'Doğrula', exact: true }).click();
  }
  await owner
    .getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
      exact: true,
    })
    .waitFor();
  await login(full, 1);
  assert.equal((await api(full, '/api/personnel')).status, 403);
  await check('EXPLICIT_FULL_MEMBER_NOT_OWNER');
  for (let actor = 0; actor < 3; actor++) {
    if (mode === 'operations' || mode !== `matrix-${actor}`) continue;
    const p = pages[actor];
    stage = `compatibility-${actor}`;
    for (const [old, expected] of [
      ['/customers/legacy', '/customers'],
      ['/policies/legacy?policyId=demo-policy-0', '/policies/demo-policy-0'],
      ['/today-work/legacy', '/today-work'],
    ]) {
      await p.goto(preview.origin + old);
      await p.waitForURL((u) => u.pathname === expected);
      await p.locator('h1').first().waitFor();
      assert.equal(await p.getByRole('link', { name: /klasik/i }).count(), 0);
    }
    await p.goto(preview.origin + '/policies/legacy?customerId=a&policyId=b');
    await p.getByRole('heading', { name: 'Bağlantının işlem hedefi belirsiz' }).waitFor();
    await check(`ROLE_${actor}_OLD_LINKS_MODERN_EQUIVALENT_AMBIGUOUS_DENY`);
    stage = `layout-${actor}`;
    for (const width of [1440, 1200, 768, 390]) {
      await p.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const [path, label, wait] of [
        ['/', 'overview', 'Genel Bakış'],
        ['/today-work', 'work', 'Bugünkü İşler'],
        ['/customers', 'customers', 'Müşteriler'],
        ['/customers/demo-customer-0/manage', 'customer-management', 'Deniz Yılmaz'],
        ['/policies', 'policies', 'Poliçe portföyü'],
        ['/policies/demo-policy-0', 'policy-detail', 'DEMO-0'],
        ['/customers/search-identity', 'identity-search', 'Kimlik numarasıyla müşteri bul'],
        ['/catalogs', 'catalogs', 'Kataloglar'],
        ['/agency-settings', 'settings', 'Acente Ayarları'],
        [
          '/personnel',
          'personnel',
          actor === 0 ? 'Personel ve İzinler' : 'Bu sayfaya erişiminiz yok',
        ],
        ['/account/password', 'account', 'Şifremi değiştir'],
      ]) {
        await p.goto(preview.origin + path);
        await p.getByRole('heading', { name: wait, exact: true }).waitFor();
        await snap(p, `${actor}-${label}-${width}`);
      }
    }
    stage = `identity-${actor}`;
    await p.goto(preview.origin + '/customers/search-identity');
    await p.getByLabel('Kimlik numarası', { exact: true }).fill('10000000146');
    const searchResponse = p.waitForResponse(
      (r) => r.url().endsWith('/api/customers/search-sensitive') && r.request().method() === 'POST',
    );
    await button(p, 'Müşteri Bul').click();
    assert.equal((await searchResponse).status(), actor === 1 ? 200 : 403);
    await p.getByRole(actor === 1 ? 'status' : 'alert').waitFor();
    assert.ok(!p.url().includes('10000000146'));
    await snap(p, `${actor}-identity-result-390`);
    assert.deepEqual(await p.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await check(`ROLE_${actor}_BODY_ONLY_IDENTITY_SEARCH_SCOPE`);
  }
  if (mode === 'operations') {
    stage = 'policy-amendment';
    await full.setViewportSize({ width: 1440, height: 1000 });
    await full.goto(preview.origin + '/policies/demo-policy-0?section=amendments');
    await button(full, 'Zeyil ekle').click();
    await full.getByLabel('Dış zeyil referansı', { exact: true }).fill('MODERN-ZEYIL-001');
    await full.getByLabel('Geçerlilik tarihi', { exact: true }).fill('2026-10-26');
    await full.getByLabel('Açıklama', { exact: true }).fill('Sentetik adres değişikliği kaydı');
    await full.getByLabel('Prim farkı', { exact: true }).fill('-0,50');
    await full.getByLabel('ISO para birimi', { exact: true }).fill('TRY');
    await button(full, 'Zeyili kaydet').click();
    await full.getByText('Zeyil eklendi.', { exact: true }).waitFor();
    const rows = (await api(full, '/api/policies/demo-policy-0/amendments')).data;
    assert.equal(
      rows.find((r) => r.externalReference === 'MODERN-ZEYIL-001').premiumDifferenceMinor,
      -50,
    );
    await snap(full, 'full-member-zeyil-signed-money');
    await full.getByRole('link', { name: 'Dış referanslar', exact: true }).click();
    await button(full, 'Dış referans ekle').click();
    await full.getByLabel('Kaynak sistem', { exact: true }).fill('SYNTHETIC');
    await full.getByLabel('Dış sistem poliçe numarası', { exact: true }).fill('MODERN-REF-001');
    await button(full, 'Referansı kaydet').click();
    await full.getByText('Dış referans eklendi.', { exact: true }).waitFor();
    await check('FULL_MEMBER_MODERN_ZEYIL_MINUS_50_AND_EXTERNAL_REFERENCE');
    stage = 'whatsapp';
    const tasks = (await api(ordinary, '/api/tasks/today?limit=50')).data.items;
    const task = tasks.find((t) => t.renewalId && t.customerId);
    assert.ok(task);
    const contactCustomer = (await api(ordinary, '/api/customers/' + task.customerId)).data;
    assert.equal(
      (
        await api(ordinary, '/api/customers/' + task.customerId, 'PATCH', {
          expectedVersion: contactCustomer.version,
          phone: '+905550000123',
        })
      ).status,
      200,
    );
    await ordinary.goto(
      preview.origin + `/today-work?task=${task.taskId}&queue=WORK&work=interactions`,
    );
    await ordinary.locator('.today-workspace[data-selected=true]').waitFor();
    const communication = button(ordinary, 'İletişim');
    if ((await communication.getAttribute('aria-expanded')) === 'false')
      await communication.click();
    const whatsappResponse = ordinary.waitForResponse((r) => r.url().includes('/whatsapp-preview'));
    await button(ordinary, 'WhatsApp önizle').click();
    const previewResponse = await whatsappResponse;
    if (previewResponse.status() !== 200) {
      const failure = await previewResponse.json();
      throw new Error(`WHATSAPP_PREVIEW_${previewResponse.status()}_${failure.error?.code}`);
    }
    await ordinary
      .getByLabel('WhatsApp taslağı', { exact: true })
      .waitFor()
      .catch(async (error) => {
        await writeFile(
          `${out}/whatsapp-dom.txt`,
          await ordinary
            .getByRole('region', { name: 'Yenileme iletişim geçmişi ve kaydı', exact: true })
            .innerText(),
        );
        const payload = await previewResponse.json();
        await writeFile(
          `${out}/whatsapp-shape.json`,
          JSON.stringify({
            keys: Object.keys(payload),
            dataKeys: Object.keys(payload.data ?? {}),
            contactIsNull: payload.data?.companyContactId === null,
            versionType: typeof payload.data?.expectedRenewalVersion,
            phoneType: typeof payload.data?.phone,
          }),
        );
        throw error;
      });
    await ordinary
      .getByLabel('WhatsApp taslağı', { exact: true })
      .fill('Sentetik önizleme; dış mesaj gönderilmez.');
    await snap(ordinary, 'ordinary-whatsapp-modern-preview');
    await button(ordinary, 'Taslağı kapat').click();
    await check('ORDINARY_MODERN_WHATSAPP_PREVIEW_NO_EXTERNAL_SEND');
    stage = 'secure';
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await owner.goto(preview.origin + '/policies/demo-policy-0');
    await owner
      .getByRole('link', { name: 'Aynı numarayla farklı sözleşme kaydet', exact: true })
      .click();
    if (await owner.locator('#reauth-form').count()) {
      await owner.getByLabel('Şifre', { exact: true }).fill(preview.passwords[0]);
      await button(owner, 'Doğrula').click();
    }
    await owner
      .getByRole('heading', { name: 'Aynı numarayla farklı sözleşme', exact: true })
      .waitFor();
    for (const width of [1440, 1200, 768, 390]) {
      await owner.setViewportSize({ width, height: 1000 });
      await snap(owner, `secure-confirm-${width}`);
    }
    await owner
      .getByLabel('Gerekçe', { exact: true })
      .fill('Sentetik farklı sözleşme yerel kabul denemesi');
    const response = owner.waitForResponse(
      (r) => r.url().endsWith('/identity-variants') && r.request().method() === 'POST',
    );
    await button(owner, 'Onayla ve farklı sözleşmeyi kaydet').click();
    const written = await response;
    assert.equal(written.status(), 201);
    const created = (await written.json()).data;
    assert.ok(created.id !== 'demo-policy-0');
    assert.equal((await api(owner, '/api/policies/' + created.id)).status, 200);
    await owner
      .getByText('Farklı sözleşme kaydı güvenli onayla oluşturuldu.', { exact: true })
      .waitFor();
    await snap(owner, 'secure-confirm-success');
    await check('OWNER_MODERN_SECURE_REAUTH_GRANT_COMMAND_REAL_D1_NEW_POLICY');
    await owner.getByRole('link', { name: 'Poliçeye dön', exact: true }).focus();
    await owner.keyboard.press('Enter');
    await owner.getByRole('heading', { name: 'DEMO-0', exact: true }).waitFor();
    await button(owner, 'Menüyü aç').focus();
    await owner.keyboard.press('Enter');
    await owner
      .getByRole('banner')
      .getByRole('button', { name: 'Menüyü kapat', exact: true })
      .waitFor();
    await owner.keyboard.press('Escape');
    assert.equal(
      await button(owner, 'Menüyü aç').evaluate((element) => element === document.activeElement),
      true,
    );
    await owner.goto(preview.origin + '/customers/search-identity');
    await owner.getByLabel('Kimlik numarası', { exact: true }).focus();
    await owner.keyboard.press('Tab');
    assert.equal(
      await button(owner, 'Müşteri Bul').evaluate((element) => element === document.activeElement),
      true,
    );
    await check('KEYBOARD_SECURE_RETURN_MOBILE_DRAWER_ESCAPE_FOCUS_FORM_TAB');
  }
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.external, []);
  await check('NO_CLASSIC_LINK_RUNTIME_ERROR_OR_EXTERNAL_REQUEST');
  console.info('MODERNIZATION_COMPLETION_BROWSER_PASS');
} catch (error) {
  result.errors.push({ stage, message: error instanceof Error ? error.message : 'unknown' });
  console.error(
    'MODERNIZATION_COMPLETION_BROWSER_FAIL',
    stage,
    error instanceof Error ? error.message : 'unknown',
  );
  process.exitCode = 1;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
  await browser?.close();
  await preview?.close();
}
