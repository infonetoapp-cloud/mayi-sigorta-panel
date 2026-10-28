/* global document,fetch,crypto,innerWidth,getComputedStyle,localStorage,sessionStorage */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const mode = process.env.MAYI_ACCEPTANCE_MODE ?? 'operations';
const matrixOnly = mode.startsWith('matrix-');
const out =
  (process.env.MAYI_ACCEPTANCE_EVIDENCE_DIR ?? 'acceptance-evidence/product') + '/' + mode;
const report = { checks: [], screens: [], layouts: [], findings: [], errors: [], external: [] };
let preview,
  browser,
  stage = 'setup';
const click = (p, name) => p.getByRole('button', { name, exact: true }).click();
async function api(p, path, method = 'GET', body) {
  return p.evaluate(
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
function ok(r, status = 200) {
  assert.equal(r.status, status, stage);
  return r.data;
}
async function check(name) {
  report.checks.push(name);
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
}
async function login(p, i) {
  await p.goto(preview.origin);
  await p.getByLabel('E-posta', { exact: true }).fill(preview.users[i].email);
  await p.getByLabel('Şifre', { exact: true }).fill(preview.passwords[i]);
  await click(p, 'Giriş Yap');
  await p.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
}
async function reauth(o) {
  const d = o.getByRole('dialog', { name: 'Devam etmek için şifrenizi tekrar girin', exact: true });
  const result = o.getByText(
    'İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.',
    { exact: true },
  );
  await d.or(result).waitFor();
  if (await d.count()) {
    await d.getByLabel('Şifre', { exact: true }).fill(preview.passwords[0]);
    await d.getByRole('button', { name: 'Doğrula', exact: true }).click();
  }
  await result.waitFor();
}
async function permissions(o, target, edit) {
  await o.goto(preview.origin + '/personnel');
  const people = ok(await api(o, '/api/personnel')).personnel;
  const t = people.find((x) => x.id === target);
  assert.ok(t);
  await o
    .getByRole('row')
    .filter({ has: o.getByText(t.login_email, { exact: true }) })
    .getByRole('button', { name: 'İzinleri düzenle', exact: true })
    .click();
  await edit();
  await click(o, 'Kaydet');
  await reauth(o);
  return ok(await api(o, '/api/personnel')).personnel.find((x) => x.id === target);
}
async function snap(p, name) {
  assert.equal(await p.locator('input[type=password],.temporary-secret').count(), 0);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({
    path: out + '/' + name + '.png',
    fullPage: true,
    mask: [p.locator('[data-sensitive=true]')],
  });
  report.screens.push(name + '.png');
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
}
async function tab(p, name) {
  await p
    .getByRole('navigation', { name: 'Müşteri bölümleri' })
    .getByRole('link', { name, exact: true })
    .click();
}
async function openTask(p, t) {
  await p.goto(preview.origin + `/today-work?task=${encodeURIComponent(t.taskId)}&queue=WORK`);
  await p.locator('.today-workspace[data-selected=true]').waitFor();
  assert.ok(
    (await p.getByRole('region', { name: 'Seçili görev özeti', exact: true }).innerText()).includes(
      t.policyNumber,
    ),
  );
}
async function section(p, name) {
  const b = p.getByRole('button', { name, exact: true });
  if ((await b.getAttribute('aria-expanded')) === 'false') await b.click();
}
try {
  await mkdir(out, { recursive: true });
  preview = await openOperationalPreview();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const c = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      }),
      p = await c.newPage();
    p.setDefaultTimeout(18000);
    p.on('pageerror', () => report.errors.push({ stage, kind: 'runtime' }));
    p.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin !== preview.origin) report.external.push(u.origin);
    });
    await login(p, i);
    pages.push(p);
  }
  const [o, f, m] = pages;
  stage = 'full-grant';
  const granted = await permissions(o, 'demo-member-ahmet', () => click(o, 'Tam Yetki Ver'));
  assert.equal(granted.type, 'MEMBER');
  assert.ok(granted.grants.some((g) => g.permission_code === 'task.team'));
  assert.ok(
    granted.grants.filter((g) => g.scope !== 'UNSCOPED').every((g) => g.scope === 'AGENCY'),
  );
  assert.equal(
    granted.grants.some((g) => g.permission_code === 'report.management'),
    false,
  );
  await login(f, 1);
  assert.equal((await api(f, '/api/personnel')).status, 403);
  await check('OWNER_UI_EXPLICIT_FULL_GRANT_MAXIMUM_SCOPES_MEMBER_NOT_OWNER');
  let cid = 'demo-customer-0',
    revokeTarget;
  if (!matrixOnly) {
    stage = 'customer-create';
    await o.goto(preview.origin + '/customers/new');
    await o.getByLabel('Müşteri türü', { exact: true }).selectOption('INDIVIDUAL');
    await o.getByLabel('Ad', { exact: true }).fill('Kabul');
    await o.getByLabel('Soyad', { exact: true }).fill('İpek Çağrı');
    await o.getByLabel('E-posta', { exact: true }).fill('acceptance-individual@example.invalid');
    await click(o, 'Müşteriyi kaydet');
    await o.getByRole('heading', { name: 'Kabul İpek Çağrı', exact: true }).waitFor();
    cid = new URL(o.url()).pathname.split('/')[2];
    assert.ok(cid && cid !== 'new');
    await tab(o, 'İletişim');
    await click(o, 'Düzenle');
    await o.getByLabel('Telefon', { exact: true }).fill('+90 555 000 0599');
    await click(o, 'İletişim bilgilerini kaydet');
    await o.getByText('İletişim bilgileri kaydedildi.', { exact: true }).waitFor();
    assert.equal(ok(await api(o, '/api/customers/' + cid)).phone, '+90 555 000 0599');
    await check('OWNER_REAL_UI_INDIVIDUAL_CREATE_EDIT_READBACK');
    stage = 'company-representative';
    await m.goto(preview.origin + '/customers/new');
    await m.getByLabel('Müşteri türü', { exact: true }).selectOption('COMPANY');
    await m.getByLabel('Şirket unvanı', { exact: true }).fill('Kabul Sentetik Nakliyat AŞ');
    await click(m, 'Müşteriyi kaydet');
    await m.getByRole('heading', { name: 'Kabul Sentetik Nakliyat AŞ', exact: true }).waitFor();
    const company = new URL(m.url()).pathname.split('/')[2];
    await tab(m, 'İletişim');
    await click(m, 'Yetkili ekle');
    await m.getByLabel('Yetkili adı', { exact: true }).fill('Deniz');
    await m.getByLabel('Yetkili soyadı', { exact: true }).fill('Sınama');
    await m.getByLabel('Görev / unvan', { exact: true }).fill('Filo');
    await m.getByLabel('Birincil yetkili olarak ata', { exact: true }).check();
    await click(m, 'Yetkiliyi kaydet');
    await m.getByText('Yetkili eklendi.', { exact: true }).waitFor();
    await click(m, 'Yetkiliyi düzenle');
    await m.getByLabel('Görev / unvan', { exact: true }).fill('Finans');
    await click(m, 'Değişiklikleri kaydet');
    await m.getByText('Yetkili bilgileri güncellendi.', { exact: true }).waitFor();
    assert.equal(ok(await api(o, '/api/customers/' + company)).contacts[0].role, 'Finans');
    await check('ORDINARY_MEMBER_UI_CORPORATE_CREATE_REPRESENTATIVE_EDIT_SHARED_OWNER_READ');
    stage = 'policy-financial';
    await f.goto(preview.origin + '/customers/' + cid);
    await f.getByRole('link', { name: 'Poliçe ekle', exact: true }).click();
    await f.getByRole('form', { name: 'Poliçe sözleşme formu' }).waitFor();
    assert.equal(await f.getByLabel('Müşteri', { exact: true }).inputValue(), cid);
    for (const [label, value] of [
      ['Sigorta şirketi', 'demo-insurer'],
      ['Branş', 'demo-branch'],
      ['Ürün', 'demo-product'],
      ['Ödeme yöntemi', 'demo-payment'],
    ])
      await f.getByLabel(label, { exact: true }).selectOption(value);
    await f.getByLabel('Poliçe numarası', { exact: true }).fill('ACCEPTANCE-UI-2026');
    await f.getByLabel('Başlangıç tarihi', { exact: true }).fill('2026-01-01');
    await f
      .getByLabel('Bitiş tarihi', { exact: true })
      .fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    await f.getByLabel('Brüt prim', { exact: true }).fill('12.500');
    await click(f, 'Poliçeyi oluştur');
    await f.locator('#contract-grossPremium[aria-invalid=true]').waitFor();
    await snap(f, 'ambiguous-money-rejected');
    await f.getByLabel('Brüt prim', { exact: true }).fill('12.500,50');
    await click(f, 'Poliçeyi oluştur');
    await f.waitForURL(/\/policies\/[^/?]+$/);
    const pid = new URL(f.url()).pathname.split('/')[2];
    let policy = ok(await api(f, '/api/policies/' + pid));
    assert.equal(policy.customerId, cid);
    assert.equal(policy.grossPremiumMinor, 1250050);
    await f.getByRole('link', { name: 'Poliçeyi düzenle', exact: true }).click();
    await f.getByLabel('Brüt prim', { exact: true }).fill('12.501,75');
    await click(f, 'Değişiklikleri kaydet');
    await f.waitForURL('**/policies/' + pid);
    policy = ok(await api(f, '/api/policies/' + pid));
    assert.equal(policy.grossPremiumMinor, 1250175);
    await check('FULL_MEMBER_UI_CUSTOMER_POLICY_LINK_TURKISH_MONEY_VALIDATION_PERSISTENCE_EDIT');
    stage = 'upcoming-link';
    const q = ok(await api(f, '/api/tasks/today?limit=50'));
    let task = q.items.find((t) => t.policyId === pid);
    assert.ok(task);
    assert.equal(task.customerId, cid);
    await openTask(f, task);
    await f.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
    await f.getByRole('heading', { name: 'Kabul İpek Çağrı', exact: true }).waitFor();
    await f.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
    await f.locator('.today-workspace[data-selected=true]').waitFor();
    assert.equal(new URL(f.url()).searchParams.get('task'), task.taskId);
    await check('NEW_POLICY_REAL_RENEWAL_TASK_EXACT_CROSS_MODULE_RETURN');
    stage = 'quotation';
    await section(f, 'Teklifler');
    await click(f, 'Teklif geçmişini aç');
    await click(f, 'Yeni teklif taslağı aç');
    await f.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('13.250,75');
    await f
      .getByLabel('Teklif geçerlilik sonu (İstanbul)', { exact: true })
      .fill(new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 19));
    await f.getByLabel('Yeni teklif kaydını oluşturmayı onaylıyorum', { exact: true }).check();
    await click(f, 'Teklifi oluştur');
    await f
      .getByRole('button', { name: 'Teklif 1 için yeni değişmez sürüm taslağı aç', exact: true })
      .waitFor();
    const endpoint = '/api/renewals/' + task.renewalId + '/quotes';
    let quotes = ok(await api(f, endpoint));
    const quote = quotes.quotes.find((x) =>
      x.versions.some((v) => v.gross_premium_minor === 1325075),
    );
    assert.ok(quote);
    const v1 = quote.versions[0];
    await click(f, 'Teklif 1 için yeni değişmez sürüm taslağı aç');
    assert.equal(await f.getByLabel('Teklif sigorta şirketi', { exact: true }).isDisabled(), true);
    await f.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('13.500,25');
    await f
      .getByLabel('Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum', { exact: true })
      .check();
    await click(f, 'Yeni değişmez sürümü oluştur');
    await f
      .getByRole('button', { name: 'Teklif 1 için yeni değişmez sürüm taslağı aç', exact: true })
      .waitFor();
    quotes = ok(await api(f, endpoint));
    const saved = quotes.quotes.find((x) => x.id === quote.id);
    assert.equal(saved.versions.length, 2);
    assert.deepEqual(
      saved.versions.find((v) => v.id === v1.id),
      v1,
    );
    assert.ok(saved.versions.some((v) => v.gross_premium_minor === 1350025));
    await snap(f, 'immutable-quotation-history');
    await check('REAL_UI_QUOTE_CREATE_REVISE_IMMUTABLE_IDENTITY_TWO_FINANCIAL_VERSIONS');
    stage = 'interaction-followup';
    await section(f, 'İletişim');
    await click(f, 'İletişim kaydı ekle');
    await f.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
    await f.getByLabel('İç not', { exact: true }).fill('Bağımsız kabul görüşme kaydı');
    await click(f, 'İletişim kaydını kaydet');
    await f
      .getByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.', { exact: true })
      .waitFor();
    assert.ok(
      ok(await api(f, '/api/renewals/' + task.renewalId + '/interactions')).interactions.some(
        (x) => x.note === 'Bağımsız kabul görüşme kaydı',
      ),
    );
    await section(f, 'Görev işlemleri');
    await click(f, 'Yeni takip planını aç');
    await f
      .getByLabel('Yeni takip zamanı (İstanbul)', { exact: true })
      .fill(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + 'T11:15');
    await f
      .getByLabel('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum', { exact: true })
      .check();
    await click(f, 'Takibi tamamla ve planla');
    await f.getByText(/Takip tamamlandı/).waitFor();
    const replacement = ok(await api(f, '/api/tasks/today?limit=50')).items.find(
      (t) => t.policyId === pid,
    );
    assert.ok(replacement);
    assert.notEqual(replacement.taskId, task.taskId);
    assert.equal(replacement.renewalId, task.renewalId);
    await check('UI_INTERACTION_COMPLETE_FOLLOWUP_REPLACEMENT_SAME_CUSTOMER_POLICY_RENEWAL');
    stage = 'team-assignment';
    const all = ok(await api(o, '/api/tasks/today?limit=50'));
    const team = all.items.find((t) => t.policyId === 'demo-policy-1');
    revokeTarget = all.items.find((t) => t.policyId === 'demo-policy-3');
    assert.ok(team && revokeTarget);
    assert.equal(team.assigneeMembershipId, 'demo-member-ayse');
    assert.equal((await api(m, '/api/tasks/' + team.taskId + '/context')).status, 200);
    assert.equal(
      (
        await api(
          m,
          '/api/tasks/' + all.items.find((t) => t.policyId === 'demo-policy-0').taskId + '/context',
        )
      ).status,
      404,
    );
    await openTask(f, team);
    await section(f, 'Görev işlemleri');
    await click(f, 'Görev atama seçeneklerini aç');
    await f.getByLabel('Yeni görev sorumlusu', { exact: true }).selectOption('demo-member-ahmet');
    await f
      .getByLabel('Görev ve yenileme sorumlusunu değiştirmeyi onaylıyorum', { exact: true })
      .check();
    await click(f, 'Görev sorumlusunu kaydet');
    await f.getByText(/Görev ve yenileme sorumlusu değiştirildi/).waitFor();
    assert.equal((await api(m, '/api/tasks/' + team.taskId + '/context')).status, 404);
    assert.equal(
      ok(await api(o, '/api/tasks/' + team.taskId + '/context')).items.find(
        (t) => t.taskId === team.taskId,
      ).assigneeMembershipId,
      'demo-member-ahmet',
    );
    await check('FULL_MEMBER_REAL_UI_TEAM_ASSIGNMENT_AND_ORDINARY_LIVE_SCOPE_LOSS');
    stage = 'catalog-settings';
    await f.goto(preview.origin + '/catalogs');
    await click(f, 'Yeni kayıt');
    await f.getByLabel('Kod', { exact: true }).fill('ACCEPTANCE_INS');
    await f.getByLabel('Ad', { exact: true }).fill('Kabul Sentetik Sigortacı');
    await click(f, 'Kaydet');
    await f
      .getByText('Kayıt kaydedildi. Güncel katalog listesi yenilendi.', { exact: true })
      .waitFor();
    const insurer = ok(await api(f, '/api/catalogs/insurers')).find(
      (x) => x.code === 'ACCEPTANCE_INS',
    );
    assert.ok(insurer);
    await f.goto(preview.origin + '/agency-settings');
    await f.getByLabel('Varsayılan sigorta şirketi', { exact: true }).selectOption(insurer.id);
    await f.getByLabel('Takibe başlama süresi', { exact: true }).fill('40');
    await click(f, 'Ayarları kaydet');
    await f.getByText('Ayarlar kaydedildi. Güncel değerler doğrulandı.', { exact: true }).waitFor();
    assert.equal(ok(await api(o, '/api/agency/settings')).defaultInsurerId, insurer.id);
    await m.goto(preview.origin + '/agency-settings');
    await m.getByText('Salt okunur', { exact: true }).waitFor();
    assert.equal(await m.locator('.settings-field input,.settings-field select').count(), 0);
    assert.equal(
      (await api(m, '/api/agency/settings', 'PATCH', { expectedVersion: 1, renewalWindowDays: 1 }))
        .status,
      403,
    );
    await check('FULL_MEMBER_UI_CATALOG_CREATE_SETTINGS_SAVE_ORDINARY_READONLY_DIRECT_403');
  }
  const modules = [
    ['overview', '/', 'h1'],
    ['daily', '/today-work', '.today-task-row'],
    ['customer', '/customers/' + cid, '.c360-title h1'],
    ['portfolio', '/policies', '.pv4-table'],
    ['personnel', '/personnel', 'h1'],
    ['catalog', '/catalogs', '.catalog-table[aria-busy=false]'],
    ['settings', '/agency-settings', '.settings-v4[aria-busy=false] .settings-surface'],
  ];
  stage = 'matrix';
  const actors = matrixOnly ? [Number(mode.split('-')[1])] : [];
  for (const actor of actors)
    for (const width of [1440, 1200, 768, 390])
      for (const [name, path, ready] of modules) {
        const p = pages[actor];
        stage = `matrix-${actor}-${width}-${name}`;
        await p.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await p.goto(preview.origin + path);
        await p.locator(ready).first().waitFor();
        if (name === 'personnel' && actor)
          await p
            .getByRole('heading', { name: 'Bu sayfaya erişiminiz yok', exact: true })
            .waitFor();
        const layout = await p.evaluate(() => ({
          width: innerWidth,
          body: document.documentElement.scrollWidth,
          h1: document.querySelectorAll('h1').length,
          main: document.querySelectorAll('main').length,
          font: getComputedStyle(document.body).fontFamily,
          unnamed: [
            ...document.querySelectorAll(
              'main button,main input:not([type=hidden]),main select,main textarea',
            ),
          ]
            .filter(
              (e) =>
                e.getBoundingClientRect().width &&
                !e.getAttribute('aria-label') &&
                !e.labels?.length &&
                !e.textContent?.trim() &&
                !e.title,
            )
            .map((e) => ({ tag: e.tagName, type: e.type })),
          small: [...document.querySelectorAll('main button,main input,main select')].filter(
            (e) => e.getBoundingClientRect().width && e.getBoundingClientRect().height < 24,
          ).length,
        }));
        report.layouts.push({ actor, name, ...layout });
        if (layout.body > width + 1 || layout.h1 !== 1 || layout.main !== 1)
          report.findings.push({ stage, severity: 'P2', type: 'layout', layout });
        await snap(p, `${actor}-${name}-${width}`);
      }
  if (matrixOnly)
    await check('ACTOR_' + actors[0] + '_SEVEN_SURFACES_FOUR_WIDTHS_REAL_RENDER_MATRIX');
  if (!matrixOnly) {
    stage = 'team-revocation';
    for (const p of pages) await p.setViewportSize({ width: 1440, height: 1000 });
    assert.equal((await api(f, '/api/tasks/' + revokeTarget.taskId + '/context')).status, 200);
    await permissions(o, 'demo-member-ahmet', () =>
      o.getByRole('checkbox', { name: /^Ekip Görevlerine Erişim/ }).uncheck(),
    );
    await login(f, 1);
    assert.equal((await api(f, '/api/tasks/' + revokeTarget.taskId + '/context')).status, 404);
    await check('REAL_SECURE_TASK_TEAM_REVOKE_LEGACY_AGENCY_SCOPES_NO_LONGER_TEAM_READ');
  }
  assert.deepEqual((await preview.demo.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  for (const p of pages)
    assert.equal(await p.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
  report.status = 'PASS';
} catch (e) {
  report.status = 'FAIL';
  report.failure = { stage, error: String(e) };
  process.exitCode = 1;
} finally {
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
  await browser?.close();
  await preview?.close();
  console.info(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      screens: report.screens.length,
      findings: report.findings,
      failure: report.failure,
    }),
  );
}
