// Opt-in focused real Edge walkthrough using disposable D1/canonical auth.
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
import { verifyPolicyParties } from './policy-parties.walkthrough.mjs';
const { URL } = globalThis;
let stage = 'setup',
  browser,
  demo,
  tls,
  server,
  directory,
  companyId;
const passwords = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
try {
  await mkdir('node_modules/.cache', { recursive: true });
  directory = await mkdtemp(resolve('node_modules/.cache/policy-form-smoke-'));
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
  stage = 'demo-open';
  demo = await application.openDemo(passwords);
  tls = await demoCertificate();
  server = await serveDemo(demo, tls);
  // Synthetic fixtures force the real origin outside the first bounded customer page.
  stage = 'synthetic-customer-fixtures';
  await demo.db.batch(
    Array.from({ length: 24 }, (_, index) =>
      demo.db
        .prepare(
          "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id,created_at,updated_at) VALUES(?,'demo-agency','INDIVIDUAL',?,?,?,'demo-member-owner',?,?)",
        )
        .bind(
          `search-page-${index}`,
          `Sıra Müşterisi ${index}`,
          'Sıra',
          `Müşterisi ${index}`,
          new Date(Date.now() + 1000).toISOString(),
          new Date(Date.now() + 2000).toISOString(),
        ),
    ),
  );
  stage = 'edge-launch';
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  await demo.db
    .prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('smoke-card','demo-agency','SMOKE_CARD','Taksitli Kart',1,6)",
    )
    .run();
  for (const [index, user] of application.DEMO_USERS.entries()) {
    stage = `login-${index}`;
    console.info('POLICY_FORM_STAGE', stage);
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
    if (!index) {
      companyId = await page.evaluate(async () => {
        const csrf = await (await globalThis.fetch('/api/csrf-token')).json();
        const r = await globalThis.fetch('/api/customers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf.data.token,
            'Idempotency-Key': globalThis.crypto.randomUUID(),
          },
          body: JSON.stringify({ type: 'COMPANY', companyTitle: 'Sentetik Poliçe Şirketi' }),
        });
        if (r.status !== 201) throw new Error('COMPANY_SETUP');
        return (await r.json()).data.id;
      });
      assert.equal(
        await page.evaluate(async () =>
          (await (await globalThis.fetch('/api/customers?limit=20')).json()).data.items.some(
            (customer) => customer.id === 'demo-customer-0',
          ),
        ),
        false,
      );
      await page.goto('https://localhost:8443/customers/demo-customer-0/advanced');
      await page.getByRole('button', { name: '+ Poliçe Ekle', exact: true }).click();
      await page.waitForURL('**/policies/legacy?customerId=demo-customer-0');
      await page.getByRole('heading', { name: 'Yeni Poliçe', exact: true }).waitFor();
      assert.equal(
        await page.getByLabel('Müşteri', { exact: true }).inputValue(),
        'demo-customer-0',
      );
    }
    let createdId, createdNumber;
    for (const [kind, origin] of [
      ['individual', 'demo-customer-0'],
      ['company', companyId],
    ]) {
      stage = `create-${index}-${kind}`;
      console.info('POLICY_FORM_STAGE', stage);
      await page.goto('https://localhost:8443/customers/' + origin);
      await page.getByRole('link', { name: 'Poliçe ekle', exact: true }).click();
      await page.waitForURL('**/policies/new?customerId=' + origin);
      await page.getByLabel('Poliçe numarası', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Müşteri', { exact: true }).inputValue(), origin);
      const controls = [
        ['Sigorta şirketi', 'demo-insurer'],
        ['Branş', 'demo-branch'],
        ['Ürün', 'demo-product'],
        ['Ödeme yöntemi', kind === 'company' ? 'smoke-card' : 'demo-payment'],
      ];
      for (const [label, value] of controls)
        await page.getByLabel(label, { exact: true }).selectOption(value);
      if (kind === 'company') {
        await page.getByLabel('Taksit sayısı', { exact: true }).fill('3');
        await page.getByLabel('ISO para birimi', { exact: true }).fill('EUR');
      }
      createdNumber = `FORM-SMOKE-${index}-${kind}`;
      await page.getByLabel('Poliçe numarası', { exact: true }).fill(createdNumber);
      await page.getByLabel('Başlangıç tarihi', { exact: true }).fill('2027-01-01');
      await page.getByLabel('Bitiş tarihi', { exact: true }).fill('2027-12-31');
      await page.getByLabel('Brüt prim', { exact: true }).fill('1234.56');
      for (const width of [1440, 768, 360]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          true,
        );
      }
      let attempts = 0;
      const writes = [];
      if (!index && kind === 'individual')
        await page.route('**/api/policies', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          writes.push({
            body: route.request().postData(),
            key: route.request().headers()['idempotency-key'],
          });
          const committed = await route.fetch();
          assert.equal(committed.status(), 201);
          if (++attempts === 1)
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false }),
            });
          return route.fulfill({ response: committed });
        });
      await page.getByRole('button', { name: 'Poliçeyi oluştur', exact: true }).click();
      if (!index && kind === 'individual') {
        await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).waitFor();
        assert.equal(await page.getByLabel('Müşteri', { exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
      }
      await page.waitForURL(
        (url) => /^\/policies\/[^/]+$/.test(url.pathname) && url.pathname !== '/policies/new',
      );
      await page.getByRole('heading', { name: createdNumber, exact: true }).waitFor();
      await page
        .getByText('Poliçe kaydedildi ve güncel detay doğrulandı.', { exact: true })
        .waitFor();
      createdId = new URL(page.url()).pathname.split('/').at(-1);
      const actual = await page.evaluate(
        async (id) => (await (await globalThis.fetch('/api/policies/' + id)).json()).data,
        createdId,
      );
      assert.equal(actual.customerId, origin);
      assert.equal(actual.grossPremiumMinor, 123456);
      assert.equal(actual.installmentCount, kind === 'company' ? 3 : null);
      assert.equal(actual.currency, kind === 'company' ? 'EUR' : 'TRY');
      if (!index && kind === 'individual') {
        assert.equal(attempts, 2);
        assert.deepEqual(writes[0], writes[1]);
        await page.unroute('**/api/policies');
      }
    }
    stage = `edit-${index}`;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('link', { name: 'Poliçeyi düzenle', exact: true }).click();
    await page.getByLabel('Poliçe numarası', { exact: true }).waitFor();
    await page.reload();
    await page.getByLabel('Brüt prim', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Müşteri', { exact: true }).count(), 0);
    await page.getByLabel('Brüt prim', { exact: true }).fill('2345.67');
    if (!index)
      assert.equal(
        await page.evaluate(async (id) => {
          const p = (await (await globalThis.fetch('/api/policies/' + id)).json()).data;
          const csrf = (await (await globalThis.fetch('/api/csrf-token')).json()).data.token;
          return (
            await globalThis.fetch('/api/policies/' + id, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrf,
                'Idempotency-Key': globalThis.crypto.randomUUID(),
              },
              body: JSON.stringify({ expectedVersion: p.version, currency: 'USD' }),
            })
          ).status;
        }, createdId),
        200,
      );
    const edits = [];
    let dropped = false,
      successfulWrite = false;
    await page.route('**/api/policies/' + createdId, async (route) => {
      if (route.request().method() === 'PATCH') {
        edits.push({
          body: route.request().postData(),
          key: route.request().headers()['idempotency-key'],
        });
        const committed = await route.fetch();
        if (committed.status() === 200) successfulWrite = true;
        if (index === 1 && !dropped && committed.status() === 200) {
          dropped = true;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false }),
          });
        }
        return route.fulfill({ response: committed });
      }
      if (index === 0 && successfulWrite && !dropped) {
        dropped = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      }
      return route.continue();
    });
    await page.getByRole('button', { name: 'Değişiklikleri kaydet', exact: true }).click();
    if (!index) {
      await page.getByRole('button', { name: 'Güncel poliçeyi karşılaştır', exact: true }).click();
      await page.getByText('USD', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Brüt prim', { exact: true }).inputValue(), '2345.67');
      await page
        .getByRole('button', { name: 'Karşılaştırdım, değişiklikleri kaydet', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Kaydedilen poliçeyi yeniden oku', exact: true })
        .click();
    }
    if (index === 1) {
      await page.getByRole('button', { name: 'Aynı işlemi yeniden dene', exact: true }).click();
    }
    await page.waitForURL('**/policies/' + createdId);
    await page.getByRole('heading', { name: createdNumber, exact: true }).waitFor();
    for (const edit of edits) {
      const body = JSON.parse(edit.body);
      assert.deepEqual(Object.keys(body).sort(), ['expectedVersion', 'grossPremium']);
      assert.equal(body.grossPremium, '2345.67');
    }
    assert.equal(edits.length, index === 2 ? 1 : 2);
    if (index === 1) assert.deepEqual(edits[0], edits[1]);
    await page.unroute('**/api/policies/' + createdId);
    const updated = await page.evaluate(
      async (id) => (await (await globalThis.fetch('/api/policies/' + id)).json()).data,
      createdId,
    );
    assert.equal(updated.grossPremiumMinor, 234567);
    assert.equal(updated.currency, index === 0 ? 'USD' : 'EUR');
    assert.equal(updated.customerId, companyId);
    assert.equal(updated.installmentCount, 3);
    for (const width of [1440, 768, 360]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        true,
      );
    }
    await page.getByRole('link', { name: 'Sentetik Poliçe Şirketi', exact: true }).click();
    await page.getByRole('heading', { name: 'Sentetik Poliçe Şirketi', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: createdNumber, exact: true }).waitFor();
    await page.goForward();
    await page.getByRole('heading', { name: 'Sentetik Poliçe Şirketi', exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('https://localhost:8443/policies');
    await page.getByLabel('Poliçe numarası', { exact: true }).fill(createdNumber);
    await page.getByRole('button', { name: 'Filtrele', exact: true }).click();
    await page.getByRole('link', { name: createdNumber, exact: true }).click();
    stage = `parties-${index}`;
    console.info('POLICY_FORM_STAGE', stage);
    await verifyPolicyParties(page, createdId, index);
    stage = `revocation-${index}`;
    await page.getByRole('link', { name: 'Poliçeyi düzenle', exact: true }).click();
    await page.getByLabel('Poliçe numarası', { exact: true }).waitFor();
    await demo.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .bind(Date.now(), 'demo-user-' + user.id)
      .run();
    await page.getByLabel('Poliçe numarası', { exact: true }).fill('REVOKED-NO-WRITE');
    await page.getByRole('button', { name: 'Değişiklikleri kaydet', exact: true }).click();
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Brüt prim', { exact: true }).count(), 0);
    assert.equal(
      (
        await demo.db
          .prepare('SELECT policy_number n FROM policies WHERE id=?')
          .bind(createdId)
          .first()
      ).n,
      createdNumber,
    );
    assert.equal(failures.length, 0);
    await context.close();
  }
  console.info(
    'POLICY_FORM_BROWSER PASS: OWNER/Ahmet/Ayşe; modern policy create/edit/handoff; insured+beneficiary create/deactivate/history; parent vs child CAS; exact retries and GET-only readback;1440/768/360; no party-profile navigation; list/detail/back-forward; revocation cleanup; CSP/runtime.',
  );
} catch {
  console.error(`POLICY_FORM_BROWSER FAIL at ${stage}. No credentials or raw diagnostics logged.`);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
}
