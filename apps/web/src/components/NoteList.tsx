import { ROOT } from '@skysa/core';

import { type NoteRecord } from '../store/db.js';
import { folderLabel } from '../store/tree.js';

/** Notes in the selected notebook, most recently edited first. */

export interface NoteListProps {
	notes: NoteRecord[] | undefined;
	selectedNoteId: string | undefined;
	onSelectNote: (id: string) => void;
	onCreateNote: () => void;
	/**
	 * The open folder, or undefined when nothing is open. The root is a folder
	 * like any other here — it just holds the loose notes rather than a notebook.
	 */
	folderPath: string | undefined;
	/** False while the notebooks are still loading, so an empty app is not
	 * mistaken for one that has no notebooks. */
	notebooksLoaded: boolean;
}

/**
 * What to show instead of the list. Pulled out of the markup because it is the
 * only place the three empty states — still loading, nowhere to put a note,
 * and an empty notebook — have to be told apart.
 */
const placeholderFor = ({
	notes,
	folderPath,
	notebooksLoaded,
}: Pick<NoteListProps, 'notes' | 'folderPath' | 'notebooksLoaded'>): string | undefined => {
	if (folderPath === undefined) {
		return notebooksLoaded ? 'Create a notebook to start writing.' : 'Loading…';
	}
	if (notes === undefined) return 'Loading…';
	return notes.length === 0 ? 'No notes here yet.' : undefined;
};

const preview = (body: string): string => {
	const text = body
		.split('\n')
		.map((line) => line.replace(/^#{1,6}\s+/, '').trim())
		.filter((line) => line !== '')
		.slice(1)
		.join(' ');
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

const editedAt = (timestamp: number): string =>
	new Date(timestamp).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});

export const NoteList = ({
	notes,
	selectedNoteId,
	onSelectNote,
	onCreateNote,
	folderPath,
	notebooksLoaded,
}: NoteListProps) => {
	const placeholder = placeholderFor({ notes, folderPath, notebooksLoaded });

	return (
		<section className="note-list" aria-label="Notes">
			<div className="pane-header">
				<h2>{folderPath === undefined ? 'Notes' : folderLabel(folderPath)}</h2>
				<button
					type="button"
					className="icon"
					title="New note"
					aria-label="New note"
					// Every note the app creates lives in a notebook, so there is
					// nowhere to put one until a notebook is open. The root is not
					// a notebook: loose notes are imported, never created here.
					disabled={folderPath === undefined || folderPath === ROOT}
					onClick={onCreateNote}
				>
					+
				</button>
			</div>

			{placeholder !== undefined && <p className="muted placeholder">{placeholder}</p>}

			{notes !== undefined && notes.length > 0 && (
				<ul>
					{notes.map((note) => (
						<li key={note.id}>
							<button
								type="button"
								className={note.id === selectedNoteId ? 'row selected' : 'row'}
								onClick={() => {
									onSelectNote(note.id);
								}}
								aria-current={note.id === selectedNoteId ? 'true' : undefined}
							>
								<span className="note-title">
									{note.title}
									{note.dirty === 1 && (
										<span
											className="dot"
											title="Not yet synced"
											aria-label="Not yet synced"
										/>
									)}
								</span>
								<span className="note-meta">{editedAt(note.updatedAt)}</span>
								{preview(note.body) !== '' && (
									<span className="note-preview">{preview(note.body)}</span>
								)}
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
};
