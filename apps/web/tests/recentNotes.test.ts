import { beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_CONNECTION_ID, noteRef, type NotesDatabase } from '../src/store/db.js';
import { createNote, deleteNote } from '../src/store/notes.js';
import {
	getRecentKeys,
	listRecentNotes,
	RECENT_KEPT,
	RECENT_SHOWN,
	rememberRecent,
} from '../src/store/recentNotes.js';
import { updateNote } from './noteRows.js';
import { freshDatabase } from './support/db.js';

/**
 * The notes opened lately on this device, which the search field lists before
 * anything is typed in it. What is remembered, and which of those are listed.
 */

let db: NotesDatabase;
beforeEach(() => {
	db = freshDatabase();
});

const DROPBOX = 'c-dropbox';

const opened = (noteId: string, connectionId = LOCAL_CONNECTION_ID) =>
	rememberRecent(db, connectionId, noteId);

const titles = async (skip?: string) => (await listRecentNotes(db, skip)).map((note) => note.title);

describe('remembering the notes opened', () => {
	it('is nothing until a note is opened', async () => {
		expect(await getRecentKeys(db)).toEqual([]);
		expect(await listRecentNotes(db)).toEqual([]);
	});

	it('keeps them newest first, and a note opened again moves to the front', async () => {
		await opened('a');
		await opened('b');
		await opened('c');
		await opened('a');

		expect(await getRecentKeys(db)).toEqual([
			[LOCAL_CONNECTION_ID, 'a'],
			[LOCAL_CONNECTION_ID, 'c'],
			[LOCAL_CONNECTION_ID, 'b'],
		]);
	});

	it('keeps one id in two sources as two notes', async () => {
		// A folder copied from one account to another carries its notes' ids.
		await opened('a');
		await opened('a', DROPBOX);

		expect(await getRecentKeys(db)).toEqual([
			[DROPBOX, 'a'],
			[LOCAL_CONNECTION_ID, 'a'],
		]);
	});

	it('writes nothing for the note at the front already', async () => {
		// Which is what reopening the app on the note it was left on asks.
		await opened('a');
		const puts: unknown[] = [];
		db.prefs.hook('creating', (key) => {
			puts.push(key);
		});
		db.prefs.hook('updating', (_changes, key) => {
			puts.push(key);
		});

		await opened('a');

		expect(puts).toEqual([]);
	});

	it('forgets the ones opened longest ago', async () => {
		for (let index = 0; index < RECENT_KEPT + 5; index += 1) {
			await opened(`n${String(index)}`);
		}

		const keys = await getRecentKeys(db);
		expect(keys).toHaveLength(RECENT_KEPT);
		expect(keys[0]).toEqual([LOCAL_CONNECTION_ID, `n${String(RECENT_KEPT + 4)}`]);
		expect(keys).not.toContainEqual([LOCAL_CONNECTION_ID, 'n4']);
	});

	it('reads a row it cannot use as nothing opened', async () => {
		await db.prefs.put({ key: 'recentNotes', value: '{"not":"a list"}' });
		expect(await getRecentKeys(db)).toEqual([]);

		await db.prefs.put({ key: 'recentNotes', value: 'not json' });
		expect(await getRecentKeys(db)).toEqual([]);

		// And starts again from there.
		await opened('a');
		expect(await getRecentKeys(db)).toEqual([[LOCAL_CONNECTION_ID, 'a']]);
	});
});

describe('the notes listed', () => {
	it('are the notes themselves, newest opened first, in every source', async () => {
		const birds = await createNote(db, { folderPath: 'Work', title: 'Birds' });
		const rivers = await createNote(db, {
			connectionId: DROPBOX,
			folderPath: 'Work',
			title: 'Rivers',
		});
		await opened(birds.id);
		await opened(rivers.id, DROPBOX);

		expect(await titles()).toEqual(['Rivers', 'Birds']);
	});

	it('leave out the note on screen', async () => {
		const birds = await createNote(db, { folderPath: 'Work', title: 'Birds' });
		const rivers = await createNote(db, { folderPath: 'Work', title: 'Rivers' });
		await opened(birds.id);
		await opened(rivers.id);

		expect(await titles(noteRef(rivers))).toEqual(['Birds']);
	});

	it('leave out a note deleted, or gone from the device', async () => {
		const birds = await createNote(db, { folderPath: 'Work', title: 'Birds' });
		const rivers = await createNote(db, { folderPath: 'Work', title: 'Rivers' });
		await opened(birds.id);
		await opened(rivers.id);
		await opened('never-here');

		await deleteNote(db, rivers.id);

		expect(await titles()).toEqual(['Birds']);
	});

	it('leave out scratch cards and password items, which are not notes to list', async () => {
		const birds = await createNote(db, { folderPath: 'Work', title: 'Birds' });
		const card = await createNote(db, { folderPath: 'Work', title: 'Card' });
		const item = await createNote(db, { folderPath: 'Work', title: 'Bank' });
		await updateNote(db, card.id, { path: '.scratchpad/Card.md' });
		await updateNote(db, item.id, { path: '.vault/Bank.md' });
		await opened(birds.id);
		await opened(card.id);
		await opened(item.id);

		expect(await titles()).toEqual(['Birds']);
	});

	it('follow a note renamed or moved, which keeps its id', async () => {
		const birds = await createNote(db, { folderPath: 'Work', title: 'Birds' });
		await opened(birds.id);

		await updateNote(db, birds.id, { path: 'Archive/Herons.md', title: 'Herons' });

		expect(await titles()).toEqual(['Herons']);
	});

	it(`are at most ${String(RECENT_SHOWN)}`, async () => {
		for (let index = 0; index < RECENT_SHOWN + 3; index += 1) {
			const note = await createNote(db, {
				folderPath: 'Work',
				title: `Note ${String(index)}`,
			});
			await opened(note.id);
		}

		const listed = await titles();
		expect(listed).toHaveLength(RECENT_SHOWN);
		expect(listed[0]).toBe(`Note ${String(RECENT_SHOWN + 2)}`);
	});
});
