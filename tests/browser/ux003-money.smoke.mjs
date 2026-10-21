/* global fetch, document */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const actor = process.env.UX003_ACTOR ?? 'owner',
  run = process.env.UX003_RUN;
assert.match(run ?? '', /^[a-z0-9-]+$/);
const origin = 'https://localhost:20443',
  evidence = resolve('ux003-evidence', run),
  cache = resolve('node_modules/.cache/ux003-runtime-' + run);
const passwords = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
let demo,
  tls,
  server,
  browser,
  page,
  stage = 'setup';
const result = { actor, checks: [], screenshots: [], policyAmounts: [] };
try {
  await mkdir(resolve('ux003-evidence'), { recursive: true });
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
  const app = await import(pathToFileURL(bundle).href),
    adapter = join(cache, 'https.mjs');
  await writeFile(
    adapter,
    (await readFile('scripts/demo/https-server.mjs', 'utf8'))
      .replaceAll('localhost:8443', 'localhost:20443')
      .replace('server.listen(8443,', 'server.listen(20443,')
      .replace("resolve('dist/client')", JSON.stringify(resolve('dist/client'))),
  );
  const https = await import(pathToFileURL(adapter).href);
  demo = await app.openDemo(passwords);
  tls = await https.demoCertificate();
  server = await https.serveDemo(demo, tls);
  browser = await chromium.launch({ channel: 'msedge', headless: false });
  const index = app.DEMO_USERS.findIndex((u) => u.id === actor);
  assert.ok(index >= 0);
  const user = app.DEMO_USERS[index];
  const width = actor === 'owner' ? 1440 : actor === 'ayse' ? 768 : 360;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: 1000 },
    hasTouch: width === 360,
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  let errors = 0;
  page.on('pageerror', () => errors++);
  const button = (name) => page.getByRole('button', { name, exact: true });
  const shot = async (name) => {
    await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
    result.screenshots.push(name + '.png');
  };
  stage = 'login';
  await page.goto(origin);
  await page.getByLabel('E-posta', { exact: true }).fill(user.email);
  await page.getByLabel('Şifre', { exact: true }).fill(passwords[index]);
  await button('Giriş Yap').click();
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  let firstId;
  for (const [i, value] of ['12500,50', '12500.50', '12.500,50'].entries()) {
    stage = 'policy-create-' + i;
    await page.goto(origin + '/policies/new?customerId=demo-customer-0');
    await page.getByLabel('Poliçe numarası', { exact: true }).waitFor();
    for (const [label, id] of [
      ['Sigorta şirketi', 'demo-insurer'],
      ['Branş', 'demo-branch'],
      ['Ürün', 'demo-product'],
      ['Ödeme yöntemi', 'demo-payment'],
    ])
      await page.getByLabel(label, { exact: true }).selectOption(id);
    const number = `UX003-${actor}-${i}`;
    await page.getByLabel('Poliçe numarası', { exact: true }).fill(number);
    await page.getByLabel('Başlangıç tarihi', { exact: true }).fill('2027-01-01');
    await page.getByLabel('Bitiş tarihi', { exact: true }).fill('2027-12-31');
    const premium = page.getByLabel('Brüt prim', { exact: true });
    const writes = [];
    let lose = i === 0;
    await page.route('**/api/policies', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push({
        body: route.request().postData(),
        key: route.request().headers()['idempotency-key'],
      });
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      if (lose) {
        lose = false;
        return route.abort('failed');
      }
      return route.fulfill({ response });
    });
    await premium.fill('12.500');
    await button('Poliçeyi oluştur').click();
    await page.locator('.customer-field-error').filter({ hasText: 'belirsiz' }).waitFor();
    assert.equal(writes.length, 0);
    await premium.fill(value);
    await shot('input-' + i);
    await button('Poliçeyi oluştur').click();
    if (i === 0) {
      await button('Aynı işlemi yeniden dene').waitFor();
      assert.equal(await premium.isDisabled(), true);
      await button('Aynı işlemi yeniden dene').click();
    }
    await page.getByRole('heading', { name: number, exact: true }).waitFor();
    assert.equal(writes.length, i === 0 ? 2 : 1);
    assert.equal(JSON.parse(writes[0].body).grossPremium, '12500.50');
    if (i === 0) {
      assert.equal(writes[0].body, writes[1].body);
      assert.equal(writes[0].key, writes[1].key);
    }
    const id = new URL(page.url()).pathname.split('/').at(-1);
    if (!i) firstId = id;
    const stored = await demo.db
      .prepare('SELECT gross_premium_minor AS amount,currency FROM policies WHERE id=?')
      .bind(id)
      .first();
    assert.deepEqual(stored, { amount: 1250050, currency: 'TRY' });
    await page.getByText('12.500,50 ₺', { exact: true }).first().waitFor();
    result.policyAmounts.push({
      input: value,
      canonical: JSON.parse(writes[0].body).grossPremium,
      stored: stored.amount,
      posts: writes.length,
    });
    await page.unroute('**/api/policies');
  }
  result.checks.push(
    'three-policy-input-formats-same-real-D1-value-strict-ambiguous-rejection-exact-retry',
  );
  stage = 'policy-edit-readback';
  await page.goto(origin + `/policies/${firstId}/edit`);
  await page.getByLabel('Brüt prim', { exact: true }).fill('12.501,50');
  let patches = 0,
    committed = false,
    failedRead = false;
  await page.route(`**/api/policies/${firstId}`, async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      patches++;
      assert.equal(JSON.parse(request.postData()).grossPremium, '12501.50');
      const r = await route.fetch();
      assert.ok(r.ok());
      committed = true;
      return route.fulfill({ response: r });
    }
    if (request.method() === 'GET' && committed && !failedRead) {
      failedRead = true;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"success":false}',
      });
    }
    return route.continue();
  });
  await button('Değişiklikleri kaydet').click();
  await button('Kaydedilen poliçeyi yeniden oku').click();
  await page.getByText('12.501,50 ₺', { exact: true }).first().waitFor();
  assert.equal(patches, 1);
  assert.equal(
    (
      await demo.db
        .prepare('SELECT gross_premium_minor AS amount FROM policies WHERE id=?')
        .bind(firstId)
        .first()
    ).amount,
    1250150,
  );
  await page.unroute(`**/api/policies/${firstId}`);
  result.checks.push('canonical-CAS-PATCH-accepted-write-GET-only-readback');
  stage = 'quote-create';
  await page.goto(origin + '/today-work');
  await page.locator('.today-task-row').first().click();
  await button('İletişim kaydı ekle').waitFor();
  await button('Teklifler').click();
  await button('Teklif geçmişini aç').click();
  await button('Yeni teklif taslağı aç').click();
  await page.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('12.500,50');
  await page.getByLabel('Yeni teklif kaydını oluşturmayı onaylıyorum', { exact: true }).check();
  let createdQuote, createdVersion;
  await page.route('**/api/renewals/*/quotes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    assert.equal(JSON.parse(route.request().postData()).version.grossPremiumMinor, 1250050);
    const r = await route.fetch();
    assert.equal(r.status(), 201);
    const data = (await r.json()).data;
    createdQuote = data.quoteId;
    createdVersion = data.quoteVersionId;
    return route.fulfill({ response: r });
  });
  await button('Teklifi oluştur').click();
  await page.getByText('Teklif kaydedildi ve geçmiş güncellendi.', { exact: true }).waitFor();
  assert.ok(createdQuote && createdVersion);
  assert.equal(
    (
      await demo.db
        .prepare('SELECT gross_premium_minor AS amount FROM renewal_quote_versions WHERE id=?')
        .bind(createdVersion)
        .first()
    ).amount,
    1250050,
  );
  await page.unroute('**/api/renewals/*/quotes');
  stage = 'quote-revise';
  await page.getByRole('button', { name: /Teklif 1 için yeni değişmez sürüm taslağı aç/ }).click();
  await page.getByLabel('Teklif brüt primi (ana birim)', { exact: true }).fill('12500,50');
  await page
    .getByLabel('Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum', { exact: true })
    .check();
  let revised;
  await page.route('**/api/renewals/*/quotes/*/versions', async (route) => {
    assert.equal(JSON.parse(route.request().postData()).version.grossPremiumMinor, 1250050);
    const r = await route.fetch();
    assert.equal(r.status(), 201);
    revised = (await r.json()).data.quoteVersionId;
    return route.fulfill({ response: r });
  });
  await button('Yeni değişmez sürümü oluştur').click();
  await page.getByText('Teklif kaydedildi ve geçmiş güncellendi.', { exact: true }).waitFor();
  assert.ok(revised);
  assert.equal(
    (
      await demo.db
        .prepare('SELECT gross_premium_minor AS amount FROM renewal_quote_versions WHERE id=?')
        .bind(revised)
        .first()
    ).amount,
    1250050,
  );
  await page.unroute('**/api/renewals/*/quotes/*/versions');
  await shot('quote-money');
  result.checks.push('real-quote-create-and-immutable-revision-exact-minor-values');
  stage = 'won-create';
  await page.goto(origin + '/today-work');
  await page.locator('.today-task-row').first().click();
  await button('İletişim kaydı ekle').waitFor();
  const taskId = new URL(page.url()).searchParams.get('task');
  const task = await page.evaluate(async (id) => {
    const r = await fetch('/api/tasks/' + id + '/context?queue=WORK');
    return (await r.json()).data.items.find((t) => t.taskId === id);
  }, taskId);
  await button('Yenileme sonucu').click();
  await button('Kazanıldı — yeni poliçe oluştur').click();
  await page.getByRole('combobox', { name: /^Sigorta şirketi/ }).selectOption('demo-insurer');
  await page.getByRole('combobox', { name: /^Branş/ }).selectOption('demo-branch');
  await page.getByRole('combobox', { name: /^Ürün/ }).selectOption('demo-product');
  await page.getByRole('combobox', { name: /^Ödeme yöntemi/ }).selectOption('demo-payment');
  await page
    .getByRole('combobox', { name: /^Poliçe sorumlusu/ })
    .selectOption(task.assigneeMembershipId);
  await page.getByLabel('Yeni poliçe numarası', { exact: true }).fill('UX003-WON-' + actor);
  await page.getByLabel('Başlangıç tarihi', { exact: true }).fill(task.policyEndDate);
  const end = new Date(Date.parse(task.policyEndDate + 'T00:00:00Z') + 365 * 86400000)
    .toISOString()
    .slice(0, 10);
  await page.getByLabel('Bitiş tarihi', { exact: true }).fill(end);
  await page.getByLabel('Brüt prim', { exact: true }).fill('12.500,50');
  await button('Yeni poliçeyi gözden geçir').click();
  await page.getByText(/İncelenen yeni poliçe:.*12\.500,50 ₺/).waitFor();
  await shot('won-review');
  await page
    .getByLabel('Yeni poliçe oluşturulmasını ve kazanıldı sonucunu onaylıyorum', { exact: true })
    .check();
  let won;
  await page.route('**/api/renewals/*/close-won', async (route) => {
    assert.equal(JSON.parse(route.request().postData()).result.policy.grossPremium, '12500.50');
    const r = await route.fetch();
    assert.equal(r.status(), 201);
    won = (await r.json()).data;
    return route.fulfill({ response: r });
  });
  await button('Yeni poliçe oluştur ve kazanıldı kaydet').click();
  await page.waitForFunction(() => !document.querySelector('.today-task-row[aria-pressed="true"]'));
  assert.ok(won?.createdPolicyId);
  assert.equal(
    (
      await demo.db
        .prepare('SELECT gross_premium_minor AS amount FROM policies WHERE id=?')
        .bind(won.createdPolicyId)
        .first()
    ).amount,
    1250050,
  );
  assert.equal(won.links[0].allocatedNewPremiumMinor, 1250050);
  result.checks.push('real-WON-CREATE-reviewed-canonical-decimal-and-exact-allocation');
  assert.equal(errors, 0);
  result.runtimeErrors = errors;
  result.width = width;
  result.browser = browser.version();
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.info('UX003_EDGE_PASS', actor, width);
} catch (error) {
  if (page)
    await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify(
      {
        stage,
        message: error.message.split('\n')[0],
        stack: error.stack
          ?.split('\n')
          .filter((x) => x.trim().startsWith('at '))
          .slice(0, 3),
        result,
      },
      null,
      2,
    ),
  );
  console.error('UX003_EDGE_FAILED', stage, error.name);
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
}
