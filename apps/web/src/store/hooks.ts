import { ROOT } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';

import { type EditorMode } from '../editor/mode.js';
import { db, type NoteRecord } from './db.js';
import { folderTree } from './folders.js';
import { listNotes } from './notes.js';
import { getDefaultEditorMode } from './prefs.js';
import { buildFolderTree, type FolderNode } from './tree.js';

/**
 * Live reads from IndexedDB. `useLiveQuery` re-runs its query whenever a write
 * touches the tables it read, so the UI follows the store without any
 * invalidation bookkeeping of its own.
 *
 * Every hook returns `undefined` on the first render, before the query has
 * resolved. That is a genuine "not loaded yet" and callers must handle it —
 * though the wait is a local IndexedDB round trip, not a network one.
 */

export const useFolderTree = (): FolderNode[] | undefined =>
	useLiveQuery(async () => {
		const [paths, notes] = await Promise.all([folderTree(db), listNotes(db)]);
		return buildFolderTree({ paths, notePaths: notes.map((note) => note.path) });
	}, []);

/**
 * Notes in a folder. With no folder open there is nothing to list.
 *
 * The result carries the folder it describes, and a result for any other folder
 * is reported as still loading. `useLiveQuery` keeps its last value across a
 * change of dependencies, so without this the previous folder's notes are shown
 * for a frame under the new folder's heading — a list that says "Loose notes"
 * above a note from a notebook, which is worse than a moment of "Loading…".
 */
export const useNotesInFolder = (folderPath: string | undefined): NoteRecord[] | undefined => {
	const result = useLiveQuery(
		async () => ({
			folderPath,
			notes: folderPath === undefined ? [] : await listNotes(db, { folderPath }),
		}),
		[folderPath]
	);
	// `result?.folderPath === folderPath` would be true for an unresolved query
	// of the root, where both sides are `undefined`, and then read `.notes` off
	// nothing at all.
	if (result === undefined) return undefined;
	return result.folderPath === folderPath ? result.notes : undefined;
};

export const useNote = (id: string | undefined): NoteRecord | undefined =>
	useLiveQuery(async () => (id === undefined ? undefined : db.notes.get(id)), [id]);

/** The mode a note opens in unless it remembers one of its own. */
export const useDefaultEditorMode = (): EditorMode | undefined =>
	useLiveQuery(() => getDefaultEditorMode(db), []);

/**
 * How many notes sit at the root of the app folder, in no notebook. Zero is the
 * normal case; a non-zero count only happens when a remote folder already had
 * loose `.md` files in it, and it is what makes the sidebar's "Loose notes" row
 * appear (docs/PLAN.md §12.6).
 */
export const useLooseNoteCount = (): number | undefined =>
	useLiveQuery(async () => (await listNotes(db, { folderPath: ROOT })).length, []);

/** Count of notes with unpushed edits, for the sync indicator in Phase 2. */
export const useDirtyCount = (): number | undefined =>
	useLiveQuery(() => db.notes.where('dirty').equals(1).count(), []);
