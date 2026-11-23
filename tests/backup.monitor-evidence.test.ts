// @vitest-environment node
import { expect, it } from 'vitest';
import { validateBackupEvidence, monitorStatus } from '../src/server/backup-monitor/evidence';
import {
  BACKUP_SOURCE,
  generationPrefix,
  MAX_BACKUP_SQL_BYTES,
} from '../src/server/d1-backup/core';
export function fixture() {
  const timestamp = '2026-10-13T15:30:07.199Z',
    generation = 'd1-backup-slot-995503',
    prefix = generationPrefix(timestamp, generation);
  const sql = {
    key: prefix + 'database.sql',
    size: 227547,
    etag: 'provider-etag',
    uploaded: new Date('2026-10-13T15:30:10.000Z'),
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
      uploaded: new Date('2026-10-13T15:30:12.000Z'),
      customMetadata: { generation },
    },
    completeHead: {
      key: prefix + 'COMPLETE.json',
      uploaded: new Date('2026-10-13T15:30:16.339Z'),
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
