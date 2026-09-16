import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import {
	createFolder,
	deleteFolder,
	ensureFolder,
	FolderExistsError,
	folderTree,
	listFolders,
	moveFolder,
	renameFolder,
} from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	getNote,
	importNoteFile,
	listNotes,
	saveNoteBody,
} from '../src/store/notes.js';

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

	/**
	 * A move onto an occupied notebook.
	 *
	 * Merging two notebooks is not a rename, and nothing in the app offers it —
	 * but `moveFolder` used to do it silently, and what it did along the way was
	 * worse than the merge: `bulkPut` replaced the destination's folder row with
	 * the source's, so the destination lost its `remoteId`, and any two notes
	 * sharing a filename ended up as two rows at one path.
	 */
	it('refuses a destination another notebook already holds', async () => {
		await ensureFolder(db, 'work');
		await ensureFolder(db, 'drafts');

		await expect(moveFolder(db, 'drafts', 'work')).rejects.toThrow(FolderExistsError);
		expect(await folderTree(db)).toEqual(['drafts', 'work']);
	});

	it('leaves the destination its identity on the provider', async () => {
		await ensureFolder(db, 'work');
		await db.folders.update([LOCAL_CONNECTION_ID, 'work'], { remoteId: 'id:work' });
		await ensureFolder(db, 'drafts');

		await expect(moveFolder(db, 'drafts', 'work')).rejects.toThrow(FolderExistsError);
		expect((await db.folders.get([LOCAL_CONNECTION_ID, 'work']))?.remoteId).toBe('id:work');
	});

	it('refuses a destination a stray row sits underneath', async () => {
		// No `work` row, only one below it — which `bulkPut` would have replaced
		// just as quietly, since nothing above compared the paths at all.
		await db.folders.add({
			connectionId: LOCAL_CONNECTION_ID,
			path: 'work/notes',
			createdAt: Date.now(),
		});
		await ensureFolder(db, 'drafts');

		await expect(moveFolder(db, 'drafts', 'work')).rejects.toThrow(FolderExistsError);
	});

	/**
	 * The collision the folder check cannot catch: a note under a path with no
	 * folder row behind it. Importing a file creates no rows, and a sync pull can
	 * report a file before the folder holding it, so this is the ordinary state
	 * rather than a corrupt one.
	 */
	it('does not put two notes at one path', async () => {
		const mine = await createNote(db, { title: 'Report', folderPath: 'drafts' });
		// A note at `archive/report.md` with no `archive` folder row behind it.
		const loose = await createNote(db, { title: 'Report', folderPath: 'archive' });
		await db.folders.delete([LOCAL_CONNECTION_ID, 'archive']);

		await moveFolder(db, 'drafts', 'archive');

		const notes = await listNotes(db, { folderPath: 'archive' });
		expect(notes.map((note) => note.path).sort()).toEqual([
			'archive/report-2.md',
			'archive/report.md',
		]);
		// Both notes are still there, and the one that was already at the path
		// kept it: the mover is the one that gives way.
		expect((await getNote(db, loose.id))?.path).toBe('archive/report.md');
		expect((await getNote(db, mine.id))?.path).toBe('archive/report-2.md');
	});

	it('does not give two notes moving together the same path', async () => {
		// `report.md` and `report-2.md`, moving into a notebook that already has
		// a `report.md`. The first gives way onto `report-2.md` — which is where
		// the second was going, so the answer has to account for a name taken
		// during the move and not only for the ones taken before it.
		const first = await createNote(db, { title: 'Report', folderPath: 'drafts' });
		const second = await createNote(db, { title: 'Report', folderPath: 'drafts' });
		expect([first.path, second.path]).toEqual(['drafts/report.md', 'drafts/report-2.md']);
		const resident = await createNote(db, { title: 'Report', folderPath: 'archive' });
		await db.folders.delete([LOCAL_CONNECTION_ID, 'archive']);

		await moveFolder(db, 'drafts', 'archive');

		const paths = (await listNotes(db, { folderPath: 'archive' })).map((note) => note.path);
		expect(paths).toHaveLength(3);
		expect(new Set(paths).size).toBe(3);
		expect((await getNote(db, resident.id))?.path).toBe('archive/report.md');
	});

	/**
	 * A tombstone is a queued delete, not a note at a path. Renaming one would
	 * point its delete at a file that is not the one it is deleting — and since
	 * nothing lists a tombstone, the name it holds is free as far as every other
	 * part of the app is concerned.
	 */
	it('moves a tombstone without renaming it out of the way', async () => {
		const doomed = await createNote(db, { title: 'Report', folderPath: 'drafts' });
		await deleteNote(db, doomed.id);
		const live = await createNote(db, { title: 'Report', folderPath: 'archive' });
		await db.folders.delete([LOCAL_CONNECTION_ID, 'archive']);

		await moveFolder(db, 'drafts', 'archive');

		expect((await getNote(db, doomed.id))?.path).toBe('archive/report.md');
		expect((await getNote(db, live.id))?.path).toBe('archive/report.md');
	});

	/**
	 * Names that differ only in case are one name on Drive, on Dropbox, and on
	 * macOS — which is why `uniqueFilename` compares them lowercased. A check
	 * that did not would wave through the collision it exists to catch: two rows
	 * here, one file there, and the two writing over each other from then on.
	 */
	it('does not put two notes on one path that differ only in case', async () => {
		// `Report.md` is a name this app would never choose. It arrives from
		// another tool, which is the whole reason the case can differ.
		await importNoteFile(db, { path: 'archive/Report.md', source: '# Theirs\n' });
		const mine = await createNote(db, { title: 'Report', folderPath: 'drafts' });

		await moveFolder(db, 'drafts', 'archive');

		const paths = (await listNotes(db, { folderPath: 'archive' })).map((note) => note.path);
		expect(paths).toHaveLength(2);
		expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(2);
		expect((await getNote(db, mine.id))?.path).toBe('archive/report-2.md');
	});

	/**
	 * Promoting a notebook one level up, where the level above holds no folder
	 * row of its own. The source is inside its own destination, so a refusal
	 * that counted every row under the destination counted the rows it was
	 * about to move and refused a move that collides with nothing.
	 */
	it('promotes a folder into a parent path that holds no notebook', async () => {
		const note = await createNote(db, { title: 'Note', folderPath: 'a/b' });
		// After the note, because `ensureFolder` puts every missing ancestor back.
		await db.folders.delete([LOCAL_CONNECTION_ID, 'a']);

		await moveFolder(db, 'a/b', 'a');

		expect(await folderTree(db)).toEqual(['a']);
		expect((await getNote(db, note.id))?.path).toBe('a/note.md');
	});

	/**
	 * The other half of the tombstone rule. A tombstone never moves aside, but it
	 * does hold its path: `importNoteFile` looks a note up by `[connectionId+path]`
	 * and takes `.first()`, and with two rows at the key which one that is comes
	 * down to the order of two random UUIDs. Picking the tombstone revives it on
	 * top of a note that was never deleted.
	 */
	it('does not land a live note on the path a queued delete is aimed at', async () => {
		const doomed = await createNote(db, { title: 'Report', folderPath: 'archive' });
		await deleteNote(db, doomed.id);
		await db.folders.delete([LOCAL_CONNECTION_ID, 'archive']);
		const live = await createNote(db, { title: 'Report', folderPath: 'drafts' });

		await moveFolder(db, 'drafts', 'archive');

		expect((await getNote(db, doomed.id))?.path).toBe('archive/report.md');
		expect((await getNote(db, live.id))?.path).toBe('archive/report-2.md');
	});

	it('leaves a name the user did not choose alone when nothing is in its way', async () => {
		// The cost of getting this wrong is a rename of somebody's file that
		// nothing asked for, on every note in the notebook, every time it moves.
		await importNoteFile(db, { path: 'drafts/My Report.md', source: '# Mine\n' });

		await moveFolder(db, 'drafts', 'archive');

		expect((await listNotes(db, { folderPath: 'archive' })).map((n) => n.path)).toEqual([
			'archive/My Report.md',
		]);
	});

	it('counts only the names in the folder it is landing in', async () => {
		// `report-2.md` is taken somewhere else entirely. Counting it would push
		// the note that gives way past a name that was never in its way.
		await createNote(db, { title: 'Report', folderPath: 'archive' });
		await createNote(db, { title: 'Report', folderPath: 'elsewhere' });
		await createNote(db, { title: 'Report', folderPath: 'elsewhere' });
		await db.folders.delete([LOCAL_CONNECTION_ID, 'archive']);
		const mine = await createNote(db, { title: 'Report', folderPath: 'drafts' });

		await moveFolder(db, 'drafts', 'archive');

		expect((await getNote(db, mine.id))?.path).toBe('archive/report-2.md');
	});

	it('refuses a destination that differs from a notebook only in case', async () => {
		// One directory on Drive, on Dropbox and on macOS. Allowed through, the
		// app ends up with two notebook rows and two `remoteId`s for one folder.
		await ensureFolder(db, 'Archive');
		await ensureFolder(db, 'drafts');

		await expect(moveFolder(db, 'drafts', 'archive')).rejects.toThrow(FolderExistsError);
		expect(await folderTree(db)).toEqual(['Archive', 'drafts']);
	});

	it('gives way when the destination folder is spelled differently in case', async () => {
		// No `archive` row to refuse on — the notes arrived from the provider and
		// nothing created one — so this falls to the per-note check, which had
		// been comparing the folders exactly and so finding nothing to avoid.
		await importNoteFile(db, { path: 'Archive/Report.md', source: '# Theirs\n' });
		const mine = await createNote(db, { title: 'Report', folderPath: 'drafts' });

		await moveFolder(db, 'drafts', 'archive');

		expect((await getNote(db, mine.id))?.path).toBe('archive/report-2.md');
	});

	it('lets the tombstone keep the path, whichever order the rows come back in', async () => {
		// A tombstone and a live note already at one path — which is what deleting
		// a note and then making another with the same name leaves behind, and is
		// blessed as such in `db.ts`. Both move together. The tombstone is a
		// queued delete aimed at that path, so it is the one that keeps it; left
		// to the order the rows came back in, which of them did would be the order
		// of two random UUIDs.
		const doomed = await createNote(db, { title: 'Report', folderPath: 'drafts' });
		await deleteNote(db, doomed.id);
		const live = await createNote(db, { title: 'Report', folderPath: 'drafts' });
		expect(live.path).toBe(doomed.path);

		await moveFolder(db, 'drafts', 'archive');

		expect((await getNote(db, doomed.id))?.path).toBe('archive/report.md');
		expect((await getNote(db, live.id))?.path).toBe('archive/report-2.md');
	});

	it('does not conjure the destination when nothing is under the source', async () => {
		// A move of a notebook that is not there asked for nothing, and the only
		// thing that used to happen was `ensureFolder` answering with a notebook
		// the user never asked for.
		await ensureFolder(db, 'work');

		await moveFolder(db, 'nowhere', 'archive');

		expect(await folderTree(db)).toEqual(['work']);
	});

	it('does nothing when a notebook is renamed to the name it already has', async () => {
		const note = await createNote(db, { title: 'Note', folderPath: 'work' });
		await moveFolder(db, 'work', 'work');

		expect(await folderTree(db)).toEqual(['work']);
		expect((await getNote(db, note.id))?.path).toBe('work/note.md');
	});
});

describe('renameFolder', () => {
	it('renames in place, keeping the name as typed', async () => {
		await ensureFolder(db, 'work/meetings');
		await renameFolder(db, 'work/meetings', 'Team Meetings');

		expect(await folderTree(db)).toEqual(['work', 'work/Team Meetings']);
	});

	it('reports a name a sibling notebook already has, in that name', async () => {
		await ensureFolder(db, 'work/meetings');
		await ensureFolder(db, 'work/Team Meetings');

		await expect(renameFolder(db, 'work/meetings', 'Team Meetings')).rejects.toThrow(
			// The name as the user typed it, so the UI can say it back to them —
			// not the path, which is what the message for the log says.
			expect.objectContaining({ folderName: 'Team Meetings' })
		);
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
