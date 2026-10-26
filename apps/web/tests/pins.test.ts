import { beforeEach, describe, expect, it } from 'vitest';

import { bindConnection, finishImport } from '../src/store/connection.js';
import { LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import { createFolder, deleteFolder, moveFolder, renameFolder } from '../src/store/folders.js';
import { pickNote } from '../src/store/lastOpen.js';
import { createNote, deleteNote, renameNote } from '../src/store/notes.js';
import {
	getBottomPinnedNotebooks,
	getPinnedNotebooks,
	getPinnedNotes,
	getPins,
	movePinnedNotebooks,
	type NotebookPin,
	pinnedFirst,
	pinnedToEnds,
	setNotebookPin,
	setNotePinned,
} from '../src/store/pins.js';
import { createDexieSyncStore } from '../src/sync/store.js';
import { freshDatabase } from './support/db.js';

let db: NotesDatabase;
beforeEach(() => {
	db = freshDatabase();
});

const scope = { connectionId: LOCAL_CONNECTION_ID };
const pinnedNotebooks = () => getPinnedNotebooks(db, LOCAL_CONNECTION_ID);
const pinnedNotes = () => getPinnedNotes(db, LOCAL_CONNECTION_ID);
const bottomNotebooks = () => getBottomPinnedNotebooks(db, LOCAL_CONNECTION_ID);

describe('pinned notebooks', () => {
	it('is none until one is pinned, and lets go of one unpinned', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Home' });
		expect(await pinnedNotebooks()).toEqual([]);

		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', undefined);

		expect(await pinnedNotebooks()).toEqual(['Home']);
	});

	it('is per source, and apart from which notebooks are open', async () => {
		await setNotebookPin(db, 'dropbox-1', 'Work', 'top');

		expect(await pinnedNotebooks()).toEqual([]);
		expect(await getPinnedNotebooks(db, 'dropbox-1')).toEqual(['Work']);
		expect(await db.prefs.get('openNotebooks:dropbox-1')).toBeUndefined();
	});

	it('reads a row it cannot use as none', async () => {
		await db.prefs.put({ key: `pinnedNotebooks:${LOCAL_CONNECTION_ID}`, value: '{not json' });
		expect(await pinnedNotebooks()).toEqual([]);
	});

	it('follows a notebook renamed or moved, and what is inside it', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, parentPath: 'Work', name: 'Old' });
		await createFolder(db, { ...scope, name: 'Home' });
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work/Old', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home', 'top');

		await renameFolder(db, 'Work', 'Job', scope);
		expect(await pinnedNotebooks()).toEqual(['Job/Old', 'Home']);

		await moveFolder(db, 'Job', 'Home/Job', scope);
		expect(await pinnedNotebooks()).toEqual(['Home/Job/Old', 'Home']);
	});

	it('keeps the pin of a notebook renamed only in case', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'top');

		await renameFolder(db, 'Work', 'work', scope);

		expect(await pinnedNotebooks()).toEqual(['work']);
	});

	it('lets go of a notebook that was there only for a note, once the note has gone', async () => {
		await createFolder(db, { ...scope, name: 'Home' });
		await createFolder(db, { ...scope, parentPath: 'Home', name: 'Kept' });
		const note = await createNote(db, { title: 'Draft', folderPath: 'Ideas' });
		await createNote(db, { title: 'Plan', folderPath: 'Work/Q3' });
		// Notebooks with no row of their own, as a pull can leave them: there for
		// what is in them.
		await db.folders.bulkDelete(
			['Ideas', 'Work', 'Work/Q3', 'Home'].map((path): [string, string] => [
				LOCAL_CONNECTION_ID,
				path,
			])
		);
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Ideas', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home', 'top');
		await deleteNote(db, note.id);

		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home/Kept', 'top');

		// `Work` holds a note a level down, and `Home` a notebook with a row.
		expect(await pinnedNotebooks()).toEqual(['Work', 'Home', 'Home/Kept']);
	});

	it('keeps a path once when a move lands on one already kept', async () => {
		await db.prefs.put({
			key: `pinnedNotebooks:${LOCAL_CONNECTION_ID}`,
			value: JSON.stringify(['B/A', 'A']),
		});

		await movePinnedNotebooks(db, LOCAL_CONNECTION_ID, 'A', 'B/A');

		expect(await pinnedNotebooks()).toEqual(['B/A']);
	});

	it('lets go of a notebook deleted, and of what was inside it', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, parentPath: 'Work', name: 'Old' });
		await createFolder(db, { ...scope, name: 'Home' });
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work/Old', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home', 'top');

		await deleteFolder(db, 'Work', scope);

		expect(await pinnedNotebooks()).toEqual(['Home']);
	});

	it('follows a notebook a sync renames, and lets go of one it deletes', async () => {
		await bindConnection(db, { connectionId: 'dropbox-1', provider: 'dropbox' });
		await finishImport(db, 'dropbox-1');
		const store = createDexieSyncStore(db, { connectionId: 'dropbox-1' });
		await store.applyChanges({
			changes: [
				{ kind: 'ensure-folder', path: 'Work' },
				{ kind: 'ensure-folder', path: 'Work/Old' },
			],
		});
		await setNotebookPin(db, 'dropbox-1', 'Work/Old', 'top');

		await store.applyChanges({ changes: [{ kind: 'move-folder', from: 'Work', to: 'Job' }] });
		expect(await getPinnedNotebooks(db, 'dropbox-1')).toEqual(['Job/Old']);

		await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Job' }] });
		expect(await getPinnedNotebooks(db, 'dropbox-1')).toEqual([]);
	});
});

describe('notebooks pinned to the bottom', () => {
	it('keeps them apart from the top’s, in a row of their own', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Home' });

		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home', 'bottom');

		expect(await pinnedNotebooks()).toEqual(['Work']);
		expect(await bottomNotebooks()).toEqual(['Home']);
		// The top's row is as it always was, so an older version reads it.
		expect(await db.prefs.get(`pinnedNotebooks:${LOCAL_CONNECTION_ID}`)).toEqual({
			key: `pinnedNotebooks:${LOCAL_CONNECTION_ID}`,
			value: JSON.stringify(['Work']),
		});
		const pins = await getPins(db, LOCAL_CONNECTION_ID);
		expect([...pins.notebooks]).toEqual(['Work']);
		expect([...pins.bottomNotebooks]).toEqual(['Home']);
	});

	it('pins a notebook to one end at a time, and unpins it from either', async () => {
		await createFolder(db, { ...scope, name: 'Work' });

		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'top');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'bottom');
		expect(await pinnedNotebooks()).toEqual([]);
		expect(await bottomNotebooks()).toEqual(['Work']);

		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'top');
		expect(await pinnedNotebooks()).toEqual(['Work']);
		expect(await bottomNotebooks()).toEqual([]);

		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', 'bottom');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work', undefined);
		expect(await pinnedNotebooks()).toEqual([]);
		expect(await bottomNotebooks()).toEqual([]);
	});

	it('lets go of one no longer there when any notebook’s pin changes', async () => {
		await createFolder(db, { ...scope, name: 'Home' });
		const note = await createNote(db, { title: 'Draft', folderPath: 'Ideas' });
		await db.folders.delete([LOCAL_CONNECTION_ID, 'Ideas']);
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Ideas', 'bottom');
		await deleteNote(db, note.id);

		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home', 'top');

		expect(await bottomNotebooks()).toEqual([]);
	});

	it('follows a notebook renamed or moved, and lets go of one deleted', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, parentPath: 'Work', name: 'Old' });
		await createFolder(db, { ...scope, name: 'Home' });
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Work/Old', 'bottom');
		await setNotebookPin(db, LOCAL_CONNECTION_ID, 'Home', 'bottom');

		await renameFolder(db, 'Work', 'Job', scope);
		await moveFolder(db, 'Job', 'Home/Job', scope);
		expect(await bottomNotebooks()).toEqual(['Home/Job/Old', 'Home']);

		await deleteFolder(db, 'Home/Job', scope);
		expect(await bottomNotebooks()).toEqual(['Home']);
	});

	it('follows a notebook a sync renames, and lets go of one it deletes', async () => {
		await bindConnection(db, { connectionId: 'dropbox-1', provider: 'dropbox' });
		await finishImport(db, 'dropbox-1');
		const store = createDexieSyncStore(db, { connectionId: 'dropbox-1' });
		await store.applyChanges({
			changes: [
				{ kind: 'ensure-folder', path: 'Work' },
				{ kind: 'ensure-folder', path: 'Work/Old' },
			],
		});
		await setNotebookPin(db, 'dropbox-1', 'Work/Old', 'bottom');

		await store.applyChanges({ changes: [{ kind: 'move-folder', from: 'Work', to: 'Job' }] });
		expect(await getBottomPinnedNotebooks(db, 'dropbox-1')).toEqual(['Job/Old']);

		await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Job' }] });
		expect(await getBottomPinnedNotebooks(db, 'dropbox-1')).toEqual([]);
	});
});

describe('pinned notes', () => {
	it('keeps a note pinned through a rename, by its id', async () => {
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await setNotePinned(db, LOCAL_CONNECTION_ID, note.id, true);

		await renameNote(db, note.id, 'Roadmap');

		expect(await pinnedNotes()).toEqual([note.id]);
		expect((await getPins(db, LOCAL_CONNECTION_ID)).notes.has(note.id)).toBe(true);
	});

	it('unpins, and lets go of a note there is no row for when a pin changes', async () => {
		const kept = await createNote(db, { title: 'Kept', folderPath: 'Work' });
		const gone = await createNote(db, { title: 'Gone', folderPath: 'Work' });
		const other = await createNote(db, { title: 'Other', folderPath: 'Work' });
		await setNotePinned(db, LOCAL_CONNECTION_ID, kept.id, true);
		await setNotePinned(db, LOCAL_CONNECTION_ID, gone.id, true);
		await db.notes.delete([LOCAL_CONNECTION_ID, gone.id]);

		await setNotePinned(db, LOCAL_CONNECTION_ID, other.id, true);
		await setNotePinned(db, LOCAL_CONNECTION_ID, kept.id, false);

		expect(await pinnedNotes()).toEqual([other.id]);
	});

	it('keeps the pin of a note deleted here and not yet gone, so taking it back keeps it', async () => {
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		const other = await createNote(db, { title: 'Other', folderPath: 'Work' });
		await setNotePinned(db, LOCAL_CONNECTION_ID, note.id, true);
		await deleteNote(db, note.id);

		await setNotePinned(db, LOCAL_CONNECTION_ID, other.id, true);

		expect(await pinnedNotes()).toEqual([note.id, other.id]);
	});

	it('opens a pinned note first in a notebook with nothing remembered', async () => {
		const pinned = await createNote(db, { title: 'Older', folderPath: 'Work' });
		await createNote(db, { title: 'Newer', folderPath: 'Work' });
		await setNotePinned(db, LOCAL_CONNECTION_ID, pinned.id, true);

		const pick = await pickNote(db, {
			connectionId: LOCAL_CONNECTION_ID,
			folderPath: 'Work',
			open: undefined,
			remembered: undefined,
			pinned: new Set(await pinnedNotes()),
		});

		expect(pick).toBe(pinned.id);
	});
});

describe('pinnedToEnds', () => {
	it('puts the top’s first and the bottom’s last, each part in the order it came in', () => {
		const pins = new Map<string, NotebookPin>([
			['d', 'bottom'],
			['c', 'top'],
			['a', 'bottom'],
		]);
		expect(pinnedToEnds(['a', 'b', 'c', 'd', 'e'], (each) => pins.get(each))).toEqual([
			'c',
			'b',
			'e',
			'a',
			'd',
		]);
	});
});

describe('pinnedFirst', () => {
	it('puts the pinned first, each part in the order it came in', () => {
		const pinned = new Set(['c', 'a']);
		expect(pinnedFirst(['a', 'b', 'c', 'd'], (each) => pinned.has(each))).toEqual([
			'a',
			'c',
			'b',
			'd',
		]);
	});
});
