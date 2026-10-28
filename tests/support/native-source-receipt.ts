import { createHash } from 'node:crypto';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export function receiptFor(sql: string) {
  const key = 'd1/synthetic-source/2026/10/09/synthetic-generation/database.sql';
  const etag = createHash('md5').update(sql).digest('hex');
  const common = {
    generation: 'synthetic-generation',
    sqlKey: key,
    sqlSize: Buffer.byteLength(sql),
    sqlEtag: etag,
  };
  return {
    format: 'mayi-recovery-source-acceptance-v1',
    expectedGeneration: common.generation,
    expectedSource: 'synthetic-source',
    expectedSourceName: 'synthetic-crm',
    expectedSourceAccount: 'synthetic-account',
    expectedObjectKey: key,
    sourceExportSha256: sha(sql),
    manifest: {
      ...common,
      version: 'mayi-d1-backup-v1',
      state: 'COMPLETE',
      source: 'synthetic-source',
      sourceName: 'synthetic-crm',
      sourceAccount: 'synthetic-account',
      exportTimestamp: '2026-10-09T00:00:00.000Z',
      bookmark: 'synthetic-bookmark',
      integrity: 'R2_HEAD_SIZE_ETAG_METADATA_NOT_SQL_SHA256',
      timings: { exportMs: 0, downloadHeadersMs: 0, uploadStreamMs: 0 },
    },
    complete: {
      ...common,
      version: 'mayi-d1-complete-v1',
      state: 'COMPLETE',
      manifestKey: key.replace('database.sql', 'manifest.json'),
    },
    object: {
      key,
      size: common.sqlSize,
      etag,
      generation: common.generation,
      source: 'synthetic-source',
      bookmark: 'synthetic-bookmark',
    },
    sqlUploadedAt: '2026-10-09T00:00:01.000Z',
    manifestUploadedAt: '2026-10-09T00:00:02.000Z',
    completeUploadedAt: '2026-10-09T00:00:03.000Z',
  };
}
