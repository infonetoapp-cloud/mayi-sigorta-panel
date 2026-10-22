// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import https from 'node:https';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeHttpsUpload } from '../scripts/recovery/node-https-upload';

afterEach(() => vi.restoreAllMocks());
it('sends exact UTF8 bytes once with no auth, content type, redirect or TLS bypass', async () => {
  let calls = 0;
  const body = "Türkçe sentetik\n'not';";
  const server = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.equals(Buffer.from(body))).toBe(true);
    expect(req.method).toBe('PUT');
    expect(req.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['content-type']).toBeUndefined();
    res.setHeader('etag', `"${createHash('md5').update(bytes).digest('hex')}"`);
    res.end('');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('LOCAL_ADDRESS_REQUIRED');
  const http = await import('node:http');
  vi.spyOn(https, 'request').mockImplementation(((
    url: URL,
    options: https.RequestOptions,
    callback: Parameters<typeof https.request>[2],
  ) => {
    expect(url.href).toBe('https://synthetic.r2.cloudflarestorage.com/owned?signature=synthetic');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent).toBe(false);
    return http.request(`http://127.0.0.1:${address.port}/`, options, callback!);
  }) as typeof https.request);
  try {
    const response = await nodeHttpsUpload(
      'https://synthetic.r2.cloudflarestorage.com/owned?signature=synthetic',
      body,
      new AbortController().signal,
      () => {},
    );
    expect(response).toMatchObject({
      status: 200,
      body: '',
      etag: `"${createHash('md5').update(body).digest('hex')}"`,
    });
    expect(calls).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(['redirect', 'largeBody', 'cutBody', 'abort'])(
  'does not retry or follow a %s response',
  async (fault) => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      if (fault === 'redirect') {
        res.writeHead(307, { location: 'https://evil.example/' });
        res.end();
      } else if (fault === 'largeBody') res.end(Buffer.alloc(2 * 1024 * 1024 + 1));
      else if (fault === 'cutBody') {
        res.writeHead(200, { 'content-length': '500' });
        res.flushHeaders();
        res.write('partial');
        setImmediate(() => res.destroy());
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('LOCAL_ADDRESS_REQUIRED');
    const http = await import('node:http');
    vi.spyOn(https, 'request').mockImplementation(((
      _url: URL,
      options: https.RequestOptions,
      callback: Parameters<typeof https.request>[2],
    ) =>
      http.request(
        `http://127.0.0.1:${address.port}/`,
        options,
        callback!,
      )) as typeof https.request);
    const controller = new AbortController();
    try {
      const result = nodeHttpsUpload(
        'https://synthetic.r2.cloudflarestorage.com/owned',
        'synthetic',
        controller.signal,
        () => {},
      );
      if (fault === 'abort') {
        await once(server, 'request');
        controller.abort();
      }
      if (fault === 'redirect') expect((await result).status).toBe(307);
      else if (fault === 'largeBody')
        await expect(result).rejects.toThrow('PROVIDER_RESPONSE_LIMIT');
      else await expect(result).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('rejects an untrusted TLS certificate using the real native HTTPS client', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-https-cert-'));
  const cert = join(directory, 'cert.pem'),
    key = join(directory, 'key.pem');
  const generated = spawnSync(
    'openssl',
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
  expect(generated.status).toBe(0);
  let calls = 0;
  const server = https.createServer(
    { cert: readFileSync(cert), key: readFileSync(key) },
    (_req, res) => {
      calls++;
      res.end();
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('LOCAL_ADDRESS_REQUIRED');
  try {
    await expect(
      nodeHttpsUpload(
        `https://127.0.0.1:${address.port}/`,
        'synthetic',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(calls).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true });
  }
}, 30000);
