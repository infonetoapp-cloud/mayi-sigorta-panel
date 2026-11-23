import { BACKUP_SOURCE, generationPrefix, MAX_BACKUP_SQL_BYTES } from '../d1-backup/core';
export const FRESHNESS_MS = 90 * 60 * 1000;
export const OPERATIONAL_FRESHNESS_MS = 45 * 60 * 1000;
export const HEARTBEAT_MS = 15 * 60 * 1000;
export type EvidenceStatus = 'HEALTHY' | 'BACKUP_STALE' | 'QUERY_OR_PROVIDER_FAILURE';
export interface Decision {
  status: EvidenceStatus;
  checkedAt: number;
  reason: string;
  generation?: string;
  exportAt?: number;
  completeAt?: number;
  ageMs?: number;
}
export interface ObjectHead {
  key: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
  size?: number;
  etag?: string;
}
export interface BackupEvidence {
  manifest: unknown;
  complete: unknown;
  sql: ObjectHead;
  manifestHead: ObjectHead;
  completeHead: ObjectHead;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('INVALID');
  return v as Record<string, unknown>;
}
function check(v: unknown): asserts v {
  if (!v) throw Error('INVALID');
}
/** Metadata-only contract, NOT SQL SHA256, restore, RPO or provider signature proof. */
export function validateBackupEvidence(
  e: BackupEvidence,
  now: number,
  freshnessMs = FRESHNESS_MS,
): Decision {
  try {
    check(Number.isSafeInteger(now) && now >= 0);
    check(Number.isSafeInteger(freshnessMs) && freshnessMs > 0 && freshnessMs <= FRESHNESS_MS);
    const m = object(e.manifest),
      c = object(e.complete);
    check(
      m.version === 'mayi-d1-backup-v1' &&
        c.version === 'mayi-d1-complete-v1' &&
        m.state === 'COMPLETE' &&
        c.state === 'COMPLETE',
    );
    check(
      m.source === BACKUP_SOURCE.databaseId &&
        m.sourceName === BACKUP_SOURCE.databaseName &&
        m.sourceAccount === BACKUP_SOURCE.accountId,
    );
    check(
      typeof m.generation === 'string' &&
        /^d1-backup-slot-[0-9]+$/u.test(m.generation) &&
        typeof m.exportTimestamp === 'string',
    );
    const prefix = generationPrefix(m.exportTimestamp, m.generation),
      exportAt = Date.parse(m.exportTimestamp),
      sql = e.sql,
      mh = e.manifestHead,
      ch = e.completeHead;
    check(Number.isSafeInteger(exportAt) && exportAt <= now);
    const times: [number, number, number] = [
      sql.uploaded.getTime(),
      mh.uploaded.getTime(),
      ch.uploaded.getTime(),
    ];
    check(
      times.every((t) => Number.isSafeInteger(t) && t <= now) &&
        exportAt <= times[0] &&
        times[0] < times[1] &&
        times[1] < times[2],
    );
    check(
      c.generation === m.generation &&
        [sql, mh, ch].every((h) => h.customMetadata?.generation === m.generation),
    );
    check(
      sql.key === prefix + 'database.sql' &&
        mh.key === prefix + 'manifest.json' &&
        ch.key === prefix + 'COMPLETE.json' &&
        c.manifestKey === mh.key &&
        m.sqlKey === sql.key &&
        c.sqlKey === sql.key,
    );
    if (
      typeof sql.size === 'number' &&
      Number.isSafeInteger(sql.size) &&
      sql.size > MAX_BACKUP_SQL_BYTES
    )
      return {
        status: 'QUERY_OR_PROVIDER_FAILURE',
        checkedAt: now,
        reason: 'BACKUP_SQL_SIZE_LIMIT_EXCEEDED',
      };
    check(
      Number.isSafeInteger(sql.size) &&
        sql.size! > 0 &&
        m.sqlSize === sql.size &&
        c.sqlSize === sql.size,
    );
    check(
      typeof sql.etag === 'string' &&
        sql.etag.length > 0 &&
        m.sqlEtag === sql.etag &&
        c.sqlEtag === sql.etag &&
        sql.customMetadata?.source === BACKUP_SOURCE.databaseId,
    );
    check(
      m.integrity === 'R2_HEAD_SIZE_ETAG_METADATA_NOT_SQL_SHA256' &&
        (m.bookmark === null ||
          (typeof m.bookmark === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(m.bookmark))),
    );
    check(sql.customMetadata?.bookmark === (m.bookmark ?? ''));
    const ageMs = now - exportAt;
    return {
      status: ageMs <= freshnessMs ? 'HEALTHY' : 'BACKUP_STALE',
      checkedAt: now,
      reason: ageMs <= freshnessMs ? 'COHERENT_RECENT_COMPLETE' : 'EXPORT_EVIDENCE_TOO_OLD',
      generation: m.generation,
      exportAt,
      completeAt: times[2],
      ageMs,
    };
  } catch {
    return { status: 'QUERY_OR_PROVIDER_FAILURE', checkedAt: now, reason: 'EVIDENCE_INCOHERENT' };
  }
}
export type MonitorStatus = EvidenceStatus | 'OBSERVER_FAILURE';
/** Do not reuse an old healthy result when observation stopped; errors are never healthy. */
export function monitorStatus(
  last: Decision | null,
  now: number,
  freshnessMs = FRESHNESS_MS,
): MonitorStatus {
  if (
    !Number.isSafeInteger(now) ||
    !last ||
    !Number.isSafeInteger(last.checkedAt) ||
    last.checkedAt > now ||
    now - last.checkedAt > HEARTBEAT_MS
  )
    return 'OBSERVER_FAILURE';
  if (last.status !== 'HEALTHY')
    return last.status === 'BACKUP_STALE' ? 'BACKUP_STALE' : 'QUERY_OR_PROVIDER_FAILURE';
  if (
    last.exportAt === undefined ||
    !Number.isSafeInteger(last.exportAt) ||
    last.exportAt < 0 ||
    last.exportAt > last.checkedAt
  )
    return 'QUERY_OR_PROVIDER_FAILURE';
  return now - last.exportAt <= freshnessMs ? 'HEALTHY' : 'BACKUP_STALE';
}
