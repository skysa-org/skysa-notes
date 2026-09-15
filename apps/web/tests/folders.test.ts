import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import {
	createFolder,
	deleteFolder,
	ensureFolder,
	folderTree,
	listFolders,
	moveFolder,
	renameFolder,
} from '../src/store/folders.js';
import { createNote, getNote, listNotes, saveNoteBody } from '../src/store/notes.js';

let db: NotesDatabase;
let counter = 0;

beforeEach(() => {
	counter += 1;
	db = createDatabase(`test-folders-${counter}`);
});

afterEach(async () => {
	await db.delete();
});

describe('ensureFolder', () => {
	it('creates every missing parent', async () => {
		await ensureFolder(db, 'work/meetings/2026');
		expect(await folderTree(db)).toEqual(['work', 'work/meetings', 'work/meetings/2026']);
	});

	it('is idempotent', async () => {
		await ensureFolder(db, 'work');
		const second = await ensureFolder(db, 'work');
		expect(second).toEqual([]);
		expect(await folderTree(db)).toEqual(['work']);
	});

	it('does nothing for the root', async () => {
		await ensureFolder(db, '');
		expect(await folderTree(db)).toEqual([]);
	});
});

describe('createFolder', () => {
	/**
	 * The existence check and the create are one step. Made separately, two
	 * concurrent creates of one name both passed the check and both reported
	 * success — harmless in the store, since `ensureFolder` is idempotent and one
	 * row results, but this is the one function whose refusal the user is shown,
	 * so a check that only usually refuses is the wrong kind.
	 */
	it('refuses the second of two creates of the same name', async () => {
		const results = await Promise.allSettled([
			createFolder(db, { name: 'Work' }),
			createFolder(db, { name: 'Work' }),
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(await listFolders(db)).toHaveLength(1);
	});

	it('keeps the name the user typed: a notebook name is a directory name', async () => {
		const folder = await createFolder(db, { name: 'Work Notes' });
		expect(folder.path).toBe('Work Notes');
	});

	it('strips only what would actually break a path', async () => {
		expect((await createFolder(db, { name: 'Q3 / Q4: plans?' })).path).toBe('Q3 Q4 plans');
	});

	it('refuses to create a hidden folder, which the UI would never show', async () => {
		expect((await createFolder(db, { name: '.git' })).path).toBe('git');
	});

	it('nests under a parent', async () => {
		await createFolder(db, { name: 'Work' });
		const nested = await createFolder(db, { parentPath: 'Work', name: 'Meetings' });
		expect(nested.path).toBe('Work/Meetings');
	});

	it('refuses to create one twice', async () => {
		await createFolder(db, { name: 'Work' });
		await expect(createFolder(db, { name: 'Work' })).rejects.toThrow(/already exists/);
	});
});

describe('listFolders', () => {
	it('can be restricted to direct children', async () => {
		await ensureFolder(db, 'work/meetings');
		await ensureFolder(db, 'personal');

		expect((await listFolders(db, { parentPath: '' })).map((f) => f.path)).toEqual([
			'personal',
			'work',
		]);
		expect((await listFolders(db, { parentPath: 'work' })).map((f) => f.path)).toEqual([
			'work/meetings',
		]);
	});
});

describe('moveFolder', () => {
	it('rewrites the paths of nested folders and notes', async () => {
		await ensureFolder(db, 'work/meetings');
		const note = await createNote(db, { title: 'Standup', folderPath: 'work/meetings' });

		await moveFolder(db, 'work', 'archive/work');

		expect(await folderTree(db)).toEqual(['archive', 'archive/work', 'archive/work/meetings']);
		expect((await getNote(db, note.id))?.path).toBe('archive/work/meetings/standup.md');
	});

	it('leaves notes outside the moved folder alone', async () => {
		const outside = await createNote(db, { title: 'Outside' });
		await createNote(db, { title: 'Inside', folderPath: 'work' });

		await moveFolder(db, 'work', 'archive');
		expect((await getNote(db, outside.id))?.path).toBe('outside.md');
	});

	it('does not dirty a clean note: a folder move is metadata only', async () => {
		await createNote(db, { title: 'Note', folderPath: 'work' });
		const notes = await listNotes(db, { folderPath: 'work' });
		const note = notes[0];
		expect(note).toBeDefined();
		// Simulate a note that has already been pushed.
		await db.notes.update(note!.id, { dirty: 0 });

		await moveFolder(db, 'work', 'archive');

		const moved = await getNote(db, note!.id);
		expect(moved?.path).toBe('archive/note.md');
		expect(moved?.dirty).toBe(0);
	});

	it('keeps a dirty note dirty, and keeps its pending edit', async () => {
		const note = await createNote(db, { title: 'Note', folderPath: 'work' });
		await saveNoteBody(db, note.id, '# Pending edit\n');

		await moveFolder(db, 'work', 'archive');

		const moved = await getNote(db, note.id);
		expect(moved?.dirty).toBe(1);
		expect(moved?.body).toBe('# Pending edit\n');
		expect(moved?.path).toBe('archive/note.md');
	});

	it('refuses to move the root', async () => {
		await expect(moveFolder(db, '', 'somewhere')).rejects.toThrow(
			/root folder cannot be moved/
		);
	});

	it('refuses to move a folder inside itself', async () => {
		await ensureFolder(db, 'work');
		await expect(moveFolder(db, 'work', 'work/nested')).rejects.toThrow(/inside itself/);
	});
});

describe('renameFolder', () => {
	it('renames in place, keeping the name as typed', async () => {
		await ensureFolder(db, 'work/meetings');
		await renameFolder(db, 'work/meetings', 'Team Meetings');

		expect(await folderTree(db)).toEqual(['work', 'work/Team Meetings']);
	});
});

describe('deleteFolder', () => {
	it('removes the folder and tombstones the notes inside it', async () => {
		const note = await createNote(db, { title: 'Doomed', folderPath: 'work' });
		await deleteFolder(db, 'work');

		expect(await folderTree(db)).toEqual([]);

		const stored = await getNote(db, note.id);
		expect(stored?.deletedLocally).toBe(1);
		// Still dirty, so the delete is pushed rather than only dropped locally.
		expect(stored?.dirty).toBe(1);
	});

	it('cascades into nested folders', async () => {
		const deep = await createNote(db, { title: 'Deep', folderPath: 'work/meetings/2026' });
		await deleteFolder(db, 'work');

		expect(await folderTree(db)).toEqual([]);
		expect((await getNote(db, deep.id))?.deletedLocally).toBe(1);
	});

	it('leaves sibling folders and their notes alone', async () => {
		const kept = await createNote(db, { title: 'Kept', folderPath: 'personal' });
		await createNote(db, { title: 'Doomed', folderPath: 'work' });

		await deleteFolder(db, 'work');

		expect(await folderTree(db)).toEqual(['personal']);
		expect((await getNote(db, kept.id))?.deletedLocally).toBe(0);
	});

	it('refuses to delete the root', async () => {
		await expect(deleteFolder(db, '')).rejects.toThrow(/root folder cannot be deleted/);
	});
});
