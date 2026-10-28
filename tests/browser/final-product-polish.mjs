/* global document,innerWidth */
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const out = 'polish-evidence';
await mkdir(out, { recursive: true });
let preview,
  browser,
  stage = 'setup';
const checks = [],
  errors = [],
  external = [];
try {
  preview = await openOperationalPreview();
  assert.equal(preview.demo.runtime, 'workerd');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const c = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  assert.equal(
    (
      await c.request.post(preview.origin + '/api/auth/login', {
        headers: { origin: preview.origin },
        data: { email: preview.users[0].email, password: preview.passwords[0] },
      })
    ).status(),
    200,
  );
  const p = await c.newPage();
  p.setDefaultTimeout(20000);
  p.on('pageerror', () => errors.push('runtime'));
  p.on('request', (r) => {
    if (new URL(r.url()).origin !== preview.origin) external.push(new URL(r.url()).origin);
  });
  const b = (name) => p.getByRole('button', { name, exact: true });
  async function nav(path) {
    await p.goto(preview.origin + path);
    await p.locator('main h1').waitFor({ state: 'attached' });
    await p.waitForFunction(
      () =>
        ![...document.querySelectorAll('[role=status]')].some(
          (e) => e.checkVisibility() && /yükleniyor|güncelleniyor/.test(e.textContent),
        ),
    );
  }
  async function api(path, method = 'GET', body) {
    const csrf =
      method === 'GET'
        ? null
        : (await (await c.request.get(preview.origin + '/api/csrf-token')).json()).data.token;
    const r = await c.request.fetch(preview.origin + path, {
      method,
      ...(method === 'GET'
        ? {}
        : {
            headers: {
              origin: preview.origin,
              'x-csrf-token': csrf,
              'idempotency-key': randomUUID(),
            },
            data: body,
          }),
    });
    return { status: r.status(), data: (await r.json()).data };
  }
  await nav('/');
  const policy = (await api('/api/policies/demo-policy-0')).data;
  for (const width of [1440, 768, 390]) {
    stage = 'portfolio-' + width;
    await p.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await nav('/policies');
    const first = await p.locator('.pv4-table tbody tr').first().boundingBox();
    assert(first);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (width === 390) {
      assert(first.y < 600);
      assert(first.y + first.height <= 844);
      assert.equal(await p.getByLabel('Sıralama', { exact: true }).isVisible(), false);
    }
    await b('Gelişmiş filtreler').click();
    assert.equal(await p.getByLabel('Sıralama', { exact: true }).isVisible(), true);
    await p.getByLabel('Poliçe numarası', { exact: true }).fill('DEMO-0');
    await p.getByLabel('Eşleştirme', { exact: true }).selectOption('exact');
    await p.getByLabel('Sıralama', { exact: true }).selectOption('end_date_desc');
    await p.getByLabel('Poliçe durumu', { exact: true }).selectOption('ACTIVE');
    await p.getByLabel('Sigortacı', { exact: true }).selectOption('demo-insurer');
    await p.getByLabel('Bitiş başlangıcı', { exact: true }).fill(policy.endDate);
    await p.getByLabel('Bitiş sonu', { exact: true }).fill(policy.endDate);
    await b('Filtrele').click();
    await p.getByRole('link', { name: 'DEMO-0', exact: true }).waitFor();
    await p.waitForFunction(() => document.querySelectorAll('.pv4-table tbody tr').length === 1);
    const u = new URL(p.url());
    for (const [k, v] of Object.entries({
      search: 'DEMO-0',
      searchMode: 'exact',
      sort: 'end_date_desc',
      status: 'ACTIVE',
      insurerId: 'demo-insurer',
      endFrom: policy.endDate,
      endTo: policy.endDate,
    }))
      assert.equal(u.searchParams.get(k), v);
    await b('Gelişmiş filtreler').click();
    assert.equal(
      await p.getByRole('region', { name: 'Etkin filtreler', exact: true }).isVisible(),
      true,
    );
    if (width === 390)
      assert.equal(await p.getByLabel('Sıralama', { exact: true }).isVisible(), false);
    await b('DEMO-0 önizle').click();
    await p.getByRole('dialog', { name: 'Poliçe önizlemesi', exact: true }).waitFor();
    await b('Önizlemeyi kapat').click();
    assert.equal(new URL(p.url()).searchParams.get('insurerId'), 'demo-insurer');
    await b('Temizle').click();
    await p.waitForFunction(() => document.querySelectorAll('.pv4-table tbody tr').length > 1);
  }
  checks.push(
    'THREE_VIEWPORTS_COMPACT_MOBILE_FULL_FIRST_RECORD_ALL_FILTERS_SORT_ACTIVE_CHIPS_AND_EXACT_PREVIEW',
  );
  stage = 'customer360';
  await p.setViewportSize({ width: 390, height: 844 });
  const customerReads = [];
  const listener = (r) => {
    if (r.url().includes('/api/')) customerReads.push(new URL(r.url()).pathname);
  };
  p.on('request', listener);
  await nav('/customers/demo-customer-0');
  await p.locator('.coverage-summary').waitFor();
  p.off('request', listener);
  assert(!customerReads.some((x) => x.startsWith('/api/tasks')));
  assert.equal(
    await p
      .getByRole('heading', { name: 'Bir sonraki adım, doğru bağlamda.', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await p.getByRole('link', { name: 'İleri müşteri işlemleri', exact: true }).count(),
    1,
  );
  await p.getByRole('link', { name: 'İletişim', exact: true }).click();
  await b('Düzenle').click();
  await p.getByLabel('E-posta', { exact: true }).fill('taslak@example.invalid');
  await p.getByRole('link', { name: 'Genel bakış', exact: true }).click();
  await p.getByRole('link', { name: 'İletişim', exact: true }).click();
  assert.equal(
    await p.getByLabel('E-posta', { exact: true }).inputValue(),
    'taslak@example.invalid',
  );
  await b('Vazgeç').click();
  checks.push('CUSTOMER_AUTHORIZED_COVERAGE_NO_PRIVATE_TASK_READ_AND_CONTACT_DRAFT_PRESERVED');
  stage = 'personnel-mobile';
  await nav('/personnel');
  await p.getByLabel('Personel ara', { exact: true }).fill('ahmet');
  await b('Ara').click();
  await p.getByRole('row').filter({ hasText: 'ahmet@demo.invalid' }).waitFor();
  await b('Aramayı temizle').click();
  const before = (await api('/api/personnel')).data.personnel.find(
    (x) => x.id === 'demo-member-ahmet',
  );
  await p
    .getByRole('row')
    .filter({ hasText: 'ahmet@demo.invalid' })
    .getByRole('button', { name: 'İzinleri düzenle', exact: true })
    .click();
  await b('Tam Yetki Ver').click();
  assert.equal(await p.getByLabel('Gerekçe', { exact: true }).evaluate((e) => e.required), false);
  assert.equal(await p.getByLabel('Gerekçe', { exact: true }).isVisible(), false);
  const region = p.getByRole('region', { name: 'İzin karşılaştırma tablosu', exact: true });
  const compare = await region.boundingBox(),
    save = await b('Kaydet').boundingBox();
  assert(compare.y < 844);
  assert(save.y >= 0 && save.y + save.height <= 844);
  assert.equal(
    await p.getByLabel('Görev Görüntüleme kapsamı', { exact: true }).inputValue(),
    'AGENCY',
  );
  assert.equal(
    JSON.stringify(
      (await api('/api/personnel')).data.personnel.find((x) => x.id === before.id).grants,
    ),
    JSON.stringify(before.grants),
  );
  await b('Vazgeç').click();
  await b('Ayrılmayı onayla').click();
  checks.push(
    'MOBILE_EMPLOYEE_SEARCH_ONE_CLICK_FULL_DRAFT_NO_PREMATURE_WRITE_OPTIONAL_REASON_COMPARE_AND_SAVE_VISIBLE',
  );
  stage = 'daily-work';
  await nav('/today-work');
  const row = p.locator('.today-task-row').first();
  await row.focus();
  await row.press('ArrowDown');
  assert.equal(
    await p.evaluate(() => document.activeElement?.classList.contains('today-task-row')),
    true,
  );
  await row.click();
  await p.locator('.today-workspace[data-selected=true]').waitFor();
  await nav('/today-work');
  await b('Atanmamış işler').click();
  await p.getByText('Bu kuyrukta gösterilecek takip bulunmuyor.', { exact: true }).waitFor();
  assert.equal(await p.locator('.today-task-row').count(), 0);
  assert.equal(await p.locator('.today-queue section > h3').count(), 0);
  await b('Açık işlere dön').click();
  await p.locator('.today-task-row').first().waitFor();
  checks.push('DAILY_EXACT_SELECTION_KEYBOARD_TRUE_EMPTY_AND_RETURN_PRESERVED');
  stage = 'quote-version-create';
  const task = (await api('/api/tasks/today?limit=50')).data.items.find(
    (t) => t.customerId === 'demo-customer-0',
  );
  const url = '/policies/demo-policy-0?section=renewal&renewal=' + task.renewalId;
  await nav(url);
  await b('Teklif geçmişini aç').click();
  await b('Teklif 1 için yeni değişmez sürüm taslağı aç').click();
  await p
    .locator('#quote-validUntil')
    .fill(new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 16));
  await p.locator('#quote-premium').fill('1.450,50');
  await p
    .getByRole('checkbox', {
      name: 'Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum',
      exact: true,
    })
    .check();
  await b('Yeni değişmez sürümü oluştur').click();
  await p.getByText('Teklif kaydedildi ve geçmiş güncellendi.', { exact: true }).waitFor();
  let history = (await api('/api/renewals/' + task.renewalId + '/quotes')).data;
  const q = history.quotes[0],
    v = q.versions.find((x) => x.id === q.current_version_id);
  stage = 'quote-version-readback';
  assert.equal(q.versions.length, 2);
  assert.equal(v.gross_premium_minor, 145050);
  await nav(url);
  await b('Teklif geçmişini aç').click();
  stage = 'quote-current-layout';
  await p.locator('.quote-record').first().waitFor();
  await p.locator('.pv4-renewal-workspace').scrollIntoViewIfNeeded();
  assert.equal(await p.locator('.quote-version').first().getAttribute('data-current'), 'true');
  const money = await p
    .locator('.quote-version[data-current=true] .quote-version-premium')
    .first()
    .boundingBox();
  assert(money.y + money.height < 844);
  assert.equal(
    await p.getByText('Bu bölüm müşteriye mesaj göndermez.', { exact: true }).isVisible(),
    true,
  );
  checks.push(
    'REAL_IMMUTABLE_SECOND_VERSION_EXACT_MINOR_MONEY_CURRENT_FIRST_AND_NO_MESSAGE_DELIVERY_CLAIM',
  );
  stage = 'quote-sent-uncertain';
  await b('Teklifi gönderildi olarak kaydet').click();
  await p.locator('#sent-quote-choice').selectOption(q.id);
  const form = p.getByRole('form', { name: 'Gönderildi durum kaydı', exact: true });
  await form.getByRole('checkbox').check();
  const posts = [];
  let drop = true;
  await p.route('**/api/renewals/*/quotes/*/send', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    if (drop) {
      drop = false;
      assert.equal((await route.fetch()).status(), 201);
      await route.abort('failed');
    } else await route.continue();
  });
  await b('Gönderildi kaydını onayla').click();
  await b('Aynı gönderildi isteğini yeniden dene').waitFor();
  assert.equal(await b('Yeni teklif taslağı aç').isDisabled(), true);
  await b('Aynı gönderildi isteğini yeniden dene').click();
  await p.getByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/).waitFor();
  await p.unrouteAll({ behavior: 'wait' });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body === posts[1].body, true, 'same replay body');
  assert.equal(posts[0].key === posts[1].key, true, 'same replay key');
  const payload = JSON.parse(posts[0].body);
  assert.equal(payload.expectedQuoteVersion, q.version);
  assert.equal(payload.quoteVersionId, v.id);
  history = (await api('/api/renewals/' + task.renewalId + '/quotes')).data;
  const after = history.quotes.find((x) => x.id === q.id);
  assert.equal(after.status, 'SENT');
  assert.equal(after.current_version_id, v.id);
  assert.equal(after.versions.length, 2);
  assert.equal(
    after.events.filter((x) => x.event === 'SENT' && x.quote_version_id === v.id).length,
    1,
  );
  assert.equal(
    (await api('/api/renewals/' + task.renewalId + '/quotes/' + q.id + '/send', 'POST', payload))
      .status,
    409,
  );
  checks.push(
    'REAL_SENT_RECORD_RESPONSE_LOSS_SAME_BODY_KEY_ONE_EVENT_EXACT_VERSION_CAS_STALE_REJECTED_NO_EXTERNAL_SEND',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const report = { status: 'PASS', runtime: preview.demo.runtime, checks, errors, external };
  await writeFile(out + '/native-product-regression.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (e) {
  const failure = { status: 'FAIL', stage, name: e.name, checks };
  await writeFile(out + '/native-product-failure.json', JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await preview?.close();
}
