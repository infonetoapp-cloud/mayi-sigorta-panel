-- Rebuild the dependent pair with foreign keys kept enabled; preserve historical snapshots before recreating capture guards.
DROP TRIGGER policy_vehicle_snapshot_insert_guard;--> statement-breakpoint
DROP TRIGGER policy_vehicle_snapshot_update_guard;--> statement-breakpoint
DROP TRIGGER customer_vehicles_parent_immutable;--> statement-breakpoint
CREATE TABLE __vehicle_snapshot_0025_backup AS SELECT * FROM policy_vehicle_snapshots;--> statement-breakpoint
DROP TABLE policy_vehicle_snapshots;--> statement-breakpoint
CREATE TABLE `__new_customer_vehicles` (
	`id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`details_json` text NOT NULL,
	`normalized_plate` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`customer_id`) REFERENCES `customers`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "customer_vehicles_details_valid" CHECK(json_valid("__new_customer_vehicles"."details_json") AND json_type("__new_customer_vehicles"."details_json")='object' AND (json_type("__new_customer_vehicles"."details_json",'$.plate')='null' OR (json_type("__new_customer_vehicles"."details_json",'$.plate')='text' AND length(trim(json_extract("__new_customer_vehicles"."details_json",'$.plate'))) BETWEEN 2 AND 30))),
	CONSTRAINT "customer_vehicles_plate_nonempty" CHECK(length("__new_customer_vehicles"."normalized_plate") BETWEEN 2 AND 30),
	CONSTRAINT "customer_vehicles_status_valid" CHECK("__new_customer_vehicles"."status" IN ('ACTIVE','INACTIVE')),
	CONSTRAINT "customer_vehicles_version_positive" CHECK("__new_customer_vehicles"."version">=1),
	CONSTRAINT "customer_vehicles_timestamps_ordered" CHECK("__new_customer_vehicles"."updated_at">="__new_customer_vehicles"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_customer_vehicles`("id", "agency_id", "customer_id", "details_json", "normalized_plate", "status", "version", "created_at", "updated_at") SELECT "id", "agency_id", "customer_id", "details_json", "normalized_plate", "status", "version", "created_at", "updated_at" FROM `customer_vehicles`;--> statement-breakpoint
DROP TABLE `customer_vehicles`;--> statement-breakpoint
ALTER TABLE `__new_customer_vehicles` RENAME TO `customer_vehicles`;--> statement-breakpoint
CREATE UNIQUE INDEX `customer_vehicles_agency_customer_id_uq` ON `customer_vehicles` (`agency_id`,`customer_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customer_vehicles_customer_plate_uq` ON `customer_vehicles` (`agency_id`,`customer_id`,`normalized_plate`);--> statement-breakpoint
CREATE INDEX `customer_vehicles_customer_page_idx` ON `customer_vehicles` (`agency_id`,`customer_id`,`id`);
--> statement-breakpoint
CREATE TABLE `policy_vehicle_snapshots` (
	`policy_id` text PRIMARY KEY NOT NULL,
	`agency_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`vehicle_version` integer NOT NULL,
	`details_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agency_id`,`policy_id`) REFERENCES `policies`(`agency_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`agency_id`,`customer_id`,`vehicle_id`) REFERENCES `customer_vehicles`(`agency_id`,`customer_id`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "policy_vehicle_snapshots_details_valid" CHECK(json_valid("policy_vehicle_snapshots"."details_json") AND json_type("policy_vehicle_snapshots"."details_json")='object'),
	CONSTRAINT "policy_vehicle_snapshots_version_positive" CHECK("policy_vehicle_snapshots"."vehicle_version">=1),
	CONSTRAINT "policy_vehicle_snapshots_timestamps_ordered" CHECK("policy_vehicle_snapshots"."updated_at">="policy_vehicle_snapshots"."created_at")
);
--> statement-breakpoint
CREATE INDEX `policy_vehicle_snapshots_vehicle_idx` ON `policy_vehicle_snapshots` (`agency_id`,`customer_id`,`vehicle_id`);
--> statement-breakpoint
INSERT INTO policy_vehicle_snapshots SELECT * FROM __vehicle_snapshot_0025_backup;--> statement-breakpoint
DROP TABLE __vehicle_snapshot_0025_backup;--> statement-breakpoint
CREATE TRIGGER customer_vehicles_parent_immutable BEFORE UPDATE ON customer_vehicles
WHEN NEW.id<>OLD.id OR NEW.agency_id<>OLD.agency_id OR NEW.customer_id<>OLD.customer_id
BEGIN SELECT RAISE(ABORT,'VEHICLE_PARENT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER policy_vehicle_snapshot_insert_guard BEFORE INSERT ON policy_vehicle_snapshots
WHEN NOT EXISTS(SELECT 1 FROM policies p JOIN customer_vehicles v ON v.agency_id=p.agency_id AND v.customer_id=p.customer_id
 WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.customer_id=NEW.customer_id
 AND v.id=NEW.vehicle_id AND v.version=NEW.vehicle_version AND v.details_json=NEW.details_json)
BEGIN SELECT RAISE(ABORT,'POLICY_VEHICLE_RELATION_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER policy_vehicle_snapshot_update_guard BEFORE UPDATE ON policy_vehicle_snapshots
WHEN NOT EXISTS(SELECT 1 FROM policies p JOIN customer_vehicles v ON v.agency_id=p.agency_id AND v.customer_id=p.customer_id
 WHERE p.agency_id=NEW.agency_id AND p.id=NEW.policy_id AND p.customer_id=NEW.customer_id
 AND v.id=NEW.vehicle_id AND v.version=NEW.vehicle_version AND v.details_json=NEW.details_json)
BEGIN SELECT RAISE(ABORT,'POLICY_VEHICLE_RELATION_INVALID'); END;
