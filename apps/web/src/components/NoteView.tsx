import { useCallback, useState } from 'react';

import { RawEditor } from '../editor/RawEditor.js';
import { useAutosave } from '../editor/useAutosave.js';
import { db, type NoteRecord } from '../store/db.js';
import { deleteNote, renameNote, saveNoteBody } from '../store/notes.js';

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

	const commit = () => {
		const trimmed = draft?.trim();
		setDraft(null);
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
					setDraft(null);
					event.currentTarget.blur();
				}
			}}
		/>
	);
};

export const NoteView = ({ note, onDeleted }: NoteViewProps) => {
	const noteId = note?.id;

	const save = useCallback(
		(body: string) => {
			if (noteId === undefined) return;
			void saveNoteBody(db, noteId, body);
		},
		[noteId]
	);

	const autosave = useAutosave({ key: noteId ?? 'none', save });

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

			<RawEditor noteId={note.id} body={note.body} onUserEdit={autosave.change} />
		</section>
	);
};
