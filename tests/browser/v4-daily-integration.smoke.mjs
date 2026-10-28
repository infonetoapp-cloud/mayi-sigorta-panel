// Real authenticated React + Hono + synthetic local D1. Never prints credentials or headers.
/* global fetch, innerWidth, document, getComputedStyle, localStorage, sessionStorage */
import console from 'node:console';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openAutomaticDemo } from '../../scripts/demo/automatic.mjs';
const { URL } = globalThis;
import process from 'node:process';
const out = process.env.MAYI_V4_BROWSER_EVIDENCE ?? 'v4-evidence/final';
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
async function api(page, path) {
  return page.evaluate(async (path) => {
    const r = await fetch(path, { cache: 'no-store' }),
      j = await r.json();
    return { status: r.status, data: j.data };
  }, path);
}
async function shot(page, name) {
  const file = `${out}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    header: document.querySelector('.app-header').getBoundingClientRect().height,
    sidebar: getComputedStyle(document.querySelector('.app-sidebar')).backgroundColor,
    fontReady: document.fonts.check('500 14px Geist'),
    inspector: document.querySelector('.today-overview')?.getBoundingClientRect().toJSON(),
    rows: [...document.querySelectorAll('.today-task-row')]
      .map((e) => e.getBoundingClientRect().height)
      .filter(Boolean),
    outside: [...document.querySelectorAll('main button,main input,main select,main a')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width && (r.right > innerWidth + 1 || r.left < -1);
      })
      .map((e) => e.textContent.slice(0, 50)),
  }));
  assert.ok(geometry.pageWidth <= geometry.width + 1, name);
  assert.deepEqual(geometry.outside, [], name);
  assert.ok(geometry.fontReady);
  report.screens.push({ file, ...geometry });
  await save();
}
async function save() {
  await writeFile(`${out}/browser-results.json`, JSON.stringify(report, null, 2));
}
async function button(page, name) {
  stage = `button:${name}`;
  await page.getByRole('button', { name, exact: true }).click();
}
async function selectTask(page, t) {
  await page.goto(demo.origin + `/today-work?task=${encodeURIComponent(t.taskId)}&queue=WORK`);
  await page.locator('.today-workspace[data-selected=true]').waitFor();
  assert.match(
    await page.getByRole('region', { name: 'Seçili görev özeti', exact: true }).innerText(),
    new RegExp(t.policyNumber),
  );
}
try {
  await mkdir(out, { recursive: true });
  demo = await openAutomaticDemo();
  for (const [index, page] of demo.pages.entries()) {
    page.setDefaultTimeout(20000);
    page.on('pageerror', () => report.errors.push('runtime'));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
        report.errors.push('csp');
    });
    page.on('request', (req) => {
      if (new URL(req.url()).origin !== demo.origin)
        report.externalRequests.push(new URL(req.url()).origin);
    });
    for (const width of process.env.MAYI_V4_OPERATIONS_ONLY === 'true'
      ? []
      : [1440, 1200, 768, 390]) {
      const actor = ['owner', 'ahmet', 'ayse'][index];
      stage = `matrix-${actor}-${width}`;
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : width === 768 ? 1024 : 900,
      });
      await page.goto(demo.origin + '/');
      await page.locator('.dashboard-metrics a').first().waitFor();
      await page.locator('#renewal-followups .dashboard-records a').first().waitFor();
      const stats = await api(
        page,
        '/api/tasks/statistics?view=' + (index === 0 ? 'team' : 'self'),
      );
      assert.equal(stats.status, 200);
      for (const [name, count] of [
        ['Geciken görevler', stats.data.summary.overdue],
        ['Bugünkü görevler', stats.data.summary.dueToday],
        ['Yaklaşan görevler', stats.data.summary.upcoming],
      ])
        assert.equal(
          await page.getByRole('link', { name: `${name}: ${count}`, exact: true }).count(),
          1,
        );
      if (index) {
        assert.equal(await page.getByRole('link', { name: /Atanmamış görevler:/ }).count(), 0);
        assert.equal((await api(page, '/api/tasks/statistics?view=team')).status, 403);
        assert.equal((await api(page, '/api/personnel')).status, 403);
      }
      await shot(page, `${actor}-dashboard-${width}`);
      await page.goto(demo.origin + '/today-work');
      await page.locator('.today-task-row').first().waitFor();
      const tasks = await api(page, '/api/tasks/today?limit=20');
      assert.equal(tasks.status, 200);
      assert.equal(await page.locator('.today-task-row').count(), tasks.data.items.length);
      if (index)
        assert.ok(
          tasks.data.items.every(
            (t) => t.assigneeMembershipId === 'demo-member-' + (index === 1 ? 'ahmet' : 'ayse'),
          ),
        );
      const t = tasks.data.items[0];
      await shot(page, `${actor}-work-${width}`);
      await page.locator('.today-task-row').first().focus();
      await page.keyboard.press('Enter');
      await page.locator('.today-workspace[data-selected=true]').waitFor();
      const region = page.getByRole('region', { name: 'Seçili görev özeti', exact: true });
      assert.match(await region.innerText(), new RegExp(t.customerDisplayName));
      assert.equal(
        await region
          .getByRole('link', { name: 'Müşteri profilini aç', exact: true })
          .getAttribute('href'),
        '/customers/' + t.customerId,
      );
      assert.equal(
        await region.getByRole('link', { name: 'Poliçeyi aç', exact: true }).getAttribute('href'),
        '/policies/' + t.policyId,
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'İletişim', exact: true })
          .getAttribute('aria-expanded'),
        'false',
      );
      assert.ok(await region.evaluate((e) => e.contains(document.activeElement)));
      await shot(page, `${actor}-selected-${width}`);
      await page.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
      await page.getByRole('link', { name: 'Seçili takibe dön', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
      await page.locator('.today-workspace[data-selected=true]').waitFor();
      assert.match(await region.innerText(), new RegExp(t.customerDisplayName));
      await button(page, 'İletişim');
      await button(page, 'İletişim kaydı ekle');
      await page.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
      await page.getByLabel('İç not', { exact: true }).fill(`Korunan sentetik taslak ${width}`);
      await page.getByRole('button', { name: 'İletişim', exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.equal(
        await page
          .getByRole('button', { name: 'İletişim', exact: true })
          .getAttribute('aria-expanded'),
        'true',
      );
      await page.getByRole('link', { name: 'Poliçeyi aç', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(
        await page.getByLabel('İç not', { exact: true }).inputValue(),
        `Korunan sentetik taslak ${width}`,
      );
      await button(page, 'Formu kapat ve taslağı bırak');
      await button(page, 'İletişim');
      if (width <= 900) {
        await button(page, 'Menüyü aç');
        await page.keyboard.press('Escape');
        assert.ok(
          await page
            .getByRole('button', { name: 'Menüyü aç', exact: true })
            .evaluate((e) => e === document.activeElement),
        );
      }
      report.cells.push({
        actor,
        width,
        realLogin: true,
        authoritativeCounts: true,
        exactContext: true,
        linkedCustomerReturn: true,
        pinnedDraftAndEscape: true,
      });
      await save();
    }
  }
  const [owner, a, b] = demo.pages;
  await a.setViewportSize({ width: 1440, height: 900 });
  await a.goto(demo.origin + '/today-work');
  const aTasks = (await api(a, '/api/tasks/today?limit=20')).data.items;
  let t = aTasks[0];
  stage = 'real-interaction-write-readback';
  await selectTask(a, t);
  await button(a, 'İletişim');
  await button(a, 'İletişim kaydı ekle');
  await a.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
  await a
    .getByLabel('İç not', { exact: true })
    .fill('V4 gerçek CRM: yerel D1 üzerinde kaydedilen sentetik görüşme notu.');
  const interactionPost = a.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/renewals/${t.renewalId}/interactions`,
  );
  await button(a, 'İletişim kaydını kaydet');
  assert.equal((await interactionPost).status(), 201);
  await a
    .getByText('V4 gerçek CRM: yerel D1 üzerinde kaydedilen sentetik görüşme notu.', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await demo.db
      .prepare('SELECT count(*) n FROM renewal_interactions WHERE renewal_id=? AND note=?')
      .bind(t.renewalId, 'V4 gerçek CRM: yerel D1 üzerinde kaydedilen sentetik görüşme notu.')
      .first('n'),
    1,
  );
  await shot(a, 'interaction-saved-1440');
  report.checks.push('REAL_INTERACTION_POST_AUTHORIZED_GET_AND_D1');
  stage = 'real-specific-quote-declaration';
  await button(a, 'Teklifler');
  await button(a, 'Teklif geçmişini aç');
  await a.locator('.quote-history').waitFor();
  const quoteHistory = (await api(a, `/api/renewals/${t.renewalId}/quotes`)).data;
  const q = quoteHistory.quotes.find((q) => ['DRAFT', 'READY'].includes(q.status));
  assert.ok(q);
  const version = q.versions.find((v) => v.id === q.current_version_id);
  assert.ok(version);
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
  const sendPath = `/api/renewals/${t.renewalId}/quotes/${q.id}/send`;
  const attempts = [];
  let loseResponse = true;
  await a.route('**' + sendPath, async (route) => {
    const req = route.request();
    attempts.push({ body: req.postData(), key: req.headers()['idempotency-key'] });
    const response = await route.fetch();
    if (loseResponse) {
      loseResponse = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await button(a, 'Gönderildi kaydını onayla');
  await a
    .getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene', exact: true })
    .waitFor();
  assert.equal(
    await a.getByRole('button', { name: 'Teklifler', exact: true }).getAttribute('aria-disabled'),
    'true',
  );
  await a.getByRole('link', { name: 'Poliçeyi aç', exact: true }).click();
  assert.equal(new URL(a.url()).pathname, '/today-work');
  assert.equal(await a.getByRole('button', { name: 'Ayrılmayı onayla', exact: true }).count(), 0);
  await shot(a, 'quote-uncertain-1440');
  await button(a, 'Aynı gönderildi isteğini yeniden dene');
  await a.getByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/).waitFor();
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].key);
  assert.equal(attempts[0].body, attempts[1].body);
  assert.equal(attempts[0].key, attempts[1].key);
  assert.equal(JSON.parse(attempts[0].body).quoteVersionId, version.id);
  assert.equal(
    await demo.db
      .prepare("SELECT count(*) n FROM renewal_quote_events WHERE quote_id=? AND event='SENT'")
      .bind(q.id)
      .first('n'),
    1,
  );
  await a.unroute('**' + sendPath);
  report.checks.push('REAL_SENT_LOST_RESPONSE_EXACT_BODY_KEY_VERSION_RETRY_SINGLE_DB_EVENT');
  await shot(a, 'quote-saved-1440');
  stage = 'real-followup-replacement';
  await selectTask(a, t);
  await button(a, 'Görev işlemleri');
  await button(a, 'Yeni takip planını aç');
  assert.equal(
    await a.getByLabel('Yeni takip zamanı (İstanbul)', { exact: true }).inputValue(),
    '',
  );
  const future = new Date(Date.now() + 3 * 86400000),
    local = new Date(future.getTime() + 3 * 3600000).toISOString().slice(0, 19);
  await a.getByLabel('Yeni takip zamanı (İstanbul)', { exact: true }).fill(local);
  await a
    .getByLabel('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum', { exact: true })
    .check();
  const completion = a.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/complete'),
  );
  await button(a, 'Takibi tamamla ve planla');
  assert.ok((await completion).ok());
  await a.waitForFunction(() => !document.querySelector('.today-workspace[data-selected=true]'));
  assert.equal(
    await demo.db.prepare('SELECT status FROM tasks WHERE id=?').bind(t.taskId).first('status'),
    'COMPLETED',
  );
  assert.equal(
    await demo.db
      .prepare(
        "SELECT count(*) n FROM tasks WHERE renewal_id=? AND status='OPEN' AND kind='RENEWAL_FOLLOWUP'",
      )
      .bind(t.renewalId)
      .first('n'),
    1,
  );
  assert.ok(
    !['WON', 'LOST', 'VOIDED'].includes(
      await demo.db
        .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
        .bind(t.renewalId)
        .first('state'),
    ),
  );
  report.checks.push('REAL_FOLLOWUP_DUAL_CAS_COMPLETES_OLD_CREATES_ONE_PRIMARY_RENEWAL_OPEN');
  stage = 'owner-real-assignment';
  await owner.setViewportSize({ width: 1200, height: 900 });
  const ownerTasks = (await api(owner, '/api/tasks/today?limit=20')).data.items;
  const assign = ownerTasks.find((x) => x.policyId === 'demo-policy-2');
  assert.ok(assign);
  await selectTask(owner, assign);
  await button(owner, 'Görev işlemleri');
  await button(owner, 'Görev atama seçeneklerini aç');
  const assignee = owner.getByLabel('Yeni görev sorumlusu', { exact: true });
  await assignee.waitFor();
  assert.equal(await assignee.inputValue(), '');
  await assignee.selectOption('demo-member-ayse');
  await owner
    .getByLabel('Görev ve yenileme sorumlusunu değiştirmeyi onaylıyorum', { exact: true })
    .check();
  const assignment = owner.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/assign'),
  );
  await button(owner, 'Görev sorumlusunu kaydet');
  assert.ok((await assignment).ok());
  await owner.waitForFunction(
    () => !document.querySelector('.today-workspace[data-selected=true]'),
  );
  assert.equal(
    await demo.db
      .prepare('SELECT assignee_membership_id FROM tasks WHERE id=?')
      .bind(assign.taskId)
      .first('assignee_membership_id'),
    'demo-member-ayse',
  );
  assert.equal((await api(a, `/api/tasks/${assign.taskId}/context?queue=WORK`)).status, 404);
  assert.equal((await api(b, `/api/tasks/${assign.taskId}/context?queue=WORK`)).status, 200);
  report.checks.push('REAL_OWNER_ASSIGN_EXPLICIT_DIRECTORY_DUAL_CAS_MEMBER_PRIVACY');
  stage = 'terminal-write-get-only-recovery';
  await b.setViewportSize({ width: 390, height: 844 });
  const bt = (await api(b, '/api/tasks/today?limit=20')).data.items.find(
    (x) => x.policyId === 'demo-policy-3',
  );
  assert.ok(bt);
  await selectTask(b, bt);
  await button(b, 'Yenileme sonucu');
  await button(b, 'Yenilenmedi olarak sonuçlandır');
  await b
    .getByRole('combobox', { name: 'Kayıp nedeni', exact: true })
    .selectOption('demo-loss-price');
  await b.getByLabel('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum', { exact: true }).check();
  let accepted = false,
    blockRead = true,
    posts = 0;
  const lostPath = `/api/renewals/${bt.renewalId}/close-lost`,
    readPattern = `**/api/customers/${bt.customerId}/renewals*`;
  await b.route('**' + lostPath, async (route) => {
    posts++;
    const response = await route.fetch();
    accepted = response.ok();
    await route.fulfill({ response });
  });
  await b.route(readPattern, (route) =>
    accepted && blockRead
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        })
      : route.continue(),
  );
  await button(b, 'Yenilenmedi olarak kaydet');
  await b
    .getByRole('button', { name: 'Yalnız yenileme okumasını yeniden dene', exact: true })
    .waitFor();
  await shot(b, 'lost-get-only-recovery-390');
  assert.equal(
    await b
      .getByRole('button', { name: 'Yenileme sonucu', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  blockRead = false;
  await button(b, 'Yalnız yenileme okumasını yeniden dene');
  await b.getByText(/sonucu kaydedildi ve yenileme kaydı kontrol edildi/).waitFor();
  assert.equal(posts, 1);
  assert.equal(
    await demo.db
      .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
      .bind(bt.renewalId)
      .first('state'),
    'LOST',
  );
  assert.equal(
    await demo.db.prepare('SELECT status FROM tasks WHERE id=?').bind(bt.taskId).first('status'),
    'COMPLETED',
  );
  await b.unroute('**' + lostPath);
  await b.unroute(readPattern);
  report.checks.push('REAL_LOST_POST_READBACK_FAILURE_GET_ONLY_NO_SECOND_POST');
  stage = 'integrity-and-storage';
  assert.equal((await demo.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  for (const page of demo.pages)
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  report.checks.push('FK_ZERO_BROWSER_STORAGE_EMPTY_NO_RUNTIME_CSP_OR_EXTERNAL_REQUESTS');
  report.partial = false;
  report.status = 'PASS';
  await save();
  console.info(
    JSON.stringify({
      status: 'PASS',
      cells: report.cells.length,
      screens: report.screens.length,
      checks: report.checks,
      errors: report.errors,
      externalRequests: report.externalRequests,
    }),
  );
} catch (e) {
  report.failure = {
    stage,
    name: e.name,
    message: stage === 'setup' ? 'DEMO_START_FAILED' : e.message,
    stack:
      stage === 'setup'
        ? []
        : e.stack
            ?.split('\n')
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 3),
  };
  await save().catch(() => {});
  console.error('V4_REAL_BROWSER_FAIL', JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  await demo?.close();
}
