/* global document, window, localStorage, sessionStorage, fetch */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const source = resolve(process.env.PHASE2_SOURCE_ROOT ?? process.cwd());
const mode = process.env.PHASE2_MODE ?? 'after';
assert.ok(['before', 'after'].includes(mode));
const run = process.env.PHASE2_RUN ?? mode;
const selectedCells = new Set((process.env.PHASE2_CELLS ?? '').split(',').filter(Boolean));
assert.match(run, /^[a-z0-9-]+$/);
const evidence = resolve('phase2-coverage-evidence', run),
  cache = resolve('node_modules/.cache/phase2-runtime-' + run);
const origin = 'https://localhost:16443',
  passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
const rows = [];
let demo,
  tls,
  server,
  browser,
  page,
  stage = 'setup';
try {
  await mkdir(resolve('phase2-coverage-evidence'), { recursive: true });
  await mkdir(evidence, { recursive: false });
  await mkdir(cache, { recursive: true });
  const bundle = join(cache, 'application.mjs');
  await build({
    entryPoints: [resolve(source, 'scripts/demo/application.ts')],
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
  const app = await import(pathToFileURL(bundle).href),
    adapter = join(cache, 'https.mjs');
  await writeFile(
    adapter,
    (await readFile(resolve(source, 'scripts/demo/https-server.mjs'), 'utf8'))
      .replaceAll('localhost:8443', 'localhost:16443')
      .replace('server.listen(8443,', 'server.listen(16443,')
      .replace("resolve('dist/client')", JSON.stringify(resolve(source, 'dist/client'))),
  );
  const https = await import(pathToFileURL(adapter).href);
  demo = await app.openDemo(passwords);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const day = (n) =>
    new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  for (const [key, name] of [
    ['trafik', 'Trafik'],
    ['konut', 'Konut'],
    ['dask', 'DASK'],
  ]) {
    await demo.db
      .prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES(?,'demo-agency',?,?,'GENERAL')",
      )
      .bind('coverage-branch-' + key, 'COVER_' + key.toUpperCase(), name)
      .run();
    await demo.db
      .prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES(?,'demo-agency','demo-insurer',?,?,?)",
      )
      .bind(
        'coverage-product-' + key,
        'coverage-branch-' + key,
        'COVER_' + key.toUpperCase(),
        name + ' Ürünü',
      )
      .run();
  }
  for (let n = 0; n < 22; n++)
    await demo.db
      .prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,email,assignee_membership_id) VALUES(?,'demo-agency','INDIVIDUAL',?,'Sentetik',?,?, 'demo-member-ahmet')",
      )
      .bind('coverage-page-' + n, 'Sentetik ' + n, String(n), 'sentetik' + n + '@example.invalid')
      .run();
  async function policy(id, branch = 'kasko', options = {}) {
    const product = branch === 'kasko' ? 'demo-product' : 'coverage-product-' + branch,
      branchId = branch === 'kasko' ? 'demo-branch' : 'coverage-branch-' + branch;
    await demo.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,archived_at,archived_by_membership_id,archive_reason) VALUES(?,'demo-agency',?,'demo-insurer',?,?,'demo-payment','demo-member-ahmet',?,?, ?,?,10000,'TRY',?,?,?,?)",
      )
      .bind(
        id,
        options.customerId ?? 'demo-customer-0',
        product,
        branchId,
        id.toUpperCase(),
        id.toUpperCase().replaceAll('-', ''),
        day(options.future ? 10 : -100),
        day(options.end ?? 30),
        options.status ?? 'ACTIVE',
        options.archived ? new Date().toISOString() : null,
        options.archived ? 'demo-member-owner' : null,
        options.archived ? 'SYNTHETIC_ARCHIVE' : null,
      )
      .run();
  }
  for (let n = 0; n < 24; n++) await policy('coverage-kasko-' + n);
  for (let n = 0; n < 25; n++)
    await policy('coverage-ayse-kasko-' + n, 'kasko', { customerId: 'demo-customer-1' });
  await policy('coverage-trafik', 'trafik', { end: 3 });
  await policy('coverage-konut', 'konut', { end: 10 });
  await policy('coverage-dask', 'dask', { end: 20 });
  await policy('coverage-expired', 'kasko', { end: -1 });
  await policy('coverage-future', 'kasko', { future: true, end: 90 });
  await policy('coverage-cancelled', 'kasko', { status: 'CANCELLED' });
  await policy('coverage-voided', 'kasko', { status: 'VOIDED' });
  await policy('coverage-archived', 'kasko', { archived: true });
  const counts = await demo.db
    .prepare(
      "SELECT COUNT(*) AS count FROM policies WHERE agency_id='demo-agency' AND customer_id='demo-customer-0' AND status='ACTIVE' AND archived_at IS NULL AND start_date<=? AND end_date>=?",
    )
    .bind(today, today)
    .first();
  tls = await https.demoCertificate();
  server = await https.serveDemo(demo, tls);
  browser = await chromium.launch({ channel: 'msedge', headless: false });
  for (const actorIndex of [0, 1, 2])
    for (const width of [1440, 768, 360]) {
      const user = app.DEMO_USERS[actorIndex],
        row = { actor: user.id, width, mode, checks: [], screenshots: [] };
      if (selectedCells.size && !selectedCells.has(`${user.id}:${width}`)) continue;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 1000 },
        hasTouch: width < 901,
      });
      page = await context.newPage();
      page.setDefaultTimeout(20000);
      let runtimeErrors = 0;
      page.on('pageerror', () => runtimeErrors++);
      const button = (name) => page.getByRole('button', { name, exact: true });
      const shot = async (name) => {
        const file = user.id + '-' + width + '-' + name + '.png';
        await page.screenshot({ path: join(evidence, file), fullPage: true });
        row.screenshots.push(file);
      };
      stage = user.id + ':' + width + ':login';
      await page.goto(origin);
      await page.getByLabel('E-posta', { exact: true }).fill(user.email);
      await page.getByLabel('Şifre', { exact: true }).fill(passwords[actorIndex]);
      await button('Giriş Yap').click();
      await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
      await page.goto(origin + '/customers');
      await page.getByRole('heading', { name: 'Müşteriler', exact: true }).waitFor();
      let listPolicyReads = 0;
      const requests = (request) => {
        if (new URL(request.url()).pathname === '/api/policies') listPolicyReads++;
      };
      page.on('request', requests);
      await page.getByLabel('Müşteri ara', { exact: true }).fill('example.invalid');
      await page.getByLabel('Müşteri türü', { exact: true }).selectOption('INDIVIDUAL');
      await Promise.all([
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === '/api/customers' &&
            new URL(r.url()).searchParams.get('search') === 'example.invalid' &&
            r.status() === 200,
        ),
        button('Ara').click(),
      ]);
      await button('Sonraki sayfa').click();
      await page.getByText('Sayfa 2 · Her sayfada en fazla 20 kayıt', { exact: true }).waitFor();
      const customer = page.getByRole('link', { name: 'Deniz Yılmaz', exact: true });
      await customer.waitFor();
      if (mode === 'after') {
        const rowText = await customer.locator('xpath=ancestor::tr').innerText();
        assert.ok(rowText.includes(counts.count + ' yürürlükte poliçe'));
        assert.ok(rowText.includes('+1'));
        assert.ok(rowText.includes('Kasko'));
        assert.equal(listPolicyReads, 0);
        row.checks.push('bounded-page-summary-real-catalog-count-no-policy-fanout');
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
      }
      await shot('customer-list');
      await page.evaluate(() => window.scrollTo(0, 400));
      const outgoing = await page.evaluate(() => window.scrollY);
      await customer.evaluate((link) => link.click());
      await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
      if (mode === 'after') {
        stage = user.id + ':' + width + ':summary';
        const summary = page.getByRole('region', { name: 'Sigorta özeti' });
        await summary.getByText(counts.count + ' yürürlükte poliçe', { exact: true }).waitFor();
        assert.equal(await summary.getByRole('link', { name: /Trafik Ürünü/ }).count(), 1);
        assert.match(await summary.innerText(), /Süresi dolmuş:\s*1/);
        assert.match(await summary.innerText(), /Başlangıcı beklenen:\s*1/);
        assert.ok(!(await summary.innerText()).includes('coverage-branch-'));
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
        await shot('customer-profile');
        const nearest = summary.getByRole('link', { name: /Trafik Ürünü/ });
        await nearest.focus();
        assert.equal(await nearest.evaluate((link) => document.activeElement === link), true);
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: 'COVERAGE-TRAFIK', exact: true }).waitFor();
        await page.goBack();
        await summary.waitFor();
        row.checks.push('profile-nearest-real-policy-keyboard-link-status-versus-period');
        await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
        await customer.waitFor();
        assert.equal(
          await page.getByLabel('Müşteri ara', { exact: true }).inputValue(),
          'example.invalid',
        );
        assert.equal(
          await page.getByLabel('Müşteri türü', { exact: true }).inputValue(),
          'INDIVIDUAL',
        );
        await page.getByText('Sayfa 2 · Her sayfada en fazla 20 kayıt', { exact: true }).waitFor();
        await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 3, outgoing);
        assert.equal(new URL(page.url()).search, '');
        row.checks.push('spa-only-search-filter-cursor-scroll-return');
        stage = user.id + ':' + width + ':task-return';
        await page.goto(origin + '/today-work');
        const queue = await page.evaluate(async () => {
          const r = await fetch('/api/tasks/today?limit=20');
          return (await r.json()).data;
        });
        const visibleTasks = [...queue.items, ...queue.unassignedItems];
        const task =
          visibleTasks.find((item) => item.customerId === 'demo-customer-0') ??
          visibleTasks.find((item) => item.customerId === 'demo-customer-1');
        assert.ok(task);
        await page.goto(
          origin +
            '/today-work?task=' +
            encodeURIComponent(task.taskId) +
            '&queue=WORK&work=quotes',
        );
        await button('İletişim kaydı ekle').waitFor();
        await page.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
        await page
          .getByRole('link', { name: 'Tüm poliçeleri ve yenilemeleri görüntüle', exact: true })
          .click();
        await page.getByText('Kasko · Anadolu Sigorta · Kasko', { exact: true }).first().waitFor();
        await page.getByRole('button', { name: 'Sonraki poliçeler', exact: true }).waitFor();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll('button')).find(
              (b) => b.textContent === 'Sonraki poliçeler',
            )?.disabled,
        );
        await button('Sonraki poliçeler').click();
        await page.waitForURL((u) => u.searchParams.has('after'));
        await page.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
        await button('İletişim kaydı ekle').waitFor();
        assert.equal(new URL(page.url()).searchParams.get('task'), task.taskId);
        assert.equal(await button('Teklifler').getAttribute('aria-expanded'), 'true');
        row.checks.push('complete-named-paginated-history-and-exact-Task-A-return');
        stage = user.id + ':' + width + ':note-regression';
        await page.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
        await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
        const note = page.getByLabel('Yeni müşteri notu', { exact: true });
        const draft = '  Sentetik Phase2 ' + user.id + ' ' + width + '\nİkinci satır  ';
        await note.fill(draft);
        const handle = await note.elementHandle();
        await page.getByRole('link', { name: 'Genel bilgiler', exact: true }).click();
        await page.goBack();
        await note.waitFor();
        assert.equal(await note.inputValue(), draft);
        assert.equal(await note.evaluate((el, old) => el === old, handle), true);
        await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
        await button('Bu ekranda kal').click();
        assert.equal(await note.inputValue(), draft);
        await button('Not taslağını iptal et').click();
        assert.equal(await note.inputValue(), '');
        row.checks.push('mounted-note-draft-section-POP-stay-cancel');
        assert.deepEqual(
          await page.evaluate(() => ({
            local: Object.keys(localStorage),
            session: Object.keys(sessionStorage),
          })),
          { local: [], session: [] },
        );
        row.checks.push('no-browser-storage');
      } else {
        await shot('customer-profile');
        row.checks.push('accepted-main-before-capture-only');
      }
      page.off('request', requests);
      assert.equal(runtimeErrors, 0);
      row.runtimeErrors = runtimeErrors;
      rows.push(row);
      await writeFile(join(evidence, 'progress.json'), JSON.stringify({ mode, rows }, null, 2));
      await context.close();
      console.info('EDGE_CELL_PASS', mode, user.id, width);
    }
  assert.equal(rows.length, selectedCells.size || 9, 'every selected cell must complete');
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        browser: browser.version(),
        sourceRoot: source,
        mode,
        selectedCells: [...selectedCells],
        expectedActiveCount: counts.count,
        rows,
      },
      null,
      2,
    ),
  );
  console.info('EDGE_COMPLETE', mode, rows.length);
} catch (error) {
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify(
      {
        stage,
        error: error.name,
        message: error.message.split('\n')[0],
        completedCells: rows.length,
      },
      null,
      2,
    ),
  );
  console.error('EDGE_FAILED', mode, stage, error.name);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
}
