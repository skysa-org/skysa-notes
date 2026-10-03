import {
	bytesHash,
	createFakeProvider,
	createSyncEngine,
	type FakeProvider,
	isHidden,
	MAX_ATTACHMENT_BYTES,
	type StorageProvider,
} from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
	abandonImport,
	bindConnection,
	detachConnection,
	releaseConnection,
} from '../src/store/connection.js';
import {
	createDatabase,
	type FileRecord,
	type NotesDatabase,
	type OpQueueRecord,
} from '../src/store/db.js';
import {
	addAttachment,
	type AddAttachmentInput,
	AttachmentRefusedError,
	fileForLink,
	listFilePaths,
} from '../src/store/files.js';
import { createFolder, deleteFolder, FolderExistsError, moveFolder } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	importNoteFile,
	moveNote,
	renameNote,
	saveNoteBody,
} from '../src/store/notes.js';
import { queueDeleteFile, queueMoveFile } from '../src/store/queue.js';
import { seenIn, unsyncedIn } from '../src/store/unsynced.js';
import { createDexieSyncStore } from '../src/sync/store.js';
import { noteById, updateNote } from './noteRows.js';

const CONNECTION = 'dropbox-1';
const scope = { connectionId: CONNECTION };

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`files-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** What `addAttachment` names these bytes, at this many hex. */
const stamped = async (stem: string, text: string, extension: string, hex = 8) =>
	`${stem}-${(await bytesHash(bytesOf(text))).slice(0, hex)}.${extension}`;

/** The queue as the engine would read it, without the bookkeeping. */
const queued = async (db: NotesDatabase) =>
	(await db.opQueue.orderBy('seq').toArray()).map((op: OpQueueRecord) => ({
		op: op.op,
		path: op.path,
		...(op.noteId === undefined ? {} : { noteId: op.noteId }),
		...(op.fileId === undefined ? {} : { fileId: op.fileId }),
		...(op.targetPath === undefined ? {} : { targetPath: op.targetPath }),
		...(op.remoteId === undefined ? {} : { remoteId: op.remoteId }),
		...(op.copyOf === undefined ? {} : { copyOf: op.copyOf }),
	}));

const fileRows = async (db: NotesDatabase) =>
	(await db.files.toArray()).sort((a, b) => a.path.localeCompare(b.path));

const heldFor = (db: NotesDatabase, file: Pick<FileRecord, 'id'>) =>
	db.fileBytes.get([CONNECTION, file.id]);

const textOf = (buffer: ArrayBuffer | undefined): string | undefined =>
	buffer === undefined ? undefined : new TextDecoder().decode(buffer);

const attach = (
	db: NotesDatabase,
	noteId: string,
	name: string,
	text: string,
	more: Partial<AddAttachmentInput> = {}
) => addAttachment(db, { ...scope, noteId, name, bytes: bytesOf(text), ...more });

/** A note the remote already has, with nothing left to send for it. */
const pushedNote = async (db: NotesDatabase, path: string, body: string) => {
	const note = await importNoteFile(db, { ...scope, path, source: body });
	await updateNote(db, note.id, { remoteId: `r-${note.id}`, remoteVersion: 'v1' });
	return (await noteById(db, note.id))!;
};

/** A file the remote already has, and whose bytes this device has not read. */
const boundFile = async (db: NotesDatabase, path: string, size = 5): Promise<FileRecord> => {
	const file: FileRecord = {
		connectionId: CONNECTION,
		id: `f-${path}`,
		path,
		remoteId: `rf-${path}`,
		remoteVersion: 'v1',
		size,
	};
	await db.files.put(file);
	return file;
};

describe('adding a file to a note', () => {
	it('puts it beside the note, holds its bytes, and queues its upload', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'Trip' });
		await db.opQueue.clear();

		const added = await attach(db, note.id, 'Holiday.JPG', 'sun');

		const name = await stamped('holiday', 'sun', 'jpg');
		expect(added).toMatchObject({
			path: `Work/${name}`,
			href: name,
			label: 'Holiday',
			kind: 'image',
			markdown: `![Holiday](${name})`,
		});
		expect(await fileRows(db)).toEqual([
			{ connectionId: CONNECTION, id: added.fileId, path: `Work/${name}`, size: 3 },
		]);
		const held = await heldFor(db, { id: added.fileId });
		expect(held?.pinned).toBe(1);
		expect(textOf(held?.bytes)).toBe('sun');
		expect(await queued(db)).toEqual([
			{ op: 'upload', path: `Work/${name}`, fileId: added.fileId },
		]);
	});

	it('links anything that is not a picture by its whole name, which shows as a chip', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		const added = await attach(db, note.id, 'Q3 report.pdf', 'numbers');

		const name = await stamped('q3-report', 'numbers', 'pdf');
		expect(added).toMatchObject({
			kind: 'file',
			label: 'Q3 report.pdf',
			markdown: `[Q3 report.pdf](${name})`,
		});
	});

	it('names a pasted picture for what it is, having no name of its own', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		const added = await attach(db, note.id, 'image.png', 'pixels', { pasted: true });

		const name = await stamped('pasted-image', 'pixels', 'png');
		expect(added.markdown).toBe(`![Pasted image](${name})`);
	});

	it('sends the note behind the file, so the file lands first', async () => {
		// A write queued before the file was added would otherwise run first,
		// and another device would read a note linking a file not there yet.
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'Plan' });

		const added = await attach(db, note.id, 'a.png', 'a');

		expect((await queued(db)).map((op) => op.op)).toEqual(['upload', 'write']);
		expect((await queued(db))[0]?.fileId).toBe(added.fileId);
	});

	it('queues no write for a note that has none owed: the edit that links it does', async () => {
		const db = freshDatabase();
		const note = await pushedNote(db, 'a.md', '# A\n');

		const added = await attach(db, note.id, 'a.png', 'a');
		expect((await queued(db)).map((op) => op.op)).toEqual(['upload']);

		await saveNoteBody(db, note.id, `# A\n\n${added.markdown}\n`, undefined, scope);
		expect((await queued(db)).map((op) => op.op)).toEqual(['upload', 'write']);
	});

	it('is the file already there when the same bytes are added again', async () => {
		const db = freshDatabase();
		const one = await createNote(db, { ...scope, title: 'One' });
		const two = await createNote(db, { ...scope, title: 'Two' });
		const first = await attach(db, one.id, 'a.png', 'same');

		const again = await attach(db, two.id, 'a.png', 'same');

		expect(again.fileId).toBe(first.fileId);
		expect(await db.files.count()).toBe(1);
		expect((await queued(db)).filter((op) => op.op === 'upload')).toHaveLength(1);
	});

	it('sends the note behind the file already there when it is not up yet', async () => {
		// Typing in One, with its write queued, and the picture already added
		// to Two: One's write would go up first, linking a file not there.
		const db = freshDatabase();
		const one = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const two = await createNote(db, { ...scope, folderPath: 'Work', title: 'Two' });
		const first = await attach(db, two.id, 'a.png', 'same');

		const again = await attach(db, one.id, 'a.png', 'same');

		expect(again.fileId).toBe(first.fileId);
		const ops = await queued(db);
		expect(ops.findIndex((op) => op.op === 'upload')).toBeLessThan(
			ops.findIndex((op) => op.op === 'write' && op.noteId === one.id)
		);
	});

	it('finds the file already there under another spelling of its name', async () => {
		// One name on Dropbox and OneDrive, so a second row would be a second
		// upload to the same name, set beside it as a conflict.
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });
		const name = await stamped('a', 'same', 'png');
		const theirs = await boundFile(db, name.toUpperCase(), 4);

		const added = await attach(db, note.id, 'a.png', 'same');

		expect(added).toMatchObject({ fileId: theirs.id, path: theirs.path });
		expect(await db.files.count()).toBe(1);
	});

	it('takes sixteen hex where another file holds the eight', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });
		await boundFile(db, await stamped('a', 'mine', 'png'), 999);

		const added = await attach(db, note.id, 'a.png', 'mine');

		expect(added.path).toBe(await stamped('a', 'mine', 'png', 16));
		expect(await db.files.count()).toBe(2);
	});

	it('refuses a file over the cap, and adds nothing', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });
		await db.opQueue.clear();

		const refused = addAttachment(db, {
			...scope,
			noteId: note.id,
			name: 'film.mov',
			bytes: new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1),
		});

		await expect(refused).rejects.toBeInstanceOf(AttachmentRefusedError);
		await expect(refused).rejects.toMatchObject({ reason: 'too-large', fileName: 'film.mov' });
		expect(await db.files.count()).toBe(0);
		expect(await queued(db)).toEqual([]);
	});

	it('takes a file of exactly the cap', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });

		const added = await addAttachment(db, {
			...scope,
			noteId: note.id,
			name: 'film.mov',
			bytes: new ArrayBuffer(MAX_ATTACHMENT_BYTES),
		});

		expect((await db.files.get([CONNECTION, added.fileId]))?.size).toBe(MAX_ATTACHMENT_BYTES);
	});

	it('refuses a note, which the engine would read as one', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });

		await expect(attach(db, note.id, 'Other.MD', '# Other')).rejects.toMatchObject({
			reason: 'note',
		});
		expect(await db.files.count()).toBe(0);
	});

	it('refuses a note that is not there, or is deleted', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });
		await deleteNote(db, note.id, scope);

		await expect(attach(db, note.id, 'a.png', 'a')).rejects.toThrow(/No note/);
		await expect(attach(db, 'nobody', 'a.png', 'a')).rejects.toThrow(/No note/);
		expect(await db.files.count()).toBe(0);
		expect(await db.fileBytes.count()).toBe(0);
	});
});

describe('the file a link names', () => {
	it('is resolved from where the note is', async () => {
		const db = freshDatabase();
		const here = await boundFile(db, 'Work/a.png');
		const up = await boundFile(db, 'b.png');
		const link = { connectionId: CONNECTION, notePath: 'Work/note.md' };

		expect(await fileForLink(db, { ...link, href: 'a.png' })).toEqual(here);
		expect(await fileForLink(db, { ...link, href: './a.png' })).toEqual(here);
		expect(await fileForLink(db, { ...link, href: '../b.png' })).toEqual(up);
		expect(await fileForLink(db, { ...link, href: 'b.png' })).toBeUndefined();
	});

	it('is nothing for a link out of the source, or to another', async () => {
		const db = freshDatabase();
		await boundFile(db, 'a.png');
		const link = { connectionId: CONNECTION, notePath: 'note.md' };

		expect(await fileForLink(db, { ...link, href: '../a.png' })).toBeUndefined();
		expect(
			await fileForLink(db, { ...link, href: 'https://example.com/a.png' })
		).toBeUndefined();
		expect(
			await fileForLink(db, { connectionId: 'other', notePath: 'note.md', href: 'a.png' })
		).toBeUndefined();
	});

	it('reads a name the link spells with escapes', async () => {
		const db = freshDatabase();
		const file = await boundFile(db, 'my file.pdf');

		expect(
			await fileForLink(db, {
				connectionId: CONNECTION,
				notePath: 'n.md',
				href: 'my%20file.pdf',
			})
		).toEqual(file);
	});
});

describe("a file's own ops", () => {
	const inQueue = (db: NotesDatabase, work: () => Promise<void>) =>
		db.transaction('rw', db.opQueue, work);

	it('moves a file the remote has from where it is, and replaces the move on a second', async () => {
		const db = freshDatabase();
		const file = await boundFile(db, 'a.png');

		await inQueue(db, () => queueMoveFile(db, { ...file, path: 'Work/a.png' }, 'a.png'));
		await inQueue(db, () => queueMoveFile(db, { ...file, path: 'Play/a.png' }, 'Work/a.png'));

		expect(await queued(db)).toEqual([
			{ op: 'move-file', path: 'a.png', fileId: file.id, targetPath: 'Play/a.png' },
		]);
	});

	it('leaves a move already going there where it stands in the queue', async () => {
		const db = freshDatabase();
		const file = await boundFile(db, 'a.png');
		const moved = { ...file, path: 'Work/a.png' };
		await inQueue(db, () => queueMoveFile(db, moved, 'a.png'));
		await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'mkdir',
			path: 'Other',
			attempts: 0,
			queuedAt: 0,
		});

		await inQueue(db, () => queueMoveFile(db, moved, 'a.png'));

		expect((await queued(db)).map((op) => op.op)).toEqual(['move-file', 'mkdir']);
	});

	it('withdraws the move of a file moved back to where it is', async () => {
		const db = freshDatabase();
		const file = await boundFile(db, 'a.png');

		await inQueue(db, () => queueMoveFile(db, { ...file, path: 'Work/a.png' }, 'a.png'));
		await inQueue(db, () => queueMoveFile(db, file, 'Work/a.png'));

		expect(await queued(db)).toEqual([]);
	});

	it('moves no pending file: its upload follows it', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });
		const added = await attach(db, note.id, 'a.png', 'a');
		const file = (await db.files.get([CONNECTION, added.fileId]))!;

		await inQueue(db, () => queueMoveFile(db, { ...file, path: 'Work/a.png' }, file.path));

		expect((await queued(db)).filter((op) => op.fileId === file.id)).toEqual([
			{ op: 'upload', path: 'Work/a.png', fileId: file.id },
		]);
	});

	it('deletes a file the remote has by its id, from where the remote has it', async () => {
		const db = freshDatabase();
		const file = await boundFile(db, 'a.png');
		await inQueue(db, () => queueMoveFile(db, { ...file, path: 'Work/a.png' }, 'a.png'));

		await inQueue(db, () => queueDeleteFile(db, { ...file, path: 'Work/a.png' }));

		expect(await queued(db)).toEqual([
			{ op: 'delete-file', path: 'a.png', remoteId: file.remoteId },
		]);
	});

	it('only withdraws the upload of a file the remote never had', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, title: 'One' });
		const added = await attach(db, note.id, 'a.png', 'a');
		const file = (await db.files.get([CONNECTION, added.fileId]))!;

		await inQueue(db, () => queueDeleteFile(db, file));

		expect((await queued(db)).map((op) => op.op)).toEqual(['write']);
	});

	it('is about its own connection only', async () => {
		const db = freshDatabase();
		const file = await boundFile(db, 'a.png');
		const theirs = { ...file, connectionId: 'other' };
		await inQueue(db, () => queueMoveFile(db, { ...theirs, path: 'b.png' }, 'a.png'));

		await inQueue(db, () => queueDeleteFile(db, file));

		expect((await queued(db)).map((op) => op.op).sort()).toEqual(['delete-file', 'move-file']);
	});
});

describe('moving a note takes the files it links', () => {
	/** A note in `Work` that links one file beside it, which the remote has. */
	const linking = async (db: NotesDatabase, title = 'One', file = 'a.png') => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Play' });
		const note = await pushedNote(db, `Work/${title}.md`, `# ${title}\n\n![a](${file})\n`);
		await db.opQueue.clear();
		return note;
	};

	it('moves a file only the note links, ahead of the note', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		const file = await boundFile(db, 'Work/a.png');

		await moveNote(db, note.id, 'Play', scope);

		expect(await fileRows(db)).toEqual([{ ...file, path: 'Play/a.png' }]);
		expect(await queued(db)).toEqual([
			{ op: 'move-file', path: 'Work/a.png', fileId: file.id, targetPath: 'Play/a.png' },
			{ op: 'write', path: 'Play/One.md', noteId: note.id },
			{ op: 'move', path: 'Work/One.md', targetPath: 'Play/One.md', noteId: note.id },
		]);
	});

	it('moves the note behind the file when it had a write queued already', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		await saveNoteBody(db, note.id, '# One\n\n![a](a.png)\n\nmore\n', undefined, scope);
		await boundFile(db, 'Work/a.png');

		await moveNote(db, note.id, 'Play', scope);

		expect((await queued(db)).map((op) => op.op)).toEqual(['move-file', 'write', 'move']);
	});

	it('moves a pending file by its row, and its upload goes there', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const added = await attach(db, note.id, 'a.png', 'a');
		await saveNoteBody(db, note.id, `# One\n\n${added.markdown}\n`, undefined, scope);

		await moveNote(db, note.id, 'Play', scope);

		const [row] = await fileRows(db);
		expect(row?.path).toBe(`Play/${added.href}`);
		expect(textOf((await heldFor(db, row!))?.bytes)).toBe('a');
		expect((await queued(db)).map((op) => op.op)).toEqual(['upload', 'write']);
		expect((await queued(db))[0]).toEqual({
			op: 'upload',
			path: `Play/${added.href}`,
			fileId: added.fileId,
		});
	});

	it('copies a file another note there links too, with the bytes held here', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		await pushedNote(db, 'Work/Two.md', '# Two\n\nsee [it](a.png)\n');
		const file = await boundFile(db, 'Work/a.png');
		await db.fileBytes.put({
			connectionId: CONNECTION,
			id: file.id,
			bytes: bytesOf('cached'),
			version: 'v1',
			pinned: 0,
			lastUsedAt: 1,
		});

		await moveNote(db, note.id, 'Play', scope);

		const rows = await fileRows(db);
		expect(rows.map((each) => each.path)).toEqual(['Play/a.png', 'Work/a.png']);
		const copy = rows[0]!;
		expect(copy).toEqual({
			connectionId: CONNECTION,
			id: copy.id,
			path: 'Play/a.png',
			size: 5,
		});
		const held = await heldFor(db, copy);
		expect(held?.pinned).toBe(1);
		expect(textOf(held?.bytes)).toBe('cached');
		expect((await queued(db))[0]).toEqual({
			op: 'upload',
			path: 'Play/a.png',
			fileId: copy.id,
		});
	});

	it('copies from the remote a file whose bytes are not here', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		await pushedNote(db, 'Work/Two.md', '# Two\n\n![a](a.png)\n');
		const file = await boundFile(db, 'Work/a.png');
		// Cached under a version the file has since left: not its bytes.
		await db.fileBytes.put({
			connectionId: CONNECTION,
			id: file.id,
			bytes: bytesOf('stale'),
			version: 'v0',
			pinned: 0,
			lastUsedAt: 1,
		});

		await moveNote(db, note.id, 'Play', scope);

		const copy = (await fileRows(db))[0]!;
		expect(await heldFor(db, copy)).toBeUndefined();
		expect((await queued(db))[0]).toEqual({
			op: 'upload',
			path: 'Play/a.png',
			fileId: copy.id,
			copyOf: file.remoteId,
		});
	});

	it('makes no copy of a file it has no way to copy', async () => {
		// Pending, with its bytes gone: nothing on the remote to read either.
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Play' });
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const other = await createNote(db, { ...scope, folderPath: 'Work', title: 'Two' });
		const added = await attach(db, note.id, 'a.png', 'a');
		await saveNoteBody(db, note.id, `${added.markdown}\n`, undefined, scope);
		await saveNoteBody(db, other.id, `${added.markdown}\n`, undefined, scope);
		await db.fileBytes.clear();

		await moveNote(db, note.id, 'Play', scope);

		expect((await fileRows(db)).map((each) => each.path)).toEqual([added.path]);
	});

	it('copies a file a deleted note there links, since the delete can be undone', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		const other = await pushedNote(db, 'Work/Two.md', '# Two\n\n![a](a.png)\n');
		await deleteNote(db, other.id, scope);
		await boundFile(db, 'Work/a.png');

		await moveNote(db, note.id, 'Play', scope);

		expect((await fileRows(db)).map((each) => each.path)).toEqual(['Play/a.png', 'Work/a.png']);
	});

	it('moves a file a note in another notebook links', async () => {
		// The one place a copy is decided from is the note's own folder: a link
		// climbing in from elsewhere is the user's own arrangement.
		const db = freshDatabase();
		const note = await linking(db);
		await pushedNote(db, 'Elsewhere.md', '# E\n\n![a](Work/a.png)\n');
		await boundFile(db, 'Work/a.png');

		await moveNote(db, note.id, 'Play', scope);

		expect((await fileRows(db)).map((each) => each.path)).toEqual(['Play/a.png']);
	});

	it('leaves a file alone where the notebook it goes to has one of that name', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		const file = await boundFile(db, 'Work/a.png');
		const there = await boundFile(db, 'Play/A.PNG');

		await moveNote(db, note.id, 'Play', scope);

		expect(await fileRows(db)).toEqual([there, file]);
		expect((await queued(db)).map((op) => op.op)).toEqual(['write', 'move']);
	});

	it('carries a file beside one of that name and another size, which the note then shows', async () => {
		// Left behind, it would be linked by nothing in a notebook whose delete
		// takes it. The note is not rewritten to rename it.
		const db = freshDatabase();
		const note = await linking(db, 'One', 'diagram.png');
		const mine = await boundFile(db, 'Work/diagram.png', 5);
		const theirs = await boundFile(db, 'Play/diagram.png', 9);

		await moveNote(db, note.id, 'Play', scope);

		const [row] = (await fileRows(db)).filter((file) => file.id === mine.id);
		expect(row?.path).toMatch(/^Play\/diagram \(conflict .+\)\.png$/);
		expect(
			await fileForLink(db, {
				connectionId: CONNECTION,
				notePath: 'Play/One.md',
				href: 'diagram.png',
			})
		).toEqual(theirs);
		await deleteFolder(db, 'Work', scope);
		expect(await db.files.get([CONNECTION, mine.id])).toEqual(row);
	});

	it('sends the note behind a file of that name there that is not up yet', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		await boundFile(db, 'Work/a.png');
		await saveNoteBody(db, note.id, '# One\n\n![a](a.png) again\n', undefined, scope);
		await db.files.put({ connectionId: CONNECTION, id: 'x1', path: 'Play/a.png', size: 5 });
		await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'upload',
			fileId: 'x1',
			path: 'Play/a.png',
			attempts: 0,
			queuedAt: 0,
		});

		await moveNote(db, note.id, 'Play', scope);

		expect((await queued(db)).map((op) => op.op)).toEqual(['upload', 'write', 'move']);
	});

	it('copies a file the note links in other spellings of its name, once', async () => {
		const db = freshDatabase();
		const note = await linking(db, 'One', 'A.PNG');
		await saveNoteBody(db, note.id, '# One\n\n![a](a.png) and ![a](A.PNG)\n', undefined, scope);
		await pushedNote(db, 'Work/Two.md', '# Two\n\n![a](a.png)\n');
		const file = await boundFile(db, 'Work/a.png');

		await moveNote(db, note.id, 'Play', scope);

		expect((await fileRows(db)).map((each) => each.path)).toEqual(['Play/a.png', file.path]);
		expect((await queued(db)).filter((op) => op.op === 'upload')).toEqual([
			expect.objectContaining({ path: 'Play/a.png', copyOf: file.remoteId }),
		]);
	});

	it('leaves a file the note links in another notebook where it is', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Play' });
		const note = await pushedNote(db, 'Work/One.md', '# One\n\n![a](../Shared/a.png)\n');
		const file = await boundFile(db, 'Shared/a.png');

		await moveNote(db, note.id, 'Play', scope);

		expect(await fileRows(db)).toEqual([file]);
	});

	it('takes nothing anywhere for a rename, which stays in the folder', async () => {
		const db = freshDatabase();
		const note = await linking(db);
		const file = await boundFile(db, 'Work/a.png');

		await renameNote(db, note.id, 'Renamed', scope);
		await moveNote(db, note.id, 'Work', scope);

		expect(await fileRows(db)).toEqual([file]);
		expect((await queued(db)).some((op) => op.fileId !== undefined)).toBe(false);
	});

	it('takes a file the note links twice once', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Play' });
		const note = await pushedNote(db, 'Work/One.md', '![a](a.png) and [again](./a.png)\n');
		await boundFile(db, 'Work/a.png');
		await db.opQueue.clear();

		await moveNote(db, note.id, 'Play', scope);

		expect((await queued(db)).filter((op) => op.op === 'move-file')).toHaveLength(1);
	});
});

describe('a notebook moved or deleted takes its files', () => {
	it('moves every file under it, ahead of the directories it leaves', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'folder-work' });
		const note = await pushedNote(db, 'Work/a.md', '# A\n');
		const bound = await boundFile(db, 'Work/deep/b.png');
		const added = await attach(db, note.id, 'c.png', 'c');

		await moveFolder(db, 'Work', 'Play', scope);

		expect((await fileRows(db)).map((file) => file.path)).toEqual([
			`Play/${added.href}`,
			'Play/deep/b.png',
		]);
		const ops = await queued(db);
		expect(ops).toContainEqual({
			op: 'move-file',
			path: 'Work/deep/b.png',
			fileId: bound.id,
			targetPath: 'Play/deep/b.png',
		});
		expect(ops.map((op) => op.op).at(-1)).toBe('rmdir');
		expect(ops.findIndex((op) => op.op === 'move-file')).toBeLessThan(
			ops.findIndex((op) => op.op === 'rmdir')
		);
	});

	it('moves the files ahead of the notes that link them', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		const note = await pushedNote(db, 'Work/One.md', '![a](a.png)\n');
		const file = await boundFile(db, 'Work/a.png');
		await db.opQueue.clear();

		await moveFolder(db, 'Work', 'Play', scope);

		const ops = await queued(db);
		expect(ops.findIndex((op) => op.fileId === file.id)).toBeLessThan(
			ops.findIndex((op) => op.op === 'move' && op.noteId === note.id)
		);
	});

	it('moves the upload of a file not sent yet along with its row', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'A' });
		const added = await attach(db, note.id, 'c.png', 'c');

		await moveFolder(db, 'Work', 'Play', scope);

		expect((await queued(db)).filter((op) => op.op === 'upload')).toEqual([
			{ op: 'upload', path: `Play/${added.href}`, fileId: added.fileId },
		]);
	});

	it('moves a notebook that holds only files', async () => {
		const db = freshDatabase();
		await boundFile(db, 'Pictures/a.png');

		await moveFolder(db, 'Pictures', 'Photos', scope);

		expect((await fileRows(db)).map((file) => file.path)).toEqual(['Photos/a.png']);
	});

	it('refuses a destination a file is in the way of', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await boundFile(db, 'play/a.png');

		await expect(moveFolder(db, 'Work', 'Play', scope)).rejects.toBeInstanceOf(
			FolderExistsError
		);
		await expect(moveFolder(db, 'Work', 'play/a.png', scope)).rejects.toBeInstanceOf(
			FolderExistsError
		);
	});

	it('deletes every file under it, bound and pending, with their bytes', async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await db.folders.update([CONNECTION, 'Work'], { remoteId: 'folder-work' });
		const note = await pushedNote(db, 'Work/a.md', '# A\n');
		const bound = await boundFile(db, 'Work/deep/b.png');
		const added = await attach(db, note.id, 'c.png', 'c');
		const outside = await boundFile(db, 'Elsewhere/d.png');
		await db.fileBytes.put({
			connectionId: CONNECTION,
			id: bound.id,
			bytes: bytesOf('b'),
			version: 'v1',
			pinned: 0,
			lastUsedAt: 1,
		});
		await db.opQueue.clear();

		await deleteFolder(db, 'Work', scope);

		expect(await fileRows(db)).toEqual([outside]);
		expect(await db.fileBytes.count()).toBe(0);
		const ops = await queued(db);
		expect(ops.filter((op) => op.op !== 'delete')).toEqual([
			{ op: 'delete-file', path: 'Work/deep/b.png', remoteId: bound.remoteId },
			{ op: 'rmdir', path: 'Work', remoteId: 'folder-work' },
		]);
		expect(ops.some((op) => op.fileId === added.fileId)).toBe(false);
	});

	it('hands a copy elsewhere the bytes it was to read from a file going', async () => {
		const db = freshDatabase();
		const going = await boundFile(db, 'Work/a.png');
		await db.fileBytes.put({
			connectionId: CONNECTION,
			id: going.id,
			bytes: bytesOf('a'),
			version: 'v1',
			pinned: 0,
			lastUsedAt: 1,
		});
		const copy: FileRecord = {
			connectionId: CONNECTION,
			id: 'copy',
			path: 'Play/a.png',
			size: 5,
		};
		await db.files.put(copy);
		await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'upload',
			fileId: copy.id,
			path: copy.path,
			copyOf: going.remoteId,
			attempts: 0,
			queuedAt: 0,
		});

		await deleteFolder(db, 'Work', scope);

		const held = await heldFor(db, copy);
		expect(held?.pinned).toBe(1);
		expect(textOf(held?.bytes)).toBe('a');
		expect((await queued(db))[0]).toEqual({ op: 'upload', path: 'Play/a.png', fileId: 'copy' });
	});

	it('hands no bytes on from a file not sent, nor ones cached for another version', async () => {
		const db = freshDatabase();
		const pending: FileRecord = {
			connectionId: CONNECTION,
			id: 'p',
			path: 'Work/p.png',
			size: 1,
		};
		await db.files.put(pending);
		await db.fileBytes.put({ ...pending, bytes: bytesOf('p'), pinned: 1, lastUsedAt: 1 });
		const stale = await boundFile(db, 'Work/s.png');
		await db.fileBytes.put({
			connectionId: CONNECTION,
			id: stale.id,
			bytes: bytesOf('old'),
			version: 'v0',
			pinned: 0,
			lastUsedAt: 1,
		});
		// One copy of the stale file, and an upload elsewhere that copies nothing.
		const copies = [
			{ fileId: 'copy', path: 'Play/s.png', copyOf: stale.remoteId },
			{ fileId: 'own', path: 'Play/own.png' },
		];
		await db.opQueue.bulkAdd(
			copies.map((op) => ({
				connectionId: CONNECTION,
				op: 'upload' as const,
				attempts: 0,
				queuedAt: 0,
				...op,
			}))
		);

		await deleteFolder(db, 'Work', scope);

		expect(await db.fileBytes.count()).toBe(0);
		expect((await queued(db)).slice(0, 2)).toEqual([
			{ op: 'upload', path: 'Play/s.png', fileId: 'copy', copyOf: stale.remoteId },
			{ op: 'upload', path: 'Play/own.png', fileId: 'own' },
		]);
	});

	it('leaves a copy reading from the remote when the bytes are not here', async () => {
		// The engine holds the delete back until the copy has read it.
		const db = freshDatabase();
		const going = await boundFile(db, 'Work/a.png');
		await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'upload',
			fileId: 'copy',
			path: 'Play/a.png',
			copyOf: going.remoteId,
			attempts: 0,
			queuedAt: 0,
		});

		await deleteFolder(db, 'Work', scope);

		expect((await queued(db))[0]).toMatchObject({ op: 'upload', copyOf: going.remoteId });
	});
});

// ---------------------------------------------------------------------------

/**
 * The app's writers, the Dexie store and the engine, over the fake provider.
 * `whileUploading`, once set, runs once while the next file's bytes are on
 * their way, for what the user does meanwhile.
 */
const connected = async () => {
	const db = freshDatabase();
	await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
	const store = createDexieSyncStore(db, scope);
	const fake = createFakeProvider();
	await fake.ensureRoot();
	const meanwhile: { whileUploading?: () => Promise<unknown> } = {};
	const provider: StorageProvider = {
		...fake,
		createFile: async (...args) => {
			const during = meanwhile.whileUploading;
			meanwhile.whileUploading = undefined;
			if (during !== undefined) await during();
			return fake.createFile(...args);
		},
	};
	const engine = createSyncEngine({
		provider,
		store,
		now: () => new Date('2026-10-03T10:00:00Z'),
	});
	return { db, fake, engine, meanwhile };
};

/** As though the cursor were lost: the next pull is a full scan. */
const forgetCursor = async (db: NotesDatabase) => {
	const state = await db.syncState.get(CONNECTION);
	if (state === undefined) throw new Error('no state');
	const { cursor: _cursor, ...rest } = state;
	await db.syncState.put(rest);
};

/** Every file on the remote that is not a note, by path, as its text. */
const remoteAttachments = async (fake: FakeProvider) =>
	Object.fromEntries(
		await Promise.all(
			fake
				.snapshot()
				.filter(
					(entry) =>
						entry.kind === 'file' &&
						!isHidden(entry.path) &&
						!entry.path.endsWith('.md')
				)
				.map(async (entry): Promise<[string, string]> => [
					entry.path,
					new TextDecoder().decode((await fake.readBytes(entry)).bytes),
				])
		)
	);

const remoteFolders = (fake: FakeProvider) =>
	fake
		.snapshot()
		.filter((entry) => entry.kind === 'folder')
		.map((entry) => entry.path);

describe('files beside notes, pushed', () => {
	it('uploads a file beside its note, and binds the row to it', async () => {
		const { db, fake, engine } = await connected();
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'Trip' });
		const added = await attach(db, note.id, 'Holiday.jpg', 'sun');
		await saveNoteBody(db, note.id, `# Trip\n\n${added.markdown}\n`, undefined, scope);

		expect((await engine.sync()).status).toBe('ok');

		expect(await remoteAttachments(fake)).toEqual({ [added.path]: 'sun' });
		expect(fake.contentAt(note.path)).toContain(added.markdown);
		const row = await db.files.get([CONNECTION, added.fileId]);
		expect(row?.remoteId).toBeDefined();
		expect((await heldFor(db, { id: added.fileId }))?.pinned).toBe(0);
		expect(await db.opQueue.count()).toBe(0);
	});

	it('moves a file with its note, and copies one a note left behind links', async () => {
		const { db, fake, engine } = await connected();
		await createFolder(db, { ...scope, name: 'Play' });
		const one = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const two = await createNote(db, { ...scope, folderPath: 'Work', title: 'Two' });
		const own = await attach(db, one.id, 'own.png', 'own');
		const shared = await attach(db, one.id, 'shared.png', 'shared');
		await saveNoteBody(db, one.id, `${own.markdown} ${shared.markdown}\n`, undefined, scope);
		await saveNoteBody(db, two.id, `${shared.markdown}\n`, undefined, scope);
		await engine.sync();

		await moveNote(db, one.id, 'Play', scope);
		expect((await engine.sync()).status).toBe('ok');

		expect(await remoteAttachments(fake)).toEqual({
			[`Play/${own.href}`]: 'own',
			[`Play/${shared.href}`]: 'shared',
			[`Work/${shared.href}`]: 'shared',
		});
		expect(await db.opQueue.count()).toBe(0);
		// And a rescan agrees: nothing the push did is undone by the pull.
		expect((await engine.sync()).status).toBe('ok');
		expect((await fileRows(db)).map((file) => file.path)).toEqual([
			`Play/${own.href}`,
			`Play/${shared.href}`,
			`Work/${shared.href}`,
		]);
	});

	it('copies a file the device never downloaded from the remote', async () => {
		const { db, fake, engine } = await connected();
		await createFolder(db, { ...scope, name: 'Play' });
		const one = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const two = await createNote(db, { ...scope, folderPath: 'Work', title: 'Two' });
		const shared = await attach(db, one.id, 'shared.png', 'shared');
		await saveNoteBody(db, one.id, `${shared.markdown}\n`, undefined, scope);
		await saveNoteBody(db, two.id, `${shared.markdown}\n`, undefined, scope);
		await engine.sync();
		// As a device that only ever pulled it has it: a row and no bytes.
		await db.fileBytes.clear();

		await moveNote(db, one.id, 'Play', scope);
		expect((await engine.sync()).status).toBe('ok');

		expect(await remoteAttachments(fake)).toEqual({
			[`Play/${shared.href}`]: 'shared',
			[`Work/${shared.href}`]: 'shared',
		});
	});

	it('takes a notebook and its files off the remote, and it stays gone', async () => {
		const { db, fake, engine } = await connected();
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const added = await attach(db, note.id, 'a.png', 'a');
		await saveNoteBody(db, note.id, `${added.markdown}\n`, undefined, scope);
		await engine.sync();
		await engine.sync();

		await deleteFolder(db, 'Work', scope);
		expect((await engine.sync()).status).toBe('ok');

		expect(await remoteAttachments(fake)).toEqual({});
		expect(remoteFolders(fake)).not.toContain('Work');
		expect((await engine.sync()).status).toBe('ok');
		expect(await db.files.count()).toBe(0);
		expect(await db.folders.count()).toBe(0);
	});

	it.each([
		['deleted', (db: NotesDatabase) => deleteFolder(db, 'Work', scope), false],
		['moved', (db: NotesDatabase) => moveFolder(db, 'Work', 'Play', scope), true],
	])(
		'leaves no directory behind a notebook %s while its file was on its way',
		async (_how, change, moved) => {
			// The `rmdir` is queued first, and the file's delete or move only
			// once the upload lands: run first, it found the file there.
			const { db, fake, engine, meanwhile } = await connected();
			const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
			await engine.sync();
			await engine.sync();
			const added = await attach(db, note.id, 'a.png', 'a');
			await saveNoteBody(db, note.id, `${added.markdown}\n`, undefined, scope);
			meanwhile.whileUploading = () => change(db);

			await engine.sync();
			await engine.sync();

			expect(await remoteAttachments(fake)).toEqual(
				moved ? { [`Play/${added.href}`]: 'a' } : {}
			);
			expect(remoteFolders(fake)).not.toContain('Work');
			expect(await db.opQueue.count()).toBe(0);
			await forgetCursor(db);
			expect((await engine.sync()).status).toBe('ok');
			expect((await db.folders.toArray()).map((folder) => folder.path)).not.toContain('Work');
		}
	);

	it('sends a note up after a file it links that another note added first', async () => {
		const { db, fake, engine, meanwhile } = await connected();
		const one = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const two = await createNote(db, { ...scope, folderPath: 'Work', title: 'Two' });
		await attach(db, two.id, 'a.png', 'same');
		const again = await attach(db, one.id, 'a.png', 'same');
		await saveNoteBody(db, one.id, `# One\n\n${again.markdown}\n`, undefined, scope);
		const seen: { text?: string } = {};
		meanwhile.whileUploading = async () => {
			seen.text = fake.contentAt((await noteById(db, one.id))?.path ?? '');
		};

		expect((await engine.sync()).status).toBe('ok');

		expect(seen.text ?? '').not.toContain(again.href);
		expect(fake.contentAt(one.path)).toContain(again.href);
	});

	it('moves a notebook and its files, and leaves no directory behind', async () => {
		const { db, fake, engine } = await connected();
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const added = await attach(db, note.id, 'a.png', 'a');
		await saveNoteBody(db, note.id, `${added.markdown}\n`, undefined, scope);
		await engine.sync();
		await engine.sync();

		await moveFolder(db, 'Work', 'Play', scope);
		expect((await engine.sync()).status).toBe('ok');

		expect(await remoteAttachments(fake)).toEqual({ [`Play/${added.href}`]: 'a' });
		expect(remoteFolders(fake)).not.toContain('Work');
		expect((await engine.sync()).status).toBe('ok');
		expect((await fileRows(db)).map((file) => file.path)).toEqual([`Play/${added.href}`]);
	});
});

describe('a source let go with a file not uploaded', () => {
	const ADA = { connectionId: CONNECTION, provider: 'dropbox', accountId: 'dbid:ada' } as const;

	it('keeps its upload while detached, and sends it once connected again', async () => {
		const db = freshDatabase();
		await bindConnection(db, ADA);
		const note = await createNote(db, { ...scope, title: 'A' });
		const added = await attach(db, note.id, 'a.png', 'a');

		await detachConnection(db, { connectionId: CONNECTION });

		expect((await unsyncedIn(db, CONNECTION)).files).toHaveLength(1);
		expect(await queued(db)).toContainEqual({
			op: 'upload',
			path: added.path,
			fileId: added.fileId,
		});
		await bindConnection(db, ADA);
		const fake = createFakeProvider();
		await fake.ensureRoot();
		const store = createDexieSyncStore(db, scope);
		expect((await createSyncEngine({ provider: fake, store }).sync()).status).toBe('ok');
		expect(await remoteAttachments(fake)).toEqual({ [added.path]: 'a' });
		expect((await unsyncedIn(db, CONNECTION)).files).toEqual([]);
	});

	it('keeps a file delete owed while detached', async () => {
		const db = freshDatabase();
		await bindConnection(db, ADA);
		await createNote(db, { ...scope, title: 'A' });
		const file = await boundFile(db, 'Work/a.png');
		await db.files.delete([CONNECTION, file.id]);
		await queueDeleteFile(db, file);

		await detachConnection(db, { connectionId: CONNECTION });

		expect(await queued(db)).toContainEqual({
			op: 'delete-file',
			path: 'Work/a.png',
			remoteId: file.remoteId,
		});
	});

	it('forgets it, row and bytes, with a source the user discards', async () => {
		const db = freshDatabase();
		await bindConnection(db, ADA);
		const note = await createNote(db, { ...scope, title: 'A' });
		await attach(db, note.id, 'a.png', 'a');
		await detachConnection(db, { connectionId: CONNECTION });
		const seen = seenIn(await unsyncedIn(db, CONNECTION));

		expect(
			await releaseConnection(db, { connectionId: CONNECTION, unsynced: 'discard', seen })
		).toBe('released');

		expect(await db.files.count()).toBe(0);
		expect(await db.fileBytes.count()).toBe(0);
	});

	it('forgets the files of an import the user cancels', async () => {
		const db = freshDatabase();
		await bindConnection(db, ADA);
		await db.files.put({ connectionId: CONNECTION, id: 'x1', path: 'a.png', size: 1 });
		await db.fileBytes.put({
			connectionId: CONNECTION,
			id: 'x1',
			bytes: bytesOf('a'),
			pinned: 1,
			lastUsedAt: 0,
		});

		expect(await abandonImport(db, CONNECTION)).toBe('abandoned');

		expect(await db.files.count()).toBe(0);
		expect(await db.fileBytes.count()).toBe(0);
	});
});

describe("one source's files, and never another's at the same paths", () => {
	const OTHER = 'onedrive-1';

	/** A file the other source's remote has. */
	const theirs = async (db: NotesDatabase, path: string, size = 5): Promise<FileRecord> => {
		const file: FileRecord = {
			connectionId: OTHER,
			id: `o-${path}`,
			path,
			remoteId: `ro-${path}`,
			remoteVersion: 'v1',
			size,
		};
		await db.files.put(file);
		return file;
	};
	const filesOf = (db: NotesDatabase, connectionId: string) =>
		db.files.where('connectionId').equals(connectionId).sortBy('path');
	const opsOf = (db: NotesDatabase, connectionId: string) =>
		db.opQueue.where('connectionId').equals(connectionId).toArray();

	it('adds a file of its own beside one the other has at that name', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { ...scope, folderPath: 'Work', title: 'One' });
		const other = await theirs(db, `Work/${await stamped('a', 'a', 'png')}`, 1);

		const added = await attach(db, note.id, 'a.png', 'a');

		expect(added.fileId).not.toBe(other.id);
		expect(textOf((await heldFor(db, { id: added.fileId }))?.bytes)).toBe('a');
	});

	it("moves and deletes a notebook's files, and none of the other's", async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		const mine = await boundFile(db, 'Work/a.png');
		const others = [await theirs(db, 'Work/a.png'), await theirs(db, 'Play/x.png')];

		await moveFolder(db, 'Work', 'Play', scope);

		expect(await filesOf(db, CONNECTION)).toEqual([{ ...mine, path: 'Play/a.png' }]);
		await deleteFolder(db, 'Play', scope);
		expect(await filesOf(db, CONNECTION)).toEqual([]);
		expect(await filesOf(db, OTHER)).toEqual(
			[...others].sort((a, b) => a.path.localeCompare(b.path))
		);
		expect(await opsOf(db, OTHER)).toEqual([]);
	});

	it("carries a note's file past the other's notes and files", async () => {
		const db = freshDatabase();
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Play' });
		const note = await pushedNote(db, 'Work/One.md', '# One\n\n![a](a.png)\n');
		const mine = await boundFile(db, 'Work/a.png');
		await theirs(db, 'Play/a.png');
		await importNoteFile(db, {
			connectionId: OTHER,
			path: 'Work/Two.md',
			source: '# Two\n\n![a](a.png)\n',
		});
		await db.opQueue.clear();

		await moveNote(db, note.id, 'Play', scope);

		expect(await filesOf(db, CONNECTION)).toEqual([{ ...mine, path: 'Play/a.png' }]);
	});

	it('hands the bytes of a file going to its own copies only', async () => {
		const db = freshDatabase();
		const going = await boundFile(db, 'Work/a.png');
		await db.fileBytes.put({
			connectionId: CONNECTION,
			id: going.id,
			bytes: bytesOf('a'),
			version: 'v1',
			pinned: 0,
			lastUsedAt: 1,
		});
		await db.files.put({ connectionId: OTHER, id: 'copy', path: 'Play/a.png', size: 5 });
		await db.opQueue.add({
			connectionId: OTHER,
			op: 'upload',
			fileId: 'copy',
			path: 'Play/a.png',
			copyOf: going.remoteId,
			attempts: 0,
			queuedAt: 0,
		});

		await deleteFolder(db, 'Work', scope);

		expect(await db.fileBytes.get([OTHER, 'copy'])).toBeUndefined();
		expect((await opsOf(db, OTHER)).map((op) => op.copyOf)).toEqual([going.remoteId]);
	});

	it('lists its own paths only', async () => {
		const db = freshDatabase();
		await boundFile(db, 'Work/a.png');
		await theirs(db, 'Play/b.png');

		expect(await listFilePaths(db, scope)).toEqual(['Work/a.png']);
	});
});
