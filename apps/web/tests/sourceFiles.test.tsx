import { NotFoundError } from '@skysa/core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { MoveUnsent } from '../src/components/MoveUnsent.js';
import {
	abandonImport,
	bindConnection,
	type BindInput,
	type ConnectedSource,
	detachConnection,
	finishImport,
	moveUnsyncedTo,
	releaseConnection,
	verifyResume,
} from '../src/store/connection.js';
import {
	createDatabase,
	type FileRecord,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
} from '../src/store/db.js';
import { addAttachment } from '../src/store/files.js';
import { renameFolder } from '../src/store/folders.js';
import { createNote, importNoteFile, moveNote, saveNoteBody } from '../src/store/notes.js';
import { queueUpload } from '../src/store/queue.js';
import { movable, seenIn, unsyncedIn } from '../src/store/unsynced.js';
import { updateNote } from './noteRows.js';

/**
 * Files across sources (#187): what connecting, letting go, moving and
 * cutting loose do with the files beside the notes (docs/ARCHITECTURE.md §7,
 * "Files across sources"). A file goes with the notes it goes with. Where the
 * target's remote has never heard of it, it is pending there with its bytes;
 * where this device holds no bytes of it, it cannot be sent, and stays where
 * it is.
 */

const ADA = { connectionId: 'c-ada', provider: 'dropbox', accountId: 'dbid:ada' } as const;
/** Ada's account again, under the id the server gives it on connecting again. */
const ADA_AGAIN = { ...ADA, connectionId: 'c-ada-2' } as const;
const BOB = { connectionId: 'c-bob', provider: 'onedrive', accountId: 'ms:bob' } as const;
const ada = { connectionId: ADA.connectionId };

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`source-files-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

/** Bound, and its first import through: an ordinary source. */
const connected = async (db: NotesDatabase, source: BindInput) => {
	await bindConnection(db, source);
	await finishImport(db, source.connectionId);
};

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
const textOf = (buffer: ArrayBuffer | undefined): string | undefined =>
	buffer === undefined ? undefined : new TextDecoder().decode(buffer);

/** A file added here and not uploaded: its bytes held, its upload queued. */
const pendingFile = async (db: NotesDatabase, connectionId: string, path: string, text: string) => {
	const file: FileRecord = { connectionId, id: `p-${path}`, path, size: text.length };
	await db.files.put(file);
	await db.fileBytes.put({
		connectionId,
		id: file.id,
		bytes: bytesOf(text),
		pinned: 1,
		lastUsedAt: 0,
	});
	await queueUpload(db, file);
	return file;
};

/** A file the remote has, with its bytes cached here where `text` is given. */
const boundFile = async (
	db: NotesDatabase,
	connectionId: string,
	path: string,
	text?: string,
	size = text?.length ?? 5
) => {
	const file: FileRecord = {
		connectionId,
		id: `b-${path}`,
		path,
		remoteId: `r-${path}`,
		remoteVersion: 'v1',
		size,
	};
	await db.files.put(file);
	if (text !== undefined) {
		await db.fileBytes.put({
			connectionId,
			id: file.id,
			bytes: bytesOf(text),
			version: 'v1',
			pinned: 0,
			lastUsedAt: 0,
		});
	}
	return file;
};

const filesOf = (db: NotesDatabase, connectionId: string) =>
	db.files.where('connectionId').equals(connectionId).sortBy('path');

const heldText = async (db: NotesDatabase, connectionId: string, id: string) =>
	textOf((await db.fileBytes.get([connectionId, id]))?.bytes);

/** The queue as the engine would read it, without the bookkeeping. */
const opsOf = async (db: NotesDatabase, connectionId: string) =>
	(await db.opQueue.where('connectionId').equals(connectionId).sortBy('seq')).map((op) => ({
		op: op.op,
		path: op.path,
		...(op.fileId === undefined ? {} : { fileId: op.fileId }),
	}));

const uploadsOf = async (db: NotesDatabase, connectionId: string) =>
	(await opsOf(db, connectionId)).filter((op) => op.op === 'upload');

/** Whether every upload in the queue comes ahead of every write. */
const filesFirst = async (db: NotesDatabase, connectionId: string) => {
	const ops = (await opsOf(db, connectionId)).map((op) => op.op);
	return ops.lastIndexOf('upload') < ops.indexOf('write');
};

/** A note nothing has sent, so a detach keeps it and the source with it. */
const unsentNote = (db: NotesDatabase, connectionId: string, body: string, folderPath = 'Work') =>
	createNote(db, { connectionId, folderPath, title: 'One', body });

describe("connecting a source takes the device's own files", () => {
	const pile = async () => {
		const db = freshDatabase();
		const note = await unsentNote(db, LOCAL_CONNECTION_ID, '# One\n');
		const added = await addAttachment(db, {
			connectionId: LOCAL_CONNECTION_ID,
			noteId: note.id,
			name: 'a.png',
			bytes: bytesOf('a'),
		});
		await saveNoteBody(db, note.id, `# One\n\n${added.markdown}\n`, undefined, {
			connectionId: LOCAL_CONNECTION_ID,
		});
		return { db, note, added };
	};

	it('copies them into the first source, owed ahead of the notes, and lets the pile go once the import is through', async () => {
		const { db, added } = await pile();

		await bindConnection(db, ADA);

		expect(await filesOf(db, ADA.connectionId)).toEqual([
			{ connectionId: ADA.connectionId, id: added.fileId, path: added.path, size: 1 },
		]);
		expect(await heldText(db, ADA.connectionId, added.fileId)).toBe('a');
		expect(await uploadsOf(db, ADA.connectionId)).toEqual([
			{ op: 'upload', path: added.path, fileId: added.fileId },
		]);
		expect(await filesFirst(db, ADA.connectionId)).toBe(true);
		// Kept, for a cancel to go back to.
		expect(await filesOf(db, LOCAL_CONNECTION_ID)).toHaveLength(1);

		await finishImport(db, ADA.connectionId);

		expect(await filesOf(db, LOCAL_CONNECTION_ID)).toEqual([]);
		expect(await db.fileBytes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(
			0
		);
		expect(await filesOf(db, ADA.connectionId)).toHaveLength(1);
	});

	it('gives them up with an import cancelled, and leaves the pile as it was', async () => {
		const { db, added } = await pile();
		await bindConnection(db, ADA);

		expect(await abandonImport(db, ADA.connectionId)).toBe('abandoned');

		expect(await filesOf(db, ADA.connectionId)).toEqual([]);
		expect(await db.fileBytes.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await heldText(db, LOCAL_CONNECTION_ID, added.fileId)).toBe('a');
	});

	it('carries a file a pile note took after the bind with the note', async () => {
		const { db, note } = await pile();
		await bindConnection(db, ADA);
		// An editor in another tab, landing a save the import's hold did not stop.
		const later = await addAttachment(db, {
			connectionId: LOCAL_CONNECTION_ID,
			noteId: note.id,
			name: 'b.png',
			bytes: bytesOf('bb'),
		});
		await saveNoteBody(db, note.id, `# One\n\n${later.markdown}\n`, undefined, {
			connectionId: LOCAL_CONNECTION_ID,
		});
		await updateNote(db, note.id, { updatedAt: Date.now() + 60_000 });

		await finishImport(db, ADA.connectionId);

		expect((await filesOf(db, ADA.connectionId)).map((file) => file.path)).toContain(
			later.path
		);
		expect(await heldText(db, ADA.connectionId, later.fileId)).toBe('bb');
		expect(await uploadsOf(db, ADA.connectionId)).toContainEqual({
			op: 'upload',
			path: later.path,
			fileId: later.fileId,
		});
	});

	it('takes the file a source has at the name and size for the same one, and puts another beside it', async () => {
		const db = freshDatabase();
		await connected(db, ADA);
		const note = await unsentNote(db, LOCAL_CONNECTION_ID, '# One\n');
		const attach = (name: string, text: string) =>
			addAttachment(db, {
				connectionId: LOCAL_CONNECTION_ID,
				noteId: note.id,
				name,
				bytes: bytesOf(text),
			});
		const same = await attach('a.png', 'a');
		const other = await attach('b.png', 'b');
		const theirs = await boundFile(db, ADA.connectionId, same.path, undefined, 1);
		const differs = await boundFile(db, ADA.connectionId, other.path, undefined, 9);

		await bindConnection(db, ADA);

		const files = await filesOf(db, ADA.connectionId);
		expect(files.filter((file) => file.path === same.path)).toEqual([theirs]);
		expect(files.filter((file) => file.path === other.path)).toEqual([differs]);
		const beside = files.filter((file) => file.remoteId === undefined);
		expect(beside.map((file) => file.path)).toEqual([
			expect.stringMatching(/^Work\/b-[0-9a-f]{8} \(conflict .+\)\.png$/),
		]);
		expect(await heldText(db, ADA.connectionId, beside[0]!.id)).toBe('b');
		expect((await uploadsOf(db, ADA.connectionId)).map((op) => op.fileId)).toEqual([
			beside[0]!.id,
		]);
	});
});

describe('a detached source', () => {
	/** Ada, detached, holding an unsent note that links a pending file and a cached one. */
	const detached = async () => {
		const db = freshDatabase();
		await connected(db, ADA);
		await unsentNote(db, ADA.connectionId, '![a](a.png) ![b](b.png)\n');
		const pending = await pendingFile(db, ADA.connectionId, 'Work/a.png', 'a');
		const cached = await boundFile(db, ADA.connectionId, 'Work/b.png', 'bb');
		const unlinked = await boundFile(db, ADA.connectionId, 'Work/z.png', 'zz');
		expect(await detachConnection(db, { connectionId: ADA.connectionId })).toBe(true);
		return { db, pending, cached, unlinked };
	};

	it('keeps the files only it has and the ones its notes link, and lets the rest go', async () => {
		const { db, pending, cached, unlinked } = await detached();

		expect(await filesOf(db, ADA.connectionId)).toEqual([pending, cached]);
		expect(await heldText(db, ADA.connectionId, cached.id)).toBe('bb');
		expect(await heldText(db, ADA.connectionId, unlinked.id)).toBeUndefined();
		expect(await uploadsOf(db, ADA.connectionId)).toEqual([
			{ op: 'upload', path: pending.path, fileId: pending.id },
		]);
	});

	it('goes home with them under the same account, as they were, uploads and all', async () => {
		const { db, pending, cached } = await detached();

		await bindConnection(db, ADA_AGAIN);

		expect(await filesOf(db, ADA.connectionId)).toEqual([]);
		expect(await db.fileBytes.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await filesOf(db, ADA_AGAIN.connectionId)).toEqual([
			{ ...pending, connectionId: ADA_AGAIN.connectionId },
			{ ...cached, connectionId: ADA_AGAIN.connectionId },
		]);
		expect(await db.fileBytes.get([ADA_AGAIN.connectionId, cached.id])).toMatchObject({
			version: 'v1',
			pinned: 0,
		});
		expect(await heldText(db, ADA_AGAIN.connectionId, pending.id)).toBe('a');
		expect(await uploadsOf(db, ADA_AGAIN.connectionId)).toEqual([
			{ op: 'upload', path: pending.path, fileId: pending.id },
		]);
		// A bound file came home with them, so nothing here is sure the remote
		// is the one it names until someone has looked.
		expect((await db.syncState.get(ADA_AGAIN.connectionId))?.resumeUnverified).toBe(true);
	});

	it('gives way to the row the live source already has for the same file', async () => {
		const { db, pending, cached } = await detached();
		await db.syncState.put({ ...ADA_AGAIN, clientId: 'client' });
		// The cached file, pulled already and renamed on the remote since —
		// under the id the pending one has here.
		const theirs: FileRecord = {
			...cached,
			connectionId: ADA_AGAIN.connectionId,
			id: pending.id,
			path: 'Work/renamed.png',
		};
		await db.files.put(theirs);

		await bindConnection(db, ADA_AGAIN);

		const files = await filesOf(db, ADA_AGAIN.connectionId);
		const kept = files.find((file) => file.remoteId === undefined);
		expect(kept?.id).not.toBe(pending.id);
		expect(files).toEqual([
			{ ...pending, connectionId: ADA_AGAIN.connectionId, id: kept?.id },
			theirs,
		]);
		// Its bytes and its upload under the id it has now.
		expect(await heldText(db, ADA_AGAIN.connectionId, kept!.id)).toBe('a');
		expect(await uploadsOf(db, ADA_AGAIN.connectionId)).toEqual([
			{ op: 'upload', path: pending.path, fileId: kept?.id },
		]);
		expect(await heldText(db, ADA_AGAIN.connectionId, cached.id)).toBeUndefined();
	});

	it('puts a kept file beside a different one the live source has at its name, and sends it once', async () => {
		const { db, pending } = await detached();
		await db.syncState.put({ ...ADA_AGAIN, clientId: 'client' });
		await boundFile(db, ADA_AGAIN.connectionId, pending.path, undefined, 9);

		await bindConnection(db, ADA_AGAIN);

		const beside = (await filesOf(db, ADA_AGAIN.connectionId)).filter(
			(file) => file.remoteId === undefined
		);
		expect(beside.map((file) => file.path)).toEqual([
			expect.stringMatching(/^Work\/a \(conflict .+\)\.png$/),
		]);
		expect(await heldText(db, ADA_AGAIN.connectionId, beside[0]!.id)).toBe('a');
		expect(await uploadsOf(db, ADA_AGAIN.connectionId)).toEqual([
			{ op: 'upload', path: beside[0]!.path, fileId: beside[0]!.id },
		]);
	});

	it('cuts its files loose where the remote turns out not to be theirs, and sends what it holds', async () => {
		const { db, pending, cached } = await detached();
		await bindConnection(db, ADA_AGAIN);
		await updateNote(db, (await db.notes.toArray())[0]!.id, { remoteId: 'r-note' });
		const unheld = await boundFile(db, ADA_AGAIN.connectionId, 'Work/c.png');
		// Bytes of a version the remote has moved on from: not the file's.
		const stale = await boundFile(db, ADA_AGAIN.connectionId, 'Work/s.png', 'ss');
		await db.fileBytes.update([ADA_AGAIN.connectionId, stale.id], { version: 'v0' });
		const emptied = { read: () => Promise.reject(new NotFoundError('gone')) };

		expect(await verifyResume(db, ADA_AGAIN.connectionId, emptied)).toBe('copied');

		expect(await filesOf(db, ADA_AGAIN.connectionId)).toEqual([
			{ ...pending, connectionId: ADA_AGAIN.connectionId },
			{ connectionId: ADA_AGAIN.connectionId, id: cached.id, path: cached.path, size: 2 },
		]);
		expect(await db.files.get([ADA_AGAIN.connectionId, unheld.id])).toBeUndefined();
		expect(await db.fileBytes.get([ADA_AGAIN.connectionId, stale.id])).toBeUndefined();
		const bytes = await db.fileBytes.get([ADA_AGAIN.connectionId, cached.id]);
		expect(bytes?.pinned).toBe(1);
		expect(bytes?.version).toBeUndefined();
		expect(await uploadsOf(db, ADA_AGAIN.connectionId)).toEqual([
			{ op: 'upload', path: pending.path, fileId: pending.id },
			{ op: 'upload', path: cached.path, fileId: cached.id },
		]);
		expect(await filesFirst(db, ADA_AGAIN.connectionId)).toBe(true);
	});

	it('sends a kept file that lost its upload once, on connecting again under the same id', async () => {
		const { db, pending } = await detached();
		const lost = await pendingFile(db, ADA.connectionId, 'Work/d.png', 'd');
		await db.opQueue.filter((op) => op.fileId === lost.id).delete();

		await bindConnection(db, ADA);

		expect((await uploadsOf(db, ADA.connectionId)).map((op) => op.fileId)).toEqual([
			pending.id,
			lost.id,
		]);
		// The cached file it kept names a file nobody has looked for since.
		expect((await db.syncState.get(ADA.connectionId))?.resumeUnverified).toBe(true);
	});

	it('keeps the upload of a copy it holds no bytes of when cut loose, to read from the remote', async () => {
		const { db } = await detached();
		const copy: FileRecord = { ...ada, id: 'copy', path: 'Work/c.png', size: 1 };
		await db.files.put(copy);
		await queueUpload(db, copy, 'r-original');
		await bindConnection(db, ADA_AGAIN);
		await updateNote(db, (await db.notes.toArray())[0]!.id, { remoteId: 'r-note' });
		const emptied = { read: () => Promise.reject(new NotFoundError('gone')) };

		expect(await verifyResume(db, ADA_AGAIN.connectionId, emptied)).toBe('copied');

		const its = (
			await db.opQueue.where('connectionId').equals(ADA_AGAIN.connectionId).toArray()
		).filter((op) => op.fileId === copy.id);
		expect(its.map(({ op, path, copyOf }) => ({ op, path, copyOf }))).toEqual([
			{ op: 'upload', path: copy.path, copyOf: 'r-original' },
		]);
	});

	it('sends a file once where a bind both resumes rows and finds its own owed', async () => {
		const db = freshDatabase();
		const EARLIER = { ...ADA, connectionId: 'c-ada-0' } as const;
		await connected(db, EARLIER);
		await unsentNote(db, EARLIER.connectionId, '# One\n');
		await pendingFile(db, EARLIER.connectionId, 'Work/a.png', 'a');
		await detachConnection(db, { connectionId: EARLIER.connectionId });
		// Ada's own source, detached as well, with another file at that name.
		await db.syncState.put({
			...ADA,
			clientId: 'client',
			detached: { at: 0, reason: 'revoked' },
		});
		await pendingFile(db, ADA.connectionId, 'Work/a.png', 'aa');

		await bindConnection(db, ADA);

		const uploads = (await uploadsOf(db, ADA.connectionId)).map((op) => op.fileId);
		expect(uploads).toHaveLength(2);
		expect(new Set(uploads).size).toBe(2);
	});

	it('keeps a file a notebook renamed here took with it, and the move it owes', async () => {
		const db = freshDatabase();
		await connected(db, ADA);
		await db.folders.put({ ...ada, path: 'Old', remoteId: 'f-old', createdAt: 0 });
		await importNoteFile(db, {
			...ada,
			path: 'Old/n.md',
			source: '# N\n',
			remoteId: 'r-n',
			remoteVersion: 'v1',
		});
		// Linked by nothing: the link was taken out, and the file stays.
		const orphan = await boundFile(db, ADA.connectionId, 'Old/x.png');
		await renameFolder(db, 'Old', 'New', ada);

		await detachConnection(db, ada);

		expect(await filesOf(db, ADA.connectionId)).toEqual([{ ...orphan, path: 'New/x.png' }]);
		expect((await opsOf(db, ADA.connectionId)).filter((op) => op.op === 'move-file')).toEqual([
			{ op: 'move-file', path: 'Old/x.png', fileId: orphan.id },
		]);
	});

	it('keeps the notebook a file not uploaded is in, with no note there', async () => {
		const db = freshDatabase();
		await connected(db, ADA);
		await db.folders.put({ ...ada, path: 'Pics', remoteId: 'f-pics', createdAt: 0 });
		await pendingFile(db, ADA.connectionId, 'Pics/p.png', 'p');

		await detachConnection(db, ada);

		expect(await db.folders.get([ADA.connectionId, 'Pics'])).toBeDefined();
	});
});

describe('a detach that finds nothing unsent', () => {
	it("forgets a file's owed move and delete with the source, and leaves nothing under it", async () => {
		const db = freshDatabase();
		await connected(db, ADA);
		const moved = await boundFile(db, ADA.connectionId, 'New/x.png');
		await db.opQueue.bulkAdd([
			{
				...ada,
				op: 'move-file',
				fileId: moved.id,
				path: 'Old/x.png',
				targetPath: moved.path,
				attempts: 0,
				queuedAt: 0,
			},
			{
				...ada,
				op: 'delete-file',
				remoteId: 'r-y',
				path: 'Gone/y.png',
				attempts: 0,
				queuedAt: 0,
			},
		]);

		expect(await detachConnection(db, ada)).toBe(true);

		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
		expect(await db.files.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await db.opQueue.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
	});
});

describe('a resumed source not yet checked against its remote', () => {
	it('lists a file the remote may have lost whose bytes are here, and only that one', async () => {
		const db = freshDatabase();
		await connected(db, ADA);
		await db.syncState.update(ADA.connectionId, { resumeUnverified: true });
		await unsentNote(db, ADA.connectionId, '![b](b.png) ![c](c.png)\n');
		const cached = await boundFile(db, ADA.connectionId, 'Work/b.png', 'bb');
		await boundFile(db, ADA.connectionId, 'Work/c.png');

		const listed = await unsyncedIn(db, ADA.connectionId);

		expect(listed.files).toEqual([cached]);
		expect(listed.linked).toEqual([]);
	});
});

describe('letting a source go', () => {
	it('discards the files the user was shown, and keeps one added since', async () => {
		const db = freshDatabase();
		await connected(db, ADA);
		await unsentNote(db, ADA.connectionId, '# One\n');
		const shown = await pendingFile(db, ADA.connectionId, 'Work/a.png', 'a');
		await detachConnection(db, { connectionId: ADA.connectionId });
		const seen = seenIn(await unsyncedIn(db, ADA.connectionId));
		const since = await pendingFile(db, ADA.connectionId, 'Work/b.png', 'b');

		expect(
			await releaseConnection(db, {
				connectionId: ADA.connectionId,
				unsynced: 'discard',
				seen,
			})
		).toBe('detached');

		expect(await filesOf(db, ADA.connectionId)).toEqual([since]);
		expect(await heldText(db, ADA.connectionId, shown.id)).toBeUndefined();
		expect(await uploadsOf(db, ADA.connectionId)).toEqual([
			{ op: 'upload', path: since.path, fileId: since.id },
		]);
	});
});

describe('moving what a source never sent into another', () => {
	/** Bob live, Ada detached with an unsent note that links three files. */
	const leaving = async () => {
		const db = freshDatabase();
		await connected(db, BOB);
		await connected(db, ADA);
		await unsentNote(db, ADA.connectionId, '![a](a.png) ![b](b.png) ![c](c.png) ![s](s.png)\n');
		const pending = await pendingFile(db, ADA.connectionId, 'Work/a.png', 'a');
		const cached = await boundFile(db, ADA.connectionId, 'Work/b.png', 'bb');
		const unheld = await boundFile(db, ADA.connectionId, 'Work/c.png');
		// Held, but of a version the remote has moved on from.
		const stale = await boundFile(db, ADA.connectionId, 'Work/s.png', 'ss');
		await db.fileBytes.update([ADA.connectionId, stale.id], { version: 'v0' });
		await detachConnection(db, { connectionId: ADA.connectionId });
		return { db, pending, cached, unheld, stale };
	};

	it('takes the files the notes link that this device holds, and leaves the rest', async () => {
		const { db, pending, cached, unheld, stale } = await leaving();
		const listed = await unsyncedIn(db, ADA.connectionId);
		expect(listed.files).toEqual([pending]);
		expect(listed.linked).toEqual([cached, unheld, stale]);

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen: seenIn(listed),
			})
		).toBe('released');

		// Both new to Bob's storage, whatever they were in Ada's.
		expect(await filesOf(db, BOB.connectionId)).toEqual([
			{ connectionId: BOB.connectionId, id: pending.id, path: pending.path, size: 1 },
			{ connectionId: BOB.connectionId, id: cached.id, path: cached.path, size: 2 },
		]);
		expect(await heldText(db, BOB.connectionId, cached.id)).toBe('bb');
		expect((await db.fileBytes.get([BOB.connectionId, cached.id]))?.pinned).toBe(1);
		expect((await uploadsOf(db, BOB.connectionId)).map((op) => op.path)).toEqual([
			pending.path,
			cached.path,
		]);
		expect(await filesFirst(db, BOB.connectionId)).toBe(true);
		expect(await db.files.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await db.fileBytes.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
	});

	it('leaves what a note written since links, and keeps it', async () => {
		const { db, pending, cached } = await leaving();
		const seen = seenIn(await unsyncedIn(db, ADA.connectionId));
		const written = await unsentNote(
			db,
			ADA.connectionId,
			'![d](d.png) ![b](../Work/b.png)\n',
			'Play'
		);
		const its = await pendingFile(db, ADA.connectionId, 'Play/d.png', 'd');

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen,
			})
		).toBe('detached');

		expect((await filesOf(db, BOB.connectionId)).map((file) => file.path)).toEqual([
			pending.path,
			cached.path,
		]);
		// Copied, not taken: the note staying links it too.
		expect(await filesOf(db, ADA.connectionId)).toEqual([its, cached]);
		expect(await heldText(db, ADA.connectionId, cached.id)).toBe('bb');
		expect(await uploadsOf(db, ADA.connectionId)).toEqual([
			{ op: 'upload', path: its.path, fileId: its.id },
		]);
		expect((await db.notes.get([ADA.connectionId, written.id]))?.path).toBe(written.path);
	});

	it('makes no notebook in the target for a file it cannot take', async () => {
		const db = freshDatabase();
		await connected(db, BOB);
		await connected(db, ADA);
		await db.folders.put({ ...ada, path: 'Archive', remoteId: 'f-archive', createdAt: 0 });
		// Never downloaded, and held but of a version the remote has moved on from.
		await boundFile(db, ADA.connectionId, 'Archive/x.png');
		const stale = await boundFile(db, ADA.connectionId, 'Old/s.png', 'ss');
		await db.fileBytes.update([ADA.connectionId, stale.id], { version: 'v0' });
		await db.folders.put({ ...ada, path: 'Old', remoteId: 'f-old', createdAt: 0 });
		await unsentNote(db, ADA.connectionId, '![x](../Archive/x.png) ![s](../Old/s.png)\n');
		await detachConnection(db, ada);

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen: seenIn(await unsyncedIn(db, ADA.connectionId)),
			})
		).toBe('released');

		expect(await db.folders.get([BOB.connectionId, 'Archive'])).toBeUndefined();
		expect(await db.folders.get([BOB.connectionId, 'Old'])).toBeUndefined();
		expect((await opsOf(db, BOB.connectionId)).map((op) => `${op.op} ${op.path}`)).toEqual([
			'mkdir Work',
			'write Work/one.md',
		]);
	});

	it('moves a file not uploaded on its own, with the notebook it is in', async () => {
		const db = freshDatabase();
		await connected(db, BOB);
		await connected(db, ADA);
		await db.folders.put({ ...ada, path: 'Pics', remoteId: 'f-pics', createdAt: 0 });
		const alone = await pendingFile(db, ADA.connectionId, 'Pics/p.png', 'p');
		await detachConnection(db, ada);
		const listed = await unsyncedIn(db, ADA.connectionId);
		expect(movable(listed)).toBe(1);

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen: seenIn(listed),
			})
		).toBe('released');

		expect(await filesOf(db, BOB.connectionId)).toEqual([
			{ ...alone, connectionId: BOB.connectionId },
		]);
		expect(await opsOf(db, BOB.connectionId)).toEqual([
			{ op: 'mkdir', path: 'Pics' },
			{ op: 'upload', path: alone.path, fileId: alone.id },
		]);
	});

	it("leaves a copy a note's move owes of a file never downloaded, and says so", async () => {
		const db = freshDatabase();
		await connected(db, BOB);
		await connected(db, ADA);
		await db.folders.put({ ...ada, path: 'Work', remoteId: 'f-work', createdAt: 0 });
		const pic = await boundFile(db, ADA.connectionId, 'Work/pic.png');
		const pushed = (path: string) =>
			importNoteFile(db, {
				...ada,
				path,
				source: '![p](pic.png)\n',
				remoteId: `r-${path}`,
				remoteVersion: 'v1',
			});
		await pushed('Work/m.md');
		const n = await pushed('Work/n.md');
		// m links the picture too, so it is copied, from the remote.
		await moveNote(db, n.id, 'Play', ada);
		await saveNoteBody(db, n.id, '![p](pic.png)\n\nmore\n', undefined, ada);
		await detachConnection(db, ada);
		const listed = await unsyncedIn(db, ADA.connectionId);
		const [copy] = listed.files;
		expect(copy?.path).toBe('Play/pic.png');
		expect(copy?.remoteId).toBeUndefined();
		expect(
			(await db.opQueue.where('connectionId').equals(ADA.connectionId).toArray()).find(
				(op) => op.fileId === copy?.id
			)?.copyOf
		).toBe(pic.remoteId);
		expect(listed.portable).toEqual([]);

		const user = userEvent.setup();
		render(
			<MoveUnsent
				listed={listed}
				from="Dropbox"
				targets={[{ ...BOB, active: false }]}
				busy={false}
				disabled={false}
				onMove={() => undefined}
			/>
		);
		await user.click(screen.getByRole('button', { name: /^Move 1 note to / }));
		expect(screen.getByText(/any it has never downloaded stay in Dropbox\.$/)).toBeTruthy();

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen: seenIn(listed),
			})
		).toBe('released');
		expect(await filesOf(db, BOB.connectionId)).toEqual([]);
		expect(await uploadsOf(db, BOB.connectionId)).toEqual([]);
	});

	it('finds nothing to move in a copy alone, and keeps it', async () => {
		const db = freshDatabase();
		await connected(db, BOB);
		await connected(db, ADA);
		const copy: FileRecord = { ...ada, id: 'copy', path: 'p.png', size: 1 };
		await db.files.put(copy);
		await queueUpload(db, copy, 'r-original');
		await detachConnection(db, ada);
		const listed = await unsyncedIn(db, ADA.connectionId);
		expect(movable(listed)).toBe(0);

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen: seenIn(listed),
			})
		).toBe('nothing-to-move');
		expect(await filesOf(db, ADA.connectionId)).toEqual([copy]);
		expect(await uploadsOf(db, ADA.connectionId)).toHaveLength(1);
	});

	it('counts the files going, and says the ones it cannot take stay', async () => {
		const { db } = await leaving();
		const target: ConnectedSource = { ...BOB, active: false };
		const user = userEvent.setup();
		render(
			<MoveUnsent
				listed={await unsyncedIn(db, ADA.connectionId)}
				from="Dropbox"
				targets={[target]}
				busy={false}
				disabled={false}
				onMove={() => undefined}
			/>
		);

		await user.click(screen.getByRole('button', { name: /^Move 1 note and 1 file to / }));

		expect(
			screen.getByText(
				/will be uploaded to .*\. Pictures and files they link go with them where this device holds them; any it has never downloaded stay in Dropbox\.$/
			)
		).toBeTruthy();
	});

	it('says a file going on its own without a count of notes', async () => {
		const db = freshDatabase();
		await connected(db, BOB);
		await connected(db, ADA);
		await pendingFile(db, ADA.connectionId, 'p.png', 'p');
		await detachConnection(db, ada);
		render(
			<MoveUnsent
				listed={await unsyncedIn(db, ADA.connectionId)}
				from="Dropbox"
				targets={[{ ...BOB, active: false }]}
				busy={false}
				disabled={false}
				onMove={() => undefined}
			/>
		);

		expect(screen.getByRole('button', { name: /^Move 1 file to / })).toBeTruthy();
	});
});
