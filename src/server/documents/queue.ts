type DocumentQueueJobType =
  'DOCUMENT_SCAN' | 'DOCUMENT_BACKUP' | 'DOCUMENT_RECONCILE' | 'DOCUMENT_RESTORE';

interface PendingDocumentJobRow {
  readonly id: string;
  readonly job_type: string;
  readonly document_version_id: string | null;
  readonly input_sha256: string | null;
  readonly generation: number;
}

export interface DocumentJobQueueMessage {
  readonly jobId: string;
  readonly jobType: DocumentQueueJobType;
  readonly generation: number;
  readonly documentVersionId: string | null;
  readonly inputSha256: string | null;
  readonly deadLetterReplayId?: string;
}

export interface DocumentJobDispatchResult {
  readonly sent: number;
  readonly failed: number;
}

const DISPATCH_BATCH_LIMIT = 100;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ExpiredDocumentScanJob {
  readonly id: string;
  readonly agencyId: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly leaseTokenHash: string;
}

export function documentScanRetryDelaySeconds(attemptNumber: number): number {
  return Math.min(60 * 2 ** Math.max(0, attemptNumber - 1), 480);
}

function assertResultChanges(db: D1Database, failureCode: string): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), failureCode);
}

function isConcurrencyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT');
}

export async function reclaimExpiredDocumentScanJob(
  db: D1Database,
  job: ExpiredDocumentScanJob,
): Promise<boolean> {
  const nextStatus = job.attemptCount < job.maxAttempts ? 'RETRY_WAIT' : 'DEAD';
  const delaySeconds = documentScanRetryDelaySeconds(job.attemptCount);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE background_job_runs
           SET status='STALE',reason_code='LEASE_EXPIRED',
               completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE agency_id=? AND job_id=? AND attempt_number=?
             AND lease_token_hash=? AND status='RUNNING'
             AND EXISTS (SELECT 1 FROM background_jobs job
               WHERE job.id=? AND job.agency_id=? AND job.job_type='DOCUMENT_SCAN'
                 AND job.status='RUNNING' AND job.attempt_count=?
                 AND job.lease_token_hash=?
                 AND julianday(job.lease_expires_at)<=julianday('now'))`,
        )
        .bind(
          job.agencyId,
          job.id,
          job.attemptCount,
          job.leaseTokenHash,
          job.id,
          job.agencyId,
          job.attemptCount,
          job.leaseTokenHash,
        ),
      assertResultChanges(db, 'DOCUMENT_SCAN_LEASE_RUN_RECLAIM'),
      db
        .prepare(
          `UPDATE background_jobs
           SET status=?,
               available_at=CASE WHEN ?='RETRY_WAIT'
                 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now',?) ELSE available_at END,
               lease_token_hash=NULL,lease_expires_at=NULL,queue_dispatched_at=NULL,
               last_error_code=CASE WHEN last_error_code='QUEUE_DELIVERY_EXHAUSTED'
                 THEN last_error_code ELSE 'LEASE_EXPIRED' END,
               completed_at=CASE WHEN ?='DEAD'
                 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=? AND agency_id=? AND job_type='DOCUMENT_SCAN'
             AND status='RUNNING' AND attempt_count=? AND lease_token_hash=?
             AND julianday(lease_expires_at)<=julianday('now')`,
        )
        .bind(
          nextStatus,
          nextStatus,
          `+${delaySeconds} seconds`,
          nextStatus,
          job.id,
          job.agencyId,
          job.attemptCount,
          job.leaseTokenHash,
        ),
      assertResultChanges(db, 'DOCUMENT_SCAN_LEASE_JOB_RECLAIM'),
    ]);
    return true;
  } catch (error) {
    if (isConcurrencyConflict(error)) return false;
    throw error;
  }
}

async function reclaimExpiredDocumentScanJobs(db: D1Database): Promise<void> {
  const expired = await db
    .prepare(
      `SELECT id,agency_id,attempt_count,max_attempts,lease_token_hash
       FROM background_jobs
       WHERE job_type='DOCUMENT_SCAN' AND status='RUNNING'
         AND lease_token_hash IS NOT NULL
         AND julianday(lease_expires_at)<=julianday('now')
       ORDER BY lease_expires_at,id LIMIT ?`,
    )
    .bind(DISPATCH_BATCH_LIMIT)
    .all<{
      id: string;
      agency_id: string;
      attempt_count: number;
      max_attempts: number;
      lease_token_hash: string;
    }>();

  for (const job of expired.results ?? []) {
    await reclaimExpiredDocumentScanJob(db, {
      id: job.id,
      agencyId: job.agency_id,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      leaseTokenHash: job.lease_token_hash,
    });
  }
}

function toQueueMessage(row: PendingDocumentJobRow): DocumentJobQueueMessage | null {
  if (
    typeof row.id !== 'string' ||
    row.id.trim().length === 0 ||
    row.id.length > 255 ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  ) {
    return null;
  }

  if (row.job_type === 'DOCUMENT_SCAN' || row.job_type === 'DOCUMENT_BACKUP') {
    if (
      typeof row.document_version_id !== 'string' ||
      row.document_version_id.trim().length === 0 ||
      row.document_version_id.length > 255 ||
      typeof row.input_sha256 !== 'string' ||
      !SHA256_PATTERN.test(row.input_sha256)
    ) {
      return null;
    }

    return {
      jobId: row.id,
      jobType: row.job_type,
      generation: row.generation,
      documentVersionId: row.document_version_id,
      inputSha256: row.input_sha256,
    };
  }

  if (
    (row.job_type === 'DOCUMENT_RECONCILE' || row.job_type === 'DOCUMENT_RESTORE') &&
    row.document_version_id === null &&
    row.input_sha256 === null
  ) {
    return {
      jobId: row.id,
      jobType: row.job_type,
      generation: row.generation,
      documentVersionId: null,
      inputSha256: null,
    };
  }

  return null;
}

export async function dispatchDueDocumentJobs(
  db: D1Database,
  queue: Pick<Queue<DocumentJobQueueMessage>, 'send'>,
  supportedJobTypes: readonly DocumentQueueJobType[] = ['DOCUMENT_SCAN'],
): Promise<DocumentJobDispatchResult> {
  await reclaimExpiredDocumentScanJobs(db);
  if (supportedJobTypes.length === 0) return { sent: 0, failed: 0 };
  const jobTypePlaceholders = supportedJobTypes.map(() => '?').join(',');
  const pendingJobs = await db
    .prepare(
      `SELECT id,job_type,document_version_id,input_sha256,generation
       FROM background_jobs
       WHERE job_type IN (${jobTypePlaceholders})
         AND status IN ('QUEUED','RETRY_WAIT')
         AND available_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND (queue_dispatched_at IS NULL OR
           queue_dispatched_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'))
       ORDER BY available_at,id
       LIMIT ?`,
    )
    .bind(...supportedJobTypes, DISPATCH_BATCH_LIMIT)
    .all<PendingDocumentJobRow>();

  let sent = 0;
  let failed = 0;
  for (const row of pendingJobs.results ?? []) {
    const message = toQueueMessage(row);
    if (!message) {
      failed += 1;
      continue;
    }

    try {
      await queue.send(message);
    } catch {
      failed += 1;
      continue;
    }

    sent += 1;
    await db
      .prepare(
        `UPDATE background_jobs
         SET queue_dispatched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=? AND job_type=? AND generation=?
           AND document_version_id IS ? AND input_sha256 IS ?
           AND status IN ('QUEUED','RETRY_WAIT')
           AND available_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           AND (queue_dispatched_at IS NULL OR
             queue_dispatched_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'))`,
      )
      .bind(
        message.jobId,
        message.jobType,
        message.generation,
        message.documentVersionId,
        message.inputSha256,
      )
      .run();
  }

  return { sent, failed };
}
