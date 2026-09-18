import { ROOT } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';

import { type EditorMode } from '../editor/mode.js';
import { db, type NoteRecord } from './db.js';
import { folderTree } from './folders.js';
import { listNotes } from './notes.js';
import { getDefaultEditorMode } from './prefs.js';
import { createNoteSearch, type NoteHit } from './search.js';
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

/**
 * The open note, or `undefined` once it is gone — including gone as a tombstone.
 *
 * `db.notes.get` hands back a tombstoned row like any other, and a tombstone is a
 * note on its way out: the list and the sidebar have already dropped it, so
 * showing it here left a note fully editable in the right pane that nothing else
 * in the app admitted existed. Anything typed into it went into a row that is
 * purged once the delete reaches the provider. Reachable today with two tabs:
 * delete a note in one while it is open in the other.
 */
export const useNote = (id: string | undefined): NoteRecord | undefined =>
	useLiveQuery(async () => {
		if (id === undefined) return undefined;
		const note = await db.notes.get(id);
		return note?.deletedLocally === 1 ? undefined : note;
	}, [id]);

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

/**
 * Notes matching what the user has typed, across every notebook. `undefined`
 * only before the first query has resolved; an empty array means nothing
 * matched.
 *
 * The index belongs to the component that is searching, so it is built when a
 * search begins and collected when that component goes — the app does not carry
 * an index for a feature nobody is using. An empty query empties it again rather
 * than merely skipping the search: the words of every note are a copy of the
 * corpus, and holding one because a search happened once is the kind of cost
 * nobody goes looking for.
 *
 * A keystroke is answered from the index already in hand rather than waited for:
 * a query is pure, the notes behind it have not moved, and reporting "still
 * loading" between letters would blank the list at typing speed. Only the read
 * itself is ever waited for, and only when it is a read for a different question
 * than the one being asked.
 */
export const useNoteSearch = (query: string): NoteHit[] | undefined => {
	const search = useMemo(createNoteSearch, []);
	const searching = query.trim() !== '';

	// The notes are read for the search, not for the query: the database is
	// asked when a search opens and whenever a note changes under it, and never
	// because another letter was typed. Reading every row again per keystroke
	// would pull the whole corpus out of IndexedDB at typing speed.
	//
	// Every live note, not the open notebook's: a search the user has to be
	// standing in the right notebook for cannot answer "where did I write that".
	const read = useLiveQuery(
		async () => ({ searching, notes: searching ? await listNotes(db) : [] }),
		[searching, search]
	);

	// `useLiveQuery` keeps its last value across a change of dependencies, so
	// without this the empty read held while nobody was searching answers the
	// first keystroke, and the pane says nothing matches a frame before the
	// matches arrive.
	const indexed = read?.searching === searching ? read : undefined;

	return useMemo(() => {
		if (indexed === undefined) return undefined;
		// The index is made to agree with the read React is *holding*, not with
		// whichever read finished last. Dexie aborts a superseded query but
		// cannot un-run it: its callback still completes, so refreshing where the
		// rows are read lets an overtaken read write the index after the winner —
		// and since the winner's value is what the memo is keyed on, nothing
		// would ever recompute over it. Two writes in quick succession, which is
		// what a sync round under an open search looks like, is enough. Here it
		// is keyed to the value it agrees with, and `refresh` is idempotent.
		search.refresh(indexed.notes);
		return searching ? search.find(query) : [];
	}, [indexed, query, searching, search]);
};

/** Count of notes with unpushed edits, for the sync indicator in Phase 2. */
export const useDirtyCount = (): number | undefined =>
	useLiveQuery(() => db.notes.where('dirty').equals(1).count(), []);
