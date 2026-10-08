import { basename, parentPath, SCRATCHPAD_FOLDER } from '@skysa/core';
import { useRouter } from '@tanstack/react-router';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import type { Place } from '../routes/place.js';
import { db, type NoteRecord } from '../store/db.js';
import { settleEditors } from '../store/heldEdits.js';
import { useScratchNotes } from '../store/hooks.js';
import { deleteNote, getNote, isUnnamed, renameNote, setScratchMarks } from '../store/notes.js';
import type { Moving } from '../store/rearrange.js';
import { scratchMarks } from '../store/scratchpad.js';
import { titleShown } from '../store/titles.js';
import { visibleLines } from '../store/visibleText.js';
import type { Pane } from './CompactBar.js';
import { COARSE_POINTER, useMediaQuery } from './layout.js';
import type { NoteViewHandle, ScratchEditing } from './NoteView.js';
import type { MarkChange } from './Scratchpad.js';

/**
 * What the route does in the scratchpad (docs/ARCHITECTURE.md §7, "The
 * scratchpad"): take a note, open a card and close it again, mark one, delete
 * one, and make one a note in a notebook.
 *
 * A card open is the place `{folder: SCRATCHPAD_FOLDER, note}`, pushed, so
 * Back closes it; closing it from the card goes Back where that is the way
 * it came. A note being taken is the same place put in for the scratchpad's
 * own, and which of the two it is — the box or a card — is said here, by the
 * note taken last.
 */

type Select = (next: Place, how?: { replace?: boolean; note?: NoteRecord }) => void;

/** A note stored by the box and left with nothing in it: nothing the user would miss. */
const leftBlank = (note: NoteRecord): boolean => {
	const marks = scratchMarks(note);
	return (
		visibleLines(note.body).length === 0 &&
		isUnnamed(note) &&
		!marks.pinned &&
		marks.color === undefined
	);
};

export const useScratchpad = ({
	active,
	connectionId,
	noteId,
	openNote,
	begin,
	select,
	compact,
	setPanel,
	setRest,
	noteView,
	onDeleted,
	pickUp,
	moving,
	onProblem,
}: {
	/** Whether the scratchpad is open. */
	active: boolean;
	connectionId: string | undefined;
	noteId: string | undefined;
	openNote: NoteRecord | undefined;
	begin: (folderPath: string, taken: readonly string[]) => NoteRecord | undefined;
	select: Select;
	compact: boolean;
	setPanel: (pane: Pane | null) => void;
	/** What a compact window shows as a pane over it is shut (`usePanel`). */
	setRest: (pane: Pane | null) => void;
	/** The note pane, while one is mounted: it holds what autosave has not stored. */
	noteView: RefObject<NoteViewHandle | null>;
	/** A card deleted from the wall, for its undo. */
	onDeleted: (note: NoteRecord) => void;
	pickUp: (what: Moving) => void;
	/** What is being moved: nothing else is, while something is. */
	moving: Moving | null;
	onProblem: (message: string) => void;
}) => {
	const router = useRouter();
	const touch = useMediaQuery(COARSE_POINTER);
	const notes = useScratchNotes(active ? connectionId : undefined);
	/** The note the box took last, which is open in the box while it is the one open. */
	const [takingId, setTakingId] = useState<string>();
	const taking = active && takingId !== undefined && takingId === noteId;
	const card =
		active && !taking && openNote?.id === noteId && openNote?.deletedLocally === 0
			? openNote
			: undefined;
	/** The card whose opening was pushed, which Back closes. */
	const pushed = useRef<string>(undefined);
	/** A card being named before it is moved (`NameDialog`). */
	const [naming, setNaming] = useState<NoteRecord>();

	// In a compact window the scratchpad is the notes' pane, and with no card
	// open it is all there is to show: there as the scratchpad opens, and
	// again as a card closes, and what shutting the notebooks over it, or the
	// sources, goes back to. It is not a dropdown open over the place, which
	// would be a step for Back to take (`usePanel`), but the pane the place
	// rests on. A card open is the column's, and nothing rests under it.
	// Before the window is drawn, so a card going back into the wall finds it
	// there, and one growing out of it finds nothing shut over it.
	const resting = active && compact && card === undefined;
	useLayoutEffect(() => {
		setRest(resting ? 'notes' : null);
	}, [resting, setRest]);

	const scope = (note: NoteRecord) => ({ connectionId: note.connectionId });

	/**
	 * Open the scratchpad, from its row or as it is shown: a step, unless it is
	 * open already with no card, when it is the dropdown open over it that
	 * shuts, onto its pane.
	 */
	const show = () => {
		if (!active || noteId !== undefined) select({ folder: SCRATCHPAD_FOLDER, note: undefined });
		else setPanel(null);
	};

	/** Begin a note in the box. Stored at its first edit, as any draft is. */
	const take = () => {
		if (!active) return;
		const taken = (notes ?? [])
			.filter((note) => parentPath(note.path) === SCRATCHPAD_FOLDER)
			.map((note) => basename(note.path));
		const made = begin(SCRATCHPAD_FOLDER, taken);
		if (made === undefined) return;
		setTakingId(made.id);
		select({ folder: SCRATCHPAD_FOLDER, note: made.id }, { replace: true, note: made });
	};

	/**
	 * Close the box. What the editor holds is written first; a note it stored
	 * and left with nothing in it is let go, as a card nobody needs.
	 */
	const closeTake = () => {
		const id = takingId;
		setTakingId(undefined);
		if (id === undefined || connectionId === undefined) return;
		const settled = settleEditors();
		select({ folder: SCRATCHPAD_FOLDER, note: undefined }, { replace: true });
		void settled
			.then(() => getNote(db, id, { connectionId }))
			.then((row) =>
				row !== undefined && row.deletedLocally === 0 && leftBlank(row)
					? deleteNote(db, id, scope(row))
					: undefined
			)
			.catch(() => undefined);
	};

	const open = (note: NoteRecord) => {
		pushed.current = note.id;
		select({ folder: SCRATCHPAD_FOLDER, note: note.id }, { note });
	};

	/** Close the card open: Back, where opening it was the step before. */
	const close = () => {
		const back = pushed.current !== undefined && pushed.current === noteId;
		pushed.current = undefined;
		if (back) router.history.back();
		else select({ folder: SCRATCHPAD_FOLDER, note: undefined }, { replace: true });
	};

	const mark = (note: NoteRecord, change: MarkChange) => {
		void setScratchMarks(db, note.id, change, scope(note)).catch(() => {
			onProblem(t('scratchpad.problem.changed'));
		});
	};

	/**
	 * Delete a card. Through the note pane where one is mounted, which holds
	 * what autosave has not stored; on the wall with none open there is none,
	 * and nothing held either.
	 */
	const remove = (note: NoteRecord) => {
		const pane = noteView.current;
		if (pane !== null) {
			pane.deleteNote(note);
			return;
		}
		void deleteNote(db, note.id, scope(note))
			.then(() => getNote(db, note.id, scope(note)).catch(() => undefined))
			.then((row) => {
				onDeleted(row ?? note);
			})
			.catch(() => {
				onProblem(t('scratchpad.problem.deleted'));
			});
	};

	/** The open note's editor is put away, the box or the card, before it moves. */
	const putAway = (note: NoteRecord) => {
		if (note.id !== noteId) return;
		if (taking) {
			setTakingId(undefined);
			select({ folder: SCRATCHPAD_FOLDER, note: undefined }, { replace: true });
			return;
		}
		close();
	};

	/** Pick it up to go into a notebook, as a note's move from the list does. */
	const carry = (note: NoteRecord) => {
		putAway(note);
		void settleEditors()
			.then(() => getNote(db, note.id, scope(note)))
			.then((row) => {
				if (row === undefined || row.deletedLocally !== 0) return;
				pickUp({ kind: 'note', id: row.id, path: row.path, name: titleShown(row.title) });
			});
	};

	/** Make a card a note: named first, if it has no name, then moved. */
	const promote = (note: NoteRecord) => {
		if (isUnnamed(note)) {
			setNaming(note);
			return;
		}
		carry(note);
	};

	const named = (name: string) => {
		const note = naming;
		setNaming(undefined);
		if (note === undefined) return;
		void renameNote(db, note.id, name, scope(note)).then(carry, () => {
			onProblem(t('scratchpad.problem.named'));
		});
	};

	const cancelNaming = () => {
		setNaming(undefined);
	};

	/** A note deleted: the box or the card it was open in goes with it. */
	const deleted = (note: NoteRecord) => {
		if (note.id === takingId) setTakingId(undefined);
		if (!active || note.id !== noteId) return;
		pushed.current = undefined;
		select({ folder: SCRATCHPAD_FOLDER, note: undefined }, { replace: true });
	};

	/** Make a card a note, offered while nothing else is being moved. */
	const offered = moving === null ? promote : undefined;

	return {
		notes,
		taking,
		takingId: taking ? takingId : undefined,
		card,
		/** A card open over the scratchpad, in a dialog: a wide window's. */
		modal: !compact && card !== undefined,
		/**
		 * What the compact bar names as the note: in the scratchpad, a card
		 * open with a name, after "Scratchpad"; anywhere else, `open`.
		 */
		barNote: (open: NoteRecord | undefined) => {
			if (!active) return open;
			return card !== undefined && !isUnnamed(card) ? card : undefined;
		},
		/** How the note open goes into a notebook, where it is a scratch note's. */
		moveOpen: active ? promote : undefined,
		/**
		 * What the shell says of the scratchpad in a compact window, under
		 * `panel` (styles.css): a card open over it, which it stays drawn under
		 * to grow out of and go back into; or it with nothing over it, which is
		 * what shows.
		 */
		shellProps: (panel: Pane | null) => ({
			'data-card': compact && card !== undefined ? '' : undefined,
			'data-wall': resting && panel === null ? '' : undefined,
		}),
		/** The note pane's part in it (`ScratchEditing`). */
		editing: {
			onClose: taking ? closeTake : close,
			onMove: offered,
			// Not on a touch screen for a card, where it would bring a keyboard
			// up over a note opened to be read.
			focusBody: taking || !touch,
		} satisfies ScratchEditing,
		naming,
		show,
		take,
		closeTake,
		open,
		close,
		mark,
		remove,
		promote,
		offered,
		named,
		cancelNaming,
		deleted,
	};
};

/**
 * The scratchpad opens as it is shown from the storage menu: turned on, it is
 * what the user wants to see. Only a change seen on this source, so neither
 * starting the app nor showing another source opens it.
 */
export const useOpenWhenShown = (
	connectionId: string | undefined,
	shown: boolean | undefined,
	open: () => void
) => {
	const seen = useRef<{ connectionId: string; shown: boolean }>(undefined);
	const opening = useRef(open);
	useEffect(() => {
		opening.current = open;
	}, [open]);
	useEffect(() => {
		if (connectionId === undefined || shown === undefined) return;
		const before = seen.current;
		seen.current = { connectionId, shown };
		if (before?.connectionId === connectionId && !before.shown && shown) opening.current();
	}, [connectionId, shown]);
};
