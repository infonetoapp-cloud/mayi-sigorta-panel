/* global document,fetch,innerWidth */
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openAutomaticDemo } from '../../scripts/demo/automatic.mjs';
const out = 'personnel-evidence/v4';
let d,
  stage = 'setup';
const report = { checks: [], screens: [], errors: [], layouts: [] };
async function snap(p, name) {
  assert.equal(await p.locator('.temporary-secret').count(), 0);
  assert.equal(await p.locator('input[type=password]').count(), 0);
  await p.screenshot({
    path: out + '/after/' + name + '.png',
    fullPage: true,
    mask: [p.locator('[data-sensitive=true]')],
  });
  report.screens.push(name + '.png');
}
async function press(p, name) {
  await p.getByRole('button', { name, exact: true }).click();
}
async function cancel(p) {
  await press(p, 'Vazgeç');
  const b = p.getByRole('button', { name: 'Ayrılmayı onayla', exact: true });
  if (await b.count()) await b.click();
}
async function people(p) {
  return p.evaluate(async () => {
    const r = await fetch('/api/personnel');
    const j = await r.json();
    return j.data.personnel;
  });
}
async function edit(p, email) {
  await p
    .getByRole('row')
    .filter({ has: p.getByText(email, { exact: true }) })
    .getByRole('button', { name: 'İzinleri düzenle', exact: true })
    .click();
}
async function confirm(p) {
  await press(p, 'Kaydet');
  const dlg = p.getByRole('dialog', {
    name: 'Devam etmek için şifrenizi tekrar girin',
    exact: true,
  });
  for (let i = 0; i < 50; i++) {
    if (await dlg.count()) {
      await p.waitForFunction(
        () => document.querySelector('[role=dialog] input[type=password]')?.value?.length >= 32,
      );
      await dlg.getByRole('button', { name: 'Doğrula', exact: true }).click();
      return;
    }
    if (
      (await p.getByRole('button', { name: 'Aynı isteği yeniden dene', exact: true }).count()) ||
      (await p
        .getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
          exact: true,
        })
        .count())
    )
      return;
    await p.waitForTimeout(50);
  }
}
try {
  await mkdir(out + '/after', { recursive: true });
  d = await openAutomaticDemo();
  const [o, a, b] = d.pages;
  for (const p of d.pages) {
    p.setDefaultTimeout(15000);
    p.on('pageerror', () => report.errors.push('runtime'));
  }
  await o.goto(d.origin + '/personnel');
  await o.getByRole('button', { name: 'Listeyi yenile', exact: true }).waitFor();
  const rows = await people(o),
    target = rows.find((p) => p.id === 'demo-member-ahmet');
  assert.ok(target);
  stage = 'responsive';
  for (const width of [1440, 1200, 768, 390]) {
    await o.setViewportSize({ width, height: 1000 });
    await o.getByText(target.login_email, { exact: true }).waitFor();
    assert.equal(await o.locator('h1').count(), 1);
    const layout = await o.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      main: document.querySelectorAll('main').length,
    }));
    assert.ok(layout.scroll <= width + 1);
    assert.equal(layout.main, 1);
    report.layouts.push(layout);
    await snap(o, 'list-' + width);
    await edit(o, target.login_email);
    await o.getByLabel('İzin ara', { exact: true }).fill('Müşteri');
    await snap(o, 'permissions-' + width);
    await press(o, 'Vazgeç');
    const row = o
      .getByRole('row')
      .filter({ has: o.getByText(target.login_email, { exact: true }) });
    await row.locator('summary').click();
    await o.waitForFunction(() => {
      const r = document
        .querySelector('.personnel-actions details[open] .personnel-action-menu')
        ?.getBoundingClientRect();
      return r && r.x >= 0 && r.right <= innerWidth + 1;
    });
    const box = await row.locator('.personnel-action-menu').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
    await row.locator('summary').press('Escape');
    assert.equal(await row.locator('details').getAttribute('open'), null);
  }
  report.checks.push('FOUR_VIEWPORTS_SINGLE_HEADING_NO_BODY_OVERFLOW_KEYBOARD_ACCOUNT_MENU');
  await o.setViewportSize({ width: 1440, height: 1000 });
  stage = 'permission-search-diff';
  await edit(o, target.login_email);
  await o.getByLabel('Müşteri Görüntüleme kapsamı', { exact: true }).selectOption('ASSIGNED');
  const diff = o.getByRole('region', { name: 'Mevcut ve önerilen izinler' });
  assert.ok((await diff.innerText()).includes('Acente geneli'));
  assert.ok((await diff.innerText()).includes('Atanan kayıtlar'));
  assert.equal(
    (await people(o))
      .find((p) => p.id === target.id)
      .grants.find((g) => g.permission_code === 'customer.read').scope,
    'AGENCY',
  );
  await snap(o, 'proposed-difference');
  await o.getByRole('button', { name: 'Standart ortak çalışma izinlerini taslağa uygula' }).click();
  assert.equal((await people(o)).find((p) => p.id === target.id).version, target.version);
  await cancel(o);
  report.checks.push('CURRENT_PROPOSED_DIFF_TEMPLATE_NEVER_WRITES_WITHOUT_CONFIRM');
  stage = 'browser-back-draft';
  await o.getByRole('link', { name: 'Müşteriler', exact: true }).click();
  await o.getByRole('link', { name: 'Personel ve İzinler', exact: true }).click();
  await edit(o, target.login_email);
  await o.getByLabel('Gerekçe', { exact: true }).fill('Korunan sentetik taslak');
  await o.goBack();
  await o.getByRole('dialog').waitFor();
  await press(o, 'Bu ekranda kal');
  assert.equal(new URL(o.url()).pathname, '/personnel');
  assert.equal(
    await o.getByLabel('Gerekçe', { exact: true }).inputValue(),
    'Korunan sentetik taslak',
  );
  await cancel(o);
  report.checks.push('NATIVE_BROWSER_BACK_RETAINS_DRAFT_UNTIL_EXPLICIT_DECISION');
  stage = 'lost-grant';
  await edit(o, target.login_email);
  await o.getByLabel('Gerekçe', { exact: true }).fill('Güvenli onay kayıp yanıt kurtarma');
  let drop = true;
  const keys = [];
  await o.route('**/secure/api/personnel/grants', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    const response = await route.fetch();
    if (response.ok() && drop) {
      drop = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await confirm(o);
  await o.getByRole('button', { name: 'Aynı isteği yeniden dene', exact: true }).waitFor();
  assert.equal(await o.getByLabel('Gerekçe', { exact: true }).isDisabled(), true);
  await press(o, 'Aynı isteği yeniden dene');
  await o
    .getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
      exact: true,
    })
    .waitFor();
  assert.equal(new Set(keys).size, 1);
  await o.unroute('**/secure/api/personnel/grants');
  report.checks.push('LOST_GRANT_RESPONSE_EXACT_ISSUANCE_KEY_REPLAY');
  stage = 'lost-command';
  await edit(o, target.login_email);
  await o.getByLabel('Gerekçe', { exact: true }).fill('İşlem kayıp yanıt kurtarma');
  drop = true;
  const writes = [];
  await o.route('**/secure/api/personnel/commands', async (route) => {
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
  await confirm(o);
  await o.getByRole('button', { name: 'Aynı isteği yeniden dene', exact: true }).waitFor();
  await press(o, 'Çıkış Yap');
  assert.equal(await o.getByRole('dialog').count(), 0);
  await press(o, 'Aynı isteği yeniden dene');
  await o
    .getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
      exact: true,
    })
    .waitFor();
  assert.equal(writes.length, 2);
  assert.ok(writes[0].body === writes[1].body && writes[0].key === writes[1].key);
  await o.unroute('**/secure/api/personnel/commands');
  report.checks.push('LOST_COMMAND_EXACT_BODY_KEY_REPLAY_AND_LOGOUT_HOLD');
  stage = 'conflicting-edit';
  await edit(o, target.login_email);
  await o.getByLabel('Gerekçe', { exact: true }).fill('Eski sürüm taslağı');
  const other = await o.context().newPage();
  await other.goto(d.origin + '/personnel');
  await edit(other, target.login_email);
  await other.getByLabel('Gerekçe', { exact: true }).fill('Diğer pencerede gerçek güncelleme');
  await confirm(other);
  await other
    .getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
      exact: true,
    })
    .waitFor();
  await confirm(o);
  await o.getByRole('alert').waitFor();
  assert.equal(await o.getByLabel('Gerekçe', { exact: true }).inputValue(), 'Eski sürüm taslağı');
  await snap(o, 'conflict');
  await cancel(o);
  await other.close();
  report.checks.push('TWO_REAL_WINDOWS_STALE_CAS_REJECTS_WITH_DRAFT_PRESERVED');
  stage = 'one-time-lost-create';
  await press(o, 'Personel oluştur');
  await o.getByLabel('Ad soyad', { exact: true }).fill('Sentetik Kayıp Yanıt');
  const email = 'lost-v4@example.invalid';
  await o.getByLabel('Giriş e-postası', { exact: true }).fill(email);
  drop = true;
  await o.route('**/secure/api/personnel/commands', async (route) => {
    const response = await route.fetch();
    if (drop) {
      drop = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await press(o, 'Onayla ve oluştur');
  await o.getByRole('button', { name: 'Aynı isteği yeniden dene', exact: true }).waitFor();
  await press(o, 'Aynı isteği yeniden dene');
  await o.getByText(/tek seferlik şifre yanıtı yeniden gösterilemez/).waitFor();
  assert.equal(
    await d.db
      .prepare('SELECT count(*) n FROM local_credentials WHERE login_email=?')
      .bind(email)
      .first('n'),
    1,
  );
  await snap(o, 'one-time-response-unavailable');
  await o.unroute('**/secure/api/personnel/commands');
  report.checks.push('LOST_TEMPORARY_RESPONSE_NO_REDISCLOSURE_NO_DUPLICATE_CREATE');
  stage = 'member-denial';
  for (const p of [a, b]) {
    const code = await p.evaluate(async () => (await fetch('/api/personnel?search=demo')).status);
    assert.ok(code === 401 || code === 403);
  }
  report.checks.push('MEMBER_DENIED_MANAGEMENT_AND_SEARCH');
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
  await writeFile(out + '/browser-v4.json', JSON.stringify(report, null, 2));
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
    out + '/browser-v4-failure.json',
    JSON.stringify({ status: 'FAIL', stage, kind: error?.name, checks: report.checks }, null, 2),
  );
  console.error(
    'V4_PERSONNEL_FAIL',
    stage,
    error?.name,
    String(error?.stack ?? '')
      .split('\n')
      .filter((line) => line.includes('v4-personnel.smoke.mjs:'))
      .pop(),
  );
  process.exitCode = 1;
} finally {
  await d?.close();
}
