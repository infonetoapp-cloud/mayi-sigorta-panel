import { BackupFailure, parseExportResponse, safeFailure } from './provider';
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
      redirect: 'error',
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
  } catch {
    throw safeFailure(stage, 'transport', attempt, runtime.now() - start);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw safeFailure(stage, 'invalid-json', attempt, runtime.now() - start, response.status);
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
export async function runBackup(
  env: BackupEnv,
  steps: BackupSteps,
  timestamp: string,
  generation: string,
  runtime: BackupRuntime = {
    fetch: globalThis.fetch,
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
        const url = new URL(result.signedUrl);
        requireState(
          url.protocol === 'https:' &&
            url.hostname.endsWith('.r2.cloudflarestorage.com') &&
            !url.username &&
            !url.password,
        );
        const exportMs = runtime.now() - begin.startedAt;
        const downloadStart = runtime.now();
        // Deliberately no authentication header on download, no signed URL in durable step output/logs.
        let response: Response;
        try {
          response = await runtime.fetch(url.href, { method: 'GET', redirect: 'error' });
        } catch {
          throw safeFailure('download', 'transport', poll, runtime.now() - downloadStart);
        }
        if (!response.ok || !response.body)
          throw safeFailure(
            'download',
            'http-error',
            poll,
            runtime.now() - downloadStart,
            response.status,
          );
        const downloadMs = runtime.now() - downloadStart,
          expected = response.headers.get('content-length');
        if (expected !== null)
          requireState(
            Number.isSafeInteger(Number(expected)) &&
              Number(expected) > 0 &&
              Number(expected) <= 16 * 1024 * 1024,
          );
        const uploadStart = runtime.now();
        const wrote = await env.RECOVERY.put(prefix + 'database.sql', response.body, {
          onlyIf: { etagDoesNotMatch: '*' },
          customMetadata: {
            generation,
            source: BACKUP_SOURCE.databaseId,
            bookmark: currentBookmark ?? '',
          },
          httpMetadata: { contentType: 'application/sql', cacheControl: 'private, no-store' },
        });
        requireState(wrote);
        const head = await env.RECOVERY.head(prefix + 'database.sql');
        requireState(
          head &&
            head.size > 0 &&
            head.size <= 16 * 1024 * 1024 &&
            head.customMetadata?.generation === generation &&
            head.customMetadata?.source === BACKUP_SOURCE.databaseId &&
            head.customMetadata?.bookmark === (currentBookmark ?? '') &&
            head.etag === wrote.etag &&
            (expected === null || Number(expected) === head.size),
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
      throw new Error('BACKUP_POLL_LIMIT');
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
