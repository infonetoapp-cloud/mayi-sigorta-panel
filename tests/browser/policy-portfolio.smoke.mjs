// Local-only real CRM/auth/D1 portfolio walkthrough. No Cloudflare or existing preview ports.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
const { URL, Request, Response } = globalThis;
import { createServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { demoCertificate } from '../../scripts/demo/https-server.mjs';
let browser,
  demo,
  tls,
  server,
  directory,
  stage = 'setup';
const results = [];
try {
  await mkdir('node_modules/.cache', { recursive: true });
  await mkdir('portfolio-evidence', { recursive: true });
  directory = await mkdtemp(resolve('node_modules/.cache/portfolio-browser-'));
  tls = await demoCertificate();
  let serve;
  server = createServer(tls, (req, res) => {
    void serve(req, res);
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const origin = `https://localhost:${server.address().port}`;
  const bundle = join(directory, 'application.mjs');
  await build({
    entryPoints: ['scripts/demo/application.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-loopback-origin',
        setup(builder) {
          builder.onLoad({ filter: /scripts[\\/]demo[\\/]application\.ts$/ }, async (args) => {
            const text = await readFile(args.path, 'utf8');
            assert(text.includes("export const DEMO_ORIGIN = 'https://localhost:8443';"));
            return {
              contents: text.replace(
                "export const DEMO_ORIGIN = 'https://localhost:8443';",
                `export const DEMO_ORIGIN = '${origin}';`,
              ),
              loader: 'ts',
            };
          });
        },
      },
    ],
  });
  const app = await import(pathToFileURL(bundle).href);
  const passwords = app.DEMO_USERS.map(() => randomBytes(24).toString('hex'));
  demo = await app.openDemo(passwords);
  const assetRoot = resolve('dist/client');
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
  };
  const assets = async (request) => {
    const url = new URL(request.url);
    const file = resolve(assetRoot, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(assetRoot + sep)) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: {
          'content-type': mime[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
  serve = async (req, res) => {
    try {
      assert.equal(req.headers.host, new URL(origin).host);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        assert(bytes <= 65536);
        chunks.push(chunk);
      }
      const request = new Request(origin + req.url, {
        method: req.method,
        headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await demo.fetch(request, assets);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end('LOCAL_HARNESS_ERROR');
    }
  };
  // More than one bounded list page; these are only synthetic local fixtures.
  await demo.db.batch(
    Array.from({ length: 24 }, (_, i) =>
      demo.db
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'demo-agency','demo-customer-0','demo-insurer','demo-product','demo-branch','demo-payment','demo-member-owner',?,?,'2026-01-01','2027-12-31',1250050,'TRY')",
        )
        .bind(`portfolio-${i}`, `PORTFOLIO-${i}`, `PORTFOLIO${i}`),
    ),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  for (const [index, user] of app.DEMO_USERS.entries())
    for (const width of [1440, 768, 360]) {
      stage = `actor-${index}-width-${width}`;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 1000 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const failures = [];
      const calls = [];
      page.on('pageerror', () => failures.push('runtime'));
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /Content Security Policy|Refused to/i.test(message.text())
        )
          failures.push('csp');
      });
      page.on('request', (request) => {
        const u = new URL(request.url());
        if (u.pathname.startsWith('/api/policies')) calls.push(u.pathname + u.search);
      });
      const login = await context.request.post(origin + '/api/auth/login', {
        headers: { origin },
        data: { email: user.email, password: passwords[index] },
      });
      assert.equal(login.status(), 200, 'REAL_SYNTHETIC_LOGIN');
      await page.goto(origin + '/policies');
      await page.getByRole('link', { name: 'PORTFOLIO-0', exact: true }).waitFor();
      const rows = page.locator('table tbody tr');
      assert.equal(await rows.count(), 20);
      await page.getByLabel('Sigortacı', { exact: true }).selectOption('demo-insurer');
      await page.getByRole('button', { name: 'Filtrele', exact: true }).click();
      await page.waitForURL('**/policies?**insurerId=demo-insurer**');
      await page.getByRole('link', { name: 'PORTFOLIO-0', exact: true }).waitFor();
      assert((await rows.first().textContent()).includes('Anadolu Sigorta'));
      assert((await rows.first().textContent()).includes('Kasko'));
      assert.equal(calls.filter((u) => u.startsWith('/api/policies/')).length, 0);
      const oldFirst = await page.locator('table tbody tr a').first().textContent();
      const nextRead = page.waitForResponse(
        (r) => r.url().includes('/api/policies?') && r.url().includes('cursor='),
      );
      await page.getByRole('button', { name: 'Sonraki sayfa', exact: true }).click();
      await nextRead;
      await page.waitForURL('**cursor=**');
      await page.getByRole('link', { name: oldFirst, exact: true }).waitFor({ state: 'detached' });
      await page.locator('table tbody tr a').first().waitFor();
      const saved = page.url();
      const selected = await page.locator('table tbody tr a').first().textContent();
      await page.locator('table tbody tr a').first().click();
      await page.getByRole('link', { name: '← Poliçe listesine dön', exact: true }).click();
      await page.waitForURL(saved);
      await page.getByRole('link', { name: selected, exact: true }).waitFor();
      const geometry = await page.evaluate(() => ({
        overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth + 1,
        display: globalThis.getComputedStyle(globalThis.document.querySelector('table tbody'))
          .display,
        labelsVisible: [...globalThis.document.querySelectorAll('.portfolio-labels')].every(
          (e) => e.getBoundingClientRect().width > 0,
        ),
      }));
      assert.equal(geometry.overflow, false, 'HORIZONTAL_OVERFLOW');
      assert(geometry.labelsVisible);
      assert.equal(geometry.display, width <= 1000 ? 'block' : 'table-row-group');
      assert.deepEqual(failures, []);
      await page.screenshot({ path: `portfolio-evidence/actor-${index}-${width}.png` });
      await page.getByRole('button', { name: '7 gün', exact: true }).click();
      await page.waitForURL('**endFrom=**');
      assert.equal(new URL(page.url()).searchParams.has('cursor'), false);
      assert.equal(new URL(page.url()).searchParams.get('insurerId'), 'demo-insurer');
      results.push({
        actor: user.type,
        width,
        realLogin: true,
        boundedPagination: true,
        labels: true,
        exactReturn: true,
        dateShortcut: true,
        ...geometry,
        runtimeOrCspErrors: failures.length,
      });
      await context.close();
    }
  await writeFile(
    'portfolio-evidence/browser-results.json',
    JSON.stringify({ mode: 'LOCAL_SYNTHETIC_REAL_APP_ONLY', remoteCalls: 0, results }, null, 2),
  );
  console.info(JSON.stringify({ status: 'PASS', cells: results.length }));
} catch (error) {
  console.error(
    'PORTFOLIO_WALKTHROUGH_FAIL',
    stage,
    error instanceof Error ? error.message : 'unknown',
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await demo?.dispose();
  await tls?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
}
