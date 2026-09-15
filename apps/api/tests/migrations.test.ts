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

const apply = (db: DatabaseSync, name: string): void => {
	for (const statement of readFileSync(join(DIR, name), 'utf8').split(
		'--> statement-breakpoint'
	)) {
		const trimmed = statement.trim();
		if (trimmed !== '') db.exec(trimmed);
	}
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
