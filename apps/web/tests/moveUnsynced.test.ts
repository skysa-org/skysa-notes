import { parentPath, ROOT } from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	bindConnection,
	detachConnection,
	moveUnsyncedTo,
	showConnection,
} from '../src/store/connection.js';
import {
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	noteRef,
	type NotesDatabase,
} from '../src/store/db.js';
import { createFolder, deleteFolder, renameFolder } from '../src/store/folders.js';
import { movedRows } from '../src/store/movedRows.js';
import { foldPath } from '../src/store/naming.js';
import {
	createNote,
	deleteNote,
	importNoteFile,
	noteFile,
	saveNoteBody,
	undeleteNote,
} from '../src/store/notes.js';
import { queueMove, queueWrite } from '../src/store/queue.js';
import { type Seen, seenIn, unsyncedIn } from '../src/store/unsynced.js';
import { noteById, updateNote } from './noteRows.js';

/**
 * Taking what one source never sent into another one (docs/PLAN.md §10).
 *
 * The only operation in the app that carries a user's writing from one storage
 * account into another, so what it takes, what it leaves and what it says about
 * either is the whole subject here. It moves what could be anywhere — the notes
 * the remote never had in full, and the notebooks around them — as new writing;
 * it leaves everything that is about the account being left; and it can reach
 * only what the user was shown (`seen`).
 */

const ADA = { connectionId: 'c-ada', provider: 'dropbox', accountId: 'dbid:ada' } as const;
const BOB = { connectionId: 'c-bob', provider: 'onedrive', accountId: 'ms:bob' } as const;
const ada = { connectionId: ADA.connectionId };
const bob = { connectionId: BOB.connectionId };

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`move-${crypto.randomUUID()}`);
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

/** Bob's source live, Ada's still connected: the caller decides when it goes. */
const twoSources = async () => {
	const db = freshDatabase();
	await bindConnection(db, BOB);
	await holdCredential(db, BOB.connectionId);
	await bindConnection(db, ADA);
	await holdCredential(db, ADA.connectionId);
	await db.syncState.update(ADA.connectionId, { cursor: 'cursor-1', rootId: 'root-1' });
	return db;
};

/** A note as a pull leaves it: clean, with a file, nothing queued. */
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

/** Ada's source, let go, holding whatever `hold` put in it. */
const detached = async (db: NotesDatabase) => {
	expect(await detachConnection(db, { connectionId: ADA.connectionId })).toBe(true);
	return seenIn(await unsyncedIn(db, ADA.connectionId));
};

const pathsUnder = async (db: NotesDatabase, connectionId: string) =>
	(await db.notes.where('connectionId').equals(connectionId).toArray())
		.filter((note) => note.deletedLocally === 0)
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

const moving = (db: NotesDatabase, seen: Seen) =>
	moveUnsyncedTo(db, { connectionId: ADA.connectionId, target: BOB.connectionId, seen });

describe('moving what a source never sent into another source', () => {
	it('takes the notes as new writing, and leaves the source behind for good', async () => {
		const db = await twoSources();
		// Edited since it was pushed: the file is on Ada's remote in an older
		// version, and the edit is nowhere.
		const edited = await pushed(db, 'edited.md');
		await updateNote(db, edited.id, { syncedHash: 'hash-1', bodyOrigin: 'origin-1' });
		await saveNoteBody(db, edited.id, '# edited\n\nmore\n', undefined, ada);
		// Never pushed at all.
		const fresh = await createNote(db, { ...ada, title: 'Fresh', body: '# Fresh\n\nnew\n' });
		await updateNote(db, fresh.id, { editorMode: 'raw' });
		const before = await noteById(db, edited.id);
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		const landed = await noteById(db, edited.id);
		expect(landed?.connectionId).toBe(BOB.connectionId);
		// Bob's storage has never heard of it: no file, no version, no agreement
		// about either, and owed a write.
		expect(landed?.remoteId).toBeUndefined();
		expect(landed?.remoteVersion).toBeUndefined();
		expect(landed?.syncedHash).toBeUndefined();
		expect(landed?.dirty).toBe(1);
		// The bytes it had, pinned before anything else changed, so the engine
		// sends the file the user wrote rather than one re-serialized under it.
		expect(landed?.source).toBe(noteFile(before!));
		expect(landed?.createdAt).toBe(before?.createdAt);
		expect(landed?.bodyOrigin).toBe(before?.bodyOrigin);
		expect((await noteById(db, fresh.id))?.editorMode).toBe('raw');
		expect(await opsUnder(db, BOB.connectionId)).toEqual(['write edited.md', 'write fresh.md']);
		// And Ada's source is gone entirely: rows, ops, row and credential.
		expect(await db.notes.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await db.opQueue.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
		expect(await db.credentials.get(ADA.connectionId)).toBeUndefined();
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
	});

	it('carries the notebooks the notes are in, and asks Bob only for the ones he lacks', async () => {
		const db = await twoSources();
		// Bob already has a notebook of this name, in his own spelling.
		await db.folders.put({ ...bob, path: 'Work', remoteId: 'f:bob:work', createdAt: 0 });
		// Ada's: one the remote never made, and one it did, each holding an
		// unsent note.
		await createFolder(db, { ...ada, name: 'work' });
		await createNote(db, { ...ada, folderPath: 'work', title: 'Plan' });
		await db.folders.put({ ...ada, path: 'Sent', remoteId: 'f:ada:sent', createdAt: 0 });
		await createNote(db, { ...ada, folderPath: 'Sent', title: 'Draft' });
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		// One notebook, in Bob's spelling, with the note in it.
		expect(await foldersUnder(db, BOB.connectionId)).toEqual(['Sent', 'Work']);
		expect(await pathsUnder(db, BOB.connectionId)).toEqual(['Sent/draft.md', 'Work/plan.md']);
		// Bob already has `Work`; `Sent` is a directory he has never heard of.
		const sent = await db.folders.get([BOB.connectionId, 'Sent']);
		expect(sent?.remoteId).toBeUndefined();
		expect(await opsUnder(db, BOB.connectionId)).toEqual([
			'mkdir Sent',
			'write Sent/draft.md',
			'write Work/plan.md',
		]);
	});

	it('leaves an unsent rename and an unsent delete where they belong, with the files', async () => {
		const db = await twoSources();
		// Clean and pushed, with only a move queued: the file is safe on Ada's
		// remote under its old name, and means nothing in Bob's.
		await pushed(db, 'Old/moved.md');
		await renameFolder(db, 'Old', 'Renamed', ada);
		// Deleted here, the delete never sent: Ada's file stays as it is, and
		// there is no such file in Bob's account to delete.
		const doomed = await pushed(db, 'doomed.md');
		await deleteNote(db, doomed.id, ada);
		// A notebook removed here, its directory still owed its removal.
		await createFolder(db, { ...ada, name: 'Emptied' });
		await db.folders.update([ADA.connectionId, 'Emptied'], { remoteId: 'f:emptied' });
		await db.opQueue.where('path').equals('Emptied').delete();
		await deleteFolder(db, 'Emptied', ada);
		const kept = await createNote(db, { ...ada, title: 'Kept' });
		const seen = await detached(db);
		expect((await unsyncedIn(db, ADA.connectionId)).renames).toHaveLength(1);

		expect(await moving(db, seen)).toBe('released');

		// Only the note whose text is nowhere else. The notebook the rename
		// brought into being goes too — a notebook no remote has ever heard of is
		// structure the user made and that exists nowhere else either — but the
		// note that would have been in it stays, under its old name, in Ada's.
		expect(await pathsUnder(db, BOB.connectionId)).toEqual(['kept.md']);
		expect((await noteById(db, kept.id))?.connectionId).toBe(BOB.connectionId);
		expect(await noteById(db, doomed.id)).toBeUndefined();
		expect(await opsUnder(db, BOB.connectionId)).toEqual(['mkdir Renamed', 'write kept.md']);
		expect(await db.notes.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await db.opQueue.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
	});

	it('points an undo of a dropped delete at the source the note went to', async () => {
		const db = await twoSources();
		const doomed = await pushed(db, 'doomed.md');
		await saveNoteBody(db, doomed.id, '# doomed\n\nworth keeping\n', undefined, ada);
		const held = (await noteById(db, doomed.id))!;
		await deleteNote(db, doomed.id, ada);
		// Something for the move to actually be about: a move whose list holds
		// nothing movable is refused rather than carried out (`nothing-to-move`).
		await createNote(db, { ...ada, title: 'Kept' });
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');
		expect(movedRows.whereNow(held)?.[0]).toBe(BOB.connectionId);

		// The undo window outlives the source: the note comes back in Bob's,
		// which is the only place the device still has for it.
		const back = await undeleteNote(db, held);

		expect(back.connectionId).toBe(BOB.connectionId);
		expect(back.body).toBe('# doomed\n\nworth keeping\n');
		expect(back.remoteId).toBeUndefined();
	});

	it('gives a newcomer a fresh id where the target already holds that one', async () => {
		const db = await twoSources();
		const mine = await createNote(db, { ...ada, title: 'Mine', body: '# Mine\n\nada\n' });
		// The same id in Bob's, as happens when one folder is copied into two
		// accounts: the id travels in the file.
		await importNoteFile(db, {
			...bob,
			path: 'theirs.md',
			source: `---\nid: ${mine.id}\n---\n\n# Theirs\n`,
			remoteId: 'r:bob:theirs',
		});
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		const rows = await db.notes.where('connectionId').equals(BOB.connectionId).toArray();
		expect(rows).toHaveLength(2);
		// Bob's own row keeps its id and its file; the newcomer is given a fresh
		// one and is otherwise the note it was.
		expect((await db.notes.get([BOB.connectionId, mine.id]))?.path).toBe('theirs.md');
		const newcomer = rows.find((note) => note.path === 'mine.md');
		expect(newcomer?.id).not.toBe(mine.id);
		expect(newcomer?.body).toBe('# Mine\n\nada\n');
		expect(await opsUnder(db, BOB.connectionId)).toEqual(['write mine.md']);
	});

	it('finds a free name where the target has that file already, compared as a provider would', async () => {
		const db = await twoSources();
		await db.folders.put({ ...bob, path: 'Work', remoteId: 'f:bob:work', createdAt: 0 });
		await pushed(db, 'Work/plan.md', BOB.connectionId);
		await createFolder(db, { ...ada, name: 'work' });
		const mine = await createNote(db, { ...ada, folderPath: 'work', title: 'PLAN' });
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		const landed = await noteById(db, mine.id);
		// One directory on every provider, and two files in it.
		expect(parentPath(landed?.path ?? '')).toBe('Work');
		expect(foldPath(landed?.path ?? '')).not.toBe('work/plan.md');
		expect(await pathsUnder(db, BOB.connectionId)).toHaveLength(2);
	});

	it('keeps a note written into since the list was made, and the source around it', async () => {
		const db = await twoSources();
		const listed = await createNote(db, { ...ada, title: 'Listed' });
		const seen = await detached(db);
		// Another tab, while the question was open: a chapter into a listed note,
		// and a note the list never had.
		await saveNoteBody(db, listed.id, '# Listed\n\nan hour of work\n', undefined, ada);
		const late = await createNote(db, { ...ada, title: 'Late' });

		expect(await moving(db, seen)).toBe('detached');

		// Neither moved, and neither let go: the user answered about a list that
		// did not stand for either of them.
		expect((await noteById(db, listed.id))?.connectionId).toBe(ADA.connectionId);
		expect((await noteById(db, listed.id))?.body).toBe('# Listed\n\nan hour of work\n');
		expect((await noteById(db, late.id))?.connectionId).toBe(ADA.connectionId);
		expect(await db.notes.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('moves what was shown and keeps what was not, where the source holds both', async () => {
		const db = await twoSources();
		const shown = await createNote(db, { ...ada, title: 'Shown' });
		const seen = await detached(db);
		const late = await createNote(db, { ...ada, title: 'Late', body: '# Late\n\ntyped\n' });

		expect(await moving(db, seen)).toBe('detached');

		expect((await noteById(db, shown.id))?.connectionId).toBe(BOB.connectionId);
		expect((await noteById(db, late.id))?.connectionId).toBe(ADA.connectionId);
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['late.md']);
		expect(await opsUnder(db, BOB.connectionId)).toEqual(['write shown.md']);
		// The one left still owes Ada's remote its write, for when it comes back.
		expect(await opsUnder(db, ADA.connectionId)).toEqual(['write late.md']);
	});

	it('leaves every other source exactly as it was', async () => {
		const db = await twoSources();
		const theirs = await createNote(db, { ...bob, title: 'Theirs', body: '# Theirs\n' });
		await updateNote(db, theirs.id, { remoteId: 'r:bob:theirs', dirty: 0 });
		await db.opQueue.where('noteId').equals(theirs.id).delete();
		// A third source, which is nobody's business here.
		await bindConnection(db, { connectionId: 'c-third', provider: 'gdrive', accountId: 'g:1' });
		await holdCredential(db, 'c-third');
		const third = await createNote(db, {
			connectionId: 'c-third',
			title: 'Third',
			body: '# Third\n',
		});
		await showConnection(db, ADA.connectionId);
		await createNote(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		expect((await noteById(db, theirs.id))?.remoteId).toBe('r:bob:theirs');
		expect((await noteById(db, theirs.id))?.dirty).toBe(0);
		expect((await noteById(db, third.id))?.connectionId).toBe('c-third');
		expect(await opsUnder(db, 'c-third')).toEqual(['write third.md']);
		expect(await db.credentials.get('c-third')).toBeDefined();
		expect((await db.syncState.get('c-third'))?.detached).toBeUndefined();
	});

	it('drops what the source owed its own remote, and owes Bob a write instead', async () => {
		const db = await twoSources();
		// Clean, pushed, and still owed a write: the op is addressed to Ada's
		// file, which Bob's account does not have.
		const owed = await pushed(db, 'owed.md');
		await queueWrite(db, owed);
		const seen = await detached(db);
		const wasQueued = await db.opQueue
			.where('connectionId')
			.equals(ADA.connectionId)
			.primaryKeys();

		expect(await moving(db, seen)).toBe('released');

		const ops = await db.opQueue.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0]?.connectionId).toBe(BOB.connectionId);
		// A fresh op, not the old one re-pointed at another account.
		expect(wasQueued).not.toContain(ops[0]?.seq);
	});

	it('refuses a list with nothing in it that a move is for, rather than discarding it', async () => {
		const db = await twoSources();
		// Everything unsent here is about a file only Ada's account has: a rename
		// it never heard of, and a delete it can never be told about now. There is
		// nothing to carry, so "Move" would be a discard of both under a button
		// that says otherwise.
		const renamed = await pushed(db, 'renamed.md');
		await updateNote(db, renamed.id, { path: 'moved.md' });
		await queueMove(db, (await noteById(db, renamed.id))!, 'renamed.md');
		const doomed = await pushed(db, 'doomed.md');
		await deleteNote(db, doomed.id, ada);
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('nothing-to-move');

		// Nothing touched, on either side: the source is still here holding both.
		expect(await db.notes.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
		expect((await noteById(db, renamed.id))?.path).toBe('moved.md');
		expect((await noteById(db, doomed.id))?.deletedLocally).toBe(1);
	});

	it('refuses to move a source whose files have not been checked against its remote', async () => {
		const db = await twoSources();
		// A whole library, pushed and clean, resumed from an earlier bind. Until
		// `verifyResume` has looked for the files, "clean, with a remote id" is a
		// memory and every row reads as unsent (`Unsynced.unverified`) — and a
		// move made on that would copy the lot into a stranger's account.
		await pushed(db, 'one.md');
		await pushed(db, 'two.md');
		await db.syncState.update(ADA.connectionId, { resumeUnverified: true });
		const seen = await detached(db);
		expect((await unsyncedIn(db, ADA.connectionId)).unverified).toBe(true);

		expect(await moving(db, seen)).toBe('unverified');

		expect(await db.notes.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['one.md', 'two.md']);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('keeps a note an editor still holds text for, rather than moving half of it', async () => {
		const db = await twoSources();
		const going = await createNote(db, { ...ada, title: 'Going' });
		const held = await createNote(db, { ...ada, title: 'Held', body: '# Held\n\nrow\n' });
		const seen = await detached(db);

		// A save of `held` that the store would not take, found by the settle
		// immediately before this: the row is not the whole of what was written.
		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen,
				holding: new Set([noteRef(held)]),
			})
		).toBe('holding');

		expect((await noteById(db, going.id))?.connectionId).toBe(BOB.connectionId);
		// Left where its editor can still write into it, under a source that stays.
		expect((await noteById(db, held.id))?.connectionId).toBe(ADA.connectionId);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('undoing a delete after the move never writes over the target’s own note of that id', async () => {
		const db = await twoSources();
		const doomed = await pushed(db, 'doomed.md');
		await saveNoteBody(db, doomed.id, '# doomed\n\nworth keeping\n', undefined, ada);
		const shown = (await noteById(db, doomed.id))!;
		await deleteNote(db, doomed.id, ada);
		// Bob's account holds a note of the same id — one folder copied into two,
		// the id travelling in the file — and it has never been pushed, so its
		// text is on no remote anywhere.
		const theirs = await importNoteFile(db, {
			...bob,
			path: 'theirs.md',
			source: `---\nid: ${doomed.id}\n---\n\n# Theirs\n\nbob wrote this\n`,
		});
		await updateNote(db, theirs.id, { dirty: 1 });
		await createNote(db, { ...ada, title: 'Kept' });
		const seen = await detached(db);
		expect(await moving(db, seen)).toBe('released');

		const back = await undeleteNote(db, shown);

		// The undo follows the tombstone into Bob's account, which is the only
		// place the device still has for it — and under a fresh id, because the
		// one it had is Bob's own note's.
		expect(back.connectionId).toBe(BOB.connectionId);
		expect(back.id).not.toBe(doomed.id);
		// Exactly the row the move said it became, id and all: the forward has
		// two halves and an editor open on the note follows both of them.
		expect(back.id).toBe(movedRows.whereNow(shown)?.[1]);
		expect(back.body).toBe('# doomed\n\nworth keeping\n');
		expect((await db.notes.get([BOB.connectionId, doomed.id]))?.body).toBe(
			'\n# Theirs\n\nbob wrote this\n'
		);
	});

	it('nor over one the target has pushed, which an undo would unlink from its file', async () => {
		const db = await twoSources();
		const doomed = await pushed(db, 'doomed.md');
		await saveNoteBody(db, doomed.id, '# doomed\n\nworth keeping\n', undefined, ada);
		const shown = (await noteById(db, doomed.id))!;
		await deleteNote(db, doomed.id, ada);
		await importNoteFile(db, {
			...bob,
			path: 'theirs.md',
			source: `---\nid: ${doomed.id}\n---\n\n# Theirs\n`,
			remoteId: 'r:bob:theirs',
			remoteVersion: 'v1',
		});
		await createNote(db, { ...ada, title: 'Kept' });
		const seen = await detached(db);
		expect(await moving(db, seen)).toBe('released');

		const back = await undeleteNote(db, shown);

		expect(back.id).not.toBe(doomed.id);
		expect(back.id).toBe(movedRows.whereNow(shown)?.[1]);
		const held = await db.notes.get([BOB.connectionId, doomed.id]);
		expect(held?.path).toBe('theirs.md');
		expect(held?.remoteId).toBe('r:bob:theirs');
		expect(held?.deletedLocally).toBe(0);
	});

	it('refuses a target that is not a connected source, and touches nothing', async () => {
		const db = await twoSources();
		const mine = await createNote(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);
		await detachConnection(db, { connectionId: BOB.connectionId });

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen,
			})
		).toBe('no-target');
		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: LOCAL_CONNECTION_ID,
				seen,
			})
		).toBe('no-target');

		expect((await noteById(db, mine.id))?.connectionId).toBe(ADA.connectionId);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('refuses a source another tab has connected again, credential and all', async () => {
		const db = await twoSources();
		const mine = await createNote(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);
		await holdCredential(db, ADA.connectionId);
		await bindConnection(db, ADA);

		expect(await moving(db, seen)).toBe('reconnected');

		expect((await noteById(db, mine.id))?.connectionId).toBe(ADA.connectionId);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeUndefined();
		expect(await db.credentials.get(ADA.connectionId)).toBeDefined();
	});

	it('says a source another tab let go of first is released, and moves nothing', async () => {
		const db = await twoSources();
		await createNote(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);
		await db.notes.where('connectionId').equals(ADA.connectionId).delete();
		await db.syncState.delete(ADA.connectionId);

		expect(await moving(db, seen)).toBe('released');
		expect(await db.notes.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
	});
});
