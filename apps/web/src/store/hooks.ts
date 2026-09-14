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

export const useNotesInFolder = (folderPath: string = ROOT): NoteRecord[] | undefined =>
	useLiveQuery(() => listNotes(db, { folderPath }), [folderPath]);

export const useNote = (id: string | undefined): NoteRecord | undefined =>
	useLiveQuery(async () => (id === undefined ? undefined : db.notes.get(id)), [id]);

/** The mode a note opens in unless it remembers one of its own. */
export const useDefaultEditorMode = (): EditorMode | undefined =>
	useLiveQuery(() => getDefaultEditorMode(db), []);

/** Count of notes with unpushed edits, for the sync indicator in Phase 2. */
export const useDirtyCount = (): number | undefined =>
	useLiveQuery(() => db.notes.where('dirty').equals(1).count(), []);
