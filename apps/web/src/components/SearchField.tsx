import { parentPath } from '@skysa/core';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';

import { type NoteRecord, noteRef } from '../store/db.js';
import { type NoteHit, SEARCH_LIMIT } from '../store/search.js';
import { folderLabel } from '../store/tree.js';
import { editedAt } from './editedAt.js';

/**
 * The app's search field, and its answers in a list that drops from it.
 *
 * It sits in the bar at the top of the app, because what it asks is not about
 * the source or the notebook showing: it searches every source on the device
 * and every notebook in them. The answers hang from the field rather than
 * taking the notes pane over — on a wide screen a card under the field, in a
 * compact one everything under the bar — so the notebook the user was reading
 * is still there behind them, and choosing an answer is the end of the search:
 * the note opens, the field empties, and the list goes.
 *
 * A combobox driving a listbox, as the command palette is: the cursor stays in
 * the field, the arrows move the highlight (`aria-activedescendant`), Enter
 * opens the highlighted note, and Escape empties the field. A press on a row
 * is `onMouseDown`, so the field keeps the focus and the keyboard still works
 * after it.
 */
export interface SearchFieldProps {
	/** What is in the field. Empty means no search is open. */
	query: string;
	onQuery: (query: string) => void;
	/** Matches for `query`, or undefined while the first one is being answered. */
	results?: readonly NoteHit[] | undefined;
	/**
	 * A match was chosen. The note, not its id: a match can be in any source,
	 * and an id names a note only inside its own. The field has emptied itself
	 * by the time this is called.
	 */
	onChoose?: (note: NoteRecord) => void;
	/**
	 * What to call the source a match is in, or `undefined` to leave it unsaid
	 * — which is right while there is only one source, when it would be noise.
	 */
	sourceName?: (connectionId: string) => string | undefined;
	/** So a command can put the cursor in the field without hunting the DOM. */
	fieldRef?: RefObject<HTMLInputElement | null>;
	/**
	 * After Escape has emptied the field, or a match was chosen. The compact bar
	 * puts its dropdowns back then: there the field stands in for them only
	 * while it is in use.
	 */
	onDismiss?: () => void;
}

/** What the list says about itself, above the matches or instead of them. */
const statusFor = (query: string, results: readonly NoteHit[] | undefined): string => {
	if (results === undefined) return 'Searching…';
	if (results.length === 0) return `Nothing matches “${query}”.`;
	// The search hands back one more than is shown for exactly this, so a search
	// that matched exactly the limit is not told it was cut short.
	return results.length <= SEARCH_LIMIT
		? ''
		: `Showing the first ${String(SEARCH_LIMIT)}. Add a word to narrow the search.`;
};

/**
 * The matched words are marked in place. `<mark>` rather than a span of our own
 * colour: it is the element for exactly this, and it survives a forced-colours
 * mode where a background of ours would be thrown away. It is not *announced* —
 * no screen reader in common use says anything about a bare `mark` — so nothing
 * here depends on the user hearing it: the excerpt reads the same without the
 * marks, and what the list says about the search it says in words.
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

/**
 * Whether the list is showing, and the ways it goes: Escape, a press anywhere
 * outside the field and the list, and a choice. Typing or coming back to the
 * field with a query in it shows it again.
 */
const useOpen = (frame: RefObject<HTMLDivElement | null>) => {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return undefined;
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && frame.current?.contains(target) === true) return;
			setOpen(false);
		};
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [open, frame]);
	return [open, setOpen] as const;
};

export const SearchField = ({
	query,
	onQuery,
	results,
	onChoose,
	sourceName,
	fieldRef,
	onDismiss,
}: SearchFieldProps) => {
	const frame = useRef<HTMLDivElement>(null);
	const ownField = useRef<HTMLInputElement>(null);
	const field = fieldRef ?? ownField;
	const [open, setOpen] = useOpen(frame);
	const [at, setAt] = useState(0);
	const id = useId();

	const searching = query.trim() !== '';
	const shown = searching ? (results ?? []).slice(0, SEARCH_LIMIT) : [];
	const listed = open && searching;
	const cursor = shown.length === 0 ? 0 : Math.min(at, shown.length - 1);
	const active = listed ? shown[cursor] : undefined;
	const optionId = (hit: NoteHit) => `${id}-${noteRef(hit.note)}`;

	// The highlight is an `aria-activedescendant` rather than focus, so nothing
	// moves it into view on its own.
	useEffect(() => {
		if (active === undefined) return;
		document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `optionId` is `id` and `active`
	}, [active, id]);

	const choose = (note: NoteRecord) => {
		onQuery('');
		setOpen(false);
		// Put away, so a phone's keyboard goes with the list and the note is
		// what is being read.
		field.current?.blur();
		onChoose?.(note);
		onDismiss?.();
	};

	return (
		<div className="search-box" ref={frame}>
			{/* The landmark is what lets a screen-reader user jump to the field
			    rather than walk the bar to find it. */}
			<div role="search">
				<input
					ref={field}
					// `search` rather than `text`: it is what the field is, and the
					// browser offers its own way to empty one.
					type="search"
					className="note-search"
					aria-label="Search notes"
					placeholder="Search notes"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={listed}
					aria-controls={listed ? `${id}-list` : undefined}
					aria-activedescendant={active === undefined ? undefined : optionId(active)}
					value={query}
					onChange={(event) => {
						onQuery(event.target.value);
						setAt(0);
						setOpen(true);
					}}
					onFocus={() => {
						setOpen(true);
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							// Out of the search altogether, which is where the user
							// was before they typed. Without it the only way out is
							// to delete what they wrote, one character at a time.
							onQuery('');
							setOpen(false);
							onDismiss?.();
							return;
						}
						if (!listed || shown.length === 0) return;
						if (event.key === 'ArrowDown') {
							event.preventDefault();
							setAt((cursor + 1) % shown.length);
							return;
						}
						if (event.key === 'ArrowUp') {
							event.preventDefault();
							setAt((cursor - 1 + shown.length) % shown.length);
							return;
						}
						if (event.key === 'Enter' && active !== undefined) {
							event.preventDefault();
							choose(active.note);
						}
					}}
				/>
			</div>

			{listed && (
				<div className="search-results">
					{/* Spoken when it changes: it arrives under a field the user is
					    still typing into, and "nothing matches" is the thing a
					    screen-reader user most needs told. Always here while the
					    list is, empty when there is nothing to say — VoiceOver
					    often stays silent about a region that appears with its
					    words already in it. */}
					<p className="muted placeholder" role="status">
						{statusFor(query, results)}
					</p>
					{shown.length > 0 && (
						<ul id={`${id}-list`} role="listbox" aria-label="Search results">
							{shown.map((hit, index) => (
								// The row is the option, with nothing focusable in it:
								// ARIA gives `option` presentational children.
								<li
									key={noteRef(hit.note)}
									id={optionId(hit)}
									role="option"
									aria-selected={index === cursor}
									className={
										index === cursor ? 'search-result active' : 'search-result'
									}
									onMouseDown={(event) => {
										event.preventDefault();
										choose(hit.note);
									}}
								>
									<span className="note-title">{hit.note.title}</span>
									{/* Which source and which notebook, because a
									    search crosses all of them and two notes can
									    share a title. */}
									<span className="note-meta">
										{[
											sourceName?.(hit.note.connectionId),
											folderLabel(parentPath(hit.note.path)),
											editedAt(hit.note.updatedAt),
										]
											.filter((part) => part !== undefined)
											.join(' · ')}
									</span>
									<Excerpt hit={hit} />
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
};
