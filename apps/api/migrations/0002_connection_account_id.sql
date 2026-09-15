ALTER TABLE `connections` ADD `account_id` text;--> statement-breakpoint
CREATE INDEX `connections_provider_account_idx` ON `connections` (`provider`,`account_id`);