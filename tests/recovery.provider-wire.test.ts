// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stdin, stdout } from 'node:process';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { providerPlan, runProviderRecovery } from '../scripts/recovery/provider-runner';
import { CloudflareD1Provider } from '../scripts/recovery/cloudflare-d1-provider';
import { retainSyntheticBundle } from '../scripts/recovery/executor-bundle';
import * as nativeUpload from '../scripts/recovery/node-https-upload';
import {
  confirmLiveProvider,
  liveProviderWire,
  validateProviderUrl,
} from '../scripts/recovery/provider-wire';
const consent = vi.hoisted(() => ({ answer: 'SYNTHETIC_TEST_CONSENT' }));
const nativeFetch = globalThis.fetch;
it('classifies a real loopback TLS rejection and curl also refuses the untrusted certificate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-local-tls-'));
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
  const server = createTlsServer(
    { cert: readFileSync(cert), key: readFileSync(key) },
    (_req, res) => res.end('synthetic'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('LOOPBACK_REQUIRED');
    const url = `https://127.0.0.1:${address.port}/`;
    vi.mocked(fetch).mockImplementation((_url, init) => nativeFetch(url, init));
    const wire = await client();
    const error = await wire
      .request({
        url: 'https://synthetic.r2.cloudflarestorage.com/owned',
        method: 'PUT',
        body: 'synthetic connectivity only',
        upload: true,
        readOnly: false,
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      diagnostic: {
        faultClass: 'TLS',
        systemCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        outcome: 'UNKNOWN',
      },
    });
    const curlCode = await new Promise<number | null>((resolve) => {
      const child = spawn(
        'curl.exe',
        ['--silent', '--noproxy', '*', '--max-time', '5', '--output', 'NUL', url],
        { stdio: 'ignore' },
      );
      child.on('close', resolve);
    });
    expect(curlCode).toBe(60);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30000);
it.each([
  ['ERR_INVALID_ARG_TYPE', 'CONSTRUCTION'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS'],
  ['ENOTFOUND', 'DNS'],
])('retains sanitized nested failure class %s without raw messages', async (code, faultClass) => {
  const nested = Object.assign(new Error('https://private/path?signature=secret SQL'), { code });
  vi.mocked(fetch).mockRejectedValueOnce(
    new TypeError('fetch failed private', { cause: new AggregateError([nested], 'secret') }),
  );
  const wire = await client();
  const error = await wire
    .request({
      url: 'https://synthetic.r2.cloudflarestorage.com/owned',
      method: 'PUT',
      body: 'secret SQL',
      upload: true,
      readOnly: false,
    })
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ diagnostic: { systemCode: code, faultClass, outcome: 'UNKNOWN' } });
  expect(JSON.stringify(error)).not.toMatch(/private|signature=|secret SQL/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: async () => consent.answer, close() {} }),
}));
const before: {
  stream: typeof stdin | typeof stdout;
  descriptor: PropertyDescriptor | undefined;
}[] = [];
beforeEach(() => {
  for (const stream of [stdin, stdout]) {
    before.push({ stream, descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY') });
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  }
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('UNEXPECTED_NETWORK_FORBIDDEN'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const { stream, descriptor } of before.splice(0)) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
});
async function client() {
  const permit = await confirmLiveProvider('synthetic-plan', 'SYNTHETIC_TEST_CONSENT');
  return liveProviderWire(permit, 'synthetic-plan', 'synthetic-not-a-real-provider-token');
}
it.each([
  { kind: 'empty', batch: [] },
  { kind: 'multiple statements', batch: [{ sql: 'SELECT 1; SELECT 2;' }] },
  { kind: 'statement limit', batch: Array.from({ length: 257 }, () => ({ sql: 'SELECT 1;' })) },
])('rejects an invalid query batch ($kind) before any provider request', async ({ batch }) => {
  const provider = new CloudflareD1Provider(await client(), () => {});
  provider.bindOwned(owned);
  await expect(provider.queryBatch(batch)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('rechecks exact ownership before a query batch mutation', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json(envelope({ ...owned, uuid: '92967c6d-8aac-4323-9b3b-6e9bcb45f016' })),
  );
  const provider = new CloudflareD1Provider(await client(), () => {});
  provider.bindOwned(owned);
  await expect(
    provider.queryBatch([{ sql: 'CREATE TABLE bounded_query_probe(id INTEGER);' }]),
  ).rejects.toThrow('TARGET_IDENTITY_MISMATCH');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0]![1]!.method).toBe('GET');
});
it('selects the independent native upload without fetch or an automatic fallback', async () => {
  const native = vi
    .spyOn(nativeUpload, 'nodeHttpsUpload')
    .mockRejectedValueOnce(Object.assign(new Error('private signed URL'), { code: 'ECONNRESET' }));
  const permit = await confirmLiveProvider('synthetic-plan', 'SYNTHETIC_TEST_CONSENT');
  const wire = liveProviderWire(
    permit,
    'synthetic-plan',
    'synthetic-not-a-real-provider-token',
    'NODE_HTTPS',
  );
  await expect(
    wire.request({
      url: 'https://synthetic.r2.cloudflarestorage.com/owned',
      method: 'PUT',
      body: 'synthetic',
      readOnly: false,
      upload: true,
    }),
  ).rejects.toMatchObject({ diagnostic: { systemCode: 'ECONNRESET', outcome: 'UNKNOWN' } });
  expect(native).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});
it('uses the actual fetch transport with redirects disabled and no Authorization on upload', async () => {
  const capture: Array<{ url: string; init: RequestInit }> = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    capture.push({ url: String(url), init: init! });
    return new Response('{}', { status: 200, headers: { etag: '"synthetic-etag"' } });
  });
  const wire = await client();
  await wire.request({
    url: 'https://api.cloudflare.com/client/v4/accounts/af9fc98cb8d5f5508d58057bc794d863',
    method: 'GET',
    readOnly: true,
  });
  await wire.request({
    url: 'https://synthetic.r2.cloudflarestorage.com/owned?signature=synthetic-only',
    method: 'PUT',
    body: 'synthetic',
    upload: true,
    readOnly: false,
  });
  expect(capture.map((r) => r.init.redirect)).toEqual(['error', 'error']);
  expect(new Headers(capture[0]!.init.headers).has('authorization')).toBe(true);
  expect(new Headers(capture[1]!.init.headers).has('authorization')).toBe(false);
  expect(capture).toHaveLength(2);
});
it('quarantines an unsettled timed-out write and never retries it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let finish: ((response: Response) => void) | undefined;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const wire = await client();
  const pending = wire
    .request({
      url: 'https://api.cloudflare.com/client/v4/accounts/af9fc98cb8d5f5508d58057bc794d863/d1/database',
      method: 'POST',
      body: '{}',
      readOnly: false,
    })
    .then(
      () => 'unexpected',
      (error) => (error as Error).message,
    );
  await vi.advanceTimersByTimeAsync(30001);
  expect(await pending).toBe('PROVIDER_RESPONSE_LOST');
  await expect(
    wire.request({
      url: 'https://api.cloudflare.com/client/v4/accounts/af9fc98cb8d5f5508d58057bc794d863',
      method: 'GET',
      readOnly: true,
    }),
  ).rejects.toThrow('PROVIDER_WRITE_SETTLEMENT_PENDING');
  expect(fetch).toHaveBeenCalledTimes(1);
  finish!(new Response('{}', { status: 200 }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await wire.request({
    url: 'https://api.cloudflare.com/client/v4/accounts/af9fc98cb8d5f5508d58057bc794d863',
    method: 'GET',
    readOnly: true,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([
  'https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000',
  'https://api.cloudflare.com/client/v4/accounts/af9fc98cb8d5f5508d58057bc794d863/d1/database/1dd3b04e-14b8-459c-86d0-5c3c3ed8127d/query',
  'https://evil.example/test',
  'http://api.cloudflare.com/client/v4/accounts/af9fc98cb8d5f5508d58057bc794d863',
])('rejects an unapproved origin/account/resource before fetch: %s', async (url) => {
  const wire = await client();
  await expect(wire.request({ url, method: 'GET', readOnly: true })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects forged/reused live capabilities and signed upload URLs to foreign hosts', async () => {
  expect(() => liveProviderWire({}, 'synthetic-plan', 'not-live')).toThrow(
    'LIVE_CAPABILITY_REQUIRED',
  );
  const permit = await confirmLiveProvider('synthetic-plan', 'SYNTHETIC_TEST_CONSENT');
  expect(() => liveProviderWire(permit, 'different-plan', 'not-live')).toThrow(
    'LIVE_CAPABILITY_REQUIRED',
  );
  liveProviderWire(permit, 'synthetic-plan', 'not-live');
  expect(() => liveProviderWire(permit, 'synthetic-plan', 'not-live')).toThrow(
    'LIVE_CAPABILITY_REQUIRED',
  );
  expect(() =>
    validateProviderUrl({
      url: 'https://evil.example/signed?secret=synthetic',
      method: 'PUT',
      readOnly: false,
      upload: true,
    }),
  ).toThrow('UPLOAD_ORIGIN_DENIED');
});
it('bounds streamed provider responses in the actual transport implementation', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  const wire = await client();
  await expect(
    wire.request({
      url: 'https://api.cloudflare.com/client/v4/accounts/af9fc98cb8d5f5508d58057bc794d863',
      method: 'GET',
      readOnly: true,
    }),
  ).rejects.toThrow('PROVIDER_RESPONSE_LOST');
});

it('preserves a safe upload transport diagnosis without exposing the failed request', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(
    new TypeError('signed-url secret SQL', {
      cause: Object.assign(new Error('token signed-url secret SQL'), { code: 'ECONNRESET' }),
    }),
  );
  const wire = await client();
  const error = await wire
    .request({
      url: 'https://synthetic.r2.cloudflarestorage.com/owned?signature=secret',
      method: 'PUT',
      body: 'secret SQL',
      upload: true,
      readOnly: false,
    })
    .catch((e: unknown) => e);
  expect(error).toMatchObject({
    diagnostic: {
      operation: 'UPLOAD',
      phase: 'REQUEST',
      category: 'NETWORK',
      systemCode: 'ECONNRESET',
      outcome: 'UNKNOWN',
    },
  });
  expect(JSON.stringify(error)).not.toMatch(/signed-url|signature=|secret SQL|token /);
  expect(fetch).toHaveBeenCalledTimes(1);
});

const owned = {
  uuid: '82967c6d-8aac-4323-9b3b-6e9bcb45f016',
  name: 'mayisigorta-ops001-restore-gatec-44c314b-03',
  jurisdiction: 'eu',
  created_at: '2026-10-21T20:23:40.915Z',
};
const envelope = (result: unknown) => ({ success: true, errors: [], result });
const absent7404 = {
  success: false,
  result: null,
  errors: [{ code: 7404, message: 'D1 resource missing' }],
};
it('verifies owned deletion using exact 404/7404 and complete inventory, not message grammar', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json(envelope(owned)))
    .mockResolvedValueOnce(Response.json(envelope(null)))
    .mockResolvedValueOnce(Response.json(absent7404, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({
        ...envelope([]),
        result_info: { page: 1, per_page: 100, count: 0, total_count: 0 },
      }),
    );
  const provider = new CloudflareD1Provider(await client(), () => {});
  provider.bindOwned(owned);
  await provider.deleteOwned();
  await expect(provider.verifyAbsent()).resolves.toMatchObject({
    state: 'VERIFIED_ABSENT',
    uuid: owned.uuid,
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('uploads exact UTF8 bytes over real loopback HTTP without synthesized text content type', async () => {
  const sql = "-- sentetik Türkçe\r\nSELECT 'İğüş 😀';\n";
  const bytes = Buffer.from(sql, 'utf8');
  const etag = createHash('md5').update(bytes).digest('hex');
  let received = Buffer.alloc(0),
    receivedType: string | undefined;
  let sentBody: unknown;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    receivedType = req.headers['content-type'];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received = Buffer.concat(chunks);
      res.writeHead(200, { etag: `"${etag}"` });
      res.end('not a JSON response');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('LOOPBACK_ADDRESS_REQUIRED');
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      sentBody = init?.body;
      return nativeFetch(`http://127.0.0.1:${address.port}/synthetic`, init);
    });
    const provider = new CloudflareD1Provider(await client(), () => {});
    await provider.upload(
      'https://synthetic.r2.cloudflarestorage.com/owned?signature=synthetic',
      sql,
    );
    expect(received.equals(bytes)).toBe(true);
    expect(sentBody).toBeInstanceOf(Uint8Array);
    expect(receivedType).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  undefined,
  '"00000000000000000000000000000000"',
  'W/"5e83de5fd61a1f6e57f01f2fc0a4fc61"',
  '"' + createHash('md5').update('SELECT 1;').digest('hex'),
])('rejects missing, wrong, weak or unbalanced upload ETag: %s', async (etag) => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('', { status: 200, headers: etag === undefined ? {} : { etag } }),
  );
  const provider = new CloudflareD1Provider(await client(), () => {});
  await expect(
    provider.upload('https://synthetic.r2.cloudflarestorage.com/owned', 'SELECT 1;'),
  ).rejects.toThrow('UPLOAD_ETAG_MISMATCH');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('classifies a truncated upload response body as UNKNOWN after headers, without replay', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.error(Object.assign(Error('sensitive SQL'), { code: 'UND_ERR_SOCKET' }));
    },
  });
  vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }));
  const wire = await client();
  const error = await wire
    .request({
      url: 'https://synthetic.r2.cloudflarestorage.com/owned?signature=secret',
      method: 'PUT',
      body: 'SELECT 1;',
      upload: true,
      readOnly: false,
    })
    .catch((e: unknown) => e);
  expect(error).toMatchObject({
    diagnostic: {
      phase: 'RESPONSE_BODY',
      category: 'BODY_STREAM',
      httpStatus: 200,
      outcome: 'UNKNOWN',
      systemCode: 'UND_ERR_SOCKET',
    },
  });
  expect(JSON.stringify(error)).not.toMatch(/sensitive SQL|signature=/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([undefined, { total_count: 1 }, { page: 1, per_page: 100, count: 0, total_count: 1 }])(
  'never proves cleanup using incomplete inventory %j',
  async (result_info) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(envelope(owned)))
      .mockResolvedValueOnce(Response.json(envelope(null)))
      .mockResolvedValueOnce(Response.json(absent7404, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ...envelope([]), result_info }));
    const provider = new CloudflareD1Provider(await client(), () => {});
    provider.bindOwned(owned);
    await provider.deleteOwned();
    await expect(provider.verifyAbsent()).rejects.toThrow('INVENTORY_INCOMPLETE');
  },
);

it('does not accept 7404 outside the owned-delete context', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(absent7404, { status: 404 }));
  const provider = new CloudflareD1Provider(await client(), () => {});
  provider.bindOwned(owned);
  await expect(provider.detail()).rejects.toThrow('OWNERSHIP_READBACK_FAILED');
  await expect(provider.verifyAbsent()).rejects.toThrow('DELETE_ATTEMPT_REQUIRED');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('persists only sanitized live-wire diagnostics in the actual runner journal', async () => {
  const bundleDirectory = join(mkdtempSync(join(tmpdir(), 'mayi-wire-bundle-')), 'bundle');
  const pins = await retainSyntheticBundle(bundleDirectory);
  const raw = {
    bundleDirectory,
    ...pins,
    authorityPath: join(bundleDirectory, 'current-authority.json'),
  };
  const options = {
    mode: 'EXECUTE_REMOTE',
    bundleDirectory: raw.bundleDirectory,
    manifestSha256: raw.manifestSha256,
    authorityPath: raw.authorityPath,
    authoritySha256: raw.authoritySha256,
    runId: crypto.randomUUID(),
    runDirectory: mkdtempSync(join(tmpdir(), 'mayi-repair-journal-')),
  };
  const plan = providerPlan(options);
  const now = Date.now();
  const identity = { ...owned, created_at: new Date(now).toISOString() };
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json(envelope({ id: 'af9fc98cb8d5f5508d58057bc794d863' })))
    .mockResolvedValueOnce(
      Response.json({
        ...envelope([]),
        result_info: { page: 1, per_page: 100, count: 0, total_count: 0 },
      }),
    )
    .mockResolvedValueOnce(Response.json(envelope(identity)))
    .mockResolvedValueOnce(Response.json(envelope(identity)))
    .mockResolvedValueOnce(
      Response.json(
        envelope([
          {
            success: true,
            results: [{ n: 0 }],
            meta: { rows_read: 1, rows_written: 0, size_after: 49152 },
          },
        ]),
      ),
    )
    .mockResolvedValueOnce(Response.json(envelope(identity)))
    .mockResolvedValueOnce(
      Response.json(
        envelope({
          success: true,
          filename: 'synthetic/staging.sql',
          upload_url: 'https://synthetic.r2.cloudflarestorage.com/owned?signature=synthetic-secret',
        }),
      ),
    )
    .mockRejectedValueOnce(
      new TypeError('synthetic-secret', {
        cause: Object.assign(Error('signed-url'), { code: 'ECONNRESET' }),
      }),
    );
  const permit = await confirmLiveProvider(plan.planSha256, 'SYNTHETIC_TEST_CONSENT');
  const wire = liveProviderWire(permit, plan.planSha256, 'synthetic-not-a-real-provider-token');
  const result = await runProviderRecovery(
    {
      ...options,
      approval: {
        kind: 'OWNER_OPS001_PROVIDER_V1',
        owner: 'Synthetic operator',
        planSha256: plan.planSha256,
        capacityReceiptSha256: '0'.repeat(64),
        notBefore: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 600000).toISOString(),
        allowCreate: true,
        allowImport: true,
        allowReconcile: true,
        allowOwnedCleanup: true,
        allowProviderManagedStaging: true,
        allowProduction: false,
        allowDeploy: false,
      },
    },
    wire,
  );
  expect(result).toMatchObject({
    code: 'PROVIDER_RESPONSE_LOST',
    transportFailure: {
      systemCode: 'ECONNRESET',
      operation: 'UPLOAD',
      phase: 'REQUEST',
      outcome: 'UNKNOWN',
    },
  });
  const db = new DatabaseSync(join(options.runDirectory, 'provider-journal.sqlite'), {
    readOnly: true,
  });
  try {
    const diagnostics = db.prepare('SELECT diagnostic FROM transport_failures').all();
    expect(diagnostics).toHaveLength(1);
    expect(JSON.parse(String(diagnostics[0]!.diagnostic))).toMatchObject({
      systemCode: 'ECONNRESET',
    });
    const session = JSON.parse(String(db.prepare('SELECT body FROM session').get()!.body));
    expect(session.jobs.restore).toMatchObject({
      uploadAttempted: true,
      uploaded: false,
      ingestAttempted: false,
    });
    expect(
      JSON.stringify({ diagnostics, session, events: db.prepare('SELECT * FROM events').all() }),
    ).not.toMatch(/signature=|synthetic-secret|INSERT INTO|signed-url/);
  } finally {
    db.close();
  }
  expect(fetch).toHaveBeenCalledTimes(8);
});

it.each([false, true])(
  'requires every inventory page for verified absence (missing last page=%s)',
  async (missingLastPage) => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      ...owned,
      name: `synthetic-${i}`,
      uuid: `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    const tail = { ...owned, name: 'synthetic-tail', uuid: '99999999-1111-4111-8111-111111111111' };
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(envelope(owned)))
      .mockResolvedValueOnce(Response.json(envelope(null)))
      .mockResolvedValueOnce(Response.json(absent7404, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          ...envelope(rows),
          result_info: { page: 1, count: 100, per_page: 100, total_count: 101 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...envelope(missingLastPage ? [] : [tail]),
          result_info: { page: 2, count: missingLastPage ? 0 : 1, per_page: 100, total_count: 101 },
        }),
      );
    const provider = new CloudflareD1Provider(await client(), () => {});
    provider.bindOwned(owned);
    await provider.deleteOwned();
    if (missingLastPage)
      await expect(provider.verifyAbsent()).rejects.toThrow('INVENTORY_INCOMPLETE');
    else await expect(provider.verifyAbsent()).resolves.toMatchObject({ state: 'VERIFIED_ABSENT' });
    expect(fetch).toHaveBeenCalledTimes(5);
  },
);

it.each([10000, 7500])('does not accept an unrelated 404 code after deletion: %s', async (code) => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json(envelope(owned)))
    .mockResolvedValueOnce(Response.json(envelope(null)))
    .mockResolvedValueOnce(
      Response.json(
        { ...absent7404, errors: [{ code, message: 'authentication error' }] },
        { status: 404 },
      ),
    );
  const provider = new CloudflareD1Provider(await client(), () => {});
  provider.bindOwned(owned);
  await provider.deleteOwned();
  await expect(provider.verifyAbsent()).rejects.toThrow('OWNERSHIP_READBACK_FAILED');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('distinguishes an upload timeout and retains the no-replay pending guard', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let finish: ((r: Response) => void) | undefined;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const wire = await client();
  const result = wire
    .request({
      url: 'https://synthetic.r2.cloudflarestorage.com/owned',
      method: 'PUT',
      body: 'SELECT 1;',
      upload: true,
      readOnly: false,
    })
    .catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(60001);
  expect(await result).toMatchObject({
    diagnostic: { category: 'TIMEOUT', phase: 'REQUEST', outcome: 'UNKNOWN' },
  });
  await expect(
    wire.request({
      url: 'https://synthetic.r2.cloudflarestorage.com/owned',
      method: 'PUT',
      body: 'SELECT 1;',
      upload: true,
      readOnly: false,
    }),
  ).rejects.toThrow('PROVIDER_WRITE_SETTLEMENT_PENDING');
  finish!(new Response('', { status: 200 }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fetch).toHaveBeenCalledTimes(1);
});
