import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { attachedFiles, deleteUnlinkedFiles } from '../src/store/fileLinks.js';
import { addAttachment } from '../src/store/files.js';
import { createNote, deleteNote, saveNoteBody } from '../src/store/notes.js';

/**
 * Which notes link a file beside them, and deleting one that none does
 * (`store/fileLinks.ts`): what a notebook's Attached files lists and deletes.
 */

const CONNECTION = 'dropbox-1';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`file-links-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

/** A file the remote has, in the store as a pull leaves it: a row, bound. */
const bound = async (db: NotesDatabase, id: string, path: string, size = 10) => {
	await db.files.put({ connectionId: CONNECTION, id, path, size, remoteId: `r-${id}` });
	await db.fileBytes.put({
		connectionId: CONNECTION,
		id,
		bytes: new ArrayBuffer(size),
		pinned: 0,
		lastUsedAt: 1,
		version: 'v1',
	});
};

const note = (db: NotesDatabase, folderPath: string, title: string, body: string) =>
	createNote(db, { connectionId: CONNECTION, folderPath, title, body });

const ops = async (db: NotesDatabase) =>
	(await db.opQueue.orderBy('seq').toArray()).map((op) => ({ op: op.op, path: op.path }));

describe('the files in a notebook', () => {
	it('are the ones directly in it, by name, each with the notes that link it', async () => {
		const db = freshDatabase();
		await bound(db, 'b', 'Work/b.png');
		await bound(db, 'a', 'Work/a.pdf', 2048);
		await bound(db, 'deeper', 'Work/Old/c.png');
		await bound(db, 'elsewhere', 'Home/d.png');
		await note(db, 'Work', 'Plan', '![b](b.png) and [a.pdf](a.pdf)\n');
		await note(db, 'Home', 'From home', '![b](../Work/b.png)\n');
		await note(db, 'Work', 'Unrelated', 'No pictures here.\n');

		const files = await attachedFiles(db, CONNECTION, 'Work');

		expect(files).toEqual([
			{
				id: 'a',
				path: 'Work/a.pdf',
				name: 'a.pdf',
				size: 2048,
				linkedBy: [expect.objectContaining({ title: 'Plan', deleted: false })],
			},
			{
				id: 'b',
				path: 'Work/b.png',
				name: 'b.png',
				size: 10,
				linkedBy: [
					expect.objectContaining({ title: 'Plan' }),
					expect.objectContaining({ title: 'From home' }),
				],
			},
		]);
	});

	it('says a file no note links is linked by none', async () => {
		const db = freshDatabase();
		await bound(db, 'a', 'Work/a.png');
		await note(db, 'Work', 'Plan', 'Text only.\n');

		const [file] = await attachedFiles(db, CONNECTION, 'Work');

		expect(file?.linkedBy).toEqual([]);
	});

	it.each([
		['spelled with other capitals', '![a](A.PNG)\n'],
		['spelled with a percent', '![a](%61.png)\n'],
		['in html', '<img src="a.png">\n'],
		['by a reference', '![a][pic]\n\n[pic]: a.png\n'],
	])('counts a link %s', async (_how, body) => {
		const db = freshDatabase();
		await bound(db, 'a', 'Work/a.png');
		await note(db, 'Work', 'Plan', body);

		const [file] = await attachedFiles(db, CONNECTION, 'Work');

		expect(file?.linkedBy.map((linking) => linking.title)).toEqual(['Plan']);
	});

	it('counts a note deleted and not yet sent, and says so', async () => {
		const db = freshDatabase();
		await bound(db, 'a', 'Work/a.png');
		const plan = await note(db, 'Work', 'Plan', '![a](a.png)\n');
		await deleteNote(db, plan.id, { connectionId: CONNECTION });

		const [file] = await attachedFiles(db, CONNECTION, 'Work');

		expect(file?.linkedBy).toEqual([expect.objectContaining({ title: 'Plan', deleted: true })]);
	});

	it('are only the source’s own', async () => {
		const db = freshDatabase();
		await bound(db, 'a', 'Work/a.png');

		expect(await attachedFiles(db, 'another', 'Work')).toEqual([]);
	});
});

describe('deleting a file no note links', () => {
	it('takes the row and the bytes, and owes the remote a delete', async () => {
		const db = freshDatabase();
		await bound(db, 'a', 'Work/a.png');
		await note(db, 'Work', 'Plan', 'Text only.\n');
		await db.opQueue.clear();

		expect(await deleteUnlinkedFiles(db, CONNECTION, ['a'])).toEqual(['Work/a.png']);

		expect(await db.files.get([CONNECTION, 'a'])).toBeUndefined();
		expect(await db.fileBytes.get([CONNECTION, 'a'])).toBeUndefined();
		expect(await ops(db)).toEqual([{ op: 'delete-file', path: 'Work/a.png' }]);
	});

	it('withdraws the upload of one not sent yet, and owes nothing more', async () => {
		const db = freshDatabase();
		const plan = await note(db, 'Work', 'Plan', 'Text only.\n');
		const added = await addAttachment(db, {
			connectionId: CONNECTION,
			noteId: plan.id,
			name: 'photo.png',
			bytes: new TextEncoder().encode('pixels').buffer,
		});
		// Added, and taken out of the note before it was ever sent.
		expect(await ops(db)).toContainEqual({ op: 'upload', path: added.path });

		expect(await deleteUnlinkedFiles(db, CONNECTION, [added.fileId])).toEqual([added.path]);

		expect((await ops(db)).map((op) => op.op)).not.toContain('upload');
		expect((await ops(db)).map((op) => op.op)).not.toContain('delete-file');
		expect(await db.fileBytes.get([CONNECTION, added.fileId])).toBeUndefined();
	});

	it('keeps one a note links now, whatever the list said', async () => {
		const db = freshDatabase();
		await bound(db, 'a', 'Work/a.png');
		const plan = await note(db, 'Work', 'Plan', 'Text only.\n');
		// Linked after the list was drawn.
		await saveNoteBody(db, plan.id, '![a](a.png)\n', undefined, { connectionId: CONNECTION });
		await db.opQueue.clear();

		expect(await deleteUnlinkedFiles(db, CONNECTION, ['a'])).toEqual([]);

		expect(await db.files.get([CONNECTION, 'a'])).toBeDefined();
		expect(await ops(db)).toEqual([]);
	});

	it('keeps one only a deleted note links, whose delete can be undone', async () => {
		const db = freshDatabase();
		await bound(db, 'a', 'Work/a.png');
		const plan = await note(db, 'Work', 'Plan', '![a](a.png)\n');
		await deleteNote(db, plan.id, { connectionId: CONNECTION });

		expect(await deleteUnlinkedFiles(db, CONNECTION, ['a'])).toEqual([]);
		expect(await db.files.get([CONNECTION, 'a'])).toBeDefined();
	});
});
