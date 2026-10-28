import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { GRANT_IDLE_DAYS } from '../src/credentials.js';
import { createDb, schema } from '../src/db/client.js';
import { revokeGrant } from '../src/db/connections.js';
import { buildApp } from './harness.js';

/**
 * `revokeGrant` on its own, where the routes' tests reach it only through
 * `DELETE /api/connection/grants/:id`: the idle boundary, which wants a fixed
 * `now`, and the one transaction, which wants a database that fails half way.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A connection with `devices` grants on it, as the callback leaves them. */
const connected = async (devices: number) => {
	const app = buildApp();
	await Array.from({ length: devices }).reduce<Promise<unknown>>(
		(previous) => previous.then(() => app.connect()),
		Promise.resolve()
	);
	const db = createDb(app.db);
	const grants = await db.select().from(schema.grants);
	const [connection] = await db.select().from(schema.connections);
	if (connection === undefined) throw new Error('no connection row');
	const [mine, ...others] = grants.map((grant) => ({
		id: grant.id,
		connectionId: connection.id,
	}));
	if (mine === undefined) throw new Error('no grant row');
	return { app, db, mine, others };
};

const connectionCount = async (db: ReturnType<typeof createDb>) =>
	(await db.select().from(schema.connections)).length;

describe('revokeGrant', () => {
	it('takes the connection with the last live grant, and keeps the grant as a tombstone', async () => {
		const { db, mine } = await connected(1);

		expect(await revokeGrant(db, mine, Date.now())).toBe(true);

		expect(await connectionCount(db)).toBe(0);
		const [row] = await db.select().from(schema.grants).where(eq(schema.grants.id, mine.id));
		expect(row?.connectionId).toBeNull();
	});

	it('leaves the connection while another device still reaches it', async () => {
		const { db, mine } = await connected(2);

		expect(await revokeGrant(db, mine, Date.now())).toBe(false);
		expect(await connectionCount(db)).toBe(1);
	});

	it.each([
		['is idle at the cutoff', 0, true],
		['is live a millisecond after it', 1, false],
	])('counts another grant that %s', async (_name, afterCutoff, gone) => {
		const { db, mine, others } = await connected(2);
		const [other] = others;
		if (other === undefined) throw new Error('no second grant');

		const now = Date.now();
		await db
			.update(schema.grants)
			.set({ lastUsedAt: new Date(now - GRANT_IDLE_DAYS * DAY_MS + afterCutoff) })
			.where(eq(schema.grants.id, other.id));

		expect(await revokeGrant(db, mine, now)).toBe(gone);
		expect(await connectionCount(db)).toBe(gone ? 0 : 1);
	});

	it('leaves a grant alone that is on a connection other than the one it is named with', async () => {
		const { db, mine } = await connected(1);

		expect(await revokeGrant(db, { ...mine, connectionId: 'elsewhere' }, Date.now())).toBe(
			false
		);

		const [row] = await db.select().from(schema.grants).where(eq(schema.grants.id, mine.id));
		expect(row?.connectionId).toBe(mine.connectionId);
		expect(await connectionCount(db)).toBe(1);
	});

	it('nulls nothing when the delete fails: one transaction, not two statements', async () => {
		const { app, mine } = await connected(1);
		// The database as it is, except that deleting a connection fails when it
		// runs — after the grant's update has — which is a request cut off
		// between the two writes, as near as a test gets.
		const cut = { count: 0 };
		const failed = (): Promise<never> => {
			cut.count += 1;
			return Promise.reject(new Error('cut off'));
		};
		const failing = (stmt: D1PreparedStatement): D1PreparedStatement =>
			({
				bind: (...args: unknown[]) => failing(stmt.bind(...args)),
				all: failed,
				raw: failed,
				first: failed,
				run: failed,
				batched: failed,
			}) as unknown as D1PreparedStatement;
		const cutOff = new Proxy(app.db, {
			get: (target, property, receiver: unknown) => {
				if (property !== 'prepare')
					return Reflect.get(target, property, receiver) as unknown;
				return (sql: string) => {
					const stmt = target.prepare(sql);
					return /^\s*delete\s+from\s+"?storage_connections/i.test(sql)
						? failing(stmt)
						: stmt;
				};
			},
		});

		await expect(revokeGrant(createDb(cutOff), mine, Date.now())).rejects.toThrow();
		expect(cut.count).toBe(1);

		const db = createDb(app.db);
		const [row] = await db.select().from(schema.grants).where(eq(schema.grants.id, mine.id));
		expect(row?.connectionId).toBe(mine.connectionId);
		expect(await connectionCount(db)).toBe(1);
	});
});
