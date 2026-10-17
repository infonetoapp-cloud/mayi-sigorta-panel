import { createServer } from 'node:https';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
const { Request, Response, Headers } = globalThis;

export async function demoCertificate() {
  const directory = await mkdtemp(join(tmpdir(), 'mayi-demo-tls-'));
  const key = join(directory, 'localhost.key'),
    cert = join(directory, 'localhost.pem');
  const candidates = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe'];
  try {
    let success = false;
    for (const command of candidates) {
      const result = spawnSync(
        command,
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: 'ignore', timeout: 15000 },
      );
      if (result.status === 0) {
        success = true;
        break;
      }
    }
    if (!success)
      throw new Error(
        'OpenSSL bulunamadı. Git for Windows kurun; demo TLS sertifikası oluşturulamadı.',
      );
    return {
      key: await readFile(key),
      cert: await readFile(cert),
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** HTTPS loopback adapter only; the real Worker owns all auth, CSRF and APIs. */
export async function serveDemo(demo, tls) {
  const root = resolve('dist/client');
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  const assets = async (request) => {
    const url = new URL(request.url);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    const file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) return new Response(null, { status: 404 });
    try {
      const bytes = await readFile(file);
      const extension = file.slice(file.lastIndexOf('.'));
      return new Response(bytes, {
        headers: { 'content-type': mime[extension] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
  const server = createServer(tls, async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== 'localhost:8443') {
        outgoing.writeHead(403);
        outgoing.end();
        return;
      }
      const parts = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 65536) {
          outgoing.writeHead(413);
          outgoing.end();
          return;
        }
        parts.push(chunk);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      // Never log URLs, request bodies, headers, credential input or raw errors.
      const request = new Request('https://localhost:8443' + incoming.url, {
        method: incoming.method,
        headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(parts) }),
      });
      const response = await demo.fetch(request, assets);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('Yerel demo isteği tamamlanamadı.');
    }
  });
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(8443, '127.0.0.1', yes);
  });
  return {
    close: () => new Promise((yes, no) => server.close((error) => (error ? no(error) : yes()))),
  };
}
