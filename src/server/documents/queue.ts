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
}

export interface DocumentJobDispatchResult {
  readonly sent: number;
  readonly failed: number;
}

const DISPATCH_BATCH_LIMIT = 100;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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
): Promise<DocumentJobDispatchResult> {
  const pendingJobs = await db
    .prepare(
      `SELECT id,job_type,document_version_id,input_sha256,generation
       FROM background_jobs
       WHERE status IN ('QUEUED','RETRY_WAIT')
         AND available_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND (queue_dispatched_at IS NULL OR
           queue_dispatched_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'))
       ORDER BY available_at,id
       LIMIT ?`,
    )
    .bind(DISPATCH_BATCH_LIMIT)
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
