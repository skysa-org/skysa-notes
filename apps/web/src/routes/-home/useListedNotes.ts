import { isScratchPath, parentPath } from '@skysa/core';
import { useEffect, useMemo } from 'react';

import { type NoteRecord } from '../../store/db.js';
import { useNotesUnderFolder } from '../../store/hooks.js';
import { type Pins } from '../../store/pins.js';
import { type FolderNode, listedUnder } from '../../store/tree.js';
import { isAppFolder } from '../place.js';

/**
 * The open notebook's notes, then those of the notebooks inside it, a notebook's
 * together and in the sidebar's order (`listedUnder`), the pinned first in each
 * (`store/pins.ts`); and the note begun in it as the newest, though the store
 * has no row for it yet: at the top of its own that are not pinned. The pins
 * come with the tree (`usePinnedTree`), which is read before any notebook is
 * open.
 *
 * `own` is the notebook's own stored notes, which are what a new note's name
 * must not repeat.
 */
export const useListedNotes = (
	connectionId: string | undefined,
	folder: string | undefined,
	begun: NoteRecord | undefined,
	pins: Pins | undefined,
	tree: FolderNode[] | undefined
) => {
	// The scratchpad lists its cards itself (`useScratchpad`), and the
	// passwords their items (`usePasswords`).
	const listed = isAppFolder(folder) ? undefined : folder;
	const stored = useNotesUnderFolder(listed, connectionId);
	const own = useMemo(
		() => stored?.filter((note) => parentPath(note.path) === folder),
		[stored, folder]
	);
	const notes = useMemo(() => {
		if (stored === undefined || folder === undefined) return undefined;
		const pinned = (note: NoteRecord) => pins?.notes.has(note.id) === true;
		const sorted = listedUnder(stored, folder, tree, pinned);
		if (
			begun === undefined ||
			parentPath(begun.path) !== folder ||
			stored.some((note) => note.id === begun.id)
		)
			return sorted;
		const at = sorted.filter((note) => parentPath(note.path) === folder && pinned(note)).length;
		return [...sorted.slice(0, at), begun, ...sorted.slice(at)];
	}, [stored, begun, folder, pins, tree]);
	return { own, notes, unsavedNoteId: begun?.id };
};

/**
 * A note begun is named next, and the cursor goes to its name, so in a compact
 * window it is the note that shows and not a dropdown over it. Choosing a
 * notebook or pressing `+` shut the dropdown already; making a notebook —
 * always one with nothing in it — and deleting a notebook's last note did not,
 * and left the cursor in a field nobody could see.
 */
export const useBegunInView = (begun: NoteRecord | undefined, shut: (panel: null) => void) => {
	// Not a note begun in the scratchpad's box, which is in the pane that is open.
	const id = begun === undefined || isScratchPath(begun.path) ? undefined : begun.id;
	useEffect(() => {
		if (id !== undefined) shut(null);
	}, [id, shut]);
};
