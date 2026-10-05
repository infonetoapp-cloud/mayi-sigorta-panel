ALTER TABLE `document_versions` ADD `validation_version` text;--> statement-breakpoint
ALTER TABLE `document_versions` ADD `validation_result` text;--> statement-breakpoint

-- F-26: structural acceptance is not an antivirus verdict; historical evidence is unchanged.
CREATE VIEW document_accepted_validation AS
SELECT v.id,v.agency_id,v.id AS document_version_id,v.sha256,1 AS generation,
 v.validation_version AS content_inspection_version,v.validation_result AS content_inspection_result,'STRUCTURAL' AS acceptance_policy
FROM document_versions v WHERE v.validation_version='m4-content-inspection-v1' AND v.validation_result IS NOT NULL
UNION ALL
SELECT e.id,e.agency_id,e.document_version_id,e.sha256,e.generation,i.content_inspection_version,i.content_inspection_result,'LEGACY_SCANNED'
FROM document_latest_scan_evidence e JOIN document_scan_evidence i ON i.agency_id=e.agency_id AND i.id=e.id
JOIN document_versions v ON v.agency_id=e.agency_id AND v.id=e.document_version_id
WHERE v.validation_version IS NULL AND e.outcome='CLEAN' AND e.run_status='SUCCEEDED' AND e.job_status='COMPLETED'
 AND i.content_inspection_version='m4-content-inspection-v1' AND i.content_inspection_result IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER document_validation_insert_guard BEFORE INSERT ON document_versions
WHEN NEW.validation_version IS NOT NULL OR NEW.validation_result IS NOT NULL
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VALIDATION_INSERT_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER document_validation_immutable_guard BEFORE UPDATE OF validation_version,validation_result ON document_versions
WHEN NOT (OLD.validation_version IS NULL AND OLD.validation_result IS NULL AND OLD.status='PENDING_UPLOAD' AND NEW.status='BACKUP_PENDING'
 AND NEW.validation_version IS 'm4-content-inspection-v1' AND NEW.validation_result IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VALIDATION_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER document_validation_shape_guard BEFORE UPDATE OF validation_version,validation_result ON document_versions
WHEN NEW.validation_version IS NOT 'm4-content-inspection-v1' OR NEW.validation_result IS NULL OR length(NEW.validation_result)>256 OR (CASE WHEN json_valid(NEW.validation_result)=1 THEN
      CASE WHEN json_type(NEW.validation_result)='object'
        AND json_type(NEW.validation_result,'$.valid')='true'
        AND json_extract(NEW.validation_result,'$.valid')=1
        AND EXISTS (
          SELECT 1 FROM document_versions version
          WHERE version.id=NEW.id
            AND version.agency_id=NEW.agency_id AND version.sha256=NEW.sha256
            AND (
              (version.detected_content_type='application/pdf'
                AND json_extract(NEW.validation_result,'$.format')='PDF'
                AND (SELECT COUNT(*) FROM json_each(NEW.validation_result))=3
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(NEW.validation_result)
                  WHERE key NOT IN ('format','pageCount','valid')
                )
                AND json_type(NEW.validation_result,'$.pageCount')='integer'
                AND json_extract(NEW.validation_result,'$.pageCount') BETWEEN 1 AND 200)
              OR (version.detected_content_type='image/jpeg'
                AND json_extract(NEW.validation_result,'$.format')='JPEG'
                AND (SELECT COUNT(*) FROM json_each(NEW.validation_result))=5
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(NEW.validation_result)
                  WHERE key NOT IN ('format','height','pixelCount','valid','width')
                )
                AND json_type(NEW.validation_result,'$.width')='integer'
                AND json_type(NEW.validation_result,'$.height')='integer'
                AND json_type(NEW.validation_result,'$.pixelCount')='integer'
                AND json_extract(NEW.validation_result,'$.width') BETWEEN 1 AND 8192
                AND json_extract(NEW.validation_result,'$.height') BETWEEN 1 AND 8192
                AND json_extract(NEW.validation_result,'$.pixelCount')=
                  json_extract(NEW.validation_result,'$.width')*json_extract(NEW.validation_result,'$.height')
                AND json_extract(NEW.validation_result,'$.pixelCount')<=4000000)
              OR (version.detected_content_type='image/png'
                AND json_extract(NEW.validation_result,'$.format')='PNG'
                AND (SELECT COUNT(*) FROM json_each(NEW.validation_result))=6
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(NEW.validation_result)
                  WHERE key NOT IN ('decompressedBytes','format','height','pixelCount','valid','width')
                )
                AND json_type(NEW.validation_result,'$.width')='integer'
                AND json_type(NEW.validation_result,'$.height')='integer'
                AND json_type(NEW.validation_result,'$.pixelCount')='integer'
                AND json_type(NEW.validation_result,'$.decompressedBytes')='integer'
                AND json_extract(NEW.validation_result,'$.width')>0
                AND json_extract(NEW.validation_result,'$.height')>0
                AND json_extract(NEW.validation_result,'$.pixelCount')=
                  json_extract(NEW.validation_result,'$.width')*json_extract(NEW.validation_result,'$.height')
                AND json_extract(NEW.validation_result,'$.pixelCount')<=16000000
                AND json_extract(NEW.validation_result,'$.decompressedBytes') BETWEEN 1 AND 33554432)
            )
        )
        THEN 0 ELSE 1 END
      ELSE 1 END)=1

BEGIN SELECT RAISE(ABORT,'DOCUMENT_VALIDATION_INVALID'); END;--> statement-breakpoint
DROP TRIGGER document_version_state_transition_guard;--> statement-breakpoint
CREATE TRIGGER document_version_state_transition_guard
BEFORE UPDATE OF status ON document_versions
WHEN NEW.validation_version IS NULL AND NEW.status<>OLD.status AND NOT (
  (OLD.status='PENDING_UPLOAD' AND NEW.status='QUARANTINED' AND EXISTS (
    SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_SCAN' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='QUEUED'))
  OR (OLD.status='PENDING_UPLOAD' AND NEW.status='SCAN_FAILED')
  OR (OLD.status IN ('AVAILABLE','BACKUP_PENDING') AND NEW.status='QUARANTINED'
    AND EXISTS (SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_SCAN' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='QUEUED'))
  OR (OLD.status='QUARANTINED' AND NEW.status='SCANNING' AND EXISTS (
    SELECT 1 FROM background_jobs job JOIN background_job_runs run
      ON run.agency_id=job.agency_id AND run.job_id=job.id
    WHERE job.agency_id=NEW.agency_id AND job.job_type='DOCUMENT_SCAN'
      AND job.document_version_id=NEW.id AND job.input_sha256=NEW.sha256
      AND job.status='RUNNING' AND run.status='RUNNING'
      AND run.attempt_number=job.attempt_count))
  OR (OLD.status='SCANNING' AND NEW.status='BACKUP_PENDING' AND EXISTS (
    SELECT 1 FROM document_latest_scan_evidence evidence
    WHERE evidence.agency_id=NEW.agency_id AND evidence.document_version_id=NEW.id
      AND evidence.sha256=NEW.sha256 AND evidence.outcome='CLEAN'
      AND evidence.job_status='COMPLETED' AND evidence.run_status='SUCCEEDED'
      AND julianday(evidence.signature_updated_at)<=julianday(evidence.scanned_at)
      AND julianday(evidence.signature_updated_at)>=julianday('now','-48 hours')
      AND julianday(evidence.scanned_at)<=julianday('now'))
    AND EXISTS (SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_BACKUP' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='QUEUED'
      AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
        WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_BACKUP'
          AND latest.document_version_id=NEW.id AND latest.input_sha256=NEW.sha256)))
  OR (OLD.status='SCANNING' AND NEW.status='REJECTED' AND EXISTS (
    SELECT 1 FROM document_latest_scan_evidence evidence
    WHERE evidence.agency_id=NEW.agency_id AND evidence.document_version_id=NEW.id
      AND evidence.sha256=NEW.sha256 AND evidence.outcome IN ('INFECTED','INVALID')
      AND evidence.job_status='COMPLETED'
      AND ((evidence.outcome='INFECTED' AND evidence.run_status='INFECTED')
        OR (evidence.outcome='INVALID' AND evidence.run_status='PERMANENT_ERROR'))))
  OR (OLD.status='SCANNING' AND NEW.status='SCAN_FAILED' AND EXISTS (
    SELECT 1 FROM document_latest_scan_evidence evidence
    WHERE evidence.agency_id=NEW.agency_id AND evidence.document_version_id=NEW.id
      AND evidence.sha256=NEW.sha256 AND evidence.outcome='ERROR'
      AND evidence.job_status='COMPLETED'
      AND evidence.run_status IN ('PERMANENT_ERROR','STALE')))
  OR (OLD.status='SCANNING' AND NEW.status='SCAN_FAILED' AND EXISTS (
    SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_SCAN' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='DEAD'
      AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
        WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_SCAN'
          AND latest.document_version_id=NEW.id AND latest.input_sha256=NEW.sha256)))
  OR (OLD.status IN ('PENDING_UPLOAD','QUARANTINED') AND NEW.status='SCAN_FAILED' AND EXISTS (
    SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_SCAN' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='DEAD'
      AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
        WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_SCAN'
          AND latest.document_version_id=NEW.id AND latest.input_sha256=NEW.sha256)))
  OR (OLD.status='BACKUP_PENDING' AND NEW.status='AVAILABLE' AND EXISTS (
    SELECT 1 FROM document_latest_scan_evidence evidence
    WHERE evidence.agency_id=NEW.agency_id AND evidence.document_version_id=NEW.id
      AND evidence.sha256=NEW.sha256 AND evidence.outcome='CLEAN'
      AND evidence.job_status='COMPLETED' AND evidence.run_status='SUCCEEDED'
      AND julianday(evidence.signature_updated_at)<=julianday(evidence.scanned_at)
      AND julianday(evidence.signature_updated_at)>=julianday('now','-48 hours')
      AND julianday(evidence.scanned_at)<=julianday('now'))
    AND EXISTS (SELECT 1 FROM document_backup_copies copy
      JOIN background_job_runs run ON run.agency_id=copy.agency_id AND run.id=copy.job_run_id
      JOIN background_jobs job ON job.agency_id=run.agency_id AND job.id=run.job_id
      WHERE copy.agency_id=NEW.agency_id AND copy.document_version_id=NEW.id
        AND copy.source_sha256=NEW.sha256 AND copy.backup_sha256=NEW.sha256
        AND run.status='SUCCEEDED' AND job.status='COMPLETED' AND job.job_type='DOCUMENT_BACKUP'
        AND job.document_version_id=NEW.id AND job.input_sha256=NEW.sha256
        AND run.attempt_number=job.attempt_count
        AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
          WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_BACKUP'
            AND latest.document_version_id=NEW.id AND latest.input_sha256=NEW.sha256)))
  OR (OLD.status='AVAILABLE' AND NEW.status='BACKUP_PENDING' AND EXISTS (
    SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_BACKUP' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='QUEUED'
      AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
        WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_BACKUP'
          AND latest.document_version_id=NEW.id AND latest.input_sha256=NEW.sha256)))
  OR (OLD.status='BACKUP_PENDING' AND NEW.status='SCAN_FAILED' AND EXISTS (
    SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_BACKUP' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='DEAD'
      AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
        WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_BACKUP'
          AND latest.document_version_id=NEW.id AND latest.input_sha256=NEW.sha256)))
  OR (OLD.status IN ('SCAN_FAILED','REJECTED') AND NEW.status='QUARANTINED' AND EXISTS (
    SELECT 1 FROM background_jobs job JOIN background_job_runs run
      ON run.agency_id=job.agency_id AND run.job_id=job.id
    WHERE job.agency_id=NEW.agency_id AND job.job_type='DOCUMENT_SCAN'
      AND job.document_version_id=NEW.id AND job.input_sha256=NEW.sha256
      AND job.status='RUNNING' AND run.status='RUNNING'
      AND run.attempt_number=job.attempt_count))
  OR (OLD.status='SCAN_FAILED' AND NEW.status='BACKUP_PENDING' AND EXISTS (
    SELECT 1 FROM document_latest_scan_evidence evidence
    WHERE evidence.agency_id=NEW.agency_id AND evidence.document_version_id=NEW.id
      AND evidence.sha256=NEW.sha256 AND evidence.outcome='CLEAN'
      AND evidence.job_status='COMPLETED' AND evidence.run_status='SUCCEEDED'
      AND julianday(evidence.signature_updated_at)<=julianday(evidence.scanned_at)
      AND julianday(evidence.signature_updated_at)>=julianday('now','-48 hours'))
    AND EXISTS (SELECT 1 FROM background_jobs job WHERE job.agency_id=NEW.agency_id
      AND job.job_type='DOCUMENT_BACKUP' AND job.document_version_id=NEW.id
      AND job.input_sha256=NEW.sha256 AND job.status='QUEUED'
      AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
        WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_BACKUP'
          AND latest.document_version_id=NEW.id AND latest.input_sha256=NEW.sha256)))
  OR (OLD.status='AVAILABLE' AND NEW.status='SCAN_FAILED' AND (
    NOT EXISTS (SELECT 1 FROM document_latest_scan_evidence evidence
      WHERE evidence.agency_id=NEW.agency_id AND evidence.document_version_id=NEW.id
        AND evidence.sha256=NEW.sha256 AND evidence.outcome='CLEAN'
        AND evidence.job_status='COMPLETED' AND evidence.run_status='SUCCEEDED'
        AND julianday(evidence.signature_updated_at)<=julianday(evidence.scanned_at)
        AND julianday(evidence.signature_updated_at)>=julianday('now','-48 hours'))
    OR NOT EXISTS (SELECT 1 FROM document_backup_copies copy
      WHERE copy.agency_id=NEW.agency_id AND copy.document_version_id=NEW.id
        AND copy.source_sha256=NEW.sha256 AND copy.backup_sha256=NEW.sha256)))
  OR (OLD.status IN ('AVAILABLE','BACKUP_PENDING') AND NEW.status='SCANNING' AND EXISTS (
    SELECT 1 FROM background_jobs job JOIN background_job_runs run
      ON run.agency_id=job.agency_id AND run.job_id=job.id
    WHERE job.agency_id=NEW.agency_id AND job.job_type='DOCUMENT_SCAN'
      AND job.document_version_id=NEW.id AND job.input_sha256=NEW.sha256
      AND job.status='RUNNING' AND run.status='RUNNING'
      AND run.attempt_number=job.attempt_count))
  OR (OLD.status='AVAILABLE' AND NEW.status='RETIRED')
)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VERSION_STATE_TRANSITION_INVALID'); END;--> statement-breakpoint

CREATE TRIGGER document_validated_state_transition_guard BEFORE UPDATE OF status ON document_versions
WHEN NEW.validation_version IS NOT NULL AND NEW.status<>OLD.status AND NOT (
 (OLD.status='PENDING_UPLOAD' AND NEW.status='BACKUP_PENDING'
 AND EXISTS(SELECT 1 FROM background_jobs j WHERE j.agency_id=NEW.agency_id AND j.document_version_id=NEW.id AND j.input_sha256=NEW.sha256
 AND j.job_type='DOCUMENT_BACKUP' AND j.status='QUEUED'))
 OR (OLD.status='BACKUP_PENDING' AND NEW.status='AVAILABLE'
 AND EXISTS(SELECT 1 FROM document_backup_copies c JOIN background_job_runs r ON r.agency_id=c.agency_id AND r.id=c.job_run_id
 JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
 WHERE c.agency_id=NEW.agency_id AND c.document_version_id=NEW.id AND c.source_sha256=NEW.sha256 AND c.backup_sha256=NEW.sha256
 AND r.status='SUCCEEDED' AND j.status='COMPLETED' AND j.job_type='DOCUMENT_BACKUP' AND j.document_version_id=NEW.id AND j.input_sha256=NEW.sha256
 AND r.attempt_number=j.attempt_count AND j.generation=(SELECT max(n.generation) FROM background_jobs n WHERE n.agency_id=j.agency_id
 AND n.job_type=j.job_type AND n.document_version_id=j.document_version_id AND n.input_sha256=j.input_sha256)))
 OR (OLD.status='AVAILABLE' AND NEW.status='BACKUP_PENDING' AND EXISTS(SELECT 1 FROM background_jobs j WHERE j.agency_id=NEW.agency_id
 AND j.document_version_id=NEW.id AND j.input_sha256=NEW.sha256 AND j.job_type='DOCUMENT_BACKUP' AND j.status='QUEUED'))
 OR (OLD.status='BACKUP_PENDING' AND NEW.status='SCAN_FAILED' AND EXISTS(SELECT 1 FROM background_jobs j WHERE j.agency_id=NEW.agency_id
 AND j.document_version_id=NEW.id AND j.input_sha256=NEW.sha256 AND j.job_type='DOCUMENT_BACKUP' AND j.status='DEAD'))
 OR (OLD.status='AVAILABLE' AND NEW.status='RETIRED'))
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VALIDATED_STATE_TRANSITION_INVALID'); END;--> statement-breakpoint
DROP TRIGGER document_versions_available_requires_inspection;--> statement-breakpoint
CREATE TRIGGER document_versions_available_requires_inspection BEFORE UPDATE OF status ON document_versions
WHEN NEW.status='AVAILABLE' AND OLD.status<>'AVAILABLE' AND NOT EXISTS(SELECT 1 FROM document_accepted_validation e
 WHERE e.agency_id=NEW.agency_id AND e.document_version_id=NEW.id AND e.sha256=NEW.sha256)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_AVAILABLE_INSPECTION_EVIDENCE_REQUIRED'); END;
--> statement-breakpoint
DROP TRIGGER document_backup_copies_insert_guard;--> statement-breakpoint
CREATE TRIGGER document_backup_copies_insert_guard BEFORE INSERT ON document_backup_copies
WHEN NOT EXISTS (
 SELECT 1 FROM document_versions v
 JOIN background_job_runs r ON r.agency_id=NEW.agency_id AND r.id=NEW.job_run_id
 JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
 JOIN document_accepted_validation e ON e.agency_id=v.agency_id AND e.document_version_id=v.id AND e.sha256=v.sha256
 WHERE v.agency_id=NEW.agency_id AND v.id=NEW.document_version_id
 AND v.sha256=NEW.source_sha256 AND NEW.backup_sha256=v.sha256
 AND j.job_type='DOCUMENT_BACKUP' AND j.document_version_id=v.id AND j.input_sha256=v.sha256
 AND j.status='COMPLETED' AND j.attempt_count=r.attempt_number AND r.status='SUCCEEDED'
 AND j.generation=(SELECT max(n.generation) FROM background_jobs n WHERE n.agency_id=j.agency_id
 AND n.job_type=j.job_type AND n.document_version_id=v.id AND n.input_sha256=v.sha256))
BEGIN SELECT RAISE(ABORT,'DOCUMENT_BACKUP_COPY_INVALID'); END;
