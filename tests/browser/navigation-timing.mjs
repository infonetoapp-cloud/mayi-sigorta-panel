import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { info } from 'node:console';
import process from 'node:process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { demoCertificate, serveDemo } from '../../scripts/demo/https-server.mjs';
import { URL } from 'node:url';

/* global document, performance, requestAnimationFrame */

const destinations = [
  {
    link: 'Müşteriler',
    path: '/customers',
    api: '/api/customers',
    visible: (page) =>
      page
        .getByRole('table', { name: /Müşteri listesi/ })
        .or(page.getByRole('heading', { name: 'Müşteri bulunamadı' })),
  },
  {
    link: 'Poliçeler',
    path: '/policies',
    api: '/api/policies',
    visible: (page) =>
      page
        .getByRole('region', { name: 'Poliçe listesi' })
        .or(page.getByRole('heading', { name: 'Poliçe bulunamadı' })),
  },
  {
    link: 'Bugünkü İşler',
    path: '/today-work',
    api: '/api/tasks/today',
    visible: (page) => page.getByText('Geciken takipler', { exact: false }).first(),
  },
];
const passwords = Array.from({ length: 3 }, () => randomBytes(24).toString('hex'));
await mkdir('node_modules/.cache', { recursive: true });
const directory = await mkdtemp(resolve('node_modules/.cache/navigation-timing-'));
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
  });
  const app = await import(pathToFileURL(bundle).href);
  demo = await app.openDemo(passwords);
  tls = await demoCertificate();
  server = await serveDemo(demo, tls);
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  await page.goto('https://localhost:8443/');
  await page.getByLabel('E-posta', { exact: true }).fill(app.DEMO_USERS[0].email);
  await page.getByLabel('Şifre', { exact: true }).fill(passwords[0]);
  await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const results = [];
  for (const target of destinations) {
    const samples = [];
    for (let i = 0; i < 6; i++) {
      await nav.getByRole('link', { name: 'Genel Bakış', exact: true }).click();
      await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
      const priorities = page.getByRole('region', { name: 'Öncelikli takipler' });
      await priorities.waitFor();
      await priorities
        .getByText('Takipler yükleniyor…', { exact: true })
        .waitFor({ state: 'hidden' });
      const api = page.waitForResponse(
        (response) => new URL(response.url()).pathname === target.api,
      );
      await page.evaluate(() => {
        performance.clearMarks('crm-navigation-start');
        document.addEventListener('click', () => performance.mark('crm-navigation-start'), {
          capture: true,
          once: true,
        });
      });
      await nav.getByRole('link', { name: target.link, exact: true }).click();
      const response = await api;
      assert.equal(response.status(), 200);
      await target.visible(page).waitFor();
      const usable = await page.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const start = performance.getEntriesByName('crm-navigation-start').at(-1);
                done(start ? Math.round(performance.now() - start.startTime) : null);
              }),
            ),
          ),
      );
      assert.equal(typeof usable, 'number');
      await response.finished();
      const apiMs = Math.round(response.request().timing().responseEnd);
      samples.push({ usableMs: usable, apiMs });
    }
    const repeated = samples
      .slice(1)
      .map((sample) => sample.usableMs)
      .sort((a, b) => a - b);
    results.push({
      path: target.path,
      first: samples[0],
      repeatMedianMs: repeated[2],
      repeatMaxMs: repeated.at(-1),
      samples,
    });
  }
  info(JSON.stringify({ scope: 'EDGE_LOCAL_SYNTHETIC', results }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
  await demo?.dispose();
  await tls?.dispose();
  await rm(directory, { recursive: true, force: true });
}
