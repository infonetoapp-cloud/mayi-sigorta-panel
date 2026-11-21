CREATE TABLE `policy_cancellations` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`before_version` integer NOT NULL,
	`after_version` integer NOT NULL,
	`event_date` text NOT NULL,
	`reason_code` text NOT NULL,
	`notes` text,
	`loss_reason_id` text,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`receipt_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`loss_reason_id`) REFERENCES `loss_reasons`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "policy_cancellations_version" CHECK("policy_cancellations"."before_version">=1 AND "policy_cancellations"."after_version"="policy_cancellations"."before_version"+1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_cancellations_agency_id_uq` ON `policy_cancellations` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_cancellations_policy_uq` ON `policy_cancellations` (`agency_id`,`policy_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_cancellations_receipt_uq` ON `policy_cancellations` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `policy_lifecycle_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`cancellation_id` text,
	`void_event_id` text,
	`renewal_id` text,
	`task_id` text,
	`before_version` integer NOT NULL,
	`after_version` integer NOT NULL,
	FOREIGN KEY (`agency_id`,`cancellation_id`) REFERENCES `policy_cancellations`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`void_event_id`) REFERENCES `policy_void_events`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`task_id`) REFERENCES `tasks`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "policy_lifecycle_targets_event_xor" CHECK(("policy_lifecycle_targets"."cancellation_id" IS NOT NULL) != ("policy_lifecycle_targets"."void_event_id" IS NOT NULL)),
	CONSTRAINT "policy_lifecycle_targets_target_xor" CHECK(("policy_lifecycle_targets"."renewal_id" IS NOT NULL) != ("policy_lifecycle_targets"."task_id" IS NOT NULL)),
	CONSTRAINT "policy_lifecycle_targets_version" CHECK("policy_lifecycle_targets"."before_version">=1 AND "policy_lifecycle_targets"."after_version"="policy_lifecycle_targets"."before_version"+1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_lifecycle_targets_cancel_renewal_uq` ON `policy_lifecycle_targets` (`cancellation_id`,`renewal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_lifecycle_targets_cancel_task_uq` ON `policy_lifecycle_targets` (`cancellation_id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_lifecycle_targets_void_renewal_uq` ON `policy_lifecycle_targets` (`void_event_id`,`renewal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_lifecycle_targets_void_task_uq` ON `policy_lifecycle_targets` (`void_event_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `policy_void_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`before_version` integer NOT NULL,
	`after_version` integer NOT NULL,
	`event_date` text NOT NULL,
	`reason_code` text NOT NULL,
	`notes` text,
	`loss_reason_id` text,
	`actor_user_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`receipt_id`) REFERENCES `operation_receipts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`loss_reason_id`) REFERENCES `loss_reasons`(`agency_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "policy_void_events_version" CHECK("policy_void_events"."before_version">=1 AND "policy_void_events"."after_version"="policy_void_events"."before_version"+1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_void_events_agency_id_uq` ON `policy_void_events` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_void_events_policy_uq` ON `policy_void_events` (`agency_id`,`policy_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_void_events_receipt_uq` ON `policy_void_events` (`receipt_id`);
--> statement-breakpoint
CREATE TRIGGER policy_cancellations_insert_guard BEFORE INSERT ON policy_cancellations
WHEN NOT (NEW.reason_code IN ('VEHICLE_SOLD','PAYMENT_DIFFICULTY','CUSTOMER_REQUEST','OTHER')) OR length(NEW.event_date)!=10 OR date(NEW.event_date) IS NULL OR date(NEW.event_date)!=NEW.event_date
 OR NEW.event_date>date('now','+3 hours') OR length(trim(coalesce(NEW.notes,'')))>500
 OR (NEW.reason_code='OTHER' AND length(trim(coalesce(NEW.notes,'')))=0)
 OR NOT EXISTS(SELECT 1 FROM policies p JOIN operation_receipts r ON r.id=NEW.receipt_id
   WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.status='ACTIVE' AND p.archived_at IS NULL
     AND p.version=NEW.before_version AND NEW.after_version=NEW.before_version+1
     AND ('CANCELLED'='VOIDED' OR NEW.event_date BETWEEN p.start_date AND p.end_date)
     AND r.agency_id=NEW.agency_id AND r.actor_user_id=NEW.actor_user_id AND r.actor_membership_id=NEW.actor_membership_id
     AND r.action='policy.cancel' AND r.status='COMPLETED' AND json_extract(r.response_body,'$.result.eventId')=NEW.id
     AND json_extract(r.response_body,'$.result.policyId')=NEW.policy_id AND json_extract(r.response_body,'$.result.policyVersion')=NEW.after_version)
BEGIN SELECT RAISE(ABORT,'POLICY_LIFECYCLE_EVIDENCE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER policy_cancellations_no_update BEFORE UPDATE ON policy_cancellations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER policy_cancellations_no_delete BEFORE DELETE ON policy_cancellations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;

--> statement-breakpoint
CREATE TRIGGER policy_void_events_insert_guard BEFORE INSERT ON policy_void_events
WHEN NOT (NEW.reason_code IN ('DUPLICATE','TECHNICAL_ERROR')) OR length(NEW.event_date)!=10 OR date(NEW.event_date) IS NULL OR date(NEW.event_date)!=NEW.event_date
 OR NEW.event_date>date('now','+3 hours') OR length(trim(coalesce(NEW.notes,'')))>500
 OR (NEW.reason_code='OTHER' AND length(trim(coalesce(NEW.notes,'')))=0)
 OR NOT EXISTS(SELECT 1 FROM policies p JOIN operation_receipts r ON r.id=NEW.receipt_id
   WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.status='ACTIVE' AND p.archived_at IS NULL
     AND p.version=NEW.before_version AND NEW.after_version=NEW.before_version+1
     AND ('VOIDED'='VOIDED' OR NEW.event_date BETWEEN p.start_date AND p.end_date)
     AND r.agency_id=NEW.agency_id AND r.actor_user_id=NEW.actor_user_id AND r.actor_membership_id=NEW.actor_membership_id
     AND r.action='policy.void' AND r.status='COMPLETED' AND json_extract(r.response_body,'$.result.eventId')=NEW.id
     AND json_extract(r.response_body,'$.result.policyId')=NEW.policy_id AND json_extract(r.response_body,'$.result.policyVersion')=NEW.after_version)
BEGIN SELECT RAISE(ABORT,'POLICY_LIFECYCLE_EVIDENCE_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER policy_void_events_no_update BEFORE UPDATE ON policy_void_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER policy_void_events_no_delete BEFORE DELETE ON policy_void_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;

--> statement-breakpoint
CREATE TRIGGER policy_lifecycle_new_active BEFORE INSERT ON policies
WHEN NEW.status!='ACTIVE' BEGIN SELECT RAISE(ABORT,'POLICY_LIFECYCLE_COMMAND_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER policy_lifecycle_status_guard BEFORE UPDATE OF status ON policies
WHEN NEW.status!=OLD.status AND (
  OLD.status!='ACTIVE' OR NEW.archived_at IS NOT NULL OR NEW.version!=OLD.version+1 OR
  (NEW.status='CANCELLED' AND NOT EXISTS(SELECT 1 FROM policy_cancellations e WHERE e.agency_id=OLD.agency_id AND e.policy_id=OLD.id AND e.before_version=OLD.version AND e.after_version=NEW.version)) OR
  (NEW.status='VOIDED' AND NOT EXISTS(SELECT 1 FROM policy_void_events e WHERE e.agency_id=OLD.agency_id AND e.policy_id=OLD.id AND e.before_version=OLD.version AND e.after_version=NEW.version)))
BEGIN SELECT RAISE(ABORT,'POLICY_LIFECYCLE_COMMAND_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER policy_lifecycle_targets_insert_guard BEFORE INSERT ON policy_lifecycle_targets
WHEN NOT EXISTS(
 SELECT 1 FROM policies p WHERE p.agency_id=NEW.agency_id AND
 ((NEW.cancellation_id IS NOT NULL AND EXISTS(SELECT 1 FROM policy_cancellations e WHERE e.agency_id=p.agency_id AND e.policy_id=p.id AND e.id=NEW.cancellation_id AND p.status='CANCELLED'))
 OR (NEW.void_event_id IS NOT NULL AND EXISTS(SELECT 1 FROM policy_void_events e WHERE e.agency_id=p.agency_id AND e.policy_id=p.id AND e.id=NEW.void_event_id AND p.status='VOIDED')))
 AND ((NEW.renewal_id IS NOT NULL AND EXISTS(SELECT 1 FROM renewal_opportunities r WHERE r.agency_id=p.agency_id AND r.expiring_policy_id=p.id AND r.id=NEW.renewal_id AND r.version=NEW.after_version AND r.state=CASE WHEN NEW.cancellation_id IS NOT NULL THEN 'LOST' ELSE 'VOIDED' END))
 OR (NEW.task_id IS NOT NULL AND EXISTS(SELECT 1 FROM tasks t JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id WHERE t.agency_id=p.agency_id AND r.expiring_policy_id=p.id AND t.id=NEW.task_id AND t.kind='RENEWAL_FOLLOWUP' AND t.status='COMPLETED' AND t.version=NEW.after_version))))
BEGIN SELECT RAISE(ABORT,'POLICY_LIFECYCLE_TARGET_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER policy_lifecycle_targets_no_update BEFORE UPDATE ON policy_lifecycle_targets BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;
--> statement-breakpoint
CREATE TRIGGER policy_lifecycle_targets_no_delete BEFORE DELETE ON policy_lifecycle_targets BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY'); END;

--> statement-breakpoint
-- Seed only missing codes; never rewrite an existing agency's catalog meaning or status.
INSERT INTO loss_reasons(id,agency_id,code,name)
SELECT lower(hex(randomblob(16))),a.id,r.code,r.name FROM agencies a CROSS JOIN (
 SELECT 'VEHICLE_SOLD' code,'Araç / sigortalı varlık satıldı' name UNION ALL
 SELECT 'PAYMENT_DIFFICULTY','Ödeme yapılamadı' UNION ALL
 SELECT 'CUSTOMER_REQUEST','Müşteri talebi' UNION ALL SELECT 'OTHER','Diğer'
) r WHERE NOT EXISTS(SELECT 1 FROM loss_reasons l WHERE l.agency_id=a.id AND l.code=r.code);

--> statement-breakpoint
-- Terminal contract facts are historical evidence; assignment/archive/version metadata remain separate.
CREATE TRIGGER policy_lifecycle_terminal_contract_guard BEFORE UPDATE OF customer_id,insurer_id,product_id,branch_id,payment_method_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,installment_count ON policies
WHEN OLD.status IN ('CANCELLED','VOIDED') AND (
 NEW.customer_id IS NOT OLD.customer_id OR NEW.insurer_id IS NOT OLD.insurer_id OR NEW.product_id IS NOT OLD.product_id
 OR NEW.branch_id IS NOT OLD.branch_id OR NEW.payment_method_id IS NOT OLD.payment_method_id OR NEW.policy_number IS NOT OLD.policy_number
 OR NEW.normalized_policy_number IS NOT OLD.normalized_policy_number OR NEW.start_date IS NOT OLD.start_date OR NEW.end_date IS NOT OLD.end_date
 OR NEW.gross_premium_minor IS NOT OLD.gross_premium_minor OR NEW.currency IS NOT OLD.currency OR NEW.installment_count IS NOT OLD.installment_count)
BEGIN SELECT RAISE(ABORT,'POLICY_TERMINAL_READONLY'); END;
