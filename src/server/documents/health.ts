const COUNT_LIMIT = 1000;
/** Aggregate-only operational snapshot. No job/agency/document keys or errors. */
export async function evaluateDocumentHealth(db: D1Database, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999)
    throw new Error('DOCUMENT_HEALTH_CLOCK_INVALID');
  const checkedAt = new Date(now).toISOString(),
    cutoff = new Date(now - 900000).toISOString();
  let row: Record<string, number> | null, timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = db
      .prepare(
        `WITH clock(now,cutoff) AS (VALUES(?,?)) SELECT
 (SELECT count(*) FROM (SELECT 1 FROM background_jobs WHERE job_type IN ('DOCUMENT_BACKUP','DOCUMENT_RECONCILE') AND status='DEAD' LIMIT 1001)) AS dead,
 (SELECT count(*) FROM (SELECT 1 FROM background_jobs WHERE job_type IN ('DOCUMENT_BACKUP','DOCUMENT_RECONCILE') AND status IN ('QUEUED','RETRY_WAIT') AND available_at<=(SELECT now FROM clock) LIMIT 1001)) AS due,
 (SELECT count(*) FROM (SELECT 1 FROM background_jobs WHERE job_type IN ('DOCUMENT_BACKUP','DOCUMENT_RECONCILE') AND status IN ('QUEUED','RETRY_WAIT') AND available_at<(SELECT cutoff FROM clock) LIMIT 1001)) AS stalledDue,
 (SELECT count(*) FROM (SELECT 1 FROM background_jobs WHERE job_type IN ('DOCUMENT_BACKUP','DOCUMENT_RECONCILE') AND status='RUNNING' AND lease_expires_at<=(SELECT now FROM clock) LIMIT 1001)) AS expiredLeases,
 (SELECT count(*) FROM (SELECT 1 FROM background_jobs job WHERE job_type='DOCUMENT_RECONCILE' AND status='COMPLETED' AND last_error_code IS NOT NULL
 AND EXISTS(SELECT 1 FROM background_job_runs run WHERE run.agency_id=job.agency_id AND run.job_id=job.id AND run.attempt_number=job.attempt_count AND run.status='PERMANENT_ERROR') LIMIT 1001)) AS completedInvestigations,
 (SELECT count(*) FROM (SELECT 1 FROM document_versions WHERE status='BACKUP_PENDING' AND updated_at<(SELECT cutoff FROM clock) LIMIT 1001)) AS overdueBackups,
 (SELECT count(*) FROM (SELECT 1 FROM document_versions WHERE status='PENDING_UPLOAD' AND updated_at<(SELECT cutoff FROM clock) LIMIT 1001)) AS overdueUploads
 `,
      )
      .bind(checkedAt, cutoff)
      .first<Record<string, number>>();
    // Bounds our await, NOT provider execution/rows-read: D1 has no cancellation
    // capability here. Late read completion cannot produce an alert or a retry.
    row = await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DOCUMENT_HEALTH_READ_FAILED')), 5000);
      }),
    ]);
  } catch {
    throw new Error('DOCUMENT_HEALTH_READ_FAILED');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const names = [
    'dead',
    'due',
    'stalledDue',
    'expiredLeases',
    'completedInvestigations',
    'overdueBackups',
    'overdueUploads',
  ] as const;
  if (
    !row ||
    names.some(
      (name) => !Number.isSafeInteger(row[name]) || row[name]! < 0 || row[name]! > COUNT_LIMIT + 1,
    )
  )
    throw new Error('DOCUMENT_HEALTH_RESULT_INVALID');
  const counts = Object.freeze({
    dead: Math.min(row.dead!, COUNT_LIMIT),
    due: Math.min(row.due!, COUNT_LIMIT),
    stalledDue: Math.min(row.stalledDue!, COUNT_LIMIT),
    expiredLeases: Math.min(row.expiredLeases!, COUNT_LIMIT),
    completedInvestigations: Math.min(row.completedInvestigations!, COUNT_LIMIT),
    overdueBackups: Math.min(row.overdueBackups!, COUNT_LIMIT),
    overdueUploads: Math.min(row.overdueUploads!, COUNT_LIMIT),
  });
  return Object.freeze({
    checkedAt,
    counts,
    truncated: names.some((name) => row[name]! > COUNT_LIMIT),
  });
}

/** Internal operations log only, no HTTP/Queue payload and no email delivery.
 * Stable slot identity supports downstream dedupe; it is NOT durable dedupe. */
export async function runDocumentHealthMonitoring(db: D1Database, now = Date.now()): Promise<void> {
  const emit = (value: unknown) => {
    try {
      console.warn(JSON.stringify(value));
    } catch {
      throw new Error('DOCUMENT_HEALTH_SINK_FAILED');
    }
  };
  let snapshot: Awaited<ReturnType<typeof evaluateDocumentHealth>>;
  try {
    snapshot = await evaluateDocumentHealth(db, now);
  } catch {
    emit({
      version: 'mayi-document-health-v1',
      scope: 'ALL_AGENCIES_OPERATIONS_ONLY',
      code: 'DOCUMENT_HEALTH_READ_FAILED',
      severity: 'ERROR',
      eventKey: `document-health:v1:read-failed:${Math.floor(now / 300000)}`,
    });
    throw new Error('DOCUMENT_HEALTH_READ_FAILED');
  }
  const c = snapshot.counts;
  if (
    c.dead === 0 &&
    c.stalledDue === 0 &&
    c.expiredLeases === 0 &&
    c.completedInvestigations === 0 &&
    c.overdueBackups === 0 &&
    c.overdueUploads === 0 &&
    !snapshot.truncated
  )
    return;
  emit(
    Object.freeze({
      version: 'mayi-document-health-v1',
      scope: 'ALL_AGENCIES_OPERATIONS_ONLY',
      code: 'DOCUMENT_DURABLE_BACKLOG',
      severity: 'WARNING',
      eventKey: `document-health:v1:backlog:${Math.floor(now / 300000)}`,
      ...snapshot,
    }),
  );
}
