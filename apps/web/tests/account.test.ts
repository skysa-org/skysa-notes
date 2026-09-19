import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient, type Connection, type Result } from '../src/api/client.js';
import { bindConnection, detachConnection } from '../src/store/connection.js';
import { beginConnect } from '../src/store/credentials.js';
import {
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	noteRef,
	type NotesDatabase,
	PENDING_CREDENTIAL_ID,
} from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { beforeClosing } from '../src/store/heldEdits.js';
import { createNote, deleteNote, getNote, saveNoteBody } from '../src/store/notes.js';
import {
	claimConnection,
	disconnectAccount,
	reconcileAccount,
	stopSyncingHere,
} from '../src/sync/account.js';
import { updateNote } from './noteRows.js';

/**
 * Reconciling a device with the server, now that what it presents is a
 * credential rather than a session.
 *
 * The shape of the question changed with it, and that is what most of these are
 * about. There is no list to read an absence out of: a credential reaches one
 * connection or it has stopped reaching anything, so the device lets a source
 * go on a definite answer about its own connection and on nothing else — and
 * lets it go the one way there is: what the remote has leaves the device, and
 * what it was never sent stays under its own source, detached.
 */

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
	grantId: 'g1',
});

/**
 * A server that answers `result` whatever credential it is shown, recording
 * which one it was shown. Every authenticated call goes through
 * `withCredential`, so that is the seam a test stubs.
 */
const answering = (result: Result<Connection>) => {
	const asked = vi.fn<() => Promise<Result<Connection>>>(() => Promise.resolve(result));
	const withCredential = vi.fn(
		(credential: string) =>
			({ connection: asked, credential }) as unknown as ReturnType<
				ApiClient['withCredential']
			>
	);
	return { withCredential, asked };
};

/** A device holding a credential for `connectionId`, as connecting leaves it. */
const holding = async (db: NotesDatabase, connectionId: string, credential = 'sk1_held') => {
	await db.credentials.put({
		id: connectionId,
		credential,
		provider: 'dropbox',
		createdAt: Date.now(),
	});
	return credential;
};

describe('claiming a connection the user has just consented to', () => {
	it('takes up the credential the flow wrote down, and brings the notes', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		const { credential } = await beginConnect(db, 'dropbox');
		const client = answering({ ok: true, value: connection('c1') });

		const state = await claimConnection(db, client);

		expect(state).toEqual({ kind: 'connected', connection: connection('c1') });
		// Asked with the credential the device wrote down before it left, which
		// is the only thing that can identify the flow that has just come back.
		expect(client.withCredential).toHaveBeenCalledWith(credential);
		// Filed under the connection it turned out to reach. It could not have
		// been filed under it before: the id did not exist until now.
		expect((await db.credentials.get('c1'))?.credential).toBe(credential);
		expect(await db.credentials.get(PENDING_CREDENTIAL_ID)).toBeUndefined();
		expect(await activeConnectionId(db)).toBe('c1');
		expect((await getNote(db, note.id))?.connectionId).toBe('c1');
	});

	it('signs out the credential it held for the same connection, once the new one is kept', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const old = await holding(db, 'c1', 'sk1_old');
		const { credential } = await beginConnect(db, 'dropbox');
		const revoked: string[] = [];
		const kept: (string | undefined)[] = [];
		const bound: (string | undefined)[] = [];
		const withCredential = vi.fn(
			(presented: string) =>
				({
					connection: () =>
						Promise.resolve({
							ok: true,
							value: {
								...connection('c1'),
								grantId: presented === old ? 'g-old' : 'g-new',
							},
						}),
					revokeGrant: async (id: string) => {
						bound.push(await activeConnectionId(db));
						kept.push((await db.credentials.get('c1'))?.credential);
						revoked.push(`${presented} ${id}`);
						return { ok: true, value: { ok: true } };
					},
				}) as unknown as ReturnType<ApiClient['withCredential']>
		);

		await claimConnection(db, { withCredential });

		// Its own grant, with its own credential — and not before the device
		// held the new one, or a failure in between leaves it holding none.
		expect(revoked).toEqual(['sk1_old g-old']);
		expect(kept).toEqual([credential]);
		// Nor before it was bound: a slow server is not put in front of that.
		expect(bound).toEqual(['c1']);
	});

	it('connects all the same when the old credential cannot be signed out', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const old = await holding(db, 'c1', 'sk1_old');
		const { credential } = await beginConnect(db, 'dropbox');
		const revokeGrant = vi.fn();
		const withCredential = vi.fn(
			(presented: string) =>
				({
					// Revoked already, which is the usual reason to connect again.
					connection: () =>
						presented === old
							? Promise.resolve({ ok: false, error: 'credential_revoked' })
							: Promise.resolve({ ok: true, value: connection('c1') }),
					revokeGrant,
				}) as unknown as ReturnType<ApiClient['withCredential']>
		);

		const state = await claimConnection(db, { withCredential });

		expect(state.kind).toBe('connected');
		expect(revokeGrant).not.toHaveBeenCalled();
		expect((await db.credentials.get('c1'))?.credential).toBe(credential);
	});

	it('nor is it stopped by a server that does not answer about the old one at all', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const old = await holding(db, 'c1', 'sk1_old');
		const { credential } = await beginConnect(db, 'dropbox');
		const withCredential = vi.fn(
			(presented: string) =>
				({
					connection: () =>
						presented === old
							? Promise.reject(new Error('offline'))
							: Promise.resolve({ ok: true, value: connection('c1') }),
				}) as unknown as ReturnType<ApiClient['withCredential']>
		);

		const state = await claimConnection(db, { withCredential });

		expect(state.kind).toBe('connected');
		expect((await db.credentials.get('c1'))?.credential).toBe(credential);
	});

	it('binds without asking, whatever the device held of its own', async () => {
		const db = freshDatabase();
		// Written before anything was connected: the only thing the device's own
		// pile ever holds, and it belongs wherever the user first connects.
		await createFolder(db, { name: 'Work' });
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		const { credential } = await beginConnect(db, 'dropbox');
		const first = connection('c9', 'dropbox', 'dbid:2');

		const state = await claimConnection(db, answering({ ok: true, value: first }));

		expect(state).toEqual({ kind: 'connected', connection: first });
		expect((await db.credentials.get('c9'))?.credential).toBe(credential);
		expect(await activeConnectionId(db)).toBe('c9');
		expect((await getNote(db, note.id))?.connectionId).toBe('c9');
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
	});

	it('does not ask about another source’s notes, which binding will not move', async () => {
		const db = freshDatabase();
		// Ada's source, connected and staying connected.
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		await createFolder(db, { name: 'Work' });
		await beginConnect(db, 'dropbox');
		const other = connection('c9', 'dropbox', 'dbid:2');

		const state = await claimConnection(db, answering({ ok: true, value: other }));

		// Nothing of Ada's is going anywhere — each source keeps its own rows —
		// so there is nothing to stop and ask about.
		expect(state).toEqual({ kind: 'connected', connection: other });
		expect(await activeConnectionId(db)).toBe('c9');
		expect(await db.folders.where('connectionId').equals('c1').count()).toBe(1);
		expect(await db.folders.where('connectionId').equals('c9').count()).toBe(0);
	});

	it('keeps a credential the server will not answer for, and reconciles instead', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		await beginConnect(db, 'dropbox');

		// A flow the user abandoned, one whose callback never committed — or one
		// still out, with the consent page open in another tab. The server's
		// answer is the same refusal for all three, so it cannot decide.
		const state = await claimConnection(db, {
			withCredential: (credential: string) =>
				({
					connection: () =>
						Promise.resolve(
							credential === 'sk1_held'
								? { ok: true, value: connection('c1') }
								: { ok: false, refusal: 'credential_revoked' }
						),
				}) as unknown as ReturnType<ApiClient['withCredential']>,
		});

		expect(state).toEqual({ kind: 'connected', connection: connection('c1') });
		// Kept. Consent given after this would spend the hash for ever, and a
		// device that had thrown the plaintext away could neither reach the
		// connection nor revoke it. `PENDING_TTL_MS` sweeps a flow that really
		// was abandoned; nothing here has to guess.
		expect(await db.credentials.get(PENDING_CREDENTIAL_ID)).toBeDefined();
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('reconciles when no flow is out', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		const state = await claimConnection(db, answering({ ok: true, value: connection('c1') }));

		expect(state).toEqual({ kind: 'connected', connection: connection('c1') });
	});

	it('forgets a flow nobody ever came back from', async () => {
		const db = freshDatabase();
		await beginConnect(db, 'dropbox', Date.now() - 25 * 60 * 60 * 1000);
		const client = answering({ ok: true, value: connection('c1') });

		const state = await claimConnection(db, client);

		// A day-old pending credential is not a consent on its way back, and
		// presenting it would only spend a request finding that out.
		expect(state).toEqual({ kind: 'none' });
		expect(client.withCredential).not.toHaveBeenCalled();
		expect(await db.credentials.get(PENDING_CREDENTIAL_ID)).toBeUndefined();
	});
});

describe('reconciling with the server', () => {
	it('confirms the connection and learns the account it belongs to', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await db.syncState.update('c1', { cursor: 'kept' });
		const credential = await holding(db, 'c1');
		const client = answering({ ok: true, value: connection('c1') });

		const state = await reconcileAccount(db, client);

		expect(state).toEqual({ kind: 'connected', connection: connection('c1') });
		expect(client.withCredential).toHaveBeenCalledWith(credential);
		expect(await activeConnectionId(db)).toBe('c1');
		expect((await db.syncState.get('c1'))?.cursor).toBe('kept');
		// On the source, not on the device: it says whose *this connection's*
		// files are, which is what letting it go needs in order to say whose
		// notes came back.
		expect((await db.syncState.get('c1'))?.accountId).toBe('dbid:1');
	});

	it('answers `none`, and asks nothing, with nothing connected', async () => {
		const db = freshDatabase();
		const client = answering({ ok: true, value: connection('c1') });

		expect(await reconcileAccount(db, client)).toEqual({ kind: 'none' });
		expect(client.withCredential).not.toHaveBeenCalled();
	});

	it('lets the source go, keeping what was never sent, when the credential reaches nothing any more', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sent = await createNote(db, { title: 'Sent', folderPath: 'Work' });
		await updateNote(db, sent.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		const unsent = await createNote(db, { title: 'Plan', folderPath: 'Work' });

		// Revoked from another device, or the account disconnected there. The
		// server spends a credential's hash for ever, so this never comes back.
		expect(
			await reconcileAccount(db, answering({ ok: false, refusal: 'credential_revoked' }))
		).toEqual({ kind: 'none' });

		expect(await db.credentials.get('c1')).toBeUndefined();
		// Nobody was there to ask, so nothing was discarded and nothing moved:
		// the note the remote never had is where it was, in a source that says
		// it is disconnected, and that source is still the one in front.
		expect(await db.syncState.get('c1')).toMatchObject({ detached: { reason: 'revoked' } });
		expect(await activeConnectionId(db)).toBe('c1');
		expect((await getNote(db, unsent.id))?.connectionId).toBe('c1');
		// What the remote has is gone from here, and comes back on reconnecting.
		expect(await db.notes.get(['c1', sent.id])).toBeUndefined();
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
	});

	it('lets it go entirely when there was nothing the remote lacked', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sent = await createNote(db, { title: 'Sent' });
		await updateNote(db, sent.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();

		expect(await reconcileAccount(db, answering({ ok: false, refusal: 'not_found' }))).toEqual({
			kind: 'none',
		});

		expect(await db.syncState.count()).toBe(0);
		expect(await db.notes.count()).toBe(0);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('has the editors write first, so a sentence still held is kept and not removed', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const note = await createNote(db, { title: 'Plan' });
		await updateNote(db, note.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		// Typed inside the autosave window: in no row yet. The note looks clean,
		// and would go with everything else the remote has.
		const withdraw = beforeClosing(() => saveNoteBody(db, note.id, '# Plan\n\njust typed\n'));

		await reconcileAccount(db, answering({ ok: false, refusal: 'credential_revoked' }));
		withdraw();

		expect(await db.notes.get(['c1', note.id])).toMatchObject({
			body: '# Plan\n\njust typed\n',
			dirty: 1,
			remoteId: 'id:1',
		});
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
	});

	it('lets go when it is bound to a connection it holds no credential for', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const client = answering({ ok: true, value: connection('c1') });

		expect(await reconcileAccount(db, client)).toEqual({ kind: 'none' });

		// Nothing here can reach that connection again — a credential cannot be
		// re-derived, and the server issues one only through a fresh flow — so
		// claiming to be connected would be a lie with a sync loop attached.
		expect(client.withCredential).not.toHaveBeenCalled();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('asks nothing about a detached source, and leaves it exactly as it is', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await createNote(db, { title: 'Unsent' });
		await detachConnection(db, { connectionId: 'c1' });
		const state = await db.syncState.get('c1');
		const bindings = await db.prefs.get('sync.bindings');
		const client = answering({ ok: true, value: connection('c1') });

		// It is the source in front, and it has no credential — which is the very
		// shape that means "let it go" for a live source. Asked on every open.
		expect(await reconcileAccount(db, client)).toEqual({ kind: 'none' });
		expect(await reconcileAccount(db, client)).toEqual({ kind: 'none' });

		expect(client.withCredential).not.toHaveBeenCalled();
		expect(await db.syncState.get('c1')).toEqual(state);
		expect(await db.prefs.get('sync.bindings')).toEqual(bindings);
	});

	it('changes nothing when the server cannot be asked', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		await expect(
			reconcileAccount(db, {
				withCredential: () =>
					({
						connection: () => Promise.reject(new TypeError('offline')),
					}) as unknown as ReturnType<ApiClient['withCredential']>,
			})
		).rejects.toThrow('offline');

		expect(await activeConnectionId(db)).toBe('c1');
		expect(await db.credentials.get('c1')).toBeDefined();
	});

	it('changes nothing on a refusal that is not about this connection existing', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		// Only `credential_revoked` and `not_found` say the connection is gone.
		// Anything else is the server declining to answer, and unbinding on it
		// would take a device off its own notes on the strength of a guess.
		await expect(
			reconcileAccount(db, answering({ ok: false, refusal: 'not_entitled' }))
		).rejects.toThrow(/not_entitled/);

		expect(await activeConnectionId(db)).toBe('c1');
		expect(await db.credentials.get('c1')).toBeDefined();
	});

	it('leaves a provider this build cannot sync with connected, and syncs nothing', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		// A newer Worker in front of an older cached app. The connection is real
		// and the next build will sync it, so the rows stay where they are.
		const state = await reconcileAccount(
			db,
			answering({ ok: true, value: connection('c1', 'webdav') })
		);

		expect(state).toEqual({ kind: 'none' });
		expect(await activeConnectionId(db)).toBe('c1');
	});
});

describe('reconciling while the device changes under it', () => {
	it('asks again when the device was disconnected while it was asking', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const asked = vi.fn<() => Promise<Result<Connection>>>();
		asked
			.mockImplementationOnce(async () => {
				await detachConnection(db, { connectionId: 'c1' });
				return { ok: true, value: connection('c1') };
			})
			.mockImplementation(() => Promise.resolve({ ok: true, value: connection('c1') }));

		const state = await reconcileAccount(db, {
			withCredential: () =>
				({ connection: asked }) as unknown as ReturnType<ApiClient['withCredential']>,
		});

		// What came back was about a device that no longer exists. Asked again,
		// the device holds nothing, so the honest answer is `none`.
		expect(state).toEqual({ kind: 'none' });
		expect(asked).toHaveBeenCalledTimes(1);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('gives up rather than chase a device that keeps changing', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const flip = vi.fn(async () => {
			await db.prefs.put({ key: 'sync.bindings', value: String(Math.random()) });
		});

		await expect(
			reconcileAccount(db, {
				withCredential: () =>
					({
						connection: async () => {
							await flip();
							return { ok: true, value: connection('c1') };
						},
					}) as unknown as ReturnType<ApiClient['withCredential']>,
			})
		).rejects.toThrow(/changed connection/);
		// Twice and no more. Every answer is about a device that has moved on by
		// the time it lands, and retrying for ever would be a loop the user
		// cannot see and cannot stop.
		expect(flip).toHaveBeenCalledTimes(2);
	});
});

describe('the account a detached source belongs to', () => {
	/** Account `dbid:1` as connection `c1`, let go holding an edit it never sent. */
	const detachedFrom = async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await updateNote(db, note.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		await saveNoteBody(db, note.id, '# Plan\n\nnot sent\n');
		await detachConnection(db, { connectionId: 'c1' });
		return { db, note };
	};

	it('picks up with the same account, under the new id reconnecting gave it', async () => {
		const { db, note } = await detachedFrom();
		await beginConnect(db, 'dropbox');

		const state = await claimConnection(db, answering({ ok: true, value: connection('c2') }));

		expect(state).toEqual({ kind: 'connected', connection: connection('c2') });
		expect(await getNote(db, note.id)).toMatchObject({
			connectionId: 'c2',
			remoteId: 'id:1',
			dirty: 1,
		});
		// The source it waited under has gone home with it.
		expect(await db.syncState.get('c1')).toBeUndefined();
		expect((await db.syncState.get('c2'))?.resumeUnverified).toBe(true);
	});

	it('picks up under the same id, where the server still has the connection', async () => {
		const { db, note } = await detachedFrom();
		await beginConnect(db, 'dropbox');

		const state = await claimConnection(db, answering({ ok: true, value: connection('c1') }));

		expect(state).toEqual({ kind: 'connected', connection: connection('c1') });
		expect(await db.syncState.get('c1')).toMatchObject({ resumeUnverified: true });
		expect((await db.syncState.get('c1'))?.detached).toBeUndefined();
		expect(await getNote(db, note.id)).toMatchObject({ connectionId: 'c1', remoteId: 'id:1' });
	});

	it('connects a different account beside it, taking nothing of its', async () => {
		const { db, note } = await detachedFrom();
		await beginConnect(db, 'dropbox');
		const other = connection('c9', 'dropbox', 'dbid:2');

		const state = await claimConnection(db, answering({ ok: true, value: other }));

		// Nothing to ask, because nothing is going anywhere: the unsent edit
		// stays where it is, and is never uploaded into somebody else's storage.
		expect(state).toEqual({ kind: 'connected', connection: other });
		expect(await activeConnectionId(db)).toBe('c9');
		expect(await db.notes.get(['c1', note.id])).toMatchObject({ remoteId: 'id:1', dirty: 1 });
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
		expect(await db.notes.where('connectionId').equals('c9').count()).toBe(0);
		expect(await db.opQueue.where('connectionId').equals('c9').count()).toBe(0);
	});

	it('does not take a delete that was owed to it into another account either', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const note = await createNote(db, { title: 'Gone' });
		await updateNote(db, note.id, { remoteId: 'id:1' });
		await deleteNote(db, note.id);
		await detachConnection(db, { connectionId: 'c1' });
		await beginConnect(db, 'dropbox');

		await claimConnection(
			db,
			answering({ ok: true, value: connection('c9', 'dropbox', 'dbid:2') })
		);

		expect(await db.notes.get(['c1', note.id])).toMatchObject({ deletedLocally: 1 });
		expect(await db.opQueue.where('connectionId').equals('c1').count()).toBe(1);
	});

	it('does not call an account the API does not name the same one', async () => {
		const { db, note } = await detachedFrom();
		await beginConnect(db, 'dropbox');

		const state = await claimConnection(
			db,
			answering({ ok: true, value: connection('c2', 'dropbox', null) })
		);

		// A Worker older than this app. It may well be the same account, and it
		// cannot be said to be: the rows stay, to be downloaded or discarded.
		expect(state.kind).toBe('connected');
		expect((await db.notes.get(['c1', note.id]))?.remoteId).toBe('id:1');
	});
});

describe('what the account is called', () => {
	const named = (
		displayName: string | null,
		accountId: string | null = 'dbid:1'
	): Connection => ({
		...connection('c1', 'dropbox', accountId),
		displayName,
	});

	it('is written down when the connection is taken up', async () => {
		const db = freshDatabase();
		await beginConnect(db, 'dropbox');

		await claimConnection(db, answering({ ok: true, value: named('ada@example.com') }));

		expect((await db.syncState.get('c1'))?.displayName).toBe('ada@example.com');
	});

	it('is written on each reconcile, so the last name heard is the one kept', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		expect((await db.syncState.get('c1'))?.displayName).toBeUndefined();

		await reconcileAccount(db, answering({ ok: true, value: named('ada@example.com') }));
		expect((await db.syncState.get('c1'))?.displayName).toBe('ada@example.com');

		// Renamed at the provider, under the same connection.
		await reconcileAccount(db, answering({ ok: true, value: named('ada@lovelace.example') }));
		expect((await db.syncState.get('c1'))?.displayName).toBe('ada@lovelace.example');
	});

	it('is written for an account the server does not name by id', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		await reconcileAccount(db, answering({ ok: true, value: named('ada@example.com', null) }));

		const state = await db.syncState.get('c1');
		expect(state?.displayName).toBe('ada@example.com');
		expect(state?.accountId).toBeUndefined();
	});

	it('is kept when the server has no name to give', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		await reconcileAccount(db, answering({ ok: true, value: named('ada@example.com') }));

		await reconcileAccount(db, answering({ ok: true, value: named(null) }));

		expect((await db.syncState.get('c1'))?.displayName).toBe('ada@example.com');
	});

	it('survives the connection being bound again, and everything else the row is rewritten for', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		await reconcileAccount(db, answering({ ok: true, value: named('ada@example.com') }));
		await db.syncState.update('c1', { cursor: 'cursor-1', rootId: 'root-1' });

		// As a flow finishing twice does, and as a caller
		// that was never told a name does.
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });

		expect(await db.syncState.get('c1')).toMatchObject({
			displayName: 'ada@example.com',
			cursor: 'cursor-1',
			rootId: 'root-1',
		});

		// A second source connected alongside has a name of its own, and leaves
		// this one's alone.
		await bindConnection(db, {
			connectionId: 'c2',
			provider: 'gdrive',
			accountId: 'g:2',
			displayName: 'cy@example.com',
		});
		expect((await db.syncState.get('c1'))?.displayName).toBe('ada@example.com');
		expect((await db.syncState.get('c2'))?.displayName).toBe('cy@example.com');
	});
});

describe('disconnecting', () => {
	const disconnecting = (result: Result<{ revoked: boolean }>, order?: string[]) => {
		const disconnect = vi.fn<ApiClient['disconnect']>(() => {
			order?.push('server');
			return Promise.resolve(result);
		});
		const withCredential = vi.fn(
			(credential: string) =>
				({ disconnect, credential }) as unknown as ReturnType<ApiClient['withCredential']>
		);
		return { withCredential, disconnect };
	};

	it('lets go on the server first, then here, and forgets the credential', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const credential = await holding(db, 'c1');
		const order: string[] = [];
		const client = disconnecting({ ok: true, value: { revoked: true } }, order);

		expect(await disconnectAccount(db, client, 'c1')).toEqual({ ok: true });

		expect(client.withCredential).toHaveBeenCalledWith(credential);
		expect(order).toEqual(['server']);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		// Nothing to tell the server: its hash is spent there for ever, so a copy
		// of this credential taken before now can claim nothing.
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it.each([
		['the server no longer has the connection', 'not_found'],
		['the credential no longer reaches it', 'credential_revoked'],
	] as const)('finishes the job when %s', async (_name, refusal) => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		expect(await disconnectAccount(db, disconnecting({ ok: false, refusal }), 'c1')).toEqual({
			ok: true,
		});
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('lets go without asking when there is no credential to ask with', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const client = disconnecting({ ok: true, value: { revoked: true } });

		expect(await disconnectAccount(db, client, 'c1')).toEqual({ ok: true });

		// The server cannot be asked, and the alternative is a binding the user
		// has no way to get rid of.
		expect(client.withCredential).not.toHaveBeenCalled();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('keeps what was typed while the server was being asked', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sent = await createNote(db, { title: 'Sent', body: '# Sent\n' });
		await updateNote(db, sent.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		// The editor: what it holds, and the flush it registers.
		const held: { body?: string } = {};
		const withdraw = beforeClosing(async () => {
			if (held.body === undefined) return [];
			const body = held.body;
			delete held.body;
			await saveNoteBody(db, sent.id, body, { origin: '', note: sent });
			return [];
		});
		// A server that answers only when the test lets it.
		const notYet = () => undefined;
		const answer: { now: () => void } = { now: notYet };
		const client = {
			withCredential: () => ({
				disconnect: () =>
					new Promise<{ ok: true; value: { revoked: boolean } }>((resolve) => {
						answer.now = () => {
							resolve({ ok: true, value: { revoked: true } });
						};
					}),
			}),
		} as unknown as Pick<ApiClient, 'withCredential'>;

		const disconnecting = disconnectAccount(db, client, 'c1');
		// The editors were settled before the server was asked; the confirm is
		// not modal, and the user keeps typing while it thinks.
		await vi.waitFor(() => {
			expect(answer.now).not.toBe(notYet);
		});
		held.body = '# Sent\n\ntyped while the server was thinking\n';
		answer.now();
		expect(await disconnecting).toEqual({ ok: true });
		withdraw();

		// The remote has the note. It does not have this, and this is kept.
		expect(await db.notes.get(['c1', sent.id])).toMatchObject({
			body: '# Sent\n\ntyped while the server was thinking\n',
			dirty: 1,
			remoteId: 'id:1',
		});
		expect(await db.syncState.get('c1')).toMatchObject({
			detached: { reason: 'disconnected' },
		});
	});

	it('keeps a note whose save is still failing, whatever its row says', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sent = await createNote(db, { title: 'Sent' });
		await updateNote(db, sent.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		const other = await createNote(db, { title: 'Other' });
		await updateNote(db, other.id, { remoteId: 'id:2', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		// An editor whose save of `sent` has been failing: its text is in no row,
		// and the row is clean. It says so when asked to write.
		const withdraw = beforeClosing(() => Promise.resolve([noteRef(sent)]));
		const client = disconnecting({ ok: true, value: { revoked: true } });

		expect(await disconnectAccount(db, client, 'c1')).toEqual({ ok: true });
		withdraw();

		// The row is not the whole of what the user wrote, so it stays, for the
		// save to land in when it can; the other went with the remote.
		expect(await db.notes.get(['c1', sent.id])).toMatchObject({ remoteId: 'id:1', dirty: 0 });
		expect(await db.notes.get(['c1', other.id])).toBeUndefined();
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
	});

	it('removes the synced notes, and keeps what was never sent under the source, detached', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sent = await createNote(db, { title: 'Sent' });
		await updateNote(db, sent.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		const unsent = await createNote(db, { title: 'Unsent' });
		const client = disconnecting({ ok: true, value: { revoked: true } });

		expect(await disconnectAccount(db, client, 'c1')).toEqual({ ok: true });

		expect(await db.notes.get(['c1', sent.id])).toBeUndefined();
		expect(await db.notes.get(['c1', unsent.id])).toBeDefined();
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
		expect(await db.credentials.get('c1')).toBeUndefined();
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
	});

	it('stops syncing on this device alone the same way, asking the server nothing', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sent = await createNote(db, { title: 'Sent' });
		await updateNote(db, sent.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		const unsent = await createNote(db, { title: 'Unsent' });

		await stopSyncingHere(db, 'c1');

		expect(await db.notes.get(['c1', sent.id])).toBeUndefined();
		expect(await db.notes.get(['c1', unsent.id])).toBeDefined();
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
		// The key to the account goes with it: a source that says it is
		// disconnected must not be holding a live credential.
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('stays connected when the server refuses', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		expect(
			await disconnectAccount(db, disconnecting({ ok: false, refusal: 'not_entitled' }), 'c1')
		).toEqual({ ok: false, refusal: 'not_entitled' });

		expect(await activeConnectionId(db)).toBe('c1');
		expect(await db.credentials.get('c1')).toBeDefined();
	});

	it('stays connected when the server cannot be reached', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');

		await expect(
			disconnectAccount(
				db,
				{
					withCredential: () =>
						({
							disconnect: () => Promise.reject(new TypeError('offline')),
						}) as unknown as ReturnType<ApiClient['withCredential']>,
				},
				'c1'
			)
		).rejects.toThrow('offline');

		expect(await activeConnectionId(db)).toBe('c1');
		expect(await db.credentials.get('c1')).toBeDefined();
	});
});
