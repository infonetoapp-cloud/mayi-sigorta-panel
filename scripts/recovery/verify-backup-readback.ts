import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { info, error as reportError } from 'node:console';
import { BACKUP_SOURCE, generationPrefix } from '../../src/server/d1-backup/core';
import {
  OPERATIONAL_FRESHNESS_MS,
  type ObjectHead,
} from '../../src/server/backup-monitor/evidence';
import { observeBackup, type BackupReader } from '../../src/server/backup-monitor/observer';
import { nativeExportSha256, prepareNativeD1Restore } from './prepare-native-restore';
import { ORDERED_IMPORT_LIMITS } from './ordered-d1-import';
import { verifyOperationalRecovery } from './operational-data-proof';

const args = new Set(process.argv.slice(2));
const restoration = args.has('--restore-in-memory');
const url = `https://api.cloudflare.com/client/v4/accounts/${BACKUP_SOURCE.accountId}/r2/buckets/${BACKUP_SOURCE.bucket}/objects`;

function readHeaders(): Headers {
  const headers = new Headers({ 'cf-r2-jurisdiction': 'eu' });
  const token = process.env.MAYI_BACKUP_READ_TOKEN;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else if (
    args.has('--existing-read-profile') &&
    process.env.CLOUDFLARE_EMAIL &&
    process.env.CLOUDFLARE_API_KEY
  ) {
    headers.set('X-Auth-Email', process.env.CLOUDFLARE_EMAIL);
    headers.set('X-Auth-Key', process.env.CLOUDFLARE_API_KEY);
  } else throw new Error('BACKUP_READ_CREDENTIAL_REQUIRED');
  return headers;
}

async function bytes(response: Response, limit: number) {
  const body = response.body?.getReader();
  if (!body) throw new Error('BACKUP_RESPONSE_MISSING');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await body.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw new Error('BACKUP_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await body.cancel().catch(() => undefined);
    body.releaseLock();
  }
}

async function main() {
  if ([...args].some((arg) => arg !== '--restore-in-memory' && arg !== '--existing-read-profile'))
    throw new Error('CLI_ARGUMENTS_INVALID');
  const headers = readHeaders();
  async function get(path: string, signal?: AbortSignal) {
    const response = await fetch(path, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`BACKUP_READ_HTTP_${response.status}`);
    return response;
  }
  async function list(prefix: string, cursor?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ prefix, per_page: '100', ...(cursor ? { cursor } : {}) });
    const result = JSON.parse(
      (await bytes(await get(`${url}?${query}`, signal), 128 * 1024)).toString('utf8'),
    ) as {
      success: boolean;
      result: Array<{
        key: string;
        size: number;
        etag: string;
        last_modified: string;
        custom_metadata: Record<string, string>;
      }>;
      result_info?: { is_truncated?: boolean; cursor?: string };
    };
    if (
      !result.success ||
      !Array.isArray(result.result) ||
      (result.result_info?.is_truncated && !result.result_info.cursor)
    )
      throw new Error('BACKUP_LIST_INVALID');
    return result;
  }
  const head = async (key: string, signal?: AbortSignal): Promise<ObjectHead | null> => {
    const page = await list(key, undefined, signal);
    const match = page.result.find((item) => item.key === key);
    return match
      ? {
          key,
          size: match.size,
          etag: match.etag,
          uploaded: new Date(match.last_modified),
          customMetadata: match.custom_metadata,
        }
      : null;
  };
  const readJSON = async (key: string, limit: number, signal?: AbortSignal) => {
    if (!key.endsWith('/manifest.json') && !key.endsWith('/COMPLETE.json'))
      throw new Error('BACKUP_JSON_KEY_INVALID');
    return JSON.parse(
      (await bytes(await get(`${url}/${encodeURIComponent(key)}`, signal), limit)).toString('utf8'),
    ) as unknown;
  };
  const reader: BackupReader = {
    async list(prefix, cursor, signal) {
      const page = await list(prefix, cursor, signal);
      return {
        keys: page.result.map((item) => item.key),
        cursor: page.result_info?.is_truncated ? page.result_info.cursor : undefined,
      };
    },
    head,
    readJSON,
  };
  const started = performance.now();
  const now = Date.now();
  const observation = await observeBackup(reader, now, OPERATIONAL_FRESHNESS_MS);
  const summary = { ...observation, checkedAt: new Date(now).toISOString() };
  if (observation.status !== 'HEALTHY') {
    info(JSON.stringify(summary));
    process.exitCode = 1;
    return;
  }
  if (!restoration) {
    info(JSON.stringify(summary));
    return;
  }

  const generation = observation.generation!;
  const prefix = generationPrefix(new Date(observation.exportAt!).toISOString(), generation);
  const key = `${prefix}database.sql`;
  const [sql, manifestInfo, completeInfo, manifest, complete] = await Promise.all([
    head(key),
    head(`${prefix}manifest.json`),
    head(`${prefix}COMPLETE.json`),
    readJSON(`${prefix}manifest.json`, 8192),
    readJSON(`${prefix}COMPLETE.json`, 8192),
  ]);
  if (!sql?.size || sql.size > ORDERED_IMPORT_LIMITS.sourceBytes || !manifestInfo || !completeInfo)
    throw new Error('BACKUP_RESTORE_EVIDENCE_MISSING');
  const download = await get(`${url}/${encodeURIComponent(key)}`);
  if (download.headers.get('etag')?.replace(/^"|"$/g, '') !== sql.etag)
    throw new Error('BACKUP_RESTORE_ETAG_MISMATCH');
  const original = await bytes(download, sql.size);
  const sourceAcceptance = {
    format: 'mayi-recovery-source-acceptance-v1',
    expectedGeneration: generation,
    expectedSource: BACKUP_SOURCE.databaseId,
    expectedSourceName: BACKUP_SOURCE.databaseName,
    expectedSourceAccount: BACKUP_SOURCE.accountId,
    expectedObjectKey: key,
    sourceExportSha256: nativeExportSha256(original),
    manifest,
    complete,
    object: {
      key,
      size: sql.size,
      etag: sql.etag,
      generation: sql.customMetadata?.generation,
      source: sql.customMetadata?.source,
      bookmark: sql.customMetadata?.bookmark,
    },
    sqlUploadedAt: sql.uploaded.toISOString(),
    manifestUploadedAt: manifestInfo.uploaded.toISOString(),
    completeUploadedAt: completeInfo.uploaded.toISOString(),
  };
  let local: DatabaseSync | undefined;
  try {
    const prepared = prepareNativeD1Restore(original, sourceAcceptance);
    const database = new DatabaseSync(':memory:', { allowExtension: false });
    local = database;
    local.exec('BEGIN;');
    local.exec(prepared.sql);
    local.exec('COMMIT;');
    if (
      local.prepare('PRAGMA foreign_key_check').all().length ||
      local.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
    )
      throw new Error('LOCAL_RESTORE_INTEGRITY_FAILED');
    await verifyOperationalRecovery((query) => database.prepare(query).all());
    info(
      JSON.stringify({
        ...summary,
        localProof: 'SQLITE_SEALED',
        bytes: original.byteLength,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  } finally {
    original.fill(0);
    local?.close();
  }
}

try {
  await main();
} catch (cause) {
  const code =
    cause instanceof Error && /^[A-Z0-9_]{1,64}$/.test(cause.message)
      ? cause.message
      : 'BACKUP_CHECK_FAILED';
  reportError(JSON.stringify({ code }));
  process.exitCode = 1;
}
