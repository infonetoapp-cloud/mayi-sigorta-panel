import { BackupFailure, parseExportResponse, safeFailure, type Classification } from './provider';
import { classifyTransport } from './diagnostic';
export function generationPrefix(timestamp: string, id: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    new Date(timestamp).toISOString() !== timestamp ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(id)
  )
    throw new Error('BACKUP_GENERATION_INVALID');
  return `d1/mayisigorta-crm/${timestamp.slice(0, 4)}/${timestamp.slice(5, 7)}/${timestamp.slice(8, 10)}/${timestamp.slice(11, 13)}/${timestamp.replaceAll(':', '-').replace('.', '-')}-${id}/`;
}
export const BACKUP_SOURCE = Object.freeze({
  accountId: 'af9fc98cb8d5f5508d58057bc794d863',
  databaseId: '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d',
  databaseName: 'mayisigorta-crm',
  bucket: 'mayisigorta-crm-recovery',
});
export const EXPORT_URL = `https://api.cloudflare.com/client/v4/accounts/${BACKUP_SOURCE.accountId}/d1/database/${BACKUP_SOURCE.databaseId}/export`;
export const MAX_POLLS = 20;
export const MAX_BACKUP_SQL_BYTES = 16 * 1024 * 1024;
export interface BackupEnv {
  CLOUDFLARE_EMAIL: string;
  CLOUDFLARE_API_KEY: string;
  RECOVERY: R2Bucket;
}
export interface BackupSteps {
  do<T extends Rpc.Serializable<T>>(name: string, callback: () => Promise<T>): Promise<T>;
}
export interface BackupRuntime {
  fetch: typeof fetch;
  now: () => number;
  sleep: () => Promise<void>;
}

async function readBackupSqlWithoutLength(
  body: ReadableStream<Uint8Array>,
  downloadFailure: (classification: Classification) => BackupFailure,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const bytes = new Uint8Array(MAX_BACKUP_SQL_BYTES);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read().catch(() => {
        throw downloadFailure('transport');
      });
      if (chunk.done) break;
      if (chunk.value.byteLength > bytes.byteLength - size) {
        void reader.cancel().catch(() => {});
        throw downloadFailure('sql-size-limit-exceeded');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw downloadFailure('invalid-length');
  return bytes.subarray(0, size);
}

function requireState(ok: unknown): asserts ok {
  if (!ok) throw new Error('BACKUP_STATE_INVALID');
}
async function exportRequest(
  env: BackupEnv,
  runtime: BackupRuntime,
  bookmark?: string,
  attempt = 1,
) {
  const stage = bookmark ? 'export-poll' : 'export-start',
    start = runtime.now();
  let response: Response;
  try {
    response = await runtime.fetch(EXPORT_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Email': env.CLOUDFLARE_EMAIL,
        'X-Auth-Key': env.CLOUDFLARE_API_KEY,
      },
      body: JSON.stringify({
        output_format: 'polling',
        ...(bookmark ? { current_bookmark: bookmark } : {}),
      }),
    });
  } catch (error) {
    throw new BackupFailure({
      ...safeFailure(stage, 'transport', attempt, runtime.now() - start).diagnostic,
      ...classifyTransport(error),
    });
  }
  if (response.status >= 300 && response.status <= 399)
    throw safeFailure(
      stage,
      'unexpected-redirect',
      attempt,
      runtime.now() - start,
      response.status,
    );
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw safeFailure(
      stage,
      response.ok ? 'invalid-json' : 'http-error',
      attempt,
      runtime.now() - start,
      response.status,
    );
  }
  return parseExportResponse(
    data,
    response.status,
    stage,
    attempt,
    runtime.now() - start,
    bookmark,
  );
}
async function checkedJson(bucket: R2Bucket, key: string, value: object, generation: string) {
  const text = JSON.stringify(value);
  const wrote = await bucket.put(key, text, {
    onlyIf: { etagDoesNotMatch: '*' },
    customMetadata: { generation },
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  if (!wrote) {
    const old = await bucket.get(key);
    requireState(
      old && old.customMetadata?.generation === generation && (await old.text()) === text,
    );
  }
  const read = await bucket.get(key);
  requireState(
    read &&
      read.size > 0 &&
      read.customMetadata?.generation === generation &&
      (await read.text()) === text,
  );
}
export const nativeBackupFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
export async function runBackup(
  env: BackupEnv,
  steps: BackupSteps,
  timestamp: string,
  generation: string,
  runtime: BackupRuntime = {
    fetch: nativeBackupFetch,
    now: () => Date.now(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1000)),
  },
) {
  try {
    requireState(env.CLOUDFLARE_EMAIL && env.CLOUDFLARE_API_KEY && env.RECOVERY);
    const prefix = generationPrefix(timestamp, generation),
      started = runtime.now();
    const begin = await steps.do('start-export-once', async () => {
      requireState(
        (await env.RECOVERY.head(prefix + 'COMPLETE.json')) === null &&
          (await env.RECOVERY.head(prefix + 'database.sql')) === null,
      );
      const startedAt = runtime.now();
      return { startedAt };
    });
    const sql = await steps.do('poll-download-store-sql', async () => {
      const existing = await env.RECOVERY.head(prefix + 'database.sql');
      // A crashed SQL write is not silently accepted without its completed durable step proof.
      requireState(existing === null);
      let currentBookmark: string | undefined;
      for (let poll = 0; poll <= MAX_POLLS; poll++) {
        const result = await exportRequest(env, runtime, currentBookmark, poll + 1);
        currentBookmark = result.bookmark;
        if (result.kind === 'progress') {
          await runtime.sleep();
          continue;
        }
        let url: URL;
        try {
          url = new URL(result.signedUrl);
        } catch {
          throw safeFailure('download', 'invalid-url', poll + 1, runtime.now() - started);
        }
        if (
          url.protocol !== 'https:' ||
          !url.hostname.endsWith('.r2.cloudflarestorage.com') ||
          url.username ||
          url.password
        )
          throw safeFailure('download', 'invalid-url', poll + 1, runtime.now() - started);
        const exportMs = runtime.now() - begin.startedAt;
        const downloadStart = runtime.now();
        // Deliberately no authentication header on download, no signed URL in durable step output/logs.
        let response: Response;
        try {
          response = await runtime.fetch(url.href, { method: 'GET', redirect: 'manual' });
        } catch (error) {
          throw new BackupFailure({
            ...safeFailure('download', 'transport', poll, runtime.now() - downloadStart).diagnostic,
            ...classifyTransport(error),
          });
        }
        if (response.status >= 300 && response.status <= 399)
          throw safeFailure(
            'download',
            'unexpected-redirect',
            poll,
            runtime.now() - downloadStart,
            response.status,
          );
        if (!response.ok || !response.body)
          throw safeFailure(
            'download',
            'http-error',
            poll,
            runtime.now() - downloadStart,
            response.status,
          );
        const downloadMs = runtime.now() - downloadStart;
        const length = response.headers.get('content-length');
        const expected = length === null ? null : Number(length);
        const downloadFailure = (classification: Classification) =>
          safeFailure('download', classification, poll + 1, runtime.now() - downloadStart);
        if (expected !== null && (!Number.isSafeInteger(expected) || expected <= 0))
          throw downloadFailure('invalid-length');
        if (expected !== null && expected > MAX_BACKUP_SQL_BYTES)
          throw downloadFailure('sql-size-limit-exceeded');
        // R2 accepts a streaming body only when its length is known. Buffer an
        // unannounced body under a hard limit before making any storage write.
        const sqlBody =
          expected === null
            ? await readBackupSqlWithoutLength(response.body, downloadFailure)
            : response.body;
        const verifiedLength = sqlBody instanceof Uint8Array ? sqlBody.byteLength : expected;
        const uploadStart = runtime.now();
        const wrote = await env.RECOVERY.put(prefix + 'database.sql', sqlBody, {
          onlyIf: { etagDoesNotMatch: '*' },
          customMetadata: {
            generation,
            source: BACKUP_SOURCE.databaseId,
            bookmark: currentBookmark ?? '',
          },
          httpMetadata: { contentType: 'application/sql', cacheControl: 'private, no-store' },
        }).catch(() => {
          throw safeFailure(
            'storage-write',
            'local-failure',
            poll + 1,
            runtime.now() - uploadStart,
          );
        });
        if (!wrote)
          throw safeFailure(
            'storage-write',
            'verification-failed',
            poll + 1,
            runtime.now() - uploadStart,
          );
        const head = await env.RECOVERY.head(prefix + 'database.sql').catch(() => {
          throw safeFailure(
            'storage-verify',
            'local-failure',
            poll + 1,
            runtime.now() - uploadStart,
          );
        });
        if (
          !head ||
          !Number.isSafeInteger(head.size) ||
          head.size <= 0 ||
          head.size > MAX_BACKUP_SQL_BYTES ||
          head.customMetadata?.generation !== generation ||
          head.customMetadata?.source !== BACKUP_SOURCE.databaseId ||
          head.customMetadata?.bookmark !== (currentBookmark ?? '') ||
          head.etag !== wrote.etag ||
          verifiedLength !== head.size
        )
          throw safeFailure(
            'storage-verify',
            'verification-failed',
            poll + 1,
            runtime.now() - uploadStart,
          );
        return {
          key: prefix + 'database.sql',
          size: head.size,
          etag: head.etag,
          bookmark: currentBookmark ?? null,
          pollingCount: poll,
          exportMs,
          downloadHeadersMs: downloadMs,
          uploadStreamMs: runtime.now() - uploadStart,
        };
      }
      throw safeFailure(
        'export-poll',
        'poll-limit',
        MAX_POLLS + 1,
        runtime.now() - begin.startedAt,
      );
    });
    const manifest = await steps.do('write-verify-manifest', async () => {
      const value = {
        version: 'mayi-d1-backup-v1',
        state: 'COMPLETE',
        source: BACKUP_SOURCE.databaseId,
        sourceName: BACKUP_SOURCE.databaseName,
        sourceAccount: BACKUP_SOURCE.accountId,
        generation,
        exportTimestamp: timestamp,
        bookmark: sql.bookmark,
        sqlKey: sql.key,
        sqlSize: sql.size,
        sqlEtag: sql.etag,
        integrity: 'R2_HEAD_SIZE_ETAG_METADATA_NOT_SQL_SHA256',
        timings: {
          exportMs: sql.exportMs,
          downloadHeadersMs: sql.downloadHeadersMs,
          uploadStreamMs: sql.uploadStreamMs,
        },
      };
      await checkedJson(env.RECOVERY, prefix + 'manifest.json', value, generation);
      return value;
    });
    return await steps.do('write-verify-COMPLETE-last', async () => {
      const head = await env.RECOVERY.head(sql.key);
      requireState(
        head &&
          head.size === sql.size &&
          head.etag === sql.etag &&
          head.customMetadata?.generation === generation,
      );
      const read = await env.RECOVERY.get(prefix + 'manifest.json');
      requireState(read && (await read.text()) === JSON.stringify(manifest));
      const marker = {
        version: 'mayi-d1-complete-v1',
        state: 'COMPLETE',
        generation,
        manifestKey: prefix + 'manifest.json',
        sqlKey: sql.key,
        sqlSize: sql.size,
        sqlEtag: sql.etag,
      };
      await checkedJson(env.RECOVERY, prefix + 'COMPLETE.json', marker, generation);
      return { ...marker, prefix, ...sql, totalMs: runtime.now() - started, stepCount: 4 };
    });
  } catch (error) {
    if (error instanceof BackupFailure) throw error;
    throw safeFailure('workflow-step', 'local-failure');
  }
}
