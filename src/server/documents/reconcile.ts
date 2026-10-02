import { createHash } from 'node:crypto';
import { z } from 'zod';
import { REQUIRED_CONTENT_INSPECTION_VERSION } from './content-inspection';
import {
  backupAbortable,
  documentBackupObjectKey,
  DocumentBackupIntegrityError,
} from './backup-storage';
import type { DocumentReconcileStorage } from './reconcile-storage';
import type { DocumentJobQueueMessage } from './queue';
import { documentScanRetryDelaySeconds } from './queue';
import { processDocumentBackupMessage } from './backup';

const id = z.string().trim().min(1).max(255);
const objectKey = z
  .string()
  .regex(/^(quarantine|backup)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const targetSchema = z.union([
  z.object({ versionId: id }).strict(),
  z
    .object({ kind: z.enum(['PRIMARY', 'BACKUP']), objectKey })
    .strict()
    .refine((t) => t.objectKey.startsWith(t.kind === 'PRIMARY' ? 'quarantine/' : 'backup/')),
]);
export type DocumentReconcileTarget = z.infer<typeof targetSchema>;
export type DocumentReconcileResult =
  'SAFE_NOOP' | 'SAFE_REPAIR' | 'INVESTIGATE' | 'ACKED' | 'RETRY_SCHEDULED' | 'RETRY_DELIVERY';
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function assertion(db: D1Database, code: string) {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), code);
}
function conflict(error: unknown) {
  return error instanceof Error && error.message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT');
}
function requestAudit(db: D1Database, agency: string, jobId: string, metadata: string) {
  return db
    .prepare(
      `INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json)
    VALUES(?,?,'document-reconcile','document.reconcile.requested','background_jobs',?,?,?,'SUCCESS','TARGET_BOUND',?)
    ON CONFLICT(agency_id,system_actor_code,action,idempotency_key) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), agency, jobId, jobId, jobId, metadata);
}
/** Internal/operator targeted scheduling, not an authorization-bypassing client endpoint.
 * Existing immutable SYSTEM audit binds the target atomically to the durable job.
 * operationId identifies an inspection cycle; exact retries converge on one job.
 */
export async function enqueueDocumentReconcile(
  db: D1Database,
  agencyId: string,
  input: DocumentReconcileTarget,
  operationId: string,
): Promise<DocumentJobQueueMessage> {
  const agency = id.parse(agencyId);
  const target = targetSchema.parse(input);
  const operation = id.parse(operationId);
  const metadata = JSON.stringify(target);
  const jobId = `reconcile-${digest(JSON.stringify([agency, target, operation]))}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO background_jobs(id,agency_id,job_type) VALUES(?,?,'DOCUMENT_RECONCILE') ON CONFLICT(id) DO NOTHING`,
      )
      .bind(jobId, agency),
    requestAudit(db, agency, jobId, metadata),
  ]);
  const bound = await db
    .prepare(
      `SELECT job.agency_id,event.metadata_json FROM background_jobs job JOIN system_audit_events event
    ON event.agency_id=job.agency_id AND event.target_id=job.id AND event.idempotency_key=job.id
    AND event.system_actor_code='document-reconcile' AND event.action='document.reconcile.requested'
    AND event.target_type='background_jobs' AND event.outcome='SUCCESS' AND event.reason_code='TARGET_BOUND'
    WHERE job.id=? AND job.job_type='DOCUMENT_RECONCILE' AND job.generation=1`,
    )
    .bind(jobId)
    .first<{ agency_id: string; metadata_json: string }>();
  if (!bound || bound.agency_id !== agency || bound.metadata_json !== metadata)
    throw new Error('RECONCILE_TARGET_CONFLICT');
  return {
    jobId,
    jobType: 'DOCUMENT_RECONCILE',
    generation: 1,
    documentVersionId: null,
    inputSha256: null,
  };
}

// One statement captures authority-free immutable identity, publication, newest generations,
// current run/evidence and freshness. The identical query is used inside final D1 CAS.
const SNAPSHOT = `WITH args(agency,version_id,kind,object_key) AS (VALUES(?,?,?,?))
SELECT json_object('foreignOwner',CASE WHEN EXISTS (
  SELECT 1 FROM document_versions v,args a WHERE a.kind='PRIMARY' AND v.object_key=a.object_key AND v.agency_id<>a.agency
  UNION ALL SELECT 1 FROM document_backup_copies c,args a WHERE a.kind='BACKUP' AND c.object_key=a.object_key AND c.agency_id<>a.agency
) THEN 1 ELSE 0 END,
'targetCopy',json((SELECT json_object('id',c.id,'key',c.object_key,'sha256',c.backup_sha256,'sourceSha256',c.source_sha256,'generation',j.generation,'jobId',j.id,'runStatus',r.status,'jobStatus',j.status,'attempt',r.attempt_number,'jobAttempt',j.attempt_count)
  FROM document_backup_copies c JOIN background_job_runs r ON r.agency_id=c.agency_id AND r.id=c.job_run_id
  JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id,args a
  WHERE a.kind='BACKUP' AND c.agency_id=a.agency AND c.object_key=a.object_key AND j.job_type='DOCUMENT_BACKUP' LIMIT 1)),
'v',json((SELECT json_object('id',v.id,'documentId',v.document_id,'status',v.status,'sha256',v.sha256,'size',v.size_bytes,'key',v.object_key,'contentType',v.detected_content_type,
  'number',v.version_number,'latest',(SELECT max(n.version_number) FROM document_versions n WHERE n.agency_id=v.agency_id AND n.document_id=v.document_id),
  'documentStatus',d.status,'documentVersion',d.version,'current',d.current_version_id,
  'scan',json((SELECT json_object('id',s.id,'sha256',s.sha256,'outcome',s.outcome,'runStatus',s.run_status,'jobStatus',s.job_status,'generation',s.generation,
    'inspectionVersion',i.content_inspection_version,'inspectionResult',i.content_inspection_result)
    FROM document_latest_scan_evidence s JOIN document_scan_evidence i ON i.agency_id=s.agency_id AND i.id=s.id
    WHERE s.agency_id=v.agency_id AND s.document_version_id=v.id AND s.sha256=v.sha256)),
  'scanJob',json((SELECT json_object('id',j.id,'generation',j.generation,'status',j.status,'attempt',j.attempt_count,'lease',j.lease_token_hash,'expires',j.lease_expires_at)
    FROM background_jobs j WHERE j.agency_id=v.agency_id AND j.document_version_id=v.id AND j.input_sha256=v.sha256 AND j.job_type='DOCUMENT_SCAN' ORDER BY j.generation DESC LIMIT 1)),
  'backupJob',json((SELECT json_object('id',j.id,'generation',j.generation,'status',j.status,'attempt',j.attempt_count,'lease',j.lease_token_hash,'expires',j.lease_expires_at,'availableAt',j.available_at)
    FROM background_jobs j WHERE j.agency_id=v.agency_id AND j.document_version_id=v.id AND j.input_sha256=v.sha256 AND j.job_type='DOCUMENT_BACKUP' ORDER BY j.generation DESC LIMIT 1)),
  'copy',json((SELECT json_object('id',c.id,'key',c.object_key,'sha256',c.backup_sha256,'sourceSha256',c.source_sha256,'generation',j.generation,'jobId',j.id,'runStatus',r.status,'jobStatus',j.status,'attempt',r.attempt_number,'jobAttempt',j.attempt_count)
    FROM document_backup_copies c JOIN background_job_runs r ON r.agency_id=c.agency_id AND r.id=c.job_run_id
    JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
    WHERE c.agency_id=v.agency_id AND c.document_version_id=v.id AND j.job_type='DOCUMENT_BACKUP' ORDER BY j.generation DESC,r.attempt_number DESC LIMIT 1))
) FROM document_versions v JOIN documents d ON d.agency_id=v.agency_id AND d.id=v.document_id,args a
WHERE v.agency_id=a.agency AND (v.id=a.version_id OR (a.kind='PRIMARY' AND v.object_key=a.object_key)
  OR (a.kind='BACKUP' AND EXISTS(SELECT 1 FROM document_backup_copies c WHERE c.agency_id=v.agency_id AND c.document_version_id=v.id AND c.object_key=a.object_key))) LIMIT 1))) AS snapshot`;
const jobSchema = z.object({
  id,
  generation: z.number().int().positive(),
  status: z.string(),
  attempt: z.number().int().nonnegative(),
  lease: z.string().nullable(),
  expires: z.string().nullable(),
});
const copySchema = z.object({
  id,
  key: objectKey,
  sha256: z.string(),
  sourceSha256: z.string(),
  generation: z.number().int(),
  jobId: id,
  runStatus: z.string(),
  jobStatus: z.string(),
  attempt: z.number().int(),
  jobAttempt: z.number().int(),
});
const snapshotSchema = z.object({
  foreignOwner: z.number().int(),
  targetCopy: copySchema.nullable(),
  v: z
    .object({
      id,
      documentId: id,
      status: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      size: z
        .number()
        .int()
        .positive()
        .max(20 * 1024 * 1024),
      key: objectKey,
      number: z.number().int().positive(),
      latest: z.number().int().positive(),
      documentStatus: z.string(),
      documentVersion: z.number().int().positive(),
      current: id.nullable(),
      contentType: z.string(),
      scan: z
        .object({
          id,
          sha256: z.string(),
          outcome: z.string(),
          runStatus: z.string(),
          jobStatus: z.string(),
          generation: z.number().int(),
          inspectionVersion: z.string().nullable(),
          inspectionResult: z.string().nullable(),
        })
        .nullable(),
      scanJob: jobSchema.nullable(),
      backupJob: jobSchema.extend({ availableAt: z.string() }).nullable(),
      copy: copySchema.nullable(),
    })
    .nullable(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
function snapshotArgs(agency: string, target: DocumentReconcileTarget) {
  return 'versionId' in target
    ? [agency, target.versionId, null, null]
    : [agency, null, target.kind, target.objectKey];
}
async function readSnapshot(db: D1Database, agency: string, target: DocumentReconcileTarget) {
  const json = await db
    .prepare(SNAPSHOT)
    .bind(...snapshotArgs(agency, target))
    .first<string>('snapshot');
  if (!json) throw new Error('RECONCILE_SNAPSHOT_MISSING');
  return { json, state: snapshotSchema.parse(JSON.parse(json)) };
}
interface Claim {
  id: string;
  agency: string;
  attempt: number;
  maxAttempts: number;
  token: string;
  runId: string;
}
async function claimJob(db: D1Database, jobId: string, generation: number) {
  const row = await db
    .prepare(
      `SELECT agency_id,status,attempt_count,max_attempts FROM background_jobs WHERE id=? AND job_type='DOCUMENT_RECONCILE' AND generation=?`,
    )
    .bind(jobId, generation)
    .first<{ agency_id: string; status: string; attempt_count: number; max_attempts: number }>();
  if (!row || !['QUEUED', 'RETRY_WAIT'].includes(row.status)) return null;
  const claim: Claim = {
    id: jobId,
    agency: row.agency_id,
    attempt: row.attempt_count + 1,
    maxAttempts: row.max_attempts,
    token: digest(crypto.randomUUID()),
    runId: crypto.randomUUID(),
  };
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_jobs SET status='RUNNING',attempt_count=attempt_count+1,lease_token_hash=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+150 seconds'),updated_at=${NOW}
        WHERE id=? AND agency_id=? AND generation=? AND job_type='DOCUMENT_RECONCILE' AND status IN ('QUEUED','RETRY_WAIT') AND attempt_count=? AND attempt_count<max_attempts AND available_at<=${NOW}`,
        )
        .bind(claim.token, jobId, claim.agency, generation, row.attempt_count),
      assertion(db, 'DOCUMENT_RECONCILE_CLAIM_RACE'),
      db
        .prepare(
          'INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash) VALUES(?,?,?,?,?)',
        )
        .bind(claim.runId, claim.agency, jobId, claim.attempt, claim.token),
    ]);
    return claim;
  } catch (error) {
    if (conflict(error)) return null;
    throw error;
  }
}
interface Outcome {
  result: 'SAFE_NOOP' | 'SAFE_REPAIR' | 'INVESTIGATE';
  code: string;
  unpublish?: false;
}
function discrepancyKey(
  agency: string,
  target: DocumentReconcileTarget,
  state: Snapshot,
  code: string,
) {
  const v = state.v;
  const identity = state.targetCopy ? target : v ? { versionId: v.id } : target;
  return digest(
    JSON.stringify([
      agency,
      identity,
      code,
      v?.sha256,
      state.targetCopy?.id ?? v?.copy?.id,
      state.targetCopy?.generation ?? v?.backupJob?.generation,
      v?.scanJob?.generation,
    ]),
  );
}
async function complete(
  db: D1Database,
  claim: Claim,
  target: DocumentReconcileTarget,
  snapshot: string,
  deadline: string,
  outcome: Outcome = { result: 'SAFE_NOOP', code: 'SAFE_NOOP' },
): Promise<boolean> {
  const state = snapshotSchema.parse(JSON.parse(snapshot));
  const v = state.v;
  const investigate = outcome.result === 'INVESTIGATE';
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_job_runs SET status=?,reason_code=?,completed_at=${NOW}
        WHERE id=? AND status='RUNNING' AND lease_token_hash=? AND EXISTS(SELECT 1 FROM background_jobs WHERE id=? AND agency_id=? AND status='RUNNING' AND attempt_count=? AND lease_token_hash=? AND julianday(lease_expires_at)>julianday('now'))
        AND julianday(?)>=julianday('now') AND (SELECT snapshot FROM (${SNAPSHOT}))=?`,
        )
        .bind(
          investigate ? 'PERMANENT_ERROR' : 'SUCCEEDED',
          outcome.code,
          claim.runId,
          claim.token,
          claim.id,
          claim.agency,
          claim.attempt,
          claim.token,
          deadline,
          ...snapshotArgs(claim.agency, target),
          snapshot,
        ),
      assertion(db, 'DOCUMENT_RECONCILE_STATE_CHANGED'),
      // Revoke the live publication pointer, not immutable scan/backup evidence. No new
      // schema/state transition is needed; AVAILABLE alone never authorizes streaming.
      ...(investigate &&
      outcome.unpublish !== false &&
      v &&
      v.current === v.id &&
      v.number === v.latest
        ? [
            db
              .prepare(
                `UPDATE documents SET current_version_id=NULL,version=version+1,updated_at=${NOW} WHERE id=? AND agency_id=? AND version=? AND current_version_id=?`,
              )
              .bind(v.documentId, claim.agency, v.documentVersion, v.id),
            assertion(db, 'DOCUMENT_RECONCILE_UNPUBLISH_RACE'),
          ]
        : []),
      ...(outcome.result === 'SAFE_REPAIR' && v?.status === 'AVAILABLE' && v.current === null
        ? [
            db
              .prepare(
                `UPDATE documents SET current_version_id=?,version=version+1,updated_at=${NOW} WHERE id=? AND agency_id=? AND version=? AND current_version_id IS NULL AND status='ACTIVE'`,
              )
              .bind(v.id, v.documentId, claim.agency, v.documentVersion),
            assertion(db, 'DOCUMENT_RECONCILE_REPUBLISH_RACE'),
            db
              .prepare(
                `INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json) VALUES(?,?,'document-reconcile','document.reconcile.repaired','document_versions',?,?,?,'SUCCESS',?,?)`,
              )
              .bind(
                crypto.randomUUID(),
                claim.agency,
                v.id,
                claim.runId,
                claim.id,
                outcome.code,
                JSON.stringify({
                  versionId: v.id,
                  sha256: v.sha256,
                  jobId: claim.id,
                  runId: claim.runId,
                }),
              ),
          ]
        : []),
      ...(investigate
        ? [
            db
              .prepare(
                `INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json)
        VALUES(?,?,'document-reconcile','document.reconcile.discrepancy','background_jobs',?,?,?,'FAILURE',?,?)
        ON CONFLICT(agency_id,system_actor_code,action,idempotency_key) DO NOTHING`,
              )
              .bind(
                crypto.randomUUID(),
                claim.agency,
                claim.id,
                claim.runId,
                discrepancyKey(claim.agency, target, state, outcome.code),
                outcome.code,
                JSON.stringify({
                  versionId: v?.id ?? null,
                  ...('kind' in target ? { kind: target.kind, objectKey: target.objectKey } : {}),
                  sha256: v?.sha256 ?? null,
                  scanGeneration: v?.scanJob?.generation ?? null,
                  backupGeneration: v?.backupJob?.generation ?? null,
                  jobId: claim.id,
                  runId: claim.runId,
                }),
              ),
          ]
        : []),
      db
        .prepare(
          `UPDATE background_jobs SET status='COMPLETED',completed_at=${NOW},updated_at=${NOW},lease_token_hash=NULL,lease_expires_at=NULL,last_error_code=? WHERE id=? AND agency_id=? AND status='RUNNING' AND lease_token_hash=? AND attempt_count=?`,
        )
        .bind(
          investigate ? outcome.code : null,
          claim.id,
          claim.agency,
          claim.token,
          claim.attempt,
        ),
      assertion(db, 'DOCUMENT_RECONCILE_COMPLETE_RACE'),
    ]);
    return true;
  } catch (error) {
    if (conflict(error)) return false;
    throw error;
  }
}
export interface DocumentReconcileOptions {
  readonly timeoutMs?: number;
  readonly retryDelaySeconds?: (attempt: number) => number;
}
async function retryAttempt(
  db: D1Database,
  claim: Claim,
  code: string,
  options: DocumentReconcileOptions,
): Promise<DocumentReconcileResult> {
  const retry = claim.attempt < claim.maxAttempts;
  const requested =
    options.retryDelaySeconds?.(claim.attempt) ?? documentScanRetryDelaySeconds(claim.attempt);
  const delay =
    Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, 480)
      : documentScanRetryDelaySeconds(claim.attempt);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_job_runs SET status=?,reason_code=?,completed_at=${NOW} WHERE id=? AND status='RUNNING' AND lease_token_hash=?
        AND EXISTS(SELECT 1 FROM background_jobs WHERE id=? AND agency_id=? AND status='RUNNING' AND attempt_count=? AND lease_token_hash=? AND julianday(lease_expires_at)>julianday('now'))`,
        )
        .bind(
          retry ? 'RETRYABLE_ERROR' : 'PERMANENT_ERROR',
          code,
          claim.runId,
          claim.token,
          claim.id,
          claim.agency,
          claim.attempt,
          claim.token,
        ),
      assertion(db, 'DOCUMENT_RECONCILE_RETRY_RACE'),
      db
        .prepare(
          `UPDATE background_jobs SET status=?,last_error_code=?,queue_dispatched_at=NULL,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=${NOW},
        available_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now',?) ELSE available_at END,completed_at=CASE WHEN ? THEN NULL ELSE ${NOW} END
        WHERE id=? AND agency_id=? AND status='RUNNING' AND attempt_count=? AND lease_token_hash=?`,
        )
        .bind(
          retry ? 'RETRY_WAIT' : 'DEAD',
          code,
          retry ? 1 : 0,
          `+${delay} seconds`,
          retry ? 1 : 0,
          claim.id,
          claim.agency,
          claim.attempt,
          claim.token,
        ),
      assertion(db, 'DOCUMENT_RECONCILE_RETRY_JOB_RACE'),
    ]);
    return retry ? 'RETRY_SCHEDULED' : 'INVESTIGATE';
  } catch (error) {
    if (conflict(error)) return 'ACKED';
    throw error;
  }
}
function clean(v: NonNullable<Snapshot['v']>) {
  const s = v.scan;
  if (
    !s ||
    s.outcome !== 'CLEAN' ||
    s.sha256 !== v.sha256 ||
    s.runStatus !== 'SUCCEEDED' ||
    s.jobStatus !== 'COMPLETED' ||
    s.inspectionVersion !== REQUIRED_CONTENT_INSPECTION_VERSION ||
    !s.inspectionResult ||
    s.inspectionResult.length > 256 ||
    s.generation !== v.scanJob?.generation
  )
    return false;
  const side = z.number().int().positive();
  const inspection = z.union([
    z
      .object({ valid: z.literal(true), format: z.literal('PDF'), pageCount: side.max(200) })
      .strict(),
    z
      .object({
        valid: z.literal(true),
        format: z.literal('JPEG'),
        width: side.max(8192),
        height: side.max(8192),
        pixelCount: side.max(4000000),
      })
      .strict()
      .refine((i) => i.pixelCount === i.width * i.height),
    z
      .object({
        valid: z.literal(true),
        format: z.literal('PNG'),
        width: side,
        height: side,
        pixelCount: side.max(16000000),
        decompressedBytes: side.max(33554432),
      })
      .strict()
      .refine((i) => i.pixelCount === i.width * i.height),
  ]);
  try {
    const result = inspection.safeParse(JSON.parse(s.inspectionResult));
    return (
      result.success &&
      { PDF: 'application/pdf', JPEG: 'image/jpeg', PNG: 'image/png' }[result.data.format] ===
        v.contentType
    );
  } catch {
    return false;
  }
}
async function inspect(
  db: D1Database,
  storage: DocumentReconcileStorage,
  claim: Claim,
  target: DocumentReconcileTarget,
  snapshot: { json: string; state: Snapshot },
  signal: AbortSignal,
): Promise<Outcome> {
  const v = snapshot.state.v;
  const investigate = (code: string): Outcome => ({ result: 'INVESTIGATE', code });
  if (snapshot.state.foreignOwner) return investigate('RECONCILE_OWNER_MISMATCH');
  if (!v) {
    if ('versionId' in target) return investigate('RECONCILE_OWNER_MISSING');
    const object = await storage.observe(target.kind, target.objectKey, signal);
    return object
      ? investigate(`RECONCILE_ORPHAN_${target.kind}`)
      : { result: 'SAFE_NOOP', code: 'RECONCILE_OBJECT_ABSENT' };
  }
  if (
    'kind' in target &&
    target.kind === 'BACKUP' &&
    (snapshot.state.targetCopy?.key !== v.copy?.key ||
      v.number !== v.latest ||
      v.documentStatus !== 'ACTIVE')
  ) {
    const copy = snapshot.state.targetCopy;
    if (
      !copy ||
      copy.sha256 !== v.sha256 ||
      copy.sourceSha256 !== v.sha256 ||
      copy.runStatus !== 'SUCCEEDED' ||
      copy.jobStatus !== 'COMPLETED' ||
      copy.attempt !== copy.jobAttempt
    )
      return { ...investigate('RECONCILE_BACKUP_EVIDENCE_INVALID'), unpublish: false };
    const identity = {
      agencyId: claim.agency,
      documentVersionId: v.id,
      generation: copy.generation,
      sha256: v.sha256,
      sizeBytes: v.size,
    };
    try {
      return (await storage.verifyBackup(identity, target.objectKey, signal))
        ? { result: 'SAFE_NOOP', code: 'RECONCILE_HISTORICAL_BACKUP_VERIFIED' }
        : { ...investigate('RECONCILE_BACKUP_MISSING'), unpublish: false };
    } catch (error) {
      if (error instanceof DocumentBackupIntegrityError)
        return { ...investigate(integrityCode(error)), unpublish: false };
      throw error;
    }
  }
  if (v.number !== v.latest || v.documentStatus !== 'ACTIVE') {
    // An old VERSION job is obsolete, but an explicit object-key investigation
    // must still verify that exact historical object without changing publication.
    if ('kind' in target && target.kind === 'PRIMARY') {
      try {
        const object = await storage.observe('PRIMARY', target.objectKey, signal);
        if (!object) return { ...investigate('RECONCILE_PRIMARY_MISSING'), unpublish: false };
        if (
          object.sha256 !== v.sha256 ||
          object.sizeBytes !== v.size ||
          object.declaredSha256 !== v.sha256
        )
          return { ...investigate('RECONCILE_PRIMARY_CHECKSUM_MISMATCH'), unpublish: false };
        return { result: 'SAFE_NOOP', code: 'RECONCILE_HISTORICAL_PRIMARY_VERIFIED' };
      } catch (error) {
        if (error instanceof DocumentBackupIntegrityError)
          return { ...investigate(integrityCode(error)), unpublish: false };
        throw error;
      }
    }
    return { result: 'SAFE_NOOP', code: 'RECONCILE_TARGET_SUPERSEDED' };
  }
  const primary = await storage.observe('PRIMARY', v.key, signal);
  if (!primary) return investigate('RECONCILE_PRIMARY_MISSING');
  if (
    primary.sha256 !== v.sha256 ||
    primary.sizeBytes !== v.size ||
    primary.declaredSha256 !== v.sha256
  )
    return investigate('RECONCILE_PRIMARY_CHECKSUM_MISMATCH');
  // Upload is a user-authorized receipt mutation; bytes alone cannot authorize replay.
  if (v.status === 'PENDING_UPLOAD') return investigate('RECONCILE_UPLOAD_INTERRUPTED');
  if (!clean(v)) return investigate('RECONCILE_CLEAN_EVIDENCE_INVALID');
  if (v.status !== 'AVAILABLE' && v.status !== 'BACKUP_PENDING')
    return investigate('RECONCILE_VERSION_STATE_CONFLICT');
  const job = v.backupJob;
  if (!job) return investigate('RECONCILE_BACKUP_JOB_MISSING');
  const identity = {
    agencyId: claim.agency,
    documentVersionId: v.id,
    generation: job.generation,
    sha256: v.sha256,
    sizeBytes: v.size,
  };
  const key = documentBackupObjectKey(identity);
  const copy = v.copy;
  // A prior valid immutable copy remains historical evidence. It must not veto a
  // new, independently verified backup generation's interrupted finalization.
  const historicalCopy =
    copy &&
    v.status === 'BACKUP_PENDING' &&
    copy.generation < job.generation &&
    copy.sha256 === v.sha256 &&
    copy.sourceSha256 === v.sha256 &&
    copy.runStatus === 'SUCCEEDED' &&
    copy.jobStatus === 'COMPLETED' &&
    copy.attempt === copy.jobAttempt;
  if (
    copy &&
    !historicalCopy &&
    (copy.sha256 !== v.sha256 ||
      copy.sourceSha256 !== v.sha256 ||
      copy.generation !== job.generation ||
      copy.jobId !== job.id ||
      copy.key !== key ||
      copy.runStatus !== 'SUCCEEDED' ||
      copy.jobStatus !== 'COMPLETED' ||
      copy.attempt !== copy.jobAttempt)
  )
    return investigate('RECONCILE_BACKUP_EVIDENCE_INVALID');
  if (!(await storage.verifyBackup(identity, key, signal)))
    return investigate('RECONCILE_BACKUP_MISSING');
  if (v.status === 'AVAILABLE') {
    if (!copy) return investigate('RECONCILE_BACKUP_EVIDENCE_MISSING');
    return {
      result: v.current === v.id ? 'SAFE_NOOP' : 'SAFE_REPAIR',
      code: v.current === v.id ? 'SAFE_NOOP' : 'RECONCILE_PUBLICATION_REPAIRED',
    };
  }
  if ((copy && !historicalCopy) || job.status === 'COMPLETED' || job.status === 'DEAD')
    return investigate('RECONCILE_JOB_STATE_CONFLICT');
  // Re-read the complete durable snapshot immediately before invoking the existing executor.
  // It owns its own lease/CAS and independently checks all prerequisites at finalization.
  if ((await readSnapshot(db, claim.agency, target)).json !== snapshot.json)
    throw new Error('RECONCILE_STATE_CHANGED');
  const result = await processDocumentBackupMessage(
    db,
    safeNestedPrimary(storage.primary),
    {
      async createAndVerify(input, bytes, backupSignal) {
        // No create/write fallback: only an already-existing exact immutable copy is eligible.
        if (
          input.agencyId !== identity.agencyId ||
          input.documentVersionId !== identity.documentVersionId ||
          input.generation !== identity.generation ||
          input.sha256 !== identity.sha256 ||
          input.sizeBytes !== identity.sizeBytes ||
          bytes.byteLength !== identity.sizeBytes ||
          digestBytes(bytes) !== identity.sha256
        )
          throw new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH');
        signal.throwIfAborted();
        try {
          const proof = await storage.verifyBackup(
            identity,
            key,
            AbortSignal.any([signal, backupSignal]),
          );
          if (!proof) throw new Error('RECONCILE_BACKUP_DISAPPEARED');
          // Read every external field inside the sanitization boundary, once. Never
          // return an adapter alias/getter-bearing proof to the durable executor.
          const fields = {
            objectKey: proof.objectKey,
            agencyId: proof.agencyId,
            documentVersionId: proof.documentVersionId,
            generation: proof.generation,
            sha256: proof.sha256,
            sizeBytes: proof.sizeBytes,
          };
          if (
            fields.objectKey !== key ||
            fields.agencyId !== identity.agencyId ||
            fields.documentVersionId !== identity.documentVersionId ||
            fields.generation !== identity.generation ||
            fields.sha256 !== identity.sha256 ||
            fields.sizeBytes !== identity.sizeBytes
          )
            throw new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH');
          return Object.freeze({ ...identity, objectKey: key });
        } catch (error) {
          // The accepted executor persists integrity codes, including at exhaustion.
          // Never forward arbitrary verifier text across this nested boundary.
          throw safeNestedVerifierError(error);
        }
      },
    },
    {
      jobId: job.id,
      jobType: 'DOCUMENT_BACKUP',
      generation: job.generation,
      documentVersionId: v.id,
      inputSha256: v.sha256,
    },
  );
  if (result !== 'COMPLETED') throw new Error('RECONCILE_BACKUP_PROGRESS_PENDING');
  return { result: 'SAFE_REPAIR', code: 'RECONCILE_BACKUP_FINALIZED' };
}
const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function isNestedIntegrityFailure(error: unknown): boolean {
  try {
    return error instanceof DocumentBackupIntegrityError;
  } catch {
    return false;
  }
}
function safeNestedVerifierError(error: unknown): Error {
  // Do not retain an untrusted cause or error object at the durable boundary.
  return isNestedIntegrityFailure(error)
    ? new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH')
    : new Error('RECONCILE_BACKUP_VERIFY_FAILED');
}
/** A private verification-only view for the accepted executor. Both get and stream
 * rejection boundaries must sanitize external integrity codes before it persists them. */
function safeNestedPrimary(primary: Pick<R2Bucket, 'get'>): Pick<R2Bucket, 'get'> {
  const nativeByteLength = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    'byteLength',
  )!.get!;
  const safeError = (error: unknown) =>
    isNestedIntegrityFailure(error)
      ? new DocumentBackupIntegrityError('BACKUP_SOURCE_IDENTITY_INVALID')
      : new Error('RECONCILE_PRIMARY_READ_FAILED');
  return {
    async get(key: string): Promise<R2ObjectBody | null> {
      let object: R2ObjectBody | null = null;
      try {
        object = await primary.get(key);
        if (!object) return null;
        // Capture only the fields the accepted source verifier consumes. Do not forward
        // metadata getters or raw confidential fields across another await boundary.
        const size = object.size;
        const customMetadata = { sha256: object.customMetadata?.sha256 ?? '' };
        const reader = object.body.getReader();
        const release = () => {
          try {
            reader.releaseLock();
          } catch {
            /* cancellation may still be pending */
          }
        };
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const result = await reader.read();
                if (result.done) {
                  controller.close();
                  release();
                } else {
                  // Native internal-slot length ignores subclass accessors. Native set
                  // copies actual bytes without constructor/species or iterator callbacks.
                  const length = Reflect.apply(nativeByteLength, result.value, []) as number;
                  if (
                    !Number.isSafeInteger(length) ||
                    length < 1 ||
                    length > size ||
                    length > 20 * 1024 * 1024
                  )
                    throw new DocumentBackupIntegrityError('BACKUP_SOURCE_IDENTITY_INVALID');
                  const chunk = new Uint8Array(length);
                  Uint8Array.prototype.set.call(chunk, result.value);
                  controller.enqueue(chunk);
                }
              } catch (error) {
                controller.error(safeError(error));
                void reader
                  .cancel()
                  .catch(() => undefined)
                  .finally(release);
              }
            },
            async cancel() {
              try {
                await reader.cancel();
              } catch (error) {
                throw safeError(error);
              } finally {
                release();
              }
            },
          },
          { highWaterMark: 0 },
        );
        // This facade is internal to readSource: no R2 header/body helper is consumed.
        return Object.create(object, {
          size: { value: size },
          customMetadata: { value: customMetadata },
          body: { value: body },
        }) as R2ObjectBody;
      } catch (error) {
        try {
          void object?.body.cancel().catch(() => undefined);
        } catch {
          /* best-effort release only */
        }
        throw safeError(error);
      }
    },
  };
}
function integrityCode(error: DocumentBackupIntegrityError) {
  const allowed = [
    'RECONCILE_OBJECT_KEY_INVALID',
    'RECONCILE_OBJECT_SIZE_INVALID',
    'RECONCILE_OBJECT_LENGTH_MISMATCH',
    'RECONCILE_BACKUP_IDENTITY_MISMATCH',
    'RECONCILE_BACKUP_CHECKSUM_MISMATCH',
  ];
  return allowed.includes(error.code) ? error.code : 'RECONCILE_OBJECT_INTEGRITY_INVALID';
}
/** The legacy DLQ table requires non-null scan/backup inputs. Reconcile exhaustion
 * instead uses the existing immutable SYSTEM audit, keyed by exact durable job identity. */
export async function persistDocumentReconcileQueueExhaustion(
  db: D1Database,
  message: DocumentJobQueueMessage,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT agency_id FROM background_jobs WHERE id=? AND job_type='DOCUMENT_RECONCILE' AND generation=? AND document_version_id IS NULL AND input_sha256 IS NULL`,
    )
    .bind(message.jobId, message.generation)
    .first<{ agency_id: string }>();
  if (!row) return false;
  await db.batch([
    db
      .prepare(
        `INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json)
      SELECT ?,agency_id,'document-reconcile','document.reconcile.queue_exhausted','background_jobs',id,id,?,'FAILURE','QUEUE_DELIVERY_EXHAUSTED',?
      FROM background_jobs WHERE id=? AND agency_id=? AND job_type='DOCUMENT_RECONCILE' AND generation=?
      ON CONFLICT(agency_id,system_actor_code,action,idempotency_key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        digest(JSON.stringify([message.jobId, message.generation])),
        JSON.stringify({ jobId: message.jobId, generation: message.generation }),
        message.jobId,
        row.agency_id,
        message.generation,
      ),
    db
      .prepare(
        `UPDATE background_jobs SET last_error_code='QUEUE_DELIVERY_EXHAUSTED',updated_at=${NOW} WHERE id=? AND agency_id=? AND job_type='DOCUMENT_RECONCILE' AND generation=? AND status NOT IN ('COMPLETED','DEAD')`,
      )
      .bind(message.jobId, row.agency_id, message.generation),
  ]);
  return true;
}
export async function processDocumentReconcileMessage(
  db: D1Database,
  storage: DocumentReconcileStorage,
  value: unknown,
  options: DocumentReconcileOptions = {},
): Promise<DocumentReconcileResult> {
  const message = z
    .object({
      jobId: id,
      jobType: z.literal('DOCUMENT_RECONCILE'),
      generation: z.number().int().positive(),
      documentVersionId: z.null(),
      inputSha256: z.null(),
    })
    .safeParse(value);
  if (!message.success) return 'ACKED';
  const controller = new AbortController();
  const timeout =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(120000, Math.floor(options.timeoutMs)))
      : 120000;
  const deadline = new Date(Date.now() + timeout).toISOString();
  const timer = setTimeout(() => controller.abort(), timeout);
  const { signal } = controller;
  let claim: Claim | null = null;
  try {
    claim = await backupAbortable(
      claimJob(db, message.data.jobId, message.data.generation),
      signal,
    );
    if (!claim) return 'ACKED';
    const raw = await backupAbortable(
      db
        .prepare(
          `SELECT metadata_json FROM system_audit_events WHERE agency_id=? AND system_actor_code='document-reconcile' AND action='document.reconcile.requested' AND target_type='background_jobs' AND target_id=? AND idempotency_key=? AND outcome='SUCCESS' AND reason_code='TARGET_BOUND'`,
        )
        .bind(claim.agency, claim.id, claim.id)
        .first<string>('metadata_json'),
      signal,
    );
    if (!raw) throw new Error('RECONCILE_TARGET_MISSING');
    const target = targetSchema.parse(JSON.parse(raw));
    let snapshot = await backupAbortable(readSnapshot(db, claim.agency, target), signal);
    let outcome: Outcome;
    try {
      outcome = await backupAbortable(
        inspect(db, storage, claim, target, snapshot, signal),
        signal,
      );
    } catch (error) {
      if (!(error instanceof DocumentBackupIntegrityError)) throw error;
      outcome = { result: 'INVESTIGATE', code: integrityCode(error) };
    }
    // Backup executor legitimately advanced D1. Verify the resulting state again instead of
    // treating a fresh read alone as success or letting a later mutation inherit old byte proof.
    if (outcome.code === 'RECONCILE_BACKUP_FINALIZED') {
      snapshot = await backupAbortable(readSnapshot(db, claim.agency, target), signal);
      const verified = await backupAbortable(
        inspect(db, storage, claim, target, snapshot, signal),
        signal,
      );
      if (verified.result !== 'SAFE_NOOP') throw new Error('RECONCILE_STATE_CHANGED');
    }
    if (
      await backupAbortable(complete(db, claim, target, snapshot.json, deadline, outcome), signal)
    )
      return outcome.result;
    return await retryAttempt(db, claim, 'RECONCILE_STATE_CHANGED', options);
  } catch {
    if (!claim || signal.aborted) return 'RETRY_DELIVERY';
    try {
      return await retryAttempt(db, claim, 'RECONCILE_IO_OR_STATE_CHANGED', options);
    } catch {
      return 'RETRY_DELIVERY';
    }
  } finally {
    clearTimeout(timer);
  }
}
