/* global document, window, localStorage, sessionStorage, fetch */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const run = process.env.WORKSPACE_RUN;
assert.match(run ?? '', /^[a-z0-9-]+$/);
const width = Number(process.env.WORKSPACE_WIDTH ?? 1440),
  actor = process.env.WORKSPACE_ACTOR ?? 'owner';
const height = Number(process.env.WORKSPACE_HEIGHT ?? 1000);
const before = process.argv.includes('--before'),
  preview = process.argv.includes('--preview');
const client = resolve(
  process.env.WORKSPACE_CLIENT ?? 'node_modules/.cache/modern-workspace-client',
);
const evidence = resolve('modern-workspace-evidence', run),
  cache = resolve('node_modules/.cache/modern-runtime-' + run),
  origin = 'https://localhost:19443';
const passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
let demo,
  tls,
  server,
  browser,
  page,
  stage = 'setup';
const result = { actor, width, before, preview, checks: [], screenshots: [], measurements: {} };
try {
  await mkdir(evidence, { recursive: false });
  await mkdir(cache, { recursive: true });
  const bundle = join(cache, 'application.mjs');
  await build({
    entryPoints: [resolve('scripts/demo/application.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  await writeFile(
    bundle,
    (await readFile(bundle, 'utf8')).replaceAll('https://localhost:8443', origin),
  );
  const app = await import(pathToFileURL(bundle).href);
  const adapter = join(cache, 'https.mjs');
  await writeFile(
    adapter,
    (await readFile('scripts/demo/https-server.mjs', 'utf8'))
      .replaceAll('localhost:8443', 'localhost:19443')
      .replace('server.listen(8443,', 'server.listen(19443,')
      .replace("resolve('dist/client')", JSON.stringify(client)),
  );
  const https = await import(pathToFileURL(adapter).href);
  demo = await app.openDemo(passwords);
  // Real, same-customer next-period policy fixtures for the existing WON LINK command.
  const originals = (
    await demo.db.prepare("SELECT * FROM policies WHERE agency_id='demo-agency'").all()
  ).results;
  for (const p of originals) {
    const end = new Date(Date.parse(p.end_date + 'T00:00:00Z') + 365 * 86400000)
      .toISOString()
      .slice(0, 10);
    await demo.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'demo-agency',?,'demo-insurer','demo-product','demo-branch','demo-payment',?,?,?,?,?,1000000,'TRY')",
      )
      .bind(
        'next-' + p.id,
        p.customer_id,
        p.assignee_membership_id,
        'NEXT-' + p.policy_number,
        'NEXT' + p.normalized_policy_number,
        p.end_date,
        end,
      )
      .run();
  }
  tls = await https.demoCertificate();
  server = await https.serveDemo(demo, tls);
  browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: preview ? ['--start-maximized'] : [],
  });
  const index = app.DEMO_USERS.findIndex((u) => u.id === actor);
  assert.ok(index >= 0);
  const user = app.DEMO_USERS[index];
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: preview ? null : { width, height },
    hasTouch: width < 901,
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  let errors = 0;
  page.on('pageerror', () => errors++);
  const button = (name) => page.getByRole('button', { name, exact: true });
  const op = async (name) => {
    await button(name).click();
    if (!before) assert.equal(await button(name).getAttribute('aria-pressed'), 'true');
  };
  const shot = async (name) => {
    const file = name + '.png';
    await page.screenshot({ path: join(evidence, file), fullPage: true });
    result.screenshots.push(file);
  };
  const measure = () =>
    page.evaluate(() => ({
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      operationHeight:
        document.querySelector('.crm-operation-region')?.getBoundingClientRect().height ?? null,
      visibleOperationPanels: [...document.querySelectorAll('.crm-operation-panel')].filter(
        (x) => x.getClientRects().length > 0,
      ).length,
      visibleControls: [
        ...document.querySelectorAll('.today-overview button,.today-overview a'),
      ].filter((x) => x.getClientRects().length > 0).length,
    }));
  const selectFirst = async () => {
    await page.locator('.today-task-row').first().click();
    await button('İletişim kaydı ekle').waitFor();
    return new URL(page.url()).searchParams.get('task');
  };
  const returnQueue = async () => {
    await button('Görev listesine dön').click();
    await page.locator('.today-task-row').first().waitFor();
  };
  const readTask = async (id) =>
    page.evaluate(async (id) => {
      const r = await fetch('/api/tasks/' + encodeURIComponent(id) + '/context?queue=WORK');
      const j = await r.json();
      return j.data.items.find((x) => x.taskId === id);
    }, id);
  stage = 'login';
  await page.goto(origin);
  await page.getByLabel('E-posta', { exact: true }).fill(user.email);
  await page.getByLabel('Şifre', { exact: true }).fill(passwords[index]);
  await button('Giriş Yap').click();
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  await page.goto(origin + '/today-work');
  let selectedId = await selectFirst();
  if (!before && !preview) {
    await returnQueue();
    assert.equal(await button('Atanmamış işler').count(), 0);
    assert.equal(await button('Yeniden atama gerekenler').count(), 0);
    let reads = 0;
    const observe = (request) => {
      if (new URL(request.url()).pathname === '/api/tasks/today') reads++;
    };
    page.on('request', observe);
    await page.getByLabel('Yüklü takiplerde ara', { exact: true }).fill('eşleşmeyen-sentetik');
    await page.getByText(/Yüklü takiplerde eşleşme yok/).waitFor();
    await page.getByLabel('Yüklü takiplerde ara', { exact: true }).fill('');
    await page.getByLabel('Takip zamanı', { exact: true }).selectOption('TODAY');
    await page.getByLabel('Takip zamanı', { exact: true }).selectOption('ALL');
    assert.equal(reads, 0);
    page.off('request', observe);
    const rows = page.locator('.today-task-row');
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await rows.nth(1).evaluate((el) => document.activeElement === el), true);
    await page.keyboard.press('Enter');
    await button('Görev listesine dön').click();
    await rows.first().waitFor();
    selectedId = await selectFirst();
    result.checks.push('authorized-queue-local-search-filter-no-refetch-keyboard-selection');
  }
  result.measurements.initial = await measure();
  await shot('initial');
  if (before) {
    await op('Teklifler');
    await button('Teklif geçmişini aç').click();
    await page.locator('.quote-current-summary').waitFor();
    result.measurements.quotes = await measure();
    await shot('quotes');
    await button(
      before ? 'Teklif 1 için yeni değişmez sürüm taslağı aç' : 'Teklif 1 için revizyon',
    ).click();
    await page.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('14500.00');
    result.measurements.form = await measure();
    await shot('revision');
  } else if (preview) {
    const auth = await page.evaluate(async () => {
      const r = await fetch('/api/auth/session', { cache: 'no-store' });
      return { status: r.status, data: (await r.json()).data };
    });
    assert.equal(auth.status, 200);
    assert.equal(auth.data.state, 'NORMAL');
    assert.equal(auth.data.isOwner, true);
    assert.equal(auth.data.email, user.email);
    result.ownerSessionVerified = true;
    await op('Teklifler');
    await page.locator('.quote-current-summary').waitFor();
    await page.bringToFront();
    const cdp = await browser.newBrowserCDPSession();
    const procs = await cdp.send('SystemInfo.getProcessInfo');
    const browserPid = procs.processInfo.find((p) => p.type === 'browser').id;
    const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);' -Name ModernWindow -Namespace Native; $p=Get-Process -Id ${browserPid}; if($p.MainWindowHandle -eq 0 -or -not [Native.ModernWindow]::IsWindowVisible($p.MainWindowHandle)){exit 2}; Write-Output 'VISIBLE_WINDOW_VERIFIED'`;
    assert.match(
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true },
      ),
      /VISIBLE_WINDOW_VERIFIED/,
    );
    result.nativeWindowVisible = true;
    result.measurements.preview = await measure();
    await shot('owner-preview');
    const stylesheet = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="stylesheet"]');
      return { path: new URL(link.href).pathname, text: await (await fetch(link.href)).text() };
    });
    assert.equal(
      createHash('sha256').update(stylesheet.text).digest('hex'),
      createHash('sha256')
        .update(await readFile(resolve(client, stylesheet.path.slice(1))))
        .digest('hex'),
    );
    await writeFile(
      join(evidence, 'preview.json'),
      JSON.stringify(
        {
          url: page.url(),
          browser: browser.version(),
          actor,
          headless: false,
          cssMatches: true,
          ...result,
        },
        null,
        2,
      ),
    );
    console.info('MODERN_PREVIEW_READY', origin + '/today-work');
    await new Promise((yes) => {
      browser.once('disconnected', yes);
      page.once('close', yes);
      process.once('SIGTERM', yes);
      process.once('SIGINT', yes);
    });
  } else if (process.argv.includes('--layout-only')) {
    const initial = await measure();
    assert.equal(initial.visibleOperationPanels, 1);
    assert.ok(initial.documentWidth <= width);
    if (height >= 900) assert.ok(initial.documentHeight <= height + 2);
    await op('Teklifler');
    await page.locator('.quote-current-summary').waitFor();
    result.measurements.quotes = await measure();
    await shot('quotes');
    await button(
      before ? 'Teklif 1 için yeni değişmez sürüm taslağı aç' : 'Teklif 1 için revizyon',
    ).click();
    const field = page.getByLabel('Teklif brüt primi (ana birim)', { exact: true });
    await field.fill('14500.00');
    const node = await field.elementHandle();
    await op('İletişim');
    assert.equal(await field.isVisible(), false);
    await page.getByRole('button', { name: 'Teklifler — taslağa dön', exact: true }).click();
    assert.equal(await field.inputValue(), '14500.00');
    assert.equal(await field.evaluate((el, old) => el === old, node), true);
    result.measurements.form = await measure();
    await shot('revision');
    assert.equal(result.measurements.form.visibleOperationPanels, 1);
    if (height >= 900) assert.ok(result.measurements.form.documentHeight <= height + 2);
    else
      assert.ok(
        result.measurements.form.operationHeight >= 250,
        'short viewport must retain a usable working region',
      );
    const detail = button('Teklif 1 sürümleri ve olayları');
    await detail.click();
    await page.getByRole('dialog', { name: 'Teklif 1 sürümleri ve olayları' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await detail.evaluate((el) => document.activeElement === el), true);
    result.checks.push(
      'responsive-bounded-workspace-mode-replacement-mounted-draft-dialog-keyboard-focus',
    );
  } else {
    const first = await measure();
    assert.ok(first.documentWidth <= width);
    assert.equal(first.visibleOperationPanels, 1);
    if (width === 1440)
      assert.ok(first.documentHeight <= 1002, 'desktop document must fit viewport');
    const nextAction = await button('İletişim kaydı ekle').boundingBox();
    assert.ok(
      nextAction && nextAction.y + nextAction.height <= 1000,
      'primary next action visible',
    );
    result.checks.push('viewport-context-selector-next-action-visible');
    stage = 'communication-uncertain';
    await button('İletişim kaydı ekle').click();
    await page.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
    const note = page.getByLabel('İç not', { exact: true });
    const noteText = `Sentetik modern ${actor} ${width}`;
    await note.fill(noteText);
    const noteHandle = await note.elementHandle();
    await op('Teklifler');
    await page.locator('.quote-current-summary').waitFor();
    assert.equal(await note.isVisible(), false);
    await page.getByRole('button', { name: 'İletişim — taslağa dön', exact: true }).click();
    assert.equal(await note.inputValue(), noteText);
    assert.equal(await note.evaluate((n, old) => n === old, noteHandle), true);
    const writes = [];
    let lose = true;
    await page.route('**/api/renewals/*/interactions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      const response = await route.fetch();
      if (lose) {
        lose = false;
        return route.abort('failed');
      }
      return route.fulfill({ response });
    });
    await button('İletişim kaydını kaydet').click();
    await button('Aynı iletişim isteğini yeniden dene').waitFor();
    await op('Teklifler');
    await page.getByRole('button', { name: 'İletişim — sonucu doğrula', exact: true }).click();
    await button('Aynı iletişim isteğini yeniden dene').click();
    await page.getByText(/İletişim kaydı kaydedildi/).waitFor();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].key, writes[1].key);
    assert.equal(writes[0].body, writes[1].body);
    await page.unroute('**/api/renewals/*/interactions');
    result.checks.push('hidden-mounted-draft-real-note-uncertain-exact-retry');
    stage = 'quote-revision';
    await op('Teklifler');
    await button(
      before ? 'Teklif 1 için yeni değişmez sürüm taslağı aç' : 'Teklif 1 için revizyon',
    ).click();
    const premium = page.getByLabel('Teklif brüt primi (ana birim)', { exact: true });
    await premium.fill('14500.00');
    const premiumHandle = await premium.elementHandle();
    await op('Görev işlemleri');
    await page.getByRole('button', { name: 'Teklifler — taslağa dön', exact: true }).click();
    assert.equal(await premium.inputValue(), '14500.00');
    assert.equal(await premium.evaluate((n, old) => n === old, premiumHandle), true);
    result.measurements.form = await measure();
    await shot('revision');
    await page
      .getByLabel('Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum', { exact: true })
      .check();
    await button('Revizyonu kaydet').click();
    await page.getByText('Teklif kaydedildi ve geçmiş güncellendi.', { exact: true }).waitFor();
    assert.match(await page.locator('.quote-current-summary').innerText(), /14\.500,00/);
    const history = button('Teklif 1 sürümleri ve olayları');
    await history.click();
    await page.getByRole('dialog', { name: 'Teklif 1 sürümleri ve olayları' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await history.evaluate((n) => document.activeElement === n), true);
    stage = 'quote-sent';
    await button('Teklifi gönderildi olarak kaydet').click();
    const choose = page.getByLabel('Gönderildi olarak kaydedilecek teklif ve güncel sürüm', {
      exact: true,
    });
    const quoteId = await choose.locator('option').nth(1).getAttribute('value');
    await choose.selectOption(quoteId);
    await page
      .getByLabel('Seçili sürümü dış kanaldan ilettiğimi ve gönderildi kaydını onaylıyorum', {
        exact: true,
      })
      .check();
    await button('Gönderildi kaydını onayla').click();
    await page.getByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/).waitFor();
    result.measurements.quotes = await measure();
    await shot('quotes');
    result.checks.push('real-revision-Turkish-money-detail-focus-and-SENT-not-delivery');
    stage = 'navigation';
    await page.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
    await page.getByRole('region', { name: 'Sigorta özeti' }).waitFor();
    await page.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('task'), selectedId);
    await page.getByRole('link', { name: 'Poliçeyi aç', exact: true }).click();
    await page.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('task'), selectedId);
    result.checks.push('Phase2-coverage-and-exact-task-return');
    stage = 'complete';
    await op('Görev işlemleri');
    await button('Yeni takip planını aç').click();
    await page.getByLabel('Yeni takip zamanı (İstanbul)', { exact: true }).fill('2098-10-21T11:30');
    await page
      .getByLabel('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum', { exact: true })
      .check();
    let completePosts = 0,
      committed = false,
      readLost = false;
    await page.route('**/api/renewals/*/tasks/*/complete', async (route) => {
      completePosts++;
      const response = await route.fetch();
      assert.ok(response.ok());
      committed = true;
      await route.fulfill({ response });
    });
    await page.route('**/api/tasks/*/context*', async (route) => {
      if (committed && !readLost) {
        readLost = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"success":false}',
        });
      }
      return route.continue();
    });
    await button('Takibi tamamla ve planla').click();
    await button('Yalnız tamamlama kuyruğunu yeniden oku').click();
    await page
      .getByText(
        'Takip tamamlandı ve yeni takip oluşturuldu. İş listeniz güncellendi. Yenileme henüz sonuçlandırılmadı.',
        { exact: true },
      )
      .waitFor();
    assert.equal(completePosts, 1);
    assert.equal(await page.locator('.today-task-row[aria-pressed="true"]').count(), 0);
    await page.unroute('**/api/renewals/*/tasks/*/complete');
    await page.unroute('**/api/tasks/*/context*');
    result.checks.push('accepted-task-completion-GET-only-no-auto-replacement-selection');
    stage = 'won';
    selectedId = await selectFirst();
    let task = await readTask(selectedId);
    await op('Yenileme sonucu');
    await button('Kazanıldı — mevcut poliçeyi bağla').click();
    await page
      .getByRole('combobox', { name: /Bağlanacak mevcut poliçe/ })
      .selectOption('next-' + task.policyId);
    await page
      .getByLabel('Seçilen poliçenin priminin tamamını bu yenilemeye tahsis ediyorum', {
        exact: true,
      })
      .check();
    await page
      .getByLabel('Kazanıldı sonucunu ve seçtiğim kayıtları onaylıyorum', { exact: true })
      .check();
    await button('Yenilemeyi kazanıldı olarak kaydet').click();
    await page.waitForFunction(
      () => !document.querySelector('.today-task-row[aria-pressed="true"]'),
    );
    assert.equal(
      (
        await demo.db
          .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
          .bind(task.renewalId)
          .first()
      ).state,
      'WON',
    );
    result.checks.push('real-authorized-WON-link-full-allocation-confirmations');
    stage = 'lost';
    selectedId = await selectFirst();
    task = await readTask(selectedId);
    await op('Yenileme sonucu');
    await button('Yenilenmedi olarak sonuçlandır').click();
    await page.getByRole('combobox', { name: /Kayıp nedeni/ }).selectOption('demo-loss-price');
    await page
      .getByLabel('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum', { exact: true })
      .check();
    await button('Yenilenmedi olarak kaydet').click();
    await page.waitForFunction(
      () => !document.querySelector('.today-task-row[aria-pressed="true"]'),
    );
    assert.equal(
      (
        await demo.db
          .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
          .bind(task.renewalId)
          .first()
      ).state,
      'LOST',
    );
    result.checks.push('real-authorized-LOST-reason-and-confirmation');
    if (actor === 'owner') {
      stage = 'void';
      selectedId = await selectFirst();
      task = await readTask(selectedId);
      await op('Yenileme sonucu');
      await button('Geçersiz olarak işaretle').click();
      await page
        .getByRole('combobox', { name: /Geçersizlik nedeni/ })
        .selectOption('TECHNICAL_ERROR');
      await page
        .getByLabel('Geçersiz sonucunu ve seçili nedeni onaylıyorum', { exact: true })
        .check();
      await button('Geçersiz olarak kaydet').click();
      await page.waitForFunction(
        () => !document.querySelector('.today-task-row[aria-pressed="true"]'),
      );
      assert.equal(
        (
          await demo.db
            .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
            .bind(task.renewalId)
            .first()
        ).state,
        'VOIDED',
      );
      result.checks.push('real-owner-VOIDED-technical-reason-not-LOST');
      stage = 'followup-controls';
      await selectFirst();
      await op('Görev işlemleri');
      await button('Yeni takip planını aç').waitFor();
      assert.equal(await button('Görev atama seçeneklerini aç').count(), 0);
      result.checks.push('real-owner-followup-without-assignment-controls');
    }
    assert.deepEqual(
      await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      })),
      { local: [], session: [] },
    );
    result.checks.push('no-private-browser-storage');
  }
  assert.equal(errors, 0);
  result.runtimeErrors = errors;
  result.browser = browser.version();
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.info('MODERN_CELL_PASS', actor, width, before ? 'before' : preview ? 'preview' : 'after');
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(
      join(evidence, 'diagnostic.json'),
      JSON.stringify(
        {
          alerts: await page.getByRole('alert').allTextContents(),
          options: await page.locator('select').evaluateAll((selects) =>
            selects.map((s) => ({
              label: s.getAttribute('aria-label') ?? s.id,
              disabled: s.disabled,
              options: [...s.options].map((o) => ({ value: o.value, text: o.textContent })),
            })),
          ),
        },
        null,
        2,
      ),
    );
  }
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify(
      {
        stage,
        error: error.name,
        message: error.message.split('\n')[0],
        stack: error.stack
          ?.split('\n')
          .filter((x) => x.trim().startsWith('at '))
          .slice(0, 4),
        result,
      },
      null,
      2,
    ),
  );
  console.error('MODERN_FAILED', stage, error.name);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
}
