import { useCallback, useEffect, useImperativeHandle, useState } from 'react';

import { parseChord } from '../../commands/chord.js';
import { useCommand } from '../../commands/context.js';
import { FindTargetProvider } from '../../editor/findTarget.js';
import { type EditorMode, otherMode } from '../../editor/mode.js';
import { type SaveContext, useAutosave } from '../../editor/useAutosave.js';
import { useLatest } from '../../hooks/useLatest.js';
import { rich } from '../../i18n/rich.js';
import { t } from '../../i18n/t.js';
import { db, type NoteRecord, noteRef } from '../../store/db.js';
import { beforeClosing } from '../../store/heldEdits.js';
import { useDefaultEditorMode } from '../../store/hooks.js';
import {
	deleteNote,
	getNote,
	renameNote,
	saveNoteBody,
	setNoteEditorMode,
	setScratchMarks,
} from '../../store/notes.js';
import { scratchMarks } from '../../store/scratchpad.js';
import { useOpeningNotice } from '../opening.js';
import { focusEditor, inAField } from './focus.js';
import { NoteScreen } from './NoteScreen.js';
import type {
	MarkChange,
	NoteDraft,
	NoteViewProps,
	ScratchEditing,
	ScratchScreen,
} from './types.js';
import { useUnsupported } from './unsupported.js';
import { useFileCleanup } from './useFileCleanup.js';
import { useNoteLayout } from './useNoteLayout.js';

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

interface Edit {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
	/** The note as it was shown when this was typed. */
	note: NoteRecord | undefined;
}

const sameBase = (next: Edit, pending: Edit): boolean => next.origin === pending.origin;

/** What the pane says while the note asked for is read, once that is taking a while. */
const Opening = () => {
	const late = useOpeningNotice();
	return (
		<p className="muted placeholder" role="status">
			{late ? t('notes.view.opening') : null}
		</p>
	);
};

/** What the empty pane says, offering what can be done from here. */
const NothingOpen = ({
	onCreateNote,
	onCreateNotebook,
}: Pick<NoteViewProps, 'onCreateNote' | 'onCreateNotebook'>) => {
	if (onCreateNote !== undefined) {
		return rich('notes.view.nothingOpen', {
			create: (words) => (
				<button type="button" className="link-button" onClick={onCreateNote}>
					{words}
				</button>
			),
		});
	}
	if (onCreateNotebook !== undefined) {
		return rich('notes.view.noNotebook', {
			create: (words) => (
				<button type="button" className="link-button" onClick={onCreateNotebook}>
					{words}
				</button>
			),
		});
	}
	return t('notes.view.selectNote');
};

/**
 * The caret into a scratch note's body as it opens (`ScratchEditing`), once
 * there is an editor to put it in: the rich editor is built a frame or more
 * after the note mounts. Given up after a second, and never taken from a field
 * the user has got to first.
 */
const useFocusBody = (wanted: boolean, noteId: string | undefined, body: Element | null) => {
	useEffect(() => {
		if (!wanted || noteId === undefined || body === null) return undefined;
		const state = { frame: 0, left: 60 };
		const attempt = () => {
			const editor = body.querySelector<HTMLElement>('.ProseMirror');
			if (editor !== null) {
				if (!inAField()) editor.focus();
				return;
			}
			state.left -= 1;
			if (state.left > 0) state.frame = requestAnimationFrame(attempt);
		};
		state.frame = requestAnimationFrame(attempt);
		return () => {
			cancelAnimationFrame(state.frame);
		};
	}, [wanted, noteId, body]);
};

/**
 * Which editor a note is shown in. One the rich editor cannot represent is
 * held in raw mode; a scratch note is otherwise always rich, since its editor
 * has no tabs to change it with; any other is in the one it was left in.
 */
const editorModeOf = (
	note: NoteRecord | undefined,
	locked: boolean,
	scratch: boolean,
	defaultMode: EditorMode | undefined
): EditorMode | undefined => {
	if (locked) return 'raw';
	if (scratch) return 'rich';
	return note?.editorMode ?? defaultMode;
};

const scratchScreen = (
	scratch: ScratchEditing | undefined,
	note: NoteRecord,
	onMark: (change: MarkChange) => void,
	deleteOne: ((note: NoteRecord) => void) | undefined
): ScratchScreen | undefined =>
	scratch === undefined
		? undefined
		: {
				...scratch,
				marks: scratchMarks(note),
				onMark,
				onDelete:
					deleteOne === undefined
						? undefined
						: () => {
								deleteOne(note);
							},
			};

/** Pin or colour a scratch note, storing it first if it is a draft. */
const useScratchMarking = (note: NoteRecord | undefined, draft: NoteDraft | undefined) =>
	useCallback(
		(change: MarkChange) => {
			if (note === undefined) return;
			const { id, connectionId } = note;
			const marked = () => setScratchMarks(db, id, change, { connectionId });
			if (draft === undefined) {
				void marked();
				return;
			}
			void draft.store().then((stored) => (stored ? marked() : undefined));
		},
		[note, draft]
	);

export const NoteView = ({
	note,
	onDeleted,
	onCreateNote,
	onCreateNotebook,
	opening = false,
	draft,
	liveEdits,
	renamings,
	onProblem,
	scratch,
	ref: handle,
}: NoteViewProps) => {
	const noteId = note?.id;
	const defaultMode = useDefaultEditorMode();

	// By source as well as id, like everything else held here across renders:
	// another source's note of the same id is another note.
	const ref = note === undefined ? undefined : noteRef(note);

	// The note as last shown. An edit carries it: a copy of the edit is written
	// from it, and a note a sync deleted is brought back as it.
	const shownRef = useLatest(note);

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
	// What this visit took out of the note, looked at once it is left.
	const { edited: editedInVisit, added: addedInVisit } = useFileCleanup(note);

	const onUserEdit = useCallback(
		(body: string, origin: string) => {
			// Stored before the edit is held: the save that follows opens its
			// write after this one, and so finds the note there to write into.
			if (draft !== undefined) void draft.store();
			const typedInto = shownRef.current;
			if (typedInto !== undefined) liveEdits?.typed(noteRef(typedInto), body, origin);
			change({ body, origin, note: typedInto });
			edited();
			editedInVisit(body, origin);
		},
		[change, edited, draft, liveEdits, editedInVisit, shownRef]
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
				})
				// Turned down by the store: the note is where it was, nothing
				// held for it was let go, and there is no delete to undo. Said,
				// as the scratchpad and the vault say it, rather than a note
				// that stays put after Delete with nothing said.
				.catch(() => {
					onProblem?.({ message: t('notes.view.notDeleted'), tone: 'error' });
				});
		},
		[flush, forget, onDeleted, onProblem, settle]
	);

	useImperativeHandle(handle, () => ({ deleteNote: deleteOne }), [deleteOne]);

	const mode = editorModeOf(note, locked, scratch !== undefined, defaultMode);
	const mark = useScratchMarking(note, draft);

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
	const layout = useNoteLayout(noteId, body, scratch !== undefined);
	useFocusBody(scratch?.focusBody === true, noteId, body);

	// A count of askings rather than a boolean: asking again with the bar already
	// open re-focuses and selects its field, which is what `Mod+F` does
	// everywhere else, and the bar needs to be able to tell one asking from the
	// next to do it.
	const [finding, setFinding] = useState(0);
	useCommand({
		id: 'note.find',
		label: t('notes.commands.find'),
		group: t('shell.commands.group.note'),
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
		label: t(`notes.commands.editAs.${otherMode(mode ?? 'rich')}`),
		group: t('shell.commands.group.note'),
		chord: MODE_TOGGLE,
		// A scratch note's editor has no other editor to go to, but a note held
		// in raw mode can still ask the rich one again.
		enabled:
			noteId !== undefined &&
			mode !== undefined &&
			(scratch === undefined ? !locked || retryable : locked && retryable),
		run: toggleMode,
	});

	if (note === undefined) {
		return (
			<section
				className="note-view empty"
				aria-label={t('notes.view.label')}
				aria-busy={opening || undefined}
			>
				{opening ? (
					<Opening />
				) : (
					<p className="muted placeholder">
						<NothingOpen
							onCreateNote={onCreateNote}
							onCreateNotebook={onCreateNotebook}
						/>
					</p>
				)}
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
				draft={draft}
				liveEdits={liveEdits}
				renamings={renamings}
				onRename={rename}
				onTitleDone={() => {
					focusEditor(body);
				}}
				onUserEdit={onUserEdit}
				onProblem={onProblem}
				onUnsupported={unsupported.report}
				// A body from outside is on screen now. What was typed before it
				// is not under whatever is typed next — a new sitting, so the next
				// edit cannot stand for a held one — and what is still pending was
				// not typed over it: saved as the body, it would put text the
				// editor no longer shows over the text it does.
				onAdopted={overtaken}
				onAdded={addedInVisit}
				scratch={scratchScreen(
					scratch,
					note,
					mark,
					draft === undefined ? deleteOne : undefined
				)}
			/>
		</FindTargetProvider>
	);
};
