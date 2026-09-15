DROP INDEX IF EXISTS `connections_provider_account_idx`;--> statement-breakpoint
DELETE FROM `connections` WHERE `account_id` IS NOT NULL AND `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `connections` WHERE `account_id` IS NOT NULL GROUP BY `provider`, `account_id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `connections_provider_account_idx` ON `connections` (`provider`,`account_id`);
