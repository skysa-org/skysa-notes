import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

/**
 * Migrations run once, in order, against whatever a deployment already holds —
 * and a migration that fails half way is worse than one that never ran, because
 * `wrangler d1 migrations apply` has no rollback and the next attempt starts
 * from the wreckage.
 */

const DIR = new URL('../migrations/', import.meta.url).pathname;

const files = (): string[] =>
	readdirSync(DIR)
		.filter((name) => name.endsWith('.sql'))
		.sort();

const statements = (name: string): string[] =>
	readFileSync(join(DIR, name), 'utf8')
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '');

/** `upTo` statements, or all of them. `wrangler` stops at the first failure. */
const apply = (db: DatabaseSync, name: string, upTo = Number.POSITIVE_INFINITY): void => {
	for (const statement of statements(name).slice(0, upTo)) db.exec(statement);
};

const open = (upTo: string): DatabaseSync => {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	for (const name of files()) {
		if (name > upTo) break;
		apply(db, name);
	}
	return db;
};

const addUser = (db: DatabaseSync, id: string): void => {
	db.prepare('INSERT INTO users (id, email, email_verified, created_at) VALUES (?, ?, 0, 0)').run(
		id,
		`${id}@example.com`
	);
};

const addConnection = (db: DatabaseSync, id: string, userId: string, accountId: string): void => {
	db.prepare(
		'INSERT INTO connections (id, user_id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
	).run(id, userId, 'dropbox', accountId, 'x', 'c', 'i', 'k1');
};

describe('0003_one_user_per_account', () => {
	it('applies to a database that already holds two users on one account', () => {
		// Reachable at 0002: account-first permitted it, and two signed-out
		// callbacks could race their way there in storage-first.
		const db = open('0002_connection_account_id.sql');
		addUser(db, 'first');
		addUser(db, 'second');
		addConnection(db, 'older', 'first', 'dbid:shared');
		addConnection(db, 'newer', 'second', 'dbid:shared');

		expect(() => {
			apply(db, '0003_one_user_per_account.sql');
		}).not.toThrow();

		// The older connection is the original claim, so it is the one that stays.
		const rows = db.prepare('SELECT id FROM connections').all() as { id: string }[];
		expect(rows.map((row) => row.id)).toEqual(['older']);
		// Only the connection goes: the user keeps their account and reconnects.
		expect(db.prepare('SELECT id FROM users').all()).toHaveLength(2);
	});

	it('can be run again after a failure, rather than wedging the deployment', () => {
		// The first draft dropped the old index before creating the new one, so a
		// failed CREATE left the table with neither, and every retry then died on
		// `no such index`.
		const db = open('0002_connection_account_id.sql');
		apply(db, '0003_one_user_per_account.sql');

		expect(() => {
			apply(db, '0003_one_user_per_account.sql');
		}).not.toThrow();
	});

	it('recovers a deployment the first draft of it wedged', () => {
		// That draft dropped the index, then failed on the CREATE, leaving the
		// table with neither index — and every retry died on `no such index`.
		// Anyone who ran it before this fix is in exactly this state.
		const db = open('0002_connection_account_id.sql');
		db.exec('DROP INDEX connections_provider_account_idx');

		expect(() => {
			apply(db, '0003_one_user_per_account.sql');
		}).not.toThrow();
	});

	it('leaves rows with no account id alone', () => {
		const db = open('0002_connection_account_id.sql');
		addUser(db, 'a');
		addUser(db, 'b');
		db.prepare(
			'INSERT INTO connections (id, user_id, provider, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
		).run('ca', 'a', 'webdav', 'x', 'c', 'i', 'k1');
		db.prepare(
			'INSERT INTO connections (id, user_id, provider, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
		).run('cb', 'b', 'webdav', 'x', 'c', 'i', 'k1');

		apply(db, '0003_one_user_per_account.sql');

		// NULLs do not conflict under a unique index, and a WebDAV connection has
		// no account id to conflict with.
		expect(db.prepare('SELECT id FROM connections').all()).toHaveLength(2);
	});

	it('applies cleanly from empty, in order', () => {
		expect(() => open('9999')).not.toThrow();
	});
});

describe('0004_per_connection_credentials', () => {
	/** A pre-0004 database with one connection per user, as 0003 leaves it. */
	const before = (): DatabaseSync => {
		const db = open('0003_one_user_per_account.sql');
		addUser(db, 'first');
		addUser(db, 'second');
		addConnection(db, 'c-one', 'first', 'dbid:one');
		addConnection(db, 'c-two', 'second', 'dbid:two');
		// A row from before 0002, when the account id was still optional. It
		// cannot be addressed in the new model, so it does not come across.
		db.prepare(
			'INSERT INTO connections (id, user_id, provider, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
		).run('c-old', 'first', 'webdav', 'x', 'c', 'i', 'k1');
		return db;
	};

	const connectionIds = (db: DatabaseSync): string[] =>
		(
			db.prepare('SELECT id FROM storage_connections ORDER BY id').all() as { id: string }[]
		).map((row) => row.id);

	const tables = (db: DatabaseSync): string[] =>
		(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as { name: string }[]
		).map((row) => row.name);

	it('carries every addressable connection across, and its secret with it', () => {
		const db = before();
		apply(db, '0004_per_connection_credentials.sql');

		expect(connectionIds(db)).toEqual(['c-one', 'c-two']);
		const [row] = db
			.prepare('SELECT * FROM storage_connections WHERE id = ?')
			.all('c-one') as Record<string, unknown>[];
		// The sealed columns move verbatim: re-encrypting is not this migration's
		// job, and a connection whose secret did not come across is an account
		// that has to be connected again for no reason.
		expect(row).toMatchObject({
			provider: 'dropbox',
			account_id: 'dbid:one',
			secret_ciphertext: 'c',
			secret_iv: 'i',
			secret_key_id: 'k1',
		});
	});

	it('takes sessions away and leaves the two unused tables standing', () => {
		const db = before();
		apply(db, '0004_per_connection_credentials.sql');
		apply(db, '0005_drop_user_connections.sql');

		const names = tables(db);
		expect(names).toContain('storage_connections');
		expect(names).toContain('grants');
		// A table nothing reads, holding live refresh tokens, is the worst of
		// both: `connections` goes in 0005 and `sessions` in 0004.
		expect(names).not.toContain('connections');
		expect(names).not.toContain('sessions');
		// `users` and `identities` are still here. They were kept for account-first,
		// which was dropped on 2026-09-18, so they are now owed a migration of
		// their own (issue #118) — but 0005 is a record of what it did, and
		// what it did was leave them.
		expect(names).toContain('users');
		expect(names).toContain('identities');
	});

	it('can be re-run from a failure at every one of its statements', () => {
		// `wrangler d1 migrations apply` records a migration only once it has
		// finished, so a failure anywhere means the whole file runs again from the
		// top. Every prefix has to converge on the same database.
		const count = statements('0004_per_connection_credentials.sql').length;
		expect(count).toBeGreaterThan(1);

		const complete = before();
		apply(complete, '0004_per_connection_credentials.sql');
		const expected = connectionIds(complete);

		for (const stopAfter of Array.from({ length: count + 1 }, (_value, index) => index)) {
			const db = before();
			apply(db, '0004_per_connection_credentials.sql', stopAfter);

			expect(
				() => {
					apply(db, '0004_per_connection_credentials.sql');
				},
				`re-run after ${String(stopAfter)} statement(s)`
			).not.toThrow();

			expect(connectionIds(db), `data after ${String(stopAfter)} statement(s)`).toEqual(
				expected
			);
			expect(tables(db)).not.toContain('sessions');
		}
	});

	it('is why 0005 is a file of its own', () => {
		// 0004 never drops the table it reads from. If it did, a re-run after the
		// drop would die on `no such table: connections` with the data only half
		// moved — which is exactly what a hand-written rebuild's drop-then-rename
		// does, and why this is a new table rather than a renamed one.
		const db = before();
		apply(db, '0004_per_connection_credentials.sql');
		apply(db, '0005_drop_user_connections.sql');

		// 0005 is one statement, so it has no partial state of its own, and it is
		// idempotent besides.
		expect(() => {
			apply(db, '0005_drop_user_connections.sql');
		}).not.toThrow();
		expect(connectionIds(db)).toEqual(['c-one', 'c-two']);
	});

	it('leaves a grant unreachable, but still there, once its connection goes', () => {
		const db = open('9999');
		db.prepare(
			'INSERT INTO storage_connections (id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
		).run('c', 'dropbox', 'dbid:1', 'x', 'c', 'i', 'k1');
		db.prepare(
			'INSERT INTO grants (id, connection_id, secret_hash, created_at, last_used_at) VALUES (?, ?, ?, 0, 0)'
		).run('g', 'c', 'h');

		db.prepare('DELETE FROM storage_connections WHERE id = ?').run('c');

		// The DDL the migration writes has to be `ON DELETE set null`: a cascade
		// would delete the row and free its hash for anyone holding a copy of the
		// credential to claim again.
		expect(db.prepare('SELECT id, connection_id FROM grants').all()).toEqual([
			{ id: 'g', connection_id: null },
		]);
	});
});
