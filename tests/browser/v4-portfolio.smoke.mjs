// Real Edge, authenticated local Hono and disposable synthetic D1. No production endpoints.
/* global document, innerWidth, fetch, crypto */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { URL, URLSearchParams } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { openAutomaticDemo } from '../../scripts/demo/automatic.mjs';
const out = process.env.MAYI_PORTFOLIO_EVIDENCE ?? 'portfolio-evidence/initial';
let demo,
  stage = 'setup';
const report = {
  mode: 'REAL_REACT_AUTH_LOCAL_D1',
  cells: [],
  screens: [],
  checks: [],
  errors: [],
  external: [],
};
async function save() {
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
}
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
        ...(body ? { body: JSON.stringify(body) } : {}),
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
async function button(p, name) {
  await p.getByRole('button', { name, exact: true }).click();
}
async function shot(p, name) {
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: out + '/' + name + '.png', fullPage: true });
  const g = await p.evaluate(() => ({
    width: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    font: document.fonts.check('500 14px Geist'),
    outside: [
      ...document.querySelectorAll(
        'main a,main button,main input,main select,main textarea,dialog[open] a,dialog[open] button',
      ),
    ]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width && (r.left < -1 || r.right > innerWidth + 1);
      })
      .map((e) => e.getAttribute('aria-label') ?? e.textContent.slice(0, 80)),
    toolbar: document.querySelector('.pv4-toolbar')?.getBoundingClientRect().toJSON(),
    rows: [...document.querySelectorAll('.pv4-table tbody tr')].map(
      (e) => e.getBoundingClientRect().height,
    ),
  }));
  assert.ok(g.pageWidth <= g.width + 1, name + ' page overflow');
  assert.deepEqual(g.outside, [], name + ' control overflow');
  report.screens.push({ file: name + '.png', ...g });
  await save();
}
async function openRenewal(p, policyId, number) {
  await p.goto(demo.origin + '/policies/' + policyId + '?section=renewal');
  const restored = p.getByRole('button', { name: 'Yenileme seçimini değiştir', exact: true });
  const choose = p.getByRole('button', { name: number + ' yenilemesini aç', exact: true });
  await choose.or(restored).waitFor();
  assert.equal(new URL(p.url()).pathname, '/policies/' + policyId);
  if (await restored.isVisible()) await restored.click();
  await p.getByRole('button', { name: number + ' yenilemesini aç', exact: true }).click();
  await button(p, 'Teklif geçmişini aç');
  await p.locator('.quote-history').waitFor();
}
try {
  await mkdir(out, { recursive: true });
  demo = await openAutomaticDemo();
  for (const p of demo.pages) {
    p.setDefaultTimeout(18000);
    p.on('pageerror', (e) => report.errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
        report.errors.push('csp');
    });
    p.on('request', (r) => {
      if (new URL(r.url()).origin !== demo.origin) report.external.push(new URL(r.url()).origin);
    });
  }
  const [owner, a, b] = demo.pages;
  const now = new Date();
  const day = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);
  // More than one server page; no policy/customer records are mocked in application requests.
  for (let i = 0; i < 23; i++) {
    await demo.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES(?,'demo-agency',?,'demo-insurer','demo-product','demo-branch','demo-payment','demo-member-ahmet',?,?,?, ?,1250050,'TRY','ACTIVE')",
      )
      .bind(
        'v4-portfolio-' + i,
        'demo-customer-' + (i % 4),
        'V4-LIST-' + String(i).padStart(3, '0'),
        'V4LIST' + String(i).padStart(3, '0'),
        day(-200),
        day(i - 3),
      )
      .run();
  }
  const originPolicy = ok(await api(owner, '/api/policies/demo-policy-0'));
  const number = originPolicy.policyNumber;
  if (process.env.MAYI_PORTFOLIO_OPERATIONS_ONLY !== 'true')
    for (const [index, p] of demo.pages.entries())
      for (const width of [1440, 1200, 768, 390]) {
        const actor = ['owner', 'ahmet', 'ayse'][index];
        stage = `matrix-${actor}-${width}`;
        await p.setViewportSize({
          width,
          height: width === 390 ? 844 : width === 768 ? 1024 : 960,
        });
        await p.goto(demo.origin + '/policies?search=V4-LIST&searchMode=prefix');
        await p.locator('.pv4-table tbody tr').first().waitFor();
        await p
          .getByRole('link', { name: originPolicy.customer.displayName, exact: true })
          .first()
          .waitFor();
        await shot(p, `${actor}-portfolio-${width}`);
        const first = await p
          .locator('.pv4-table tbody tr')
          .first()
          .getByRole('link')
          .last()
          .innerText();
        await p.locator('.pv4-table tbody tr').first().getByRole('button').click();
        await p.getByRole('dialog', { name: 'Poliçe önizlemesi' }).waitFor();
        await p.getByRole('dialog').getByRole('heading', { name: first, exact: true }).waitFor();
        await shot(p, `${actor}-preview-${width}`);
        await p.keyboard.press('Escape');
        await p.getByRole('dialog').waitFor({ state: 'hidden' });
        assert.match(
          await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''),
          / önizle$/,
        );
        assert.equal(new URL(p.url()).searchParams.get('search'), 'V4-LIST');
        await openRenewal(p, 'demo-policy-0', number);
        await shot(p, `${actor}-renewal-${width}`);
        await button(p, 'Görüşmeler');
        await p.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).waitFor();
        await shot(p, `${actor}-interactions-${width}`);
        report.cells.push({ actor, width, status: 'PASS' });
        await save();
      }
  if (process.env.MAYI_PORTFOLIO_MATRIX_ONLY !== 'true') {
    stage = 'server-search-pagination';
    await owner.setViewportSize({ width: 1440, height: 960 });
    await owner.goto(demo.origin + '/policies?search=V4-LIST&searchMode=prefix');
    await owner.locator('.pv4-table tbody tr').first().waitFor();
    assert.equal(await owner.locator('.pv4-table tbody tr').count(), 20);
    const firstPage = await owner.locator('.pv4-policy-link').allTextContents();
    await button(owner, 'Sonraki sayfa');
    await owner.waitForFunction(
      () => document.querySelectorAll('.pv4-table tbody tr').length === 3,
    );
    assert.equal(await owner.locator('.pv4-table tbody tr').count(), 3);
    const secondPage = await owner.locator('.pv4-policy-link').allTextContents();
    assert.ok(secondPage.every((n) => !firstPage.includes(n)));
    const secondURL = new URL(owner.url()).pathname + new URL(owner.url()).search;
    await owner.locator('.pv4-table tbody tr').first().getByRole('button').click();
    await owner
      .getByRole('dialog')
      .getByRole('link', { name: 'Poliçe ayrıntısını aç', exact: true })
      .click();
    await owner.getByRole('link', { name: '← Poliçe listesine dön', exact: true }).click();
    await owner.getByRole('dialog').waitFor();
    await button(owner, 'Önizlemeyi kapat');
    assert.equal(new URL(owner.url()).pathname + new URL(owner.url()).search, secondURL);
    report.checks.push('SERVER_23_RESULTS_PAGINATION_PREVIEW_DETAIL_EXACT_RETURN');
    stage = 'expiration-sorting';
    await owner.getByLabel('Sıralama', { exact: true }).selectOption('end_date_desc');
    await button(owner, 'Filtrele');
    await owner.locator('.pv4-table tbody tr').first().waitFor();
    const expected = ok(
      await api(
        owner,
        '/api/policies?search=V4-LIST&searchMode=prefix&sort=end_date_desc&pageSize=20&includeLabels=true',
      ),
    );
    assert.deepEqual(
      await owner.locator('.pv4-policy-link').allTextContents(),
      expected.items.map((p) => p.policyNumber),
    );
    await button(owner, '7 gün');
    await owner.locator('.pv4-table tbody tr').first().waitFor();
    const live = new URL(owner.url()).searchParams;
    assert.equal(live.get('search'), 'V4-LIST');
    assert.equal(live.get('sort'), 'end_date_desc');
    assert.equal(live.get('cursor'), null);
    const filtered = ok(
      await api(
        owner,
        '/api/policies?' +
          new URLSearchParams({
            search: 'V4-LIST',
            searchMode: 'prefix',
            sort: 'end_date_desc',
            endFrom: live.get('endFrom'),
            endTo: live.get('endTo'),
            pageSize: '20',
            includeLabels: 'true',
          }),
      ),
    );
    assert.deepEqual(
      await owner.locator('.pv4-policy-link').allTextContents(),
      filtered.items.map((p) => p.policyNumber),
    );
    report.checks.push('ISTANBUL_EXPIRATION_SERVER_SORT_CURSOR_RESET');
    stage = 'server-customer-selection';
    await button(owner, 'Gelişmiş filtreler');
    await owner
      .getByLabel('Müşteri adıyla ara', { exact: true })
      .fill(originPolicy.customer.displayName);
    await button(owner, 'Müşterileri sunucuda ara');
    await owner
      .locator('.pv4-customer-options')
      .getByRole('button', { name: originPolicy.customer.displayName, exact: true })
      .click();
    await button(owner, 'Gelişmiş filtreleri uygula');
    assert.equal(new URL(owner.url()).searchParams.get('customerId'), originPolicy.customer.id);
    await owner.getByRole('button', { name: 'Müşteri filtresini kaldır', exact: true }).click();
    assert.equal(new URL(owner.url()).searchParams.get('customerId'), null);
    report.checks.push('EXPLICIT_SERVER_CUSTOMER_SEARCH_FILTER_CHIP_REMOVE');
    stage = 'quote-create-version';
    await openRenewal(a, 'demo-policy-0', number);
    await a.setViewportSize({ width: 1440, height: 960 });
    await button(a, 'Yeni teklif taslağı aç');
    const form = a.getByRole('form', { name: 'Yeni teklif formu', exact: true });
    await form.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('12.500,50');
    await form
      .getByLabel('Teklif geçerlilik sonu (İstanbul)', { exact: true })
      .fill(new Date(Date.now() + 86400000 + 3 * 3600000).toISOString().slice(0, 19));
    await form.getByLabel('Teklif koşulları', { exact: true }).fill('V4 gerçek portföy kabulü');
    await button(a, 'Görüşmeler');
    await button(a, 'Teklifler ve sürümler');
    assert.equal(
      await form.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).inputValue(),
      '12.500,50',
    );
    await form.getByLabel('Yeni teklif kaydını oluşturmayı onaylıyorum', { exact: true }).check();
    await shot(a, 'quote-draft-1440');
    await a.setViewportSize({ width: 390, height: 844 });
    await shot(a, 'quote-draft-390');
    await a.setViewportSize({ width: 1440, height: 960 });
    await button(a, 'Teklifi oluştur');
    await a.getByText('Teklif kaydedildi ve geçmiş güncellendi.', { exact: true }).waitFor();
    const renewals = ok(
      await api(a, '/api/customers/demo-customer-0/renewals?includePolicyId=true'),
    );
    const renewal = renewals.items.find((r) => r.policyId === 'demo-policy-0');
    assert.ok(renewal);
    let h = ok(await api(a, `/api/renewals/${renewal.id}/quotes`));
    const q = h.quotes.find((q) =>
      q.versions.some((v) => v.terms_summary === 'V4 gerçek portföy kabulü'),
    );
    assert.ok(q);
    assert.equal(q.versions[0].gross_premium_minor, 1250050);
    const index = h.quotes.findIndex((x) => x.id === q.id) + 1;
    await button(a, `Teklif ${index} için yeni değişmez sürüm taslağı aç`);
    const revision = a.getByRole('form', { name: 'Yeni değişmez sürüm formu', exact: true });
    await revision.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('13.000,25');
    await revision
      .getByLabel('Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum', { exact: true })
      .check();
    await button(a, 'Yeni değişmez sürümü oluştur');
    await a.getByText('Teklif kaydedildi ve geçmiş güncellendi.', { exact: true }).waitFor();
    h = ok(await api(a, `/api/renewals/${renewal.id}/quotes`));
    const revised = h.quotes.find((x) => x.id === q.id);
    assert.equal(revised.versions.length, 2);
    assert.equal(revised.versions[0].gross_premium_minor, 1250050);
    assert.equal(revised.versions[1].gross_premium_minor, 1300025);
    report.checks.push('REAL_QUOTE_CREATE_TURKISH_MONEY_IMMUTABLE_VERSION_IDENTITY');
    stage = 'quote-sent-uncertain';
    await button(a, 'Teklifi gönderildi olarak kaydet');
    const chooser = a.getByLabel('Gönderildi olarak kaydedilecek teklif ve güncel sürüm', {
      exact: true,
    });
    assert.equal(await chooser.inputValue(), '');
    await chooser.selectOption(q.id);
    await a
      .getByLabel('Seçili sürümü dış kanaldan ilettiğimi ve gönderildi kaydını onaylıyorum', {
        exact: true,
      })
      .check();
    const path = `/api/renewals/${renewal.id}/quotes/${q.id}/send`;
    let lose = true;
    const attempts = [];
    await a.route('**' + path, async (route) => {
      attempts.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      const response = await route.fetch();
      if (lose) {
        lose = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await button(a, 'Gönderildi kaydını onayla');
    await a
      .getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene', exact: true })
      .waitFor();
    await a.getByRole('link', { name: '← Poliçe listesine dön', exact: true }).click();
    await a.getByText(/İşlemin sonucu henüz kesinleşmedi/).waitFor();
    assert.equal(new URL(a.url()).pathname, '/policies/demo-policy-0');
    await button(a, 'Çıkış Yap');
    assert.equal(await a.getByRole('dialog').count(), 0);
    await button(a, 'Aynı gönderildi isteğini yeniden dene');
    await a.getByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/).waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(JSON.parse(attempts[0].body).quoteVersionId, revised.current_version_id);
    assert.equal(
      await demo.db
        .prepare("SELECT count(*) n FROM renewal_quote_events WHERE quote_id=? AND event='SENT'")
        .bind(q.id)
        .first('n'),
      1,
    );
    await a.unroute('**' + path);
    const refreshedRenewal = ok(
      await api(a, '/api/customers/demo-customer-0/renewals?includePolicyId=true'),
    ).items.find((r) => r.id === renewal.id);
    const stateLabels = {
      CONTACT_PENDING: 'İletişim bekleniyor',
      CONTACTED: 'Görüşüldü',
      QUOTE_PREPARING: 'Teklif hazırlanıyor',
      QUOTE_SENT: 'Teklif gönderildi',
      AWAITING_RESPONSE: 'Yanıt bekleniyor',
      WON: 'Yenilendi',
      LOST: 'Yenilenmedi',
      VOIDED: 'Geçersiz',
    };
    await a.waitForFunction(
      (label) => document.querySelector('.pv4-selected-context .pv4-status')?.textContent === label,
      stateLabels[refreshedRenewal.state],
    );
    report.checks.push(
      'QUOTE_SENT_LOST_RESPONSE_EXACT_KEY_BODY_VERSION_SINGLE_DB_EVENT_LOGOUT_GUARD',
    );
    stage = 'interaction-explicit-target';
    await button(a, 'Görüşmeler');
    await button(a, 'İletişim kaydı ekle');
    await a.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
    await a.getByLabel('İç not', { exact: true }).fill('V4 poliçe yenileme gerçek iç notu');
    await button(a, 'Teklifler ve sürümler');
    await button(a, 'Görüşmeler');
    assert.equal(
      await a.getByLabel('İç not', { exact: true }).inputValue(),
      'V4 poliçe yenileme gerçek iç notu',
    );
    await a.getByRole('link', { name: 'Poliçe bilgileri', exact: true }).click();
    await a.getByRole('link', { name: 'Yenileme ve teklifler', exact: true }).click();
    assert.equal(
      await a.getByLabel('İç not', { exact: true }).inputValue(),
      'V4 poliçe yenileme gerçek iç notu',
    );
    await button(a, 'İletişim kaydını kaydet');
    await a
      .getByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.', { exact: true })
      .waitFor();
    assert.ok(
      ok(await api(a, `/api/renewals/${renewal.id}/interactions`)).interactions.some(
        (i) => i.note === 'V4 poliçe yenileme gerçek iç notu',
      ),
    );
    report.checks.push('POLICY_RENEWAL_INTERACTION_REAL_WRITE_TAB_DRAFT_PRESERVATION');
    stage = 'followup-identity';
    await button(a, 'Takip ve sonuç');
    await button(a, 'Yetkili takipleri yükle');
    await a.getByRole('link', { name: 'Takip ve sonuç işlemlerini aç', exact: true }).click();
    await a.locator('.today-workspace[data-selected=true]').waitFor();
    const region = a.getByRole('region', { name: 'Seçili görev özeti', exact: true });
    assert.ok((await region.innerText()).includes(number));
    const taskId = new URL(a.url()).searchParams.get('task');
    assert.ok(taskId);
    const ctx = ok(await api(a, `/api/tasks/${taskId}/context`));
    assert.equal(ctx.items[0].policyId, 'demo-policy-0');
    assert.equal(ctx.items[0].renewalId, renewal.id);
    assert.equal((await api(b, `/api/tasks/${taskId}/context`)).status, 404);
    await a.goBack();
    await a.getByRole('button', { name: 'Yenileme seçimini değiştir', exact: true }).waitFor();
    assert.equal(new URL(a.url()).searchParams.get('renewal'), renewal.id);
    await a.reload();
    await a.getByRole('button', { name: 'Yenileme seçimini değiştir', exact: true }).waitFor();
    assert.equal(new URL(a.url()).searchParams.get('renewal'), renewal.id);
    report.checks.push('AUTHORIZED_FOLLOWUP_EXACT_IDENTITY_MEMBER_404_BACK_REFRESH_RESTORE');
    stage = 'loading';
    let releaseList;
    await owner.route('**/api/policies?**', async (route) => {
      await new Promise((resolve) => {
        releaseList = resolve;
      });
      await route.continue();
    });
    await owner.goto(demo.origin + '/policies?search=V4-LIST&searchMode=prefix', {
      waitUntil: 'domcontentloaded',
    });
    await owner.getByText('Poliçe bilgileri yükleniyor…', { exact: true }).waitFor();
    await shot(owner, 'loading-1440');
    releaseList();
    await owner.locator('.pv4-table tbody tr').first().waitFor();
    await owner.unroute('**/api/policies?**');
    report.checks.push('REAL_LOADING_PENDING_AUTHORIZED_LIST');
    stage = 'safe-empty-error';
    await owner.goto(demo.origin + '/policies?search=NO-SUCH-POLICY&searchMode=exact');
    await owner.getByRole('heading', { name: 'Poliçe bulunamadı', exact: true }).waitFor();
    await shot(owner, 'empty-1440');
    await owner.route('**/api/policies?**', (r) =>
      r.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { message: 'unsafe diagnostic' } }),
      }),
    );
    await owner.reload();
    await owner.getByRole('alert').waitFor();
    assert.equal(await owner.getByText('unsafe diagnostic').count(), 0);
    await shot(owner, 'error-1440');
    await owner.unroute('**/api/policies?**');
    await owner.getByRole('button', { name: 'Yeniden dene', exact: true }).click();
    await owner.getByRole('heading', { name: 'Poliçe bulunamadı', exact: true }).waitFor();
    report.checks.push('EMPTY_SAFE_ERROR_RETRY');
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
  report.status = 'PASS';
  await save();
  console.info(
    JSON.stringify({
      status: 'PASS',
      cells: report.cells.length,
      checks: report.checks.length,
      screens: report.screens.length,
      evidence: out,
    }),
  );
} catch (e) {
  report.status = 'FAIL';
  report.stage = stage;
  report.failure = stage === 'setup' ? 'SETUP_FAILED' : String(e);
  if (demo && stage !== 'setup')
    report.pageStates = await Promise.all(
      demo.pages.map(async (p) => ({
        path: new URL(p.url()).pathname + new URL(p.url()).search,
        text: (
          await p
            .locator('main')
            .innerText()
            .catch(() => '')
        ).slice(0, 1800),
      })),
    );
  await save();
  console.error('Portfolio acceptance: ' + stage + ' ' + report.failure);
  process.exitCode = 1;
} finally {
  await demo?.close();
}
