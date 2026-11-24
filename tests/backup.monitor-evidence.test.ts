// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  DAILY_BACKUP_FRESHNESS_MS,
  validateBackupEvidence,
  monitorStatus,
} from '../src/server/backup-monitor/evidence';
import { observeBackup } from '../src/server/backup-monitor/observer';
import { GZIP_INTEGRITY, GZIP_SQL_FILE } from '../src/server/d1-backup/format';
import {
  BACKUP_SOURCE,
  generationPrefix,
  MAX_BACKUP_SQL_BYTES,
} from '../src/server/d1-backup/core';
export function fixture(
  timestamp = '2026-10-13T15:30:07.199Z',
  generation = 'd1-backup-slot-995503',
) {
  const prefix = generationPrefix(timestamp, generation);
  const exportAt = Date.parse(timestamp);
  const sql = {
    key: prefix + 'database.sql',
    size: 227547,
    etag: 'provider-etag',
    uploaded: new Date(exportAt + 2801),
    customMetadata: { generation, source: BACKUP_SOURCE.databaseId, bookmark: '' },
  };
  const manifest = {
    version: 'mayi-d1-backup-v1',
    state: 'COMPLETE',
    source: String(BACKUP_SOURCE.databaseId),
    sourceName: BACKUP_SOURCE.databaseName,
    sourceAccount: String(BACKUP_SOURCE.accountId),
    generation,
    exportTimestamp: timestamp,
    bookmark: null,
    sqlKey: sql.key,
    sqlSize: sql.size,
    sqlEtag: sql.etag,
    integrity: 'R2_HEAD_SIZE_ETAG_METADATA_NOT_SQL_SHA256',
  };
  const complete = {
    version: 'mayi-d1-complete-v1',
    state: 'COMPLETE',
    generation,
    manifestKey: prefix + 'manifest.json',
    sqlKey: sql.key,
    sqlSize: sql.size,
    sqlEtag: sql.etag,
  };
  return {
    manifest,
    complete,
    sql,
    manifestHead: {
      key: complete.manifestKey,
      uploaded: new Date(exportAt + 4801),
      customMetadata: { generation },
    },
    completeHead: {
      key: prefix + 'COMPLETE.json',
      uploaded: new Date(exportAt + 9140),
      customMetadata: { generation },
    },
  };
}
it('accepts coherent COMPLETE-last evidence with writer-compatible null bookmark at inclusive90m cutoff', () => {
  const f = fixture(),
    now = Date.parse(f.manifest.exportTimestamp) + 5400000;
  expect(validateBackupEvidence(f, now)).toMatchObject({
    status: 'HEALTHY',
    generation: f.manifest.generation,
    ageMs: 5400000,
  });
  expect(validateBackupEvidence(f, now + 1)).toMatchObject({ status: 'BACKUP_STALE' });
});
it('verifies the daily gzip marker without reading SQL content', async () => {
  const timestamp = '2026-11-24T21:00:00.000Z';
  const generation = 'd1-backup-daily-2026-11-25';
  const f = fixture(timestamp, generation);
  const at = Date.parse(timestamp);
  const sqlKey = generationPrefix(timestamp, generation) + GZIP_SQL_FILE;
  const gzip = { encoding: 'gzip', rawSqlSize: 625621, storedSha256: 'a'.repeat(64) };
  const sql = {
    ...f.sql,
    key: sqlKey,
    customMetadata: { ...f.sql.customMetadata, ...gzip, rawSqlSize: String(gzip.rawSqlSize) },
  };
  const manifest = {
    ...f.manifest,
    ...gzip,
    version: 'mayi-d1-backup-v2',
    sqlKey,
    integrity: GZIP_INTEGRITY,
  };
  const complete = { ...f.complete, ...gzip, version: 'mayi-d1-complete-v2', sqlKey };
  const heads = new Map([sql, f.manifestHead, f.completeHead].map((head) => [head.key, head]));
  const json = new Map<string, unknown>([
    [f.manifestHead.key, manifest],
    [f.completeHead.key, complete],
  ]);
  const reader = {
    list: vi.fn(async (prefix: string) => ({
      keys: [...heads.keys()].filter((key) => key.startsWith(prefix)),
    })),
    head: async (key: string) => heads.get(key) ?? null,
    readJSON: vi.fn(async (key: string) => {
      if (!json.has(key)) throw Error('SQL_BODY_FORBIDDEN');
      return json.get(key);
    }),
  };
  const checkedAt = at + 24 * 60 * 60_000;
  const observe = () => observeBackup(reader, checkedAt, DAILY_BACKUP_FRESHNESS_MS);
  expect(await observe()).toMatchObject({
    status: 'HEALTHY',
    generation,
    checkedAt,
    exportAt: at,
    completeAt: f.completeHead.uploaded.getTime(),
  });
  expect(reader.readJSON.mock.calls.map(([key]) => key)).toEqual([
    f.manifestHead.key,
    f.completeHead.key,
  ]);
  heads.delete(f.completeHead.key);
  expect(await observe()).toMatchObject({ status: 'BACKUP_STALE' });
  reader.list.mockRejectedValueOnce(new Error('synthetic provider outage'));
  expect(await observe()).toMatchObject({ status: 'QUERY_OR_PROVIDER_FAILURE' });
});

it('discovers all valid markers at the 20-minute cadence across three hourly prefixes', async () => {
  const { observeBackup } = await import('../src/server/backup-monitor/observer');
  const batches = Array.from({ length: 7 }, (_, index) => {
    const timestamp = new Date(Date.parse('2026-10-13T13:00:00.000Z') + index * 20 * 60 * 1000);
    return fixture(timestamp.toISOString(), 'd1-backup-slot-' + (1500000 + index));
  });
  const heads = new Map(
    batches.flatMap((f) => [f.sql, f.manifestHead, f.completeHead]).map((head) => [head.key, head]),
  );
  const json = new Map<string, unknown>(
    batches.flatMap((f) => [
      [f.manifestHead.key, f.manifest] as const,
      [f.completeHead.key, f.complete] as const,
    ]),
  );
  const result = await observeBackup(
    {
      list: async (prefix) => ({ keys: [...heads.keys()].filter((key) => key.startsWith(prefix)) }),
      head: async (key) => heads.get(key) ?? null,
      readJSON: async (key) => {
        if (!json.has(key)) throw Error('SQL_BODY_FORBIDDEN');
        return json.get(key);
      },
    },
    Date.parse('2026-10-13T15:10:00.000Z'),
  );
  expect(result).toMatchObject({ status: 'HEALTHY', generation: 'd1-backup-slot-1500006' });
});
it.each([
  'source',
  'account',
  'key',
  'generation',
  'size',
  'etag',
  'bookmark',
  'integrity',
  'order',
  'future',
  'version',
])('rejects incoherent %s instead of healthy', (kind) => {
  const f = fixture(),
    now = Date.parse('2026-10-13T15:40:00.000Z');
  if (kind === 'source') f.manifest.source = 'wrong';
  if (kind === 'account') f.manifest.sourceAccount = 'wrong';
  if (kind === 'key') f.manifest.sqlKey = 'other/database.sql';
  if (kind === 'generation') f.complete.generation = 'd1-backup-slot-1';
  if (kind === 'size') f.complete.sqlSize = 0;
  if (kind === 'etag') f.sql.etag = 'other';
  if (kind === 'bookmark') f.sql.customMetadata.bookmark = 'different';
  if (kind === 'integrity') f.manifest.integrity = 'SHA256';
  if (kind === 'order') f.manifestHead.uploaded = f.sql.uploaded;
  if (kind === 'future') f.completeHead.uploaded = new Date(now + 1);
  if (kind === 'version') f.complete.version = 'unknown';
  expect(validateBackupEvidence(f, now).status).toBe('QUERY_OR_PROVIDER_FAILURE');
});
it('distinguishes a dead observer from query failure without keeping old healthy status', () => {
  const now = Date.parse('2026-10-13T15:40:00.000Z'),
    d = validateBackupEvidence(fixture(), now);
  expect(monitorStatus(d, now + 900000)).toBe('HEALTHY');
  expect(monitorStatus(d, now + 900001)).toBe('OBSERVER_FAILURE');
  expect(monitorStatus(null, now)).toBe('OBSERVER_FAILURE');
  expect(monitorStatus({ ...d, status: 'QUERY_OR_PROVIDER_FAILURE' }, now)).toBe(
    'QUERY_OR_PROVIDER_FAILURE',
  );
  expect(monitorStatus({ ...d, checkedAt: now + 1 }, now)).toBe('OBSERVER_FAILURE');
});
it('uses the same inclusive SQL byte limit as the backup writer', () => {
  const f = fixture();
  const now = Date.parse('2026-10-13T15:40:00.000Z');
  f.sql.size = f.manifest.sqlSize = f.complete.sqlSize = MAX_BACKUP_SQL_BYTES;
  expect(validateBackupEvidence(f, now).status).toBe('HEALTHY');
  f.sql.size = f.manifest.sqlSize = f.complete.sqlSize = MAX_BACKUP_SQL_BYTES + 1;
  expect(validateBackupEvidence(f, now)).toMatchObject({
    status: 'QUERY_OR_PROVIDER_FAILURE',
    reason: 'BACKUP_SQL_SIZE_LIMIT_EXCEEDED',
  });
});
it('uses bounded UTC metadata discovery and distinguishes provider errors', async () => {
  const { observeBackup } = await import('../src/server/backup-monitor/observer');
  const f = fixture(),
    now = Date.parse('2026-10-13T15:40:00.000Z');
  const calls: string[] = [];
  const reader = {
    list: async (prefix: string) => {
      calls.push('list:' + prefix);
      return { keys: f.completeHead.key.startsWith(prefix) ? [f.completeHead.key] : [] };
    },
    head: async (key: string) =>
      key.endsWith('database.sql')
        ? f.sql
        : key.endsWith('manifest.json')
          ? f.manifestHead
          : f.completeHead,
    readJSON: async (key: string) => {
      calls.push('body:' + key);
      if (key.endsWith('database.sql')) throw Error('SQL_BODY_FORBIDDEN');
      return key.endsWith('manifest.json') ? f.manifest : f.complete;
    },
  };
  expect((await observeBackup(reader, now)).status).toBe('HEALTHY');
  expect(calls.filter((x) => x.startsWith('list:'))).toHaveLength(2);
  expect(
    (
      await observeBackup(
        {
          ...reader,
          list: async () => {
            throw Error('provider secret detail');
          },
        },
        now,
      )
    ).status,
  ).toBe('QUERY_OR_PROVIDER_FAILURE');
});
