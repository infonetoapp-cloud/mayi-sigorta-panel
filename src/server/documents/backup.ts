import { createHash } from 'node:crypto';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import { REQUIRED_CONTENT_INSPECTION_VERSION } from './content-inspection';
import {
  documentScanRetryDelaySeconds,
  reclaimExpiredDocumentBackupJob,
  type DocumentJobQueueMessage,
} from './queue';
import {
  backupAbortable,
  documentBackupObjectKey,
  DocumentBackupIntegrityError,
  type DocumentBackupAdapter,
  type DocumentBackupIdentity,
  type DocumentBackupProof,
} from './backup-storage';

export type DocumentBackupProcessingResult =
  'COMPLETED' | 'ACKED' | 'FAILED_CLOSED' | 'RETRY_SCHEDULED' | 'RETRY_DELIVERY';
export interface DocumentBackupProcessingOptions {
  /** Tests can shorten, never extend, the production deadline. */
  readonly timeoutMs?: number;
  readonly retryDelaySeconds?: (attempt: number) => number;
}
interface BackupJobRow {
  id: string;
  agency_id: string;
  document_version_id: string;
  input_sha256: string;
  generation: number;
  status: string;
  attempt_count: number;
  max_attempts: number;
  object_key: string;
  size_bytes: number;
  document_id: string;
  validation_evidence_id: string | null;
  lease_token_hash: string | null;
  lease_expired: number;
}
interface Claim {
  readonly row: BackupJobRow;
  readonly runId: string;
  readonly token: string;
  readonly attempt: number;
}
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
// Immutable structural acceptance is separate from historical antivirus evidence.
// The view accepts new validated bytes without asserting a malware verdict.
// Recheck before reads/writes and in final CAS across every await.
// A lease may also be claimed to terminate an obsolete job without reading/copying bytes;
// leaving it active would block creation of the next backup generation after a rescan.
const ELIGIBLE = `version.sha256=job.input_sha256 AND version.status='BACKUP_PENDING'
  AND document.status='ACTIVE'
  AND version.version_number=(SELECT max(v.version_number) FROM document_versions v
    WHERE v.agency_id=version.agency_id AND v.document_id=version.document_id)
  AND job.generation=(SELECT max(j.generation) FROM background_jobs j
    WHERE j.agency_id=job.agency_id AND j.job_type='DOCUMENT_BACKUP'
      AND j.document_version_id=job.document_version_id AND j.input_sha256=job.input_sha256)
  AND EXISTS (SELECT 1 FROM document_accepted_validation inspection
    WHERE inspection.agency_id=version.agency_id AND inspection.document_version_id=version.id
      AND inspection.sha256=version.sha256
      AND inspection.id=? AND inspection.content_inspection_version=?
      AND inspection.content_inspection_result IS NOT NULL)`;
const JOINS = `JOIN document_versions version ON version.agency_id=job.agency_id AND version.id=job.document_version_id
  JOIN documents document ON document.agency_id=version.agency_id AND document.id=version.document_id`;

function assertion(db: D1Database, code: string) {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), code);
}
function casFailure(error: unknown) {
  return error instanceof Error && error.message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT');
}
function matches(message: DocumentJobQueueMessage, row: BackupJobRow) {
  return (
    message.jobType === 'DOCUMENT_BACKUP' &&
    row.id === message.jobId &&
    row.generation === message.generation &&
    row.document_version_id === message.documentVersionId &&
    row.input_sha256 === message.inputSha256
  );
}
function parseMessage(value: unknown): DocumentJobQueueMessage | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const m = value as DocumentJobQueueMessage;
    if (
      m.jobType !== 'DOCUMENT_BACKUP' ||
      typeof m.jobId !== 'string' ||
      !m.jobId.trim() ||
      m.jobId.length > 255 ||
      !Number.isSafeInteger(m.generation) ||
      m.generation < 1 ||
      typeof m.documentVersionId !== 'string' ||
      !m.documentVersionId.trim() ||
      m.documentVersionId.length > 255 ||
      typeof m.inputSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(m.inputSha256)
    )
      return null;
    return {
      jobId: m.jobId,
      jobType: 'DOCUMENT_BACKUP',
      generation: m.generation,
      documentVersionId: m.documentVersionId,
      inputSha256: m.inputSha256,
    };
  } catch {
    return null;
  }
}
async function loadJob(db: D1Database, message: DocumentJobQueueMessage) {
  return db
    .prepare(
      `SELECT job.*,version.object_key,version.size_bytes,version.document_id,
    CASE WHEN julianday(job.lease_expires_at)<=julianday('now') THEN 1 ELSE 0 END AS lease_expired,
    (SELECT latest.id FROM document_accepted_validation latest
     WHERE latest.agency_id=job.agency_id AND latest.document_version_id=job.document_version_id
       AND latest.sha256=job.input_sha256) AS validation_evidence_id
    FROM background_jobs job ${JOINS} WHERE job.id=? AND job.job_type='DOCUMENT_BACKUP'`,
    )
    .bind(message.jobId)
    .first<BackupJobRow>();
}
async function claimJob(
  db: D1Database,
  row: BackupJobRow,
  deadline: string,
): Promise<Claim | null> {
  const token = createHash('sha256').update(crypto.randomUUID()).digest('hex');
  const runId = crypto.randomUUID();
  const attempt = row.attempt_count + 1;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_jobs SET status='RUNNING',attempt_count=attempt_count+1,
        lease_token_hash=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+150 seconds'),updated_at=${NOW}
        WHERE id=? AND agency_id=? AND job_type='DOCUMENT_BACKUP' AND generation=?
          AND document_version_id=? AND input_sha256=? AND attempt_count=?
          AND attempt_count<max_attempts AND status IN ('QUEUED','RETRY_WAIT') AND available_at<=${NOW}
          AND julianday(?)>=julianday('now')
          AND EXISTS (SELECT 1 FROM background_jobs job ${JOINS}
            WHERE job.id=background_jobs.id AND version.sha256=job.input_sha256
              AND job.generation=(SELECT max(j.generation) FROM background_jobs j
                WHERE j.agency_id=job.agency_id AND j.job_type='DOCUMENT_BACKUP'
                  AND j.document_version_id=job.document_version_id AND j.input_sha256=job.input_sha256))`,
        )
        .bind(
          token,
          row.id,
          row.agency_id,
          row.generation,
          row.document_version_id,
          row.input_sha256,
          row.attempt_count,
          deadline,
        ),
      assertion(db, 'DOCUMENT_BACKUP_CLAIM_RACE'),
      db
        .prepare(
          'INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash) VALUES(?,?,?,?,?)',
        )
        .bind(runId, row.agency_id, row.id, attempt, token),
    ]);
    return { row, runId, token, attempt };
  } catch (error) {
    if (casFailure(error)) return null;
    throw error;
  }
}
function liveClaim(
  claim: Claim,
  deadline: string,
): { sql: string; values: (string | number | null)[] } {
  const { row } = claim;
  return {
    sql: `job.id=? AND job.agency_id=? AND job.job_type='DOCUMENT_BACKUP' AND job.generation=?
      AND job.document_version_id=? AND job.input_sha256=? AND job.status='RUNNING'
      AND job.attempt_count=? AND job.lease_token_hash=?
      AND julianday(job.lease_expires_at)>julianday('now') AND julianday(?)>=julianday('now')`,
    values: [
      row.id,
      row.agency_id,
      row.generation,
      row.document_version_id,
      row.input_sha256,
      claim.attempt,
      claim.token,
      deadline,
    ],
  };
}
async function finalize(
  db: D1Database,
  claim: Claim,
  proof: DocumentBackupProof,
  deadline: string,
): Promise<boolean> {
  const { row } = claim;
  const live = liveClaim(claim, deadline);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_job_runs SET status='SUCCEEDED',completed_at=${NOW}
        WHERE id=? AND agency_id=? AND job_id=? AND attempt_number=? AND lease_token_hash=? AND status='RUNNING'
          AND EXISTS(SELECT 1 FROM background_jobs job ${JOINS} WHERE ${live.sql} AND ${ELIGIBLE})`,
        )
        .bind(
          claim.runId,
          row.agency_id,
          row.id,
          claim.attempt,
          claim.token,
          ...live.values,
          row.validation_evidence_id,
          REQUIRED_CONTENT_INSPECTION_VERSION,
        ),
      assertion(db, 'DOCUMENT_BACKUP_FINALIZE_RUN_RACE'),
      db
        .prepare(
          `UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,lease_expires_at=NULL,
        completed_at=${NOW},updated_at=${NOW},last_error_code=CASE WHEN last_error_code='QUEUE_DELIVERY_EXHAUSTED' THEN last_error_code ELSE NULL END
        WHERE id=? AND agency_id=? AND status='RUNNING' AND attempt_count=? AND lease_token_hash=?
          AND EXISTS(SELECT 1 FROM background_jobs job WHERE ${live.sql})`,
        )
        .bind(row.id, row.agency_id, claim.attempt, claim.token, ...live.values),
      assertion(db, 'DOCUMENT_BACKUP_FINALIZE_JOB_RACE'),
      db
        .prepare(
          `INSERT INTO document_backup_copies(id,agency_id,document_version_id,job_run_id,source_sha256,object_key,backup_sha256)
        VALUES(?,?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          row.agency_id,
          row.document_version_id,
          claim.runId,
          row.input_sha256,
          proof.objectKey,
          proof.sha256,
        ),
      db
        .prepare(
          `UPDATE document_versions SET status='AVAILABLE',updated_at=${NOW}
        WHERE id=? AND agency_id=? AND sha256=? AND status='BACKUP_PENDING'`,
        )
        .bind(row.document_version_id, row.agency_id, row.input_sha256),
      assertion(db, 'DOCUMENT_BACKUP_AVAILABLE_RACE'),
      db
        .prepare(
          `UPDATE documents SET current_version_id=?,version=version+1,updated_at=${NOW}
        WHERE id=? AND agency_id=? AND status='ACTIVE' AND current_version_id IS NOT ?`,
        )
        .bind(row.document_version_id, row.document_id, row.agency_id, row.document_version_id),
      assertion(db, 'DOCUMENT_BACKUP_POINTER_RACE'),
      db
        .prepare(
          `INSERT INTO system_audit_events(id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json)
        VALUES(?,?,'document-backup','document.backup.completed','document_versions',?,?,?,'SUCCESS','BACKUP_VERIFIED',?)`,
        )
        .bind(
          crypto.randomUUID(),
          row.agency_id,
          row.document_version_id,
          claim.runId,
          row.id,
          JSON.stringify({
            jobId: row.id,
            runId: claim.runId,
            attempt: claim.attempt,
            generation: row.generation,
            sha256: row.input_sha256,
          }),
        ),
    ]);
    return true;
  } catch (error) {
    if (casFailure(error)) return false;
    throw error;
  }
}
async function failAttempt(
  db: D1Database,
  claim: Claim,
  code: string,
  permanent: boolean,
  deadline: string,
  options: DocumentBackupProcessingOptions,
): Promise<DocumentBackupProcessingResult> {
  const { row } = claim;
  const retry = !permanent && claim.attempt < row.max_attempts;
  const requested =
    options.retryDelaySeconds?.(claim.attempt) ?? documentScanRetryDelaySeconds(claim.attempt);
  const delay =
    Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, 480)
      : documentScanRetryDelaySeconds(claim.attempt);
  const live = liveClaim(claim, deadline);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_job_runs SET status=?,reason_code=?,completed_at=${NOW}
        WHERE id=? AND agency_id=? AND status='RUNNING' AND lease_token_hash=?
          AND EXISTS(SELECT 1 FROM background_jobs job WHERE ${live.sql})`,
        )
        .bind(
          permanent || !retry ? 'PERMANENT_ERROR' : 'RETRYABLE_ERROR',
          code,
          claim.runId,
          row.agency_id,
          claim.token,
          ...live.values,
        ),
      assertion(db, 'DOCUMENT_BACKUP_FAILURE_RUN_RACE'),
      db
        .prepare(
          `UPDATE background_jobs SET status=?,lease_token_hash=NULL,lease_expires_at=NULL,
        queue_dispatched_at=NULL,last_error_code=?,updated_at=${NOW},
        available_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now',?) ELSE available_at END,
        completed_at=CASE WHEN ? THEN NULL ELSE ${NOW} END
        WHERE id=? AND agency_id=? AND status='RUNNING' AND attempt_count=? AND lease_token_hash=?`,
        )
        .bind(
          retry ? 'RETRY_WAIT' : 'DEAD',
          code,
          retry ? 1 : 0,
          `+${delay} seconds`,
          retry ? 1 : 0,
          row.id,
          row.agency_id,
          claim.attempt,
          claim.token,
        ),
      assertion(db, 'DOCUMENT_BACKUP_FAILURE_JOB_RACE'),
    ]);
    return retry ? 'RETRY_SCHEDULED' : 'FAILED_CLOSED';
  } catch (error) {
    if (casFailure(error)) return 'ACKED';
    throw error;
  }
}
async function readSource(
  storage: Pick<R2Bucket, 'get'>,
  row: BackupJobRow,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(row.size_bytes) ||
    row.size_bytes < 1 ||
    row.size_bytes > MAX_DOCUMENT_UPLOAD_BYTES ||
    !/^quarantine\/[0-9a-f-]{36}$/u.test(row.object_key)
  )
    throw new DocumentBackupIntegrityError('BACKUP_SOURCE_IDENTITY_INVALID');
  const read = storage.get(row.object_key);
  let object: R2ObjectBody | null;
  try {
    object = await backupAbortable(read, signal);
  } catch (error) {
    void read.then((object) => object?.body.cancel()).catch(() => undefined);
    throw error;
  }
  if (!object) throw new Error('BACKUP_SOURCE_MISSING');
  if (object.size !== row.size_bytes || object.customMetadata?.sha256 !== row.input_sha256) {
    void object.body.cancel().catch(() => undefined);
    throw new DocumentBackupIntegrityError('BACKUP_SOURCE_METADATA_MISMATCH');
  }
  // One size-bounded buffer, no tee/unbounded chunks or duplicate whole-file materialization.
  const bytes = new Uint8Array(row.size_bytes);
  const reader = object.body.getReader();
  let size = 0;
  const hash = createHash('sha256');
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await backupAbortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > bytes.byteLength)
        throw new DocumentBackupIntegrityError('BACKUP_SOURCE_LENGTH_MISMATCH');
      bytes.set(value, size - value.byteLength);
      hash.update(value);
    }
    if (size !== bytes.byteLength || hash.digest('hex') !== row.input_sha256)
      throw new DocumentBackupIntegrityError('BACKUP_SOURCE_CHECKSUM_MISMATCH');
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  return bytes;
}

export async function processDocumentBackupMessage(
  db: D1Database,
  source: Pick<R2Bucket, 'get'>,
  backup: DocumentBackupAdapter,
  value: unknown,
  options: DocumentBackupProcessingOptions = {},
): Promise<DocumentBackupProcessingResult> {
  const message = parseMessage(value);
  if (!message) return 'ACKED';
  const requested = options.timeoutMs;
  const timeout =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.min(120000, Math.max(1, Math.floor(requested)))
      : 120000;
  const controller = new AbortController();
  const deadline = new Date(Date.now() + timeout).toISOString();
  const timer = setTimeout(() => controller.abort(), timeout);
  const { signal } = controller;
  try {
    const row = await backupAbortable(loadJob(db, message), signal);
    if (!row || !matches(message, row)) return 'ACKED';
    if (row.status === 'RUNNING' && row.lease_expired === 1 && row.lease_token_hash) {
      await backupAbortable(
        reclaimExpiredDocumentBackupJob(db, {
          id: row.id,
          agencyId: row.agency_id,
          attemptCount: row.attempt_count,
          maxAttempts: row.max_attempts,
          leaseTokenHash: row.lease_token_hash,
        }),
        signal,
      );
      return 'ACKED';
    }
    if (!['QUEUED', 'RETRY_WAIT'].includes(row.status)) return 'ACKED';
    const claim = await backupAbortable(claimJob(db, row, deadline), signal);
    if (!claim) return 'ACKED';
    try {
      const live = liveClaim(claim, deadline);
      const eligible = () =>
        backupAbortable(
          db
            .prepare(`SELECT 1 FROM background_jobs job ${JOINS} WHERE ${live.sql} AND ${ELIGIBLE}`)
            .bind(...live.values, row.validation_evidence_id, REQUIRED_CONTENT_INSPECTION_VERSION)
            .first(),
          signal,
        );
      const obsolete = () =>
        backupAbortable(
          failAttempt(db, claim, 'BACKUP_PREREQUISITES_CHANGED', true, deadline, options),
          signal,
        );
      if (!(await eligible())) return await obsolete();
      const bytes = await readSource(source, row, signal);
      // Re-read durable eligibility AFTER reading source and immediately BEFORE any backup write.
      if (!(await eligible())) return await obsolete();
      const identity: DocumentBackupIdentity = {
        agencyId: row.agency_id,
        documentVersionId: row.document_version_id,
        generation: row.generation,
        sha256: row.input_sha256,
        sizeBytes: row.size_bytes,
      };
      const proof = await backupAbortable(backup.createAndVerify(identity, bytes, signal), signal);
      if (
        proof.objectKey !== documentBackupObjectKey(identity) ||
        proof.agencyId !== identity.agencyId ||
        proof.documentVersionId !== identity.documentVersionId ||
        proof.generation !== identity.generation ||
        proof.sha256 !== identity.sha256 ||
        proof.sizeBytes !== identity.sizeBytes
      )
        throw new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH');
      return (await backupAbortable(finalize(db, claim, proof, deadline), signal))
        ? 'COMPLETED'
        : await obsolete();
    } catch (error) {
      if (signal.aborted) return 'RETRY_DELIVERY';
      if (error instanceof DocumentBackupIntegrityError)
        return await backupAbortable(
          failAttempt(db, claim, error.code, true, deadline, options),
          signal,
        );
      // D1 failure after object write is not rollback: keep the immutable object and retry safely.
      return await backupAbortable(
        failAttempt(db, claim, 'BACKUP_IO_OR_FINALIZE_FAILED', false, deadline, options),
        signal,
      );
    }
  } catch {
    return 'RETRY_DELIVERY';
  } finally {
    clearTimeout(timer);
  }
}
