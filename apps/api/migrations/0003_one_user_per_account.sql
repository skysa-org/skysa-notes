DROP INDEX `connections_provider_account_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_provider_account_idx` ON `connections` (`provider`,`account_id`);