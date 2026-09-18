import { parentPath, previewLines, ROOT } from '@skysa/core';
import { type ReactNode, type RefObject } from 'react';

import { type NoteRecord } from '../store/db.js';
import { type NoteHit, SEARCH_LIMIT } from '../store/search.js';
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
	/** So a command can put the cursor in the field without hunting the DOM. */
	queryRef?: RefObject<HTMLInputElement | null>;
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
	if (query.trim() !== '') {
		if (results === undefined) return 'Searching…';
		if (results.length === 0) return `Nothing matches “${query}”.`;
		// Cut short, so say so: the note they want may be the one not shown, and
		// the way to it is another word rather than a scrollbar. `find` hands
		// back one more than is shown for exactly this, so a search that matched
		// fifty notes exactly is not told that some were left out.
		return results.length <= SEARCH_LIMIT
			? undefined
			: `Showing the first ${String(SEARCH_LIMIT)}. Add a word to narrow the search.`;
	}
	if (folderPath === undefined) {
		return storeLoaded ? 'Create a notebook to start writing.' : 'Loading…';
	}
	if (notes === undefined) return 'Loading…';
	return notes.length === 0 ? 'No notes here yet.' : undefined;
};

/**
 * Whether a line is the note's title written out again.
 *
 * Emphasis is ignored on both sides. The title is derived from the *parsed*
 * heading, so `# **Alpha**` gives a title of "Alpha" while the line still reads
 * `**Alpha**` — the same heading, spelled two ways, and comparing them
 * character for character would print it twice.
 *
 * Both sides, because the parse removes only the characters that *were*
 * emphasis and leaves the rest: a title of `setup_guide` keeps its underscore,
 * so stripping the line alone left "setupguide" against "setup_guide" and the
 * heading was printed twice after all.
 */
const bare = (text: string): string => text.replaceAll(/[*_`]/g, '').trim();

const isTitle = (line: string | undefined, title: string): boolean =>
	line !== undefined && bare(line) === bare(title);

/**
 * The note's opening, after its title. `previewLines` decides what a readable
 * line is — the same rule the search excerpt is cut by — and the title is
 * dropped from the front of them so the row does not say it twice.
 *
 * Dropped by *identity*, not by position. Taking the first line on the
 * assumption that it is the heading was wrong in both directions: a note
 * beginning with the `<br />` the editor writes for an empty paragraph has no
 * heading on line one, and lost a line of the user's own writing instead — and
 * a note whose heading comes after an introduction had the introduction eaten
 * and the heading shown. Comparing against the title the row is already
 * displaying is the question actually being asked.
 */
const preview = (body: string, title: string): string => {
	const lines = previewLines(body);
	const opening = isTitle(lines[0], title) ? lines.slice(1) : lines;
	const text = opening.join(' ');
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

/** The opening of a note, or nothing at all when it has none to show. */
const Preview = ({ note }: { note: NoteRecord }) => {
	const text = preview(note.body, note.title);
	return text === '' ? null : <span className="note-preview">{text}</span>;
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
 * The matched words are marked in place. `<mark>` rather than a span of our own
 * colour: it is the element for exactly this, and it survives a forced-colours
 * mode where a background of ours would be thrown away. It is not *announced* —
 * no screen reader in common use says anything about a bare `mark` — so nothing
 * here depends on the user hearing it: the excerpt reads the same without the
 * marks, and what the pane says about the search it says in words.
 */
const Excerpt = ({ hit }: { hit: NoteHit }) => (
	<span className="note-excerpt">
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
	queryRef,
}: NoteListProps) => {
	const searching = query.trim() !== '';
	const placeholder = placeholderFor({ notes, folderPath, storeLoaded, query, results });
	const heading = folderPath === undefined ? 'Notes' : folderLabel(folderPath);

	return (
		// Named for what it is listing: a screen reader announcing "Notes" over
		// a list of search results describes the pane the user left.
		<section
			// `searching` is on the element as well as in the label because the
			// narrow layout gives an open search more of the screen than a list
			// read beside a note needs (see `.note-list.searching`).
			className={searching ? 'note-list searching' : 'note-list'}
			aria-label={searching ? 'Search results' : 'Notes'}
		>
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

			{/* The landmark is what lets a screen-reader user jump to the field
			    rather than walk the pane to find it. */}
			<div role="search">
				<input
					ref={queryRef}
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
						// Escape puts the user back in the notebook they were in,
						// which is where they were before they typed. Without it the
						// only way out is to delete what they wrote, one character at
						// a time.
						if (event.key === 'Escape') onQuery('');
					}}
				/>
			</div>

			{/* A search's answer is spoken when it changes: it arrives under a
			    field the user is still typing into, and "nothing matches" is the
			    thing a screen-reader user most needs told. While a search is open
			    the region is always here, empty when there is nothing to say —
			    VoiceOver often stays silent about one that appears with its words
			    already in it. The notebook's own empty states get no region: they
			    follow a deliberate move to another notebook, which is announced
			    already, and one here would read the pane out on every click. */}
			{searching ? (
				<p className="muted placeholder" role="status">
					{placeholder ?? ''}
				</p>
			) : (
				placeholder !== undefined && <p className="muted placeholder">{placeholder}</p>
			)}

			{searching && results !== undefined && results.length > 0 && (
				<ul>
					{results.slice(0, SEARCH_LIMIT).map((hit) => (
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
							detail={<Preview note={note} />}
						/>
					))}
				</ul>
			)}
		</section>
	);
};
