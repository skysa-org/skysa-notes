import { parentPath, ROOT } from '@skysa/core';
import { type ReactNode } from 'react';

import { type NoteRecord } from '../store/db.js';
import { type NoteHit } from '../store/search.js';
import { folderLabel } from '../store/tree.js';

/**
 * The middle pane: the notes in the selected notebook, most recently edited
 * first — or, while there is something in the search field, what matches it
 * anywhere in the app.
 *
 * Both are the same list of the same rows, so they are one pane rather than two:
 * searching is a different question about the notes, not a different place to
 * be, and a search that opened a pane of its own would leave the user somewhere
 * they have to find their way back from.
 */

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
	/**
	 * False while the store is still loading — the notebooks or the count of
	 * loose notes — so an app that is merely slow is not mistaken for an empty
	 * one and told to create a notebook it may already have notes outside of.
	 */
	storeLoaded: boolean;
	/** What is in the search field. Empty means the notebook's notes are shown. */
	query: string;
	onQuery: (query: string) => void;
	/** Matches for `query`, or undefined while the first one is being answered. */
	results: readonly NoteHit[] | undefined;
}

/**
 * What to show instead of the list. Pulled out of the markup because it is the
 * only place the empty states — still loading, nowhere to put a note, an empty
 * notebook, and a search nothing answers — have to be told apart.
 */
const placeholderFor = ({
	notes,
	folderPath,
	storeLoaded,
	query,
	results,
}: Pick<NoteListProps, 'notes' | 'folderPath' | 'storeLoaded' | 'query' | 'results'>):
	string | undefined => {
	if (query !== '') {
		if (results === undefined) return 'Searching…';
		return results.length === 0 ? `Nothing matches “${query}”.` : undefined;
	}
	if (folderPath === undefined) {
		return storeLoaded ? 'Create a notebook to start writing.' : 'Loading…';
	}
	if (notes === undefined) return 'Loading…';
	return notes.length === 0 ? 'No notes here yet.' : undefined;
};

const preview = (body: string): string => {
	const text = body
		// All three spellings: a note written on a pre-OS X Mac has no `\n` in it
		// at all, and splitting on one yields a single line the `.slice(1)` below
		// then drops, leaving every such note with an empty excerpt.
		.split(/\r\n|\n|\r/)
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

interface NoteRowProps {
	note: NoteRecord;
	selected: boolean;
	onSelect: () => void;
	/** The line under the title: when it was edited, and for a result, where. */
	meta: string;
	/** The line under that: the note's opening, or the match in it. */
	detail: ReactNode;
}

const NoteRow = ({ note, selected, onSelect, meta, detail }: NoteRowProps) => (
	<li>
		<button
			type="button"
			className={selected ? 'row selected' : 'row'}
			onClick={onSelect}
			aria-current={selected ? 'true' : undefined}
		>
			<span className="note-title">
				{note.title}
				{note.dirty === 1 && (
					<span className="dot" title="Not yet synced" aria-label="Not yet synced" />
				)}
			</span>
			<span className="note-meta">{meta}</span>
			{detail}
		</button>
	</li>
);

/**
 * The matched words are marked in place. `<mark>` rather than a colour of our
 * own: it is what the element is for, it survives a high-contrast mode, and a
 * screen reader can be told the run is marked.
 */
const Excerpt = ({ hit }: { hit: NoteHit }) => (
	<span className="note-preview">
		{/* The runs of one excerpt have no identity of their own: they are one
		    string decomposed, in order, and decomposed again whenever the query
		    changes. Where they sit in it is the only key there is. */}
		{hit.excerpt.map((run, index) =>
			run.hit ? (
				<mark key={`${String(index)}:${run.text}`}>{run.text}</mark>
			) : (
				<span key={`${String(index)}:${run.text}`}>{run.text}</span>
			)
		)}
	</span>
);

export const NoteList = ({
	notes,
	selectedNoteId,
	onSelectNote,
	onCreateNote,
	folderPath,
	storeLoaded,
	query,
	onQuery,
	results,
}: NoteListProps) => {
	const searching = query !== '';
	const placeholder = placeholderFor({ notes, folderPath, storeLoaded, query, results });
	const heading = folderPath === undefined ? 'Notes' : folderLabel(folderPath);

	return (
		<section className="note-list" aria-label="Notes">
			<div className="pane-header">
				<h2>{searching ? 'Search' : heading}</h2>
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

			<input
				// `search` rather than `text`: it is what the field is, and the
				// browser offers its own way to empty one.
				type="search"
				className="note-search"
				aria-label="Search notes"
				placeholder="Search notes"
				value={query}
				onChange={(event) => {
					onQuery(event.target.value);
				}}
				onKeyDown={(event) => {
					// Escape puts the user back in the notebook they were in, which
					// is where they were before they typed. Without it the only way
					// out is to delete what they wrote, character by character.
					if (event.key === 'Escape') onQuery('');
				}}
			/>

			{placeholder !== undefined && <p className="muted placeholder">{placeholder}</p>}

			{searching && results !== undefined && results.length > 0 && (
				<ul>
					{results.map((hit) => (
						<NoteRow
							key={hit.note.id}
							note={hit.note}
							selected={hit.note.id === selectedNoteId}
							onSelect={() => {
								onSelectNote(hit.note.id);
							}}
							// Which notebook, because a search crosses all of them and
							// two notes can share a title.
							meta={`${folderLabel(parentPath(hit.note.path))} · ${editedAt(hit.note.updatedAt)}`}
							detail={<Excerpt hit={hit} />}
						/>
					))}
				</ul>
			)}

			{!searching && notes !== undefined && notes.length > 0 && (
				<ul>
					{notes.map((note) => (
						<NoteRow
							key={note.id}
							note={note}
							selected={note.id === selectedNoteId}
							onSelect={() => {
								onSelectNote(note.id);
							}}
							meta={editedAt(note.updatedAt)}
							detail={
								preview(note.body) === '' ? null : (
									<span className="note-preview">{preview(note.body)}</span>
								)
							}
						/>
					))}
				</ul>
			)}
		</section>
	);
};
