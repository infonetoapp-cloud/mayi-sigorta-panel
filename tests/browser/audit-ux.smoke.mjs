/* global document, innerWidth, localStorage, sessionStorage */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const red = process.argv.includes('--red');
const only = process.argv.find((arg) => arg.startsWith('--cell='))?.slice(7);
const directory = await mkdtemp(resolve('node_modules/.cache/audit-ux-'));
const origin = 'https://localhost:11443';
const passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
const rows = [];
let demo, tls, server, browser, activePage;
let step = 'setup';
try {
  const bundle = join(directory, 'application.mjs');
  await build({
    entryPoints: ['scripts/demo/application.ts'],
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
      .replaceAll('localhost:8443', 'localhost:11443')
      .replace('server.listen(8443,', 'server.listen(11443,'),
  );
  const https = await import(pathToFileURL(adapter).href);
  demo = await app.openDemo(passwords);
  tls = await https.demoCertificate();
  server = await https.serveDemo(demo, tls);
  browser = await chromium.launch({ channel: 'msedge', headless: false });
  for (const [index, user] of app.DEMO_USERS.entries()) {
    for (const width of [1440, 768, 360]) {
      if (red && (index !== 0 || width !== 1440)) continue;
      if (only && only !== `${user.id}:${width}`) continue;
      step = `${user.id}:${width}:login`;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 1000 },
      });
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(15000);
      const button = (name) => page.getByRole('button', { name, exact: true });
      const link = (name) => page.getByRole('link', { name, exact: true });
      const errors = [];
      page.on('pageerror', () => errors.push('runtime'));
      await page.goto(origin);
      await page.getByLabel('E-posta', { exact: true }).fill(user.email);
      await page.getByLabel('Şifre', { exact: true }).fill(passwords[index]);
      await button('Giriş Yap').click();
      await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
      await page.goto(origin + '/customers');
      await page.getByRole('heading', { name: 'Müşteriler', exact: true }).waitFor();
      await link('Yeni Müşteri').click();
      if (!red) {
        await link('Müşteri listesine dön').click();
        await page.goBack();
        await page.getByRole('heading', { name: 'Yeni müşteri', exact: true }).waitFor();
      }
      step = `${user.id}:${width}:draft`;
      await page.getByLabel('Ad', { exact: true }).fill('Taslak');
      await page.getByLabel('Soyad', { exact: true }).fill('Sentetik');
      if (width < 901) await button('Menüyü aç').click();
      await link('Müşteriler').click();
      if (red) {
        assert.equal(await button('Bu ekranda kal').count(), 0);
        await page.goBack();
        await page.getByRole('heading', { name: 'Yeni müşteri', exact: true }).waitFor();
        assert.equal(await page.getByLabel('Ad', { exact: true }).inputValue(), '');
        await page.screenshot({
          path: join(directory, 'customer-draft-loss-red.png'),
          fullPage: true,
        });
        rows.push({ actor: user.id, width, defectReproduced: true });
      } else {
        await button('Bu ekranda kal').click();
        assert.equal(await page.getByLabel('Ad', { exact: true }).inputValue(), 'Taslak');
        await link('Vazgeç ve listeye dön').click();
        await page.keyboard.press('Escape');
        assert.equal(await page.getByLabel('Soyad', { exact: true }).inputValue(), 'Sentetik');
        await page.goBack();
        await button('Bu ekranda kal').click();
        assert.equal(new URL(page.url()).pathname, '/customers/new');
        assert.equal(await page.getByLabel('Ad', { exact: true }).inputValue(), 'Taslak');
        await page.goForward();
        await button('Bu ekranda kal').click();
        assert.equal(new URL(page.url()).pathname, '/customers/new');
        assert.equal(await page.getByLabel('Ad', { exact: true }).inputValue(), 'Taslak');
        await page.screenshot({
          path: join(directory, `${user.id}-${width}-draft-stay.png`),
          fullPage: true,
        });
        step = `${user.id}:${width}:pending`;
        // Let the real server commit, but hold its response: leaving cannot discard this request.
        let release, committed;
        const held = new Promise((resolve) => {
          release = resolve;
        });
        const accepted = new Promise((resolve) => {
          committed = resolve;
        });
        const attempts = [];
        await page.getByLabel('Soyad', { exact: true }).fill(`Sentetik-${user.id}-${width}`);
        await page.route('**/api/customers', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          const req = route.request();
          attempts.push({ body: req.postData(), key: req.headers()['idempotency-key'] });
          const response = await route.fetch();
          assert.equal(response.status(), 201);
          if (attempts.length === 1) {
            committed();
            await held;
            return route.abort('failed');
          }
          return route.fulfill({ response });
        });
        await button('Müşteriyi kaydet').dblclick();
        await accepted;
        await link('Vazgeç ve listeye dön').click();
        assert.equal(new URL(page.url()).pathname, '/customers/new');
        assert.equal(await button('Taslağı bırak ve ayrıl').count(), 0);
        await page.goBack();
        await page.getByText(/Kayıt isteği henüz sonuçlanmadı/).waitFor();
        await page.waitForURL('**/customers/new');
        release();
        await button('Aynı kaydı güvenle yeniden dene').waitFor();
        await page.goForward();
        await page.waitForURL('**/customers/new');
        if (width < 901) await button('Menüyü aç').click();
        await link('Müşteriler').click();
        assert.equal(new URL(page.url()).pathname, '/customers/new');
        assert.equal(await button('Taslağı bırak ve ayrıl').count(), 0);
        await button('Aynı kaydı güvenle yeniden dene').click();
        await page.waitForURL(/\/customers\/(?!new)[^/]+$/);
        assert.equal(attempts.length, 2);
        assert.deepEqual(attempts[1], attempts[0]);
        const count = await demo.db
          .prepare('SELECT COUNT(*) count FROM customers WHERE last_name=?')
          .bind(`Sentetik-${user.id}-${width}`)
          .first();
        assert.equal(count.count, 1);
        const storage = await page.evaluate(() =>
          JSON.stringify({ ...localStorage, ...sessionStorage }),
        );
        assert.ok(!storage.includes(`Sentetik-${user.id}-${width}`));
        await page.unroute('**/api/customers');
        await page.goto(origin + '/customers');
        await link('Yeni Müşteri').click();
        step = `${user.id}:${width}:company`;
        await page.getByRole('heading', { name: 'Yeni müşteri', exact: true }).waitFor();
        await page
          .getByRole('form', { name: 'Yeni müşteri oluşturma', exact: true })
          .getByLabel('Müşteri türü', { exact: true })
          .selectOption('COMPANY');
        assert.equal(
          await page.getByLabel('Müşteri türü', { exact: true }).inputValue(),
          'COMPANY',
        );
        await page
          .getByLabel('Şirket unvanı', { exact: true })
          .fill(`Sentetik şirket ${user.id}-${width}`);
        await button('Müşteriyi kaydet').click();
        await page.waitForURL(/\/customers\/(?!new)[^/]+$/);
        await page
          .getByRole('heading', { name: `Sentetik şirket ${user.id}-${width}`, exact: true })
          .waitFor();
        const labels = [];
        for (const route of ['/agency-settings', '/catalogs']) {
          step = `${user.id}:${width}:${route}`;
          await page.goto(origin + route);
          if (route === '/agency-settings') {
            await button('Ayarları Kaydet').waitFor();
            for (const label of [
              'Varsayılan Sigorta Şirketi',
              'Operasyonel Zaman Dilimi (IANA)',
              'Yenileme Bildirim Penceresi (Gün: 1 - 120)',
            ]) {
              const control = page.getByLabel(label, { exact: true });
              const id = await control.getAttribute('id');
              await page.locator('label').filter({ hasText: label }).click();
              assert.equal(await control.evaluate((el) => document.activeElement === el), true);
              labels.push(id);
            }
            const timezone = page.getByLabel('Operasyonel Zaman Dilimi (IANA)', { exact: true });
            await timezone.focus();
            await page.keyboard.press('Tab');
            assert.equal(
              await page
                .getByLabel('Yenileme Bildirim Penceresi (Gün: 1 - 120)', { exact: true })
                .evaluate((el) => document.activeElement === el),
              true,
            );
            await timezone.fill('invalid/timezone');
            await button('Ayarları Kaydet').click();
            assert.equal(await timezone.getAttribute('aria-invalid'), 'true');
            assert.ok(
              await timezone.evaluate((el) =>
                document
                  .getElementById(el.getAttribute('aria-describedby'))
                  .textContent.includes('Geçerli bir IANA'),
              ),
            );
          } else {
            await button('+ Yeni Ekle').click();
            const code = page.getByLabel('Kod (Semantik Değer - Değiştirilemez)', { exact: true });
            await page
              .locator('label')
              .filter({ hasText: 'Kod (Semantik Değer - Değiştirilemez)' })
              .click();
            assert.equal(await code.evaluate((el) => document.activeElement === el), true);
            await page.keyboard.press('Tab');
            assert.equal(
              await page
                .getByLabel('İsim / Tanım', { exact: true })
                .evaluate((el) => document.activeElement === el),
              true,
            );
            await button('Kaydet').click();
            assert.equal(await code.getAttribute('aria-invalid'), 'true');
            labels.push(
              await code.getAttribute('id'),
              await page.getByLabel('İsim / Tanım', { exact: true }).getAttribute('id'),
            );
            await page.screenshot({
              path: join(directory, `${user.id}-${width}-catalog-labels.png`),
              fullPage: true,
            });
            await button('Vazgeç').click();
          }
        }
        rows.push({
          actor: user.id,
          width,
          draftStay: true,
          backForwardStay: true,
          pendingNavigationBlocked: true,
          uncertainExactReplay: true,
          customerRows: count.count,
          customerPosts: attempts.length,
          companyCreated: true,
          labelsChecked: labels.length,
        });
      }
      assert.equal(errors.length, 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await context.close();
      console.info('AUDIT_UX_CELL', user.id, width);
    }
  }
  assert.equal(rows.length, red || only ? 1 : 9);
  const result = {
    red,
    browser: browser.version(),
    visible: true,
    rows,
    clientIndexSha256: createHash('sha256')
      .update(await readFile('dist/client/index.html'))
      .digest('hex'),
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.info('AUDIT_UX_RESULT', directory);
} catch (error) {
  if (activePage && !step.endsWith(':login')) {
    await activePage
      .screenshot({ path: join(directory, 'failed-synthetic.png'), fullPage: true })
      .catch(() => {});
    await writeFile(
      join(directory, 'failed-dom.txt'),
      await activePage
        .locator('body')
        .innerText()
        .catch(() => 'DOM_UNAVAILABLE'),
    );
  }
  await writeFile(
    join(directory, 'failed.json'),
    JSON.stringify(
      {
        red,
        rows,
        step,
        trace: error.stack
          ?.split('\n')
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 4),
        error: error.name,
        message: error.message.split('\n')[0],
      },
      null,
      2,
    ),
  );
  console.error('AUDIT_UX_FAILED', directory, error.name);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
}
