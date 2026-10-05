import { type NotesDatabase } from './db.js';
import { notebookPaths } from './notebookPaths.js';

/**
 * Which notebooks are open in the sidebar, per source, on this device: the
 * ones whose notebooks inside them are listed. Every other notebook with
 * notebooks inside it is shut, so a library of hundreds of notebooks nested
 * three deep opens as the short list of its top level (docs/ARCHITECTURE.md
 * §7, "The sidebar opens as far as it is asked").
 *
 * Open rather than shut is what is kept, so a notebook nobody has opened is
 * shut wherever it came from: made on another device, pulled, imported.
 *
 * In `prefs`, as `store/lastOpen.ts` is and for its reasons: how far one
 * device has the tree open is that device's, and each source is its own
 * notebooks. Kept by path, and so moved with the notebook when it is renamed
 * or moved and let go of when it is deleted (`notebookPaths`).
 */

/**
 * How many notebooks a source keeps open. Oldest opened first out: a device
 * that has opened thousands over the years keeps a row nobody notices, and
 * what it lets go of is shut, which is where a notebook starts anyway.
 */
const LIMIT = 500;

const open = notebookPaths('openNotebooks', LIMIT);

export const getOpenNotebooks = open.get;

/** Open or shut `paths`. */
export const setNotebooksOpen = (
	db: NotesDatabase,
	connectionId: string,
	paths: readonly string[],
	isOpen: boolean
): Promise<void> => open.set(db, connectionId, paths, isOpen);

/** Those that were open are open where they are now. */
export const moveOpenNotebooks = open.move;

/** None of them is open, so a notebook made later at one of those paths starts shut. */
export const forgetOpenNotebooks = open.forget;
