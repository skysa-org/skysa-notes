import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient, type Connection, type Result } from '../src/api/client.js';
import { bindConnection } from '../src/store/connection.js';
import {
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
} from '../src/store/db.js';
import { createNote, getNote } from '../src/store/notes.js';
import { disconnectAccount, reconcileAccount } from '../src/sync/account.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`account-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const connection = (id: string, provider: Connection['provider'] = 'dropbox'): Connection => ({
	id,
	provider,
	displayName: 'Ada',
	createdAt: 1,
	lastUsedAt: null,
});

const listing = (result: Result<Connection[]>): Pick<ApiClient, 'connections'> => ({
	connections: () => Promise.resolve(result),
});

describe('reconciling with the server', () => {
	it('binds the device, notes and all, to the account the server has connected', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });

		const state = await reconcileAccount(db, listing({ ok: true, value: [connection('c1')] }));

		expect(state).toEqual({ kind: 'connected', connection: connection('c1') });
		expect(await activeConnectionId(db)).toBe('c1');
		expect((await getNote(db, note.id))?.connectionId).toBe('c1');
	});

	it('leaves a device already bound to it alone', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await db.syncState.update('c1', { cursor: 'kept' });

		await reconcileAccount(
			db,
			listing({ ok: true, value: [connection('c2'), connection('c1')] })
		);

		expect(await activeConnectionId(db)).toBe('c1');
		expect((await db.syncState.get('c1'))?.cursor).toBe('kept');
	});

	it('passes over a provider this build cannot sync with', async () => {
		const db = freshDatabase();

		const state = await reconcileAccount(
			db,
			listing({ ok: true, value: [connection('c1', 'gdrive')] })
		);

		expect(state).toEqual({ kind: 'none' });
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('unbinds, keeping the notes, when the server says the connection has gone', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });

		expect(await reconcileAccount(db, listing({ ok: true, value: [] }))).toEqual({
			kind: 'none',
		});

		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect((await getNote(db, note.id))?.connectionId).toBe(LOCAL_CONNECTION_ID);
	});

	it('changes nothing without a session: an expired session is not a disconnect', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });

		expect(
			await reconcileAccount(db, listing({ ok: false, refusal: 'sign_in_required' }))
		).toEqual({ kind: 'signed-out' });

		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('changes nothing when the server cannot be asked', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });

		await expect(
			reconcileAccount(db, { connections: () => Promise.reject(new TypeError('offline')) })
		).rejects.toThrow('offline');

		expect(await activeConnectionId(db)).toBe('c1');
	});
});

describe('disconnecting', () => {
	it('lets go on the server first, then unbinds the device', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const order: string[] = [];
		const disconnect = vi.fn<ApiClient['disconnect']>(async () => {
			order.push(`server, bound to ${await activeConnectionId(db)}`);
			return { ok: true, value: { revoked: true } };
		});

		expect(await disconnectAccount(db, { disconnect }, 'c1')).toEqual({ ok: true });

		expect(disconnect).toHaveBeenCalledWith('c1');
		expect(order).toEqual(['server, bound to c1']);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('unbinds when the server no longer has the connection', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });

		await disconnectAccount(
			db,
			{ disconnect: () => Promise.resolve({ ok: false, refusal: 'not_found' }) },
			'c1'
		);

		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('stays connected when the server refuses', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });

		expect(
			await disconnectAccount(
				db,
				{ disconnect: () => Promise.resolve({ ok: false, refusal: 'sign_in_required' }) },
				'c1'
			)
		).toEqual({ ok: false, refusal: 'sign_in_required' });

		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('stays connected when the server cannot be reached', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });

		await expect(
			disconnectAccount(
				db,
				{ disconnect: () => Promise.reject(new TypeError('offline')) },
				'c1'
			)
		).rejects.toThrow('offline');

		expect(await activeConnectionId(db)).toBe('c1');
	});
});
