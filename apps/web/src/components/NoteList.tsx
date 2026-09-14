import { type NoteRecord } from '../store/db.js';

/** Notes in the selected notebook, most recently edited first. */

export interface NoteListProps {
	notes: NoteRecord[] | undefined;
	selectedNoteId: string | undefined;
	onSelectNote: (id: string) => void;
	onCreateNote: () => void;
	folderLabel: string;
}

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
}: NoteListProps) => (
	<section className="note-list" aria-label="Notes">
		<div className="pane-header">
			<h2>{folderLabel}</h2>
			<button
				type="button"
				className="icon"
				title="New note"
				aria-label="New note"
				onClick={onCreateNote}
			>
				+
			</button>
		</div>

		{notes === undefined && <p className="muted placeholder">Loading…</p>}

		{notes !== undefined && notes.length === 0 && (
			<p className="muted placeholder">No notes here yet.</p>
		)}

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
