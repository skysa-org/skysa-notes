import { type NoteRecord } from '../store/db.js';

/** Notes in the selected notebook, most recently edited first. */

export interface NoteListProps {
	notes: NoteRecord[] | undefined;
	selectedNoteId: string | undefined;
	onSelectNote: (id: string) => void;
	onCreateNote: () => void;
	/** The open notebook, or undefined when no notebook is open. */
	folderLabel: string | undefined;
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
	folderLabel,
	notebooksLoaded,
}: Pick<NoteListProps, 'notes' | 'folderLabel' | 'notebooksLoaded'>): string | undefined => {
	if (folderLabel === undefined) {
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
	folderLabel,
	notebooksLoaded,
}: NoteListProps) => {
	const placeholder = placeholderFor({ notes, folderLabel, notebooksLoaded });

	return (
		<section className="note-list" aria-label="Notes">
			<div className="pane-header">
				<h2>{folderLabel ?? 'Notes'}</h2>
				<button
					type="button"
					className="icon"
					title="New note"
					aria-label="New note"
					// Every note lives in a notebook, so there is nowhere to put one
					// until a notebook is open.
					disabled={folderLabel === undefined}
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
