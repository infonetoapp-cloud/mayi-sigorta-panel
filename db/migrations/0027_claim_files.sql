CREATE TABLE `claim_files` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`insurer_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`data_classification` text NOT NULL,
	`loss_date` text NOT NULL,
	`file_number` text,
	`normalized_file_number` text,
	`expert_name` text,
	`expert_contact` text,
	`status` text NOT NULL,
	`note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`insurer_id`) REFERENCES `insurers`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`branch_id`) REFERENCES `insurance_branches`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claim_files_class" CHECK("claim_files"."data_classification" IN ('GENERAL','HEALTH')),
	CONSTRAINT "claim_files_status" CHECK("claim_files"."status" IN ('WAITING','IN_PROGRESS','COMPLETED')),
	CONSTRAINT "claim_files_version" CHECK("claim_files"."version" BETWEEN 1 AND 1000000000),
	CONSTRAINT "claim_files_date" CHECK(length("claim_files"."loss_date")=10 AND date("claim_files"."loss_date",'+0 days') IS NOT NULL AND date("claim_files"."loss_date",'+0 days')="claim_files"."loss_date"),
	CONSTRAINT "claim_files_number" CHECK(("claim_files"."file_number" IS NULL AND "claim_files"."normalized_file_number" IS NULL) OR ("claim_files"."file_number" IS NOT NULL AND "claim_files"."normalized_file_number" IS NOT NULL AND length(trim("claim_files"."file_number")) BETWEEN 1 AND 80 AND length("claim_files"."normalized_file_number") BETWEEN 1 AND 80))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_files_agency_id_uq` ON `claim_files` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `claim_files_insurer_number_uq` ON `claim_files` (`agency_id`,`insurer_id`,`normalized_file_number`);--> statement-breakpoint
CREATE INDEX `claim_files_date_idx` ON `claim_files` (`agency_id`,`loss_date`,`id`);--> statement-breakpoint
CREATE TABLE `claim_history` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`version` integer NOT NULL,
	`data_classification` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`claim_id`) REFERENCES `claim_files`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "claim_history_json" CHECK(json_valid("claim_history"."snapshot_json") AND json_type("claim_history"."snapshot_json")='object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_history_version_uq` ON `claim_history` (`agency_id`,`claim_id`,`version`);
--> statement-breakpoint
CREATE TRIGGER claim_insert_guard BEFORE INSERT ON claim_files BEGIN
 SELECT CASE WHEN (NEW.file_number IS NULL)<>(NEW.normalized_file_number IS NULL) OR (NEW.expert_name IS NOT NULL AND length(trim(NEW.expert_name)) NOT BETWEEN 1 AND 120) OR (NEW.expert_contact IS NOT NULL AND length(trim(NEW.expert_contact)) NOT BETWEEN 1 AND 160) OR (NEW.note IS NOT NULL AND length(trim(NEW.note)) NOT BETWEEN 1 AND 1000) OR NEW.data_classification NOT IN ('GENERAL','HEALTH') THEN RAISE(ABORT,'CLAIM_FIELDS_INVALID') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM policies p JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.customer_id=NEW.customer_id AND p.insurer_id=NEW.insurer_id AND p.branch_id=NEW.branch_id AND b.data_classification=NEW.data_classification AND p.start_date<=NEW.loss_date AND p.end_date>=NEW.loss_date) THEN RAISE(ABORT,'CLAIM_PARENT_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER claim_update_guard BEFORE UPDATE ON claim_files BEGIN
 SELECT CASE WHEN (NEW.file_number IS NULL)<>(NEW.normalized_file_number IS NULL) OR (NEW.expert_name IS NOT NULL AND length(trim(NEW.expert_name)) NOT BETWEEN 1 AND 120) OR (NEW.expert_contact IS NOT NULL AND length(trim(NEW.expert_contact)) NOT BETWEEN 1 AND 160) OR (NEW.note IS NOT NULL AND length(trim(NEW.note)) NOT BETWEEN 1 AND 1000) OR NEW.data_classification NOT IN ('GENERAL','HEALTH') THEN RAISE(ABORT,'CLAIM_FIELDS_INVALID') END;
 SELECT CASE WHEN NEW.id<>OLD.id OR NEW.agency_id<>OLD.agency_id OR NEW.policy_id<>OLD.policy_id OR NEW.customer_id<>OLD.customer_id OR NEW.insurer_id<>OLD.insurer_id OR NEW.branch_id<>OLD.branch_id OR (OLD.data_classification='HEALTH' AND NEW.data_classification<>'HEALTH') OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE(ABORT,'CLAIM_IMMUTABLE') END;
END;
--> statement-breakpoint
CREATE TRIGGER claim_no_delete BEFORE DELETE ON claim_files BEGIN SELECT RAISE(ABORT,'CLAIM_HISTORY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER claim_history_insert_guard BEFORE INSERT ON claim_history BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM claim_files r WHERE r.agency_id=NEW.agency_id AND r.id=NEW.claim_id AND r.version=NEW.version AND r.data_classification=NEW.data_classification AND json_extract(NEW.snapshot_json,'$.lossDate') IS r.loss_date AND json_extract(NEW.snapshot_json,'$.fileNumber') IS r.file_number AND json_extract(NEW.snapshot_json,'$.expertName') IS r.expert_name AND json_extract(NEW.snapshot_json,'$.expertContact') IS r.expert_contact AND json_extract(NEW.snapshot_json,'$.status') IS r.status AND json_extract(NEW.snapshot_json,'$.note') IS r.note) THEN RAISE(ABORT,'CLAIM_HISTORY_INVALID') END;
END;
--> statement-breakpoint
CREATE TRIGGER claim_history_no_update BEFORE UPDATE ON claim_history BEGIN SELECT RAISE(ABORT,'CLAIM_HISTORY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER claim_history_no_delete BEFORE DELETE ON claim_history BEGIN SELECT RAISE(ABORT,'CLAIM_HISTORY_IMMUTABLE'); END;
