import { isScratchPath, ROOT } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef } from 'react';

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
import { holdsAnything } from './exportNotes.js';
import { listFilePaths } from './files.js';
import { folderTree } from './folders.js';
import { keptRows } from './keptRows.js';
import { getLastOpen, type LastOpen, noteIsUnder, pickNote } from './lastOpen.js';
import { getNote, listNotes, listNotesEverywhere, listScratchNotes } from './notes.js';
import { getOpenNotebooks } from './openNotebooks.js';
import { getPins, type Pins, pinsFromKey, pinsKey } from './pins.js';
import {
	getCodeDisplay,
	getDefaultEditorMode,
	getFormatToolbarShown,
	setCodeDisplay,
} from './prefs.js';
import { getScratchpadShown, isScratchNote } from './scratchpad.js';
import { createNoteSearch, type NoteHit } from './search.js';
import { buildFolderTree, type FolderNode, keptTree, withPins } from './tree.js';

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

/**
 * A source's first import, which holds the app while it runs; nothing
 * otherwise. Every one, whatever its row's `lock` says (`Importing.lock`).
 */
export const useHeldImport = (): SyncStateRecord | undefined =>
	useLiveQuery(async () => (await db.syncState.toArray()).find(holdsPile), []);

export const useActiveSource = (): SyncStateRecord | null | undefined =>
	useLiveQuery(async () => (await db.syncState.get(await activeConnectionId(db))) ?? null, []);

/**
 * The showing source's notebooks, and what it has pinned on this device; both
 * `undefined` until read.
 */
export interface PinnedTree {
	/** The notebooks, the pinned first at each level (`withPins`). */
	readonly tree: FolderNode[] | undefined;
	readonly pins: Pins | undefined;
}

/**
 * The showing source's notebooks and its pins (`store/pins.ts`), from one
 * query, so they come together: a notebook renamed or moved, or another source
 * shown, is never drawn with the pins from before.
 *
 * The source is asked for once and each read is given it, so there are no
 * more reads in a row than the tree had before the pins: a slower tree loses
 * the race to have a notebook just moved or made before the URL names it, and
 * the app falls back to another. The pins are not read by the notes' query or
 * by `pickNote` for the same reason, and are handed to them from here.
 *
 * The pins stay the same object while they are the same pins (`pinsKey`):
 * `pickNote` is asked again when they change. A notebook that has not changed
 * since the read before is the node it was then, and the tree the tree it was
 * where nothing in it changed (`keptTree`), so the sidebar redraws only the
 * rows that did.
 */
export const usePinnedTree = (): PinnedTree => {
	const before = useRef<FolderNode[] | undefined>(undefined);
	const result = useLiveQuery(async () => {
		const connectionId = await activeConnectionId(db);
		const [paths, notes, filePaths, pins] = await Promise.all([
			folderTree(db, { connectionId }),
			listNotes(db, { connectionId }),
			listFilePaths(db, { connectionId }),
			getPins(db, connectionId),
		]);
		// The scratchpad's folder is no notebook, and its notes and files are
		// no notebook's (docs/ARCHITECTURE.md §7, "The scratchpad").
		const tree = buildFolderTree({
			paths: paths.filter((path) => !isScratchPath(path)),
			notePaths: notes.map((note) => note.path).filter((path) => !isScratchPath(path)),
			filePaths: filePaths.filter((path) => !isScratchPath(path)),
		});
		const kept = keptTree(before.current, withPins(tree, pins.notebooks));
		before.current = kept;
		return { tree: kept, pinned: pinsKey(pins) };
	}, []);
	const pinned = result?.pinned;
	const pins = useMemo(() => (pinned === undefined ? undefined : pinsFromKey(pinned)), [pinned]);
	return { tree: result?.tree, pins };
};

/**
 * Notes under a folder: in it, or in a notebook inside it, at any depth
 * (`noteIsUnder`), which is what its list shows (`listedUnder`). The loose
 * notes are only those at the root. With no folder open there is nothing to
 * list.
 *
 * The result carries the folder it describes, and a result for any other folder
 * is reported as still loading. `useLiveQuery` keeps its last value across a
 * change of dependencies, so without this the previous folder's notes are shown
 * for a frame under the new folder's heading — a list that says "Loose notes"
 * above a note from a notebook, which is worse than a moment of "Loading…".
 *
 * A note that has not changed since the read before is the object it was then
 * (`keptRows`), so its row is not drawn again.
 */
export const useNotesUnderFolder = (folderPath: string | undefined): NoteRecord[] | undefined => {
	const before = useRef<ReadonlyMap<string, NoteRecord>>(new Map());
	const result = useLiveQuery(async () => {
		if (folderPath === undefined) {
			// Nothing listed, so nothing to keep the last notebook's notes for.
			before.current = new Map();
			return { folderPath, notes: [] };
		}
		const notes = keptRows(
			before.current,
			(await listNotes(db)).filter((note) => noteIsUnder(note.path, folderPath))
		);
		before.current = new Map(notes.map((note) => [note.id, note]));
		return { folderPath, notes };
	}, [folderPath]);
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

/**
 * Every notebook and live note in a source, read for one question — `key` —
 * and nothing while there is none: what a link naming a place by its names is
 * read against (`findNamedPlace` in `routes/place.ts`). `undefined` until read
 * for this key in this source, so an answer read for another is never handed
 * back for this one.
 */
export const useSourceContents = (
	connectionId: string | undefined,
	key: string | undefined
): { folders: string[]; notes: NoteRecord[] } | undefined => {
	const result = useLiveQuery(
		async () =>
			connectionId === undefined || key === undefined
				? undefined
				: {
						connectionId,
						key,
						folders: await folderTree(db, { connectionId }),
						notes: await listNotes(db, { connectionId }),
					},
		[connectionId, key]
	);
	return result?.connectionId === connectionId && result?.key === key ? result : undefined;
};

/**
 * Where the user was in a source, on this device (`store/lastOpen.ts`).
 * `undefined` until it has been read, for this source: a value read for the
 * source showing a moment ago is another source's place.
 */
export const useLastOpen = (connectionId: string | undefined): LastOpen | undefined => {
	const result = useLiveQuery(
		async () =>
			connectionId === undefined
				? undefined
				: { connectionId, lastOpen: await getLastOpen(db, connectionId) },
		[connectionId]
	);
	return result?.connectionId === connectionId ? result?.lastOpen : undefined;
};

/**
 * The notebooks open in the sidebar for a source, on this device
 * (`store/openNotebooks.ts`). `undefined` until read for this source, as
 * `useLastOpen` has it.
 */
export const useOpenNotebooks = (
	connectionId: string | undefined
): ReadonlySet<string> | undefined => {
	const result = useLiveQuery(
		async () =>
			connectionId === undefined
				? undefined
				: { connectionId, open: new Set(await getOpenNotebooks(db, connectionId)) },
		[connectionId]
	);
	return result?.connectionId === connectionId ? result?.open : undefined;
};

export interface NoteToOpen {
	/** What was asked about, so an answer to an earlier question can be told apart. */
	readonly folder: string;
	readonly open: string | undefined;
	/** The note that should be open, or `null` for an empty notebook. */
	readonly pick: string | null;
}

/**
 * Which note should be open in the notebook showing (`pickNote`). Live, so a
 * note arriving in an empty notebook — a first import filling it, a sync — is
 * opened as it lands, and the open note going — deleted here, in another tab,
 * on another device — is followed by the next one along.
 *
 * `undefined` while there is no notebook, while the source or its remembered
 * place is still being read, and until the store has answered.
 */
export const useNoteToOpen = ({
	connectionId,
	folder,
	open,
	remembered,
	pinned,
	ready,
}: {
	connectionId: string | undefined;
	folder: string | undefined;
	open: string | undefined;
	remembered: string | undefined;
	/** The source's pinned notes, the first of which a notebook opens on. */
	pinned: ReadonlySet<string> | undefined;
	/** The remembered place has been read; until then `remembered` means nothing. */
	ready: boolean;
}): NoteToOpen | undefined =>
	useLiveQuery(async () => {
		if (connectionId === undefined || folder === undefined || !ready) return undefined;
		const pick = await pickNote(db, {
			connectionId,
			folderPath: folder,
			open,
			remembered,
			pinned,
		});
		return { folder, open, pick };
	}, [connectionId, folder, open, remembered, pinned, ready]);

/** The mode a note opens in unless it remembers one of its own. */
export const useDefaultEditorMode = (): EditorMode | undefined =>
	useLiveQuery(() => getDefaultEditorMode(db), []);

/**
 * Whether a compact window shows the formatting toolbar, as it was last left
 * on this device — across a reload, and in step with another tab.
 */
export const useFormatToolbarShown = (): boolean | undefined =>
	useLiveQuery(() => getFormatToolbarShown(db), []);

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
 * Whether the source has anything a download of it would hold
 * (`holdsAnything`): what the palette's "Download all notes" goes by, as the
 * panel's button does, so the two are never offered for different libraries.
 * `undefined` while there is no source, or before the first read.
 */
export const useHoldsAnything = (connectionId: string | undefined): boolean | undefined =>
	useLiveQuery(
		() => (connectionId === undefined ? undefined : holdsAnything(db, connectionId)),
		[connectionId]
	);

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
		async () => ({ searching, notes: searching ? await searchable() : [] }),
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

/**
 * Every note a search may find: all of them, but a scratch note only where its
 * source's scratchpad is shown on this device, since that is the only place
 * one can be opened (docs/ARCHITECTURE.md §7, "The scratchpad").
 */
const searchable = async (): Promise<NoteRecord[]> => {
	const notes = await listNotesEverywhere(db);
	const sources = [...new Set(notes.filter(isScratchNote).map((note) => note.connectionId))];
	const shown = new Set(
		(
			await Promise.all(
				sources.map(async (id) => ((await getScratchpadShown(db, id)) ? id : undefined))
			)
		).filter((id) => id !== undefined)
	);
	return notes.filter((note) => !isScratchNote(note) || shown.has(note.connectionId));
};

/**
 * The notes of a source's scratchpad, newest made first; `undefined` until read
 * for this source.
 */
export const useScratchNotes = (connectionId: string | undefined): NoteRecord[] | undefined => {
	const before = useRef<ReadonlyMap<string, NoteRecord>>(new Map());
	const result = useLiveQuery(async () => {
		if (connectionId === undefined) {
			// No scratchpad shown, so nothing to keep the last one's notes for.
			before.current = new Map();
			return undefined;
		}
		// A card unchanged since the read before is the object it was then, so
		// it is not drawn again (`keptRows`).
		const notes = keptRows(before.current, await listScratchNotes(db, connectionId));
		before.current = new Map(notes.map((note) => [note.id, note]));
		return { connectionId, notes };
	}, [connectionId]);
	return result?.connectionId === connectionId ? result?.notes : undefined;
};

/**
 * Whether a source shows its scratchpad on this device; `undefined` until read
 * for this source.
 */
export const useScratchpadShown = (connectionId: string | undefined): boolean | undefined => {
	const result = useLiveQuery(
		async () =>
			connectionId === undefined
				? undefined
				: { connectionId, shown: await getScratchpadShown(db, connectionId) },
		[connectionId]
	);
	return result?.connectionId === connectionId ? result?.shown : undefined;
};

/** Count of notes with unpushed edits, for the sync indicator in Phase 2. */
export const useDirtyCount = (): number | undefined =>
	useLiveQuery(() => db.notes.where('dirty').equals(1).count(), []);
