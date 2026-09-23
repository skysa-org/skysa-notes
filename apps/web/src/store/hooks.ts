import { ROOT } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo } from 'react';

import { codeDisplay, type CodeDisplayStore } from '../editor/codeDisplay.js';
import { type EditorMode } from '../editor/mode.js';
import { type ConnectedSource, connectedSources, holdsPile } from './connection.js';
import {
	activeConnectionId,
	db,
	type NoteRecord,
	PENDING_CREDENTIAL_ID,
	type SyncStateRecord,
} from './db.js';
import { folderTree } from './folders.js';
import { getNote, listNotes, listNotesEverywhere } from './notes.js';
import { getCodeDisplay, getDefaultEditorMode, setCodeDisplay } from './prefs.js';
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

/**
 * The source the app is showing, as the device knows it, or `null` for the
 * device's own pile. For saying what kind of source the notes on screen belong
 * to — a detached one, above all, which looks like any other from its notes.
 */
/** Every source on this device, in the order they were connected. */
export const useSources = (): ConnectedSource[] | undefined =>
	useLiveQuery(() => connectedSources(db), []);

/**
 * The source whose first import is under way, or `null` for none. One at a
 * time: a bind while one is running copies nothing (`bindConnection`).
 */
/**
 * Whether a credential brought back from a provider's consent page is still
 * waiting to be taken up (`claimConnection`), and so whether the connection it
 * is for is bound yet. True until it is known.
 */
export const useClaimingConnection = (): boolean =>
	useLiveQuery(
		async () => (await db.credentials.get(PENDING_CREDENTIAL_ID)) !== undefined,
		[],
		true
	);

/** The first source's import, while it holds the app; nothing otherwise. */
export const useHeldImport = (): SyncStateRecord | undefined =>
	useLiveQuery(
		async () =>
			(await db.syncState.toArray()).find(
				(state) => holdsPile(state) && state.importing?.lock === true
			),
		[]
	);

export const useActiveSource = (): SyncStateRecord | null | undefined =>
	useLiveQuery(async () => (await db.syncState.get(await activeConnectionId(db))) ?? null, []);

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
/**
 * The source showing. A query of its own, so that what it reads — `prefs`, and
 * the `syncState` row every sync run writes its cursor to — is not in the
 * observed set of a query over notes: the answer is a string, which is the same
 * string after a sync, and nothing downstream runs again.
 */
export const useActiveConnectionId = (): string | undefined =>
	useLiveQuery(() => activeConnectionId(db), []);

export const useNote = (id: string | undefined): NoteRecord | undefined => {
	// In the source showing: an id names a note only inside its source.
	const connectionId = useActiveConnectionId();
	return useLiveQuery(async () => {
		if (id === undefined) return undefined;
		if (connectionId === undefined) return undefined;
		const note = await getNote(db, id, { connectionId });
		return note?.deletedLocally === 1 ? undefined : note;
	}, [id, connectionId]);
};

/** The mode a note opens in unless it remembers one of its own. */
export const useDefaultEditorMode = (): EditorMode | undefined =>
	useLiveQuery(() => getDefaultEditorMode(db), []);

/**
 * Keep the code-block display settings and what is stored on this device in
 * step, in both directions, for as long as an editor is on screen.
 *
 * The store is what the editor's plugins read, because they are not React and
 * cannot wait for a query; the table is what survives a reload. Writing through
 * a live query rather than into the store alone is what makes a second tab
 * follow along — and costs nothing when it is the only tab, since a store told
 * the value it already holds does not tell anybody.
 */
export const useCodeDisplay = (store: CodeDisplayStore = codeDisplay): void => {
	const stored = useLiveQuery(() => getCodeDisplay(db), []);

	useEffect(() => {
		if (stored !== undefined) store.set(stored);
	}, [stored, store]);

	// Back the other way. The write re-runs the query above, which hands the
	// store the value it just set and stops there.
	useEffect(
		() =>
			store.subscribe(() => {
				void setCodeDisplay(db, store.get());
			}),
		[store]
	);
};

/**
 * How many notes sit at the root of the app folder, in no notebook. Zero is the
 * normal case; a non-zero count only happens when a remote folder already had
 * loose `.md` files in it, and it is what makes the sidebar's "Loose notes" row
 * appear (docs/ARCHITECTURE.md §12.6).
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
	// Every live note in every source, not the open notebook's and not the
	// showing source's: a search the user has to be standing in the right place
	// for cannot answer "where did I write that". Opening a match is what takes
	// them to the right place.
	const read = useLiveQuery(
		async () => ({ searching, notes: searching ? await listNotesEverywhere(db) : [] }),
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
