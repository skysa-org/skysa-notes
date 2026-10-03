import { EditorView } from '@codemirror/view';
import { frontmatterIsEditable, headings, type StructuralDifference } from '@skysa/core';
import {
	type Ref,
	useCallback,
	useDeferredValue,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';

import { parseChord } from '../commands/chord.js';
import { useCommand } from '../commands/context.js';
import { FindTargetProvider } from '../editor/findTarget.js';
import { Icon, type IconName } from '../editor/icons.js';
import { type EditorMode, MODE_LABELS, otherMode } from '../editor/mode.js';
import { RawEditor } from '../editor/RawEditor.js';
import { RichEditor, type RichEditorProps } from '../editor/RichEditor.js';
import { type SaveContext, useAutosave } from '../editor/useAutosave.js';
import { db, type NoteRecord, noteRef } from '../store/db.js';
import { beforeClosing } from '../store/heldEdits.js';
import { useDefaultEditorMode, useFormatToolbarShown } from '../store/hooks.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import {
	deleteNote,
	getNote,
	isUnnamed,
	renameNote,
	saveNoteBody,
	setNoteEditorMode,
} from '../store/notes.js';
import { setFormatToolbarShown } from '../store/prefs.js';
import { type Renamings, shownFolder, useRenaming } from '../store/renaming.js';
import { FindBar } from './FindBar.js';
import {
	COARSE_POINTER,
	COMPACT,
	OUTLINE_FITS_AT,
	OUTLINE_OPENS_AT,
	rems,
	useElementWidth,
	useMediaQuery,
} from './layout.js';
import { useNoteAttachments } from './noteAttachments.js';
import { Outline } from './Outline.js';
import { UnsupportedBanner, useUnsupported } from './unsupported.js';

/** The open note: its title, its body, and the actions that act on it. */

/** `Cmd+E` on a Mac, `Ctrl+E` elsewhere — see `commands/chord.ts`. */
const MODE_TOGGLE = parseChord('Mod+E');

/**
 * `Mod+F`. `Mod+Shift+F` is already searching every note, which is a different
 * question — this one is about the note that is open.
 *
 * On a Mac that means Cmd+F. Ctrl+F there reaches the raw editor first, where
 * CodeMirror's `standardKeymap` binds the emacs `Ctrl-f` to move the cursor one
 * character right and calls `preventDefault`, and `useShortcuts` stands aside
 * for a keystroke somebody nearer has already acted on. The same is true of
 * Ctrl+E and Ctrl+K, which `commands/context.ts` describes; Cmd is the modifier
 * a Mac user reaches for anyway.
 */
const FIND = parseChord('Mod+F');

export interface NoteViewProps {
	note: NoteRecord | undefined;
	/**
	 * With the note as it was deleted, holding the text the editor held — which
	 * is not always what the row holds: a save the store refused never got there.
	 * It is what an undo puts back.
	 */
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
	/** For the route, which offers Delete on every note in the list. */
	ref?: Ref<NoteViewHandle>;
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

/**
 * `draft` is null except while the user is actually typing in the field, so a
 * title that changes underneath — a rename from sync, or a heading edit in the
 * body — shows through without any state to keep in step. A heading being
 * typed into a note not named yet shows through as it is typed, as it does in
 * the list (`shownNote`).
 */
const TitleField = ({
	note,
	liveEdits,
	startFocused,
	onRename,
	onDone,
}: {
	note: NoteRecord;
	/** Where the name is said as it is typed, for the list to show it. */
	liveEdits: LiveEdits | undefined;
	/**
	 * In the field as it mounts, with the whole name selected: a note just
	 * begun has no name yet, and naming it is the first thing to do.
	 */
	startFocused: boolean;
	onRename: (title: string) => void;
	/** Enter: the name is done, and the writing comes next. */
	onDone: () => void;
}) => {
	const [draft, setDraft] = useState<string | null>(null);
	const field = useRef<HTMLInputElement>(null);
	// Deferred: the title a body gives is a parse of it, and the keystroke in
	// the body comes first.
	const shown = shownNote(note, useDeferredValue(useLiveEdit(liveEdits, note)));
	const ref = noteRef(note);
	// Escape has to reach `commit` through something `commit` can read
	// synchronously. `blur()` dispatches the blur event before React has
	// re-rendered, so `commit` runs against the render in which `draft` is still
	// the typed value: clearing state and blurring means Escape renames the note
	// — and the file on disk — to whatever the user was trying to throw away.
	const cancelled = useRef(false);
	/**
	 * Whether the press that is focusing the field should leave the whole name
	 * selected. "Untitled" is a placeholder, not a name, and the reason to
	 * click it is to replace it: selecting it on the way in means typing does
	 * that, where a caret dropped in the middle of it means deleting it first.
	 * The browser puts a caret where the pointer was released, after focus, so
	 * the selection made on focus has to survive the release — hence the flag
	 * read on `mouseup`. A named note is left alone: a click in a real name is
	 * a click at a place in it.
	 */
	const keepSelection = useRef(false);

	// On mount only: the field is keyed by note, and a draft that is stored as
	// it is edited stays mounted, so this never takes the cursor back.
	useEffect(() => {
		const input = field.current;
		if (!startFocused || input === null || typingElsewhere()) return;
		input.focus();
		input.select();
		// The selection is made; there is no press whose release could undo it.
		keepSelection.current = false;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const commit = () => {
		const trimmed = draft?.trim();
		const abandoned = cancelled.current;
		cancelled.current = false;
		setDraft(null);
		const given =
			!abandoned && trimmed !== undefined && trimmed !== '' && trimmed !== note.title;
		// Said as given, trimmed, until the row has it; or let go, and the row's
		// name is the one shown again.
		liveEdits?.naming(ref, given ? trimmed : undefined);
		if (given) onRename(trimmed);
	};

	return (
		<input
			ref={field}
			className="note-title-input"
			aria-label="Note title"
			value={draft ?? shown.title}
			onChange={(event) => {
				setDraft(event.target.value);
				liveEdits?.naming(ref, event.target.value);
			}}
			onFocus={(event) => {
				if (draft !== null || !isUnnamed(note)) return;
				event.currentTarget.select();
				keepSelection.current = true;
			}}
			onMouseUp={(event) => {
				if (!keepSelection.current) return;
				keepSelection.current = false;
				event.preventDefault();
			}}
			onBlur={() => {
				keepSelection.current = false;
				commit();
			}}
			onKeyDown={(event) => {
				if (event.key === 'Enter') {
					// Kept from going any further: the editor takes the focus while
					// the key is still down, and an Enter that followed it there
					// would be a new paragraph at the top of the note — an edit
					// nobody made, which stores a note nobody wrote in.
					event.preventDefault();
					event.currentTarget.blur();
					onDone();
				}
				if (event.key === 'Escape') {
					cancelled.current = true;
					event.currentTarget.blur();
				}
			}}
		/>
	);
};

/**
 * Whether the user is already typing somewhere else — the search field, the
 * command palette, another note's text — which a note begun by the app rather
 * than by them must not take the cursor out of. A note begins on its own a
 * moment after a notebook opens, and a key pressed in that moment belongs where
 * it was pressed. A button the user has just pressed — the `+`, a notebook — is
 * not typing, and the cursor goes to the new note's name as it should.
 */
const typingElsewhere = (): boolean => {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement)) return false;
	if (active.closest('[role="dialog"]') !== null) return true;
	if (active.isContentEditable || active instanceof HTMLTextAreaElement) return true;
	if (active instanceof HTMLSelectElement) return true;
	return (
		active instanceof HTMLInputElement &&
		!['button', 'checkbox', 'radio', 'submit', 'reset'].includes(active.type)
	);
};

/** Text typed into a note that belongs beside it: see `NoteViewProps.onDeleted`. */
export interface DisplacedText {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
}

interface Edit {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
	/** The note as it was shown when this was typed. */
	note: NoteRecord | undefined;
}

const sameBase = (next: Edit, pending: Edit): boolean => next.origin === pending.origin;

/**
 * Whichever editor is open, with the outline beside it.
 *
 * Its own component so that `NoteView` stays inside the complexity limit, and
 * because the rail needs an element to look inside: `body` is the one both the
 * editor and the outline are under, and only this part of the tree cares.
 */
const NoteBody = ({
	note,
	mode,
	showOutline,
	flyout,
	focusEditor,
	onCloseOutline,
	toolbar,
	onUserEdit,
	onUnsupported,
	onAdopted,
	onBody,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	showOutline: boolean;
	/** Over the editor rather than beside it (`useNoteLayout`). */
	flyout: boolean;
	/** Whether jumping to a heading puts the caret there (`OutlineProps`). */
	focusEditor: boolean;
	onCloseOutline: () => void;
	toolbar: RichEditorProps['toolbar'];
	onUserEdit: (body: string, origin: string) => void;
	onUnsupported: (lost: StructuralDifference) => void;
	onAdopted: () => void;
	/** The element, for whoever sizes the outline by its width. */
	onBody: (element: HTMLDivElement | null) => void;
}) => {
	const body = useRef<HTMLDivElement>(null);
	const attachments = useNoteAttachments(note);
	const attach = useCallback(
		(element: HTMLDivElement | null) => {
			body.current = element;
			onBody(element);
		},
		[onBody]
	);
	return (
		<div className="note-body" ref={attach}>
			{mode === 'raw' && (
				<RawEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
					onAdopted={onAdopted}
				/>
			)}
			{mode === 'rich' && (
				<RichEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
					onUnsupported={onUnsupported}
					onAdopted={onAdopted}
					toolbar={toolbar}
					attachments={attachments}
				/>
			)}
			{showOutline && (
				<Outline
					body={note.body}
					// Read when a row is clicked, not when it is drawn: the
					// editor is a sibling that mounts and unmounts with the mode,
					// so a reference taken at render time is stale the moment the
					// mode changes.
					editor={() => body.current?.querySelector('.editor') ?? null}
					focusEditor={focusEditor}
					{...(flyout ? { onClose: onCloseOutline } : {})}
				/>
			)}
		</div>
	);
};

/**
 * What of the note's furniture there is room for: the outline beside it, and
 * where the formatting toolbar goes.
 *
 * **The outline** is sized by the note's own width, not the window's — the
 * same window gives the note very different room with the columns beside it
 * and without them. At 53.5rem and wider it starts open (`OUTLINE_OPENS_AT`),
 * below that it starts collapsed and is a press away. Once pressed it stays as
 * the user left it for as long as the app is open, whatever the room does.
 * Below 36rem (`OUTLINE_FITS_AT`), where a rail would leave the note narrower
 * than itself, and in a compact window on a touch screen — a phone on its side,
 * a small tablet — it is a **flyout** over the editor instead: shut until asked for, and shut
 * again once a heading is chosen, on Escape, on a press anywhere else, and on
 * opening another note — it covers what it is for, so it goes once used.
 * Unmounted rather than hidden
 * when it is not shown: the headings are re-read when it comes back, which is
 * one parse of one note, and a rail that is not there cannot be tabbed
 * through.
 *
 * **The toolbar** is across the top in a wide window, as it always was. In a
 * compact one it is hidden until asked for and then sits at the bottom of the
 * editor, under the thumb: the screen is too short to spend a row of buttons
 * above every note, and the inline toolbar and the slash menu are still there
 * without it. Once asked for it stays, on this device, until it is asked away
 * again — a reload included (`FORMAT_TOOLBAR_KEY`).
 */
const useNoteLayout = (noteId: string | undefined, body: Element | null) => {
	const compact = useMediaQuery(COMPACT);
	const width = useElementWidth(body);
	const outlineFits = width === undefined || width >= rems(OUTLINE_FITS_AT);
	const outlineOpens = width === undefined || width >= rems(OUTLINE_OPENS_AT);

	const touch = useMediaQuery(COARSE_POINTER);
	const flyout = !outlineFits || (compact && touch);

	const [outlineChoice, setOutlineChoice] = useState<boolean | null>(null);
	// Which note the flyout is open over, so that opening another closes it
	// without an effect to notice the change.
	const [flyoutOver, setFlyoutOver] = useState<string | undefined>(undefined);
	const flyoutOpen = noteId !== undefined && flyoutOver === noteId;
	const showOutline = flyout ? flyoutOpen : (outlineChoice ?? outlineOpens);
	const toggleOutline = useCallback(() => {
		if (flyout) setFlyoutOver(flyoutOpen ? undefined : noteId);
		else setOutlineChoice(!showOutline);
	}, [flyout, flyoutOpen, noteId, showOutline]);
	const closeOutline = useCallback(() => {
		setFlyoutOver(undefined);
	}, []);
	useCommand({
		id: 'note.outline',
		label: showOutline ? 'Hide outline' : 'Show outline',
		group: 'Note',
		enabled: noteId !== undefined,
		run: toggleOutline,
	});

	// Hidden until the store has answered, which is before the note has: both
	// are reads of the same database, and the note's is the larger.
	const toolbarShown = useFormatToolbarShown() ?? false;
	const bottom = toolbarShown ? 'bottom' : 'none';
	const toolbar: RichEditorProps['toolbar'] = compact ? bottom : 'top';
	const toggleToolbar = useCallback(() => {
		void setFormatToolbarShown(db, !toolbarShown);
	}, [toolbarShown]);

	return {
		compact,
		flyout,
		touch,
		showOutline,
		toggleOutline,
		closeOutline,
		toolbar,
		toggleToolbar,
	};
};

/** What the empty pane says, offering what can be done from here. */
const NothingOpen = ({
	onCreateNote,
	onCreateNotebook,
}: Pick<NoteViewProps, 'onCreateNote' | 'onCreateNotebook'>) => {
	if (onCreateNote !== undefined) {
		return (
			<>
				Select a note, or{' '}
				<button type="button" className="link-button" onClick={onCreateNote}>
					create one
				</button>
				.
			</>
		);
	}
	if (onCreateNotebook !== undefined) {
		return (
			<>
				<button type="button" className="link-button" onClick={onCreateNotebook}>
					Create a notebook
				</button>{' '}
				to start writing.
			</>
		);
	}
	return 'Select a note.';
};

/**
 * Put the cursor in whichever editor is open, where it was — at the start, in
 * a note just opened. By the same lookups the outline jumps with
 * (`Outline.tsx`). A rich editor still being built has nothing to focus yet,
 * and is left alone.
 */
const focusEditor = (body: Element | null): void => {
	const editor = body?.querySelector<HTMLElement>('.editor');
	if (editor === null || editor === undefined) return;
	if (editor.classList.contains('editor-raw')) {
		EditorView.findFromDOM(editor)?.focus();
		return;
	}
	editor.querySelector<HTMLElement>('.ProseMirror')?.focus();
};

export const NoteView = ({
	note,
	onDeleted,
	onCreateNote,
	onCreateNotebook,
	draft,
	liveEdits,
	renamings,
	ref: handle,
}: NoteViewProps) => {
	const noteId = note?.id;
	const defaultMode = useDefaultEditorMode();

	// By source as well as id, like everything else held here across renders:
	// another source's note of the same id is another note.
	const ref = note === undefined ? undefined : noteRef(note);

	// The note as last shown. An edit carries it: a copy of the edit is written
	// from it, and a note a sync deleted is brought back as it.
	const shown = useRef(note);
	useEffect(() => {
		shown.current = note;
	}, [note]);

	const save = useCallback(
		({ body, origin, note: typedInto }: Edit, context?: SaveContext) => {
			if (noteId === undefined) return undefined;
			const base =
				typedInto !== undefined && noteRef(typedInto) === ref
					? { origin, note: typedInto }
					: undefined;
			// Returned, not dropped: autosave holds the edit until this settles,
			// and a rejection nobody hears is a user typing into nothing.
			return saveNoteBody(
				db,
				noteId,
				body,
				// Displaced with nothing to write a copy from cannot happen — every
				// edit carries the note — and would be written as the body if it did.
				base !== undefined && context?.displaced === true
					? { ...base, displaced: true }
					: base
			).then((saved) => {
				// The list shows the row again once the row has this.
				if (ref !== undefined) liveEdits?.landed(ref, 'body', body, saved.updatedAt);
				return saved;
			});
		},
		[noteId, ref, liveEdits]
	);

	const autosave = useAutosave<Edit>({
		key: ref ?? 'none',
		save,
		// An edit typed into a body a sync has since replaced is saved on its own,
		// before the next one — made from the new body — can stand for it.
		supersedes: sameBase,
	});
	const { change, flush, settle, rebased, overtaken, forget } = autosave;
	// A newer build in another tab closes this one's database; what is held
	// here goes in first.
	useEffect(() => beforeClosing(settle), [settle]);

	// A note the rich editor could not represent, held in raw mode until the
	// user has changed it and asks for the rich editor again.
	const unsupported = useUnsupported(note, { rebased, settle, failing: autosave.failing });
	const locked = unsupported.lost !== undefined;
	const { edited } = unsupported;

	const onUserEdit = useCallback(
		(body: string, origin: string) => {
			// Stored before the edit is held: the save that follows opens its
			// write after this one, and so finds the note there to write into.
			if (draft !== undefined) void draft.store();
			const typedInto = shown.current;
			if (typedInto !== undefined) liveEdits?.typed(noteRef(typedInto), body, origin);
			change({ body, origin, note: typedInto });
			edited();
		},
		[change, edited, draft, liveEdits]
	);

	const rename = useCallback(
		(title: string) => {
			if (note === undefined) return;
			const { id, connectionId } = note;
			const at = noteRef(note);
			// Shown as given until the row has it, and the row's own again if it
			// never does.
			const landed = (row?: NoteRecord) => {
				liveEdits?.landed(at, 'title', title, row?.updatedAt);
			};
			const named = () =>
				renameNote(db, id, title, { connectionId }).then(landed, () => {
					landed();
				});
			if (draft === undefined) {
				void named();
				return;
			}
			// A name is an edit: the draft is stored, and then named.
			void draft.store().then((stored) => (stored ? named() : landed()));
		},
		[draft, note, liveEdits]
	);

	/**
	 * Delete a note, from its row's `⋯` or a right-click on the row, the one
	 * open or any other (`NoteViewHandle`). Here either way, because what
	 * autosave holds is here — for the note open, and for any earlier one whose
	 * save failed — and what it holds goes with the note, for undo.
	 */
	const deleteOne = useCallback(
		(target: NoteRecord) => {
			// Written first, so the last words are in the row before it is a
			// tombstone: restoring it brings them back with it. Only the open note's
			// editor has any, but the flush is harmless for another.
			flush();
			// By the note's own source throughout: an id names a note only there, and
			// the one showing may have changed by the time a continuation runs.
			const home = { connectionId: target.connectionId };
			void deleteNote(db, target.id, home)
				// Everything out has come back, and what had failed has had one more
				// try — into the tombstone, which keeps an edit and stays deleted.
				.then(settle)
				// Deleted either way; a row that cannot be read is the note as shown.
				.then(() => getNote(db, target.id, home).catch(() => undefined))
				.then((row) => {
					// Only now that it is deleted, and nothing before: a held edit
					// retried after sync has purged the row would bring the note back
					// (`saveNoteBody`), here and on the provider. What is let go is
					// what the store never took, and undo cannot bring back less than
					// the user had written — so it goes along. Asked of autosave, by
					// note, rather than remembered here: a save that went into a
					// conflict copy is stored, and offered again it would be copied
					// again.
					const unstored = forget(noteRef(target));
					const deleted = row ?? target;
					if (unstored === undefined) {
						onDeleted(deleted);
						return;
					}
					if (unstored.displaced) {
						onDeleted(deleted, unstored.value);
						return;
					}
					const { body, origin } = unstored.value;
					onDeleted({ ...deleted, body, bodyOrigin: origin });
				});
		},
		[flush, forget, onDeleted, settle]
	);

	useImperativeHandle(handle, () => ({ deleteNote: deleteOne }), [deleteOne]);

	const mode: EditorMode | undefined = locked ? 'raw' : (note?.editorMode ?? defaultMode);

	const { retry, retryable } = unsupported;
	const toggleMode = useCallback(() => {
		if (noteId === undefined || mode === undefined) return;
		// Held in raw mode: the only way out is the rich editor's check, run again.
		if (locked) {
			retry();
			return;
		}
		// Nothing typed yet, so nothing to write first, and no row to remember
		// the mode on.
		if (draft !== undefined) {
			draft.setMode(otherMode(mode));
			return;
		}
		// Write the pending edit first: the incoming editor loads from the note
		// record, and the mode switch itself must never be what saves — or lose —
		// what the user typed. `rebased` flushes, and says the editor that comes
		// next starts from the stored body rather than from what this one held.
		rebased();
		void setNoteEditorMode(db, noteId, otherMode(mode), { connectionId: note?.connectionId });
	}, [rebased, mode, noteId, note?.connectionId, locked, retry, draft]);

	// The element the outline shares the room of, as state rather than a ref:
	// a note opening mounts it, and the width has to be asked of the new one.
	const [body, setBody] = useState<HTMLDivElement | null>(null);
	const layout = useNoteLayout(noteId, body);

	// A count of askings rather than a boolean: asking again with the bar already
	// open re-focuses and selects its field, which is what `Mod+F` does
	// everywhere else, and the bar needs to be able to tell one asking from the
	// next to do it.
	const [finding, setFinding] = useState(0);
	useCommand({
		id: 'note.find',
		label: 'Find in note',
		group: 'Note',
		chord: FIND,
		enabled: noteId !== undefined,
		run: () => {
			setFinding((times) => times + 1);
		},
	});

	// Registered rather than listened for. The chord the app watches and the
	// chord the palette prints are then the same one by construction, and a
	// second window listener cannot race this one for the same keystroke.
	useCommand({
		id: 'note.toggleMode',
		label: `Edit as ${MODE_LABELS[otherMode(mode ?? 'rich')].toLowerCase()}`,
		group: 'Note',
		chord: MODE_TOGGLE,
		enabled: noteId !== undefined && mode !== undefined && (!locked || retryable),
		run: toggleMode,
	});

	if (note === undefined) {
		return (
			<section className="note-view empty" aria-label="Note">
				<p className="muted placeholder">
					<NothingOpen onCreateNote={onCreateNote} onCreateNotebook={onCreateNotebook} />
				</p>
			</section>
		);
	}

	return (
		<FindTargetProvider>
			<NoteScreen
				note={note}
				mode={mode}
				lost={unsupported.lost}
				retryable={retryable}
				unsaved={autosave.failing}
				finding={finding}
				layout={layout}
				onBody={setBody}
				toggleMode={toggleMode}
				onClose={() => {
					setFinding(0);
				}}
				begun={draft !== undefined}
				liveEdits={liveEdits}
				renamings={renamings}
				onRename={rename}
				onTitleDone={() => {
					focusEditor(body);
				}}
				onUserEdit={onUserEdit}
				onUnsupported={unsupported.report}
				// A body from outside is on screen now. What was typed before it
				// is not under whatever is typed next — a new sitting, so the next
				// edit cannot stand for a held one — and what is still pending was
				// not typed over it: saved as the body, it would put text the
				// editor no longer shows over the text it does.
				onAdopted={overtaken}
			/>
		</FindTargetProvider>
	);
};

// Markdown is drawn as code: the `M↓` mark it had was a box of small strokes
// that could not be told from the rich text icon beside it at a glance.
const MODE_ICONS: Record<EditorMode, IconName> = { rich: 'rich-text', raw: 'code' };

const tabTitle = (
	tab: EditorMode,
	current: boolean,
	locked: boolean,
	retryable: boolean
): string => {
	const name = MODE_LABELS[tab].toLowerCase();
	if (current) return `Editing as ${name}`;
	if (locked && retryable) return `Try the ${name} editor again (Ctrl/Cmd+E)`;
	if (locked) return 'This note has to stay in markdown mode until it is changed';
	return `Switch to ${name} (Ctrl/Cmd+E)`;
};

/**
 * The two editors as a pair of tabs, the one in use pressed. Two buttons
 * rather than one that names the mode it is in: a single toggle labelled with
 * where you are reads as where it will take you, and an icon cannot carry the
 * difference at all.
 *
 * Pressing the tab already in use does nothing. A note the rich editor cannot
 * represent keeps its markdown tab, pressed, and the rich one is disabled until
 * the note has been changed, when pressing it asks the rich editor again.
 */
const ModeTabs = ({
	mode,
	locked,
	retryable,
	toggleMode,
}: {
	mode: EditorMode;
	locked: boolean;
	retryable: boolean;
	toggleMode: () => void;
}) => (
	<div className="mode-tabs" role="group" aria-label="Editor">
		{(['rich', 'raw'] as const).map((tab) => {
			const current = tab === mode;
			return (
				<button
					key={tab}
					type="button"
					aria-label={MODE_LABELS[tab]}
					aria-pressed={current}
					disabled={!current && locked && !retryable}
					title={tabTitle(tab, current, locked, retryable)}
					onClick={() => {
						if (!current) toggleMode();
					}}
				>
					<Icon name={MODE_ICONS[tab]} />
				</button>
			);
		})}
	</div>
);

/**
 * Everything below the provider.
 *
 * Split out because the bar and the editors have to be inside the same
 * `FindTargetProvider` — the editor offers itself to it and the bar reads it —
 * and because `NoteView` is at the complexity limit without it.
 */
/**
 * Where the note is, with its notebook under the name being typed while it is
 * renamed. Its own component, so a keystroke redraws the path and not the note.
 */
const NotePath = ({ path, renamings }: { path: string; renamings: Renamings | undefined }) => {
	const shown = shownFolder(path, useRenaming(renamings));
	return (
		<span className="muted path" title={shown}>
			{shown}
		</span>
	);
};

const NoteScreen = ({
	note,
	mode,
	lost,
	retryable,
	unsaved,
	finding,
	layout,
	onBody,
	toggleMode,
	onClose,
	begun,
	liveEdits,
	renamings,
	onRename,
	onTitleDone,
	onUserEdit,
	onUnsupported,
	onAdopted,
}: {
	note: NoteRecord;
	mode: EditorMode | undefined;
	/** What the rich editor could not show, while the note is held in raw mode. */
	lost: StructuralDifference | undefined;
	/** The note has changed since, and the rich editor may be asked again. */
	retryable: boolean;
	/** A save was rejected, and what it held is still only in this tab. */
	unsaved: boolean;
	finding: number;
	layout: ReturnType<typeof useNoteLayout>;
	onBody: (element: HTMLDivElement | null) => void;
	toggleMode: () => void;
	onClose: () => void;
	/** A draft: begun just now, stored nowhere yet (`NoteViewProps.draft`). */
	begun: boolean;
	liveEdits: LiveEdits | undefined;
	renamings: Renamings | undefined;
	onRename: (title: string) => void;
	onTitleDone: () => void;
	onUserEdit: (body: string, origin: string) => void;
	onUnsupported: (lost: StructuralDifference) => void;
	onAdopted: () => void;
}) => {
	// Whether there is an outline to open. A button for a rail that would be
	// empty is a button that does nothing when pressed.
	const outlined = useMemo(() => headings(note.body).length > 0, [note.body]);

	return (
		<section className="note-view" aria-label="Note">
			<header className="note-header">
				<TitleField
					key={noteRef(note)}
					note={note}
					liveEdits={liveEdits}
					startFocused={begun}
					onRename={onRename}
					onDone={onTitleDone}
				/>
				<div className="note-actions">
					<NotePath path={note.path} renamings={renamings} />
					{layout.compact && mode === 'rich' && (
						<button
							type="button"
							className="note-icon"
							onClick={layout.toggleToolbar}
							aria-label="Format"
							aria-pressed={layout.toolbar === 'bottom'}
							title={
								layout.toolbar === 'bottom'
									? 'Hide the formatting toolbar'
									: 'Show the formatting toolbar'
							}
						>
							<Icon name="format" />
						</button>
					)}
					{mode !== undefined && (
						<ModeTabs
							mode={mode}
							locked={lost !== undefined}
							retryable={retryable}
							toggleMode={toggleMode}
						/>
					)}
					{/* At the right-hand edge: the rail it opens is the note's, and
					    is drawn there. */}
					{outlined && (
						<button
							type="button"
							className="note-icon"
							onClick={layout.toggleOutline}
							aria-label="Outline"
							aria-pressed={layout.showOutline}
							// Pressing it while the flyout is open closes it, so a
							// press outside the flyout that lands here is not one.
							data-outline-toggle=""
							title={layout.showOutline ? 'Hide the outline' : 'Show the outline'}
						>
							<Icon name="outline" />
						</button>
					)}
				</div>
			</header>

			{/*
			 * An alert, and it stays for as long as it is true. It does not say "this
			 * note": a held edit may be to the note that was open before this one.
			 * Nor what went wrong, which the app cannot tell — only what is safe to
			 * do about it.
			 */}
			{unsaved && (
				<p className="banner banner-alert" role="alert">
					Changes are not being saved on this device. Copy your text somewhere safe, then
					reload.
				</p>
			)}

			{lost !== undefined && <UnsupportedBanner lost={lost} retryable={retryable} />}

			{/*
			 * A rename or a tag edit cannot reach a file whose frontmatter has a
			 * YAML error in it: the app will not rewrite a block it had to guess
			 * at, so the change lands in the app and not in the file, and the next
			 * sync reads the old values back over it. Saying so is the difference
			 * between a limitation and a note that quietly refuses to be renamed.
			 */}
			{/*
			 * `role="note"`, not `status`: this is true of the note from the moment
			 * it opens, so it is a standing remark rather than something that has
			 * just happened — and two live regions announcing at once is one too
			 * many when a note is also in the rich editor's unsupported state.
			 */}
			{!frontmatterIsEditable(note.frontmatter) && (
				<p className="banner" role="note">
					There is a YAML error in this note’s frontmatter, so its title and tags cannot
					be saved back to the file — the text is left exactly as it is rather than
					guessed at. Everything else about the note works as usual.
				</p>
			)}

			{finding > 0 && <FindBar focusToken={finding} onClose={onClose} />}

			<NoteBody
				note={note}
				mode={mode}
				showOutline={layout.showOutline}
				flyout={layout.flyout}
				focusEditor={!layout.touch}
				onCloseOutline={layout.closeOutline}
				toolbar={layout.toolbar}
				onUserEdit={onUserEdit}
				onUnsupported={onUnsupported}
				onAdopted={onAdopted}
				onBody={onBody}
			/>
		</section>
	);
};
