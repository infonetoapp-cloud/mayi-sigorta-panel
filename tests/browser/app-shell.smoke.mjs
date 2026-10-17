// Opt-in real-browser smoke, not part of the historical Vitest suite.
// Uses the canonical disposable local demo + real login, never mocked auth.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { demoCertificate, serveDemo } from '../../scripts/demo/https-server.mjs';
const { URL } = globalThis;
let stage = 'setup',
  browser,
  demo,
  tls,
  server,
  directory;
const passwords = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
try {
  await mkdir('node_modules/.cache', { recursive: true });
  directory = await mkdtemp(resolve('node_modules/.cache/frontend-smoke-'));
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
  const application = await import(pathToFileURL(bundle).href);
  demo = await application.openDemo(passwords);
  tls = await demoCertificate();
  server = await serveDemo(demo, tls);
  // Windows uses installed Edge; other platforms can install Chromium through Playwright.
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  for (const [index, user] of application.DEMO_USERS.entries()) {
    stage = `login-${index}`;
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', () => failures.push('runtime'));
    page.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text()))
        failures.push('csp');
    });
    await page.goto('https://localhost:8443/');
    await page.getByLabel('E-posta', { exact: true }).fill(user.email);
    await page.getByLabel('Şifre', { exact: true }).fill(passwords[index]);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    stage = `responsive-${index}`;
    assert.equal(
      await page
        .locator('.app-sidebar')
        .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
      248,
    );
    await page.getByRole('button', { name: 'Menüyü daralt', exact: true }).click();
    assert.equal(
      await page
        .locator('.app-sidebar')
        .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
      72,
    );
    await page.getByRole('button', { name: 'Menüyü genişlet', exact: true }).click();
    for (const width of [768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.getByRole('navigation', { name: 'Ana menü' }).isVisible(), false);
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.getByRole('button', { name: 'Menüyü aç', exact: true }).click();
      assert.equal(await page.getByRole('navigation', { name: 'Ana menü' }).isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('navigation', { name: 'Ana menü' }).isVisible(), false);
      await page.screenshot({ path: join(directory, `overview-${index}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    stage = `compatibility-${index}`;
    await page.getByRole('link', { name: 'Müşteriler', exact: true }).click();
    await page.getByRole('link', { name: 'Yeni Müşteri', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('link', { name: 'Yeni Müşteri', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/customers');
    for (const type of ['INDIVIDUAL', 'COMPANY']) {
      stage = `modern-create-${index}-${type}`;
      await page.goto('https://localhost:8443/customers/new');
      await page.reload();
      await page.getByLabel('Müşteri türü', { exact: true }).selectOption(type);
      const name = type === 'INDIVIDUAL' ? `Sentetik Deneme${index}` : `Sentetik Şirket${index}`;
      if (type === 'INDIVIDUAL') {
        await page.getByLabel('Ad', { exact: true }).fill('Sentetik');
        await page.getByLabel('Soyad', { exact: true }).fill(`Deneme${index}`);
      } else await page.getByLabel('Şirket unvanı', { exact: true }).fill(name);
      for (const width of [1440, 768, 360]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          true,
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      const lostReply = index === 0 && type === 'INDIVIDUAL';
      const writes = [];
      if (lostReply)
        await page.route('**/api/customers', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          writes.push({
            body: route.request().postData(),
            key: route.request().headers()['idempotency-key'],
          });
          if (writes.length === 1) {
            const committed = await route.fetch();
            assert.equal(committed.status(), 201);
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false }),
            });
          } else await route.continue();
        });
      await page.getByRole('button', { name: 'Müşteriyi kaydet', exact: true }).click();
      if (lostReply) {
        await page
          .getByRole('button', { name: 'Aynı kaydı güvenle yeniden dene', exact: true })
          .click();
      }
      await page.getByRole('heading', { name, exact: true }).waitFor();
      if (lostReply) {
        assert.equal(writes.length, 2);
        assert.deepEqual(writes[0], writes[1]);
        await page.unroute('**/api/customers');
      }
      const profilePath = new URL(page.url()).pathname;
      assert.equal(await page.locator('.legacy-workspace').count(), 0);
      stage = `modern-contact-${index}-${type}`;
      await page.getByRole('link', { name: 'İletişim', exact: true }).click();
      await page.getByRole('button', { name: 'Düzenle', exact: true }).click();
      const contactForm = page.getByRole('region', { name: 'İletişim bilgilerini düzenleme' });
      const email = `updated-${index}-${type.toLowerCase()}@demo.invalid`;
      await contactForm.getByLabel('E-posta', { exact: true }).fill(email);
      if (lostReply) {
        // A real independent API update advances CAS while the inline draft stays open.
        assert.equal(
          await page.evaluate(async (path) => {
            const current = await (await globalThis.fetch('/api' + path)).json();
            const csrf = await (await globalThis.fetch('/api/csrf-token')).json();
            return (
              await globalThis.fetch('/api' + path, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': csrf.data.token,
                  'Idempotency-Key': globalThis.crypto.randomUUID(),
                },
                body: JSON.stringify({
                  expectedVersion: current.data.version,
                  address: 'Başka oturumun adresi',
                }),
              })
            ).status;
          }, profilePath),
          200,
        );
      }
      await page.getByRole('button', { name: 'İletişim bilgilerini kaydet', exact: true }).click();
      if (lostReply) {
        await page.getByRole('button', { name: 'Güncel bilgileri yükle', exact: true }).click();
        await page.getByText('Başka oturumun adresi', { exact: true }).waitFor();
        assert.equal(await contactForm.getByLabel('E-posta', { exact: true }).inputValue(), email);
        await page
          .getByRole('button', { name: 'Karşılaştırdım, iletişim bilgilerini kaydet', exact: true })
          .click();
      }
      await page.getByText('İletişim bilgileri kaydedildi.', { exact: true }).waitFor();
      await page.reload();
      await page.getByText(email, { exact: true }).first().waitFor();
      if (index === 0 && type === 'COMPANY') {
        stage = 'legacy-archive-modern-denial';
        await page.getByRole('link', { name: 'İleri müşteri işlemleri', exact: true }).click();
        await page.getByRole('button', { name: 'Müşteriyi Arşivle', exact: true }).click();
        await page.getByLabel('Arşiv Nedeni', { exact: true }).fill('DEMO_CLOSED');
        await page.getByRole('button', { name: 'Arşivlemeyi Onayla', exact: true }).click();
        await page
          .getByText('Bu müşteri arşivlenmiştir. Geçmiş kayıtları korunur.', { exact: true })
          .waitFor();
        await page.getByRole('button', { name: '✕', exact: true }).click();
        await page.getByRole('link', { name: 'Modern müşteri profiline dön', exact: true }).click();
        await page.getByRole('link', { name: 'İletişim', exact: true }).click();
        await page
          .getByText('Arşivlenmiş müşterinin iletişim bilgileri düzenlenemez.', { exact: true })
          .waitFor();
        assert.equal(await page.getByRole('button', { name: 'Düzenle', exact: true }).count(), 0);
      }
      await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
    }
    stage = `compatibility-${index}`;
    await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).click();
    await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/customers/demo-customer-0');
    assert.equal(await page.locator('.legacy-workspace').count(), 0);
    await page.reload();
    await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
    await page.getByText('Kaydeden: Ahmet', { exact: true }).first().waitFor();
    await page.getByText('Kaydeden: Ayşe', { exact: true }).first().waitFor();
    await page
      .getByLabel('Yeni müşteri notu', { exact: true })
      .fill(`Yerel profil denemesi ${index}`);
    await page.getByRole('button', { name: 'Notu kaydet', exact: true }).click();
    await page.getByText(`Yerel profil denemesi ${index}`, { exact: true }).waitFor();
    await page.getByText(`Kaydeden: ${user.name}`, { exact: true }).first().waitFor();
    for (const width of [768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
      await page.getByText(`Yerel profil denemesi ${index}`, { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
      await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).click();
      await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
      await page.goBack();
      await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).waitFor();
      await page.goForward();
      await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('link', { name: 'Poliçeler ve yenilemeler', exact: true }).click();
    await page.getByRole('heading', { name: 'Mevcut poliçeler', exact: true }).waitFor();
    await page.getByRole('link', { name: 'İleri müşteri işlemleri', exact: true }).click();
    await page.getByText('Geçici klasik müşteri çalışma alanı', { exact: true }).waitFor();
    await page.getByRole('button', { name: '+ Poliçe Ekle', exact: true }).waitFor();
    await page.getByRole('button', { name: '+ Poliçe Ekle', exact: true }).click();
    await page.waitForURL('**/policies');
    // The legacy customer->policy hand-off must survive real route navigation.
    await page.getByRole('heading', { name: 'Yeni Poliçe', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Bugünkü İşler', exact: true }).click();
    await page
      .getByRole('button', { name: 'Görev istatistiklerini göster', exact: true })
      .waitFor();
    const work = await page.evaluate(async () =>
      (await globalThis.fetch('/api/tasks/today')).json(),
    );
    assert.equal(work.data.items.length, index === 0 ? 10 : 5);
    if (index > 0) {
      assert.equal(new Set(work.data.items.map((item) => item.assigneeMembershipId)).size, 1);
      assert.equal(
        work.data.items[0].assigneeMembershipId,
        index === 1 ? 'demo-member-ahmet' : 'demo-member-ayse',
      );
      assert.equal(
        await page.getByRole('link', { name: 'Personel ve İzinler', exact: true }).count(),
        0,
      );
      await page.goto('https://localhost:8443/personnel');
      await page.getByRole('heading', { name: 'Bu sayfaya erişiminiz yok', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(async () => (await globalThis.fetch('/api/personnel')).status),
        403,
      );
      assert.equal(
        await page.evaluate(
          async () => (await globalThis.fetch('/api/tasks/statistics?view=team')).status,
        ),
        403,
      );
    } else {
      await page.getByRole('link', { name: 'Personel ve İzinler', exact: true }).click();
      await page.getByRole('button', { name: 'Personel oluştur', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Acente Ayarları', exact: true }).click();
      await page.getByRole('heading', { name: 'Acente Ayarları', exact: true }).first().waitFor();
    }
    await page.getByRole('link', { name: 'Kataloglar', exact: true }).click();
    await page.getByRole('heading', { name: 'Kataloglar', exact: true }).first().waitFor();
    await page.getByRole('link', { name: 'Genel Bakış', exact: true }).click();
    await page.goBack();
    assert.equal(new URL(page.url()).pathname, '/catalogs');
    await page.goForward();
    assert.equal(new URL(page.url()).pathname, '/');
    stage = `session-end-${index}`;
    if (index === 2) {
      await page.goto('https://localhost:8443/customers/demo-customer-0');
      await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
      // Revoke the real live session, then exercise the existing 401 event path.
      await demo.db
        .prepare(
          'UPDATE local_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        )
        .bind(Math.floor(Date.now() / 1000), 'demo-user-' + user.id)
        .run();
      await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
    } else await page.getByRole('button', { name: 'Çıkış Yap', exact: true }).click();
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    await page.goto('https://localhost:8443/customers');
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(failures.length, 0);
    await context.close();
  }
  console.info(
    'FRONTEND_BROWSER_SMOKE PASS: 3 real logins; modern individual/company creation + safe retry; inline contact CAS; 1440/768/360; list/profile/notes/history; legacy archive/policy hand-off; private tasks; owner denial; logout/live revocation; CSP/runtime.',
  );
} catch {
  // Never print raw Playwright errors: call arguments can include synthetic secrets.
  console.error(
    `FRONTEND_BROWSER_SMOKE FAIL at ${stage}. No credentials or raw diagnostics logged.`,
  );
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
}
