import assert from 'node:assert/strict';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { demoCertificate, serveDemo } from '../../scripts/demo/https-server.mjs';

const [phase, output, axePath, mode] = process.argv.slice(2);
if (!['before', 'after'].includes(phase) || !output) {
  throw new Error(
    'Kullanım: node tests/browser/ui-modernization.audit.mjs before|after çıktı [axe.js]',
  );
}

const origin = 'https://localhost:8443';
const widths = [1920, 1600, 1440, 1366, 1280, 1024, 768, 390, 320];
const pages = [
  ['overview', '/'],
  ['today-work', '/today-work'],
  ['customers', '/customers'],
  ['customer-create', '/customers/new'],
  ['customer-profile', '/customers/demo-customer-0'],
  ['customer-management', '/customers/demo-customer-0/advanced'],
  ['customer-legacy', '/customers/legacy'],
  ['policies', '/policies'],
  ['policy-create', '/policies/new'],
  ['policy-detail', '/policies/demo-policy-0'],
  ['policy-edit', '/policies/demo-policy-0/edit'],
  ['policy-legacy', '/policies/legacy'],
  ['renewals', '/renewals'],
  ['renewal-detail', '/renewals', 'a[href^="/renewals/"]'],
  ['finance', '/finance'],
  ['claims', '/claims'],
  ['catalogs', '/catalogs'],
  ['personnel', '/personnel'],
  ['settings', '/agency-settings'],
  ['password', '/account/password'],
  ['not-found', '/olmayan-denetim-sayfasi'],
];
const passwords = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
const evidence = resolve(output, phase);
await mkdir(evidence, { recursive: true });
await mkdir('node_modules/.cache', { recursive: true });
const cache = await realpath('node_modules/.cache');
const directory = await mkdtemp(join(cache, 'ui-modernization-'));
const report = { phase, matrix: [], accessibility: [], interactions: [], errors: [], gaps: [] };
let demo, tls, server, browser;
let stage = 'bundle';

async function capture(page, role, screen) {
  await page.evaluate(() => globalThis.document.fonts.ready);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const { document: doc, innerWidth } = globalThis;
      const overflowing = [...doc.querySelectorAll('main *')]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.right > innerWidth + 1 &&
            !element.parentElement?.closest('[role="region"], .personnel-table')
          );
        })
        .slice(0, 6)
        .map(
          (element) =>
            element.tagName.toLowerCase() +
            (element.classList[0] ? '.' + element.classList[0] : ''),
        );
      const workRow = doc.querySelector('.work-queue-table tbody tr');
      const workGroup = workRow?.closest('.work-group');
      return {
        overflow: Math.max(0, doc.documentElement.scrollWidth - innerWidth),
        overflowing,
        ...(workRow && workGroup
          ? {
              workRowWidth: Math.round(workRow.getBoundingClientRect().width),
              workGroupWidth: Math.round(workGroup.getBoundingClientRect().width),
            }
          : {}),
      };
    });
    report.matrix.push({ role, screen, width, ...layout });
    if ([1440, 390].includes(width) && (role === 'OWNER' || screen === 'overview')) {
      await page.screenshot({
        path: join(evidence, `${role}-${screen}-${width}.png`),
        animations: 'disabled',
      });
    }
    if (axePath && [1440, 390].includes(width)) {
      const violations = await page.evaluate(async () => {
        const result = await globalThis.axe.run({
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
        });
        return result.violations.map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map(({ target }) => target),
        }));
      });
      report.accessibility.push({ role, screen, width, violations });
    }
  }
}

async function verifyShell(page, role) {
  stage = `${role}-desktop-shell`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  const titleTop = await page
    .locator('main h1')
    .evaluate((heading) => heading.getBoundingClientRect().top);
  const headerBottom = await page
    .locator('.app-header')
    .evaluate((header) => header.getBoundingClientRect().bottom);
  const desktopMobileControls = await page.locator('.mobile-only:visible').count();
  if (phase === 'after') {
    assert.ok(titleTop >= headerBottom, 'Page title should be below the sticky header');
    assert.equal(desktopMobileControls, 0, 'Desktop should hide mobile drawer controls');
    await page.waitForFunction(() => {
      const logo = globalThis.document.querySelector('.sidebar-brand-wordmark');
      return logo?.naturalWidth > 0;
    });
  }
  const account = page.getByRole('button', { name: 'Hesap menüsü', exact: true });
  await account.click();
  await page.locator('.account-menu-trigger[aria-expanded="true"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.account-menu-trigger[aria-expanded="false"]').waitFor();
  assert.equal(await account.getAttribute('aria-expanded'), 'false');
  assert.equal(
    await account.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  stage = `${role}-mobile-drawer`;
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page
    .locator('.app-header')
    .getByRole('button', { name: 'Menüyü aç', exact: true });
  await toggle.click();
  await page.getByRole('region', { name: 'Hesap işlemleri' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(
    await toggle.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  report.interactions.push({
    role,
    screen: 'shell',
    titleTop,
    headerBottom,
    desktopMobileControls,
    accountEscape: true,
    drawerEscape: true,
  });
}

async function verifyOwnerWorkflow(page, role) {
  stage = 'customer-required-field';
  await page.goto(origin + '/customers/new');
  const firstName = page.getByLabel('Ad', { exact: true });
  await firstName.fill('Denetim');
  await page.getByLabel('Soyad', { exact: true }).fill('Sentetik');
  const save = page.getByRole('button', { name: 'Müşteriyi kaydet', exact: true });
  const customerNumber = page.getByLabel('Şirket müşteri no (zorunlu)', { exact: true });
  await page.getByLabel('Sigorta şirketi (zorunlu)', { exact: true }).selectOption('demo-insurer');
  await save.click();
  assert.equal(
    await customerNumber.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  stage = 'customer-draft-dialog';
  await page.getByRole('link', { name: 'Müşteri listesine dön', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'Kaydedilmemiş müşteri bilgileri var' });
  await draft.waitFor();
  await page.keyboard.press('Escape');
  await draft.waitFor({ state: 'hidden' });
  assert.equal(await firstName.inputValue(), 'Denetim');
  stage = 'customer-save';
  await customerNumber.fill('000421');
  await save.click();
  await page.getByRole('heading', { name: 'Denetim Sentetik', exact: true }).waitFor();
  stage = 'sales-create';
  const newCase = page.getByRole('button', { name: 'Yeni teklif çalışması', exact: true });
  await page.getByRole('link', { name: 'Teklif çalışmaları', exact: true }).click();
  await newCase.click();
  await page.getByLabel('Branş (zorunlu)', { exact: true }).selectOption('demo-branch');
  await page
    .getByLabel('Takip zamanı · İstanbul (zorunlu)', { exact: true })
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Çalışmayı ve takibi kaydet', exact: true }).click();
  await page.getByRole('link', { name: 'Çalışmayı aç', exact: true }).click();
  await page.getByRole('heading', { name: 'Teklif çalışması', exact: true }).waitFor();
  if (mode !== 'interactions') await capture(page, role, 'sales-case');
  report.interactions.push({
    role,
    screen: 'customer-and-sales',
    invalidFieldFocus: true,
    retainedDraft: true,
    createdCustomer: true,
    createdSalesFollowup: true,
  });
}

async function verifyCatalogDialog(page, role) {
  stage = 'catalog-native-dialog';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/catalogs');
  const trigger = page.getByRole('button', { name: '+ Yeni Ekle', exact: true });
  await trigger.click();
  const dialog = page.locator('dialog.catalog-dialog:modal');
  await dialog.waitFor();
  const focusWithin = await dialog.evaluate((element) =>
    element.contains(globalThis.document.activeElement),
  );
  assert.ok(focusWithin);
  await page.screenshot({ path: join(evidence, 'OWNER-catalog-dialog-390.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    await trigger.evaluate((element) => element === globalThis.document.activeElement),
    true,
  );
  report.interactions.push({
    role,
    screen: 'catalog-dialog',
    focusWithin,
    escapeRestoredFocus: true,
  });
}

async function verifyPolicyWorkflow(page, role) {
  stage = 'policy-create';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/customers/demo-customer-0');
  await page.getByRole('link', { name: 'Poliçe ekle', exact: true }).click();
  for (const [label, value] of [
    ['Sigorta şirketi', 'demo-insurer'],
    ['Branş', 'demo-branch'],
    ['Ürün', 'demo-product'],
    ['Ödeme yöntemi', 'demo-payment'],
  ]) {
    await page.getByLabel(label, { exact: true }).selectOption(value);
  }
  const number = 'QA-UI-POLICE';
  await page.getByLabel('Poliçe numarası', { exact: true }).fill(number);
  await page.getByLabel('Başlangıç tarihi', { exact: true }).fill('2027-01-01');
  await page.getByLabel('Bitiş tarihi', { exact: true }).fill('2027-12-31');
  await page.getByLabel('Brüt prim', { exact: true }).fill('1500.50');
  await page.getByRole('button', { name: 'Poliçeyi oluştur', exact: true }).click();
  const policy = page.getByRole('heading', { name: number, exact: true });
  await policy.waitFor();
  stage = 'policy-edit';
  await page.getByRole('link', { name: 'Poliçeyi düzenle', exact: true }).click();
  await page.getByLabel('Brüt prim', { exact: true }).fill('1750.50');
  await page.getByRole('button', { name: 'Değişiklikleri kaydet', exact: true }).click();
  await policy.waitFor();
  await page
    .getByText(/1[.]750,50/)
    .first()
    .waitFor();
  await page.goto(origin + '/policies');
  await page.getByLabel('Poliçe numarası', { exact: true }).fill(number);
  await page.getByRole('button', { name: 'Filtrele', exact: true }).click();
  await page.getByRole('link', { name: number, exact: true }).waitFor();
  report.interactions.push({
    role,
    screen: 'policy-workflow',
    createdPolicy: true,
    updatedPolicy: true,
    exactFilter: true,
  });
}

async function verifyMemberPermission(page, role) {
  stage = 'member-personnel-denial';
  await page.goto(origin + '/personnel');
  await page.getByRole('heading', { name: 'Bu sayfaya erişiminiz yok', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Personel oluştur', exact: true }).count(),
    0,
  );
  report.interactions.push({ role, screen: 'personnel-denial', directRouteDenied: true });
}

try {
  const bundle = join(directory, 'application.mjs');
  await build({
    entryPoints: ['scripts/demo/application.ts'],
    outfile: bundle,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  const application = await import(pathToFileURL(bundle).href);
  stage = 'demo-d1';
  demo = await application.openDemo(passwords);
  stage = 'local-https';
  tls = await demoCertificate();
  server = await serveDemo(demo, tls);
  stage = 'edge';
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const [index, user] of application.DEMO_USERS.slice(0, 2).entries()) {
    const role = user.type;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    if (axePath) await context.addInitScript({ path: axePath });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let screen = 'login';
    page.on('pageerror', () => report.errors.push({ role, screen, type: 'runtime' }));
    page.on('response', (response) => {
      if (response.status() >= 500)
        report.errors.push({ role, screen, type: 'http', status: response.status() });
    });
    stage = `${role}-login`;
    await page.goto(origin);
    const login = page.getByRole('button', { name: 'Giriş Yap', exact: true });
    await login.waitFor();
    if (index === 0 && mode !== 'interactions') await capture(page, role, screen);
    await page.getByLabel('E-posta', { exact: true }).fill(user.email);
    await page.getByLabel('Şifre', { exact: true }).fill(passwords[index]);
    await login.click();
    await page.getByRole('heading', { name: 'Genel Bakış' }).waitFor();
    for (const [name, route, detail] of mode === 'interactions' ? [] : pages) {
      screen = name;
      stage = `${role}-${screen}`;
      try {
        await page.goto(origin + route);
        await page.locator('.app-main :is(h1, [role="alert"])').first().waitFor();
        await page
          .locator('main')
          .getByText(/yükleniyor[.…]*$/i)
          .first()
          .waitFor({ state: 'hidden', timeout: 5000 });
        if (detail) {
          await page.locator(detail).first().click();
          await page.waitForURL('**/renewals/*');
          await page
            .locator('main')
            .getByText(/yükleniyor[.…]*$/i)
            .first()
            .waitFor({ state: 'hidden', timeout: 5000 });
        }
        await capture(page, role, screen);
      } catch (error) {
        report.gaps.push({
          role,
          screen,
          type: error.name,
          applicationHeading: await page.locator('.app-main h1').count(),
        });
      }
    }
    stage = `${role}-shell-behavior`;
    try {
      await verifyShell(page, role);
    } catch (error) {
      report.gaps.push({ stage, type: error.name, description: error.message.split('\n')[0] });
      process.exitCode = 1;
    }
    if (index === 0) {
      stage = 'owner-synthetic-flow';
      try {
        await verifyOwnerWorkflow(page, role);
      } catch (error) {
        report.gaps.push({ stage, type: error.name, description: error.message.split('\n')[0] });
        process.exitCode = 1;
      }
      try {
        if (phase === 'after') await verifyCatalogDialog(page, role);
      } catch (error) {
        report.gaps.push({ stage, type: error.name, description: error.message.split('\n')[0] });
        process.exitCode = 1;
      }
    }
    if (mode === 'interactions') {
      try {
        if (index === 0) await verifyPolicyWorkflow(page, role);
        else await verifyMemberPermission(page, role);
      } catch (error) {
        report.gaps.push({ stage, type: error.name, description: error.message.split('\n')[0] });
        process.exitCode = 1;
      }
    }
    await context.close();
  }
} catch (error) {
  report.gaps.push({ stage, type: error.name, code: error.code ?? null });
  process.exitCode = 1;
} finally {
  passwords.fill('');
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
  if (dirname(directory) === cache) await rm(directory, { recursive: true, force: true });
  await writeFile(join(evidence, 'matrix.json'), JSON.stringify(report, null, 2));
  const overflow = report.matrix.filter((entry) => entry.overflow > 1);
  if (
    phase === 'after' &&
    (overflow.length ||
      report.errors.length ||
      report.gaps.length ||
      report.accessibility.some((entry) => entry.violations.length))
  ) {
    process.exitCode = 1;
  }
  console.info(
    JSON.stringify({
      checks: report.matrix.length,
      axe: report.accessibility.length,
      interactions: report.interactions,
      overflow,
      errors: report.errors,
      gaps: report.gaps,
    }),
  );
}
