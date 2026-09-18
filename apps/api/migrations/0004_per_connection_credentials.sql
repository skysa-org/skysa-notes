-- Per-connection credentials (docs/PLAN.md §6).
--
-- Hand-written, not `drizzle-kit generate`d. Dropping `connections.user_id`
-- needs a SQLite table rebuild — the column is named in a foreign key, and
-- neither `DROP COLUMN` nor a `NOT NULL` relaxation is allowed for such a
-- column — and drizzle writes that rebuild with `PRAGMA foreign_keys=OFF`,
-- which D1 rejects outright while the node:sqlite test shim tolerates it: green
-- in tests, wedged on `wrangler d1 migrations apply`.
--
-- A rebuild written by hand can drop the pragma, but not the
-- `DROP TABLE` + `ALTER TABLE ... RENAME` pair in the middle. Any re-run after
-- a failure *between* those two statements finds its source table gone, and a
-- re-run after the last one drops the live table. So the new shape gets a new
-- name instead, and nothing here destroys the table it reads from: every
-- statement is individually idempotent and the file converges from any partial
-- state. `connections` itself goes in 0005, which is a single statement and has
-- no partial state to recover from.
--
-- Rows with no `account_id` are left behind deliberately: the account id is the
-- new identity, and a row without one cannot be addressed. Only rows written
-- before 0002 can be in that state, and no code has created one since.
--
-- Every device reconnects after this. A grant is created by the OAuth callback
-- and there is no earlier credential to derive one from; sessions carried that
-- right before, and sessions are gone.
CREATE TABLE IF NOT EXISTS `storage_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`root_id` text,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_key_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
INSERT OR IGNORE INTO `storage_connections` (
	`id`, `provider`, `account_id`, `display_name`, `root_id`,
	`secret_ciphertext`, `secret_iv`, `secret_key_id`, `created_at`, `last_used_at`
)
SELECT
	`id`, `provider`, `account_id`, `display_name`, `root_id`,
	`secret_ciphertext`, `secret_iv`, `secret_key_id`, `created_at`, `last_used_at`
FROM `connections`
WHERE `account_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `storage_connections_provider_account_idx` ON `storage_connections` (`provider`,`account_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `storage_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `grants_secret_hash_idx` ON `grants` (`secret_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `grants_connection_id_idx` ON `grants` (`connection_id`);
--> statement-breakpoint
DROP TABLE IF EXISTS `sessions`;
