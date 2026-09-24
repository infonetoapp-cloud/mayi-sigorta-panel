CREATE TABLE `renewal_generation_cursors` (
	`agency_id` text PRIMARY KEY NOT NULL,
	`last_successful_local_date` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_generation_cursors_date_shape" CHECK("renewal_generation_cursors"."last_successful_local_date" IS NULL OR "renewal_generation_cursors"."last_successful_local_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "renewal_generation_cursors_version_positive" CHECK("renewal_generation_cursors"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE `renewal_opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`expiring_policy_id` text NOT NULL,
	`assignee_membership_id` text,
	`state` text DEFAULT 'CONTACT_PENDING' NOT NULL,
	`loss_reason_id` text,
	`loss_reason_notes` text,
	`void_reason_code` text,
	`closed_at` text,
	`closed_by_membership_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`expiring_policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`assignee_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`loss_reason_id`) REFERENCES `loss_reasons`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`closed_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_opportunities_id_nonempty" CHECK(length(trim("renewal_opportunities"."id")) > 0),
	CONSTRAINT "renewal_opportunities_state_valid" CHECK("renewal_opportunities"."state" IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE','WON','LOST','VOIDED')),
	CONSTRAINT "renewal_opportunities_version_positive" CHECK("renewal_opportunities"."version" >= 1),
	CONSTRAINT "renewal_opportunities_timestamps_ordered" CHECK("renewal_opportunities"."updated_at" >= "renewal_opportunities"."created_at"),
	CONSTRAINT "renewal_opportunities_terminal_fields_consistent" CHECK(("renewal_opportunities"."state" IN ('WON','LOST','VOIDED') AND "renewal_opportunities"."closed_at" IS NOT NULL AND "renewal_opportunities"."closed_by_membership_id" IS NOT NULL) OR ("renewal_opportunities"."state" NOT IN ('WON','LOST','VOIDED') AND "renewal_opportunities"."closed_at" IS NULL AND "renewal_opportunities"."closed_by_membership_id" IS NULL)),
	CONSTRAINT "renewal_opportunities_loss_reason_consistent" CHECK(("renewal_opportunities"."state"='LOST' AND "renewal_opportunities"."loss_reason_id" IS NOT NULL) OR ("renewal_opportunities"."state"<>'LOST' AND "renewal_opportunities"."loss_reason_id" IS NULL AND "renewal_opportunities"."loss_reason_notes" IS NULL)),
	CONSTRAINT "renewal_opportunities_void_reason_consistent" CHECK(("renewal_opportunities"."state"='VOIDED' AND "renewal_opportunities"."void_reason_code" IS NOT NULL AND length(trim("renewal_opportunities"."void_reason_code"))>0) OR ("renewal_opportunities"."state"<>'VOIDED' AND "renewal_opportunities"."void_reason_code" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_opportunities_agency_id_id_uq` ON `renewal_opportunities` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_opportunities_expiring_policy_uq` ON `renewal_opportunities` (`agency_id`,`expiring_policy_id`);--> statement-breakpoint
CREATE INDEX `renewal_opportunities_state_idx` ON `renewal_opportunities` (`agency_id`,`state`,`id`);--> statement-breakpoint
CREATE INDEX `renewal_opportunities_assignee_state_idx` ON `renewal_opportunities` (`agency_id`,`assignee_membership_id`,`state`,`id`);--> statement-breakpoint
CREATE TABLE `renewal_state_history` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`renewal_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`actor_membership_id` text,
	`reason_code` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`actor_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "renewal_state_history_id_nonempty" CHECK(length(trim("renewal_state_history"."id")) > 0),
	CONSTRAINT "renewal_state_history_from_state_valid" CHECK("renewal_state_history"."from_state" IS NULL OR "renewal_state_history"."from_state" IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE','WON','LOST','VOIDED')),
	CONSTRAINT "renewal_state_history_to_state_valid" CHECK("renewal_state_history"."to_state" IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE','WON','LOST','VOIDED')),
	CONSTRAINT "renewal_state_history_actor_consistent" CHECK(("renewal_state_history"."actor_kind"='USER' AND "renewal_state_history"."actor_user_id" IS NOT NULL AND "renewal_state_history"."actor_membership_id" IS NOT NULL) OR ("renewal_state_history"."actor_kind"='SYSTEM' AND "renewal_state_history"."actor_user_id" IS NULL AND "renewal_state_history"."actor_membership_id" IS NULL)),
	CONSTRAINT "renewal_state_history_reason_nonempty" CHECK(length(trim("renewal_state_history"."reason_code")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_state_history_agency_id_id_uq` ON `renewal_state_history` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_state_history_initial_uq` ON `renewal_state_history` (`agency_id`,`renewal_id`) WHERE "renewal_state_history"."from_state" IS NULL;--> statement-breakpoint
CREATE INDEX `renewal_state_history_renewal_created_idx` ON `renewal_state_history` (`agency_id`,`renewal_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `system_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`system_actor_code` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "system_audit_events_id_nonempty" CHECK(length(trim("system_audit_events"."id")) > 0),
	CONSTRAINT "system_audit_events_actor_code_nonempty" CHECK(length(trim("system_audit_events"."system_actor_code")) > 0),
	CONSTRAINT "system_audit_events_action_nonempty" CHECK(length(trim("system_audit_events"."action")) > 0),
	CONSTRAINT "system_audit_events_target_type_nonempty" CHECK(length(trim("system_audit_events"."target_type")) > 0),
	CONSTRAINT "system_audit_events_target_id_nonempty" CHECK(length(trim("system_audit_events"."target_id")) > 0),
	CONSTRAINT "system_audit_events_correlation_id_nonempty" CHECK(length(trim("system_audit_events"."correlation_id")) > 0),
	CONSTRAINT "system_audit_events_key_nonempty" CHECK(length(trim("system_audit_events"."idempotency_key")) > 0),
	CONSTRAINT "system_audit_events_reason_nonempty" CHECK(length(trim("system_audit_events"."reason_code")) > 0),
	CONSTRAINT "system_audit_events_outcome_valid" CHECK("system_audit_events"."outcome" IN ('SUCCESS','FAILURE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_audit_events_idempotency_uq` ON `system_audit_events` (`agency_id`,`system_actor_code`,`action`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `system_audit_events_target_idx` ON `system_audit_events` (`agency_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `system_audit_events_created_idx` ON `system_audit_events` (`agency_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`policy_id` text,
	`renewal_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`due_at` text NOT NULL,
	`assignee_membership_id` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`completed_at` text,
	`completed_by_membership_id` text,
	`actor_kind` text NOT NULL,
	`created_by_user_id` text,
	`created_by_membership_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`renewal_id`) REFERENCES `renewal_opportunities`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`assignee_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`created_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`completed_by_membership_id`) REFERENCES `agency_memberships`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "tasks_id_nonempty" CHECK(length(trim("tasks"."id")) > 0),
	CONSTRAINT "tasks_title_nonempty" CHECK(length(trim("tasks"."title")) > 0),
	CONSTRAINT "tasks_kind_valid" CHECK("tasks"."kind" IN ('GENERAL','RENEWAL_FOLLOWUP')),
	CONSTRAINT "tasks_status_valid" CHECK("tasks"."status" IN ('OPEN','COMPLETED')),
	CONSTRAINT "tasks_version_positive" CHECK("tasks"."version" >= 1),
	CONSTRAINT "tasks_timestamps_ordered" CHECK("tasks"."updated_at" >= "tasks"."created_at"),
	CONSTRAINT "tasks_kind_parent_consistent" CHECK(("tasks"."kind"='RENEWAL_FOLLOWUP' AND "tasks"."renewal_id" IS NOT NULL AND "tasks"."policy_id" IS NULL) OR ("tasks"."kind"='GENERAL' AND "tasks"."renewal_id" IS NULL)),
	CONSTRAINT "tasks_completion_consistent" CHECK(("tasks"."status"='OPEN' AND "tasks"."completed_at" IS NULL AND "tasks"."completed_by_membership_id" IS NULL) OR ("tasks"."status"='COMPLETED' AND "tasks"."completed_at" IS NOT NULL AND "tasks"."completed_by_membership_id" IS NOT NULL)),
	CONSTRAINT "tasks_creator_consistent" CHECK(("tasks"."actor_kind"='USER' AND "tasks"."created_by_user_id" IS NOT NULL AND "tasks"."created_by_membership_id" IS NOT NULL) OR ("tasks"."actor_kind"='SYSTEM' AND "tasks"."created_by_user_id" IS NULL AND "tasks"."created_by_membership_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_agency_id_id_uq` ON `tasks` (`agency_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_open_renewal_followup_uq` ON `tasks` (`agency_id`,`renewal_id`) WHERE "tasks"."kind"='RENEWAL_FOLLOWUP' AND "tasks"."status"='OPEN';--> statement-breakpoint
CREATE INDEX `tasks_today_lookup_idx` ON `tasks` (`agency_id`,`status`,`due_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_status_due_idx` ON `tasks` (`agency_id`,`assignee_membership_id`,`status`,`due_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_customer_due_idx` ON `tasks` (`agency_id`,`customer_id`,`due_at`);--> statement-breakpoint
CREATE TRIGGER renewal_state_history_no_update
BEFORE UPDATE ON renewal_state_history
BEGIN
  SELECT RAISE(ABORT, 'RENEWAL_STATE_HISTORY_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER renewal_state_history_no_delete
BEFORE DELETE ON renewal_state_history
BEGIN
  SELECT RAISE(ABORT, 'RENEWAL_STATE_HISTORY_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER system_audit_events_no_update
BEFORE UPDATE ON system_audit_events
BEGIN
  SELECT RAISE(ABORT, 'SYSTEM_AUDIT_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER system_audit_events_no_delete
BEFORE DELETE ON system_audit_events
BEGIN
  SELECT RAISE(ABORT, 'SYSTEM_AUDIT_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER tasks_renewal_customer_insert
BEFORE INSERT ON tasks
WHEN NEW.renewal_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_opportunities r
    JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
    WHERE r.agency_id=NEW.agency_id AND r.id=NEW.renewal_id AND p.customer_id=NEW.customer_id
  ) THEN RAISE(ABORT, 'TASK_RENEWAL_CUSTOMER_MISMATCH') END;
END;--> statement-breakpoint
CREATE TRIGGER tasks_renewal_customer_update
BEFORE UPDATE OF agency_id,customer_id,renewal_id ON tasks
WHEN NEW.renewal_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM renewal_opportunities r
    JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
    WHERE r.agency_id=NEW.agency_id AND r.id=NEW.renewal_id AND p.customer_id=NEW.customer_id
  ) THEN RAISE(ABORT, 'TASK_RENEWAL_CUSTOMER_MISMATCH') END;
END;--> statement-breakpoint
CREATE TRIGGER tasks_policy_customer_insert
BEFORE INSERT ON tasks
WHEN NEW.policy_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM policies p
    WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.customer_id=NEW.customer_id
  ) THEN RAISE(ABORT, 'TASK_POLICY_CUSTOMER_MISMATCH') END;
END;--> statement-breakpoint
CREATE TRIGGER tasks_policy_customer_update
BEFORE UPDATE OF agency_id,customer_id,policy_id ON tasks
WHEN NEW.policy_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM policies p
    WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.customer_id=NEW.customer_id
  ) THEN RAISE(ABORT, 'TASK_POLICY_CUSTOMER_MISMATCH') END;
END;--> statement-breakpoint
CREATE TRIGGER policies_archive_open_renewal_guard
BEFORE UPDATE OF archived_at ON policies
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM renewal_opportunities r
      WHERE r.agency_id=OLD.agency_id AND r.expiring_policy_id=OLD.id
        AND r.state NOT IN ('WON','LOST','VOIDED')
    )
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
      WHERE r.agency_id=OLD.agency_id AND r.expiring_policy_id=OLD.id
        AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'POLICY_OPEN_DEPENDENCIES');
END;--> statement-breakpoint
CREATE TRIGGER policies_terminal_status_open_renewal_guard
BEFORE UPDATE OF status ON policies
WHEN NEW.status IN ('CANCELLED','VOIDED')
  AND (
    EXISTS (
      SELECT 1 FROM renewal_opportunities r
      WHERE r.agency_id=OLD.agency_id AND r.expiring_policy_id=OLD.id
        AND r.state NOT IN ('WON','LOST','VOIDED')
    )
    OR EXISTS (
      SELECT 1 FROM tasks t
      JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
      WHERE r.agency_id=OLD.agency_id AND r.expiring_policy_id=OLD.id
        AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'POLICY_OPEN_DEPENDENCIES');
END;--> statement-breakpoint
CREATE VIEW audit_event_records AS
SELECT id,agency_id,'USER' AS actor_kind,actor_user_id,actor_membership_id,
       NULL AS system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,
       outcome,NULL AS reason_code,metadata_json,created_at
FROM audit_events
UNION ALL
SELECT id,agency_id,'SYSTEM' AS actor_kind,NULL AS actor_user_id,NULL AS actor_membership_id,
       system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,
       outcome,reason_code,metadata_json,created_at
FROM system_audit_events;