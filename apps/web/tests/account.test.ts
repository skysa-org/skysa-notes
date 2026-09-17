import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient, type Connection, type Result } from '../src/api/client.js';
import { bindConnection, NOTES_ACCOUNT_KEY, unbindConnection } from '../src/store/connection.js';
import {
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
} from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, deleteNote, getNote } from '../src/store/notes.js';
import { adoptAccount, disconnectAccount, reconcileAccount } from '../src/sync/account.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`account-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const connection = (
	id: string,
	provider: Connection['provider'] = 'dropbox',
	accountId: string | null = 'dbid:1'
): Connection => ({
	id,
	provider,
	displayName: 'Ada',
	accountId,
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

describe('reconciling while the device changes under it', () => {
	/** A server whose first answer arrives only after `meanwhile` has run. */
	const answeringAfter = (
		meanwhile: () => Promise<unknown>,
		first: Result<Connection[]>,
		later: Result<Connection[]>
	) => {
		const asked = vi.fn<ApiClient['connections']>();
		asked
			.mockImplementationOnce(async () => {
				await meanwhile();
				return first;
			})
			.mockImplementation(() => Promise.resolve(later));
		return { connections: asked };
	};

	it('does not bind again to a connection disconnected while it was asking', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const client = answeringAfter(
			() => unbindConnection(db),
			{ ok: true, value: [connection('c1')] },
			{ ok: false, refusal: 'sign_in_required' }
		);

		const state = await reconcileAccount(db, client);

		expect(state).toEqual({ kind: 'signed-out' });
		expect(client.connections).toHaveBeenCalledTimes(2);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('does not unbind a connection made while it was asking', async () => {
		const db = freshDatabase();
		const client = answeringAfter(
			() => bindConnection(db, { connectionId: 'c2', provider: 'dropbox' }),
			{ ok: true, value: [] },
			{ ok: true, value: [connection('c2')] }
		);

		const state = await reconcileAccount(db, client);

		expect(state).toEqual({ kind: 'connected', connection: connection('c2') });
		expect(await activeConnectionId(db)).toBe('c2');
	});

	it('does not bind a connection bound and disconnected again while it was asking', async () => {
		const db = freshDatabase();
		const client = answeringAfter(
			async () => {
				await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
				await unbindConnection(db);
			},
			{ ok: true, value: [connection('c1')] },
			{ ok: false, refusal: 'sign_in_required' }
		);

		const state = await reconcileAccount(db, client);

		expect(state).toEqual({ kind: 'signed-out' });
		expect(client.connections).toHaveBeenCalledTimes(2);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('gives up rather than chase a device that keeps changing', async () => {
		const db = freshDatabase();
		const flip = vi.fn(async () => {
			const bound = await activeConnectionId(db);
			await (bound === LOCAL_CONNECTION_ID
				? bindConnection(db, { connectionId: 'c2', provider: 'dropbox' })
				: unbindConnection(db));
		});
		const client = {
			connections: async (): Promise<Result<Connection[]>> => {
				await flip();
				return { ok: true, value: [connection('c1')] };
			},
		};

		await expect(reconcileAccount(db, client)).rejects.toThrow();
		expect(flip).toHaveBeenCalledTimes(2);
	});
});

describe('reconciling after the device has belonged to an account', () => {
	/** Notes synced with account `dbid:1` as connection `c1`, then disconnected. */
	const disconnectedFrom = async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await db.notes.update(note.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await unbindConnection(db);
		return { db, note };
	};

	it('picks up with the same account, under the new id reconnecting gave it', async () => {
		const { db, note } = await disconnectedFrom();

		const state = await reconcileAccount(db, listing({ ok: true, value: [connection('c2')] }));

		expect(state).toEqual({ kind: 'connected', connection: connection('c2') });
		expect(await getNote(db, note.id)).toMatchObject({ connectionId: 'c2', remoteId: 'id:1' });
	});

	it('asks before copying the notes into a different account', async () => {
		const { db, note } = await disconnectedFrom();
		const other = connection('c9', 'dropbox', 'dbid:2');

		const state = await reconcileAccount(db, listing({ ok: true, value: [other] }));

		expect(state).toEqual({ kind: 'other-account', connection: other });
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect((await getNote(db, note.id))?.remoteId).toBe('id:1');
	});

	it('asks while the device is still bound to the account the notes belong to', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await createFolder(db, { name: 'Work' });
		const other = connection('c9', 'dropbox', 'dbid:2');

		const state = await reconcileAccount(db, listing({ ok: true, value: [other] }));

		expect(state).toEqual({ kind: 'other-account', connection: other });
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('does not ask when there is nothing on the device to copy', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const gone = await createNote(db, { title: 'Gone' });
		await deleteNote(db, gone.id);
		await db.notes.update(gone.id, { remoteId: 'id:1' });
		await unbindConnection(db);

		const state = await reconcileAccount(
			db,
			listing({ ok: true, value: [connection('c9', 'dropbox', 'dbid:2')] })
		);

		expect(state.kind).toBe('connected');
		expect(await activeConnectionId(db)).toBe('c9');
	});

	it('takes the notes’ own account when the server has more than one', async () => {
		const { db } = await disconnectedFrom();

		await reconcileAccount(
			db,
			listing({
				ok: true,
				value: [connection('c9', 'dropbox', 'dbid:2'), connection('c2')],
			})
		);

		expect(await activeConnectionId(db)).toBe('c2');
	});

	it('copies the notes into the other account once the user says so', async () => {
		const { db, note } = await disconnectedFrom();
		const other = connection('c9', 'dropbox', 'dbid:2');

		expect(await adoptAccount(db, other)).toEqual({ kind: 'connected', connection: other });

		const row = await getNote(db, note.id);
		expect(row?.connectionId).toBe('c9');
		expect(row?.remoteId).toBeUndefined();
		// They are its notes now, and come back to it without asking.
		expect((await db.prefs.get(NOTES_ACCOUNT_KEY))?.value).toBe('dropbox:dbid:2');
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
