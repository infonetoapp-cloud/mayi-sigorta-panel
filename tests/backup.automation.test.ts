// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  generationPrefix,
  runBackup,
  BACKUP_SOURCE,
  EXPORT_URL,
  MAX_BACKUP_SQL_BYTES,
  MAX_POLLS,
  type BackupEnv,
  type BackupSteps,
  type BackupRuntime,
} from '../src/server/d1-backup/core';
import { BACKUP_CRONS } from '../src/server/d1-backup/scheduler';
import { MAX_GZIP_SQL_BYTES, MAX_RAW_SQL_BYTES } from '../src/server/d1-backup/format';
import { validateBackupEvidence } from '../src/server/backup-monitor/evidence';
import {
  nativeExportSha256,
  prepareNativeD1Restore,
} from '../scripts/recovery/prepare-native-restore';
const timestamp = '2026-10-08T00:00:00.000Z';
const syntheticSql = 'CREATE TABLE synthetic(id TEXT PRIMARY KEY);';
it('default runtime invokes global fetch with correct receiver on export and signed download', async () => {
  const f = fixture('immediate');
  vi.stubGlobal('fetch', function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    expect(this).toBe(globalThis);
    return f.runtime.fetch(input, init);
  });
  try {
    const result = await runBackup(f.env, f.steps, timestamp, 'synthetic-default');
    expect(result.state).toBe('COMPLETE');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]!.url).toBe(EXPORT_URL);
    expect(f.requests[1]!.url).toContain('.r2.cloudflarestorage.com');
  } finally {
    vi.unstubAllGlobals();
  }
});
function fixture(failure = '') {
  const objects = new Map<
      string,
      {
        bytes: Buffer;
        text: string;
        size: number;
        etag: string;
        customMetadata: Record<string, string>;
      }
    >(),
    writes: string[] = [],
    requests: Array<{ url: string; init?: RequestInit }> = [],
    outputs: unknown[] = [];
  let poll = 0;
  const storage = {
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async get(key: string) {
      const r = objects.get(key);
      return r ? { ...r, text: async () => r.text } : null;
    },
    async put(
      key: string,
      data: unknown,
      options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string> },
    ) {
      expect(options.onlyIf.etagDoesNotMatch).toBe('*');
      if (objects.has(key)) return null;
      if (
        (failure === 'sql-write' && key.endsWith('database.sql')) ||
        (failure === 'manifest-write' && key.endsWith('manifest.json'))
      )
        throw new Error('synthetic key must not escape');
      const bytes =
        typeof data === 'string'
          ? Buffer.from(data)
          : Buffer.from(await new Response(data as BodyInit).arrayBuffer());
      const record = {
        bytes,
        text: bytes.toString('utf8'),
        size: bytes.length,
        etag: 'bc10c5406a88755ebc7446ab5c4e5b39',
        customMetadata: options.customMetadata,
      };
      objects.set(key, record);
      writes.push(key);
      return record;
    },
  } as unknown as R2Bucket;
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (
      (failure === 'export-redirect' && url === EXPORT_URL) ||
      (failure === 'download-redirect' && url !== EXPORT_URL)
    )
      return new Response('unsafe provider body', {
        status: 302,
        headers: { location: 'https://redirect.invalid/?secret=synthetic-only-not-a-real-key' },
      });
    if (url === EXPORT_URL) {
      if (failure.startsWith('http-'))
        return new Response('untrusted non-JSON provider body', {
          status: Number(failure.slice(5)),
        });
      if (failure === 'transport')
        throw new Error(
          'synthetic-only-not-a-real-key https://signed.invalid/?secret=synthetic-signed-value',
        );
      if (failure === 'export') return new Response('{}', { status: 403 });
      poll++;
      return Response.json({
        success: true,
        ...(failure === 'malformed-errors'
          ? { errors: [{ code: '1000', message: 'synthetic-secret' }] }
          : {}),
        result: {
          success: failure === 'malformed-success' ? 'false' : true,
          ...(failure !== 'immediate' && (failure === 'poll-limit' || poll === 1)
            ? {}
            : { status: 'complete' }),
          ...(failure === 'immediate'
            ? {}
            : {
                at_bookmark:
                  failure === 'changed-bookmark' && poll > 1 ? 'other' : 'synthetic-bookmark',
              }),
          result: {
            signed_url:
              'https://synthetic.eu.r2.cloudflarestorage.com/dump?secret=synthetic-signed-value',
          },
        },
      });
    }
    return new Response(failure === 'empty' ? '' : syntheticSql, {
      status: failure === 'download' ? 503 : 200,
      headers: { 'content-length': failure === 'empty' ? '0' : String(syntheticSql.length) },
    });
  }) as typeof fetch;
  // Synthetic download intentionally has exact independent byte count.
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await network(input, init);
    if (String(input) !== EXPORT_URL && r.ok && failure !== 'empty') {
      const t = await r.text();
      return new Response(t, {
        headers: { 'content-length': String(new TextEncoder().encode(t).length) },
      });
    }
    return r;
  };
  const env: BackupEnv = {
    CLOUDFLARE_EMAIL: 'synthetic@example.invalid',
    CLOUDFLARE_API_KEY: 'synthetic-only-not-a-real-key',
    RECOVERY: storage,
  };
  const steps: BackupSteps = {
    async do(_name, callback) {
      const r = await callback();
      outputs.push(r);
      return r;
    },
  };
  const runtime: BackupRuntime = {
    fetch: wrapped as typeof fetch,
    now: () => 123456,
    sleep: async () => {},
  };
  return { env, steps, runtime, objects, writes, requests, outputs };
}
it('publishes gzip metadata and restores the exact compressed export', async () => {
  const f = fixture('immediate');
  const generation = 'd1-backup-slot-1496303';
  const result = await runBackup(f.env, f.steps, timestamp, generation, f.runtime, 'gzip');
  expect(f.writes.map((key) => key.split('/').at(-1))).toEqual([
    'database.sql.gz',
    'manifest.json',
    'COMPLETE.json',
  ]);
  const [sqlKey, manifestKey, completeKey] = f.writes as [string, string, string];
  const object = f.objects.get(sqlKey)!;
  const raw = gunzipSync(object.bytes);
  expect(raw.toString()).toBe(syntheticSql);
  expect(result.rawSqlSize).toBe(raw.length);
  const manifest = JSON.parse(f.objects.get(manifestKey)!.text) as Record<string, unknown>;
  const complete = JSON.parse(f.objects.get(completeKey)!.text) as Record<string, unknown>;
  const t = Date.parse(timestamp);
  const head = (key: string, offset: number) => ({
    ...f.objects.get(key)!,
    key,
    uploaded: new Date(t + offset),
  });
  const evidence = {
    manifest,
    complete,
    sql: head(sqlKey, 1000),
    manifestHead: head(manifestKey, 2000),
    completeHead: head(completeKey, 3000),
  };
  expect(validateBackupEvidence(evidence, t + 4000).status).toBe('HEALTHY');
  const receipt = {
    format: 'mayi-recovery-source-acceptance-v1',
    expectedGeneration: generation,
    expectedSource: BACKUP_SOURCE.databaseId,
    expectedSourceName: BACKUP_SOURCE.databaseName,
    expectedSourceAccount: BACKUP_SOURCE.accountId,
    expectedObjectKey: sqlKey,
    sourceExportSha256: nativeExportSha256(object.bytes),
    manifest,
    complete,
    object: { key: sqlKey, size: object.size, etag: object.etag, ...object.customMetadata },
    sqlUploadedAt: evidence.sql.uploaded.toISOString(),
    manifestUploadedAt: evidence.manifestHead.uploaded.toISOString(),
    completeUploadedAt: evidence.completeHead.uploaded.toISOString(),
  };
  const prepared = prepareNativeD1Restore(object.bytes, receipt);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(prepared.sql);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='synthetic'").get()).toEqual({
      name: 'synthetic',
    });
  } finally {
    db.close();
  }
  const changed = Buffer.from(object.bytes);
  changed[changed.length - 1] = changed.at(-1)! ^ 1;
  expect(() => prepareNativeD1Restore(changed, receipt)).toThrow('SOURCE_IDENTITY_MISMATCH');
  expect(() =>
    prepareNativeD1Restore(object.bytes, {
      ...receipt,
      manifest: { ...manifest, rawSqlSize: 1 },
      complete: { ...complete, rawSqlSize: 1 },
      object: { ...receipt.object, rawSqlSize: '1' },
    }),
  ).toThrow('SOURCE_GZIP_INVALID');
  expect(
    validateBackupEvidence(
      {
        ...evidence,
        sql: { ...evidence.sql, customMetadata: { ...object.customMetadata, rawSqlSize: '1' } },
      },
      t + 4000,
    ).status,
  ).toBe('QUERY_OR_PROVIDER_FAILURE');
});

it.each([
  [String(MAX_RAW_SQL_BYTES + 1), 'sql-size-limit-exceeded'],
  ['90', 'invalid-length'],
])('rejects invalid gzip input length without publishing objects', async (length, expected) => {
  const f = fixture('immediate');
  const runtime: BackupRuntime = {
    ...f.runtime,
    fetch: (input, init) =>
      String(input) === EXPORT_URL
        ? f.runtime.fetch(input, init)
        : Promise.resolve(new Response('short', { headers: { 'content-length': length } })),
  };
  await expect(
    runBackup(f.env, f.steps, timestamp, 'synthetic-gzip', runtime, 'gzip'),
  ).rejects.toMatchObject({ diagnostic: { classification: expected } });
  expect(f.writes).toEqual([]);
});

it('stops before uploading a gzip artifact above the compressed object limit', async () => {
  const f = fixture('immediate');
  const data = randomBytes(MAX_GZIP_SQL_BYTES + 65536);
  const runtime: BackupRuntime = {
    ...f.runtime,
    fetch: (input, init) =>
      String(input) === EXPORT_URL
        ? f.runtime.fetch(input, init)
        : Promise.resolve(new Response(data)),
  };
  await expect(
    runBackup(f.env, f.steps, timestamp, 'synthetic-gzip', runtime, 'gzip'),
  ).rejects.toMatchObject({ diagnostic: { classification: 'gzip-size-limit-exceeded' } });
  expect(f.writes).toEqual([]);
});
it.each(['immediate', 'changed-bookmark'])('valid %s completion is not rejected', async (mode) => {
  const f = fixture(mode);
  const result = await runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime);
  expect(result.state).toBe('COMPLETE');
  if (mode === 'immediate') {
    expect(result.bookmark).toBeNull();
    expect(result.pollingCount).toBe(0);
    expect(f.requests.filter((r) => r.url === EXPORT_URL)).toHaveLength(1);
  }
});
it.each([false, true])('accepts exactly 16 MiB (length announced=%s)', async (announced) => {
  const f = fixture('immediate');
  const fetch = f.runtime.fetch;
  f.runtime.fetch = async (input, init) =>
    String(input) === EXPORT_URL
      ? fetch(input, init)
      : new Response(new Uint8Array(MAX_BACKUP_SQL_BYTES).fill(32), {
          headers: announced ? { 'content-length': String(MAX_BACKUP_SQL_BYTES) } : undefined,
        });
  await expect(
    runBackup(f.env, f.steps, timestamp, 'size-limit', f.runtime),
  ).resolves.toMatchObject({
    state: 'COMPLETE',
    sqlSize: MAX_BACKUP_SQL_BYTES,
    capacityWarning: true,
    utilizationPct: 100,
  });
  expect(f.writes.at(-1)).toMatch(/COMPLETE\.json$/u);
});
it.each([false, true])(
  'rejects an oversized SQL before any R2 write (length announced=%s)',
  async (announced) => {
    const f = fixture('immediate');
    const fetch = f.runtime.fetch;
    const cancel = vi.fn();
    f.runtime.fetch = async (input, init) => {
      if (String(input) === EXPORT_URL) return fetch(input, init);
      let chunks = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(chunks++ === 0 ? MAX_BACKUP_SQL_BYTES : 1));
          },
          cancel,
        }),
        { headers: announced ? { 'content-length': String(MAX_BACKUP_SQL_BYTES + 1) } : undefined },
      );
    };
    await expect(
      runBackup(f.env, f.steps, timestamp, 'oversized', f.runtime),
    ).rejects.toMatchObject({
      diagnostic: { stage: 'download', classification: 'sql-size-limit-exceeded' },
    });
    expect(f.writes).toEqual([]);
    if (!announced) expect(cancel).toHaveBeenCalledOnce();
  },
);
it('transport error raw secret message cannot escape', async () => {
  const f = fixture('transport');
  try {
    await runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime);
  } catch (e) {
    expect(String(e)).toContain('transport');
    expect(String(e)).not.toContain('synthetic-only');
    expect(String(e)).not.toContain('signed.invalid');
    return;
  }
  throw new Error('expected error');
});
it.each(['export-redirect', 'download-redirect'])(
  '%s fails closed without replay or URL diagnostics',
  async (mode) => {
    const f = fixture(mode);
    let caught: unknown;
    try {
      await runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime);
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toContain('unexpected-redirect');
    expect(String(caught)).toContain('302');
    expect(String(caught)).not.toContain('redirect.invalid');
    expect(String(caught)).not.toContain('synthetic-only');
    expect(String(caught)).not.toContain('synthetic-signed-value');
    expect(String(caught)).not.toContain('unsafe provider body');
    expect(f.writes).toEqual([]);
    expect(f.requests.every((r) => r.init?.redirect === 'manual')).toBe(true);
    expect(f.requests.some((r) => r.url.includes('redirect.invalid'))).toBe(false);
    if (mode === 'export-redirect') expect(f.requests).toHaveLength(1);
  },
);
it.each([401, 500])('API %i non-JSON failure stays http-error, not transport', async (status) => {
  const f = fixture('http-' + status);
  let caught: unknown;
  try {
    await runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime);
  } catch (e) {
    caught = e;
  }
  expect(String(caught)).toContain('http-error');
  expect(String(caught)).toContain(String(status));
  expect(String(caught)).not.toContain('transport');
  expect(String(caught)).not.toContain('provider body');
  expect(f.writes).toEqual([]);
});
it('generation naming is immutable and exact-source scoped', () => {
  expect(generationPrefix('2026-10-08T00:00:00.000Z', 'synthetic-run')).toBe(
    'd1/mayisigorta-crm/2026/10/08/00/2026-10-08T00-00-00-000Z-synthetic-run/',
  );
});
it('backup flow must produce COMPLETE after validated SQL and manifest', async () => {
  const f = fixture();
  const r = await runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime);
  expect(r.state).toBe('COMPLETE');
  expect(r.capacityWarning).toBe(false);
  expect(f.requests.every((request) => request.init?.redirect === 'manual')).toBe(true);
  expect(f.writes.map((k) => k.split('/').pop())).toEqual([
    'database.sql',
    'manifest.json',
    'COMPLETE.json',
  ]);
  const headers = new Headers(f.requests[0]!.init?.headers);
  expect(headers.get('X-Auth-Key')).toBe(f.env.CLOUDFLARE_API_KEY);
  expect(headers.get('X-Auth-Email')).toBe(f.env.CLOUDFLARE_EMAIL);
  expect(headers.has('Authorization')).toBe(false);
  expect(new Headers(f.requests.at(-1)!.init?.headers).has('X-Auth-Key')).toBe(false);
  expect(new Headers(f.requests.at(-1)!.init?.headers).has('X-Auth-Email')).toBe(false);
  expect(new Headers(f.requests.at(-1)!.init?.headers).has('Authorization')).toBe(false);
  for (const value of [...f.outputs, ...[...f.objects.values()].map((r) => r.text)]) {
    expect(JSON.stringify(value)).not.toContain('synthetic-only-not-a-real-key');
    expect(JSON.stringify(value)).not.toContain('synthetic@example.invalid');
    expect(JSON.stringify(value)).not.toContain('synthetic-signed-value');
  }
});
it.each([
  'export',
  'download',
  'sql-write',
  'manifest-write',
  'malformed-errors',
  'malformed-success',
  'empty',
  'poll-limit',
])('%s failure never publishes COMPLETE', async (failure) => {
  const f = fixture(failure);
  await expect(runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime)).rejects.toThrow(
    'BACKUP_FAILED',
  );
  expect(f.writes.some((k) => k.endsWith('COMPLETE.json'))).toBe(false);
  expect(f.requests.length).toBeLessThanOrEqual(MAX_POLLS + 1);
});
it.each([
  ['sql-write', 'storage-write', 'local-failure'],
  ['empty', 'download', 'invalid-length'],
  ['poll-limit', 'export-poll', 'poll-limit'],
] as const)(
  'classifies %s without disclosing credential values',
  async (failure, stage, classification) => {
    const f = fixture(failure);
    await expect(
      runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime),
    ).rejects.toMatchObject({
      diagnostic: { stage, classification },
      message: expect.not.stringContaining(f.env.CLOUDFLARE_API_KEY),
    });
  },
);
it('duplicate completed generation is not overwritten or re-exported', async () => {
  const f = fixture();
  await runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime);
  const count = f.requests.length;
  await expect(runBackup(f.env, f.steps, timestamp, 'synthetic-run', f.runtime)).rejects.toThrow(
    'BACKUP_FAILED',
  );
  expect(f.requests).toHaveLength(count);
  expect(f.writes).toHaveLength(3);
});
it.each(['../escape', '', 'a/b'])('invalid generation %s rejected', (id) => {
  expect(() => generationPrefix(timestamp, id)).toThrow();
});
it('dedicated config uses the daily schedule, exact EU R2 binding and no D1/app route', () => {
  const c = JSON.parse(readFileSync('wrangler.backup.json', 'utf8'));
  expect(c.account_id).toBe('af9fc98cb8d5f5508d58057bc794d863');
  expect(c.workers_dev).toBe(false);
  expect(c.preview_urls).toBe(false);
  expect(c.routes).toEqual([]);
  expect(c.r2_buckets).toEqual([
    { binding: 'RECOVERY', bucket_name: 'mayisigorta-crm-recovery', jurisdiction: 'eu' },
  ]);
  expect(c.d1_databases).toBeUndefined();
  expect(c.triggers.crons).toEqual(BACKUP_CRONS);
  expect(c.workflows[0].schedules).toBeUndefined();
  const entry = readFileSync('src/server/d1-backup/worker.ts', 'utf8');
  expect(entry).toContain('scheduled');
  expect(entry).not.toContain('async fetch');
  expect(entry).toContain('MAYI_R2_CAPACITY');
  expect(entry).toContain('MAYI_D1_BACKUP_COMPLETE');
  expect(entry).toContain("name === 'poll-download-store-sql' ? 0 : 1");
});
