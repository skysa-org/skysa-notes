import { isScratchPath, isWithin, rebasePath } from '@skysa/core';
import { type RefObject, useCallback, useEffect, useState } from 'react';

import { useNotices } from '../../components/ui/notices.js';
import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { moveFolder } from '../../store/folders.js';
import { settleEditors } from '../../store/heldEdits.js';
import { moveNote } from '../../store/notes.js';
import { dropMove, type Moving } from '../../store/rearrange.js';
import type { Pane } from '../panel.js';
import { notebookRefused } from './useNotebookActions.js';
import type { Select } from './useOpenPlace.js';

/**
 * What the user has picked up, by dragging it or by running the command.
 *
 * One piece of state for both, and it lives here rather than in either pane
 * because the two ends of a note's move are in different ones: the row is in
 * the note list and every destination is in the sidebar. What is allowed to
 * land where is in `store/rearrange.ts`, which knows nothing about React.
 */
export const useMoving = ({
	compact,
	setPanel,
	shutPanel,
	select,
	folder,
	noteIdRef,
}: Readonly<{
	compact: boolean;
	setPanel: (panel: Pane | null) => void;
	shutPanel: () => Promise<void>;
	select: Select;
	folder: string | undefined;
	noteIdRef: Readonly<RefObject<string | undefined>>;
}>) => {
	const db = useDb();
	const { say, moveOn } = useNotices();
	const [moving, setMoving] = useState<Moving | null>(null);

	const cancelMove = useCallback(() => {
		setMoving(null);
	}, []);

	/**
	 * Every destination is a sidebar row, and in a compact window the sidebar
	 * is a dropdown that may be shut — so picking something up opens it, or a
	 * move begun from the palette would be a mode with nowhere to finish it.
	 */
	const pickUp = (what: Moving) => {
		setMoving(what);
		if (compact) setPanel('notebooks');
	};

	const onDropInto = (into: string) => {
		if (moving === null) return;
		const move = dropMove(moving, into);
		// Put down first: the move is a round trip through the store and a mode
		// left standing over it is one the user can drop a second copy of.
		setMoving(null);
		// And the dropdown shut before the move goes on: shutting it may be
		// Back, which a step taken before it lands would be the one undone.
		const shut = shutPanel();
		if (move === undefined) return;
		moveOn();

		if (move.kind === 'note') {
			// A scratch note made a note is followed into its notebook: making
			// it one was the point (docs/ARCHITECTURE.md §7, "The scratchpad").
			const promoted = moving.kind === 'note' && isScratchPath(moving.path);
			// What the editor holds is saved first: a file pasted into the note
			// a moment ago is carried by the links its body has stored
			// (`carryLinkedFiles`), and left behind by one that has not been.
			void shut
				.then(settleEditors)
				.then(() => moveNote(db, move.id, move.into))
				.then(() => {
					if (promoted) {
						select({ folder: move.into, note: move.id });
						return;
					}
					// Only when it is the note in front. A note dragged out of the
					// list the user is reading leaves it, which is the whole of what
					// they asked for; the one they are *writing in* would otherwise
					// be open beside a sidebar highlighting the notebook it has just
					// left, which is the disagreement opening a search result also
					// has to avoid.
					if (noteIdRef.current === move.id) {
						select({ folder: move.into }, { replace: true });
					}
				})
				.catch(() => {
					say({ message: t('shell.note.notMoved'), tone: 'error' });
				});
			return;
		}

		void shut
			.then(() => moveFolder(db, move.from, move.to))
			.then(() => {
				// The open notebook is named by path in the URL, and the move has
				// just changed it — for the notebook itself and for everything
				// under it. Left alone, the URL names a notebook that is no longer
				// there and `selectedFolderPath` falls back to the first one, so
				// moving the notebook you are in throws you out of it.
				if (folder !== undefined && isWithin(folder, move.from)) {
					select({ folder: rebasePath(folder, move.from, move.to) }, { replace: true });
				}
			})
			.catch((error: unknown) => {
				say(notebookRefused(error, 'there', t('shell.notebook.notMoved')));
			});
	};

	return { moving, setMoving, cancelMove, pickUp, onDropInto };
};

/**
 * Escape puts down whatever is being moved, from wherever the focus is. On
 * the document rather than on the sidebar: a move started from the palette
 * leaves the focus where the palette had it, which may be nowhere near the
 * destinations, and a mode with no way out is worse than no mode.
 */
export const useEscapePutsDown = (
	moving: Moving | null,
	setMoving: (moving: Moving | null) => void
) => {
	useEffect(() => {
		if (moving === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setMoving(null);
		};
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('keydown', onKey);
		};
	}, [moving, setMoving]);
};
