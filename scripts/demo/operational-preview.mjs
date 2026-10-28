// Synthetic loopback preview; no production bindings, persisted passwords or remote calls.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { createServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { demoCertificate } from './https-server.mjs';
const { URL, Request, Response } = globalThis;
export async function openOperationalPreview({ instrumentDatabase, nativeRuntime } = {}) {
  let server, demo, tls, directory;
  async function close() {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await demo?.dispose();
    await tls?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  try {
    await mkdir('node_modules/.cache', { recursive: true });
    directory = await mkdtemp(resolve('node_modules/.cache/dashboard-preview-'));
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
    demo = await app.openDemo(passwords, instrumentDatabase, nativeRuntime);
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

    return { origin, users: app.DEMO_USERS, passwords, demo, close };
  } catch (error) {
    await close();
    throw error;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let preview, browser;
  try {
    preview = await openOperationalPreview();
    browser = await chromium.launch({
      headless: false,
      ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    const login = await context.request.post(preview.origin + '/api/auth/login', {
      headers: { origin: preview.origin },
      data: { email: preview.users[0].email, password: preview.passwords[0] },
    });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    await page.goto(preview.origin + '/');
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    console.info(
      'OPERATIONAL_PREVIEW_READY ' +
        preview.origin +
        ' | dashboard: / | portfolio: /policies | OWNER synthetic session open in Edge',
    );
    await new Promise((resolve) => {
      browser.once('disconnected', resolve);
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } catch (error) {
    console.error('OPERATIONAL_PREVIEW_FAILED', error instanceof Error ? error.message : 'unknown');
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await preview?.close();
  }
}
