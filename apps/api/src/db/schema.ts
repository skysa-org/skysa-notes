import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * D1 holds tokens and connection metadata only. No note content is ever stored
 * here — see docs/PLAN.md §6.
 */

/**
 * Two tables with no caller, waiting on a migration to remove them.
 *
 * There are no users here: a connection is reached by the credential the device
 * that made it holds, and nothing aggregates connections under a subject. These
 * two were kept for `account-first`, which was **dropped** on 2026-09-18 —
 * identity and storage are coupled deliberately (docs/PLAN.md §6, "No sign-in
 * separate from storage"). So they are now dead rather than early, and §10
 * tracks dropping them: a hand-written migration, `identities` before `users`
 * because of the foreign key.
 *
 * Nothing in `src/` reads either one. Do not start.
 */
export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull(),
		emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	},
	// Deliberately not unique: an unverified sign-in with an existing address must
	// create a separate user rather than merge into one. See docs/PLAN.md §6.
	(t) => [index('users_email_idx').on(t.email)]
);

/** No caller: one row per external sign-in attached to a user. See above. */
export const identities = sqliteTable(
	'identities',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		provider: text('provider', { enum: ['google', 'microsoft'] }).notNull(),
		subject: text('subject').notNull(),
		email: text('email').notNull(),
		emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [
		// An external identity belongs to exactly one user; linking it to a second
		// must fail rather than silently merge accounts.
		uniqueIndex('identities_provider_subject_idx').on(t.provider, t.subject),
		index('identities_user_id_idx').on(t.userId),
	]
);

/**
 * One connected storage account. Auth and data are coupled: a connection is its
 * own silo, and the device switches between them (docs/PLAN.md §6).
 *
 * The SQL name is `storage_connections`, not `connections`. The old table
 * carried a `NOT NULL` foreign key to `users`, and SQLite can neither drop a
 * column named in a foreign key nor relax `NOT NULL` without rebuilding the
 * table — a rebuild `drizzle-kit` writes with `PRAGMA foreign_keys=OFF`, which
 * D1 rejects. A rebuild done by hand can avoid the pragma but not the
 * drop-then-rename in the middle, which leaves a partial state no re-run of the
 * migration can recover from. A new table under a new name has neither problem:
 * see `migrations/0004_per_connection_credentials.sql`.
 */
export const connections = sqliteTable(
	'storage_connections',
	{
		id: text('id').primaryKey(),
		provider: text('provider', { enum: ['gdrive', 'onedrive', 'dropbox', 'webdav'] }).notNull(),
		/**
		 * The provider's own id for the account this connection points at, and the
		 * only identity a connection has. `NOT NULL`, because it is the upsert
		 * target: SQLite NULLs do not conflict, so a nullable one would insert a
		 * duplicate row on every reconnect instead of updating the existing one.
		 */
		accountId: text('account_id').notNull(),
		displayName: text('display_name').notNull(),
		/** Provider id of the app-owned root folder, once `ensureRoot()` has run. */
		rootId: text('root_id'),
		/**
		 * AES-256-GCM over `{ refresh_token }` (OAuth) or `{ url, username, password }`
		 * (WebDAV). Never logged, never returned to the client.
		 */
		secretCiphertext: text('secret_ciphertext').notNull(),
		secretIv: text('secret_iv').notNull(),
		/** Identifies which `SECRETS_KEY` encrypted this row, so keys can be rotated. */
		secretKeyId: text('secret_key_id').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
	},
	(t) => [
		// One row per account, so reconnecting is an atomic upsert rather than a
		// read-then-write race between two tabs. Two devices connecting the same
		// account share the row and hold a grant each.
		uniqueIndex('storage_connections_provider_account_idx').on(t.provider, t.accountId),
	]
);

/**
 * A device's right to act on one connection.
 *
 * The device generates 32 random bytes, keeps them, and sends only their
 * SHA-256 — so the plaintext credential never reaches the server at all, not
 * even in transit, and a copy of this table mints nothing. Lookup is by hash
 * through a unique index rather than id-then-compare, which would need a
 * constant-time comparison: `crypto.subtle.timingSafeEqual` is a Workers
 * extension that Node's webcrypto lacks, and the test suite runs on Node.
 *
 * See docs/PLAN.md §6, and CLAUDE.md on what holding a bearer in IndexedDB
 * costs.
 */
export const grants = sqliteTable(
	'grants',
	{
		id: text('id').primaryKey(),
		/**
		 * Which connection this device may act on, or null once it may not.
		 *
		 * Revoking a device nulls this rather than deleting the row, and the
		 * foreign key is `set null` rather than `cascade` so disconnecting the
		 * account does the same. The row that stays behind is a tombstone, and it
		 * is load-bearing: `secret_hash` is unique, so a hash that has ever been
		 * used can never be claimed again.
		 *
		 * Without that, a hash leaked from a database dump is not merely useless —
		 * it is a claim waiting for its grant row to go away. The user disconnects
		 * and reconnects (the first thing anyone tries when sync misbehaves); a
		 * device that was offline at the time still holds its plaintext
		 * credential; the attacker starts a flow with that device's hash, consents
		 * with storage of their own, and the device comes back, is answered 200,
		 * and syncs the user's notes into it. Nothing would ever tell it
		 * otherwise.
		 */
		connectionId: text('connection_id').references(() => connections.id, {
			onDelete: 'set null',
		}),
		/** base64url SHA-256 of the credential string. Never the credential. */
		secretHash: text('secret_hash').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		/**
		 * Touched at most once a day, so idle expiry has something to read. Set to
		 * `createdAt` on insert and never null: a NULL would fail the `>` the idle
		 * check is written as, and a grant nothing can find is a device that can
		 * never sync again.
		 */
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [
		// Unique, and over every row including the tombstones: it is what makes a
		// hash claimable exactly once, ever. A collision here would be a SHA-256
		// collision.
		uniqueIndex('grants_secret_hash_idx').on(t.secretHash),
		index('grants_connection_id_idx').on(t.connectionId),
	]
);

export type User = typeof users.$inferSelect;
export type Identity = typeof identities.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Grant = typeof grants.$inferSelect;
