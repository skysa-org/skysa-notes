import { parentPath, ROOT } from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	bindConnection,
	connectedSources,
	detachConnection,
	releaseConnection,
	showConnection,
} from '../src/store/connection.js';
import { credentialFor } from '../src/store/credentials.js';
import {
	ACTIVE_CONNECTION_KEY,
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	noteRef,
	type NotesDatabase,
} from '../src/store/db.js';
import { deletedHere } from '../src/store/deletedHere.js';
import { createFolder, deleteFolder, renameFolder } from '../src/store/folders.js';
import { goneSources } from '../src/store/goneSources.js';
import { movedRows } from '../src/store/movedRows.js';
import {
	createNote,
	deleteNote,
	getNote,
	importNoteFile,
	listNotes,
	saveNoteBody,
} from '../src/store/notes.js';
import { queueWrite } from '../src/store/queue.js';
import { countOf, isEmpty, type Seen, seenIn, unsyncedIn } from '../src/store/unsynced.js';
import { createDexieSyncStore, UnboundConnectionError } from '../src/sync/store.js';

/**
 * Letting a source go. The remote is the source of truth, so what it has leaves
 * the device; what it was never sent stays, under the source it was written in,
 * detached and in sight; and nothing a disconnect does fills the device's own
 * pile or reaches another account (docs/ARCHITECTURE.md §6, §10).
 */

const ADA = { connectionId: 'c-ada', provider: 'dropbox', accountId: 'dbid:ada' } as const;
const BOB = { connectionId: 'c-bob', provider: 'dropbox', accountId: 'dbid:bob' } as const;
const ada = { connectionId: ADA.connectionId };

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`detach-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const holdCredential = (db: NotesDatabase, connectionId: string) =>
	db.credentials.put({
		id: connectionId,
		credential: `sk1_${connectionId}`,
		provider: 'dropbox',
		createdAt: 0,
	});

/** Ada's source, live: bound, holding a credential, a cursor, a root and a token. */
const connected = async () => {
	const db = freshDatabase();
	await bindConnection(db, { ...ADA, displayName: 'ada@example.com' });
	await holdCredential(db, ADA.connectionId);
	await db.syncState.update(ADA.connectionId, {
		cursor: 'cursor-1',
		rootId: 'root-1',
		lastSyncAt: 5,
		accessToken: 'token-1',
		accessTokenExpiresAt: 10,
	});
	return db;
};

/**
 * A note as a pull leaves it: clean, with a file on the remote, and nothing
 * queued — in a notebook, where it has one, that the pull named too.
 */
const pushed = async (
	db: NotesDatabase,
	path: string,
	connectionId: string = ADA.connectionId
): Promise<NoteRecord> => {
	const folder = parentPath(path);
	if (folder !== ROOT) {
		await db.folders.put({ connectionId, path: folder, remoteId: `f:${folder}`, createdAt: 0 });
	}
	return importNoteFile(db, {
		connectionId,
		path,
		source: `# ${path}\n`,
		remoteId: `r:${connectionId}:${path}`,
		remoteVersion: 'v1',
	});
};

const pathsUnder = async (db: NotesDatabase, connectionId: string) =>
	(await db.notes.where('connectionId').equals(connectionId).toArray())
		.map((note) => note.path)
		.sort();

const foldersUnder = async (db: NotesDatabase, connectionId: string) =>
	(await db.folders.where('connectionId').equals(connectionId).toArray())
		.map((folder) => folder.path)
		.sort();

const opsUnder = async (db: NotesDatabase, connectionId: string) =>
	(await db.opQueue.where('connectionId').equals(connectionId).sortBy('seq')).map(
		(op) => `${op.op} ${op.targetPath ?? op.path}`
	);

/** What the user was shown of a source: everything it holds, as it stands now. */
const shownNow = async (
	db: NotesDatabase,
	connectionId: string = ADA.connectionId
): Promise<Seen> => seenIn(await unsyncedIn(db, connectionId));

const NOTHING_SEEN: Seen = { notes: new Map(), folders: new Set(), rmdirs: new Set() };

describe('letting a source go', () => {
	it('removes what the remote has, and the source with it when that is everything', async () => {
		const db = await connected();
		await pushed(db, 'Work/plan.md');
		await pushed(db, 'loose.md');
		// A tombstone that never had a file owes nothing, and a stuck op left over
		// for a row long purged stands for nothing the user made.
		const never = await createNote(db, { ...ada, title: 'Never' });
		await deleteNote(db, never.id, ada);
		await db.opQueue.add({
			...ada,
			op: 'write',
			noteId: 'purged-long-ago',
			path: 'purged.md',
			attempts: 99,
			lastError: 'boom',
			queuedAt: 0,
		});
		expect(isEmpty(await unsyncedIn(db, ADA.connectionId))).toBe(true);

		expect(await detachConnection(db, { connectionId: ADA.connectionId })).toBe(true);

		expect(await db.notes.count()).toBe(0);
		expect(await db.folders.count()).toBe(0);
		expect(await db.opQueue.count()).toBe(0);
		expect(await db.syncState.count()).toBe(0);
		expect(await credentialFor(db, ADA.connectionId)).toBeUndefined();
		expect(await db.prefs.get(ACTIVE_CONNECTION_KEY)).toBeUndefined();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('keeps each kind of thing the remote was never sent, as it stands, and removes the rest', async () => {
		const db = await connected();
		// What the remote has in full.
		await pushed(db, 'Sent/clean.md');
		await pushed(db, 'Mixed/clean.md');
		// Edited since it was pushed: still names its file, and the version and
		// hash it last agreed on, so the same account can take it up as an edit.
		const edited = await pushed(db, 'Mixed/edited.md');
		await db.notes.update([ADA.connectionId, edited.id], { syncedHash: 'hash-1' });
		await saveNoteBody(db, edited.id, '# edited\n\nmore\n', undefined, ada);
		// Never pushed at all.
		await createFolder(db, { ...ada, name: 'New' });
		const fresh = await createNote(db, { ...ada, folderPath: 'New', title: 'Fresh' });
		// Clean, and still owed a write.
		const owed = await pushed(db, 'owed.md');
		await queueWrite(db, owed);
		// Carried along by a notebook's rename: clean, with only a move queued.
		await pushed(db, 'Old/moved.md');
		await renameFolder(db, 'Old', 'Renamed', ada);
		// Deleted here, the delete still owed.
		const doomed = await pushed(db, 'doomed.md');
		await deleteNote(db, doomed.id, ada);
		// Deleted here, never having had a file.
		const never = await createNote(db, { ...ada, title: 'Never' });
		await deleteNote(db, never.id, ada);
		// A notebook deleted here, its directory still owed its removal.
		await createFolder(db, { ...ada, name: 'Emptied' });
		await db.folders.update([ADA.connectionId, 'Emptied'], { remoteId: 'f:emptied' });
		await db.opQueue.where('path').equals('Emptied').delete();
		await deleteFolder(db, 'Emptied', ada);
		const opsBefore = await db.opQueue.where('connectionId').equals(ADA.connectionId).toArray();

		expect(await detachConnection(db, { connectionId: ADA.connectionId })).toBe(true);

		expect(await pathsUnder(db, ADA.connectionId)).toEqual([
			'Mixed/edited.md',
			'New/fresh.md',
			'Renamed/moved.md',
			'doomed.md',
			'owed.md',
		]);
		// The notebooks nothing has made, and the ones a kept note sits in — link
		// and all. `Sent` held only what the remote has, and went with it.
		expect(await foldersUnder(db, ADA.connectionId)).toEqual(['Mixed', 'New', 'Renamed']);
		expect((await db.folders.get([ADA.connectionId, 'Mixed']))?.remoteId).toBe('f:Mixed');
		// Every op of a kept row, exactly as queued; none for a row that went.
		const kept = await db.opQueue.where('connectionId').equals(ADA.connectionId).toArray();
		expect(kept).toEqual(opsBefore.filter((op) => op.noteId !== never.id));
		expect(await opsUnder(db, ADA.connectionId)).toEqual(
			expect.arrayContaining([
				'write Mixed/edited.md',
				'mkdir New',
				'write New/fresh.md',
				'write owed.md',
				'move Renamed/moved.md',
				'delete doomed.md',
				'rmdir Emptied',
			])
		);
		// The link to the file, for a note that was pushed once.
		expect(await db.notes.get([ADA.connectionId, edited.id])).toMatchObject({
			remoteId: edited.remoteId,
			remoteVersion: 'v1',
			syncedHash: 'hash-1',
			dirty: 1,
		});
		expect(await db.notes.get([ADA.connectionId, doomed.id])).toMatchObject({
			remoteId: doomed.remoteId,
			deletedLocally: 1,
		});
		expect((await db.notes.get([ADA.connectionId, fresh.id]))?.remoteId).toBeUndefined();
		// And not one row anywhere else: not the device's pile, not another source.
		expect(await db.notes.where('connectionId').notEqual(ADA.connectionId).count()).toBe(0);
		expect(await db.folders.where('connectionId').notEqual(ADA.connectionId).count()).toBe(0);
	});

	it('leaves the source detached: named as it was, reaching nothing, still in front', async () => {
		const db = await connected();
		await createNote(db, { ...ada, title: 'Unsent' });
		const before = await db.syncState.get(ADA.connectionId);
		const started = Date.now();

		await detachConnection(db, { connectionId: ADA.connectionId });

		const state = await db.syncState.get(ADA.connectionId);
		expect(state).toEqual({
			connectionId: ADA.connectionId,
			provider: 'dropbox',
			accountId: 'dbid:ada',
			displayName: 'ada@example.com',
			clientId: before?.clientId,
			detached: { at: state?.detached?.at, reason: 'revoked' },
		});
		expect(state?.detached?.at).toBeGreaterThanOrEqual(started);
		expect(await credentialFor(db, ADA.connectionId)).toBeUndefined();
		// The user is looking at what they have to decide about.
		expect(await activeConnectionId(db)).toBe(ADA.connectionId);

		// Let go again — another tab reconciling — it is what it was, time included.
		await detachConnection(db, { connectionId: ADA.connectionId, reason: 'interrupted' });
		expect(await db.syncState.get(ADA.connectionId)).toEqual(state);
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['unsent.md']);
	});

	it('keeps everything while a resumed source has not been verified', async () => {
		const db = await connected();
		await pushed(db, 'Work/plan.md');
		await pushed(db, 'loose.md');
		await db.syncState.update(ADA.connectionId, { resumeUnverified: true });

		await detachConnection(db, { connectionId: ADA.connectionId });

		// Clean and linked as they look, nobody has found their files: a memory.
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['Work/plan.md', 'loose.md']);
		expect(await foldersUnder(db, ADA.connectionId)).toEqual(['Work']);
		// And still said to be, so that nothing later counts them as safely sent.
		expect(await db.syncState.get(ADA.connectionId)).toMatchObject({
			resumeUnverified: true,
			detached: { reason: 'revoked' },
		});
		expect((await unsyncedIn(db, ADA.connectionId)).notes).toHaveLength(2);
	});

	it('touches nothing of another source, and never fills the device’s own pile', async () => {
		const db = await connected();
		await bindConnection(db, BOB);
		await holdCredential(db, BOB.connectionId);
		await pushed(db, 'Work/his.md', BOB.connectionId);
		const hisUnsent = await createNote(db, { connectionId: BOB.connectionId, title: 'His' });
		// The same id in both, as a folder copied between two accounts has.
		await db.notes.add({ ...hisUnsent, connectionId: ADA.connectionId, path: 'hers.md' });
		await pushed(db, 'Work/hers-sent.md');
		const bobBefore = {
			notes: await db.notes.where('connectionId').equals(BOB.connectionId).toArray(),
			folders: await db.folders.where('connectionId').equals(BOB.connectionId).toArray(),
			ops: await db.opQueue.where('connectionId').equals(BOB.connectionId).toArray(),
			state: await db.syncState.get(BOB.connectionId),
		};

		// In turn, which is what used to fill one pile with two accounts' notes.
		await detachConnection(db, { connectionId: ADA.connectionId });

		expect(await db.notes.where('connectionId').equals(BOB.connectionId).toArray()).toEqual(
			bobBefore.notes
		);
		expect(await db.folders.where('connectionId').equals(BOB.connectionId).toArray()).toEqual(
			bobBefore.folders
		);
		expect(await db.opQueue.where('connectionId').equals(BOB.connectionId).toArray()).toEqual(
			bobBefore.ops
		);
		expect(await db.syncState.get(BOB.connectionId)).toEqual(bobBefore.state);
		expect(await credentialFor(db, BOB.connectionId)).toBeDefined();
		// Bob's is the source showing, and stays so.
		expect(await activeConnectionId(db)).toBe(BOB.connectionId);

		await detachConnection(db, { connectionId: BOB.connectionId });

		// Each kept its own, under its own name.
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['hers.md']);
		expect(await pathsUnder(db, BOB.connectionId)).toEqual(['his.md']);
		expect(await pathsUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
		expect(await foldersUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
		expect(await opsUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
	});

	it('keeps a save that arrives for a removed note: the remote has the note, not the edit', async () => {
		const db = await connected();
		const sent = await pushed(db, 'sent.md');
		await createNote(db, { ...ada, title: 'Unsent' });

		await detachConnection(db, { connectionId: ADA.connectionId });

		// Not a delete of the user's, and never taken for one.
		expect(await deletedHere.has(db, sent)).toBe(false);
		// The editor that was open on it saves what it was holding — typed while
		// the server was being asked, or a save that had been failing.
		const saved = await saveNoteBody(db, sent.id, '# sent\n\nheld from before\n', {
			origin: sent.bodyOrigin ?? '',
			note: sent,
		});

		// As an unsent note of the source, in sight, and counted.
		expect(saved).toMatchObject({
			connectionId: ADA.connectionId,
			id: sent.id,
			body: '# sent\n\nheld from before\n',
			dirty: 1,
		});
		expect(saved.remoteId).toBeUndefined();
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['sent.md', 'unsent.md']);
		expect(countOf(await unsyncedIn(db, ADA.connectionId))).toBe(2);
		expect(await pathsUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
	});

	it('keeps a note an editor still holds text for, whatever its row says', async () => {
		const db = await connected();
		const failing = await pushed(db, 'failing.md');
		const sent = await pushed(db, 'sent.md');

		// Clean, linked, nothing queued: the row is not the whole of what the
		// user wrote, and the editors said so (`settleEditors`).
		await detachConnection(db, {
			connectionId: ADA.connectionId,
			holding: new Set([noteRef(failing)]),
		});

		expect(await db.notes.get([ADA.connectionId, failing.id])).toMatchObject({
			remoteId: failing.remoteId,
			dirty: 0,
		});
		expect(await db.notes.get([ADA.connectionId, sent.id])).toBeUndefined();
		// Kept for it: the source stays, with its row, for the save to land in.
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
		const saved = await saveNoteBody(db, failing.id, '# failing\n\nat last\n', {
			origin: failing.bodyOrigin ?? '',
			note: failing,
		});
		expect(saved).toMatchObject({ remoteId: failing.remoteId, dirty: 1 });
	});

	it('changes nothing when it did not happen', async () => {
		const db = await connected();
		const sent = await pushed(db, 'sent.md');

		expect(
			await detachConnection(db, { connectionId: ADA.connectionId, ifUnchangedSince: -1 })
		).toBe(false);

		expect(await getNote(db, sent.id, ada)).toBeDefined();
		expect(goneSources.recall(ADA.connectionId)).toBeUndefined();
	});

	it('does not take a note deleted before a reconnect for one deleted since', async () => {
		const db = await connected();
		const sent = await pushed(db, 'sent.md');
		await deleteNote(db, sent.id, ada);
		expect(await deletedHere.has(db, sent)).toBe(true);
		await detachConnection(db, { connectionId: ADA.connectionId });

		// The same connection again, and its first pull brings the note back:
		// another device restored it, or the delete never got there.
		await bindConnection(db, ADA);
		await db.notes.put({ ...sent, deletedLocally: 0, dirty: 0 });
		// A pull in some other tab deletes it again before the editor's save lands.
		await db.notes.delete([ADA.connectionId, sent.id]);

		// Not the note the user deleted before: that binding is over. Kept.
		expect(await deletedHere.has(db, sent)).toBe(false);
		const saved = await saveNoteBody(db, sent.id, '# sent\n\nafter the reconnect\n', {
			origin: sent.bodyOrigin ?? '',
			note: sent,
		});
		expect(saved).toMatchObject({ connectionId: ADA.connectionId, dirty: 1 });
	});

	it('is refused by the sync store from then on, as a source that has gone is', async () => {
		const db = await connected();
		await createNote(db, { ...ada, title: 'Unsent' });
		await detachConnection(db, { connectionId: ADA.connectionId });
		const store = createDexieSyncStore(db, ada);

		// A run that was at the network when the source was let go, landing now:
		// it would bring back what was just removed, and put a cursor on the row.
		await expect(
			store.applyPull({
				changes: [
					{
						kind: 'upsert-note',
						id: 'n1',
						path: 'back.md',
						content: 'x\n',
						remote: {
							remoteId: 'r:back',
							path: 'back.md',
							kind: 'file',
							version: 'v1',
							modifiedAt: '2026-01-01T00:00:00.000Z',
							size: 2,
						},
						syncedHash: 'hash',
					},
				],
				cursor: 'cursor-2',
			})
		).rejects.toThrow(UnboundConnectionError);

		expect((await db.syncState.get(ADA.connectionId))?.cursor).toBeUndefined();
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['unsent.md']);
	});

	it('is listed for what it is, with how much it holds', async () => {
		const db = await connected();
		await bindConnection(db, BOB);
		await createFolder(db, { ...ada, name: 'New' });
		await createNote(db, { ...ada, folderPath: 'New', title: 'One' });
		await createNote(db, { ...ada, title: 'Two' });
		await detachConnection(db, { connectionId: ADA.connectionId });

		expect(await connectedSources(db)).toEqual([
			{
				connectionId: ADA.connectionId,
				provider: 'dropbox',
				accountId: 'dbid:ada',
				displayName: 'ada@example.com',
				active: false,
				// The two notes. The notebook goes up with the note inside it.
				detached: { unsent: 2 },
			},
			{
				connectionId: BOB.connectionId,
				provider: 'dropbox',
				accountId: 'dbid:bob',
				// A live source says when it was bound, which is what puts the
				// tabs in the order the user made them. Ada's went with her
				// binding, which is why she has none here.
				boundAt: expect.any(Number) as number,
				active: true,
			},
		]);
		expect(countOf(await unsyncedIn(db, ADA.connectionId))).toBe(2);
	});
});

describe('discarding what a detached source holds', () => {
	const detachedWith = async (titles: readonly string[]) => {
		const db = await connected();
		await pushed(db, 'sent.md');
		const notes = await titles.reduce<Promise<NoteRecord[]>>(
			async (sofar, title) => [...(await sofar), await createNote(db, { ...ada, title })],
			Promise.resolve([])
		);
		await detachConnection(db, { connectionId: ADA.connectionId });
		return { db, notes };
	};

	it('takes everything, the source included, when all of it was shown', async () => {
		const { db, notes } = await detachedWith(['One', 'Two']);
		await createFolder(db, { ...ada, name: 'Empty' });

		const seen = await shownNow(db);
		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen,
		});

		expect(outcome).toBe('released');
		expect(await db.notes.count()).toBe(0);
		expect(await db.folders.count()).toBe(0);
		expect(await db.opQueue.count()).toBe(0);
		expect(await db.syncState.count()).toBe(0);
		expect(await db.prefs.get(ACTIVE_CONNECTION_KEY)).toBeUndefined();
		expect(notes).toHaveLength(2);
	});

	it('never reaches text the user was not shown: it is kept, and the source stays', async () => {
		const { db, notes } = await detachedWith(['One', 'Two']);
		const seen = await shownNow(db);
		// Another tab, after the list was put in front of the user.
		await createFolder(db, { ...ada, name: 'Late' });
		const late = await createNote(db, { ...ada, folderPath: 'Late', title: 'Typed since' });
		// And into a note that *was* on the list — the same note, by name, but
		// not as it was shown: a chapter the user never saw go on the list.
		await saveNoteBody(db, notes[0]!.id, '# One\n\nan hour of work\n', undefined, ada);

		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen,
		});

		expect(outcome).toBe('detached');
		expect(await pathsUnder(db, ADA.connectionId)).toEqual([late.path, notes[0]!.path].sort());
		expect((await db.notes.get([ADA.connectionId, notes[0]!.id]))?.body).toBe(
			'# One\n\nan hour of work\n'
		);
		expect(await db.notes.get([ADA.connectionId, notes[1]!.id])).toBeUndefined();
		expect(await foldersUnder(db, ADA.connectionId)).toEqual(['Late']);
		expect(await opsUnder(db, ADA.connectionId)).toEqual(
			expect.arrayContaining(['mkdir Late', `write ${late.path}`, `write ${notes[0]!.path}`])
		);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('keeps a notebook made, or a notebook delete queued, after the list was shown', async () => {
		const { db } = await detachedWith(['One']);
		const seen = await shownNow(db);
		await createFolder(db, { ...ada, name: 'Late' });

		expect(
			await releaseConnection(db, {
				connectionId: ADA.connectionId,
				unsynced: 'discard',
				seen,
			})
		).toBe('detached');
		expect(await foldersUnder(db, ADA.connectionId)).toEqual(['Late']);
		expect(await db.notes.count()).toBe(0);

		// Shown again, with the notebook on the list, and then a directory
		// deleted since — its `rmdir` was not shown either.
		const again = await shownNow(db);
		await db.folders.put({ ...ada, path: 'Gone', remoteId: 'f:gone', createdAt: 0 });
		await deleteFolder(db, 'Gone', ada);
		expect(
			await releaseConnection(db, {
				connectionId: ADA.connectionId,
				unsynced: 'discard',
				seen: again,
			})
		).toBe('detached');
		// The notebook that was shown stays too: nothing shown is discarded
		// while anything unshown keeps the source, rather than half of it.
		expect(await opsUnder(db, ADA.connectionId)).toEqual(['mkdir Late', 'rmdir Gone']);
		expect(await foldersUnder(db, ADA.connectionId)).toEqual(['Late']);
	});

	it('discards nothing at all when nothing was shown', async () => {
		const { db, notes } = await detachedWith(['One']);

		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen: NOTHING_SEEN,
		});

		expect(outcome).toBe('detached');
		expect(await db.notes.get([ADA.connectionId, notes[0]!.id])).toEqual(notes[0]);
	});

	it('refuses a source that has been connected again meanwhile', async () => {
		const { db, notes } = await detachedWith(['One']);
		const seen = await shownNow(db);
		// Another tab, while the question was open.
		await holdCredential(db, ADA.connectionId);
		await bindConnection(db, ADA);
		const state = await db.syncState.get(ADA.connectionId);

		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen,
		});

		// Live, and left alone: its rows are the remote's now, and taking them
		// with the credential would strand the connection on the server.
		expect(outcome).toBe('reconnected');
		expect(await db.notes.get([ADA.connectionId, notes[0]!.id])).toEqual(notes[0]);
		expect(await db.syncState.get(ADA.connectionId)).toEqual(state);
		expect(await credentialFor(db, ADA.connectionId)).toBeDefined();
	});

	it('leaves every other source exactly as it was', async () => {
		const { db, notes } = await detachedWith(['One']);
		await bindConnection(db, BOB);
		const his = await createNote(db, { connectionId: BOB.connectionId, title: 'His' });
		// Same id, other source: a `seen` that named it by id alone would reach it.
		await db.notes.add({ ...notes[0]!, connectionId: BOB.connectionId, path: 'copy.md' });

		await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen: await shownNow(db),
		});

		expect(await pathsUnder(db, BOB.connectionId)).toEqual(['copy.md', his.path].sort());
		expect(await db.syncState.get(BOB.connectionId)).toBeDefined();
		expect(await opsUnder(db, BOB.connectionId)).toEqual([`write ${his.path}`]);
	});
});

describe('connecting again after a source was detached', () => {
	/** Ada's source detached, holding one edited note that was pushed and one that never was. */
	const detached = async () => {
		const db = await connected();
		await pushed(db, 'sent.md');
		const edited = await pushed(db, 'Work/edited.md');
		await saveNoteBody(db, edited.id, '# edited\n\nmore\n', undefined, ada);
		const fresh = await createNote(db, { ...ada, title: 'Fresh' });
		await detachConnection(db, { connectionId: ADA.connectionId });
		const ops = await opsUnder(db, ADA.connectionId);
		return { db, edited, fresh, ops };
	};

	it('under the same connection id: live again where it stands, and unverified', async () => {
		const { db, edited, fresh, ops } = await detached();
		const clientId = (await db.syncState.get(ADA.connectionId))?.clientId;

		await bindConnection(db, ADA);

		const state = await db.syncState.get(ADA.connectionId);
		expect(state?.detached).toBeUndefined();
		// A kept row still names a file, so the remote is looked at before any scan.
		expect(state?.resumeUnverified).toBe(true);
		expect(state?.cursor).toBeUndefined();
		expect(state).toMatchObject({ displayName: 'ada@example.com', clientId });
		expect(await db.notes.get([ADA.connectionId, edited.id])).toMatchObject({
			remoteId: edited.remoteId,
			remoteVersion: 'v1',
			dirty: 1,
		});
		expect(await db.notes.get([ADA.connectionId, fresh.id])).toBeDefined();
		// What was queued is still queued, once: nothing is owed twice.
		expect(await opsUnder(db, ADA.connectionId)).toEqual(ops);
		expect(await activeConnectionId(db)).toBe(ADA.connectionId);
	});

	it('under the same id with nothing linked: nothing to verify', async () => {
		const db = await connected();
		const fresh = await createNote(db, { ...ada, title: 'Fresh' });
		// From before writers queued anything: kept, and owed a write all the same.
		await db.opQueue.clear();
		await detachConnection(db, { connectionId: ADA.connectionId });

		await bindConnection(db, ADA);

		expect((await db.syncState.get(ADA.connectionId))?.resumeUnverified).toBeUndefined();
		expect(await opsUnder(db, ADA.connectionId)).toEqual([`write ${fresh.path}`]);
	});

	it('under a new id for the same account: the rows go home, and the old source goes', async () => {
		const { db, edited, fresh, ops } = await detached();

		await bindConnection(db, { ...ADA, connectionId: 'c-ada-2' });

		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
		expect(await pathsUnder(db, ADA.connectionId)).toEqual([]);
		expect(await foldersUnder(db, ADA.connectionId)).toEqual([]);
		expect(await opsUnder(db, ADA.connectionId)).toEqual([]);
		expect(await db.notes.get(['c-ada-2', edited.id])).toMatchObject({
			remoteId: edited.remoteId,
			remoteVersion: 'v1',
			dirty: 1,
			path: 'Work/edited.md',
		});
		expect(await db.notes.get(['c-ada-2', fresh.id])).toBeDefined();
		expect(await foldersUnder(db, 'c-ada-2')).toEqual(['Work']);
		expect(await opsUnder(db, 'c-ada-2')).toEqual(ops);
		const state = await db.syncState.get('c-ada-2');
		expect(state?.resumeUnverified).toBe(true);
		expect(state?.detached).toBeUndefined();
		expect(await activeConnectionId(db)).toBe('c-ada-2');
	});

	it('into the same account already live under another id: its rows yield to the pulled ones', async () => {
		const db = await connected();
		const edited = await pushed(db, 'edited.md');
		await saveNoteBody(db, edited.id, '# edited\n\nmine, here\n', undefined, ada);
		const renamed = await pushed(db, 'renamed.md');
		await db.opQueue.add({
			...ada,
			op: 'move',
			noteId: renamed.id,
			path: 'renamed.md',
			targetPath: 'moved.md',
			attempts: 0,
			queuedAt: 0,
		});
		await db.notes.update([ADA.connectionId, renamed.id], { path: 'moved.md' });
		const doomed = await pushed(db, 'doomed.md');
		await deleteNote(db, doomed.id, ada);
		await detachConnection(db, { connectionId: ADA.connectionId });
		// The same account, connected again under a new id in another tab, which
		// has since pulled the same three files; this tab's bind lands after.
		const AGAIN = { ...ADA, connectionId: 'c-ada-2' };
		await db.syncState.put({ ...AGAIN, clientId: 'client', cursor: 'cursor-2' });
		// The same notes, as the pull under the new id left them: same id, same
		// file, a newer version.
		const later = async (note: NoteRecord, path: string): Promise<NoteRecord> => {
			const { source: _source, ...pulled } = note;
			const row: NoteRecord = {
				...pulled,
				connectionId: AGAIN.connectionId,
				path,
				body: `# ${path}\n\nchanged there\n`,
				dirty: 0,
				deletedLocally: 0,
				remoteVersion: 'v2',
			};
			await db.notes.put(row);
			return row;
		};
		const theirs = {
			edited: await later(edited, 'edited.md'),
			renamed: await later(renamed, 'renamed.md'),
			doomed: await later(doomed, 'doomed.md'),
		};

		await bindConnection(db, AGAIN);

		// One row per file. The pulled row is the file's, untouched.
		expect(await db.notes.get([AGAIN.connectionId, edited.id])).toEqual(theirs.edited);
		expect(await db.notes.get([AGAIN.connectionId, renamed.id])).toEqual(theirs.renamed);
		expect(await db.notes.get([AGAIN.connectionId, doomed.id])).toEqual(theirs.doomed);
		// The edit survives beside it, as a conflict copy: fresh id, no file,
		// owed a write; and an editor still open on it is pointed at the copy.
		const rows = await db.notes.where('connectionId').equals(AGAIN.connectionId).toArray();
		const copy = rows.find((note) => note.body === '# edited\n\nmine, here\n');
		expect(copy).toMatchObject({ dirty: 1, deletedLocally: 0 });
		expect(copy?.id).not.toBe(edited.id);
		expect(copy?.remoteId).toBeUndefined();
		expect(copy?.path).toMatch(/^edited \(conflict .*\)\.md$/);
		expect(movedRows.whereNow(edited)).toEqual([AGAIN.connectionId, copy?.id]);
		// The rename and the delete held no text, and are dropped in favour of
		// the file as it is; an editor on either lands on the pulled row.
		expect(rows).toHaveLength(4);
		expect(await opsUnder(db, AGAIN.connectionId)).toEqual([`write ${copy?.path ?? ''}`]);
		expect(movedRows.whereNow(renamed)).toEqual([AGAIN.connectionId, renamed.id]);
		expect(movedRows.whereNow(doomed)).toEqual([AGAIN.connectionId, doomed.id]);
		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
	});

	it('another account absorbs nothing: the detached source stays exactly as it is', async () => {
		const { db, ops } = await detached();
		const before = {
			notes: await db.notes.where('connectionId').equals(ADA.connectionId).toArray(),
			folders: await db.folders.where('connectionId').equals(ADA.connectionId).toArray(),
			state: await db.syncState.get(ADA.connectionId),
		};

		await bindConnection(db, BOB);

		expect(await db.notes.where('connectionId').equals(ADA.connectionId).toArray()).toEqual(
			before.notes
		);
		expect(await db.folders.where('connectionId').equals(ADA.connectionId).toArray()).toEqual(
			before.folders
		);
		expect(await db.syncState.get(ADA.connectionId)).toEqual(before.state);
		expect(await opsUnder(db, ADA.connectionId)).toEqual(ops);
		// Bob's source is new and empty, and nothing is owed to it.
		expect(await pathsUnder(db, BOB.connectionId)).toEqual([]);
		expect(await opsUnder(db, BOB.connectionId)).toEqual([]);
		expect((await db.syncState.get(BOB.connectionId))?.resumeUnverified).toBeUndefined();
		// Connecting is choosing: Bob's is in front, Ada's still listed behind it.
		expect(await activeConnectionId(db)).toBe(BOB.connectionId);
		expect((await connectedSources(db)).map((source) => source.connectionId)).toEqual([
			ADA.connectionId,
			BOB.connectionId,
		]);
	});

	it('nor does an account the server does not name', async () => {
		const { db } = await detached();

		await bindConnection(db, { connectionId: 'c-unnamed', provider: 'dropbox' });

		expect(await db.syncState.get(ADA.connectionId)).toMatchObject({
			detached: { reason: 'revoked' },
		});
		expect(await pathsUnder(db, 'c-unnamed')).toEqual([]);
	});
});

describe('a save that arrives after its source has gone', () => {
	it('is kept under its own source, brought back detached, never the pile or another account', async () => {
		const db = await connected();
		await bindConnection(db, BOB);
		const shown = await pushed(db, 'Work/plan.md');
		// Another tab lets Ada's source go, with nothing unsent: every row and
		// the source's own row are gone. This tab was told nothing — its editor
		// still holds a keystroke, and `deletedHere` knows of no delete.
		await db.notes.where('connectionId').equals(ADA.connectionId).delete();
		await db.folders.where('connectionId').equals(ADA.connectionId).delete();
		await db.syncState.delete(ADA.connectionId);
		expect(await activeConnectionId(db)).toBe(BOB.connectionId);

		const saved = await saveNoteBody(db, shown.id, '# plan\n\none more line\n', {
			origin: shown.bodyOrigin ?? '',
			note: shown,
		});

		expect(saved.connectionId).toBe(ADA.connectionId);
		expect(saved).toMatchObject({ dirty: 1, body: '# plan\n\none more line\n' });
		expect(saved.remoteId).toBeUndefined();
		expect(await db.syncState.get(ADA.connectionId)).toMatchObject({
			connectionId: ADA.connectionId,
			detached: { reason: 'interrupted' },
		});
		expect(await pathsUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
		expect(await pathsUnder(db, BOB.connectionId)).toEqual([]);
		// Visible: listed, and not sent anywhere.
		expect(await connectedSources(db)).toContainEqual({
			connectionId: ADA.connectionId,
			active: false,
			detached: { unsent: 1 },
		});
		// Bob's source is still the one showing, and is live.
		expect(await activeConnectionId(db)).toBe(BOB.connectionId);
	});

	it('is made again as the source was, where this tab let it go, and goes home with it', async () => {
		const db = await connected();
		const shown = await pushed(db, 'plan.md');
		// This tab's own disconnect, with nothing unsent: the whole source went,
		// and this tab remembers whose it was.
		await detachConnection(db, { connectionId: ADA.connectionId });
		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();

		const saved = await saveNoteBody(db, shown.id, '# plan\n\nlate\n', {
			origin: shown.bodyOrigin ?? '',
			note: shown,
		});

		expect(saved.connectionId).toBe(ADA.connectionId);
		expect(await db.syncState.get(ADA.connectionId)).toMatchObject({
			provider: 'dropbox',
			accountId: 'dbid:ada',
			displayName: 'ada@example.com',
			detached: { reason: 'interrupted' },
		});
		expect((await connectedSources(db)).map((source) => source.displayName)).toEqual([
			'ada@example.com',
		]);
		// So the same account, back under a new id, takes the note home.
		await bindConnection(db, { ...ADA, connectionId: 'c-ada-2' });
		expect((await db.notes.get(['c-ada-2', shown.id]))?.body).toBe('# plan\n\nlate\n');
		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
	});

	it('never takes the screen from the device’s own notes', async () => {
		const db = await connected();
		const sent = await pushed(db, 'sent.md');
		await detachConnection(db, { connectionId: ADA.connectionId });
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		// Nothing connected, so the user writes on the device itself.
		const own = await createNote(db, { title: 'Written with nothing connected' });
		expect(own.connectionId).toBe(LOCAL_CONNECTION_ID);

		// A tab that never heard of the detach saves into the removed note.
		await saveNoteBody(db, sent.id, '# sent\n\nlate\n', {
			origin: sent.bodyOrigin ?? '',
			note: sent,
		});

		// The source is back, detached, and the device's notes are still what
		// is showing — a keystroke into an old note does not hide the new one.
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect((await listNotes(db)).map((note) => note.title)).toEqual([
			'Written with nothing connected',
		]);
		// Both are on offer, and either can be shown.
		expect(
			(await connectedSources(db)).map((source) => [source.connectionId, source.active])
		).toEqual([
			[ADA.connectionId, false],
			[LOCAL_CONNECTION_ID, true],
		]);
		expect(await showConnection(db, ADA.connectionId)).toBe(true);
		expect((await listNotes(db)).map((note) => note.path)).toEqual(['sent.md']);
		expect(await showConnection(db, LOCAL_CONNECTION_ID)).toBe(true);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('goes into the source as it stands when that is still here, detached', async () => {
		const db = await connected();
		const shown = await pushed(db, 'plan.md');
		await createNote(db, { ...ada, title: 'Unsent' });
		// Another tab's detach: the clean note removed, the source kept.
		await detachConnection(db, { connectionId: ADA.connectionId });
		const state = await db.syncState.get(ADA.connectionId);

		const saved = await saveNoteBody(db, shown.id, '# plan\n\nlate\n', {
			origin: shown.bodyOrigin ?? '',
			note: shown,
		});

		expect(saved.connectionId).toBe(ADA.connectionId);
		// Not re-made, and not marked `interrupted` over what it already says.
		expect(await db.syncState.get(ADA.connectionId)).toEqual(state);
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['plan.md', 'unsent.md']);
	});
});
