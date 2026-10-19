// Focused real Edge gate; all credentials stay ephemeral and unlogged.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { demoCertificate, serveDemo } from '../../scripts/demo/https-server.mjs';
import { interactionWalkthrough } from './renewal-interactions.walkthrough.mjs';
import { taskOperationsWalkthrough } from './task-operations.walkthrough.mjs';
import { quoteWalkthrough } from './renewal-quotes.walkthrough.mjs';
import { quoteSentWalkthrough } from './quote-sent.walkthrough.mjs';
let stage = 'setup',
  browser,
  demo,
  tls,
  server,
  directory,
  evidence;
const accepted = [];
const quotesOnly = process.argv.includes('--quotes-only');
const sentOnly = process.argv.includes('--sent-only');
const passwords = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
const mark = (value) => {
  stage = value;
  console.info('TODAY_QUEUE_STAGE', stage);
};
async function json(page, url) {
  return page.evaluate(async (url) => {
    const r = await globalThis.fetch(url);
    if (!r.ok) throw new Error('AUTHORIZED_READ_FAILED');
    return (await r.json()).data;
  }, url);
}
async function legacy(page, index) {
  mark('legacy-' + index);
  await page.goto('https://localhost:8443/today-work/legacy');
  await page
    .getByRole('heading', { name: 'Bugünkü İşler — klasik çalışma alanı', exact: true })
    .waitFor();
  mark('legacy-tasks-' + index);
  await page
    .getByRole('button', { name: /^Takibi tamamla ve yenisini planla:/ })
    .first()
    .waitFor();
  await page
    .getByLabel(/^Yeni takip zamanı:/)
    .first()
    .waitFor();
  mark('legacy-workspace-' + index);
  const workspace = page
    .getByRole('button', { name: /^İletişim, teklif ve sonuçları aç:/ })
    .first();
  await workspace.click();
  if (!index) {
    mark('legacy-quote-' + index);
    await page
      .getByRole('button', { name: /^Yeni teklif sürümü oluştur:/ })
      .first()
      .waitFor();
    mark('legacy-assignment-' + index);
    await page
      .getByRole('button', { name: /^Atama seçeneklerini aç:/ })
      .first()
      .click();
    await page
      .getByLabel(/^Yeni sorumlu:/)
      .first()
      .waitFor();
  }
  await page.getByRole('link', { name: 'Modern iş kuyruğuna dön', exact: true }).click();
}
try {
  await mkdir('node_modules/.cache', { recursive: true });
  directory = await mkdtemp(resolve('node_modules/.cache/today-queue-smoke-'));
  evidence = await mkdtemp(
    resolve(
      sentOnly
        ? 'node_modules/.cache/phase4e-edge-acceptance-'
        : 'node_modules/.cache/phase4d-edge-acceptance-',
    ),
  );
  const bundle = join(directory, 'fixture.mjs');
  await build({
    entryPoints: ['tests/browser/today-work-fixture.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  const application = await import(pathToFileURL(bundle).href);
  demo = await application.openDemo(passwords);
  tls = await demoCertificate();
  server = await serveDemo(demo, tls);
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  for (const [index, user] of application.DEMO_USERS.entries()) {
    mark('login-' + index);
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    page.setDefaultTimeout(30000);

    const failures = [];
    page.on('pageerror', () => failures.push('runtime'));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text()))
        failures.push('csp');
    });
    await page.goto('https://localhost:8443/');
    await page.getByLabel('E-posta', { exact: true }).fill(user.email);
    await page.getByLabel('Şifre', { exact: true }).fill(passwords[index]);
    const loginResponse = page.waitForResponse(
      (r) =>
        new globalThis.URL(r.url()).pathname === '/api/auth/login' &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
    console.info('CANONICAL_LOGIN_STATUS', index, (await loginResponse).status());
    mark('login-dashboard-' + index);
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    if (sentOnly) {
      await legacy(page, index);
      await quoteSentWalkthrough(page, index, mark, demo, evidence);
      assert.equal(failures.length, 0);
      accepted.push({ actor: user.id, widths: [1440, 768, 360], result: 'PASS' });
      await context.close();
      continue;
    }
    if (!index) {
      await legacy(page, index);
      mark('bounded-fixtures');
      if (!quotesOnly) await application.seedQueuePages(demo.db);
      await application.seedQuoteAlternatives(demo.db);
    } else await page.getByRole('link', { name: 'Bugünkü İşler', exact: true }).click();
    mark('modern-' + index);
    await page.goto('https://localhost:8443/today-work');
    await page.locator('.today-task-row').first().waitFor();
    const data = await json(page, '/api/tasks/today?limit=20');
    assert.ok(data.items.length <= 20);
    if (index) {
      assert.ok(data.items.every((t) => t.assigneeMembershipId === 'demo-member-' + user.id));
      assert.equal(
        await page.getByRole('button', { name: 'Atanmamış işler', exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByRole('button', { name: 'Yeniden atama gerekenler', exact: true }).count(),
        0,
      );
    }
    const task = data.items[0];
    await page.locator('.today-task-row').first().focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(
      await page
        .locator('.today-task-row')
        .nth(1)
        .evaluate((node) => node === globalThis.document.activeElement),
      true,
    );
    await page.keyboard.press('Enter');
    await page
      .getByRole('region', { name: 'Seçili görev özeti', exact: true })
      .getByRole('link', { name: 'Klasik iş akışını aç', exact: true })
      .waitFor();
    assert.equal(new globalThis.URL(page.url()).search, '');
    assert.equal(
      await page
        .getByRole('link', { name: 'Klasik iş akışını aç', exact: true })
        .getAttribute('href'),
      '/today-work/legacy',
    );
    await page.getByRole('button', { name: 'Görev listesine dön', exact: true }).click();
    await page.locator('.today-task-row').first().click();
    const overview = page.getByRole('region', { name: 'Seçili görev özeti', exact: true });
    if (task.policyNumber) await overview.getByText(task.policyNumber, { exact: true }).waitFor();
    const time = new Intl.DateTimeFormat('tr-TR', {
      timeZone: data.timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(task.dueAt));
    assert.ok((await overview.innerText()).includes(time));
    for (const width of [1440, 768, 360]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      if (width === 1440) {
        const left = await page.locator('.today-queue').boundingBox(),
          right = await overview.boundingBox();
        assert.ok(left.x < right.x);
        assert.ok(Math.abs(left.y - right.y) < 5);
      } else {
        assert.equal(await page.locator('.today-queue').isVisible(), false);
        assert.equal(await overview.isVisible(), true);
      }
    }
    await page.getByRole('button', { name: 'Görev listesine dön', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    mark('paging-' + index);
    if (data.hasMore) {
      const attempts = [];
      let failed = false;
      await page.route('**/api/tasks/today?*', async (route) => {
        const u = new globalThis.URL(route.request().url());
        if (u.searchParams.has('cursor')) {
          attempts.push(u.pathname + u.search);
          if (!failed) {
            failed = true;
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false }),
            });
          }
        }
        return route.continue();
      });
      await page.getByRole('button', { name: 'Daha fazla iş yükle', exact: true }).click();
      await page.getByRole('button', { name: 'Aynı sayfayı yeniden dene', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await page.waitForFunction(
        () => globalThis.document.querySelectorAll('.today-task-row').length > 20,
      );
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0], attempts[1]);
      assert.ok((await page.locator('.today-task-row').count()) > 20);
      await page.unroute('**/api/tasks/today?*');
    }
    if (!index && !quotesOnly) {
      await page.getByRole('button', { name: 'Atanmamış işler', exact: true }).click();
      mark('paging-unassigned-' + index);
      await page.getByRole('button', { name: 'Daha fazla iş yükle', exact: true }).click();
      await page
        .getByRole('button', { name: 'Daha fazla iş yükle', exact: true })
        .waitFor({ state: 'detached' });
      assert.equal(await page.locator('.today-task-row').count(), 21);
      mark('reassignment-' + index);
      await page.getByRole('button', { name: 'Yeniden atama gerekenler', exact: true }).click();
      await page.getByText('Bu kuyrukta gösterilecek takip bulunmuyor.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Açık işler', exact: true }).click();
      await page.locator('.today-task-row').first().waitFor();
    }
    if (!quotesOnly) {
      mark('statistics-' + index);
      await page
        .getByRole('button', { name: 'Görev istatistiklerini göster', exact: true })
        .click();
      const personal = await json(page, '/api/tasks/statistics');
      const statistics = page.getByRole('region', { name: 'Görev istatistikleri', exact: true });
      await statistics.getByText('Kendi görev özetim', { exact: true }).waitFor();
      assert.equal(
        Number(await statistics.locator('dl').first().locator('dd').first().innerText()),
        personal.summary.overdue,
      );
      if (!index) {
        await statistics.getByRole('button', { name: 'Ekip özeti', exact: true }).click();
        const team = await json(page, '/api/tasks/statistics?view=team');
        await statistics.getByText('Tüm ekip (atanmamış dahil)', { exact: true }).waitFor();
        assert.deepEqual(
          (await statistics.locator('dl').first().locator('dd').allTextContents()).map(Number),
          [
            team.summary.overdue,
            team.summary.dueToday,
            team.summary.upcoming,
            team.summary.completedLast30Days,
          ],
        );
        assert.ok(team.summary.overdue + team.summary.dueToday + team.summary.upcoming > 20);
      } else
        assert.equal(
          await statistics.getByRole('button', { name: 'Ekip özeti', exact: true }).count(),
          0,
        );
      await interactionWalkthrough(page, index, mark);
      await taskOperationsWalkthrough(page, index, mark, demo);
    }
    await quoteWalkthrough(page, index, mark, evidence);
    mark('history-' + index);
    await page.reload();
    assert.equal(
      await page.getByRole('link', { name: 'Klasik iş akışını aç', exact: true }).count(),
      0,
    );
    await page.locator('.today-task-row').first().click();
    await page.getByRole('link', { name: 'Klasik iş akışını aç', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Bugünkü İşler — klasik çalışma alanı', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: /^Takibi tamamla ve yenisini planla:/ })
      .first()
      .waitFor();
    await page.goBack();
    await page.locator('.today-task-row').first().waitFor();
    await page.goForward();
    await page
      .getByRole('heading', { name: 'Bugünkü İşler — klasik çalışma alanı', exact: true })
      .waitFor();
    await page.getByRole('link', { name: 'Modern iş kuyruğuna dön', exact: true }).click();
    await page.locator('.today-task-row').first().click();
    mark('revocation-' + index);
    await page.getByRole('button', { name: 'Teklif geçmişini aç', exact: true }).click();
    await page.getByRole('button', { name: 'Yeni teklif taslağı aç', exact: true }).waitFor();
    if (!(await page.locator('.quote-record').count())) {
      // Queue ordering can legitimately select a different renewal after follow-up replacement.
      // Establish visible protected data explicitly instead of assuming this row has a quote.
      mark('revocation-visible-quote-fixture-' + index);
      await page.getByRole('button', { name: 'Yeni teklif taslağı aç', exact: true }).click();
      await page.getByLabel('Yeni teklif kaydını oluşturmayı onaylıyorum', { exact: true }).check();
      await page.getByRole('button', { name: 'Teklifi oluştur', exact: true }).click();
      await page
        .getByText('Teklif yetkili geçmiş okumasıyla doğrulandı.', { exact: true })
        .waitFor();
    }
    await page.locator('.quote-record').first().waitFor();
    await demo.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .bind(Date.now(), 'demo-user-' + user.id)
      .run();
    await page.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
    mark('revocation-login-' + index);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(await page.locator('.today-task-row').count(), 0);
    assert.equal(await page.locator('.quote-record').count(), 0);
    assert.equal(
      await page.getByRole('region', { name: 'Seçili görev özeti', exact: true }).count(),
      0,
    );
    mark('runtime-csp-' + index);
    if (failures.length) console.info('BROWSER_FAILURE_CATEGORIES', failures.join(','));
    assert.equal(failures.length, 0);
    accepted.push({ actor: user.id, widths: [1440, 768, 360], result: 'PASS' });
    await context.close();
  }
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        browser: browser.version(),
        scope: sentOnly
          ? 'PHASE4E_SENT_ONLY'
          : quotesOnly
            ? 'PHASE4D_QUOTES_ONLY'
            : 'TODAY_WORK_FULL',
        accepted,
      },
      null,
      2,
    ),
  );
  console.info(sentOnly ? 'PHASE4E_EDGE_EVIDENCE' : 'PHASE4D_EDGE_EVIDENCE', evidence);
  if (sentOnly)
    console.info(
      'PHASE4E_SENT_BROWSER PASS: OWNER/Ahmet/Ayşe x 1440/768/360; actual DRAFT/READY SENT recording, CAS/version/event/receipt proof, lost-success exact retry, GET-only mismatch recovery, conflicting version comparison/reselection, later state, expiry, navigation/storage and live session cleanup. No external messages.',
    );
  else if (quotesOnly)
    console.info(
      'PHASE4D_QUOTES_BROWSER PASS: OWNER/Ahmet/Ayşe; 1440/768/360; new alternatives, immutable identity/version, exact retry, comparison/readback, navigation, storage, legacy handoff and live-session cleanup. Broader 4A-4C walkthroughs not rerun in this mode.',
    );
  else
    console.info(
      'TODAY_QUEUE_BROWSER PASS: OWNER/Ahmet/Ayşe; private/agency queues; independent bounded cursors/exact page retry; authorized selection/keyboard; Istanbul/statistics; 1440/768/360; legacy completion/assignment/quote controls; reload/back-forward; revocation cleanup; CSP/runtime.',
    );
} catch (error) {
  console.error('BROWSER_FAILURE_KIND', error instanceof Error ? error.name : 'Unknown');
  const failedPage = browser?.contexts().at(-1)?.pages().at(-1);
  if (failedPage) {
    const state = await failedPage
      .evaluate(() => ({
        modernRoute: globalThis.location.pathname === '/today-work',
        taskRows: globalThis.document.querySelectorAll('.today-task-row').length,
        quoteRecords: globalThis.document.querySelectorAll('.quote-record').length,
        quoteForms: globalThis.document.querySelectorAll('.quote-form').length,
      }))
      .catch(() => null);
    console.error('BROWSER_FAILURE_SAFE_STATE', JSON.stringify(state));
  }
  const location =
    error instanceof Error
      ? error.stack?.match(
          /(?:(?:task-operations|renewal-quotes|quote-sent)\.walkthrough|today-work\.smoke)\.mjs:\d+:\d+/,
        )?.[0]
      : null;
  if (location) console.error('BROWSER_FAILURE_LOCATION', location);
  console.error(`TODAY_QUEUE_BROWSER FAIL at ${stage}. No credentials or raw diagnostics logged.`);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
}
