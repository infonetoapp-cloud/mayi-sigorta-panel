CREATE TABLE IF NOT EXISTS _m4_content_inspection_upgrade_guard (
  allowed INTEGER NOT NULL CONSTRAINT m4_no_legacy_available_document CHECK(allowed=1)
);
DELETE FROM _m4_content_inspection_upgrade_guard;
INSERT INTO _m4_content_inspection_upgrade_guard(allowed)
SELECT CASE WHEN EXISTS (SELECT 1 FROM document_versions WHERE status='AVAILABLE') THEN 0 ELSE 1 END;
DROP TABLE _m4_content_inspection_upgrade_guard;--> statement-breakpoint
ALTER TABLE `document_scan_evidence` ADD `content_inspection_version` text;--> statement-breakpoint
ALTER TABLE `document_scan_evidence` ADD `content_inspection_result` text;--> statement-breakpoint
CREATE TRIGGER document_scan_evidence_content_inspection_guard
BEFORE INSERT ON document_scan_evidence
WHEN (NEW.outcome='CLEAN' AND (
  NEW.content_inspection_version IS NOT 'm4-content-inspection-v1'
  OR NEW.content_inspection_result IS NULL
  OR length(NEW.content_inspection_result)>256
  OR (CASE WHEN json_valid(NEW.content_inspection_result)=1 THEN
      CASE WHEN json_type(NEW.content_inspection_result)='object'
        AND json_type(NEW.content_inspection_result,'$.valid')='true'
        AND json_extract(NEW.content_inspection_result,'$.valid')=1
        AND EXISTS (
          SELECT 1 FROM document_versions version
          WHERE version.id=NEW.document_version_id
            AND version.agency_id=NEW.agency_id AND version.sha256=NEW.sha256
            AND (
              (version.detected_content_type='application/pdf'
                AND json_extract(NEW.content_inspection_result,'$.format')='PDF'
                AND (SELECT COUNT(*) FROM json_each(NEW.content_inspection_result))=3
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(NEW.content_inspection_result)
                  WHERE key NOT IN ('format','pageCount','valid')
                )
                AND json_type(NEW.content_inspection_result,'$.pageCount')='integer'
                AND json_extract(NEW.content_inspection_result,'$.pageCount') BETWEEN 1 AND 200)
              OR (version.detected_content_type='image/jpeg'
                AND json_extract(NEW.content_inspection_result,'$.format')='JPEG'
                AND (SELECT COUNT(*) FROM json_each(NEW.content_inspection_result))=5
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(NEW.content_inspection_result)
                  WHERE key NOT IN ('format','height','pixelCount','valid','width')
                )
                AND json_type(NEW.content_inspection_result,'$.width')='integer'
                AND json_type(NEW.content_inspection_result,'$.height')='integer'
                AND json_type(NEW.content_inspection_result,'$.pixelCount')='integer'
                AND json_extract(NEW.content_inspection_result,'$.width') BETWEEN 1 AND 8192
                AND json_extract(NEW.content_inspection_result,'$.height') BETWEEN 1 AND 8192
                AND json_extract(NEW.content_inspection_result,'$.pixelCount')=
                  json_extract(NEW.content_inspection_result,'$.width')*json_extract(NEW.content_inspection_result,'$.height')
                AND json_extract(NEW.content_inspection_result,'$.pixelCount')<=4000000)
              OR (version.detected_content_type='image/png'
                AND json_extract(NEW.content_inspection_result,'$.format')='PNG'
                AND (SELECT COUNT(*) FROM json_each(NEW.content_inspection_result))=6
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(NEW.content_inspection_result)
                  WHERE key NOT IN ('decompressedBytes','format','height','pixelCount','valid','width')
                )
                AND json_type(NEW.content_inspection_result,'$.width')='integer'
                AND json_type(NEW.content_inspection_result,'$.height')='integer'
                AND json_type(NEW.content_inspection_result,'$.pixelCount')='integer'
                AND json_type(NEW.content_inspection_result,'$.decompressedBytes')='integer'
                AND json_extract(NEW.content_inspection_result,'$.width')>0
                AND json_extract(NEW.content_inspection_result,'$.height')>0
                AND json_extract(NEW.content_inspection_result,'$.pixelCount')=
                  json_extract(NEW.content_inspection_result,'$.width')*json_extract(NEW.content_inspection_result,'$.height')
                AND json_extract(NEW.content_inspection_result,'$.pixelCount')<=16000000
                AND json_extract(NEW.content_inspection_result,'$.decompressedBytes') BETWEEN 1 AND 33554432)
            )
        )
        THEN 0 ELSE 1 END
      ELSE 1 END)=1
)) OR (NEW.outcome<>'CLEAN' AND (
  NEW.content_inspection_version IS NOT NULL OR NEW.content_inspection_result IS NOT NULL
))
BEGIN SELECT RAISE(ABORT,'DOCUMENT_SCAN_INSPECTION_EVIDENCE_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER document_versions_available_requires_inspection
BEFORE UPDATE OF status ON document_versions
WHEN NEW.status='AVAILABLE' AND OLD.status<>'AVAILABLE'
  AND NOT EXISTS (
    SELECT 1 FROM document_scan_evidence evidence
    WHERE evidence.agency_id=NEW.agency_id
      AND evidence.document_version_id=NEW.id
      AND evidence.sha256=NEW.sha256
      AND evidence.outcome='CLEAN'
      AND evidence.content_inspection_version='m4-content-inspection-v1'
      AND evidence.content_inspection_result IS NOT NULL
      AND length(evidence.content_inspection_result)<=256
      AND json_valid(evidence.content_inspection_result)=1
      AND json_type(evidence.content_inspection_result)='object'
      AND json_type(evidence.content_inspection_result,'$.valid')='true'
      AND json_extract(evidence.content_inspection_result,'$.valid')=1
      AND (
        (NEW.detected_content_type='application/pdf'
          AND json_extract(evidence.content_inspection_result,'$.format')='PDF'
          AND (SELECT COUNT(*) FROM json_each(evidence.content_inspection_result))=3
          AND NOT EXISTS (
            SELECT 1 FROM json_each(evidence.content_inspection_result)
            WHERE key NOT IN ('format','pageCount','valid')
          )
          AND json_type(evidence.content_inspection_result,'$.pageCount')='integer'
          AND json_extract(evidence.content_inspection_result,'$.pageCount') BETWEEN 1 AND 200)
        OR (NEW.detected_content_type='image/jpeg'
          AND json_extract(evidence.content_inspection_result,'$.format')='JPEG'
          AND (SELECT COUNT(*) FROM json_each(evidence.content_inspection_result))=5
          AND NOT EXISTS (
            SELECT 1 FROM json_each(evidence.content_inspection_result)
            WHERE key NOT IN ('format','height','pixelCount','valid','width')
          )
          AND json_type(evidence.content_inspection_result,'$.width')='integer'
          AND json_type(evidence.content_inspection_result,'$.height')='integer'
          AND json_type(evidence.content_inspection_result,'$.pixelCount')='integer'
          AND json_extract(evidence.content_inspection_result,'$.width') BETWEEN 1 AND 8192
          AND json_extract(evidence.content_inspection_result,'$.height') BETWEEN 1 AND 8192
          AND json_extract(evidence.content_inspection_result,'$.pixelCount')=
            json_extract(evidence.content_inspection_result,'$.width')*json_extract(evidence.content_inspection_result,'$.height')
          AND json_extract(evidence.content_inspection_result,'$.pixelCount')<=4000000)
        OR (NEW.detected_content_type='image/png'
          AND json_extract(evidence.content_inspection_result,'$.format')='PNG'
          AND (SELECT COUNT(*) FROM json_each(evidence.content_inspection_result))=6
          AND NOT EXISTS (
            SELECT 1 FROM json_each(evidence.content_inspection_result)
            WHERE key NOT IN ('decompressedBytes','format','height','pixelCount','valid','width')
          )
          AND json_type(evidence.content_inspection_result,'$.width')='integer'
          AND json_type(evidence.content_inspection_result,'$.height')='integer'
          AND json_type(evidence.content_inspection_result,'$.pixelCount')='integer'
          AND json_type(evidence.content_inspection_result,'$.decompressedBytes')='integer'
          AND json_extract(evidence.content_inspection_result,'$.width')>0
          AND json_extract(evidence.content_inspection_result,'$.height')>0
          AND json_extract(evidence.content_inspection_result,'$.pixelCount')=
            json_extract(evidence.content_inspection_result,'$.width')*json_extract(evidence.content_inspection_result,'$.height')
          AND json_extract(evidence.content_inspection_result,'$.pixelCount')<=16000000
          AND json_extract(evidence.content_inspection_result,'$.decompressedBytes') BETWEEN 1 AND 33554432)
      )
  )
BEGIN SELECT RAISE(ABORT,'DOCUMENT_AVAILABLE_INSPECTION_EVIDENCE_REQUIRED'); END;
