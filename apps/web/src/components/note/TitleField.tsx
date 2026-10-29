import { useDeferredValue, useEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import { type NoteRecord, noteRef } from '../../store/db.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../../store/liveEdits.js';
import { isUnnamed } from '../../store/notes.js';
import { titleShown } from '../../store/titles.js';

/**
 * `draft` is null except while the user is actually typing in the field, so a
 * title that changes underneath — a rename from sync, or a heading edit in the
 * body — shows through without any state to keep in step. A heading being
 * typed into a note not named yet shows through as it is typed, as it does in
 * the list (`shownNote`).
 */
export const TitleField = ({
	note,
	liveEdits,
	startFocused,
	onRename,
	onDone,
	blankWhenUnnamed = false,
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
	/**
	 * A scratch note's: a note with no name has an empty field that says
	 * "Title", where a notebook's says "Untitled" (docs/ARCHITECTURE.md §7,
	 * "The scratchpad"). A name its first heading gives it shows through.
	 */
	blankWhenUnnamed?: boolean;
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
			!abandoned &&
			trimmed !== undefined &&
			trimmed !== '' &&
			trimmed !== note.title &&
			// What the field showed, given back: not a name, if it is not the title.
			trimmed !== titleShown(note.title);
		// Said as given, trimmed, until the row has it; or let go, and the row's
		// name is the one shown again.
		liveEdits?.naming(ref, given ? trimmed : undefined);
		if (given) onRename(trimmed);
	};

	const blank = blankWhenUnnamed && isUnnamed(note) && shown.title === note.title;

	return (
		<input
			ref={field}
			className="note-title-input"
			aria-label={t('notes.view.titleLabel')}
			placeholder={blankWhenUnnamed ? t('notes.view.titlePlaceholder') : undefined}
			value={draft ?? (blank ? '' : titleShown(shown.title))}
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
