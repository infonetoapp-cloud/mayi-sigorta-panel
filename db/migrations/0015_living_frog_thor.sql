CREATE TABLE `background_job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`job_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`lease_token_hash` text NOT NULL,
	`status` text DEFAULT 'RUNNING' NOT NULL,
	`reason_code` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`agency_id`,`job_id`) REFERENCES `background_jobs`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "background_job_runs_id_nonempty" CHECK(length(trim("background_job_runs"."id"))>0),
	CONSTRAINT "background_job_runs_attempt_positive" CHECK("background_job_runs"."attempt_number">=1),
	CONSTRAINT "background_job_runs_lease_token_hash_shape" CHECK(length("background_job_runs"."lease_token_hash")=64 AND "background_job_runs"."lease_token_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "background_job_runs_status_valid" CHECK("background_job_runs"."status" IN ('RUNNING','SUCCEEDED','RETRYABLE_ERROR','PERMANENT_ERROR','STALE','INFECTED')),
	CONSTRAINT "background_job_runs_completion_consistent" CHECK(("background_job_runs"."status"='RUNNING' AND "background_job_runs"."completed_at" IS NULL) OR ("background_job_runs"."status"<>'RUNNING' AND "background_job_runs"."completed_at" IS NOT NULL)),
	CONSTRAINT "background_job_runs_timestamps_valid" CHECK(length("background_job_runs"."started_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_job_runs"."started_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_job_runs"."started_at")="background_job_runs"."started_at" AND ("background_job_runs"."completed_at" IS NULL OR (length("background_job_runs"."completed_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_job_runs"."completed_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_job_runs"."completed_at")="background_job_runs"."completed_at"))),
	CONSTRAINT "background_job_runs_reason_code_safe" CHECK("background_job_runs"."reason_code" IS NULL OR (length("background_job_runs"."reason_code") BETWEEN 1 AND 64 AND instr("background_job_runs"."reason_code", char(10))=0 AND instr("background_job_runs"."reason_code", char(13))=0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_job_runs_agency_id_id_uq` ON `background_job_runs` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `background_job_runs_attempt_uq` ON `background_job_runs` (`agency_id`,`job_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `background_job_runs_job_idx` ON `background_job_runs` (`agency_id`,`job_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `background_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`job_type` text NOT NULL,
	`document_version_id` text,
	`input_sha256` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`available_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`lease_token_hash` text,
	`lease_expires_at` text,
	`queue_dispatched_at` text,
	`last_error_code` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`document_version_id`) REFERENCES `document_versions`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "background_jobs_id_nonempty" CHECK(length(trim("background_jobs"."id"))>0),
	CONSTRAINT "background_jobs_type_valid" CHECK("background_jobs"."job_type" IN ('DOCUMENT_SCAN','DOCUMENT_BACKUP','DOCUMENT_RECONCILE','DOCUMENT_RESTORE')),
	CONSTRAINT "background_jobs_status_valid" CHECK("background_jobs"."status" IN ('QUEUED','RUNNING','RETRY_WAIT','COMPLETED','DEAD')),
	CONSTRAINT "background_jobs_generation_positive" CHECK("background_jobs"."generation">=1),
	CONSTRAINT "background_jobs_attempts_bounded" CHECK("background_jobs"."attempt_count" BETWEEN 0 AND "background_jobs"."max_attempts" AND "background_jobs"."max_attempts" BETWEEN 1 AND 5 AND ("background_jobs"."job_type"<>'DOCUMENT_SCAN' OR "background_jobs"."max_attempts"=5)),
	CONSTRAINT "background_jobs_document_input_consistent" CHECK((("background_jobs"."job_type" IN ('DOCUMENT_SCAN','DOCUMENT_BACKUP') AND "background_jobs"."document_version_id" IS NOT NULL AND "background_jobs"."input_sha256" IS NOT NULL AND length("background_jobs"."input_sha256")=64 AND "background_jobs"."input_sha256" NOT GLOB '*[^0-9a-f]*') OR ("background_jobs"."job_type" IN ('DOCUMENT_RECONCILE','DOCUMENT_RESTORE') AND "background_jobs"."document_version_id" IS NULL AND "background_jobs"."input_sha256" IS NULL))),
	CONSTRAINT "background_jobs_lease_state_consistent" CHECK(("background_jobs"."status"='RUNNING' AND "background_jobs"."lease_token_hash" IS NOT NULL AND length("background_jobs"."lease_token_hash")=64 AND "background_jobs"."lease_token_hash" NOT GLOB '*[^0-9a-f]*' AND "background_jobs"."lease_expires_at" IS NOT NULL)
       OR ("background_jobs"."status"<>'RUNNING' AND "background_jobs"."lease_token_hash" IS NULL AND "background_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "background_jobs_completion_consistent" CHECK(("background_jobs"."status" IN ('COMPLETED','DEAD') AND "background_jobs"."completed_at" IS NOT NULL) OR ("background_jobs"."status" NOT IN ('COMPLETED','DEAD') AND "background_jobs"."completed_at" IS NULL)),
	CONSTRAINT "background_jobs_timestamps_valid" CHECK(length("background_jobs"."available_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."available_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."available_at")="background_jobs"."available_at" AND length("background_jobs"."created_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."created_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."created_at")="background_jobs"."created_at" AND length("background_jobs"."updated_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."updated_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."updated_at")="background_jobs"."updated_at" AND ("background_jobs"."lease_expires_at" IS NULL OR (length("background_jobs"."lease_expires_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."lease_expires_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."lease_expires_at")="background_jobs"."lease_expires_at")) AND ("background_jobs"."completed_at" IS NULL OR (length("background_jobs"."completed_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."completed_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."completed_at")="background_jobs"."completed_at")) AND ("background_jobs"."queue_dispatched_at" IS NULL OR (length("background_jobs"."queue_dispatched_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."queue_dispatched_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"background_jobs"."queue_dispatched_at")="background_jobs"."queue_dispatched_at"))),
	CONSTRAINT "background_jobs_error_code_safe" CHECK("background_jobs"."last_error_code" IS NULL OR (length("background_jobs"."last_error_code") BETWEEN 1 AND 64 AND instr("background_jobs"."last_error_code", char(10))=0 AND instr("background_jobs"."last_error_code", char(13))=0)),
	CONSTRAINT "background_jobs_timestamps_ordered" CHECK(julianday("background_jobs"."updated_at")>=julianday("background_jobs"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `background_jobs_agency_id_id_uq` ON `background_jobs` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `background_jobs_document_generation_uq` ON `background_jobs` (`agency_id`,`job_type`,`document_version_id`,`input_sha256`,`generation`) WHERE "background_jobs"."document_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `background_jobs_dispatch_idx` ON `background_jobs` (`status`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `background_jobs_agency_status_idx` ON `background_jobs` (`agency_id`,`status`,`available_at`);--> statement-breakpoint
CREATE TABLE `document_backup_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`job_run_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`backup_sha256` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`document_version_id`) REFERENCES `document_versions`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`job_run_id`) REFERENCES `background_job_runs`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "document_backup_copies_id_nonempty" CHECK(length(trim("document_backup_copies"."id"))>0),
	CONSTRAINT "document_backup_copies_source_sha256_shape" CHECK(length("document_backup_copies"."source_sha256")=64 AND "document_backup_copies"."source_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "document_backup_copies_backup_sha256_shape" CHECK(length("document_backup_copies"."backup_sha256")=64 AND "document_backup_copies"."backup_sha256" NOT GLOB '*[^0-9a-f]*' AND "document_backup_copies"."backup_sha256"="document_backup_copies"."source_sha256"),
	CONSTRAINT "document_backup_copies_object_key_private_shape" CHECK(length("document_backup_copies"."object_key")=43 AND substr("document_backup_copies"."object_key",1,7)='backup/' AND length(substr("document_backup_copies"."object_key",8))=36 AND substr("document_backup_copies"."object_key",16,1)='-' AND substr("document_backup_copies"."object_key",21,1)='-' AND substr("document_backup_copies"."object_key",26,1)='-' AND substr("document_backup_copies"."object_key",31,1)='-' AND length(replace(substr("document_backup_copies"."object_key",8),'-',''))=32 AND replace(substr("document_backup_copies"."object_key",8),'-','') NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "document_backup_copies_timestamps_valid" CHECK(length("document_backup_copies"."created_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_backup_copies"."created_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_backup_copies"."created_at")="document_backup_copies"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_backup_copies_agency_id_id_uq` ON `document_backup_copies` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_backup_copies_run_uq` ON `document_backup_copies` (`agency_id`,`job_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_backup_copies_object_key_uq` ON `document_backup_copies` (`object_key`);--> statement-breakpoint
CREATE INDEX `document_backup_copies_version_idx` ON `document_backup_copies` (`agency_id`,`document_version_id`);--> statement-breakpoint
CREATE TABLE `document_scan_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`document_version_id` text NOT NULL,
	`job_run_id` text NOT NULL,
	`sha256` text NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text,
	`scanner_engine_version` text,
	`signature_version` text,
	`signature_updated_at` text,
	`scanned_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`document_version_id`) REFERENCES `document_versions`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`job_run_id`) REFERENCES `background_job_runs`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "document_scan_evidence_id_nonempty" CHECK(length(trim("document_scan_evidence"."id"))>0),
	CONSTRAINT "document_scan_evidence_outcome_valid" CHECK("document_scan_evidence"."outcome" IN ('CLEAN','INFECTED','INVALID','ERROR')),
	CONSTRAINT "document_scan_evidence_sha256_shape" CHECK(length("document_scan_evidence"."sha256")=64 AND "document_scan_evidence"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "document_scan_evidence_timestamps_valid" CHECK(length("document_scan_evidence"."scanned_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_scan_evidence"."scanned_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_scan_evidence"."scanned_at")="document_scan_evidence"."scanned_at" AND ("document_scan_evidence"."signature_updated_at" IS NULL OR (length("document_scan_evidence"."signature_updated_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_scan_evidence"."signature_updated_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_scan_evidence"."signature_updated_at")="document_scan_evidence"."signature_updated_at"))),
	CONSTRAINT "document_scan_evidence_result_consistent" CHECK("document_scan_evidence"."outcome" IN ('ERROR','INVALID') OR ("document_scan_evidence"."scanner_engine_version" IS NOT NULL AND length(trim("document_scan_evidence"."scanner_engine_version")) BETWEEN 1 AND 128 AND "document_scan_evidence"."signature_version" IS NOT NULL AND length(trim("document_scan_evidence"."signature_version")) BETWEEN 1 AND 128 AND "document_scan_evidence"."signature_updated_at" IS NOT NULL)),
	CONSTRAINT "document_scan_evidence_reason_code_safe" CHECK("document_scan_evidence"."reason_code" IS NULL OR (length("document_scan_evidence"."reason_code") BETWEEN 1 AND 64 AND instr("document_scan_evidence"."reason_code", char(10))=0 AND instr("document_scan_evidence"."reason_code", char(13))=0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_scan_evidence_agency_id_id_uq` ON `document_scan_evidence` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_scan_evidence_run_uq` ON `document_scan_evidence` (`agency_id`,`job_run_id`);--> statement-breakpoint
CREATE INDEX `document_scan_evidence_version_idx` ON `document_scan_evidence` (`agency_id`,`document_version_id`,`scanned_at`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`document_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`file_name` text NOT NULL,
	`declared_content_type` text,
	`detected_content_type` text NOT NULL,
	`status` text DEFAULT 'PENDING_UPLOAD' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`document_id`) REFERENCES `documents`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "document_versions_id_nonempty" CHECK(length(trim("document_versions"."id"))>0),
	CONSTRAINT "document_versions_number_positive" CHECK("document_versions"."version_number">=1),
	CONSTRAINT "document_versions_sha256_shape" CHECK(length("document_versions"."sha256")=64 AND "document_versions"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "document_versions_size_limit" CHECK("document_versions"."size_bytes" BETWEEN 1 AND 20971520),
	CONSTRAINT "document_versions_object_key_private_shape" CHECK(length("document_versions"."object_key")=47 AND substr("document_versions"."object_key",1,11)='quarantine/' AND length(substr("document_versions"."object_key",12))=36 AND substr("document_versions"."object_key",20,1)='-' AND substr("document_versions"."object_key",25,1)='-' AND substr("document_versions"."object_key",30,1)='-' AND substr("document_versions"."object_key",35,1)='-' AND length(replace(substr("document_versions"."object_key",12),'-',''))=32 AND replace(substr("document_versions"."object_key",12),'-','') NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "document_versions_file_name_shape" CHECK(length(trim("document_versions"."file_name")) BETWEEN 1 AND 255 AND instr("document_versions"."file_name",'/')=0 AND instr("document_versions"."file_name",char(92))=0 AND instr("document_versions"."file_name",'..')=0 AND instr("document_versions"."file_name",char(0))=0 AND "document_versions"."file_name" NOT GLOB ('*[' || char(1) || '-' || char(31) || ']*') AND "document_versions"."file_name" NOT GLOB ('*[' || char(128) || '-' || char(159) || ']*') AND instr("document_versions"."file_name",char(127))=0 AND instr("document_versions"."file_name",char(34))=0 AND instr("document_versions"."file_name",char(39))=0 AND instr("document_versions"."file_name",char(59))=0),
	CONSTRAINT "document_versions_declared_content_type_shape" CHECK("document_versions"."declared_content_type" IS NULL OR (length("document_versions"."declared_content_type") BETWEEN 1 AND 128 AND instr("document_versions"."declared_content_type", char(10))=0 AND instr("document_versions"."declared_content_type", char(13))=0)),
	CONSTRAINT "document_versions_detected_content_type_valid" CHECK("document_versions"."detected_content_type" IN ('application/pdf','image/jpeg','image/png')),
	CONSTRAINT "document_versions_declared_content_type_matches_detected" CHECK("document_versions"."declared_content_type" IS NULL OR "document_versions"."declared_content_type"="document_versions"."detected_content_type"),
	CONSTRAINT "document_versions_type_extension_consistent" CHECK(("document_versions"."detected_content_type"='application/pdf' AND lower("document_versions"."file_name") LIKE '%.pdf') OR ("document_versions"."detected_content_type"='image/jpeg' AND (lower("document_versions"."file_name") LIKE '%.jpg' OR lower("document_versions"."file_name") LIKE '%.jpeg')) OR ("document_versions"."detected_content_type"='image/png' AND lower("document_versions"."file_name") LIKE '%.png')),
	CONSTRAINT "document_versions_status_valid" CHECK("document_versions"."status" IN ('PENDING_UPLOAD','QUARANTINED','SCANNING','BACKUP_PENDING','AVAILABLE','REJECTED','SCAN_FAILED','RETIRED')),
	CONSTRAINT "document_versions_timestamps_valid" CHECK(length("document_versions"."created_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_versions"."created_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_versions"."created_at")="document_versions"."created_at" AND length("document_versions"."updated_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_versions"."updated_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"document_versions"."updated_at")="document_versions"."updated_at"),
	CONSTRAINT "document_versions_timestamps_ordered" CHECK(julianday("document_versions"."updated_at")>=julianday("document_versions"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_agency_id_id_uq` ON `document_versions` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_number_uq` ON `document_versions` (`agency_id`,`document_id`,`version_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_object_key_uq` ON `document_versions` (`object_key`);--> statement-breakpoint
CREATE INDEX `document_versions_document_state_idx` ON `document_versions` (`agency_id`,`document_id`,`status`,`version_number`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`customer_id` text,
	`policy_id` text,
	`quote_id` text,
	`classification` text DEFAULT 'GENERAL' NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`current_version_id` text,
	`created_by_user_id` text NOT NULL,
	`created_by_membership_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`quote_id`) REFERENCES `renewal_quotes`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "documents_id_nonempty" CHECK(length(trim("documents"."id")) > 0),
	CONSTRAINT "documents_owner_valid" CHECK(("documents"."owner_type"='CUSTOMER' AND "documents"."customer_id" IS NOT NULL AND "documents"."policy_id" IS NULL AND "documents"."quote_id" IS NULL)
       OR ("documents"."owner_type"='POLICY' AND "documents"."customer_id" IS NULL AND "documents"."policy_id" IS NOT NULL AND "documents"."quote_id" IS NULL)
       OR ("documents"."owner_type"='QUOTE' AND "documents"."customer_id" IS NULL AND "documents"."policy_id" IS NULL AND "documents"."quote_id" IS NOT NULL)),
	CONSTRAINT "documents_classification_valid" CHECK("documents"."classification" IN ('GENERAL','IDENTITY','HEALTH')),
	CONSTRAINT "documents_status_valid" CHECK("documents"."status" IN ('ACTIVE','ARCHIVED')),
	CONSTRAINT "documents_version_positive" CHECK("documents"."version">=1),
	CONSTRAINT "documents_timestamps_valid" CHECK(length("documents"."created_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"documents"."created_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"documents"."created_at")="documents"."created_at" AND length("documents"."updated_at")=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',"documents"."updated_at") IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',"documents"."updated_at")="documents"."updated_at"),
	CONSTRAINT "documents_timestamps_ordered" CHECK(julianday("documents"."updated_at")>=julianday("documents"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_agency_id_id_uq` ON `documents` (`agency_id`,`id`);--> statement-breakpoint
CREATE INDEX `documents_customer_idx` ON `documents` (`agency_id`,`customer_id`,`status`);--> statement-breakpoint
CREATE INDEX `documents_policy_idx` ON `documents` (`agency_id`,`policy_id`,`status`);--> statement-breakpoint
CREATE INDEX `documents_quote_idx` ON `documents` (`agency_id`,`quote_id`,`status`);--> statement-breakpoint
CREATE VIEW document_latest_scan_evidence AS
SELECT evidence.id,evidence.agency_id,evidence.document_version_id,evidence.job_run_id,
  evidence.sha256,evidence.outcome,evidence.reason_code,evidence.scanner_engine_version,
  evidence.signature_version,evidence.signature_updated_at,evidence.scanned_at,
  job.status AS job_status,job.generation,run.status AS run_status,run.attempt_number
FROM document_scan_evidence evidence
JOIN background_job_runs run
  ON run.agency_id=evidence.agency_id AND run.id=evidence.job_run_id
JOIN background_jobs job ON job.agency_id=run.agency_id AND job.id=run.job_id
WHERE job.job_type='DOCUMENT_SCAN' AND job.status='COMPLETED'
  AND run.attempt_number=job.attempt_count
  AND (evidence.outcome<>'CLEAN' OR (
    julianday(evidence.signature_updated_at)<=julianday(evidence.scanned_at)
    AND julianday(evidence.signature_updated_at)>=julianday('now','-48 hours')
    AND julianday(evidence.scanned_at)<=julianday('now')))
  AND NOT EXISTS (
    SELECT 1 FROM background_jobs newer_job
    WHERE newer_job.agency_id=job.agency_id AND newer_job.job_type='DOCUMENT_SCAN'
      AND newer_job.document_version_id=job.document_version_id
      AND newer_job.input_sha256=job.input_sha256
      AND newer_job.generation>job.generation
  )
  AND NOT EXISTS (
    SELECT 1 FROM background_job_runs newer_run
    JOIN background_jobs newer_job ON newer_job.agency_id=newer_run.agency_id
      AND newer_job.id=newer_run.job_id
    WHERE newer_job.agency_id=job.agency_id AND newer_job.job_type='DOCUMENT_SCAN'
      AND newer_job.document_version_id=job.document_version_id
      AND newer_job.input_sha256=job.input_sha256
      AND newer_job.generation=job.generation
      AND newer_run.attempt_number>run.attempt_number
  );--> statement-breakpoint
CREATE TRIGGER documents_initial_version_pointer_guard
BEFORE INSERT ON documents
WHEN NEW.current_version_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'DOCUMENT_CURRENT_VERSION_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER documents_creator_membership_guard
BEFORE INSERT ON documents
WHEN NOT EXISTS (SELECT 1 FROM agency_memberships membership
  WHERE membership.agency_id=NEW.agency_id AND membership.id=NEW.created_by_membership_id
    AND membership.user_id=NEW.created_by_user_id)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_CREATOR_MEMBERSHIP_MISMATCH'); END;--> statement-breakpoint
CREATE TRIGGER documents_current_version_guard
BEFORE UPDATE OF current_version_id ON documents
WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_versions version
    WHERE version.agency_id=NEW.agency_id AND version.document_id=NEW.id
      AND version.id=NEW.current_version_id
      AND version.status='AVAILABLE'
      AND version.version_number=(SELECT max(latest.version_number) FROM document_versions latest
        WHERE latest.agency_id=NEW.agency_id AND latest.document_id=NEW.id)
  )
BEGIN SELECT RAISE(ABORT,'DOCUMENT_CURRENT_VERSION_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER documents_update_version_guard
BEFORE UPDATE ON documents
WHEN (NEW.current_version_id IS NOT OLD.current_version_id OR NEW.status IS NOT OLD.status
    OR NEW.classification IS NOT OLD.classification)
  AND NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VERSION_CONFLICT'); END;--> statement-breakpoint
CREATE TRIGGER documents_version_transition_guard
BEFORE UPDATE OF version ON documents
WHEN NEW.version<>OLD.version AND NOT (
  NEW.version=OLD.version+1 AND (
    NEW.current_version_id IS NOT OLD.current_version_id
    OR NEW.status IS NOT OLD.status
    OR NEW.classification IS NOT OLD.classification))
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VERSION_TRANSITION_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER documents_identity_immutable
BEFORE UPDATE OF id,agency_id,owner_type,customer_id,policy_id,quote_id,
  created_by_user_id,created_by_membership_id,created_at ON documents
BEGIN SELECT RAISE(ABORT,'DOCUMENT_IDENTITY_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER documents_status_transition_guard
BEFORE UPDATE OF status ON documents
WHEN NEW.status<>OLD.status AND NOT (OLD.status='ACTIVE' AND NEW.status='ARCHIVED')
BEGIN SELECT RAISE(ABORT,'DOCUMENT_STATE_TRANSITION_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER documents_no_delete
BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT,'DOCUMENT_HARD_DELETE_FORBIDDEN'); END;--> statement-breakpoint
CREATE TRIGGER document_versions_insert_guard
BEFORE INSERT ON document_versions
WHEN NEW.status<>'PENDING_UPLOAD' OR NOT EXISTS (
  SELECT 1 FROM documents document
  WHERE document.agency_id=NEW.agency_id AND document.id=NEW.document_id
    AND document.status='ACTIVE'
    AND NEW.version_number=COALESCE((SELECT max(version.version_number)+1
      FROM document_versions version
      WHERE version.agency_id=NEW.agency_id AND version.document_id=NEW.document_id),1)
)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VERSION_INSERT_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER document_versions_creator_membership_guard
BEFORE INSERT ON document_versions
WHEN NOT EXISTS (SELECT 1 FROM agency_memberships membership
  WHERE membership.agency_id=NEW.agency_id AND membership.id=NEW.created_by_membership_id
    AND membership.user_id=NEW.created_by_user_id)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_CREATOR_MEMBERSHIP_MISMATCH'); END;--> statement-breakpoint
CREATE TRIGGER document_versions_new_revision_unpublishes_current
AFTER INSERT ON document_versions
WHEN NEW.version_number>1 AND EXISTS (SELECT 1 FROM documents document
  WHERE document.agency_id=NEW.agency_id AND document.id=NEW.document_id
    AND document.current_version_id IS NOT NULL)
BEGIN
  UPDATE documents SET current_version_id=NULL,version=version+1,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE agency_id=NEW.agency_id AND id=NEW.document_id AND current_version_id IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER document_versions_identity_immutable
BEFORE UPDATE OF id,agency_id,document_id,version_number,object_key,sha256,size_bytes,
  file_name,declared_content_type,detected_content_type,created_by_user_id,
  created_by_membership_id,created_at ON document_versions
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VERSION_EVIDENCE_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER document_versions_current_pointer_clear_guard
BEFORE UPDATE OF status ON document_versions
WHEN OLD.status='AVAILABLE' AND NEW.status<>'AVAILABLE' AND EXISTS (
  SELECT 1 FROM documents document
  WHERE document.agency_id=OLD.agency_id AND document.current_version_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_CURRENT_VERSION_CLEAR_REQUIRED'); END;--> statement-breakpoint
CREATE TRIGGER document_versions_no_delete
BEFORE DELETE ON document_versions
BEGIN SELECT RAISE(ABORT,'DOCUMENT_VERSION_DELETE_FORBIDDEN'); END;--> statement-breakpoint
CREATE TRIGGER document_version_state_transition_guard
BEFORE UPDATE OF status ON document_versions
WHEN NEW.status<>OLD.status AND NOT (
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
CREATE TRIGGER background_jobs_insert_guard
BEFORE INSERT ON background_jobs
WHEN NEW.status<>'QUEUED' OR NEW.attempt_count<>0 OR
  (NEW.job_type IN ('DOCUMENT_SCAN','DOCUMENT_BACKUP') AND NEW.generation<>
    COALESCE((SELECT max(job.generation)+1 FROM background_jobs job
      WHERE job.agency_id=NEW.agency_id AND job.job_type=NEW.job_type
        AND job.document_version_id=NEW.document_version_id AND job.input_sha256=NEW.input_sha256),1)) OR
  (NEW.job_type IN ('DOCUMENT_SCAN','DOCUMENT_BACKUP') AND EXISTS (
    SELECT 1 FROM background_jobs prior
    WHERE prior.agency_id=NEW.agency_id AND prior.job_type=NEW.job_type
      AND prior.document_version_id=NEW.document_version_id
      AND prior.input_sha256=NEW.input_sha256 AND prior.generation<NEW.generation
      AND prior.status IN ('QUEUED','RUNNING','RETRY_WAIT')))
  OR
  (NEW.document_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_versions version
    WHERE version.agency_id=NEW.agency_id AND version.id=NEW.document_version_id
      AND version.sha256=NEW.input_sha256))
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_INSERT_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_rescan_quarantine_guard
AFTER INSERT ON background_jobs
WHEN NEW.job_type='DOCUMENT_SCAN' AND NEW.status='QUEUED'
  AND EXISTS (SELECT 1 FROM document_versions version
    WHERE version.agency_id=NEW.agency_id AND version.id=NEW.document_version_id
      AND version.sha256=NEW.input_sha256 AND version.status IN ('AVAILABLE','BACKUP_PENDING'))
BEGIN
  UPDATE documents SET current_version_id=NULL,version=version+1,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE agency_id=NEW.agency_id AND current_version_id=NEW.document_version_id;
  UPDATE document_versions SET status='QUARANTINED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE agency_id=NEW.agency_id AND id=NEW.document_version_id
    AND sha256=NEW.input_sha256 AND status IN ('AVAILABLE','BACKUP_PENDING');
END;--> statement-breakpoint
CREATE TRIGGER background_jobs_backup_unpublish_guard
AFTER INSERT ON background_jobs
WHEN NEW.job_type='DOCUMENT_BACKUP' AND NEW.status='QUEUED'
  AND EXISTS (SELECT 1 FROM document_versions version
    WHERE version.agency_id=NEW.agency_id AND version.id=NEW.document_version_id
      AND version.sha256=NEW.input_sha256 AND version.status='AVAILABLE')
BEGIN
  UPDATE documents SET current_version_id=NULL,version=version+1,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE agency_id=NEW.agency_id AND current_version_id=NEW.document_version_id;
  UPDATE document_versions SET status='BACKUP_PENDING',
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE agency_id=NEW.agency_id AND id=NEW.document_version_id
    AND sha256=NEW.input_sha256 AND status='AVAILABLE';
END;--> statement-breakpoint
CREATE TRIGGER background_jobs_identity_immutable
BEFORE UPDATE OF id,agency_id,job_type,document_version_id,input_sha256,generation,
  max_attempts,created_at ON background_jobs
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_IDENTITY_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_available_at_guard
BEFORE UPDATE OF available_at ON background_jobs
WHEN NEW.available_at IS NOT OLD.available_at AND NOT (
  OLD.status='RUNNING' AND NEW.status='RETRY_WAIT'
  AND julianday(NEW.available_at)>julianday('now'))
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_AVAILABLE_AT_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_state_transition_guard
BEFORE UPDATE OF status ON background_jobs
WHEN NEW.status<>OLD.status AND NOT (
  (OLD.status IN ('QUEUED','RETRY_WAIT') AND NEW.status IN ('RUNNING','DEAD'))
  OR (OLD.status='RUNNING' AND NEW.status IN ('RETRY_WAIT','COMPLETED','DEAD')))
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_STATE_TRANSITION_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_schedule_retry_guard
BEFORE UPDATE OF status ON background_jobs
WHEN OLD.status='RUNNING' AND NEW.status='RETRY_WAIT'
  AND julianday(NEW.available_at)<=julianday('now')
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_RETRY_SCHEDULE_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_retry_attempt_guard
BEFORE UPDATE OF status ON background_jobs
WHEN OLD.status='RUNNING' AND NEW.status='RETRY_WAIT'
  AND OLD.attempt_count>=OLD.max_attempts
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_ATTEMPTS_EXHAUSTED'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_retry_eligibility_guard
BEFORE UPDATE OF status ON background_jobs
WHEN OLD.status IN ('QUEUED','RETRY_WAIT') AND NEW.status='RUNNING'
  AND julianday(OLD.available_at)>julianday('now')
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_RETRY_NOT_DUE'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_lease_claim_guard
BEFORE UPDATE OF status ON background_jobs
WHEN OLD.status IN ('QUEUED','RETRY_WAIT') AND NEW.status='RUNNING'
  AND julianday(NEW.lease_expires_at)<=julianday('now')
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_LEASE_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_lease_renewal_guard
BEFORE UPDATE ON background_jobs
WHEN OLD.status='RUNNING' AND NEW.status='RUNNING'
  AND (NEW.lease_token_hash IS NOT OLD.lease_token_hash
    OR (julianday(NEW.lease_expires_at)>julianday(OLD.lease_expires_at)
      AND julianday(OLD.lease_expires_at)<=julianday('now')))
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_LEASE_RENEWAL_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_dead_attempt_guard
BEFORE UPDATE OF status ON background_jobs
WHEN NEW.status='DEAD' AND (
  NEW.attempt_count<>NEW.max_attempts
  OR NOT EXISTS (SELECT 1 FROM background_job_runs run
    WHERE run.agency_id=NEW.agency_id AND run.job_id=NEW.id
      AND run.attempt_number=NEW.attempt_count AND run.status<>'RUNNING'
      AND run.completed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_DEAD_ATTEMPT_REQUIRED'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_dead_fail_closed
AFTER UPDATE OF status ON background_jobs
WHEN NEW.status='DEAD' AND NEW.document_version_id IS NOT NULL
  AND ((NEW.job_type='DOCUMENT_SCAN' AND NEW.generation=(
      SELECT max(latest.generation) FROM background_jobs latest
      WHERE latest.agency_id=NEW.agency_id AND latest.job_type='DOCUMENT_SCAN'
        AND latest.document_version_id=NEW.document_version_id AND latest.input_sha256=NEW.input_sha256))
    OR (NEW.job_type='DOCUMENT_BACKUP' AND NEW.generation=(
      SELECT max(latest.generation) FROM background_jobs latest
      WHERE latest.agency_id=NEW.agency_id AND latest.job_type='DOCUMENT_BACKUP'
        AND latest.document_version_id=NEW.document_version_id AND latest.input_sha256=NEW.input_sha256)))
BEGIN
  UPDATE document_versions SET status='SCAN_FAILED',
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE agency_id=NEW.agency_id AND id=NEW.document_version_id
    AND sha256=NEW.input_sha256
    AND ((NEW.job_type='DOCUMENT_SCAN' AND status IN ('PENDING_UPLOAD','QUARANTINED','SCANNING'))
      OR (NEW.job_type='DOCUMENT_BACKUP' AND status='BACKUP_PENDING'));
END;--> statement-breakpoint
CREATE TRIGGER background_jobs_attempt_transition_guard
BEFORE UPDATE OF attempt_count,status ON background_jobs
WHEN (OLD.status IN ('QUEUED','RETRY_WAIT') AND NEW.status='RUNNING'
    AND NEW.attempt_count<>OLD.attempt_count+1)
  OR (NOT (OLD.status IN ('QUEUED','RETRY_WAIT') AND NEW.status='RUNNING')
    AND NEW.attempt_count<>OLD.attempt_count)
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_ATTEMPT_TRANSITION_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_retry_run_guard
BEFORE UPDATE OF status ON background_jobs
WHEN OLD.status='RUNNING' AND NEW.status IN ('RETRY_WAIT','DEAD')
  AND NOT EXISTS (SELECT 1 FROM background_job_runs run
    WHERE run.agency_id=OLD.agency_id AND run.job_id=OLD.id
      AND run.attempt_number=OLD.attempt_count AND run.status<>'RUNNING'
      AND run.completed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_RUN_COMPLETION_REQUIRED'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_completion_evidence_guard
BEFORE UPDATE OF status ON background_jobs
WHEN NEW.status='COMPLETED' AND NOT EXISTS (
  SELECT 1 FROM background_job_runs run
  WHERE run.agency_id=NEW.agency_id AND run.job_id=NEW.id
    AND run.attempt_number=NEW.attempt_count AND run.completed_at IS NOT NULL
    AND (NEW.job_type NOT IN ('DOCUMENT_SCAN','DOCUMENT_BACKUP') OR NEW.generation=(
      SELECT max(latest.generation) FROM background_jobs latest
      WHERE latest.agency_id=NEW.agency_id AND latest.job_type=NEW.job_type
        AND latest.document_version_id=NEW.document_version_id
        AND latest.input_sha256=NEW.input_sha256))
    AND ((NEW.job_type='DOCUMENT_SCAN' AND run.status IN ('SUCCEEDED','INFECTED','PERMANENT_ERROR','STALE'))
      OR (NEW.job_type='DOCUMENT_BACKUP' AND run.status='SUCCEEDED')
      OR (NEW.job_type IN ('DOCUMENT_RECONCILE','DOCUMENT_RESTORE')
        AND run.status IN ('SUCCEEDED','PERMANENT_ERROR','STALE')))
)
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_COMPLETION_EVIDENCE_REQUIRED'); END;--> statement-breakpoint
CREATE TRIGGER background_jobs_no_delete
BEFORE DELETE ON background_jobs
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_DELETE_FORBIDDEN'); END;--> statement-breakpoint
CREATE TRIGGER background_job_runs_insert_guard
BEFORE INSERT ON background_job_runs
WHEN NEW.status<>'RUNNING' OR NOT EXISTS (
  SELECT 1 FROM background_jobs job
  WHERE job.agency_id=NEW.agency_id AND job.id=NEW.job_id
    AND job.status='RUNNING' AND job.attempt_count=NEW.attempt_number
    AND job.lease_token_hash=NEW.lease_token_hash
    AND julianday(NEW.started_at)>=julianday(job.created_at)
    AND julianday(NEW.started_at)>=julianday('now','-10 seconds')
    AND julianday(NEW.started_at)<=julianday('now')
    AND julianday(job.lease_expires_at)>julianday(NEW.started_at)
    AND julianday(job.lease_expires_at)>julianday('now'))
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_RUN_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER background_job_runs_update_guard
BEFORE UPDATE ON background_job_runs
WHEN OLD.status<>'RUNNING' OR NEW.id<>OLD.id OR NEW.agency_id<>OLD.agency_id
  OR NEW.job_id<>OLD.job_id OR NEW.attempt_number<>OLD.attempt_number
  OR NEW.lease_token_hash<>OLD.lease_token_hash
  OR NEW.started_at<>OLD.started_at OR NEW.status='RUNNING'
  OR julianday(NEW.completed_at)<julianday(OLD.started_at)
  OR julianday(NEW.completed_at)<julianday('now','-10 seconds')
  OR julianday(NEW.completed_at)>julianday('now')
  OR NOT EXISTS (SELECT 1 FROM background_jobs job
    WHERE job.agency_id=OLD.agency_id AND job.id=OLD.job_id
      AND job.status='RUNNING' AND job.attempt_count=OLD.attempt_number
      AND job.lease_token_hash=OLD.lease_token_hash
      AND ((NEW.status='STALE' AND julianday(job.lease_expires_at)<=julianday('now'))
        OR (NEW.status<>'STALE' AND julianday(job.lease_expires_at)>julianday('now'))))
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_RUN_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER background_job_runs_no_delete
BEFORE DELETE ON background_job_runs
BEGIN SELECT RAISE(ABORT,'BACKGROUND_JOB_RUN_DELETE_FORBIDDEN'); END;--> statement-breakpoint
CREATE TRIGGER document_scan_evidence_insert_guard
BEFORE INSERT ON document_scan_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM document_versions version
  JOIN background_job_runs run ON run.agency_id=NEW.agency_id AND run.id=NEW.job_run_id
  JOIN background_jobs job ON job.agency_id=run.agency_id AND job.id=run.job_id
  WHERE version.agency_id=NEW.agency_id AND version.id=NEW.document_version_id
    AND version.sha256=NEW.sha256 AND job.job_type='DOCUMENT_SCAN'
    AND job.document_version_id=version.id AND job.input_sha256=NEW.sha256
    AND job.status='COMPLETED' AND job.attempt_count=run.attempt_number
    AND julianday(NEW.scanned_at)>=julianday(run.started_at)
    AND julianday(NEW.scanned_at)<=julianday(run.completed_at)
    AND julianday(NEW.scanned_at)<=julianday('now')
    AND (NEW.outcome<>'CLEAN' OR (
      julianday(NEW.signature_updated_at)<=julianday(NEW.scanned_at)
      AND julianday(NEW.signature_updated_at)>=julianday('now','-48 hours')))
    AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
      WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_SCAN'
        AND latest.document_version_id=version.id AND latest.input_sha256=version.sha256)
    AND ((NEW.outcome='CLEAN' AND run.status='SUCCEEDED')
      OR (NEW.outcome='INFECTED' AND run.status='INFECTED')
      OR (NEW.outcome='INVALID' AND run.status='PERMANENT_ERROR')
      OR (NEW.outcome='ERROR' AND run.status IN ('RETRYABLE_ERROR','PERMANENT_ERROR','STALE')))
)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_SCAN_EVIDENCE_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER document_scan_evidence_finalize_failure
AFTER INSERT ON document_scan_evidence
WHEN NEW.outcome IN ('INFECTED','INVALID','ERROR')
BEGIN
  UPDATE document_versions SET status=CASE
      WHEN NEW.outcome IN ('INFECTED','INVALID') THEN 'REJECTED'
      ELSE 'SCAN_FAILED' END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE agency_id=NEW.agency_id AND id=NEW.document_version_id AND sha256=NEW.sha256
    AND status='SCANNING';
END;--> statement-breakpoint
CREATE TRIGGER document_scan_evidence_immutable_update
BEFORE UPDATE ON document_scan_evidence
BEGIN SELECT RAISE(ABORT,'DOCUMENT_SCAN_EVIDENCE_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER document_scan_evidence_immutable_delete
BEFORE DELETE ON document_scan_evidence
BEGIN SELECT RAISE(ABORT,'DOCUMENT_SCAN_EVIDENCE_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER document_backup_copies_insert_guard
BEFORE INSERT ON document_backup_copies
WHEN NOT EXISTS (
  SELECT 1 FROM document_versions version
  JOIN background_job_runs run ON run.agency_id=NEW.agency_id AND run.id=NEW.job_run_id
  JOIN background_jobs job ON job.agency_id=run.agency_id AND job.id=run.job_id
  WHERE version.agency_id=NEW.agency_id AND version.id=NEW.document_version_id
    AND version.sha256=NEW.source_sha256 AND NEW.backup_sha256=version.sha256
    AND job.job_type='DOCUMENT_BACKUP' AND job.document_version_id=version.id
    AND job.input_sha256=version.sha256 AND job.status='COMPLETED'
    AND job.attempt_count=run.attempt_number AND run.status='SUCCEEDED'
    AND job.generation=(SELECT max(latest.generation) FROM background_jobs latest
      WHERE latest.agency_id=job.agency_id AND latest.job_type='DOCUMENT_BACKUP'
        AND latest.document_version_id=version.id AND latest.input_sha256=version.sha256)
    AND EXISTS (SELECT 1 FROM document_latest_scan_evidence evidence
      WHERE evidence.agency_id=version.agency_id
        AND evidence.document_version_id=version.id AND evidence.sha256=version.sha256
        AND evidence.outcome='CLEAN' AND evidence.run_status='SUCCEEDED')
)
BEGIN SELECT RAISE(ABORT,'DOCUMENT_BACKUP_COPY_INVALID'); END;--> statement-breakpoint
CREATE TRIGGER document_backup_copies_immutable_update
BEFORE UPDATE ON document_backup_copies
BEGIN SELECT RAISE(ABORT,'DOCUMENT_BACKUP_EVIDENCE_IMMUTABLE'); END;--> statement-breakpoint
CREATE TRIGGER document_backup_copies_immutable_delete
BEFORE DELETE ON document_backup_copies
BEGIN SELECT RAISE(ABORT,'DOCUMENT_BACKUP_EVIDENCE_IMMUTABLE'); END;