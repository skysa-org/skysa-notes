import type { ScratchColor } from '@skysa/core';
import type { Ref } from 'react';

import type { AttachmentProblem } from '../../editor/attachHost.js';
import type { EditorMode } from '../../editor/mode.js';
import type { NoteRecord } from '../../store/db.js';
import type { LiveEdits } from '../../store/liveEdits.js';
import type { Renamings } from '../../store/renaming.js';
import type { ScratchMarks } from '../../store/scratchpad.js';

export interface NoteViewProps {
	note: NoteRecord | undefined;
	/**
	 * The note as it was deleted, holding the last text the store never took.
	 * `beside` is such text where it is *not* the newest — an edit whose save
	 * failed, with a later one stored since that was not typed over it. An undo
	 * keeps it beside the note; as the body it would undo that later edit.
	 */
	onDeleted: (deleted: NoteRecord, beside?: DisplacedText) => void;
	/**
	 * Make a note in the open notebook, for the empty pane's "create one". Given
	 * only while a notebook is open: without somewhere to put a note, the pane
	 * does not offer to make one.
	 */
	onCreateNote?: () => void;
	/**
	 * Ask for the first notebook, given while there are none. In a compact
	 * window this pane is all there is on screen, and "Select a note" with
	 * nothing anywhere to select is a dead end.
	 */
	onCreateNotebook?: () => void;
	/**
	 * A note asked for and not read yet (`useNoteRead`). The pane says nothing for a
	 * moment, then that the note is opening, rather than that none is: read
	 * behind a write that was held up, a note took minutes to arrive, and "Select
	 * a note" over a note just pressed said it was not there (2026-10-10).
	 */
	opening?: boolean;
	/**
	 * Given while `note` is a draft: begun, on screen, and stored nowhere until
	 * it is edited (`draftNote`). Leaving it unedited leaves nothing behind.
	 */
	draft?: NoteDraft | undefined;
	/**
	 * Where what is typed is said before it is saved, so the note list can show
	 * it as it is typed (`store/liveEdits.ts`). Without it nothing else on
	 * screen hears of an edit until autosave has stored it.
	 */
	liveEdits?: LiveEdits;
	/** A notebook being renamed, so the note's path says what is typed. */
	renamings?: Renamings;
	/**
	 * Something done with a file beside the note that did not work — one that
	 * could not be opened — for the route to say over the page (#187).
	 */
	onProblem?: (problem: AttachmentProblem) => void;
	/**
	 * Given for a scratch note (docs/ARCHITECTURE.md §7, "The scratchpad"): a
	 * smaller editor, with no path, no editor tabs and no outline, the basic
	 * formatting bar at its foot and the note's own controls under that.
	 */
	scratch?: ScratchEditing | undefined;
	/** For the route, which offers Delete on every note in the list. */
	ref?: Ref<NoteViewHandle>;
}

/** What a scratch note's editor is handed (`NoteViewProps.scratch`). */
export interface ScratchEditing {
	/** Close it: the card open, or the note being taken. */
	onClose: () => void;
	/** Make it a note in a notebook; unsaid while that cannot be offered. */
	onMove: ((note: NoteRecord) => void) | undefined;
	/** Put the caret in the body as it opens. */
	focusBody: boolean;
}

/** What the note pane can do with a note that is not stored yet. */
export interface NoteDraft {
	/**
	 * Store it, as it is, because it has just been edited. Called again for the
	 * same draft, it answers the same promise. Resolves to whether it was stored.
	 *
	 * It must open its write before it returns: the edit that called it is saved
	 * after, and has to land in the note rather than find nothing there.
	 */
	store: () => Promise<boolean>;
	/** The other editor, which is a way of looking at it and not an edit. */
	setMode: (mode: EditorMode) => void;
}

/**
 * What the note pane does for a note from elsewhere: the `⋯` at the end of a
 * row in the note list, or a right-click on one.
 */
export interface NoteViewHandle {
	deleteNote: (note: NoteRecord) => void;
}

/** Text typed into a note that belongs beside it: see `NoteViewProps.onDeleted`. */
export interface DisplacedText {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
}

/** A change to a scratch note's marks: a key given is set, or taken away as `undefined`. */
export type MarkChange = { pinned?: true | undefined; color?: ScratchColor | undefined };

/** What a scratch note's screen is handed: its editing, and its marks. */
export interface ScratchScreen extends ScratchEditing {
	marks: ScratchMarks;
	onMark: (change: MarkChange) => void;
	/** Unsaid for a draft, which has nothing stored to delete. */
	onDelete: (() => void) | undefined;
}
