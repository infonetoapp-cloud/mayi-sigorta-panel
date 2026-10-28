// Visible local Edge review; keep the personal localhost:8443 demo isolated.
/* global document, innerWidth, getComputedStyle, fetch */
import assert from 'node:assert/strict';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const baseline = process.argv.includes('--baseline');
const keepOpen = process.argv.includes('--keep-open');
const previewOnly = process.argv.includes('--preview-only');
assert.ok(!previewOnly || (keepOpen && !baseline));
const only = process.argv.find((arg) => arg.startsWith('--cell='))?.slice(7);
const directory = await mkdtemp(resolve('node_modules/.cache/airy-review-'));
const origin = 'https://localhost:9443';
const rows = [];
const passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
let demo, tls, server, browser;
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
      .replaceAll('localhost:8443', 'localhost:9443')
      .replace('server.listen(8443,', 'server.listen(9443,')
      .replace("resolve('dist/client')", "resolve('node_modules/.cache/airy-client')"),
  );
  const https = await import(pathToFileURL(adapter).href);
  demo = await app.openDemo(passwords);
  tls = await https.demoCertificate();
  server = await https.serveDemo(demo, tls);
  browser = await chromium.launch({ channel: 'msedge', headless: false });
  for (const [index, user] of app.DEMO_USERS.entries())
    for (const width of [1440, 768, 360]) {
      if (previewOnly) continue;
      if (only && only !== `${user.id}:${width}`) continue;
      const row = { actor: user.id, width, passed: false, checks: [], screenshots: [] };
      rows.push(row);
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
          /content security policy|violates.*directive/i.test(message.text())
        )
          runtimeErrors.push('csp');
      });
      const button = (name) => page.getByRole('button', { name, exact: true });
      await authenticate(page, user, passwords[index]);
      await page.goto(origin + '/today-work');
      await page.locator('.today-task-row').first().click();
      await page.getByRole('button', { name: 'İletişim kaydı ekle', exact: true }).waitFor();
      const measure = () =>
        page.locator('.today-overview').evaluate((el) => ({
          panelHeight: Math.round(el.getBoundingClientRect().height),
          visibleButtons: [...el.querySelectorAll('button,a')].filter(
            (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden',
          ).length,
          visibleSummaries: [...el.querySelectorAll('summary')].filter(
            (n) => n.getClientRects().length > 0,
          ).length,
          visibleTextLength: (el.innerText ?? '').length,
          documentWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
        }));
      row.initial = await measure();
      assert.ok(row.initial.documentWidth <= width);
      const shot = async (name) => {
        const file = join(directory, `${user.id}-${width}-${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        row.screenshots.push(file);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      };
      await shot(baseline ? 'before' : 'after');
      if (!baseline) {
        for (const title of ['Teklifler', 'Görev işlemleri', 'Yenileme sonucu'])
          assert.equal(
            await page
              .getByRole('button', { name: title, exact: true })
              .getAttribute('aria-expanded'),
            'false',
          );
        assert.equal(
          await page
            .getByRole('button', { name: 'Kazanıldı — yeni poliçe oluştur', exact: true })
            .isVisible(),
          false,
        );
        row.checks.push('three-secondary-groups-initially-collapsed');
        await button('İletişim kaydı ekle').click();
        await page
          .getByRole('combobox', { name: 'Görüşme sonucu', exact: true })
          .selectOption('NOTE');
        await page
          .getByLabel('İç not', { exact: true })
          .fill('Bölüm geçişinde korunan sentetik taslak');
        await cannotCollapse(page, 'İletişim');
        if (width < 901) await button('Teklifler').tap();
        else await button('Teklifler').click();
        assert.equal(
          await page.getByLabel('İç not', { exact: true }).inputValue(),
          'Bölüm geçişinde korunan sentetik taslak',
        );
        await button('Teklifler').click();
        if (width < 901) await button('Menüyü aç').tap();
        await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
        await button('Bu ekranda kal').waitFor();
        assert.equal(await page.locator('#app-sidebar').getAttribute('data-mobile-open'), 'false');
        await page.keyboard.press('Escape');
        assert.equal(
          await page.getByLabel('İç not', { exact: true }).inputValue(),
          'Bölüm geçişinde korunan sentetik taslak',
        );
        row.checks.push('draft-pinned-and-sidebar-escape-keeps-content');
        await shot('draft-pinned');
        await button('Formu kapat ve taslağı bırak').click();
        await button('İletişim').click();
        assert.equal(await button('İletişim').getAttribute('aria-expanded'), 'false');
        await button('Teklifler').focus();
        await page.keyboard.press('Enter');
        assert.equal(await button('Teklifler').getAttribute('aria-expanded'), 'true');
        let quoteReads = 0;
        const readObserver = (req) => {
          if (
            req.method() === 'GET' &&
            /\/api\/renewals\/[^/]+\/quotes$/.test(new URL(req.url()).pathname)
          )
            quoteReads++;
        };
        page.on('request', readObserver);
        await button('Teklif geçmişini aç').click();
        await page.locator('.quote-history').waitFor();
        const history = await page.locator('.quote-history').elementHandle();
        const reads = quoteReads;
        await button('Teklifler').click();
        assert.equal(await page.locator('.quote-history').isVisible(), false);
        await button('Teklifler').click();
        assert.equal(
          await page.locator('.quote-history').evaluate((el, old) => el === old, history),
          true,
        );
        assert.equal(quoteReads, reads);
        page.off('request', readObserver);
        row.checks.push('keyboard-disclosure-history-mounted-no-refetch');
        await button('Teklifler').click();
        await button('Yenileme sonucu').click();
        await button('Kazanıldı — yeni poliçe oluştur').click();
        await page.getByLabel('Yeni poliçe numarası', { exact: true }).fill('SADECE-INCELEME');
        await cannotCollapse(page, 'Yenileme sonucu');
        assert.equal(
          await page.getByLabel('Yeni poliçe numarası', { exact: true }).inputValue(),
          'SADECE-INCELEME',
        );
        await button('Görev işlemleri').click();
        assert.equal(await button('Yeni takip planını aç').isDisabled(), true);
        await shot('create-draft-pinned');
        await button('Yeni poliçeyle kazanma taslağını açıkça kapat').click();
        await button('Görev işlemleri').click();
        row.checks.push('create-policy-draft-visible-and-cross-operation-guard');
        if (width !== 1440) {
          const task = await page.evaluate(async () => {
            const r = await fetch('/api/tasks/today?limit=20');
            return (await r.json()).data.items[0];
          });
          await button('Yenilenmedi olarak sonuçlandır').click();
          await page
            .getByRole('combobox', { name: 'Kayıp nedeni', exact: true })
            .selectOption('demo-loss-price');
          await page
            .getByLabel('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum', { exact: true })
            .check();
          const path = `/api/renewals/${task.renewalId}/close-lost`;
          const attempts = [];
          let first = true,
            blockRead = width === 360;
          await page.route('**' + path, async (route) => {
            const req = route.request();
            attempts.push({ body: req.postData(), key: req.headers()['idempotency-key'] });
            const response = await route.fetch();
            if (width === 768 && first) {
              first = false;
              return route.abort('failed');
            }
            return route.fulfill({ response });
          });
          const readPattern = `**/api/customers/${task.customerId}/renewals*`;
          if (width === 360)
            await page.route(readPattern, (route) =>
              blockRead
                ? route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: false }),
                  })
                : route.continue(),
            );
          await button('Yenilenmedi olarak kaydet').click();
          if (width === 768) await button('Aynı LOST isteğini yeniden dene').waitFor();
          else await button('Yalnız yenileme okumasını yeniden dene').waitFor();
          await cannotCollapse(page, 'Yenileme sonucu');
          await shot('pending-proof-pinned');
          await page.getByRole('link', { name: 'Poliçeyi aç', exact: true }).click();
          assert.equal(new URL(page.url()).pathname, '/today-work');
          assert.equal(await button('Ayrılmayı onayla').count(), 0);
          if (width === 768) await button('Aynı LOST isteğini yeniden dene').click();
          else {
            blockRead = false;
            await button('Yalnız yenileme okumasını yeniden dene').click();
          }
          await page.getByText(/sonucu kaydedildi ve yenileme kaydı kontrol edildi/).waitFor();
          assert.equal(attempts.length, width === 768 ? 2 : 1);
          assert.ok(attempts[0].key);
          assert.equal(JSON.parse(attempts[0].body).expectedPrimaryTaskId, task.taskId);
          if (width === 768) {
            assert.equal(attempts[0].body, attempts[1].body);
            assert.equal(attempts[0].key, attempts[1].key);
          }
          assert.equal(
            (await demo.db.prepare('SELECT status FROM tasks WHERE id=?').bind(task.taskId).first())
              .status,
            'COMPLETED',
          );
          await page.unroute('**' + path);
          if (width === 360) await page.unroute(readPattern);
          row.checks.push(
            width === 768
              ? 'uncertain-exact-retry-cannot-be-hidden'
              : 'accepted-write-get-only-cannot-be-hidden',
          );
        }
        if (width === 1440) {
          await button('Menüyü daralt').click();
          assert.equal(await page.locator('.app-shell').getAttribute('data-collapsed'), 'true');
          await button('Menüyü genişlet').click();
        }
        row.checks.push('all-actions-preserved-no-horizontal-overflow');
      }
      assert.equal(runtimeErrors.length, 0);
      row.runtimeErrors = 0;
      row.passed = true;
      await writeFile(
        join(directory, 'progress.json'),
        JSON.stringify({ baseline, rows }, null, 2),
      );
      console.info('AIRY_CELL', user.id, width);
      await context.close();
    }
  assert.equal(rows.length, previewOnly ? 0 : only ? 1 : 9);
  assert.ok(rows.every((r) => r.passed));
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      { baseline, previewOnly, browser: browser.version(), visible: true, rows },
      null,
      2,
    ),
  );
  console.info('AIRY_RESULT', directory);
  if (keepOpen && !baseline) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
    const page = await context.newPage();
    await authenticate(page, app.DEMO_USERS[0], passwords[0]);
    passwords.fill('');
    await page.goto(origin + '/today-work');
    await page.locator('.today-task-row').first().click();
    await page.bringToFront();
    await buttonPreview(page, 'Teklifler');
    const browserCdp = await browser.newBrowserCDPSession();
    const procs = await browserCdp.send('SystemInfo.getProcessInfo');
    const pid = procs.processInfo.find((p) => p.type === 'browser').id;
    const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);' -Name AiryWindow -Namespace Native; $p=Get-Process -Id ${pid}; if($p.MainWindowHandle -eq 0 -or -not [Native.AiryWindow]::IsWindowVisible($p.MainWindowHandle)){exit 2}; Write-Output 'VISIBLE_WINDOW_VERIFIED'`;
    assert.match(
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true },
      ),
      /VISIBLE_WINDOW_VERIFIED/,
    );
    const ui = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.querySelector('#app-sidebar')).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
      groups: document.querySelectorAll('.workspace-section').length,
    }));
    assert.equal(ui.sidebar, 'rgb(20, 44, 67)');
    assert.equal(ui.groups, 4);
    const css = await page.evaluate(async () => {
      const url = document.querySelector('link[rel="stylesheet"]').href;
      return { path: new URL(url).pathname, text: await (await fetch(url)).text() };
    });
    assert.ok(css.path.startsWith('/assets/'));
    assert.equal(
      createHash('sha256').update(css.text).digest('hex'),
      createHash('sha256')
        .update(await readFile(resolve('node_modules/.cache/airy-client', css.path.slice(1))))
        .digest('hex'),
    );
    ui.servedCssMatchesBuild = true;
    await writeFile(
      join(directory, 'preview.json'),
      JSON.stringify(
        { url: page.url(), owner: true, visible: true, pid: process.pid, browserPid: pid, ui },
        null,
        2,
      ),
    );
    console.info('AIRY_PREVIEW_READY', directory);
    await new Promise((resolve) => {
      browser.once('disconnected', resolve);
      page.once('close', resolve);
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  }
} catch (error) {
  await writeFile(
    join(directory, 'failed.json'),
    JSON.stringify(
      {
        baseline,
        rows,
        error: error.name,
        message: error.message.split('\n')[0],
        trace: error.stack
          ?.split('\n')
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 4),
      },
      null,
      2,
    ),
  );
  console.error('AIRY_FAILED', directory, error.name);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
  await rm(join(directory, 'application.mjs'), { force: true });
}
async function cannotCollapse(page, title) {
  const control = page.getByRole('button', { name: title, exact: true });
  assert.equal(await control.getAttribute('aria-disabled'), 'true');
  await control.focus();
  await page.keyboard.press('Enter');
  assert.equal(await control.getAttribute('aria-expanded'), 'true');
}
async function buttonPreview(page, title) {
  await page.getByRole('button', { name: title, exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: title, exact: true }).getAttribute('aria-expanded'),
    'false',
  );
}
async function authenticate(page, user, password) {
  await page.goto(origin + '/');
  await page.getByLabel('E-posta', { exact: true }).fill(user.email);
  await page.getByLabel('Şifre', { exact: true }).fill(password);
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/login',
  );
  await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
  assert.equal((await response).status(), 200);
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  const auth = await page.evaluate(async () => {
    const r = await fetch('/api/auth/session', { cache: 'no-store' });
    const j = await r.json();
    return {
      status: r.status,
      email: j.data?.email,
      state: j.data?.state,
      isOwner: j.data?.isOwner,
    };
  });
  assert.equal(auth.status, 200);
  assert.equal(auth.email, user.email);
  assert.equal(auth.state, 'NORMAL');
  assert.equal(auth.isOwner, user.id === 'owner');
}
