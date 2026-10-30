import { useCallback, useEffect } from 'react';

import { type EditorMode, otherMode } from '../../editor/mode.js';
import { type SaveContext, useAutosave } from '../../editor/useAutosave.js';
import { useLatest } from '../../hooks/useLatest.js';
import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { type NoteRecord, noteRef } from '../../store/db.js';
import { beforeClosing } from '../../store/heldEdits.js';
import { useDefaultEditorMode } from '../../store/hooks.js';
import { deleteForUndo, renameNote, saveNoteBody, setNoteEditorMode } from '../../store/notes.js';
import { useNotices } from '../ui/notices.js';
import type { NoteViewProps } from './types.js';
import { useUnsupported } from './unsupported.js';
import { useFileCleanup } from './useFileCleanup.js';

interface Edit {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
	/** The note as it was shown when this was typed. */
	note: NoteRecord | undefined;
}

const sameBase = (next: Edit, pending: Edit): boolean => next.origin === pending.origin;

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

/**
 * The open note's sitting: what is typed into it and how it is saved, its
 * name, its deletion, and the editor it is shown in. `onUserEdit` is the only
 * caller of autosave's `change`, so a note becomes dirty on a user's edit and
 * on nothing else — not on loading, a mode switch or a re-serialization.
 */
export const useNoteSession = ({
	note,
	draft,
	liveEdits,
	onDeleted,
	isScratch,
}: Pick<NoteViewProps, 'note' | 'draft' | 'liveEdits' | 'onDeleted'> & {
	/** A scratch note, whose editor is always the rich one. */
	isScratch: boolean;
}) => {
	const db = useDb();
	const { say } = useNotices();
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
		[noteId, ref, liveEdits, db]
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
		[draft, note, liveEdits, db]
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
			// By the note's own source: an id names a note only there, and the
			// one showing may have changed by the time a continuation runs.
			// Settled once deleted: everything out has come back, and what had
			// failed has had one more try — into the tombstone, which keeps an
			// edit and stays deleted.
			void deleteForUndo(db, target, { settle }).then(
				(deleted) => {
					// Only now that it is deleted, and nothing before: a held edit
					// retried after sync has purged the row would bring the note back
					// (`saveNoteBody`), here and on the provider. What is let go is
					// what the store never took, and undo cannot bring back less than
					// the user had written — so it goes along. Asked of autosave, by
					// note, rather than remembered here: a save that went into a
					// conflict copy is stored, and offered again it would be copied
					// again.
					const unstored = forget(noteRef(target));
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
				},
				// Turned down by the store: the note is where it was, nothing
				// held for it was let go, and there is no delete to undo. Said,
				// as the scratchpad and the vault say it, rather than a note
				// that stays put after Delete with nothing said.
				() => {
					say({ message: t('notes.view.notDeleted'), tone: 'error' });
				}
			);
		},
		[flush, forget, onDeleted, say, settle, db]
	);

	const mode = editorModeOf(note, locked, isScratch, defaultMode);

	const { retry } = unsupported;
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
	}, [rebased, mode, noteId, note?.connectionId, locked, retry, draft, db]);

	return {
		mode,
		/** The rich editor's check, and what it found it could not represent. */
		unsupported,
		/** Edits the store has not taken: the save is failing. */
		failing: autosave.failing,
		/** A body from outside is on screen now (`NoteScreen`'s `onAdopted`). */
		overtaken,
		/** A file this visit added to the note (`useFileCleanup`). */
		addedInVisit,
		onUserEdit,
		rename,
		deleteOne,
		toggleMode,
	};
};
