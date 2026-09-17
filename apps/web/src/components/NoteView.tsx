import { frontmatterIsEditable } from '@skysa/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type EditorMode, isModeToggleShortcut, MODE_LABELS, otherMode } from '../editor/mode.js';
import { RawEditor } from '../editor/RawEditor.js';
import { RichEditor } from '../editor/RichEditor.js';
import { useAutosave } from '../editor/useAutosave.js';
import { db, type NoteRecord } from '../store/db.js';
import { useDefaultEditorMode } from '../store/hooks.js';
import { deleteNote, renameNote, saveNoteBody, setNoteEditorMode } from '../store/notes.js';

/** The open note: its title, its body, and the actions that act on it. */

export interface NoteViewProps {
	note: NoteRecord | undefined;
	onDeleted: () => void;
}

/**
 * `draft` is null except while the user is actually typing in the field, so a
 * title that changes underneath — a rename from sync, or a heading edit in the
 * body — shows through without any state to keep in step.
 */
const TitleField = ({ note }: { note: NoteRecord }) => {
	const [draft, setDraft] = useState<string | null>(null);
	// Escape has to reach `commit` through something `commit` can read
	// synchronously. `blur()` dispatches the blur event before React has
	// re-rendered, so `commit` runs against the render in which `draft` is still
	// the typed value: clearing state and blurring means Escape renames the note
	// — and the file on disk — to whatever the user was trying to throw away.
	const cancelled = useRef(false);

	const commit = () => {
		const trimmed = draft?.trim();
		const abandoned = cancelled.current;
		cancelled.current = false;
		setDraft(null);
		if (abandoned) return;
		if (trimmed === undefined || trimmed === '' || trimmed === note.title) return;
		void renameNote(db, note.id, trimmed);
	};

	return (
		<input
			className="note-title-input"
			aria-label="Note title"
			value={draft ?? note.title}
			onChange={(event) => {
				setDraft(event.target.value);
			}}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === 'Enter') event.currentTarget.blur();
				if (event.key === 'Escape') {
					cancelled.current = true;
					event.currentTarget.blur();
				}
			}}
		/>
	);
};

interface Edit {
	body: string;
	/** See `NoteRecord.bodyOrigin`. */
	origin: string;
	/** The note as it was shown when this was typed. */
	note: NoteRecord | undefined;
}

const sameBase = (next: Edit, pending: Edit): boolean => next.origin === pending.origin;

export const NoteView = ({ note, onDeleted }: NoteViewProps) => {
	const noteId = note?.id;
	const defaultMode = useDefaultEditorMode();

	/**
	 * The note the rich editor reported it could not represent. Held by id rather
	 * than as a boolean so moving to another note clears it without an effect.
	 */
	const [unsupportedId, setUnsupportedId] = useState<string | null>(null);
	const unsupported = noteId !== undefined && unsupportedId === noteId;

	// The note as last shown. An edit carries it: a copy of the edit is written
	// from it, and a note a sync deleted is brought back as it.
	const shown = useRef(note);
	useEffect(() => {
		shown.current = note;
	}, [note]);

	const save = useCallback(
		({ body, origin, note: typedInto }: Edit) => {
			if (noteId === undefined) return;
			void saveNoteBody(
				db,
				noteId,
				body,
				typedInto?.id === noteId ? { origin, note: typedInto } : undefined
			);
		},
		[noteId]
	);

	const autosave = useAutosave<Edit>({
		key: noteId ?? 'none',
		save,
		// An edit typed into a body a sync has since replaced is saved on its own,
		// before the next one — made from the new body — can stand for it.
		supersedes: sameBase,
	});
	const { change, flush } = autosave;
	const onUserEdit = useCallback(
		(body: string, origin: string) => {
			change({ body, origin, note: shown.current });
		},
		[change]
	);

	const mode: EditorMode | undefined = unsupported ? 'raw' : (note?.editorMode ?? defaultMode);

	const toggleMode = useCallback(() => {
		if (noteId === undefined || mode === undefined || unsupported) return;
		// Write the pending edit first: the incoming editor loads from the note
		// record, and the mode switch itself must never be what saves — or lose —
		// what the user typed.
		flush();
		void setNoteEditorMode(db, noteId, otherMode(mode));
	}, [flush, mode, noteId, unsupported]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isModeToggleShortcut(event)) return;
			event.preventDefault();
			toggleMode();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
		};
	}, [toggleMode]);

	if (note === undefined) {
		return (
			<section className="note-view empty" aria-label="Note">
				<p className="muted placeholder">Select a note, or create one.</p>
			</section>
		);
	}

	return (
		<section className="note-view" aria-label="Note">
			<header className="note-header">
				<TitleField key={note.id} note={note} />
				<div className="note-actions">
					<span className="muted path" title={note.path}>
						{note.path}
					</span>
					{mode !== undefined && (
						<button
							type="button"
							onClick={toggleMode}
							disabled={unsupported}
							aria-pressed={mode === 'raw'}
							title={
								unsupported
									? 'This note has to stay in markdown mode'
									: `Switch to ${MODE_LABELS[otherMode(mode)].toLowerCase()} (Ctrl/Cmd+E)`
							}
						>
							{MODE_LABELS[mode]}
						</button>
					)}
					<button
						type="button"
						onClick={() => {
							autosave.flush();
							void deleteNote(db, note.id).then(onDeleted);
						}}
					>
						Delete
					</button>
				</div>
			</header>

			{unsupported && (
				<p className="banner" role="status">
					This note uses markdown the rich editor has no way to show, so it stays in
					markdown mode. Nothing in it has been changed.
				</p>
			)}

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

			{mode === 'raw' && (
				<RawEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
				/>
			)}
			{mode === 'rich' && (
				<RichEditor
					noteId={note.id}
					body={note.body}
					origin={note.bodyOrigin ?? ''}
					onUserEdit={onUserEdit}
					onUnsupported={() => {
						setUnsupportedId(note.id);
					}}
				/>
			)}
		</section>
	);
};
