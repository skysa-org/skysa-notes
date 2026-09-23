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
 * Swap this for the pool as soon as it supports Vitest 5 (docs/ARCHITECTURE.md §6).
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

/** The statement's real column names, on the Node versions that expose them. */
const describe = (db: DatabaseSync, sql: string): string[] | undefined => {
	const stmt = db.prepare(sql) as unknown as { columns?: () => { name: string }[] };
	if (typeof stmt.columns !== 'function') return undefined;
	return stmt.columns().map((column) => column.name);
};

/**
 * node:sqlite is synchronous and throws; D1 is asynchronous and rejects. A
 * caller written for the rejection would not survive the throw — the difference
 * is exactly the kind a cooperative harness hides.
 */
const settle = <T>(run: () => T): Promise<T> => {
	try {
		return Promise.resolve(run());
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
};

const statement = (db: DatabaseSync, sql: string, params: readonly Param[]) => {
	const self = {
		bind: (...next: unknown[]) => statement(db, sql, next.map(toParam)),

		all: () =>
			settle(() => {
				const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
				return { success: true, results: rows, meta: meta(0, 0) };
			}),

		/**
		 * Positional rows. drizzle routes every `select()` and `query.*` through
		 * here, so this is the hot path.
		 *
		 * node:sqlite returns rows as *objects*, and Node 22 has no
		 * `StatementSync.columns()` to recover the real column list — so two
		 * columns with the same name (`users.id` and `connections.id` in a join,
		 * or any `with:` relation) collapse into one key and every later column
		 * shifts left. Real D1 returns all of them.
		 *
		 * There is no way to detect that from the row alone, so the guard is on
		 * the query instead: a join is refused loudly rather than answered wrong.
		 * Node ≥ 23 has `columns()`, and the check disappears the moment it does.
		 */
		raw: () =>
			settle(() => {
				// Preparing the statement is itself a throw for bad SQL, so it has to
				// happen inside the settle: D1 rejects, it does not throw.
				const columns = describe(db, sql);

				// Duplicate names collapse in the row object whether or not this Node
				// can name the columns, so both branches refuse them: with `columns()`
				// the duplicate is visible, without it a join is the only proxy.
				const ambiguous =
					columns === undefined
						? /\bjoin\b/i.test(sql)
						: new Set(columns).size !== columns.length;
				if (ambiguous) {
					throw new Error(
						'the node:sqlite D1 shim cannot return positional rows for a query ' +
							'with duplicate column names: they would collapse. Switch to ' +
							'@cloudflare/vitest-pool-workers when it supports Vitest 5.'
					);
				}

				const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
				if (columns === undefined) return rows.map((row) => Object.values(row));
				return rows.map((row) => columns.map((column) => row[column]));
			}),

		first: async (column?: string) => {
			const { results } = await self.all();
			const row = results[0];
			if (row === undefined) return null;
			return column === undefined ? row : (row[column] ?? null);
		},

		run: () =>
			settle(() => {
				const result = db.prepare(sql).run(...params);
				return {
					success: true,
					results: [],
					meta: meta(Number(result.changes), result.lastInsertRowid),
				};
			}),
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

/**
 * The same database, able to answer one read the way a concurrent transaction
 * would: as though nothing had been written yet.
 *
 * `node:sqlite` is synchronous, so two requests issued together in a test still
 * run one after the other, and the second always sees what the first committed.
 * That is the ordering in which nothing goes wrong, which makes it the wrong
 * one to build confidence on — the connect callback's retry existed for a long
 * time without a single test that could tell whether it worked.
 *
 * Narrow on purpose: only `storage_connections`, only reads, and only when the
 * test says so.
 */
export const blindable = (real: D1Database & { close: () => void }) => {
	const pending = { count: 0, blinded: 0 };

	const blindStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
		({
			bind: (...args: unknown[]) => blindStatement(stmt.bind(...args)),
			all: () => Promise.resolve({ success: true, results: [], meta: {} }),
			raw: () => Promise.resolve([]),
			first: () => Promise.resolve(null),
			run: () => Promise.resolve({ success: true, results: [], meta: {} }),
		}) as unknown as D1PreparedStatement;

	const db = new Proxy(real, {
		get: (target, property, receiver: unknown) => {
			if (property !== 'prepare') return Reflect.get(target, property, receiver) as unknown;
			return (sql: string): D1PreparedStatement => {
				const stmt = target.prepare(sql);
				const reads = /^\s*select\b/i.test(sql) && /\bstorage_connections\b/i.test(sql);
				if (!reads || pending.count === 0) return stmt;
				pending.count -= 1;
				pending.blinded += 1;
				return blindStatement(stmt);
			};
		},
	});

	return {
		db,
		/** Answer the next read of `storage_connections` as empty. */
		once: () => {
			pending.count += 1;
		},
		/** How many reads were actually blinded — a test that blinded none is not testing anything. */
		get blinded() {
			return pending.blinded;
		},
	};
};
