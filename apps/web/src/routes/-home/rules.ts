import { isScratchPath, isVaultPath, ROOT } from '@skysa/core';

import { type SyncStateRecord } from '../../store/db.js';

/**
 * The small rules the shell reads about the place open: what can be made or
 * moved there, which rows the sidebar adds, and when the app is out of reach.
 */

/**
 * What the empty note pane offers to make. A note where there is a notebook to
 * put it in, as `note.new` has; and the first notebook while there is none,
 * since in a compact window this pane is the only one on screen.
 */
export const emptyPaneOffers = ({
	folder,
	nothingYet,
	onCreateNote,
	onCreateNotebook,
}: {
	folder: string | undefined;
	nothingYet: boolean;
	onCreateNote: () => void;
	onCreateNotebook: () => void;
}): { onCreateNote?: () => void; onCreateNotebook?: () => void } => {
	if (folder !== undefined && folder !== ROOT) return { onCreateNote };
	return nothingYet ? { onCreateNotebook } : {};
};

/**
 * Whether a new note can be made here. The root holds loose notes that came
 * from the remote folder and the app does not add to them, so there is
 * nowhere to put a note until a notebook is open (docs/ARCHITECTURE.md
 * §12.6). The scratchpad's goes in its box, which is not there under a card
 * open over it.
 */
export const canMakeNote = (folder: string | undefined, modal: boolean): boolean =>
	folder !== undefined && folder !== ROOT && !modal;

/**
 * Whether the folder open is a notebook, which can be moved: not the root,
 * which holds the loose notes, and not the scratchpad or the passwords.
 */
export const isNotebook = (folder: string | undefined): folder is string =>
	folder !== undefined && folder !== ROOT && !isScratchPath(folder) && !isVaultPath(folder);

/**
 * Whether the app behind is out of reach: held by a source's first import, or
 * under a scratch card's dialog, which keeps the focus to itself.
 */
export const covered = (held: SyncStateRecord | undefined, modal: boolean): boolean =>
	held !== undefined || modal;

/**
 * The sidebar's scratchpad row, while this device shows the source's
 * scratchpad; and its passwords' row, the same while it shows them.
 */
export const placeRow = (
	shown: boolean | undefined,
	selected: boolean,
	onSelect: () => void
): { selected: boolean; onSelect: () => void } | undefined =>
	shown === true ? { selected, onSelect } : undefined;
