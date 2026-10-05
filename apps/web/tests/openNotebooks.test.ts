import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import { createFolder, deleteFolder, moveFolder, renameFolder } from '../src/store/folders.js';
import { getOpenNotebooks, setNotebooksOpen } from '../src/store/openNotebooks.js';

let db: NotesDatabase;
let counter = 0;

beforeEach(() => {
	counter += 1;
	db = createDatabase(`test-open-notebooks-${String(counter)}`);
});

afterEach(async () => {
	await db.delete();
});

const scope = { connectionId: LOCAL_CONNECTION_ID };
const open = () => getOpenNotebooks(db, LOCAL_CONNECTION_ID);

describe('which notebooks are open', () => {
	it('is none until one is opened', async () => {
		expect(await open()).toEqual([]);
	});

	it('keeps what is opened, and lets go of what is shut', async () => {
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['Work', 'Work/Old'], true);
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['Home'], true);
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['Work'], false);

		expect(await open()).toEqual(['Work/Old', 'Home']);
	});

	it('is per source', async () => {
		await setNotebooksOpen(db, 'dropbox-1', ['Work'], true);
		expect(await open()).toEqual([]);
		expect(await getOpenNotebooks(db, 'dropbox-1')).toEqual(['Work']);
	});

	it('keeps the newest 500, a notebook opened again being the newest', async () => {
		const many = Array.from({ length: 500 }, (_, at) => `N${String(at)}`);
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, many, true);
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['N0'], true);
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['New'], true);

		const kept = await open();
		expect(kept).toHaveLength(500);
		expect(kept).not.toContain('N1');
		expect(kept.slice(-2)).toEqual(['N0', 'New']);
	});

	it('reads a row it cannot use as none', async () => {
		await db.prefs.put({ key: `openNotebooks:${LOCAL_CONNECTION_ID}`, value: '{not json' });
		expect(await open()).toEqual([]);
	});

	it('follows a notebook renamed or moved, and what is inside it', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, parentPath: 'Work', name: 'Old' });
		await createFolder(db, { ...scope, name: 'Home' });
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['Work', 'Work/Old', 'Home'], true);

		await renameFolder(db, 'Work', 'Job', scope);
		expect(await open()).toEqual(['Job', 'Job/Old', 'Home']);

		await moveFolder(db, 'Job', 'Home/Job', scope);
		expect(await open()).toEqual(['Home/Job', 'Home/Job/Old', 'Home']);
	});

	it('lets go of a notebook deleted, and of what was inside it', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, parentPath: 'Work', name: 'Old' });
		await createFolder(db, { ...scope, name: 'Home' });
		await setNotebooksOpen(db, LOCAL_CONNECTION_ID, ['Work', 'Work/Old', 'Home'], true);

		await deleteFolder(db, 'Work', scope);

		expect(await open()).toEqual(['Home']);
	});
});
