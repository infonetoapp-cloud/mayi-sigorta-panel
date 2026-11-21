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
  demo = await application.openDemo(passwords, {
    companyRegistrationActors: application.DEMO_USERS.map(({ id }) => id),
  });
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
    page.setDefaultTimeout(15000);
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
      236,
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
    stage = `operations-readiness-${index}`;
    const readiness = page.getByRole('link', { name: 'İşletim durumu', exact: true });
    if (index === 0) {
      const result = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/ops/readiness',
      );
      await readiness.click();
      const response = await result;
      assert.equal(response.status(), 503);
      assert.ok(response.headers()['cache-control'].includes('no-store'));
      const checks = page.getByRole('region', { name: 'İşletim kontrolleri' });
      await checks.getByText('Otomatik yedek', { exact: true }).waitFor();
      await checks.getByText('Belge işleri', { exact: true }).waitFor();
      await checks
        .locator('dt + dd', { hasText: /^Kapalı$/ })
        .first()
        .waitFor();
    } else {
      assert.equal(await readiness.count(), 0);
      await page.goto('https://localhost:8443/ops/readiness');
      await page.getByRole('heading', { name: 'Bu sayfaya erişiminiz yok', exact: true }).waitFor();
    }
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
      } else {
        await page.getByLabel('Şirket unvanı', { exact: true }).fill(name);
        await page.getByLabel('Vergi no (zorunlu)', { exact: true }).fill(`900000000${index}`);
      }
      await page
        .getByLabel('Sigorta şirketi (zorunlu)', { exact: true })
        .selectOption('demo-insurer');
      await page
        .getByLabel('Şirket müşteri no (zorunlu)', { exact: true })
        .fill(`00-smoke-${index}-${type}`);
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
      if (type === 'COMPANY') {
        stage = `company-contacts-${index}`;
        console.info('SMOKE_STAGE', stage);
        const section = page.getByRole('region', {
          name: 'Şirket yetkilisi yönetimi',
          exact: true,
        });
        await section.getByRole('heading', { name: 'Şirket yetkilileri', exact: true }).waitFor();
        let attempts = 0;
        const contactWrites = [];
        if (index === 0)
          await page.route('**/api/customers/*/contacts', async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            contactWrites.push({
              body: route.request().postData(),
              key: route.request().headers()['idempotency-key'],
            });
            if (++attempts === 1) {
              const committed = await route.fetch();
              assert.equal(committed.status(), 201);
              return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ success: false }),
              });
            }
            return route.continue();
          });
        for (const firstName of ['Birinci', 'İkinci']) {
          await section.getByRole('button', { name: 'Yetkili ekle', exact: true }).click();
          await section.getByLabel('Yetkili adı', { exact: true }).fill(firstName);
          await section.getByLabel('Yetkili soyadı', { exact: true }).fill('Yetkili');
          if (firstName === 'Birinci')
            await section.getByLabel('Birincil yetkili olarak ata', { exact: true }).check();
          for (const width of [1440, 768, 360]) {
            await page.setViewportSize({ width, height: 900 });
            assert.equal(
              await page.evaluate(
                () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
              ),
              true,
            );
          }
          await section.getByRole('button', { name: 'Yetkiliyi kaydet', exact: true }).click();
          if (index === 0 && firstName === 'Birinci') {
            await section
              .getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true })
              .waitFor();
            assert.equal(
              await section.getByLabel('Yetkili adı', { exact: true }).isDisabled(),
              true,
            );
            await section
              .getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true })
              .click();
          }
          await section.getByText('Yetkili eklendi.', { exact: true }).waitFor();
          if (index === 0 && firstName === 'Birinci') {
            assert.deepEqual(contactWrites[0], contactWrites[1]);
            await page.unroute('**/api/customers/*/contacts');
          }
        }
        const second = section.getByRole('region', { name: 'İkinci Yetkili', exact: true });
        await second.getByRole('button', { name: 'Yetkiliyi düzenle', exact: true }).click();
        await section.getByLabel('Yetkili e-postası', { exact: true }).fill('contact@demo.invalid');
        if (index === 0) {
          assert.equal(
            await page.evaluate(async (path) => {
              const current = await (await globalThis.fetch('/api' + path)).json();
              const target = current.data.contacts.find(
                (contact) => contact.firstName === 'İkinci',
              );
              const csrf = await (await globalThis.fetch('/api/csrf-token')).json();
              return (
                await globalThis.fetch('/api' + path + '/contacts/' + target.id, {
                  method: 'PATCH',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf.data.token,
                    'Idempotency-Key': globalThis.crypto.randomUUID(),
                  },
                  body: JSON.stringify({
                    expectedVersion: target.version,
                    role: 'Başka oturumun görevi',
                  }),
                })
              ).status;
            }, profilePath),
            200,
          );
        }
        await section.getByRole('button', { name: 'Değişiklikleri kaydet', exact: true }).click();
        if (index === 0) {
          await section
            .getByRole('button', { name: 'Güncel yetkilileri yükle', exact: true })
            .click();
          await second.getByText('Başka oturumun görevi', { exact: true }).waitFor();
          assert.equal(
            await section.getByLabel('Yetkili e-postası', { exact: true }).inputValue(),
            'contact@demo.invalid',
          );
          await section
            .getByRole('button', { name: 'Karşılaştırdım, değişiklikleri kaydet', exact: true })
            .click();
        }
        await section.getByText('Yetkili bilgileri güncellendi.', { exact: true }).waitFor();
        await second.getByRole('button', { name: 'Birincil yap', exact: true }).click();
        await section.getByRole('button', { name: 'Birincil yapmayı onayla', exact: true }).click();
        await section.getByText('Birincil yetkili değiştirildi.', { exact: true }).waitFor();
        await second.getByText('Birincil yetkili', { exact: true }).waitFor();
        await second.getByRole('button', { name: 'Pasifleştir', exact: true }).click();
        await section.getByRole('button', { name: 'Pasifleştirmeyi onayla', exact: true }).click();
        await section.getByText('Yetkili pasifleştirildi.', { exact: true }).waitFor();
        await second.getByText('Pasif', { exact: true }).waitFor();
        assert.equal(
          await second.getByRole('button', { name: 'Birincil yap', exact: true }).count(),
          0,
        );
        assert.equal(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          true,
        );
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.reload();
        await page
          .getByRole('region', { name: 'İkinci Yetkili', exact: true })
          .getByText('Pasif', { exact: true })
          .waitFor();
      }
      if (index === 0 && type === 'COMPANY') {
        stage = 'modern-archive-open-management';
        await page.getByRole('link', { name: 'Diğer müşteri işlemleri', exact: true }).click();
        stage = 'modern-archive-open-form';
        await page.getByRole('heading', { name: 'Müşteri işlemleri', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Müşteriyi Arşivle', exact: true }).click();
        stage = 'modern-archive-select-reason';
        await page.getByRole('combobox', { name: /Arşiv Nedeni/ }).selectOption('DATA_CLEANUP');
        stage = 'modern-archive-write';
        const archiveResponse = page.waitForResponse(
          (res) => res.url().endsWith('/archive') && res.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Arşivlemeyi Onayla', exact: true }).click();
        const archive = await archiveResponse;
        if (archive.status() !== 200) {
          const { error } = await archive.json();
          console.error('SMOKE_ARCHIVE_RESULT', archive.status(), error?.code ?? 'UNKNOWN');
        }
        assert.equal(archive.status(), 200);
        stage = 'modern-archive-readback';
        await page
          .getByText('Bu müşteri arşivlenmiştir. Geçmiş kayıtları korunur.', { exact: true })
          .waitFor();
        await page.getByRole('link', { name: 'Müşteri kartına dön', exact: true }).click();
        await page.getByRole('link', { name: 'İletişim', exact: true }).click();
        stage = 'modern-archive-denial';
        await page
          .getByText('Arşivlenmiş müşterinin iletişim bilgileri düzenlenemez.', { exact: true })
          .waitFor();
        assert.equal(await page.getByRole('button', { name: 'Düzenle', exact: true }).count(), 0);
        assert.equal(
          await page.getByRole('button', { name: 'Yetkili ekle', exact: true }).count(),
          0,
        );
        await page
          .getByRole('region', { name: 'İkinci Yetkili', exact: true })
          .getByText('Pasif', { exact: true })
          .waitFor();
      }
      await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
    }
    stage = `compatibility-${index}`;
    await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).click();
    await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    stage = `compatibility-${index}-canonical-profile`;
    assert.equal(new URL(page.url()).pathname, '/customers/demo-customer-0');
    assert.equal(await page.locator('.legacy-workspace').count(), 0);
    await page.reload();
    await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    stage = `compatibility-${index}-notes`;
    await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
    await page.getByText('Kaydeden: Ahmet', { exact: true }).first().waitFor();
    await page.getByText('Kaydeden: Ayşe', { exact: true }).first().waitFor();
    await page
      .getByLabel('Yeni müşteri notu', { exact: true })
      .fill(`Yerel profil denemesi ${index}`);
    await page.getByRole('button', { name: 'Notu kaydet', exact: true }).click();
    const savedNote = page
      .getByRole('list', { name: 'Müşteri not geçmişi' })
      .getByRole('listitem')
      .filter({ has: page.getByText(`Yerel profil denemesi ${index}`, { exact: true }) });
    await savedNote.getByText(`Kaydeden: ${user.name}`, { exact: true }).waitFor();
    await page
      .getByRole('button', { name: 'Notları yenile', exact: true })
      .and(page.locator(':enabled'))
      .waitFor();
    for (const width of [768, 360]) {
      stage = `compatibility-${index}-profile-${width}`;
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('link', { name: 'Müşteri notları', exact: true }).click();
      await savedNote.waitFor();
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
      await page.waitForURL('**/customers');
      const customerLink = page.getByRole('link', { name: 'Deniz Yılmaz', exact: true });
      try {
        await customerLink.waitFor();
      } catch (error) {
        console.error(
          'SMOKE_PROFILE_RETURN',
          await customerLink.count(),
          await page.getByRole('heading', { name: 'Müşteriler', exact: true }).count(),
          await page.getByRole('alert').count(),
        );
        throw error;
      }
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
    stage = `compatibility-${index}-policy-handoff`;
    await page.getByRole('link', { name: 'Poliçeler ve yenilemeler', exact: true }).click();
    await page.getByRole('heading', { name: 'Mevcut poliçeler', exact: true }).waitFor();
    const policyNumberLinks = page.getByRole('link', { name: 'DEMO-0', exact: true });
    await policyNumberLinks.and(page.locator('a[href^="/renewals/"]')).waitFor();
    await policyNumberLinks.and(page.locator('a[href="/policies/demo-policy-0"]')).click();
    await page.getByRole('heading', { name: 'DEMO-0', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Mevcut poliçeler', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Diğer müşteri işlemleri', exact: true }).click();
    await page.getByRole('heading', { name: 'Müşteri işlemleri', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Müşteri kartına dön', exact: true }).click();
    await page.getByRole('link', { name: 'Poliçe ekle', exact: true }).click();
    await page.waitForURL('**/policies/new?customerId=demo-customer-0');
    await page.getByRole('heading', { name: 'Yeni poliçe', exact: true }).waitFor();
    stage = `modern-policies-${index}`;
    console.info('SMOKE_STAGE', stage);
    await page
      .getByRole('form', { name: 'Poliçe sözleşme formu' })
      .getByText('Deniz Yılmaz', { exact: true })
      .waitFor();
    const policyNumber = `MODERN-POL-${index}`;
    for (const [label, value] of [
      ['Sigorta şirketi', 'demo-insurer'],
      ['Branş', 'demo-branch'],
      ['Ürün', 'demo-product'],
      ['Ödeme yöntemi', 'demo-payment'],
    ]) {
      await page.getByLabel(label, { exact: true }).selectOption(value);
    }
    await page.getByLabel('Poliçe numarası', { exact: true }).fill(policyNumber);
    await page.getByLabel('Başlangıç tarihi', { exact: true }).fill('2027-01-01');
    await page.getByLabel('Bitiş tarihi', { exact: true }).fill('2027-12-31');
    await page.getByLabel('Brüt prim', { exact: true }).fill('1234.56');
    const savedResponse = page.waitForResponse(
      (res) => res.url().endsWith('/api/policies') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Poliçeyi oluştur', exact: true }).click();
    const saved = await savedResponse;
    assert.equal(saved.status(), 201);
    const savedPolicy = (await saved.json()).data;
    assert.equal(savedPolicy.customerId, 'demo-customer-0');
    await page.getByRole('heading', { name: policyNumber, exact: true }).waitFor();
    await page.goto('https://localhost:8443/policies');
    await page.getByRole('heading', { name: 'Poliçeler', exact: true }).waitFor();
    await page.getByLabel('Poliçe numarası', { exact: true }).fill(policyNumber);
    await page.getByText('Tarih ve diğer filtreler', { exact: true }).click();
    await page.getByLabel('Eşleştirme', { exact: true }).selectOption('exact');
    await page.getByRole('button', { name: 'Filtrele', exact: true }).click();
    await page.getByRole('link', { name: policyNumber, exact: true }).waitFor();
    for (const width of [1440, 768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
      assert.equal(
        await page
          .locator('.policy-directory-table tr')
          .last()
          .evaluate((row) => globalThis.getComputedStyle(row).display),
        width === 1440 ? 'table-row' : 'grid',
      );
    }
    await page.getByRole('link', { name: policyNumber, exact: true }).click();
    await page.getByRole('heading', { name: policyNumber, exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: policyNumber, exact: true }).waitFor();
    await page.getByText('1.234,56 ₺', { exact: true }).waitFor();
    for (const width of [1440, 768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['Sigortalılar ve lehtarlar', 'Zeyiller', 'Dış referanslar']) {
        await page.getByRole('link', { name, exact: true }).click();
        await page.getByRole('heading', { name, exact: true }).waitFor();
        await page.getByText('Bu bölümde kayıt bulunmuyor.', { exact: true }).waitFor();
        assert.equal(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          true,
        );
      }
      await page.getByRole('link', { name: 'Poliçe bilgileri', exact: true }).click();
      await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    }
    await page.getByRole('link', { name: 'Deniz Yılmaz', exact: true }).click();
    await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: policyNumber, exact: true }).waitFor();
    await page.goForward();
    await page.getByRole('heading', { name: 'Deniz Yılmaz', exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('link', { name: 'Bugünkü İşler', exact: true }).click();
    await page.getByRole('button', { name: 'İş yükü özeti', exact: true }).waitFor();
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
      await page.goto('https://localhost:8443/policies/' + savedPolicy.id);
      await page.getByRole('heading', { name: policyNumber, exact: true }).waitFor();
      // Revoke the real live session, then exercise the existing 401 event path.
      await demo.db
        .prepare(
          'UPDATE local_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        )
        .bind(Math.floor(Date.now() / 1000), 'demo-user-' + user.id)
        .run();
      await page.getByRole('link', { name: 'Sigortalılar ve lehtarlar', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Hesap menüsü', exact: true }).click();
      await page.getByText('Çıkış Yap', { exact: true }).click();
    }
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: policyNumber, exact: true }).count(), 0);
    await page.goto('https://localhost:8443/customers');
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(failures.length, 0);
    await context.close();
  }
  console.info(
    'FRONTEND_BROWSER_SMOKE PASS: 3 real logins; modern customer/company contacts; modern policy list/detail + filters + related reads; 1440/768/360; history/direct refresh/back-forward; policy creation with correct originating customer; private tasks; owner denial; logout/live policy revocation cleanup; CSP/runtime.',
  );
} catch (error) {
  // Never print raw Playwright errors: call arguments can include synthetic secrets.
  const location = error instanceof Error && error.stack?.match(/app-shell\.smoke\.mjs:\d+:\d+/);
  console.error(
    `FRONTEND_BROWSER_SMOKE FAIL at ${stage}${location ? ` (${location[0]})` : ''}. No credentials or raw diagnostics logged.`,
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
