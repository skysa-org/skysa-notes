import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * D1 holds tokens and connection metadata only. No note content is ever stored
 * here — see docs/PLAN.md §6.
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

/**
 * `account-first` mode only: one row per external sign-in attached to a user.
 * `storage-first` instances leave this table empty.
 */
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

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => [index('sessions_user_id_idx').on(t.userId)]
);

export const connections = sqliteTable(
	'connections',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		provider: text('provider', { enum: ['gdrive', 'onedrive', 'dropbox', 'webdav'] }).notNull(),
		/**
		 * The provider's own id for the account this connection points at. In
		 * `storage-first` it is what lets a returning user be recognised as the
		 * same user instead of a new one, and it is how a reconnect tells "the
		 * same account again" from "a different account in the same slot".
		 */
		accountId: text('account_id'),
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
		index('connections_user_id_idx').on(t.userId),
		// One connection per provider per user until Phase 7 (docs/PLAN.md §12.3).
		// Enforced here rather than by convention so reconnecting is an atomic
		// upsert instead of a read-then-write race between two tabs.
		uniqueIndex('connections_user_provider_idx').on(t.userId, t.provider),
		// Not unique: two users of a shared instance may legitimately connect the
		// same Dropbox account. This index only has to make the lookup cheap.
		index('connections_provider_account_idx').on(t.provider, t.accountId),
	]
);

export type User = typeof users.$inferSelect;
export type Identity = typeof identities.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Connection = typeof connections.$inferSelect;
