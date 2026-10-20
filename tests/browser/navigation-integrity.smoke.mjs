/* global fetch, document, window, history, localStorage, sessionStorage */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = process.cwd(),
  source = process.env.PHASE1_SOURCE_ROOT ?? root;
const evidence = resolve('phase1-navigation-evidence');
const cache = resolve('node_modules/.cache/phase1-runtime');
const origin = 'https://localhost:15443';
const passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
let demo,
  tls,
  server,
  browser,
  page,
  stage = 'setup';
const rows = [];
try {
  await mkdir(evidence, { recursive: true });
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
  const app = await import(pathToFileURL(bundle).href);
  const adapter = join(cache, 'https.mjs');
  await writeFile(
    adapter,
    (await readFile(resolve(source, 'scripts/demo/https-server.mjs'), 'utf8'))
      .replaceAll('localhost:8443', 'localhost:15443')
      .replace('server.listen(8443,', 'server.listen(15443,')
      .replace(
        "resolve('dist/client')",
        JSON.stringify(resolve('node_modules/.cache/phase1-client')),
      ),
  );
  const https = await import(pathToFileURL(adapter).href);
  demo = await app.openDemo(passwords);
  tls = await https.demoCertificate();
  server = await https.serveDemo(demo, tls);
  browser = await chromium.launch({ channel: 'msedge', headless: false });
  for (const [actorIndex, width] of [
    [0, 1440],
    [1, 1440],
    [0, 360],
    [1, 360],
  ]) {
    const user = app.DEMO_USERS[actorIndex];
    const row = { actor: user.id, width, checks: [], screenshots: [] };
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height: 1000 },
      hasTouch: width < 901,
    });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    let runtimeErrors = 0;
    page.on('pageerror', () => {
      runtimeErrors++;
    });
    const button = (name) => page.getByRole('button', { name, exact: true });
    const shot = async (name) => {
      const file = `${user.id}-${width}-${name}.png`;
      await page.screenshot({ path: join(evidence, file), fullPage: true });
      row.screenshots.push(file);
    };
    stage = `${user.id}:${width}:login`;
    await page.goto(origin);
    await page.getByLabel('E-posta', { exact: true }).fill(user.email);
    await page.getByLabel('Şifre', { exact: true }).fill(passwords[actorIndex]);
    await button('Giriş Yap').click();
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    stage = `${user.id}:${width}:task-return`;
    await page.goto(origin + '/today-work');
    await page.locator('.today-task-row').first().click();
    await button('İletişim kaydı ekle').waitFor();
    const selectedId = new URL(page.url()).searchParams.get('task');
    assert.ok(selectedId);
    const queue = await page.evaluate(async () => {
      const r = await fetch('/api/tasks/today?limit=20');
      return (await r.json()).data;
    });
    const task = [...queue.items, ...queue.unassignedItems].find(
      (item) => item.taskId === selectedId,
    );
    assert.ok(task);
    await button('Teklifler').click();
    await page.evaluate(() => {
      window.scrollTo(0, 400);
      const list = document.querySelector('.today-queue > [data-slot="card-content"]');
      if (list) list.scrollTop = 50;
    });
    const before = await page.evaluate(() => ({
      page: window.scrollY,
      queue: document.querySelector('.today-queue > [data-slot="card-content"]')?.scrollTop ?? 0,
    }));
    // Activate the real link without Playwright first scrolling it into view;
    // otherwise its automatic scroll would replace the very outgoing position measured.
    await page
      .getByRole('link', { name: 'Müşteri profilini aç', exact: true })
      .evaluate((link) => link.click());
    await page.waitForURL(origin + `/customers/${task.customerId}`);
    await page.locator('.customer-modern').waitFor();
    await page.goBack();
    await button('İletişim kaydı ekle').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('task'), selectedId);
    assert.equal(await page.locator('.today-task-row[aria-pressed="true"]').count(), 1);
    assert.equal(await button('Teklifler').getAttribute('aria-expanded'), 'true');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      page: window.scrollY,
      queue: document.querySelector('.today-queue > [data-slot="card-content"]')?.scrollTop ?? 0,
    }));
    await writeFile(
      join(evidence, 'scroll-diagnostic.json'),
      JSON.stringify({ before, after, url: page.url() }, null, 2),
    );
    assert.ok(Math.abs(after.page - before.page) < 3, 'page scroll restoration');
    assert.equal(after.queue, before.queue);
    row.scroll = { before, after };
    row.checks.push('customer-back-exact-task-section-scroll');
    await page.goForward();
    await page.locator('.customer-modern').waitFor();
    await page.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
    await button('İletişim kaydı ekle').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('task'), selectedId);
    row.checks.push('forward-explicit-return');
    await page.getByRole('link', { name: 'Poliçeyi aç', exact: true }).click();
    await page.getByRole('heading', { name: task.policyNumber, exact: true }).waitFor();
    await page.getByRole('link', { name: 'Zeyiller', exact: true }).click();
    await page.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
    await button('İletişim kaydı ekle').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('task'), selectedId);
    row.checks.push('policy-section-explicit-return');
    await page.reload();
    await button('İletişim kaydı ekle').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('task'), selectedId);
    assert.equal(await button('Teklifler').getAttribute('aria-expanded'), 'true');
    await page.goto(
      origin + `/today-work?task=${encodeURIComponent(selectedId)}&queue=WORK&work=quotes`,
    );
    await button('İletişim kaydı ekle').waitFor();
    assert.equal(await button('Teklifler').getAttribute('aria-expanded'), 'true');
    row.checks.push('reload-direct-exact-context');
    await shot('task-restored');
    stage = `${user.id}:${width}:note-sections`;
    const taskHistoryIndex = await page.evaluate(() => history.state.idx);
    await page.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
    await page.waitForURL(origin + `/customers/${task.customerId}`);
    await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
    const note = page.getByLabel('Yeni müşteri notu', { exact: true });
    await note.waitFor();
    const element = await note.elementHandle();
    const content = `Sentetik Phase1 ${user.id} ${width}`;
    await note.fill('  ' + content + '\nİkinci satır  ');
    await page.getByRole('link', { name: 'Genel bilgiler', exact: true }).click();
    await page.goBack();
    await note.waitFor();
    assert.equal(await note.evaluate((el, old) => el === old, element), true);
    await page.goForward();
    await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
    assert.equal(await note.inputValue(), '  ' + content + '\nİkinci satır  ');
    await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
    await button('Bu ekranda kal').click();
    assert.equal(await note.inputValue(), '  ' + content + '\nİkinci satır  ');
    await page.evaluate((index) => history.go(index - history.state.idx), taskHistoryIndex);
    await button('Bu ekranda kal').click();
    assert.equal(await note.evaluate((el, old) => el === old, element), true);
    assert.equal(await note.inputValue(), '  ' + content + '\nİkinci satır  ');
    row.checks.push('note-native-POP-to-task-stay');
    await shot('note-preserved');
    row.checks.push('note-section-back-forward-stay-exact-dom');
    await button('Not taslağını iptal et').click();
    assert.equal(await note.inputValue(), '');
    row.checks.push('note-explicit-cancel');
    // Real POST reaches the synthetic Worker and commits; lose only its browser response.
    stage = `${user.id}:${width}:note-uncertain`;
    let phase = 'lose',
      writes = [],
      gateRelease;
    let held = false;
    const gate = new Promise((resolveGate) => {
      gateRelease = resolveGate;
    });
    await page.route('**/api/customers/*/notes', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') {
        await route.continue();
        return;
      }
      writes.push({ body: request.postData(), key: request.headers()['idempotency-key'] });
      if (phase === 'lose') {
        phase = 'retry';
        const r = await route.fetch();
        assert.equal(r.status(), 201);
        await route.abort();
        return;
      }
      if (phase === 'hold') {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await note.fill(content);
    await button('Notu kaydet').click();
    await button('Aynı notu yeniden dene').waitFor();
    assert.equal(await note.isDisabled(), true);
    await page.getByRole('link', { name: 'Genel bilgiler', exact: true }).click();
    await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
    await page.getByText(/Not isteğinin sonucu henüz doğrulanmadı/).waitFor();
    await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
    assert.equal(await note.inputValue(), content);
    await button('Aynı notu yeniden dene').click();
    await page.getByText('Not kaydedildi.', { exact: true }).waitFor();
    assert.equal(writes.length, 2);
    assert.ok(writes[0].body === writes[1].body && writes[0].key === writes[1].key);
    const count = await demo.db
      .prepare('SELECT COUNT(*) AS n FROM customer_notes WHERE customer_id=? AND content=?')
      .bind(task.customerId, content)
      .first();
    assert.equal(count.n, 1);
    row.checks.push('note-post-response-loss-exact-retry-one-db-row');
    stage = `${user.id}:${width}:note-pending`;
    phase = 'hold';
    await note.fill(content + ' bekleyen');
    await button('Notu kaydet').click();
    await page.waitForTimeout(100);
    assert.ok(held);
    await page.getByRole('link', { name: 'Genel bilgiler', exact: true }).click();
    await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
    await page.getByText(/Not isteğinin sonucu henüz doğrulanmadı/).waitFor();
    gateRelease();
    await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
    await page.getByText('Not kaydedildi.', { exact: true }).waitFor();
    assert.equal(writes.length, 3);
    row.checks.push('pending-mounted-blocked-departure-one-submit');
    await page.unroute('**/api/customers/*/notes');
    stage = `${user.id}:${width}:closed-task`;
    await demo.db
      .prepare(
        "UPDATE tasks SET status='COMPLETED',completed_at=?,completed_by_membership_id=?,version=version+1 WHERE id=?",
      )
      .bind(new Date().toISOString(), task.assigneeMembershipId, selectedId)
      .run();
    try {
      await page.goto(origin + `/today-work?task=${encodeURIComponent(selectedId)}&queue=WORK`);
      await page.getByText(/Önceki takip kullanılamıyor/).waitFor();
      assert.equal(await page.locator('.today-task-row[aria-pressed="true"]').count(), 0);
      assert.equal(await button('İletişim kaydı ekle').count(), 0);
      row.checks.push('real-d1-closed-A-no-B-selection');
    } finally {
      await demo.db
        .prepare(
          "UPDATE tasks SET status='OPEN',completed_at=NULL,completed_by_membership_id=NULL,version=version+1 WHERE id=?",
        )
        .bind(selectedId)
        .run();
    }
    if (user.id === 'ahmet') {
      stage = `${user.id}:${width}:reassigned-task`;
      await demo.db.batch([
        demo.db
          .prepare(
            "UPDATE tasks SET assignee_membership_id='demo-member-ayse',version=version+1 WHERE id=?",
          )
          .bind(selectedId),
        demo.db
          .prepare(
            "UPDATE renewal_opportunities SET assignee_membership_id='demo-member-ayse',version=version+1 WHERE id=?",
          )
          .bind(task.renewalId),
      ]);
      try {
        await page.reload();
        await page.getByText(/Önceki takip kullanılamıyor/).waitFor();
        assert.equal(await page.locator('.today-task-row[aria-pressed="true"]').count(), 0);
        row.checks.push('real-d1-reassigned-A-denied-to-old-member');
      } finally {
        await demo.db.batch([
          demo.db
            .prepare('UPDATE tasks SET assignee_membership_id=?,version=version+1 WHERE id=?')
            .bind(task.assigneeMembershipId, selectedId),
          demo.db
            .prepare(
              'UPDATE renewal_opportunities SET assignee_membership_id=?,version=version+1 WHERE id=?',
            )
            .bind(task.renewalAssigneeMembershipId, task.renewalId),
        ]);
      }
    }
    if (user.id === 'ahmet' && width === 360) {
      stage = 'ahmet:360:restored-task-completion-get-only';
      await page.goto(origin + `/today-work?task=${encodeURIComponent(selectedId)}&queue=WORK`);
      await button('İletişim kaydı ekle').waitFor();
      await button('Görev işlemleri').click();
      await button('Yeni takip planını aç').click();
      await page
        .getByLabel('Yeni takip zamanı (İstanbul)', { exact: true })
        .fill('2098-10-21T11:30');
      await page
        .getByLabel('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum', { exact: true })
        .check();
      let completePosts = 0,
        committed = false,
        failedRead = false;
      await page.route('**/api/renewals/*/tasks/*/complete', async (route) => {
        completePosts++;
        const response = await route.fetch();
        assert.ok(response.ok());
        committed = true;
        await route.fulfill({ response });
      });
      await page.route('**/api/tasks/*/context*', async (route) => {
        if (committed && !failedRead) {
          failedRead = true;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"success":false}',
          });
        } else await route.continue();
      });
      await button('Takibi tamamla ve planla').click();
      await button('Yalnız tamamlama kuyruğunu yeniden oku').waitFor();
      await button('Yalnız tamamlama kuyruğunu yeniden oku').click();
      await page
        .getByText(
          'Takip tamamlandı ve yeni takip oluşturuldu. İş listeniz güncellendi. Yenileme henüz sonuçlandırılmadı.',
          { exact: true },
        )
        .waitFor();
      assert.equal(completePosts, 1);
      assert.equal(await page.locator('.today-task-row[aria-pressed="true"]').count(), 0);
      const replacement = await demo.db
        .prepare(
          "SELECT id FROM tasks WHERE renewal_id=? AND status='OPEN' AND kind='RENEWAL_FOLLOWUP'",
        )
        .bind(task.renewalId)
        .all();
      assert.equal(replacement.results.length, 1);
      assert.notEqual(replacement.results[0].id, selectedId);
      row.checks.push('restored-A-complete-accepted-GET-only-recovery-no-auto-B');
      await page.unroute('**/api/renewals/*/tasks/*/complete');
      await page.unroute('**/api/tasks/*/context*');
    }
    const storage = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    assert.deepEqual(storage, { local: [], session: [] });
    row.checks.push('no-browser-storage');
    assert.equal(runtimeErrors, 0);
    row.runtimeErrors = runtimeErrors;
    rows.push(row);
    await writeFile(join(evidence, 'edge-progress.json'), JSON.stringify(rows, null, 2));
    await context.close();
    console.info('EDGE_CELL_PASS', user.id, width);
  }
  await writeFile(
    join(evidence, 'edge-results.json'),
    JSON.stringify({ browser: browser.version(), sourceRoot: source, rows }, null, 2),
  );
  console.info('EDGE_COMPLETE', rows.length);
} catch (error) {
  await writeFile(
    join(evidence, 'edge-failure.json'),
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
  console.error('EDGE_FAILED', stage, error.name);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
}
