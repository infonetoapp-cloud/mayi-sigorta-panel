// Real authenticated browser -> existing Hono APIs -> disposable synthetic D1.
/* global document, innerWidth, fetch, crypto, history */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { openAutomaticDemo } from '../../scripts/demo/automatic.mjs';
const out = process.env.MAYI_CUSTOMER_EVIDENCE ?? 'customer360-evidence/initial';
let demo,
  stage = 'setup';
const report = {
  mode: 'REAL_REACT_AUTH_API_LOCAL_D1',
  cells: [],
  checks: [],
  screens: [],
  errors: [],
  externalRequests: [],
};
async function save() {
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
}
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
      return { status: r.status, data: j.data };
    },
    { path, method, body },
  );
}
function ok(r, status = 200) {
  assert.equal(r.status, status, stage);
  return r.data;
}
async function click(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
}
async function tab(page, name) {
  await page
    .getByRole('navigation', { name: 'Müşteri bölümleri' })
    .getByRole('link', { name, exact: true })
    .click();
}
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out + '/' + name + '.png', fullPage: true });
  const g = await page.evaluate(() => ({
    width: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    font: document.fonts.check('500 14px Geist'),
    tabs: [...document.querySelectorAll('.customer-section-nav a')].map((e) => ({
      text: e.textContent,
      height: e.getBoundingClientRect().height,
    })),
    outside: [
      ...document.querySelectorAll('main button,main input,main select,main textarea,main a'),
    ]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width && (r.right > innerWidth + 1 || r.left < -1);
      })
      .map((e) => e.getAttribute('aria-label') ?? e.textContent.slice(0, 60)),
    identity: document.querySelector('.c360-identity')?.getBoundingClientRect().toJSON(),
    main: document.querySelector('.c360-main')?.getBoundingClientRect().toJSON(),
  }));
  assert.ok(g.pageWidth <= g.width + 1, name + ': page overflow');
  assert.deepEqual(g.outside, [], name + ': controls overflow');
  assert.ok(g.font, name);
  assert.ok(
    g.tabs.every((tab) => tab.height >= 44),
    name + ': section touch target',
  );
  report.screens.push({ file: name + '.png', ...g });
  await save();
}
try {
  await mkdir(out, { recursive: true });
  demo = await openAutomaticDemo();
  for (const page of demo.pages) {
    page.setDefaultTimeout(18000);
    page.on('pageerror', (e) => report.errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
        report.errors.push('csp');
    });
    page.on('request', (req) => {
      if (new URL(req.url()).origin !== demo.origin)
        report.externalRequests.push(new URL(req.url()).origin);
    });
  }
  const [owner, ahmet, ayse] = demo.pages;
  const tomorrow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const second = ok(
    await api(owner, '/api/policies', 'POST', {
      customerId: 'demo-customer-0',
      insurerId: 'demo-insurer',
      productId: 'demo-product',
      branchId: 'demo-branch',
      paymentMethodId: 'demo-payment',
      assigneeMembershipId: 'demo-member-ahmet',
      policyNumber: 'C360-SECOND-PERIOD',
      startDate: '2026-01-01',
      endDate: tomorrow,
      grossPremium: '4500.00',
      currency: 'TRY',
      installmentCount: null,
      status: 'ACTIVE',
    }),
    201,
  );
  assert.equal(second.customerId, 'demo-customer-0');
  for (const [index, page] of demo.pages.entries()) {
    const actor = ['owner', 'ahmet', 'ayse'][index];
    for (const width of process.env.MAYI_CUSTOMER_OPERATIONS_ONLY === 'true'
      ? []
      : [1440, 1200, 768, 390]) {
      stage = `matrix-${actor}-${width}`;
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : width === 768 ? 1024 : 960,
      });
      await page.goto(demo.origin + '/customers/demo-customer-0');
      await page.locator('.c360-title h1').waitFor();
      await page
        .getByRole('region', { name: 'Sigorta özeti' })
        .getByText(/yürürlükte poliçe/)
        .waitFor();
      await shot(page, `${actor}-overview-${width}`);
      await tab(page, 'Poliçeler ve yenilemeler');
      await page.getByRole('link', { name: 'C360-SECOND-PERIOD', exact: true }).waitFor();
      await page
        .getByRole('button', { name: 'C360-SECOND-PERIOD yenilemesini seç', exact: true })
        .waitFor();
      assert.equal(await page.getByRole('region', { name: 'Seçili yenileme' }).count(), 0);
      await shot(page, `${actor}-policies-${width}`);
      await tab(page, 'İletişim');
      await click(page, 'Düzenle');
      await page.getByLabel('Adres', { exact: true }).fill('Sekmeler arası sentetik taslak');
      await tab(page, 'Genel bakış');
      await tab(page, 'İletişim');
      assert.equal(
        await page.getByLabel('Adres', { exact: true }).inputValue(),
        'Sekmeler arası sentetik taslak',
      );
      await click(page, 'Vazgeç');
      await tab(page, 'Müşteri notları');
      await page
        .getByText('Ayşe tarafından eklenen ortak müşteri notu.', { exact: true })
        .waitFor();
      await shot(page, `${actor}-notes-${width}`);
      assert.equal(await page.getByText('Kimlik numarası', { exact: true }).count(), 0);
      report.cells.push({ actor, width, status: 'PASS' });
      await save();
    }
  }
  if (process.env.MAYI_CUSTOMER_MATRIX_ONLY !== 'true') {
    // UI create/edit/representative management/policy creation for all three authenticated actors.
    const created = [];
    for (const [index, page] of demo.pages.entries()) {
      const actor = ['OWNER', 'Ahmet', 'Ayşe'][index];
      await page.setViewportSize({ width: 1440, height: 960 });
      for (const type of ['INDIVIDUAL', 'COMPANY']) {
        stage = `create-${actor}-${type}`;
        await page.goto(demo.origin + '/customers/new');
        await page.getByLabel('Müşteri türü', { exact: true }).selectOption(type);
        const display = type === 'COMPANY' ? `Sentetik ${actor} V4 AŞ` : `Sentetik ${actor} V4`;
        if (type === 'COMPANY')
          await page.getByLabel('Şirket unvanı', { exact: true }).fill(display);
        else {
          await page.getByLabel('Ad', { exact: true }).fill('Sentetik');
          await page.getByLabel('Soyad', { exact: true }).fill(actor + ' V4');
        }
        await page
          .getByLabel('E-posta', { exact: true })
          .fill(`c360-${index}-${type.toLowerCase()}@example.invalid`);
        await click(page, 'Müşteriyi kaydet');
        await page.getByRole('heading', { name: display, exact: true }).waitFor();
        const id = new URL(page.url()).pathname.split('/')[2];
        assert.notEqual(id, 'new');
        assert.equal(ok(await api(page, `/api/customers/${id}`)).displayName, display);
        created.push({ actor, type, id, display });
        await tab(page, 'İletişim');
        await click(page, 'Düzenle');
        const email = `edited-${index}-${type.toLowerCase()}@example.invalid`;
        await page.getByLabel('E-posta', { exact: true }).fill(email);
        await click(page, 'İletişim bilgilerini kaydet');
        await page.getByText('İletişim bilgileri kaydedildi.', { exact: true }).waitFor();
        assert.equal(ok(await api(page, `/api/customers/${id}`)).email, email);
        if (type === 'COMPANY') {
          stage = `representatives-${actor}`;
          await click(page, 'Yetkili ekle');
          await page.getByLabel('Yetkili adı', { exact: true }).fill('Deniz');
          await page.getByLabel('Yetkili soyadı', { exact: true }).fill('Sentetik');
          await page.getByLabel('Görev / unvan', { exact: true }).fill('Filo sorumlusu');
          await page.getByLabel('Birincil yetkili olarak ata', { exact: true }).check();
          await click(page, 'Yetkiliyi kaydet');
          await page.getByText('Yetkili eklendi.', { exact: true }).waitFor();
          let detail = ok(await api(page, `/api/customers/${id}`));
          assert.equal(detail.contacts.length, 1);
          assert.equal(detail.contacts[0].isPrimary, true);
          await click(page, 'Yetkiliyi düzenle');
          await page.getByLabel('Görev / unvan', { exact: true }).fill('Finans sorumlusu');
          await click(page, 'Değişiklikleri kaydet');
          await page.getByText('Yetkili bilgileri güncellendi.', { exact: true }).waitFor();
          assert.equal(
            ok(await api(page, `/api/customers/${id}`)).contacts[0].role,
            'Finans sorumlusu',
          );
          await shot(page, `${index}-corporate-1440`);
          await page.setViewportSize({ width: 390, height: 844 });
          await shot(page, `${index}-corporate-390`);
          await page.setViewportSize({ width: 1440, height: 960 });
          if (index === 0) {
            await click(page, 'Pasifleştir');
            await click(page, 'Pasifleştirmeyi onayla');
            await page.getByText('Yetkili pasifleştirildi.', { exact: true }).waitFor();
            detail = ok(await api(page, `/api/customers/${id}`));
            assert.equal(detail.contacts[0].status, 'INACTIVE');
            assert.equal(detail.contacts[0].isPrimary, false);
          }
          await tab(page, 'Poliçeler ve yenilemeler');
          await page
            .getByRole('heading', { name: 'Görüntülenebilir poliçe bulunamadı', exact: true })
            .waitFor();
          await page
            .getByRole('heading', { name: 'Görüntülenebilir yenileme bulunamadı.', exact: true })
            .waitFor();
          if (index === 0) {
            await page.setViewportSize({ width: 390, height: 844 });
            await shot(page, 'owner-empty-corporate-390');
            await page.setViewportSize({ width: 1440, height: 960 });
          }
        } else {
          stage = `policy-preselection-${actor}`;
          await page.getByRole('link', { name: 'Poliçe ekle', exact: true }).click();
          await page.getByRole('form', { name: 'Poliçe sözleşme formu' }).waitFor();
          assert.equal(await page.getByLabel('Müşteri', { exact: true }).inputValue(), id);
          for (const [label, value] of [
            ['Sigorta şirketi', 'demo-insurer'],
            ['Branş', 'demo-branch'],
            ['Ürün', 'demo-product'],
            ['Ödeme yöntemi', 'demo-payment'],
          ])
            await page.getByLabel(label, { exact: true }).selectOption(value);
          await page.getByLabel('Poliçe numarası', { exact: true }).fill('C360-UI-' + index);
          await page.getByLabel('Başlangıç tarihi', { exact: true }).fill('2026-01-01');
          await page.getByLabel('Bitiş tarihi', { exact: true }).fill(tomorrow);
          await page.getByLabel('Brüt prim', { exact: true }).fill('4500.00');
          await page.getByLabel('ISO para birimi', { exact: true }).fill('TRY');
          await click(page, 'Poliçeyi oluştur');
          await page.waitForURL(/\/policies\/[^/?]+$/);
          const policyId = new URL(page.url()).pathname.split('/')[2];
          assert.equal(ok(await api(page, '/api/policies/' + policyId)).customerId, id);
          await page.goto(demo.origin + `/customers/${id}?section=policies`);
          await page.getByRole('link', { name: 'C360-UI-' + index, exact: true }).click();
          await page.waitForURL('**/policies/' + policyId);
          assert.equal(ok(await api(page, '/api/policies/' + policyId)).customerId, id);
        }
      }
      report.checks.push('UI_CREATE_INDIVIDUAL_COMPANY_EDIT_REPRESENTATIVE_POLICY_' + actor);
      await save();
    }
    // Shared notes have immutable author history and remain shared, not employee task state.
    stage = 'shared-notes';
    await ahmet.goto(demo.origin + '/customers/demo-customer-0?section=notes');
    await ahmet
      .getByLabel('Yeni müşteri notu', { exact: true })
      .fill('V4 Customer 360 sentetik ortak kabul notu');
    await click(ahmet, 'Notu kaydet');
    await ahmet.getByText('Not kaydedildi.', { exact: true }).waitFor();
    await ayse.goto(demo.origin + '/customers/demo-customer-0?section=notes');
    await ayse.getByText('V4 Customer 360 sentetik ortak kabul notu', { exact: true }).waitFor();
    await ayse.reload();
    await ayse.getByText('V4 Customer 360 sentetik ortak kabul notu', { exact: true }).waitFor();
    const note = ok(await api(owner, '/api/customers/demo-customer-0/notes')).items.find(
      (n) => n.content === 'V4 Customer 360 sentetik ortak kabul notu',
    );
    assert.ok(note.authorName.includes('Ahmet'));
    report.checks.push('SHARED_NOTE_AUTHOR_AND_RELOAD');
    // Correct explicit target + real interaction write; switching tabs preserves the open form.
    stage = 'explicit-renewal';
    await ahmet.goto(demo.origin + '/customers/demo-customer-0?section=renewals');
    await ahmet
      .getByRole('button', { name: 'C360-SECOND-PERIOD yenilemesini seç', exact: true })
      .click();
    await ahmet.getByRole('heading', { name: 'İletişim geçmişi', exact: true }).waitFor();
    await click(ahmet, 'İletişim kaydı ekle');
    await ahmet.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
    await ahmet
      .getByLabel('İç not', { exact: true })
      .fill('V4 açık hedefli sentetik yenileme notu');
    await ahmet
      .getByLabel('Gerçekleşme zamanı (İstanbul)', { exact: true })
      .fill(new Date(Date.now() + 3 * 3600000 - 60000).toISOString().slice(0, 19));
    await tab(ahmet, 'Genel bakış');
    await tab(ahmet, 'Görüşmeler');
    assert.equal(
      await ahmet.getByLabel('İç not', { exact: true }).inputValue(),
      'V4 açık hedefli sentetik yenileme notu',
    );
    const otherButtons = ahmet.getByRole('button', { name: /yenilemesini seç$/ });
    assert.ok((await otherButtons.count()) >= 2);
    for (const b of await otherButtons.all()) {
      if ((await b.getAttribute('aria-pressed')) === 'false') assert.ok(await b.isDisabled());
    }
    await shot(ahmet, 'ahmet-selected-renewal-1440');
    await ahmet.setViewportSize({ width: 390, height: 844 });
    await shot(ahmet, 'ahmet-selected-renewal-390');
    await ahmet.setViewportSize({ width: 1440, height: 960 });
    await click(ahmet, 'İletişim kaydını kaydet');
    await ahmet
      .getByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.', { exact: true })
      .waitFor();
    const renewal = ok(await api(ahmet, '/api/customers/demo-customer-0/renewals')).items.find(
      (r) => r.policyNumber === 'C360-SECOND-PERIOD',
    );
    assert.ok(
      ok(await api(ahmet, `/api/renewals/${renewal.id}/interactions`)).interactions.some(
        (i) => i.note === 'V4 açık hedefli sentetik yenileme notu',
      ),
    );
    report.checks.push('EXPLICIT_RENEWAL_REAL_INTERACTION_TAB_DRAFT');
    // Real successful PATCH followed by dropped response: exact retry reconciles a single stored version.
    stage = 'uncertain-contact';
    const target = created[0];
    await owner.goto(demo.origin + `/customers/${target.id}?section=contact`);
    await click(owner, 'Düzenle');
    await owner.getByLabel('Telefon', { exact: true }).fill('+90 555 000 0360');
    const before = ok(await api(owner, '/api/customers/' + target.id)).version;
    let drop = true;
    const attempts = [];
    await owner.route('**/api/customers/' + target.id, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      attempts.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await click(owner, 'İletişim bilgilerini kaydet');
    await owner.getByRole('button', { name: 'Aynı isteği tekrar dene', exact: true }).waitFor();
    assert.ok(await owner.getByLabel('Telefon', { exact: true }).isDisabled());
    let logoutRequests = 0;
    const logoutListener = (request) => {
      if (new URL(request.url()).pathname === '/api/auth/logout') logoutRequests++;
    };
    owner.on('request', logoutListener);
    await click(owner, 'Çıkış Yap');
    await owner.getByText(/İşlemin sonucu henüz kesinleşmedi/).waitFor();
    assert.equal(logoutRequests, 0);
    assert.equal(await owner.getByRole('dialog').count(), 0);
    await owner.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
    await owner.getByText(/İşlemin sonucu henüz kesinleşmedi/).waitFor();
    assert.equal(new URL(owner.url()).pathname, '/customers/' + target.id);
    await click(owner, 'Aynı isteği tekrar dene');
    await owner.getByText('İletişim bilgileri kaydedildi.', { exact: true }).waitFor();
    assert.equal(attempts.length, 2);
    assert.equal(await owner.getByText(/İşlemin sonucu henüz kesinleşmedi/).count(), 0);
    assert.deepEqual(attempts[1], attempts[0]);
    let current = ok(await api(owner, '/api/customers/' + target.id));
    assert.equal(current.version, before + 1);
    assert.equal(current.phone, '+90 555 000 0360');
    await owner.unroute('**/api/customers/' + target.id);
    report.checks.push('COMMITTED_RESPONSE_LOSS_EXACT_KEY_BODY_SINGLE_VERSION');
    // Successful write, failed detail GET, recover with GET only.
    stage = 'readback-only';
    await click(owner, 'Düzenle');
    await owner.getByLabel('Adres', { exact: true }).fill('Sentetik GET ile toparlanma adresi');
    let committed = false,
      writes = 0,
      failRead = true;
    await owner.route('**/api/customers/' + target.id, async (route) => {
      if (route.request().method() === 'PATCH') {
        writes++;
        committed = true;
        return route.continue();
      }
      if (committed && failRead) {
        failRead = false;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }),
        });
      }
      return route.continue();
    });
    await click(owner, 'İletişim bilgilerini kaydet');
    await owner.getByText(/Değişiklikler kaydedildi, ancak güncel detaylar yüklenemedi/).waitFor();
    await click(owner, 'Güncel bilgileri yükle');
    await owner.getByText('İletişim bilgileri kaydedildi.', { exact: true }).waitFor();
    assert.equal(writes, 1);
    await owner.unroute('**/api/customers/' + target.id);
    assert.equal(
      ok(await api(owner, '/api/customers/' + target.id)).address,
      'Sentetik GET ile toparlanma adresi',
    );
    report.checks.push('POST_COMMIT_FAILED_GET_RECOVERS_READ_ONLY');
    owner.off('request', logoutListener);
    report.checks.push('UNCERTAIN_WRITE_BLOCKS_VOLUNTARY_LOGOUT');
    // Browser-level back navigation/list filter memory and keyboard dialog focus.
    stage = 'list-back-drafts';
    await owner.goto(demo.origin + '/customers');
    await owner.getByLabel('Müşteri ara', { exact: true }).fill('Sentetik OWNER');
    await click(owner, 'Ara');
    await owner.getByRole('link', { name: created[0].display, exact: true }).click();
    await tab(owner, 'İletişim');
    await click(owner, 'Düzenle');
    await owner.getByLabel('Adres', { exact: true }).fill('Kaydedilmemiş sentetik taslak');
    await owner.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).focus();
    await owner.keyboard.press('Enter');
    await owner.getByRole('dialog').waitFor();
    assert.ok(await owner.getByRole('dialog').evaluate((e) => e.contains(document.activeElement)));
    await owner.keyboard.press('Escape');
    await owner.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
      await owner.getByLabel('Adres', { exact: true }).inputValue(),
      'Kaydedilmemiş sentetik taslak',
    );
    await click(owner, 'Vazgeç');
    await owner.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
    assert.equal(
      await owner.getByLabel('Müşteri ara', { exact: true }).inputValue(),
      'Sentetik OWNER',
    );
    report.checks.push('LIST_FILTER_RETURN_DRAFT_DIALOG_ENTER_ESCAPE_FOCUS');
    // No customer UI requests any task API or another worker's task details.
    stage = 'privacy';
    for (const page of [ahmet, ayse]) {
      const requests = [];
      const listen = (r) => requests.push(new URL(r.url()).pathname);
      page.on('request', listen);
      await page.goto(demo.origin + '/customers/demo-customer-0?section=renewals');
      await page
        .getByRole('button', { name: 'C360-SECOND-PERIOD yenilemesini seç', exact: true })
        .click();
      await page.getByRole('heading', { name: 'İletişim geçmişi', exact: true }).waitFor();
      await tab(page, 'Müşteri notları');
      await page.getByLabel('Yeni müşteri notu').waitFor();
      page.off('request', listen);
      assert.ok(requests.every((p) => !p.startsWith('/api/tasks')));
    }
    const tasks = ok(await api(ahmet, '/api/tasks/today?limit=50'));
    const privateTask = tasks.items.find((t) => t.policyId === 'demo-policy-0');
    assert.ok(privateTask);
    assert.equal((await api(ayse, `/api/tasks/${privateTask.taskId}/context`)).status, 404);
    report.checks.push('SHARED_CUSTOMER_NO_TASK_FETCH_OTHER_EMPLOYEE_CONTEXT_404');
    // A forced refresh error is not mislabeled an empty customer.
    stage = 'loading-error';
    let release;
    await owner.route('**/api/customers/demo-customer-0', async (route) => {
      await new Promise((r) => {
        release = r;
      });
      await route.continue();
    });
    await owner.goto(demo.origin + '/customers/demo-customer-0', { waitUntil: 'domcontentloaded' });
    await owner.getByText('Müşteri profili yükleniyor…', { exact: true }).waitFor();
    await shot(owner, 'owner-loading-1440');
    release();
    await owner.locator('.c360-title h1').waitFor();
    await owner.unroute('**/api/customers/demo-customer-0');
    await owner.route('**/api/customers/demo-customer-0', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { message: 'unsafe diagnostic' } }),
      }),
    );
    await owner.reload();
    await owner.getByRole('heading', { name: 'Müşteri profili açılamadı', exact: true }).waitFor();
    assert.equal(await owner.getByText('unsafe diagnostic').count(), 0);
    await shot(owner, 'owner-safe-error-1440');
    await owner.unroute('**/api/customers/demo-customer-0');
    await click(owner, 'Yeniden dene');
    await owner.locator('.c360-title h1').waitFor();
    report.checks.push('LOADING_SAFE_ERROR_RETRY_REAL_READ');
    stage = 'work-context-discard';
    await owner.goto(
      demo.origin + `/today-work?task=${encodeURIComponent(privateTask.taskId)}&queue=WORK`,
    );
    await owner.locator('.today-workspace[data-selected=true]').waitFor();
    await owner.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
    await tab(owner, 'İletişim');
    await click(owner, 'Düzenle');
    await owner.getByLabel('Adres', { exact: true }).fill('Bağlamı korunan taslak');
    await owner.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
    await click(owner, 'Taslağı bırak ve ayrıl');
    await owner.locator('.today-workspace[data-selected=true]').waitFor();
    assert.equal(await owner.evaluate(() => typeof history.state?.usr?.workContext), 'string');
    assert.ok(
      (
        await owner.getByRole('region', { name: 'Seçili görev özeti', exact: true }).innerText()
      ).includes(privateTask.policyNumber),
    );
    report.checks.push('DISCARD_REPLAYS_ORIGINAL_LINK_WITH_WORK_CONTEXT');
    stage = 'forced-session-end';
    await ayse.goto(demo.origin + '/customers/demo-customer-0?section=contact');
    await click(ayse, 'Düzenle');
    await ayse
      .getByLabel('Adres', { exact: true })
      .fill('Zorunlu oturum bitiminde korunmayan geçici taslak');
    const forced = await ayse.evaluate(async () => {
      const c = await (await fetch('/api/auth/csrf-token')).json();
      return (
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': c.data.token },
          body: '{}',
        })
      ).status;
    });
    assert.equal(forced, 200);
    await tab(ayse, 'Müşteri notları');
    await ayse.getByRole('heading', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(await ayse.getByRole('dialog').count(), 0);
    report.checks.push('SERVER_SESSION_END_NOT_BLOCKED_BY_CUSTOMER_DRAFT');
    stage = 'voluntary-logout-draft';
    await owner.goto(demo.origin + '/customers/demo-customer-0?section=contact');
    await click(owner, 'Düzenle');
    await owner.getByLabel('Adres', { exact: true }).fill('Çıkış onayı isteyen taslak');
    let logoutPosts = 0;
    owner.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/logout') logoutPosts++;
    });
    await click(owner, 'Çıkış Yap');
    await owner.getByRole('dialog').waitFor();
    assert.equal(logoutPosts, 0);
    await click(owner, 'Bu ekranda kal');
    assert.equal(logoutPosts, 0);
    await click(owner, 'Çıkış Yap');
    await click(owner, 'Taslağı bırak ve ayrıl');
    await owner.getByRole('heading', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(logoutPosts, 1);
    assert.equal((await api(owner, '/api/auth/session')).status, 401);
    report.checks.push('VOLUNTARY_LOGOUT_REQUIRES_EXPLICIT_DRAFT_DISCARD');
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  report.status = 'PASS';
  await save();
  console.info(
    JSON.stringify({
      status: 'PASS',
      cells: report.cells.length,
      checks: report.checks.length,
      screens: report.screens.length,
      errors: report.errors.length,
      externalRequests: report.externalRequests.length,
      evidence: out,
    }),
  );
} catch (e) {
  report.status = 'FAIL';
  report.stage = stage;
  report.failure = stage === 'setup' ? 'SYNTHETIC_SETUP_FAILED' : String(e);
  if (demo?.pages?.[0])
    await demo.pages[0].screenshot({ path: out + '/failure.png', fullPage: true }).catch(() => {});
  await save();
  console.error('Customer 360 acceptance failed at ' + stage + ': ' + report.failure);
  process.exitCode = 1;
} finally {
  await demo?.close();
}
