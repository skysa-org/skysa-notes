import { ROOT } from '@skysa/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import {
	getLastOpen,
	lastWritten,
	noteIsUnder,
	pickNote,
	rememberOpen,
} from '../src/store/lastOpen.js';
import { createNote, deleteNote } from '../src/store/notes.js';
import { updateNote } from './noteRows.js';

let db: NotesDatabase;
let counter = 0;

beforeEach(() => {
	counter += 1;
	db = createDatabase(`test-last-open-${counter}`);
});

afterEach(async () => {
	await db.delete();
});

const pick = (folderPath: string, open?: string, remembered?: string) =>
	pickNote(db, { connectionId: LOCAL_CONNECTION_ID, folderPath, open, remembered });

describe('remembering where the user was', () => {
	it('is nothing until something is remembered', async () => {
		expect(await getLastOpen(db, LOCAL_CONNECTION_ID)).toEqual({ notes: {} });
	});

	it('keeps the notebook, and the note in each notebook', async () => {
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', 'w1');
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Home', 'h1');
		// A notebook opened with no note in it keeps the note it had.
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work');

		expect(await getLastOpen(db, LOCAL_CONNECTION_ID)).toEqual({
			folder: 'Work',
			notes: { Work: 'w1', Home: 'h1' },
		});
	});

	it('keeps each source apart', async () => {
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', 'w1');
		await rememberOpen(db, 'c-dropbox', 'Inbox', 'i1');

		expect((await getLastOpen(db, LOCAL_CONNECTION_ID)).folder).toBe('Work');
		expect((await getLastOpen(db, 'c-dropbox')).folder).toBe('Inbox');
	});

	it('writes nothing where it would change nothing', async () => {
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', 'w1');
		const was = lastWritten(db, LOCAL_CONNECTION_ID);
		const puts: unknown[] = [];
		db.prefs.hook('creating', (key) => {
			puts.push(key);
		});
		db.prefs.hook('updating', (_changes, key) => {
			puts.push(key);
		});

		// The same place again, and the notebook again with no note in it.
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', 'w1');
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work');

		expect(puts).toEqual([]);
		// Nor handed out as this tab's newest write.
		expect(lastWritten(db, LOCAL_CONNECTION_ID)).toBe(was);
	});

	it('forgets the notebooks opened longest ago once it holds two hundred', async () => {
		for (let index = 0; index < 205; index += 1) {
			await rememberOpen(db, LOCAL_CONNECTION_ID, `Notebook ${index}`, `n${index}`);
		}
		// Opened again, so newest rather than oldest.
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Notebook 0', 'again');

		const { notes } = await getLastOpen(db, LOCAL_CONNECTION_ID);
		expect(Object.keys(notes)).toHaveLength(200);
		expect(notes['Notebook 0']).toBe('again');
		expect(notes['Notebook 1']).toBeUndefined();
		expect(notes['Notebook 204']).toBe('n204');
	});

	it('reads a row it cannot use as nothing remembered', async () => {
		await db.prefs.put({ key: `lastOpen:${LOCAL_CONNECTION_ID}`, value: '{"folder": 3' });
		expect(await getLastOpen(db, LOCAL_CONNECTION_ID)).toEqual({ notes: {} });
		await db.prefs.put({ key: `lastOpen:${LOCAL_CONNECTION_ID}`, value: '{"notes": [1]}' });
		expect(await getLastOpen(db, LOCAL_CONNECTION_ID)).toEqual({ notes: {} });
	});
});

describe('which note to open', () => {
	it('is the one asked for, wherever it is, while it is there', async () => {
		const asked = await createNote(db, { folderPath: 'Home', title: 'Asked' });
		await createNote(db, { folderPath: 'Work', title: 'Other' });
		expect(await pick('Work', asked.id)).toBe(asked.id);
	});

	it('is the one open last in the notebook when none is asked for', async () => {
		const older = await createNote(db, { folderPath: 'Work', title: 'Older' });
		await createNote(db, { folderPath: 'Work', title: 'Newer' });
		expect(await pick('Work', undefined, older.id)).toBe(older.id);
	});

	it('is the one open last in a notebook inside this one', async () => {
		// Clicking a parent of the note's own notebook keeps the note open, so it
		// is what is remembered for the parent.
		const deep = await createNote(db, { folderPath: 'Work/Alpha', title: 'Deep' });
		expect(await pick('Work', undefined, deep.id)).toBe(deep.id);
	});

	it('is the newest note when the one open last has been deleted, or moved out', async () => {
		const older = await createNote(db, { folderPath: 'Work', title: 'Older' });
		const newer = await createNote(db, { folderPath: 'Work', title: 'Newer' });
		const moved = await createNote(db, { folderPath: 'Home', title: 'Moved' });
		await updateNote(db, older.id, { createdAt: 1_000 });
		await updateNote(db, newer.id, { createdAt: 2_000 });
		await deleteNote(db, older.id);

		expect(await pick('Work', undefined, older.id)).toBe(newer.id);
		expect(await pick('Work', undefined, moved.id)).toBe(newer.id);
	});

	it('is the newest note when the one asked for has been deleted', async () => {
		const gone = await createNote(db, { folderPath: 'Work', title: 'Gone' });
		const kept = await createNote(db, { folderPath: 'Work', title: 'Kept' });
		await deleteNote(db, gone.id);
		expect(await pick('Work', gone.id)).toBe(kept.id);
	});

	it('is none for an empty notebook', async () => {
		expect(await pick('Work', 'nothing', 'nothing either')).toBeNull();
	});
});

describe('a note under a notebook', () => {
	it('is in it, or in one inside it', () => {
		expect(noteIsUnder('Work/a.md', 'Work')).toBe(true);
		expect(noteIsUnder('Work/Alpha/a.md', 'Work')).toBe(true);
		expect(noteIsUnder('Home/a.md', 'Work')).toBe(false);
	});

	it('is loose only when it sits at the root itself', () => {
		expect(noteIsUnder('a.md', ROOT)).toBe(true);
		expect(noteIsUnder('Work/a.md', ROOT)).toBe(false);
	});
});
