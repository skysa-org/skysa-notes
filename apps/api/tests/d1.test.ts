import { describe, expect, it } from 'vitest';

import { createD1 } from './d1.js';

/**
 * The shim is not the thing under test anywhere else, which is exactly why it
 * needs tests of its own: a harness that is more forgiving than production
 * validates the harness, not the code.
 */

describe('the node:sqlite D1 shim', () => {
	it('applies the real migration files, in order, from empty', async () => {
		const db = createD1();
		const { results } = await db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all<{ name: string }>();

		const names = results.map((row) => row.name);
		expect(names).toEqual(
			expect.arrayContaining(['grants', 'identities', 'storage_connections', 'users'])
		);
		// 0004 and 0005 take these away. A migration that left either behind would
		// leave a table nothing reads holding live refresh tokens.
		expect(names).not.toContain('sessions');
		expect(names).not.toContain('connections');
	});

	it('enforces one connection per provider account', async () => {
		const db = createD1();
		const connect = (id: string, accountId: string) =>
			db
				.prepare(
					'INSERT INTO storage_connections (id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
				)
				.bind(id, 'dropbox', accountId, 'x', 'c', 'i', 'k1')
				.run();

		await connect('ca', 'dbid:shared');

		// The upsert target. Without the constraint two racing callbacks would
		// each leave a row behind, and a device's credential would reach whichever
		// one the query planner happened to return.
		await expect(connect('cb', 'dbid:shared')).rejects.toThrow();
	});

	it('enforces one grant per credential hash', async () => {
		const db = createD1();
		await db
			.prepare(
				'INSERT INTO storage_connections (id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
			)
			.bind('c', 'dropbox', 'dbid:1', 'x', 'c', 'i', 'k1')
			.run();

		const grant = (id: string) =>
			db
				.prepare(
					'INSERT INTO grants (id, connection_id, secret_hash, created_at, last_used_at) VALUES (?, ?, ?, 0, 0)'
				)
				.bind(id, 'c', 'the-hash')
				.run();

		await grant('g1');
		// The hash is the lookup key, so a second row under it is a credential
		// that reaches two connections depending on row order.
		await expect(grant('g2')).rejects.toThrow();
	});

	it('enforces foreign keys, which SQLite does not do by default', async () => {
		const db = createD1();
		await expect(
			db
				.prepare(
					'INSERT INTO grants (id, connection_id, secret_hash, created_at, last_used_at) VALUES (?, ?, ?, 0, 0)'
				)
				.bind('g', 'no-such-connection', 'h')
				.run()
		).rejects.toThrow();
	});

	it('cascades a deleted connection onto its grants', async () => {
		const db = createD1();
		await db
			.prepare(
				'INSERT INTO storage_connections (id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
			)
			.bind('c', 'dropbox', 'dbid:1', 'x', 'c', 'i', 'k1')
			.run();
		await db
			.prepare(
				'INSERT INTO grants (id, connection_id, secret_hash, created_at, last_used_at) VALUES (?, ?, ?, 0, 0)'
			)
			.bind('g', 'c', 'h')
			.run();

		await db.prepare('DELETE FROM storage_connections WHERE id = ?').bind('c').run();

		// Disconnecting is the button for a credential the user believes is
		// stolen; a grant that outlived its connection would be one that still
		// points at whatever takes that id next.
		const { results } = await db.prepare('SELECT id FROM grants').all();
		expect(results).toHaveLength(0);
	});

	it('refuses to answer a join rather than answering it wrongly', async () => {
		const db = createD1();
		await db
			.prepare(
				'INSERT INTO users (id, email, email_verified, created_at) VALUES (?, ?, 0, 0)'
			)
			.bind('user-1', 'u@example.com')
			.run();
		await db
			.prepare(
				'INSERT INTO identities (id, user_id, provider, subject, email, email_verified, created_at) VALUES (?, ?, ?, ?, ?, 0, 0)'
			)
			.bind('identity-1', 'user-1', 'google', 's', 'u@example.com')
			.run();

		// Node 22 has no `StatementSync.columns()`, so duplicate column names in a
		// join would silently collapse and shift every later column left. Whether
		// this throws or answers depends on the Node version; what must never
		// happen is a quiet wrong answer.
		const attempt = db
			.prepare('SELECT u.id, i.id FROM users u JOIN identities i ON i.user_id = u.id')
			.bind()
			.raw();

		const outcome = await attempt.then(
			(rows) => ({ ok: true as const, rows }),
			(error: unknown) => ({ ok: false as const, error })
		);

		// Two columns both named `id`. Against empty tables this test would pass
		// whether or not they collapsed, which is why there is a row in them.
		if (outcome.ok) expect(outcome.rows).toEqual([['user-1', 'identity-1']]);
		else expect(String(outcome.error)).toContain('duplicate column names');
	});
});
