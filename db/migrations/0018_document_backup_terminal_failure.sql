-- Backup integrity/prerequisite failure must not fabricate exhausted attempts or retry.
-- Retain the accepted scan and exhausted-retry rules; allow only a completed permanent
-- backup run with a server-owned bounded investigation code to terminate early.
DROP TRIGGER background_jobs_dead_attempt_guard;--> statement-breakpoint
CREATE TRIGGER background_jobs_dead_attempt_guard
BEFORE UPDATE OF status ON background_jobs
WHEN NEW.status='DEAD' AND NOT (
  EXISTS (SELECT 1 FROM background_job_runs run
    WHERE run.agency_id=NEW.agency_id AND run.job_id=NEW.id
      AND run.attempt_number=NEW.attempt_count AND run.status<>'RUNNING'
      AND run.completed_at IS NOT NULL
      AND (NEW.attempt_count=NEW.max_attempts OR (
        NEW.job_type='DOCUMENT_BACKUP' AND NEW.attempt_count>=1
        AND run.status='PERMANENT_ERROR' AND run.reason_code=NEW.last_error_code
        AND run.reason_code IN (
          'BACKUP_IDENTITY_INVALID','BACKUP_INPUT_MISMATCH',
          'BACKUP_OBJECT_IDENTITY_MISMATCH','BACKUP_LENGTH_MISMATCH',
          'BACKUP_CHECKSUM_MISMATCH','BACKUP_SOURCE_IDENTITY_INVALID',
          'BACKUP_SOURCE_METADATA_MISMATCH','BACKUP_SOURCE_LENGTH_MISMATCH',
          'BACKUP_SOURCE_CHECKSUM_MISMATCH','BACKUP_PROOF_MISMATCH',
          'BACKUP_PREREQUISITES_CHANGED'
        )
      ))
  )
)
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_DEAD_ATTEMPT_REQUIRED'); END;