// Real Edge, disposable synthetic D1; alternate loopback port preserves the user's interactive demo.
/* global document, innerWidth, history, fetch, getComputedStyle */
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const origin = 'https://localhost:9443';
const before = process.argv.includes('--before');
const stageA = process.argv.includes('--stage-a');
const probe = process.argv.includes('--probe');
const directory = await mkdtemp(resolve('node_modules/.cache/ux-sprint-'));
const results = [];
let demo, tls, server, browser, current;
const passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
try {
  const bundle = join(directory, 'application.mjs');
  await build({
    entryPoints: ['tests/browser/today-work-fixture.ts'],
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
  const adapter = join(directory, 'https.mjs');
  await writeFile(
    adapter,
    (await readFile('scripts/demo/https-server.mjs', 'utf8'))
      .replaceAll('localhost:8443', 'localhost:9443')
      .replace('server.listen(8443,', 'server.listen(9443,'),
  );
  const https = await import(pathToFileURL(adapter).href);
  demo = await app.openDemo(passwords);
  await app.seedTerminalTasks(demo.db);
  tls = await https.demoCertificate();
  server = await https.serveDemo(demo, tls);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [index, user] of app.DEMO_USERS.entries())
    for (const width of stageA || before || probe ? [360] : [1440, 768, 360]) {
      if (probe && index > 0) continue;
      current = { actor: user.id, width, passed: false, checks: [], screenshots: [] };
      results.push(current);
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 1000 },
        hasTouch: width < 901,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const runtimeErrors = [];
      page.on('pageerror', () => runtimeErrors.push('runtime'));
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /Content Security Policy|Refused to/i.test(message.text())
        )
          runtimeErrors.push('csp');
      });
      await page.goto(origin + '/');
      await page.getByLabel('E-posta', { exact: true }).fill(user.email);
      await page.getByLabel('Şifre', { exact: true }).fill(passwords[index]);
      await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
      await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
      await page.goto(origin + '/today-work');
      await page.locator('.today-task-row').first().click();
      const shot = async (name) => {
        const file = join(directory, `${user.id}-${width}-${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        current.screenshots.push(file);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        if (overflow)
          current.overflow = await page.evaluate(() =>
            [...document.querySelectorAll('main *')]
              .map((el) => ({ el, rect: el.getBoundingClientRect() }))
              .filter(({ rect }) => rect.right > innerWidth + 1)
              .map(({ el, rect }) => ({
                tag: el.tagName,
                classes: typeof el.className === 'string' ? el.className : '',
                width: Math.round(rect.width),
                right: Math.round(rect.right),
                minWidth: getComputedStyle(el).minWidth,
                display: getComputedStyle(el).display,
                overflow: getComputedStyle(el).overflowX,
              }))
              .slice(0, 25),
          );
        if (!before)
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
      };
      const button = (n) => page.getByRole('button', { name: n, exact: true });
      await button('İletişim kaydı ekle').click();
      await page
        .getByRole('combobox', { name: 'Görüşme sonucu', exact: true })
        .selectOption('NOTE');
      await page.getByLabel('İç not', { exact: true }).fill('Sprint korunan sentetik taslak');
      if (width < 901) await button('Menüyü aç').tap();
      await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
      await page.getByText('Hedefi değiştirmeden önce', { exact: true }).waitFor();
      await shot(before ? 'before-dirty' : 'after-dirty');
      const drawerOpen = await page.locator('#app-sidebar').getAttribute('data-mobile-open');
      if (before) {
        current.reproducedOverlap = drawerOpen === 'true';
        assert.equal(drawerOpen, 'true');
        current.passed = true;
        await context.close();
        continue;
      }
      assert.equal(drawerOpen, 'false');
      current.checks.push('drawer-closed-before-decision');
      if (width < 901) await button('Bu ekranda kal').tap();
      else await button('Bu ekranda kal').click();
      assert.equal(
        await page.getByLabel('İç not', { exact: true }).inputValue(),
        'Sprint korunan sentetik taslak',
      );
      current.checks.push('stay-keeps-draft');
      if (width < 901) {
        await button('Menüyü aç').click();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#app-sidebar').getAttribute('data-mobile-open'), 'false');
        assert.equal(
          await button('Menüyü aç').evaluate((el) => el === document.activeElement),
          true,
        );
        current.checks.push('drawer-escape-focus');
      }
      if (width < 901) await button('Menüyü aç').click();
      await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
      await page.getByText('Hedefi değiştirmeden önce', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(
        await page.getByLabel('İç not', { exact: true }).inputValue(),
        'Sprint korunan sentetik taslak',
      );
      assert.equal(await button('Ayrılmayı onayla').count(), 0);
      current.checks.push('decision-escape-stays');
      if (width < 901) await button('Menüyü aç').click();
      await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
      await button('Ayrılmayı onayla').click();
      await page.getByRole('heading', { name: 'Müşteriler', exact: true }).waitFor();
      current.checks.push('confirmed-navigation');
      if (!stageA) {
        await page.goto(origin + '/today-work');
        await page.locator('.today-task-row').first().click();
        await shot('workspace');
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        assert.equal(overflow, false);
        current.checks.push('no-document-horizontal-overflow');
        if (width === 1440) {
          await button('Menüyü daralt').click();
          assert.equal(await page.locator('.app-shell').getAttribute('data-collapsed'), 'true');
          await button('Menüyü genişlet').click();
          current.checks.push('collapse-expand');
        }
        // Authorized IDs already in the task summary replace the repeated number lookup.
        const policyHref = await page
          .getByRole('link', { name: 'Poliçeyi aç', exact: true })
          .getAttribute('href');
        const customerHref = await page
          .getByRole('link', { name: 'Müşteri profilini aç', exact: true })
          .getAttribute('href');
        assert.ok(policyHref?.startsWith('/policies/'));
        assert.ok(customerHref?.startsWith('/customers/'));
        await page.getByRole('link', { name: 'Poliçeyi aç', exact: true }).click();
        await page.locator('.policy-modern').waitFor();
        await shot('policy-direct');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.goto(origin + '/today-work');
        await page.locator('.today-task-row').first().click();
        await page.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
        await page.locator('.customer-modern').waitFor();
        await shot('customer-direct');
        await page.getByRole('link', { name: 'İleri müşteri işlemleri', exact: true }).click();
        await page
          .getByRole('heading', { name: 'Atama, arşiv ve kimlik işlemleri', exact: true })
          .waitFor();
        await page.getByRole('button', { name: '+ Poliçe Ekle', exact: true }).waitFor();
        await shot('customer-advanced');
        // Preserve the legacy modal's interaction boundary. Do not expose route
        // navigation around its independent mutation/reauth state machines.
        await page.getByRole('button', { name: '✕', exact: true }).click();
        await page.getByRole('link', { name: 'Modern müşteri profiline dön', exact: true }).click();
        await page.locator('.customer-modern').waitFor();
        current.checks.push('customer-policy-direct-and-advanced-return');
        // Browser back and forward share the same dirty decision, not an implicit discard.
        if (width < 901) await button('Menüyü aç').click();
        await page.getByRole('link', { name: 'Bugünkü İşler', exact: true }).click();
        await page.locator('.today-task-row').first().click();
        await button('İletişim kaydı ekle').click();
        await page
          .getByRole('combobox', { name: 'Görüşme sonucu', exact: true })
          .selectOption('NOTE');
        await page.getByLabel('İç not', { exact: true }).fill('History korunan taslak');
        await page.evaluate(() => history.back());
        await button('Bu ekranda kal').waitFor();
        await button('Bu ekranda kal').click();
        assert.equal(
          await page.getByLabel('İç not', { exact: true }).inputValue(),
          'History korunan taslak',
        );
        await page.evaluate(() => history.back());
        await button('Ayrılmayı onayla').click();
        await page.locator('.customer-modern').waitFor();
        await page.goForward();
        await page.locator('.today-task-row').first().click();
        await page.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
        await page.locator('.customer-modern').waitFor();
        await page.goBack();
        await page.locator('.today-task-row').first().click();
        await button('İletişim kaydı ekle').click();
        await page
          .getByRole('combobox', { name: 'Görüşme sonucu', exact: true })
          .selectOption('NOTE');
        await page.getByLabel('İç not', { exact: true }).fill('Forward korunan taslak');
        await page.evaluate(() => history.forward());
        await button('Bu ekranda kal').click();
        assert.equal(
          await page.getByLabel('İç not', { exact: true }).inputValue(),
          'Forward korunan taslak',
        );
        current.checks.push('native-back-forward-stay-and-confirm');
        await button('Formu kapat ve taslağı bırak').click();
        // Preserve all terminal write guards while making a blocked sidebar attempt visible.
        const task = await page.evaluate(async () => {
          const j = await (await fetch('/api/tasks/today?limit=20')).json();
          return j.data.items[0];
        });
        await button('Yenileme sonucu').click();
        await button('Yenilenmedi olarak sonuçlandır').click();
        await page
          .getByRole('combobox', { name: 'Kayıp nedeni', exact: true })
          .selectOption('demo-loss-price');
        await page
          .getByLabel('LOST sonucunu ve seçili nedeni onaylıyorum', { exact: true })
          .check();
        const attempts = [];
        let first = true;
        const path = `/api/renewals/${task.renewalId}/close-lost`;
        await page.route('**' + path, async (route) => {
          const req = route.request();
          attempts.push({ body: req.postData(), key: req.headers()['idempotency-key'] });
          const r = await route.fetch();
          if (first) {
            first = false;
            return route.abort('failed');
          }
          return route.fulfill({ response: r });
        });
        await button('LOST kaydını onayla').click();
        await button('Aynı LOST isteğini yeniden dene').waitFor();
        if (width < 901) await button('Menüyü aç').click();
        await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
        assert.equal(await page.locator('#app-sidebar').getAttribute('data-mobile-open'), 'false');
        assert.equal(await button('Ayrılmayı onayla').count(), 0);
        assert.equal(new URL(page.url()).pathname, '/today-work');
        await button('Aynı LOST isteğini yeniden dene').click();
        await page
          .getByText(/POST yanıtı ve yetkili yenileme state\/sürüm okuması doğrulandı/)
          .waitFor();
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0].body, attempts[1].body);
        assert.equal(attempts[0].key, attempts[1].key);
        await page.unroute('**' + path);
        current.checks.push('uncertain-terminal-sidebar-blocked-exact-retry');
        await page.locator('.today-task-row').first().click();
        // Presentation-only long labels: do not alter domain data to test wrapping.
        await page
          .locator('.today-overview [data-slot="card-title"]')
          .evaluate(
            (el) =>
              (el.textContent = 'Çok Uzun Sentetik Sigortalı Kurumsal Müşteri Adı '.repeat(5)),
          );
        await shot('long-label');
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        current.checks.push('long-label-wrap');
        await page
          .locator('.today-task-facts')
          .first()
          .evaluate((el) => {
            const dt = [...el.querySelectorAll('dt')].find(
              (n) => n.textContent === 'Poliçe numarası',
            );
            if (dt?.nextElementSibling)
              dt.nextElementSibling.textContent = 'UZUN-POLICE-'.repeat(24);
          });
        await button('Teklifler').click();
        await button('Teklif geçmişini aç').click();
        await button('Teklif geçmişini ve katalogları yeniden oku').waitFor();
        await page.locator('.quote-history').waitFor();
        await shot('long-policy-and-history');
        const scroll = await page.evaluate(() => {
          const q = document.querySelector('.today-queue > [data-slot="card-content"]');
          return {
            queueOverflow: q ? getComputedStyle(q).overflowY : null,
            queueScrollable: q ? q.scrollHeight > q.clientHeight : false,
            historyOverflow: [
              ...document.querySelectorAll('.interaction-timeline,.quote-history'),
            ].map((el) => getComputedStyle(el).overflowY),
            font: getComputedStyle(document.body).fontFamily,
          };
        });
        current.scroll = scroll;
        assert.ok(
          scroll.historyOverflow.length > 0 && scroll.historyOverflow.every((v) => v === 'visible'),
        );
        if (width === 1440) {
          assert.ok(scroll.queueScrollable);
          await page.locator('.today-task-row').last().focus();
          await page.keyboard.press('End');
          assert.ok(
            await page
              .locator('.today-queue > [data-slot="card-content"]')
              .evaluate((el) => el.scrollTop > 0),
          );
        }
        current.checks.push('history-natural-flow-desktop-queue-retained');
        if (width < 901) {
          await button('Menüyü aç').click();
          const sidebar = page.locator('#app-sidebar');
          await sidebar.locator('a').last().focus();
          await page.keyboard.press('Tab');
          assert.equal(
            await sidebar
              .getByRole('button', { name: 'Menüyü kapat', exact: true })
              .evaluate((el) => el === document.activeElement),
            true,
          );
          await page.keyboard.press('Escape');
          current.checks.push('drawer-tab-loop');
        }
        if (index > 0) {
          await page.route('**/api/policies/*', (route) =>
            route.fulfill({
              status: 403,
              contentType: 'application/json',
              body: JSON.stringify({
                success: false,
                error: { code: 'FORBIDDEN', message: 'Erişim reddedildi.' },
              }),
            }),
          );
          await page.getByRole('link', { name: 'Poliçeyi aç', exact: true }).click();
          await page.getByRole('alert').first().waitFor();
          assert.equal(await page.locator('.policy-modern [data-slot="card"]').count(), 0);
          await shot('policy-permission-denied');
          current.checks.push('policy-denied-no-detail');
        }
      }
      assert.equal(runtimeErrors.length, 0);
      current.runtimeErrors = 0;
      current.passed = true;
      await writeFile(join(directory, 'progress.json'), JSON.stringify({ results }, null, 2));
      console.info('UX_CELL_PASS', user.id, width);
      await context.close();
    }
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify({ browser: browser.version(), before, stageA, results }, null, 2),
  );
  console.info('UX_EDGE_RESULT', directory);
} catch (error) {
  await writeFile(
    join(directory, 'failed.json'),
    JSON.stringify(
      { results, errorType: error.name, message: error.message.split('\n')[0] },
      null,
      2,
    ),
  );
  console.error('UX_EDGE_FAILED', directory, error.name, error.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
  await rm(join(directory, 'application.mjs'), { force: true });
}
