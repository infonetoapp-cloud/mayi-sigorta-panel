ALTER TABLE `customers` ADD `birth_date` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `reference_membership_id` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `reference_name` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `reference_search_key` text;--> statement-breakpoint
CREATE INDEX `customers_agency_reference_idx` ON `customers` (`agency_id`,`reference_membership_id`);--> statement-breakpoint
CREATE INDEX `customers_agency_reference_search_idx` ON `customers` (`agency_id`,`reference_search_key`);