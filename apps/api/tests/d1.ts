import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Enough of the D1 API to run the real `drizzle-orm/d1` driver against Node's
 * built-in SQLite.
 *
 * `@cloudflare/vitest-pool-workers` — which would give us Miniflare's actual D1
 * — still peers on `vitest ^4.1.0` and this workspace is on 5, so it cannot be
 * installed. The alternative was to mock the database out from under the
 * routes, which would test the mock. This keeps the driver, the SQL, the
 * migrations and the schema all real; only the process hosting SQLite differs.
 * No new dependency: `node:sqlite` ships with Node 22.
 *
 * Swap this for the pool as soon as it supports Vitest 5 (docs/PLAN.md §6).
 */

type Param = null | number | bigint | string | Uint8Array;

/** SQLite has no boolean; D1 accepts one and coerces. */
const toParam = (value: unknown): Param => {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (value instanceof Uint8Array) return value;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
		return value;
	}
	throw new TypeError(`D1 cannot bind a ${typeof value}`);
};

const meta = (changes: number, lastRowId: number | bigint) => ({
	duration: 0,
	changes,
	last_row_id: Number(lastRowId),
	changed_db: changes > 0,
	size_after: 0,
	rows_read: 0,
	rows_written: changes,
});

const statement = (db: DatabaseSync, sql: string, params: readonly Param[]) => {
	const self = {
		bind: (...next: unknown[]) => statement(db, sql, next.map(toParam)),

		all: () => {
			const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
			return Promise.resolve({ success: true, results: rows, meta: meta(0, 0) });
		},

		// Column order is insertion order on the row objects node:sqlite returns,
		// which is the order SQLite reports the columns in.
		raw: () => {
			const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
			return Promise.resolve(rows.map((row) => Object.values(row)));
		},

		first: async (column?: string) => {
			const { results } = await self.all();
			const row = results[0];
			if (row === undefined) return null;
			return column === undefined ? row : (row[column] ?? null);
		},

		run: () => {
			const result = db.prepare(sql).run(...params);
			return Promise.resolve({
				success: true,
				results: [],
				meta: meta(Number(result.changes), result.lastInsertRowid),
			});
		},
	};
	return self;
};

export type FakeD1 = ReturnType<typeof createD1>;

export const createD1 = (): D1Database & { close: () => void } => {
	const db = new DatabaseSync(':memory:');
	// D1 enforces foreign keys; the default SQLite does not, and a test that
	// passes only because a constraint was off is worse than no test.
	db.exec('PRAGMA foreign_keys = ON');

	applyMigrations(db);

	const client = {
		prepare: (sql: string) => statement(db, sql, []),

		// D1's batch is one implicit transaction. `begin`/`commit` here means a
		// failure half way leaves nothing behind, as it would in production.
		batch: async (statements: readonly { run: () => Promise<unknown> }[]) => {
			db.exec('BEGIN');
			try {
				const results = [];
				for (const stmt of statements) results.push(await stmt.run());
				db.exec('COMMIT');
				return results;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},

		exec: (sql: string) => {
			db.exec(sql);
			return Promise.resolve({ count: 0, duration: 0 });
		},

		dump: () => Promise.reject(new Error('not implemented')),
		withSession: () => {
			throw new Error('not implemented');
		},

		close: () => {
			db.close();
		},
	};

	return client as unknown as D1Database & { close: () => void };
};

const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname;

/**
 * The same files `wrangler d1 migrations apply` runs, in the same order, so a
 * migration that does not apply cleanly from empty fails the suite rather than
 * the deployment.
 */
const applyMigrations = (db: DatabaseSync): void => {
	const files = readdirSync(MIGRATIONS)
		.filter((name) => name.endsWith('.sql'))
		.sort();

	for (const name of files) {
		const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
		// Drizzle writes one statement per breakpoint, and `exec` takes one.
		sql.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter((statement) => statement !== '')
			.forEach((statement) => {
				db.exec(statement);
			});
	}
};
