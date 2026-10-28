/* global document,innerWidth,fetch,crypto,getComputedStyle,localStorage,sessionStorage */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const phase = process.env.MAYI_SETTINGS_BASELINE === 'true' ? 'before' : 'after';
const out = process.env.MAYI_ACCEPTANCE_EVIDENCE_DIR ?? `settings-evidence/${phase}`;
const report = { checks: [], screens: [], geometry: [], errors: [] };
let p,
  b,
  stage = 'setup';
const button = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function api(page, path, method = 'GET', body, key) {
  return page.evaluate(
    async ({ path, method, body, key }) => {
      const headers = {};
      if (method !== 'GET') {
        const c = await (await fetch('/api/csrf-token')).json();
        headers['x-csrf-token'] = c.data.token;
        headers['content-type'] = 'application/json';
        headers['idempotency-key'] = key ?? crypto.randomUUID();
      }
      const r = await fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const j = await r.json();
      return { status: r.status, data: j.data, code: j.error?.code };
    },
    { path, method, body, key },
  );
}
async function snap(page, name) {
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: out + '/' + name + '.png', fullPage: true });
  report.screens.push(name + '.png');
  if (phase === 'after' && !/-\d+$/.test(name)) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: out + '/' + name + '-390.png', fullPage: true });
    report.screens.push(name + '-390.png');
    await page.setViewportSize(size);
  }
}
async function saved(page) {
  await page
    .getByText('Ayarlar kaydedildi. Güncel değerler doğrulandı.', { exact: true })
    .waitFor();
}
async function login(page, i) {
  await page.goto(p.origin);
  await page.getByLabel('E-posta', { exact: true }).fill(p.users[i].email);
  await page.getByLabel('Şifre', { exact: true }).fill(p.passwords[i]);
  await button(page, 'Giriş Yap');
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
}
async function settings(page) {
  await page.goto(p.origin + '/agency-settings');
  if (phase === 'before')
    await page.getByText('Acente Operasyonel Ayarları', { exact: true }).waitFor();
  else await page.locator('.settings-v4[aria-busy=false] .settings-surface').waitFor();
}
try {
  await mkdir(out, { recursive: true });
  p = await openOperationalPreview();
  b = await chromium.launch({ channel: 'msedge', headless: true });
  const pages = [];
  for (const i of [0, 1, 2]) {
    const c = await b.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      }),
      page = await c.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', () => report.errors.push('runtime'));
    await login(page, i);
    pages.push(page);
    if (i === 2) continue;
    await settings(page);
    for (const width of [1440, 1200, 768, 390]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (phase === 'after') {
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('main').count(), 1);
        report.geometry.push(
          await page.evaluate(() => ({
            width: innerWidth,
            body: document.documentElement.scrollWidth,
            fields: [
              ...document.querySelectorAll('.settings-field input,.settings-field select'),
            ].map((e) => ({
              height: e.getBoundingClientRect().height,
              width: e.getBoundingClientRect().width,
              font: getComputedStyle(e).fontFamily,
            })),
            sections: [...document.querySelectorAll('.settings-section')].map((e) => ({
              height: e.getBoundingClientRect().height,
              columns: getComputedStyle(e).gridTemplateColumns,
            })),
          })),
        );
      }
      await snap(page, `${i === 0 ? 'owner' : 'member'}-${width}`);
    }
    report.checks.push(`${i === 0 ? 'OWNER' : 'MEMBER'}_FOUR_WIDTHS`);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  if (phase === 'after') {
    const [o, m, e] = pages;
    stage = 'readonly';
    assert.equal(await m.locator('.settings-field input,.settings-field select').count(), 0);
    assert.equal(
      (await api(m, '/api/agency/settings', 'PATCH', { expectedVersion: 1, renewalWindowDays: 12 }))
        .status,
      403,
    );
    report.checks.push('ORDINARY_MEMBER_READONLY_AND_DIRECT_WRITE_403');
    stage = 'validation';
    await o.getByLabel('Takibe başlama süresi', { exact: true }).fill('1.5');
    await button(o, 'Ayarları kaydet');
    await o.getByRole('alert').waitFor();
    assert.match(await o.getByRole('alert').innerText(), /tam gün/);
    await snap(o, 'validation');
    await o.getByLabel('Takibe başlama süresi', { exact: true }).fill('45');
    await o.getByLabel('Saat dilimi', { exact: true }).fill('Europe/Berlin');
    await button(o, 'Ayarları kaydet');
    await saved(o);
    assert.equal((await api(o, '/api/agency/settings')).data.renewalWindowDays, 45);
    const originalInsurer = (await api(o, '/api/agency/settings')).data.defaultInsurerId;
    assert.ok(originalInsurer);
    await o.getByLabel('Varsayılan sigorta şirketi', { exact: true }).selectOption('');
    await button(o, 'Ayarları kaydet');
    await saved(o);
    assert.equal((await api(o, '/api/agency/settings')).data.defaultInsurerId, null);
    await o.getByLabel('Varsayılan sigorta şirketi', { exact: true }).selectOption(originalInsurer);
    await button(o, 'Ayarları kaydet');
    await saved(o);
    assert.equal((await api(o, '/api/agency/settings')).data.defaultInsurerId, originalInsurer);
    report.checks.push('DEFAULT_INSURER_UI_CLEAR_RESELECT_PERSISTED_NO_DEACTIVATION');
    await o.reload();
    await o.locator('.settings-surface').waitFor();
    assert.equal(await o.getByLabel('Saat dilimi', { exact: true }).inputValue(), 'Europe/Berlin');
    report.checks.push('VALIDATION_OWNER_SAVE_API_PERSISTENCE_REFRESH');
    await o.getByRole('link', { name: 'Poliçeler', exact: true }).click();
    await o.getByRole('heading', { name: 'Poliçe portföyü', exact: true }).waitFor();
    await o.getByRole('link', { name: 'Acente Ayarları', exact: true }).click();
    await o.locator('.settings-v4[aria-busy=false] .settings-surface').waitFor();
    stage = 'dirty';
    await o.getByLabel('Takibe başlama süresi', { exact: true }).fill('46');
    await o.getByRole('link', { name: 'Poliçeler', exact: true }).click();
    await o.getByRole('dialog').waitFor();
    await snap(o, 'unsaved-navigation');
    await button(o, 'Bu ekranda kal');
    assert.equal(await o.getByLabel('Takibe başlama süresi', { exact: true }).inputValue(), '46');
    await o.goBack();
    await o.getByRole('dialog').waitFor();
    await button(o, 'Bu ekranda kal');
    assert.ok(o.url().endsWith('/agency-settings'));
    await button(o, 'Çıkış Yap');
    await o.getByRole('dialog').waitFor();
    await button(o, 'Bu ekranda kal');
    report.checks.push('NATIVE_SPA_BACK_AND_LOGOUT_DRAFT_GUARD');
    await button(o, 'Değişiklikleri geri al');
    await button(o, 'Ayrılmayı onayla');
    report.checks.push('UNSAVED_ROUTE_STAY_AND_DISCARD');
    stage = 'conflict';
    await o.getByLabel('Takibe başlama süresi', { exact: true }).fill('47');
    let s = (await api(o, '/api/agency/settings')).data;
    assert.equal(
      (
        await api(o, '/api/agency/settings', 'PATCH', {
          expectedVersion: s.version,
          timezone: 'Europe/Istanbul',
        })
      ).status,
      200,
    );
    await button(o, 'Ayarları kaydet');
    await button(o, 'Güncel değerleri karşılaştır');
    await o
      .getByRole('button', { name: 'Taslağımı güncel kayıt üzerine hazırla', exact: true })
      .waitFor();
    await snap(o, 'conflict-comparison');
    await button(o, 'Taslağımı güncel kayıt üzerine hazırla');
    assert.equal(
      await o.getByLabel('Saat dilimi', { exact: true }).inputValue(),
      'Europe/Istanbul',
    );
    await button(o, 'Ayarları kaydet');
    await saved(o);
    report.checks.push('REAL_CAS_409_COMPARE_REBASE_PRESERVES_OTHER_FIELDS');
    stage = 'lost-response';
    const writes = [];
    let lose = true;
    await o.route('**/api/agency/settings', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      writes.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await o.getByLabel('Takibe başlama süresi', { exact: true }).fill('48');
    await button(o, 'Ayarları kaydet');
    await o.getByRole('button', { name: 'Aynı isteği yeniden dene', exact: true }).waitFor();
    await snap(o, 'uncertain-save');
    await o.getByRole('link', { name: 'Poliçeler', exact: true }).click();
    assert.match(await o.getByRole('alert').innerText(), /sonucu çözülmeden/);
    await button(o, 'Aynı isteği yeniden dene');
    await saved(o);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(
      await p.demo.db
        .prepare('SELECT count(*) n FROM audit_events WHERE idempotency_key=?')
        .bind(writes[0].key)
        .first('n'),
      1,
    );
    await o.unroute('**/api/agency/settings');
    report.checks.push('COMMITTED_LOST_RESPONSE_EXACT_RETRY_ONE_AUDIT_NAVIGATION_LOCK');
    stage = 'readback';
    let accepted = false,
      failRead = true;
    let patchCount = 0;
    await o.route('**/api/agency/settings', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchCount++;
        await route.continue();
        accepted = true;
        return;
      }
      if (accepted && failRead) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await o.getByLabel('Takibe başlama süresi', { exact: true }).fill('49');
    await button(o, 'Ayarları kaydet');
    await o.getByRole('button', { name: 'Kaydı yeniden kontrol et', exact: true }).waitFor();
    await snap(o, 'readback-recovery');
    failRead = false;
    await button(o, 'Kaydı yeniden kontrol et');
    await saved(o);
    assert.equal(patchCount, 1);
    await o.unroute('**/api/agency/settings');
    report.checks.push('ACCEPTED_WRITE_FAILED_GET_RECOVERY_NO_SECOND_PATCH');
    stage = 'delegated';
    await p.demo.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'agency.settings.manage','UNSCOPED')",
      )
      .bind(crypto.randomUUID(), 'demo-member-ayse')
      .run();
    await settings(e);
    await e.getByLabel('Takibe başlama süresi', { exact: true }).fill('50');
    await button(e, 'Ayarları kaydet');
    await saved(e);
    await snap(e, 'delegated-member');
    await e.getByLabel('Takibe başlama süresi', { exact: true }).fill('51');
    await p.demo.db
      .prepare(
        "DELETE FROM membership_permissions WHERE membership_id='demo-member-ayse' AND permission_code='agency.settings.manage'",
      )
      .run();
    await button(e, 'Ayarları kaydet');
    await e.getByText('Salt okunur', { exact: true }).waitFor();
    assert.equal(await e.locator('.settings-field input').count(), 0);
    assert.equal((await api(o, '/api/agency/settings')).data.renewalWindowDays, 50);
    await snap(e, 'revoked-permission-draft');
    report.checks.push('DELEGATED_MEMBER_REAL_SAVE_AND_LIVE_PERMISSION_LOSS_NO_WRITE');
    stage = 'session';
    await p.demo.db
      .prepare("UPDATE local_sessions SET revoked_at=? WHERE user_id='demo-user-owner'")
      .bind(Date.now())
      .run();
    await o.getByLabel('Takibe başlama süresi', { exact: true }).fill('52');
    await button(o, 'Ayarları kaydet');
    await o.getByRole('alert').waitFor();
    assert.match(await o.getByRole('alert').innerText(), /Oturumunuz sona erdi/);
    assert.equal((await api(o, '/api/agency/settings')).status, 401);
    await snap(o, 'expired-session');
    report.checks.push('REAL_SESSION_REVOCATION_FAIL_CLOSED');
    for (const page of pages)
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    report.checks.push('NO_BROWSER_PERSISTENCE');
  }
  assert.deepEqual(report.errors, []);
} catch (e) {
  report.failure = { stage, error: String(e) };
  process.exitCode = 1;
} finally {
  await b?.close();
  await p?.close();
  await writeFile(out + '/report.json', JSON.stringify(report, null, 2));
  console.info(JSON.stringify(report));
}
