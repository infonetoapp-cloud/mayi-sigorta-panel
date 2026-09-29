import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import {
  documentScanRetryDelaySeconds,
  reclaimExpiredDocumentScanJob,
  type DocumentJobQueueMessage,
} from './queue';

const SCAN_LEASE_SECONDS = 150;
const SCAN_TIMEOUT_MS = 120_000;
export const DOCUMENT_SCAN_DEAD_LETTER_QUEUE = 'mayisigorta-document-scan-dead-letter';
export const DOCUMENT_SCAN_OVERFLOW_QUEUE = 'mayisigorta-document-scan-dead-letter-overflow';
export const DOCUMENT_SCAN_TERMINAL_QUEUE = 'mayisigorta-document-scan-dead-letter-terminal';
type DocumentScanDeadLetterQueueName =
  | typeof DOCUMENT_SCAN_DEAD_LETTER_QUEUE
  | typeof DOCUMENT_SCAN_OVERFLOW_QUEUE
  | typeof DOCUMENT_SCAN_TERMINAL_QUEUE;
const MAX_SIGNATURE_AGE_MS = 48 * 60 * 60 * 1000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export type DocumentScannerResult =
  | {
      readonly outcome: 'CLEAN' | 'INFECTED';
      readonly sha256: string;
      readonly scannerEngineVersion: string;
      readonly signatureVersion: string;
      readonly signatureUpdatedAt: string;
    }
  | {
      readonly outcome: 'INVALID';
      readonly sha256: string;
      readonly reasonCode: string;
    }
  | {
      readonly outcome: 'UNKNOWN';
      readonly reasonCode: string;
    };

export interface DocumentScannerRequest {
  readonly body: ReadableStream<Uint8Array>;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly signal: AbortSignal;
}

export interface DocumentScannerAdapter {
  scan(request: DocumentScannerRequest): Promise<unknown>;
}

export type DocumentScanProcessingResult =
  'COMPLETED' | 'RETRY_SCHEDULED' | 'FAILED_CLOSED' | 'ACKED' | 'RETRY_DELIVERY';

export interface DocumentScanProcessingOptions {
  /** Shorten the production deadline for deterministic tests; callers cannot extend it. */
  readonly scanTimeoutMs?: number;
  /** Shorten retry delays in deterministic tests; production callers leave this unset. */
  readonly retryDelaySeconds?: (attemptNumber: number) => number;
  /** Replace the digest await in tests; Worker callers must leave this unset. */
  readonly digestBytes?: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
}

interface ScanJobRow {
  readonly id: string;
  readonly agency_id: string;
  readonly job_type: string;
  readonly generation: number;
  readonly document_version_id: string;
  readonly input_sha256: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly available_at: string;
  readonly lease_token_hash: string | null;
  readonly lease_expires_at: string | null;
  readonly lease_expired: number;
  readonly object_key: string;
  readonly size_bytes: number;
  readonly detected_content_type: string;
  readonly version_status: string;
}

interface ScanClaim {
  readonly jobId: string;
  readonly agencyId: string;
  readonly generation: number;
  readonly documentVersionId: string;
  readonly inputSha256: string;
  readonly attemptNumber: number;
  readonly runId: string;
  readonly leaseTokenHash: string;
  readonly maxAttempts: number;
}

interface ScannerEvidence {
  readonly outcome: 'CLEAN' | 'INFECTED' | 'INVALID' | 'ERROR';
  readonly runStatus: 'SUCCEEDED' | 'INFECTED' | 'PERMANENT_ERROR';
  readonly reasonCode: string | null;
  readonly scannerEngineVersion: string | null;
  readonly signatureVersion: string | null;
  readonly signatureUpdatedAt: string | null;
}

class ScanInputTooLargeError extends Error {
  constructor() {
    super('SCAN_INPUT_TOO_LARGE');
  }
}

class ScannerTimeoutError extends Error {
  constructor() {
    super('SCANNER_TIMEOUT');
  }
}

export const unavailableDocumentScanner: DocumentScannerAdapter = {
  async scan({ body }): Promise<DocumentScannerResult> {
    await body.cancel().catch(() => undefined);
    return { outcome: 'UNKNOWN', reasonCode: 'SCANNER_UNAVAILABLE' };
  },
};

function safeReasonCode(value: unknown, fallback = 'SCANNER_INVALID_RESPONSE'): string {
  return typeof value === 'string' && SAFE_REASON_CODE.test(value) ? value : fallback;
}

function parseScannerResult(value: unknown): DocumentScannerResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const record = value as Record<string, unknown>;
    if (record.outcome === 'UNKNOWN') {
      return {
        outcome: 'UNKNOWN',
        reasonCode: safeReasonCode(record.reasonCode, 'SCANNER_UNKNOWN'),
      };
    }
    if (record.outcome === 'INVALID' && typeof record.sha256 === 'string') {
      return {
        outcome: 'INVALID',
        sha256: record.sha256,
        reasonCode: safeReasonCode(record.reasonCode),
      };
    }
    if (
      (record.outcome === 'CLEAN' || record.outcome === 'INFECTED') &&
      typeof record.sha256 === 'string' &&
      typeof record.scannerEngineVersion === 'string' &&
      typeof record.signatureVersion === 'string' &&
      typeof record.signatureUpdatedAt === 'string'
    ) {
      return {
        outcome: record.outcome,
        sha256: record.sha256,
        scannerEngineVersion: record.scannerEngineVersion,
        signatureVersion: record.signatureVersion,
        signatureUpdatedAt: record.signatureUpdatedAt,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isSafeScannerVersion(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    !value.includes('\0')
  );
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isFreshSignature(updatedAt: string, now = Date.now()): boolean {
  if (!isCanonicalUtcTimestamp(updatedAt)) return false;
  const signatureTime = Date.parse(updatedAt);
  return signatureTime <= now && signatureTime >= now - MAX_SIGNATURE_AGE_MS;
}

function assertResultChanges(db: D1Database, failureCode: string): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), failureCode);
}

function isCasAssertionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT');
}

function isKnownDocumentQueueMessage(value: unknown): value is DocumentJobQueueMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const message = value as Record<string, unknown>;
    const hasIdentity =
      typeof message.jobId === 'string' &&
      message.jobId.trim().length > 0 &&
      message.jobId.length <= 255 &&
      Number.isSafeInteger(message.generation) &&
      (message.generation as number) >= 1;
    if (!hasIdentity) return false;
    if (
      message.deadLetterReplayId !== undefined &&
      !isSafeQueueMessageId(message.deadLetterReplayId)
    ) {
      return false;
    }
    if (message.jobType === 'DOCUMENT_SCAN' || message.jobType === 'DOCUMENT_BACKUP') {
      return (
        typeof message.documentVersionId === 'string' &&
        message.documentVersionId.trim().length > 0 &&
        message.documentVersionId.length <= 255 &&
        typeof message.inputSha256 === 'string' &&
        SHA256_PATTERN.test(message.inputSha256)
      );
    }
    return (
      (message.jobType === 'DOCUMENT_RECONCILE' || message.jobType === 'DOCUMENT_RESTORE') &&
      message.documentVersionId === null &&
      message.inputSha256 === null
    );
  } catch {
    return false;
  }
}

function isDocumentScanMessage(value: unknown): value is DocumentJobQueueMessage {
  return isKnownDocumentQueueMessage(value) && value.jobType === 'DOCUMENT_SCAN';
}

async function sha256Stream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
  digestBytes: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>,
): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  const cancelReader = () => {
    void reader.cancel(new ScannerTimeoutError()).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      sizeBytes += value.byteLength;
      if (sizeBytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ScanInputTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }

  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await abortable(digestBytes(bytes), signal);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return { sha256, sizeBytes };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new ScannerTimeoutError());
    };
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function createScanDeadline(timeoutMs: number) {
  const controller = new AbortController();
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    deadlineAt,
    dispose: () => clearTimeout(timer),
  };
}

function cancelStream(stream: ReadableStream<Uint8Array>): void {
  void stream.cancel().catch(() => undefined);
}

async function loadScanJob(db: D1Database, message: DocumentJobQueueMessage) {
  return await db
    .prepare(
      `SELECT job.id,job.agency_id,job.job_type,job.generation,job.document_version_id,
              job.input_sha256,job.status,job.attempt_count,job.max_attempts,job.available_at,
              job.lease_token_hash,job.lease_expires_at,
              CASE WHEN job.status='RUNNING' AND
                julianday(job.lease_expires_at)<=julianday('now') THEN 1 ELSE 0 END AS lease_expired,
              version.object_key,version.size_bytes,version.detected_content_type,
              version.status AS version_status
       FROM background_jobs job
       JOIN document_versions version
         ON version.agency_id=job.agency_id AND version.id=job.document_version_id
       WHERE job.id=? AND job.job_type='DOCUMENT_SCAN'`,
    )
    .bind(message.jobId)
    .first<ScanJobRow>();
}

function messageMatchesJob(message: DocumentJobQueueMessage, row: ScanJobRow): boolean {
  return (
    row.job_type === 'DOCUMENT_SCAN' &&
    row.generation === message.generation &&
    row.document_version_id === message.documentVersionId &&
    row.input_sha256 === message.inputSha256
  );
}

async function claimScanJob(
  db: D1Database,
  row: ScanJobRow,
  deadlineAt: string,
): Promise<ScanClaim | null> {
  const leaseTokenHash = await digestText(crypto.randomUUID());
  const attemptNumber = row.attempt_count + 1;
  const runId = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_jobs
           SET status='RUNNING',attempt_count=attempt_count+1,lease_token_hash=?,
               lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=? AND agency_id=? AND job_type='DOCUMENT_SCAN' AND generation=?
             AND document_version_id=? AND input_sha256=? AND attempt_count=?
             AND max_attempts=? AND status IN ('QUEUED','RETRY_WAIT')
             AND available_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             AND julianday(?)>=julianday('now')
             AND generation=(SELECT max(latest.generation) FROM background_jobs latest
               WHERE latest.agency_id=background_jobs.agency_id
                 AND latest.job_type='DOCUMENT_SCAN'
                 AND latest.document_version_id=background_jobs.document_version_id
                 AND latest.input_sha256=background_jobs.input_sha256)
             AND EXISTS (SELECT 1 FROM document_versions version
               WHERE version.agency_id=background_jobs.agency_id
                 AND version.id=background_jobs.document_version_id
                 AND version.sha256=background_jobs.input_sha256
                 AND version.status IN ('QUARANTINED','SCANNING'))`,
        )
        .bind(
          leaseTokenHash,
          `+${SCAN_LEASE_SECONDS} seconds`,
          row.id,
          row.agency_id,
          row.generation,
          row.document_version_id,
          row.input_sha256,
          row.attempt_count,
          row.max_attempts,
          deadlineAt,
        ),
      assertResultChanges(db, 'DOCUMENT_SCAN_CLAIM_RACE'),
      db
        .prepare(
          `INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
           SELECT ?,?,?,?,? WHERE julianday(?)>=julianday('now')`,
        )
        .bind(runId, row.agency_id, row.id, attemptNumber, leaseTokenHash, deadlineAt),
      db
        .prepare(
          `UPDATE document_versions
           SET status='SCANNING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE agency_id=? AND id=? AND sha256=? AND status IN ('QUARANTINED','SCANNING')
             AND julianday(?)>=julianday('now')`,
        )
        .bind(row.agency_id, row.document_version_id, row.input_sha256, deadlineAt),
      assertResultChanges(db, 'DOCUMENT_SCAN_VERSION_CLAIM_RACE'),
    ]);
  } catch (error) {
    if (isCasAssertionFailure(error)) return null;
    throw error;
  }

  return {
    jobId: row.id,
    agencyId: row.agency_id,
    generation: row.generation,
    documentVersionId: row.document_version_id,
    inputSha256: row.input_sha256,
    attemptNumber,
    runId,
    leaseTokenHash,
    maxAttempts: row.max_attempts,
  };
}

async function digestText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resultEvidence(result: DocumentScannerResult): ScannerEvidence | null {
  if (result.outcome === 'UNKNOWN') return null;
  if (result.outcome === 'INVALID') {
    return {
      outcome: 'INVALID',
      runStatus: 'PERMANENT_ERROR',
      reasonCode: result.reasonCode,
      scannerEngineVersion: null,
      signatureVersion: null,
      signatureUpdatedAt: null,
    };
  }
  if (result.outcome === 'INFECTED') {
    return {
      outcome: 'INFECTED',
      runStatus: 'INFECTED',
      reasonCode: 'MALWARE_DETECTED',
      scannerEngineVersion: result.scannerEngineVersion,
      signatureVersion: result.signatureVersion,
      signatureUpdatedAt: result.signatureUpdatedAt,
    };
  }
  return {
    outcome: 'CLEAN',
    runStatus: 'SUCCEEDED',
    reasonCode: null,
    scannerEngineVersion: result.scannerEngineVersion,
    signatureVersion: result.signatureVersion,
    signatureUpdatedAt: result.signatureUpdatedAt,
  };
}

function permanentErrorEvidence(reasonCode: string): ScannerEvidence {
  return {
    outcome: 'ERROR',
    runStatus: 'PERMANENT_ERROR',
    reasonCode,
    scannerEngineVersion: null,
    signatureVersion: null,
    signatureUpdatedAt: null,
  };
}

async function finalizeEvidence(
  db: D1Database,
  claim: ScanClaim,
  evidence: ScannerEvidence,
  deadlineAt: string,
): Promise<boolean> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE background_job_runs
         SET status=?,reason_code=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND agency_id=? AND job_id=? AND attempt_number=?
           AND lease_token_hash=? AND status='RUNNING'
           AND EXISTS (SELECT 1 FROM background_jobs job
             JOIN document_versions version
               ON version.agency_id=job.agency_id AND version.id=job.document_version_id
             WHERE job.id=? AND job.agency_id=? AND job.job_type='DOCUMENT_SCAN'
               AND job.generation=? AND job.document_version_id=? AND job.input_sha256=?
               AND job.status='RUNNING' AND job.attempt_count=?
               AND job.lease_token_hash=?
               AND julianday(job.lease_expires_at)>julianday('now')
               AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
                 WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_SCAN'
                   AND latest.document_version_id=job.document_version_id
                   AND latest.input_sha256=job.input_sha256)
               AND version.sha256=job.input_sha256 AND version.status='SCANNING'
               AND julianday(?)>=julianday('now'))`,
      )
      .bind(
        evidence.runStatus,
        evidence.reasonCode,
        claim.runId,
        claim.agencyId,
        claim.jobId,
        claim.attemptNumber,
        claim.leaseTokenHash,
        claim.jobId,
        claim.agencyId,
        claim.generation,
        claim.documentVersionId,
        claim.inputSha256,
        claim.attemptNumber,
        claim.leaseTokenHash,
        deadlineAt,
      ),
    assertResultChanges(db, 'DOCUMENT_SCAN_RUN_COMPLETION_RACE'),
    db
      .prepare(
        `UPDATE background_jobs
         SET status='COMPLETED',lease_token_hash=NULL,lease_expires_at=NULL,
             completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             last_error_code=CASE WHEN last_error_code='QUEUE_DELIVERY_EXHAUSTED'
               THEN last_error_code ELSE ? END,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND agency_id=? AND job_type='DOCUMENT_SCAN' AND generation=?
           AND document_version_id=? AND input_sha256=? AND status='RUNNING'
           AND attempt_count=? AND lease_token_hash=?
           AND julianday(lease_expires_at)>julianday('now')
           AND generation=(SELECT max(latest.generation) FROM background_jobs latest
             WHERE latest.agency_id=background_jobs.agency_id
               AND latest.job_type='DOCUMENT_SCAN'
               AND latest.document_version_id=background_jobs.document_version_id
               AND latest.input_sha256=background_jobs.input_sha256)
           AND EXISTS (SELECT 1 FROM document_versions version
             WHERE version.agency_id=background_jobs.agency_id
               AND version.id=background_jobs.document_version_id
               AND version.sha256=background_jobs.input_sha256
               AND version.status='SCANNING')
           AND julianday(?)>=julianday('now')`,
      )
      .bind(
        evidence.outcome === 'CLEAN' ? null : evidence.reasonCode,
        claim.jobId,
        claim.agencyId,
        claim.generation,
        claim.documentVersionId,
        claim.inputSha256,
        claim.attemptNumber,
        claim.leaseTokenHash,
        deadlineAt,
      ),
    assertResultChanges(db, 'DOCUMENT_SCAN_JOB_COMPLETION_RACE'),
    db
      .prepare(
        `INSERT INTO document_scan_evidence
           (id,agency_id,document_version_id,job_run_id,sha256,outcome,reason_code,
            scanner_engine_version,signature_version,signature_updated_at,scanned_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,run.completed_at
         FROM background_job_runs run
         WHERE run.agency_id=? AND run.id=? AND run.status=?
           AND julianday(?)>=julianday('now')`,
      )
      .bind(
        crypto.randomUUID(),
        claim.agencyId,
        claim.documentVersionId,
        claim.runId,
        claim.inputSha256,
        evidence.outcome,
        evidence.reasonCode,
        evidence.scannerEngineVersion,
        evidence.signatureVersion,
        evidence.signatureUpdatedAt,
        claim.agencyId,
        claim.runId,
        evidence.runStatus,
        deadlineAt,
      ),
    assertResultChanges(db, 'DOCUMENT_SCAN_EVIDENCE_WRITE_RACE'),
  ];

  if (evidence.outcome === 'CLEAN') {
    statements.push(
      db
        .prepare(
          `INSERT INTO background_jobs
             (id,agency_id,job_type,document_version_id,input_sha256,generation,status,
              attempt_count,max_attempts,available_at,created_at,updated_at)
           SELECT ?,scan.agency_id,'DOCUMENT_BACKUP',scan.document_version_id,scan.input_sha256,
                  COALESCE(MAX(backup.generation),0)+1,'QUEUED',0,5,
                  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  strftime('%Y-%m-%dT%H:%M:%fZ','now')
           FROM background_jobs scan
           LEFT JOIN background_jobs backup
             ON backup.agency_id=scan.agency_id AND backup.job_type='DOCUMENT_BACKUP'
             AND backup.document_version_id=scan.document_version_id
             AND backup.input_sha256=scan.input_sha256
           WHERE scan.id=? AND scan.agency_id=? AND scan.status='COMPLETED'
             AND scan.job_type='DOCUMENT_SCAN' AND scan.generation=?
             AND scan.document_version_id=? AND scan.input_sha256=?
             AND julianday(?)>=julianday('now')
           GROUP BY scan.agency_id,scan.document_version_id,scan.input_sha256`,
        )
        .bind(
          crypto.randomUUID(),
          claim.jobId,
          claim.agencyId,
          claim.generation,
          claim.documentVersionId,
          claim.inputSha256,
          deadlineAt,
        ),
      assertResultChanges(db, 'DOCUMENT_BACKUP_JOB_CREATION_RACE'),
      db
        .prepare(
          `UPDATE document_versions
           SET status='BACKUP_PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE agency_id=? AND id=? AND sha256=? AND status='SCANNING'
             AND julianday(?)>=julianday('now')`,
        )
        .bind(claim.agencyId, claim.documentVersionId, claim.inputSha256, deadlineAt),
      assertResultChanges(db, 'DOCUMENT_SCAN_BACKUP_TRANSITION_RACE'),
    );
  }

  try {
    await db.batch(statements);
    return true;
  } catch (error) {
    if (isCasAssertionFailure(error)) return false;
    throw error;
  }
}

async function scheduleRetry(
  db: D1Database,
  claim: ScanClaim,
  reasonCode: string,
  getRetryDelaySeconds: (attemptNumber: number) => number = documentScanRetryDelaySeconds,
): Promise<DocumentScanProcessingResult> {
  const retry = claim.attemptNumber < claim.maxAttempts;
  const nextStatus = retry ? 'RETRY_WAIT' : 'DEAD';
  const requestedDelaySeconds = getRetryDelaySeconds(claim.attemptNumber);
  const delaySeconds =
    Number.isSafeInteger(requestedDelaySeconds) && requestedDelaySeconds > 0
      ? Math.min(requestedDelaySeconds, 480)
      : documentScanRetryDelaySeconds(claim.attemptNumber);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_job_runs
           SET status=?,reason_code=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=? AND agency_id=? AND job_id=? AND attempt_number=?
             AND lease_token_hash=? AND status='RUNNING'
             AND EXISTS (SELECT 1 FROM background_jobs job
               WHERE job.id=? AND job.agency_id=? AND job.status='RUNNING'
                 AND job.attempt_count=? AND job.lease_token_hash=?
                 AND julianday(job.lease_expires_at)>julianday('now'))`,
        )
        .bind(
          retry ? 'RETRYABLE_ERROR' : 'PERMANENT_ERROR',
          reasonCode,
          claim.runId,
          claim.agencyId,
          claim.jobId,
          claim.attemptNumber,
          claim.leaseTokenHash,
          claim.jobId,
          claim.agencyId,
          claim.attemptNumber,
          claim.leaseTokenHash,
        ),
      assertResultChanges(db, 'DOCUMENT_SCAN_RETRY_RUN_RACE'),
      db
        .prepare(
          `UPDATE background_jobs
           SET status=?,
               available_at=CASE WHEN ?='RETRY_WAIT'
                 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now',?) ELSE available_at END,
               lease_token_hash=NULL,lease_expires_at=NULL,queue_dispatched_at=NULL,
               last_error_code=CASE WHEN last_error_code='QUEUE_DELIVERY_EXHAUSTED'
                 THEN last_error_code ELSE ? END,
               completed_at=CASE WHEN ?='DEAD'
                 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=? AND agency_id=? AND job_type='DOCUMENT_SCAN' AND generation=?
             AND document_version_id=? AND input_sha256=? AND status='RUNNING'
             AND attempt_count=? AND lease_token_hash=?
             AND julianday(lease_expires_at)>julianday('now')`,
        )
        .bind(
          nextStatus,
          nextStatus,
          `+${delaySeconds} seconds`,
          reasonCode,
          nextStatus,
          claim.jobId,
          claim.agencyId,
          claim.generation,
          claim.documentVersionId,
          claim.inputSha256,
          claim.attemptNumber,
          claim.leaseTokenHash,
        ),
      assertResultChanges(db, 'DOCUMENT_SCAN_RETRY_JOB_RACE'),
    ]);
    return retry ? 'RETRY_SCHEDULED' : 'FAILED_CLOSED';
  } catch (error) {
    if (isCasAssertionFailure(error)) return 'ACKED';
    throw error;
  }
}

async function scheduleRetryWithinDeadline(
  db: D1Database,
  claim: ScanClaim,
  reasonCode: string,
  deadline: ReturnType<typeof createScanDeadline>,
  retryDelaySeconds: (attemptNumber: number) => number,
): Promise<DocumentScanProcessingResult> {
  return await abortable(scheduleRetry(db, claim, reasonCode, retryDelaySeconds), deadline.signal);
}

async function recordPermanentError(
  db: D1Database,
  claim: ScanClaim,
  reasonCode: string,
  deadlineAt: string,
): Promise<DocumentScanProcessingResult> {
  return (await finalizeEvidence(db, claim, permanentErrorEvidence(reasonCode), deadlineAt))
    ? 'COMPLETED'
    : 'ACKED';
}

async function failClosedScanResult(
  db: D1Database,
  claim: ScanClaim,
  reasonCode: string,
  deadline: ReturnType<typeof createScanDeadline>,
): Promise<DocumentScanProcessingResult> {
  if (deadline.signal.aborted) return 'RETRY_DELIVERY';
  const result = await abortable(
    recordPermanentError(db, claim, reasonCode, deadline.deadlineAt),
    deadline.signal,
  );
  return result === 'ACKED' && deadline.signal.aborted ? 'RETRY_DELIVERY' : result;
}

async function processClaimedDocumentScan(
  db: D1Database,
  quarantine: R2Bucket,
  row: ScanJobRow,
  claim: ScanClaim,
  scanner: DocumentScannerAdapter,
  deadline: ReturnType<typeof createScanDeadline>,
  retryDelaySeconds: (attemptNumber: number) => number,
  digestBytes: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>,
): Promise<DocumentScanProcessingResult> {
  try {
    if (deadline.signal.aborted) return 'RETRY_DELIVERY';
    let object: R2ObjectBody | null;
    const objectRead = Promise.resolve().then(() => quarantine.get(row.object_key));
    try {
      object = await abortable(objectRead, deadline.signal);
    } catch (error) {
      if (error instanceof ScannerTimeoutError) {
        void objectRead
          .then((lateObject) => {
            if (lateObject) cancelStream(lateObject.body);
          })
          .catch(() => undefined);
        return 'RETRY_DELIVERY';
      }
      return await scheduleRetryWithinDeadline(
        db,
        claim,
        'R2_READ_FAILED',
        deadline,
        retryDelaySeconds,
      );
    }
    if (!object)
      return await scheduleRetryWithinDeadline(
        db,
        claim,
        'R2_OBJECT_MISSING',
        deadline,
        retryDelaySeconds,
      );
    if (
      object.size !== row.size_bytes ||
      object.size < 1 ||
      object.size > MAX_DOCUMENT_UPLOAD_BYTES ||
      object.customMetadata?.sha256 !== claim.inputSha256
    ) {
      cancelStream(object.body);
      return await failClosedScanResult(db, claim, 'R2_METADATA_MISMATCH', deadline);
    }

    let scannerStream: ReadableStream<Uint8Array>;
    let checksumStream: ReadableStream<Uint8Array>;
    try {
      [scannerStream, checksumStream] = object.body.tee();
    } catch {
      return await scheduleRetryWithinDeadline(
        db,
        claim,
        'R2_STREAM_FAILED',
        deadline,
        retryDelaySeconds,
      );
    }
    const scanPromise = Promise.resolve().then(() =>
      scanner.scan({
        body: scannerStream,
        sha256: claim.inputSha256,
        sizeBytes: row.size_bytes,
        contentType: row.detected_content_type,
        signal: deadline.signal,
      }),
    );
    const [scanSettled, checksumSettled] = await Promise.allSettled([
      abortable(scanPromise, deadline.signal),
      sha256Stream(checksumStream, MAX_DOCUMENT_UPLOAD_BYTES, deadline.signal, digestBytes),
    ]);

    if (checksumSettled.status === 'rejected') {
      cancelStream(scannerStream);
      if (checksumSettled.reason instanceof ScanInputTooLargeError) {
        return await failClosedScanResult(db, claim, 'SCAN_INPUT_TOO_LARGE', deadline);
      }
      if (checksumSettled.reason instanceof ScannerTimeoutError) {
        return 'RETRY_DELIVERY';
      }
      return await scheduleRetryWithinDeadline(
        db,
        claim,
        'R2_STREAM_FAILED',
        deadline,
        retryDelaySeconds,
      );
    }
    const checksum = checksumSettled.value;
    if (checksum.sizeBytes !== row.size_bytes || checksum.sha256 !== claim.inputSha256) {
      cancelStream(scannerStream);
      return await failClosedScanResult(db, claim, 'CONTENT_SHA256_MISMATCH', deadline);
    }
    if (scanSettled.status === 'rejected') {
      cancelStream(scannerStream);
      if (scanSettled.reason instanceof ScannerTimeoutError) return 'RETRY_DELIVERY';
      return await scheduleRetryWithinDeadline(
        db,
        claim,
        'SCANNER_UNAVAILABLE',
        deadline,
        retryDelaySeconds,
      );
    }

    const result = parseScannerResult(scanSettled.value);
    if (!result) return await failClosedScanResult(db, claim, 'SCANNER_INVALID_RESPONSE', deadline);
    if (result.outcome === 'UNKNOWN') {
      return await scheduleRetryWithinDeadline(
        db,
        claim,
        result.reasonCode,
        deadline,
        retryDelaySeconds,
      );
    }
    if (!SHA256_PATTERN.test(result.sha256) || result.sha256 !== checksum.sha256) {
      return await failClosedScanResult(db, claim, 'SCANNER_CHECKSUM_MISMATCH', deadline);
    }
    if (result.outcome !== 'INVALID') {
      const now = Date.now();
      if (
        !isSafeScannerVersion(result.scannerEngineVersion) ||
        !isSafeScannerVersion(result.signatureVersion) ||
        !isFreshSignature(result.signatureUpdatedAt, now)
      ) {
        return await failClosedScanResult(db, claim, 'SIGNATURE_STALE_OR_INVALID', deadline);
      }
    }

    const evidence = resultEvidence(result);
    if (!evidence)
      return await scheduleRetryWithinDeadline(
        db,
        claim,
        'SCANNER_UNKNOWN',
        deadline,
        retryDelaySeconds,
      );
    if (deadline.signal.aborted) return 'RETRY_DELIVERY';
    const finalized = await abortable(
      finalizeEvidence(db, claim, evidence, deadline.deadlineAt),
      deadline.signal,
    );
    if (finalized) return 'COMPLETED';
    if (deadline.signal.aborted) return 'RETRY_DELIVERY';
    return 'ACKED';
  } finally {
    deadline.dispose();
  }
}

export async function processDocumentScanMessage(
  db: D1Database,
  quarantine: R2Bucket,
  messageValue: unknown,
  scanner: DocumentScannerAdapter,
  options: DocumentScanProcessingOptions = {},
): Promise<DocumentScanProcessingResult> {
  if (!isDocumentScanMessage(messageValue)) return 'ACKED';
  const message = messageValue;
  const requestedTimeoutMs = options.scanTimeoutMs;
  const timeoutMs =
    typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
      ? Math.min(SCAN_TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeoutMs)))
      : SCAN_TIMEOUT_MS;
  const retryDelaySeconds = options.retryDelaySeconds ?? documentScanRetryDelaySeconds;
  const digestBytes =
    options.digestBytes ??
    ((bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.digest('SHA-256', bytes));
  const deadline = createScanDeadline(timeoutMs);
  try {
    let row: ScanJobRow | null;
    try {
      row = await abortable(loadScanJob(db, message), deadline.signal);
    } catch {
      return 'RETRY_DELIVERY';
    }
    if (deadline.signal.aborted) return 'RETRY_DELIVERY';
    if (!row || !messageMatchesJob(message, row)) return 'ACKED';
    if (row.status === 'RUNNING' && row.lease_expired === 1 && row.lease_token_hash) {
      try {
        await abortable(
          reclaimExpiredDocumentScanJob(db, {
            id: row.id,
            agencyId: row.agency_id,
            attemptCount: row.attempt_count,
            maxAttempts: row.max_attempts,
            leaseTokenHash: row.lease_token_hash,
          }),
          deadline.signal,
        );
        return deadline.signal.aborted ? 'RETRY_DELIVERY' : 'ACKED';
      } catch {
        return 'RETRY_DELIVERY';
      }
    }
    if (
      !['QUEUED', 'RETRY_WAIT'].includes(row.status) ||
      !['QUARANTINED', 'SCANNING'].includes(row.version_status)
    ) {
      return 'ACKED';
    }

    let claim: ScanClaim | null;
    try {
      claim = await abortable(claimScanJob(db, row, deadline.deadlineAt), deadline.signal);
    } catch {
      return 'RETRY_DELIVERY';
    }
    if (deadline.signal.aborted) return 'RETRY_DELIVERY';
    if (!claim) return 'ACKED';
    try {
      return await processClaimedDocumentScan(
        db,
        quarantine,
        row,
        claim,
        scanner,
        deadline,
        retryDelaySeconds,
        digestBytes,
      );
    } catch (error) {
      if (error instanceof ScannerTimeoutError || deadline.signal.aborted) {
        return 'RETRY_DELIVERY';
      }
      throw error;
    }
  } finally {
    deadline.dispose();
  }
}

function isSafeQueueMessageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    !value.includes('\0')
  );
}

function canonicalQueueValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '"NON_FINITE"';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'object') return JSON.stringify(`[${typeof value}]`);
  if (seen.has(value)) return '"[CIRCULAR]"';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalQueueValue(item, seen)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key.normalize('NFC'))}:${canonicalQueueValue(record[key], seen)}`,
      );
    return `{${properties.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

async function fallbackDeadLetterMessageId(
  queueName: DocumentScanDeadLetterQueueName,
  payload: DocumentJobQueueMessage | null,
  malformedDelivery?: {
    readonly messageId: unknown;
    readonly timestamp: unknown;
    readonly body: unknown;
  },
  conflictSourceMessageId?: string,
): Promise<string> {
  const payloadIdentity = payload
    ? [payload.jobId, payload.generation, payload.documentVersionId, payload.inputSha256]
    : null;
  const identity = payloadIdentity
    ? canonicalQueueValue(
        conflictSourceMessageId ? [conflictSourceMessageId, ...payloadIdentity] : payloadIdentity,
      )
    : malformedDelivery
      ? canonicalQueueValue([
          malformedDelivery.messageId,
          malformedDelivery.timestamp instanceof Date &&
          Number.isFinite(malformedDelivery.timestamp.getTime())
            ? malformedDelivery.timestamp.toISOString()
            : malformedDelivery.timestamp,
          malformedDelivery.body,
        ])
      : canonicalQueueValue('INVALID_QUEUE_MESSAGE');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${queueName}|${identity}`)),
  );
  return `invalid-${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function persistDeadLetterEvent(
  db: D1Database,
  message: Message<DocumentJobQueueMessage>,
  queueName: DocumentScanDeadLetterQueueName,
): Promise<void> {
  const validMessage = isDocumentScanMessage(message.body);
  const messageIdIsSafe = isSafeQueueMessageId(message.id);
  const messageBody = message.body as unknown;
  const replayCandidate =
    typeof messageBody === 'object' && messageBody !== null && !Array.isArray(messageBody)
      ? (messageBody as Record<string, unknown>).deadLetterReplayId
      : undefined;
  const replayMessageId = isSafeQueueMessageId(replayCandidate) ? replayCandidate : null;
  const payload = validMessage ? message.body : null;
  const recordedMessageId =
    replayMessageId ??
    (messageIdIsSafe
      ? message.id
      : await fallbackDeadLetterMessageId(queueName, payload, {
          messageId: message.id,
          timestamp: message.timestamp,
          body: message.body,
        }));
  const reasonCode =
    validMessage && (messageIdIsSafe || replayMessageId !== null)
      ? 'QUEUE_DELIVERY_EXHAUSTED'
      : 'INVALID_QUEUE_MESSAGE';
  await db
    .prepare(
      `INSERT OR IGNORE INTO document_queue_dead_letter_events
         (id,message_id,queue_name,job_id,job_generation,document_version_id,
          input_sha256,reason_code)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      recordedMessageId,
      queueName,
      payload?.jobId ?? null,
      payload?.generation ?? null,
      payload?.documentVersionId ?? null,
      payload?.inputSha256 ?? null,
      reasonCode,
    )
    .run();
  const storedEvent = await db
    .prepare(
      `SELECT job_id,job_generation,document_version_id,input_sha256,reason_code
       FROM document_queue_dead_letter_events WHERE queue_name=? AND message_id=?`,
    )
    .bind(queueName, recordedMessageId)
    .first<{
      readonly job_id: string | null;
      readonly job_generation: number | null;
      readonly document_version_id: string | null;
      readonly input_sha256: string | null;
      readonly reason_code: string;
    }>();
  if (!storedEvent) throw new Error('DEAD_LETTER_EVENT_MISSING');
  const eventMatches =
    storedEvent.job_id === (payload?.jobId ?? null) &&
    storedEvent.job_generation === (payload?.generation ?? null) &&
    storedEvent.document_version_id === (payload?.documentVersionId ?? null) &&
    storedEvent.input_sha256 === (payload?.inputSha256 ?? null) &&
    storedEvent.reason_code === reasonCode;
  if (!eventMatches) {
    const conflictMessageId = await fallbackDeadLetterMessageId(
      queueName,
      payload,
      undefined,
      recordedMessageId,
    );
    await db
      .prepare(
        `INSERT OR IGNORE INTO document_queue_dead_letter_events
           (id,message_id,queue_name,job_id,job_generation,document_version_id,
            input_sha256,reason_code)
         VALUES(?,?,?,NULL,NULL,NULL,NULL,'INVALID_QUEUE_MESSAGE')`,
      )
      .bind(crypto.randomUUID(), conflictMessageId, queueName)
      .run();
    console.warn('DOCUMENT_SCAN_QUEUE_DEAD_LETTER_IDENTITY_CONFLICT', {
      queue: queueName,
      messageId: recordedMessageId,
      conflictId: conflictMessageId,
    });
    return;
  }
  if (payload && reasonCode === 'QUEUE_DELIVERY_EXHAUSTED') {
    await db
      .prepare(
        `UPDATE background_jobs
         SET last_error_code='QUEUE_DELIVERY_EXHAUSTED',
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND job_type='DOCUMENT_SCAN' AND generation=?
           AND document_version_id=? AND input_sha256=?`,
      )
      .bind(payload.jobId, payload.generation, payload.documentVersionId, payload.inputSha256)
      .run();
  }
  console.warn('DOCUMENT_SCAN_QUEUE_DEAD_LETTER', {
    queue: queueName,
    messageId: recordedMessageId,
    reasonCode,
  });
}

export async function consumeDocumentQueueBatch(
  batch: MessageBatch<DocumentJobQueueMessage>,
  db: D1Database,
  quarantine: R2Bucket | undefined,
  documentsEnabled: boolean,
  scanner: DocumentScannerAdapter = unavailableDocumentScanner,
): Promise<void> {
  if (
    batch.queue === DOCUMENT_SCAN_DEAD_LETTER_QUEUE ||
    batch.queue === DOCUMENT_SCAN_OVERFLOW_QUEUE ||
    batch.queue === DOCUMENT_SCAN_TERMINAL_QUEUE
  ) {
    for (const message of batch.messages) {
      try {
        await persistDeadLetterEvent(db, message, batch.queue);
        message.ack();
      } catch {
        console.warn('DOCUMENT_SCAN_QUEUE_DEAD_LETTER_PERSIST_RETRY', {
          queue: batch.queue,
          messageId: isSafeQueueMessageId(message.id) ? message.id : 'INVALID_MESSAGE_ID',
        });
        message.retry({ delaySeconds: 60 });
      }
    }
    return;
  }

  for (const message of batch.messages) {
    if (!isKnownDocumentQueueMessage(message.body)) {
      message.retry({ delaySeconds: 30 });
      continue;
    }
    if (message.body.jobType !== 'DOCUMENT_SCAN') {
      message.ack();
      continue;
    }
    if (!documentsEnabled) {
      message.ack();
      continue;
    }
    if (!quarantine) {
      message.retry({ delaySeconds: 60 });
      continue;
    }
    let result: DocumentScanProcessingResult;
    try {
      result = await processDocumentScanMessage(db, quarantine, message.body, scanner);
    } catch {
      result = 'RETRY_DELIVERY';
    }
    if (result === 'RETRY_DELIVERY') message.retry({ delaySeconds: 30 });
    else message.ack();
  }
}
