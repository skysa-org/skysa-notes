import type { AccessToken } from '../../src/api/client.js';
import type { CredentialRecord } from '../../src/store/credentials.js';
import type { ClientDevice } from './device.js';

/**
 * A device whose ports are maps: the kit's own, for running the client's
 * suites with no app's database (`device.ts`).
 */
export const memoryDevice = (): ClientDevice => {
	const held = new Map<string, CredentialRecord>();
	const connections = new Map<string, 'live' | 'detached'>();
	const kept = new Map<string, AccessToken>();

	return {
		credentials: {
			credentials: {
				get: (id) => Promise.resolve(held.get(id)),
				put: (record) => {
					held.set(record.id, record);
					return Promise.resolve();
				},
				delete: (id) => {
					held.delete(id);
					return Promise.resolve();
				},
			},
		},
		tokens: {
			read: (connectionId) =>
				Promise.resolve({
					detached: connections.get(connectionId) === 'detached',
					token: kept.get(connectionId),
				}),
			// Onto a synced connection only, as the port says: one let go while
			// its token was on the way must not get a key to the account back.
			keep: (connectionId, token) => {
				if (connections.get(connectionId) !== 'live') return Promise.resolve();
				if (token === undefined) kept.delete(connectionId);
				else kept.set(connectionId, token);
				return Promise.resolve();
			},
		},
		bind: (connectionId, credential = `sk1_${connectionId}`) => {
			connections.set(connectionId, 'live');
			held.set(connectionId, {
				id: connectionId,
				credential,
				provider: 'dropbox',
				createdAt: 0,
			});
			return Promise.resolve();
		},
		keptToken: (connectionId) => Promise.resolve(kept.get(connectionId)),
		keepElsewhere: (connectionId, token) => {
			kept.set(connectionId, token);
			return Promise.resolve();
		},
		letGo: (connectionId, { unsent = false } = {}) => {
			held.delete(connectionId);
			kept.delete(connectionId);
			if (unsent) connections.set(connectionId, 'detached');
			else connections.delete(connectionId);
			return Promise.resolve();
		},
		connection: (connectionId) => Promise.resolve(connections.get(connectionId)),
		dropCredential: (connectionId) => {
			held.delete(connectionId);
			return Promise.resolve();
		},
	};
};
