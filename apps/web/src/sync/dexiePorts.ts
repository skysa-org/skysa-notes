import type { ClientStore, TokenStates } from '@skysa/client';
import { outOfAttempts } from '@skysa/sync';
import { liveQuery } from 'dexie';

import { bindingCount, finishImport, verifyResume } from '../store/connection.js';
import { activeConnectionId, type NotesDatabase } from '../store/db.js';
import { updateLive } from '../store/detached.js';
import { heldUpOf } from '../store/heldUp.js';
import { MAX_OP_ATTEMPTS } from '../store/queue.js';
import { rowsOf } from '../store/rows.js';
import { isLiveSource } from '../store/rowStates.js';
import { createDexieSyncStore, toSyncOp } from './store.js';

/**
 * The sync client's ports, over this app's database. The client is the shared
 * kit's (`@skysa/client`) and reaches IndexedDB only through ports
 * (docs/decisions/0018-the-shared-kit.md); the tables they are made over, and
 * these, are the app's. The scheduler is handed `clientStoreOf`, which
 * carries the rest. The credentials need no adapter: the database fits
 * `CredentialStore` as it is.
 */

/**
 * A connection's token, kept on its `syncState` row so a reload need not ask
 * the server again. Written only onto a live row (`updateLive`): a connection
 * let go while its token was on the way has no row and must not get one back,
 * or has a detached one, which must not hold a key to the account
 * (`store/detached.ts`).
 */
const tokenStatesOf = (db: NotesDatabase): TokenStates => ({
	read: async (connectionId) => {
		const state = await db.syncState.get(connectionId);
		const token =
			state?.accessToken === undefined || state.accessTokenExpiresAt === undefined
				? undefined
				: { accessToken: state.accessToken, expiresAt: state.accessTokenExpiresAt };
		return { detached: state?.detached !== undefined, token };
	},
	keep: (connectionId, token) =>
		updateLive(
			db,
			connectionId,
			({ accessToken: _token, accessTokenExpiresAt: _expiry, ...rest }) =>
				token === undefined
					? rest
					: {
							...rest,
							accessToken: token.accessToken,
							accessTokenExpiresAt: token.expiresAt,
						}
		),
});

/** Every op of the connection gets its attempts back. Inside a transaction. */
const resetAttempts = async (db: NotesDatabase, connectionId: string): Promise<void> => {
	const tried = await rowsOf(db.opQueue, connectionId)
		.filter((op) => op.attempts > 0)
		.toArray();
	await db.opQueue.bulkPut(tried.map((op) => ({ ...op, attempts: 0 })));
};

/** Follow a live query until told to stop. */
const watching = <T>(query: () => Promise<T>, next: (value: T) => void): (() => void) => {
	const subscription = liveQuery(query).subscribe({ next });
	return () => {
		subscription.unsubscribe();
	};
};

/**
 * The scheduler's side of the device (`ClientStore`), over the tables the app
 * owns: the source shown, its `syncState` row, its queue and its store.
 */
export const clientStoreOf = (db: NotesDatabase): ClientStore => ({
	// The source the app is showing, not whichever row comes back first:
	// `activeConnectionId` reads `prefs` as well, so switching sources is seen.
	watchShown: (next) =>
		watching(
			async () => db.syncState.get(await activeConnectionId(db)),
			(state) => {
				next(
					state === undefined
						? undefined
						: {
								connectionId: state.connectionId,
								provider: state.provider,
								clientId: state.clientId,
								lastSyncAt: state.lastSyncAt,
								detached: state.detached !== undefined,
							}
				);
			}
		),
	bindings: () => bindingCount(db),
	verifyResume: async (connectionId, provider) => ({
		superseded: (await verifyResume(db, connectionId, provider)) === 'superseded',
	}),
	needsRoot: async (connectionId) => {
		const state = await db.syncState.get(connectionId);
		return state !== undefined && state.rootId === undefined;
	},
	keepRoot: (connectionId, rootId) =>
		updateLive(db, connectionId, (live) => ({ ...live, rootId })),
	pulled: (connectionId, at) =>
		updateLive(db, connectionId, (live) => ({ ...live, lastSyncAt: at })),
	finishImport: (connectionId) => finishImport(db, connectionId),
	rescan: (connectionId) =>
		db.transaction('rw', db.syncState, db.opQueue, async () => {
			const state = await db.syncState.get(connectionId);
			// Let go of meanwhile: there is nothing to re-scan, and a `put` would
			// bring the row back. Detached is let go as well.
			if (state === undefined || !isLiveSource(state)) return;
			// `rootId` is kept: it is the same folder, and finding it again costs
			// a search whose answer is already here.
			const { cursor: _cursor, ...kept } = state;
			await db.syncState.put(kept);
			await resetAttempts(db, connectionId);
		}),
	releaseOps: (connectionId) =>
		// One transaction, so an op the engine completes meanwhile is not put back.
		db.transaction('rw', db.opQueue, () => resetAttempts(db, connectionId)),
	failingOps: async (connectionId, maxAttempts) => {
		const failing = await rowsOf(db.opQueue, connectionId)
			.filter((op) => outOfAttempts(op, maxAttempts))
			.toArray();
		return failing.map((row) => ({ op: toSyncOp(row), lastError: row.lastError }));
	},
	watchQueue: (connectionId, next) =>
		watching(() => rowsOf(db.opQueue, connectionId).primaryKeys(), next),
	queuedAfter: (connectionId, seq) =>
		rowsOf(db.opQueue, connectionId)
			.filter((op) => (op.seq ?? 0) > seq)
			.toArray(),
	syncStore: (connectionId) => createDexieSyncStore(db, { connectionId }),
	credentials: db,
	tokens: tokenStatesOf(db),
	heldUp: () => heldUpOf(db),
	maxAttempts: MAX_OP_ATTEMPTS,
});
