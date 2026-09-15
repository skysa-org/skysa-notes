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

		expect(results.map((row) => row.name)).toEqual(
			expect.arrayContaining(['connections', 'identities', 'sessions', 'users'])
		);
	});

	it('enforces the unique index the reconnect upsert depends on', async () => {
		const db = createD1();
		await db
			.prepare(
				'INSERT INTO users (id, email, email_verified, created_at) VALUES (?, ?, 0, 0)'
			)
			.bind('u', 'u@example.com')
			.run();

		const insert = (id: string) =>
			db
				.prepare(
					'INSERT INTO connections (id, user_id, provider, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
				)
				.bind(id, 'u', 'dropbox', 'x', 'c', 'i', 'k1')
				.run();

		await insert('a');
		// Without this the upsert in the connect callback would be a no-op and
		// two tabs could each leave a connection behind.
		await expect(insert('b')).rejects.toThrow();
	});

	it('enforces foreign keys, which SQLite does not do by default', async () => {
		const db = createD1();
		await expect(
			db
				.prepare(
					'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
				)
				.bind('s', 'no-such-user', 1, 1)
				.run()
		).rejects.toThrow();
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
				'INSERT INTO connections (id, user_id, provider, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
			)
			.bind('connection-1', 'user-1', 'dropbox', 'x', 'c', 'i', 'k1')
			.run();

		// Node 22 has no `StatementSync.columns()`, so duplicate column names in a
		// join would silently collapse and shift every later column left. Whether
		// this throws or answers depends on the Node version; what must never
		// happen is a quiet wrong answer.
		const attempt = db
			.prepare('SELECT u.id, c.id FROM users u JOIN connections c ON c.user_id = u.id')
			.bind()
			.raw();

		const outcome = await attempt.then(
			(rows) => ({ ok: true as const, rows }),
			(error: unknown) => ({ ok: false as const, error })
		);

		// Two columns both named `id`. Against empty tables this test would pass
		// whether or not they collapsed, which is why there is a row in them.
		if (outcome.ok) expect(outcome.rows).toEqual([['user-1', 'connection-1']]);
		else expect(String(outcome.error)).toContain('duplicate column names would collapse');
	});
});
