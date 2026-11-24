import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { gunzipSync } from 'node:zlib';
// @ts-expect-error Native Node recovery CLI needs an explicit extension.
import * as format from '../../src/server/d1-backup/format.ts';
// @ts-expect-error Node's recovery-only type-stripping CLI needs explicit extension.
import * as ordered from './ordered-d1-import.ts';
const {
  GZIP_INTEGRITY,
  GZIP_SQL_FILE,
  LEGACY_SQL_FILE,
  LEGACY_SQL_BYTES,
  MAX_GZIP_SQL_BYTES,
  MAX_RAW_SQL_BYTES,
} = format;
const { orderedD1Import, OrderedImportFailure } = ordered;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const objectKey = z
  .string()
  .min(1)
  .max(512)
  .regex(/^d1\/[A-Za-z0-9_./:-]+\/database\.sql(?:\.gz)?$/u)
  .refine((s) => !s.includes('..'));
const etag = z.string().regex(/^[a-f0-9]{32}(?:-\d+)?$/u);
const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/u);
const commonManifest = z.strictObject({
  state: z.literal('COMPLETE'),
  source: identity,
  sourceName: identity,
  sourceAccount: identity,
  generation: identity,
  exportTimestamp: z.iso.datetime({ precision: 3 }),
  bookmark: z.string().min(1).max(256).nullable(),
  sqlKey: objectKey,
  sqlSize: z.number().int().positive(),
  sqlEtag: etag,
  timings: z.strictObject({
    exportMs: z.number().nonnegative(),
    downloadHeadersMs: z.number().nonnegative(),
    uploadStreamMs: z.number().nonnegative(),
  }),
});
const commonComplete = z.strictObject({
  state: z.literal('COMPLETE'),
  generation: identity,
  manifestKey: z.string().min(1).max(512),
  sqlKey: objectKey,
  sqlSize: z.number().int().positive(),
  sqlEtag: etag,
});
const gzipFields = {
  encoding: z.literal('gzip'),
  rawSqlSize: z.number().int().positive().max(MAX_RAW_SQL_BYTES),
  storedSha256: digest,
};
const manifest = z.discriminatedUnion('version', [
  commonManifest.extend({
    version: z.literal('mayi-d1-backup-v1'),
    integrity: z.literal('R2_HEAD_SIZE_ETAG_METADATA_NOT_SQL_SHA256'),
  }),
  commonManifest.extend({
    version: z.literal('mayi-d1-backup-v2'),
    integrity: z.literal(GZIP_INTEGRITY),
    ...gzipFields,
  }),
]);
const complete = z.discriminatedUnion('version', [
  commonComplete.extend({ version: z.literal('mayi-d1-complete-v1') }),
  commonComplete.extend({ version: z.literal('mayi-d1-complete-v2'), ...gzipFields }),
]);
const acceptance = z.strictObject({
  format: z.literal('mayi-recovery-source-acceptance-v1'),
  expectedGeneration: identity,
  expectedSource: identity,
  expectedSourceName: identity,
  expectedSourceAccount: identity,
  expectedObjectKey: objectKey,
  sourceExportSha256: digest,
  manifest,
  complete,
  object: z.strictObject({
    key: objectKey,
    size: z.number().int().positive(),
    etag,
    generation: identity,
    source: identity,
    bookmark: z.string().max(256),
    encoding: z.literal('gzip').optional(),
    rawSqlSize: z.string().optional(),
    storedSha256: digest.optional(),
  }),
  // Operator metadata readback verifies publication ordering; never guessed from SQL.
  sqlUploadedAt: z.iso.datetime({ precision: 3 }),
  manifestUploadedAt: z.iso.datetime({ precision: 3 }),
  completeUploadedAt: z.iso.datetime({ precision: 3 }),
});
export type NativeSourceAcceptance = z.infer<typeof acceptance>;
export function nativeExportSha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Metadata custody/provenance is an operator responsibility. This checks the
 * accepted COMPLETE contract against explicitly pinned source identity and bytes;
 * a locally computed SHA is not a historical signature or manifest SHA claim. */
export function prepareNativeD1Restore(sourceBytes: Uint8Array, receipt: unknown) {
  const stored = Buffer.from(sourceBytes.buffer, sourceBytes.byteOffset, sourceBytes.byteLength);
  if (!stored.length || stored.length > LEGACY_SQL_BYTES)
    throw new OrderedImportFailure('RESOURCE_LIMIT');
  let r: NativeSourceAcceptance;
  try {
    r = acceptance.parse(receipt);
  } catch {
    throw new OrderedImportFailure('SOURCE_ACCEPTANCE_INVALID');
  }
  const m = r.manifest,
    c = r.complete,
    o = r.object;
  const gzip = m.version === 'mayi-d1-backup-v2';
  const filename = gzip ? GZIP_SQL_FILE : LEGACY_SQL_FILE;
  const sourceSha = nativeExportSha256(stored);
  const prefix = r.expectedObjectKey.slice(0, -filename.length);
  if (
    sourceSha !== r.sourceExportSha256 ||
    !r.expectedObjectKey.endsWith('/' + filename) ||
    m.source !== r.expectedSource ||
    m.sourceName !== r.expectedSourceName ||
    m.sourceAccount !== r.expectedSourceAccount ||
    m.generation !== r.expectedGeneration ||
    c.generation !== m.generation ||
    o.generation !== m.generation ||
    m.sqlKey !== r.expectedObjectKey ||
    c.sqlKey !== m.sqlKey ||
    o.key !== m.sqlKey ||
    c.manifestKey !== prefix + 'manifest.json' ||
    stored.length !== m.sqlSize ||
    c.sqlSize !== m.sqlSize ||
    o.size !== m.sqlSize ||
    o.etag !== m.sqlEtag ||
    c.sqlEtag !== m.sqlEtag ||
    o.source !== m.source ||
    o.bookmark !== (m.bookmark ?? '') ||
    !(
      m.exportTimestamp <= r.sqlUploadedAt &&
      r.sqlUploadedAt < r.manifestUploadedAt &&
      r.manifestUploadedAt < r.completeUploadedAt
    )
  )
    throw new OrderedImportFailure('SOURCE_IDENTITY_MISMATCH');
  let source = stored;
  if (gzip) {
    if (stored.length > MAX_GZIP_SQL_BYTES) throw new OrderedImportFailure('RESOURCE_LIMIT');
    if (
      c.version !== 'mayi-d1-complete-v2' ||
      c.rawSqlSize !== m.rawSqlSize ||
      c.storedSha256 !== m.storedSha256 ||
      m.storedSha256 !== sourceSha ||
      o.encoding !== 'gzip' ||
      o.rawSqlSize !== String(m.rawSqlSize) ||
      o.storedSha256 !== sourceSha
    )
      throw new OrderedImportFailure('SOURCE_IDENTITY_MISMATCH');
    try {
      source = gunzipSync(stored, { maxOutputLength: m.rawSqlSize });
    } catch {
      throw new OrderedImportFailure('SOURCE_GZIP_INVALID');
    }
    if (source.length !== m.rawSqlSize) throw new OrderedImportFailure('SOURCE_GZIP_INVALID');
  } else if (c.version !== 'mayi-d1-complete-v1') {
    throw new OrderedImportFailure('SOURCE_IDENTITY_MISMATCH');
  }
  let native: string;
  try {
    native = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new OrderedImportFailure('SOURCE_ENCODING_INVALID');
  }
  // Reject BOM/encoding normalization: source bytes and decoded native SQL are distinct identities.
  if (!Buffer.from(native, 'utf8').equals(source))
    throw new OrderedImportFailure('SOURCE_ENCODING_INVALID');
  const sql = orderedD1Import(native);
  return Object.freeze({
    sql,
    sourceExportSha256: sourceSha,
    derivedRestoreSha256: nativeExportSha256(Buffer.from(sql, 'utf8')),
    sourceBytes: source.length,
    storedBytes: stored.length,
    derivedBytes: Buffer.byteLength(sql),
    generation: r.expectedGeneration,
    sourceObjectKey: r.expectedObjectKey,
    format: 'DERIVED_ORDERED_RESTORE_SQL' as const,
    restoreProof: 'NOT_EXECUTED' as const,
  });
}

/** Only a temporary transport handoff. No Cloudflare client, target option,
 * binding, production default, credential or import capability is present. */
export async function withPreparedRestoreFile<T>(
  prepared: ReturnType<typeof prepareNativeD1Restore>,
  use: (path: string) => Promise<T>,
) {
  if (
    prepared.format !== 'DERIVED_ORDERED_RESTORE_SQL' ||
    nativeExportSha256(Buffer.from(prepared.sql)) !== prepared.derivedRestoreSha256
  )
    throw new OrderedImportFailure('DERIVED_IDENTITY_MISMATCH');
  const directory = mkdtempSync(join(tmpdir(), 'mayi-derived-restore-'));
  try {
    const path = join(directory, 'derived-restore.sql');
    writeFileSync(path, prepared.sql, { flag: 'wx', mode: 0o600 });
    return await use(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
