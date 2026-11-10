import { bindConnection, detachConnection, showConnection } from '../../src/store/connection.js';
import { createNote } from '../../src/store/notes.js';
import { clientStoreOf } from '../../src/sync/dexiePorts.js';
import type { ClientDevice } from '../client/device.js';
import { holdCredential } from './connection.js';
import { freshDatabase } from './db.js';

/**
 * A device over this app's database, fresh for each call: the client's
 * suites (`tests/client/device.ts`) run over it as the app runs them, through
 * the ports in `sync/dexiePorts.ts`. An op is queued as a row of the queue,
 * the shape every writer in `store/` leaves.
 */
export const dexieDevice = (): ClientDevice => {
	const db = freshDatabase();
	return {
		store: clientStoreOf(db),
		bind: async (connectionId, credential) => {
			await bindConnection(db, { connectionId, provider: 'dropbox' });
			await holdCredential(db, connectionId, credential === undefined ? {} : { credential });
		},
		show: async (connectionId) => {
			await showConnection(db, connectionId);
		},
		queue: (connectionId, op, { lazy = false } = {}) =>
			db.opQueue.add({
				...op,
				connectionId,
				attempts: 0,
				queuedAt: 0,
				...(lazy ? { lazy: true as const } : {}),
			}),
		keptToken: async (connectionId) => {
			const state = await db.syncState.get(connectionId);
			return state?.accessToken === undefined || state.accessTokenExpiresAt === undefined
				? undefined
				: { accessToken: state.accessToken, expiresAt: state.accessTokenExpiresAt };
		},
		keepElsewhere: async (connectionId, token) => {
			await db.syncState.update(connectionId, {
				accessToken: token.accessToken,
				accessTokenExpiresAt: token.expiresAt,
			});
		},
		letGo: async (connectionId, { unsent = false } = {}) => {
			// What keeps a source detached rather than forgotten is a note it never sent.
			if (unsent) await createNote(db, { connectionId, title: 'Unsent' });
			await detachConnection(db, { connectionId });
		},
		connection: async (connectionId) => {
			const state = await db.syncState.get(connectionId);
			if (state === undefined) return undefined;
			return state.detached === undefined ? 'live' : 'detached';
		},
		dropCredential: async (connectionId) => {
			await db.credentials.delete(connectionId);
		},
	};
};
