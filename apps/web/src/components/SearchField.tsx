import { parentPath } from '@skysa/core';
import {
	type ReactNode,
	type RefObject,
	useDeferredValue,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react';

import { t } from '../i18n/t.js';
import { type NoteRecord, noteRef } from '../store/db.js';
import { useNoteSearch, useRecentNotes } from '../store/hooks.js';
import { type NoteHit, SEARCH_LIMIT } from '../store/search.js';
import { titleShown } from '../store/titles.js';
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
 * Before anything is typed, the list is the notes opened lately on this
 * device, under a heading that says so (`store/recentNotes.ts`): what is
 * looked for is often what was being read a minute ago. The first letter
 * makes it the search.
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
	 * The notes opened lately, newest first, listed while the field is empty.
	 * With none, an empty field lists nothing.
	 */
	recent?: readonly NoteRecord[] | undefined;
	/**
	 * The query `results` answer, where that is not `query`: a step behind it
	 * while the answers to the latest letter are worked out (`NoteSearchField`).
	 * The list goes by this — whether there is one, and what it says about
	 * itself — so it never says that nothing matches, or that it is still
	 * looking, about a letter nobody has asked it about yet.
	 */
	asked?: string;
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
	/** The field took the cursor (true) or lost it (false). */
	onFocusChange?: (focused: boolean) => void;
}

/** What the list says about itself, above the matches or instead of them. */
const statusFor = (query: string, results: readonly NoteHit[] | undefined): string => {
	if (results === undefined) return t('search.searching');
	if (results.length === 0) return t('search.noMatch', { query });
	// The search hands back one more than is shown for exactly this, so a search
	// that matched exactly the limit is not told it was cut short.
	return results.length <= SEARCH_LIMIT ? '' : t('search.limited', { count: SEARCH_LIMIT });
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
 * A note in the list: a match, with its excerpt, or a note opened lately.
 * The row is the option, with nothing focusable in it: ARIA gives `option`
 * presentational children.
 */
const Row = ({
	id,
	note,
	hit,
	active,
	sourceName,
	onChoose,
}: {
	id: string;
	note: NoteRecord;
	hit: NoteHit | undefined;
	active: boolean;
	sourceName: SearchFieldProps['sourceName'];
	onChoose: (note: NoteRecord) => void;
}) => (
	<li
		id={id}
		role="option"
		aria-selected={active}
		className={active ? 'search-result active' : 'search-result'}
		onMouseDown={(event) => {
			event.preventDefault();
			onChoose(note);
		}}
	>
		<span className="note-title">{titleShown(note.title)}</span>
		{/* Which source and which notebook, because the list crosses all of
		    them and two notes can share a title. */}
		<span className="note-meta">
			{[
				sourceName?.(note.connectionId),
				folderLabel(parentPath(note.path)),
				editedAt(note.updatedAt),
			]
				.filter((part) => part !== undefined)
				.join(' · ')}
		</span>
		{hit !== undefined && <Excerpt hit={hit} />}
	</li>
);

/**
 * What the list offers: while there is a search, its matches, and before
 * anything is typed, the notes opened lately.
 */
const offered = (
	query: string,
	asked: string,
	results: readonly NoteHit[] | undefined,
	recent: readonly NoteRecord[] | undefined
) => {
	const typed = query.trim() !== '';
	// Both: the answers are for `asked`, and an empty field is no search
	// whatever was last asked — the list of the letters just deleted is not
	// left under it for a frame, for Enter to open one of.
	const searching = typed && asked.trim() !== '';
	const hits = searching ? (results ?? []).slice(0, SEARCH_LIMIT) : [];
	// Only before anything is typed. A letter the answers have not caught up
	// with yet is a search already, and these are not its answers.
	const recents = typed ? [] : (recent ?? []);
	// The first letter, its answers a draw behind it (`NoteSearchField`): where
	// the notes opened lately were listed, the list stays, empty, until the
	// answers fill it. Taken away and put back, it showed the note between the
	// two for as long as a phone takes to answer, a fifth of a second (#275),
	// and its status region came back with its words already in it.
	const waiting = typed && !searching && (recent?.length ?? 0) > 0;
	return {
		searching,
		waiting,
		hits,
		options: searching ? hits.map((hit) => hit.note) : recents,
	};
};

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
	recent,
	onChoose,
	sourceName,
	fieldRef,
	onDismiss,
	asked = query,
	onFocusChange,
}: SearchFieldProps) => {
	const frame = useRef<HTMLDivElement>(null);
	const ownField = useRef<HTMLInputElement>(null);
	const field = fieldRef ?? ownField;
	const [open, setOpen] = useOpen(frame);
	const [at, setAt] = useState(0);
	const id = useId();

	const { searching, waiting, hits, options } = offered(query, asked, results, recent);
	// A search that matched nothing is still a list, which says so; the notes
	// opened lately, none of them, are none.
	const listed = open && (searching || waiting || options.length > 0);
	const cursor = options.length === 0 ? 0 : Math.min(at, options.length - 1);
	const active = listed ? options[cursor] : undefined;
	const optionId = (note: NoteRecord) => `${id}-${noteRef(note)}`;

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
		// From the top next time, which is what Enter is to open then.
		setAt(0);
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
					aria-label={t('search.field')}
					placeholder={t('search.field')}
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
						// From the top each time the list comes back: the notes
						// opened lately are not the ones they were when the
						// highlight was last moved, and Enter opens what it is on.
						if (!open) setAt(0);
						setOpen(true);
						onFocusChange?.(true);
					}}
					// A press on the field it is already in: after Escape the
					// cursor stays, and the notes opened lately are what a press
					// there is for.
					onClick={() => {
						if (!open) setAt(0);
						setOpen(true);
					}}
					onBlur={(event) => {
						// Not when the window lost the focus and the field kept
						// it — another app, another tab — which coming back gives
						// to the field again, and the search with it.
						if (!document.hasFocus() && document.activeElement === event.currentTarget)
							return;
						onFocusChange?.(false);
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							// Out of the search altogether, which is where the user
							// was before they typed. Without it the only way out is
							// to delete what they wrote, one character at a time.
							onQuery('');
							setOpen(false);
							setAt(0);
							onDismiss?.();
							return;
						}
						if (!listed || options.length === 0) return;
						if (event.key === 'ArrowDown') {
							event.preventDefault();
							setAt((cursor + 1) % options.length);
							return;
						}
						if (event.key === 'ArrowUp') {
							event.preventDefault();
							setAt((cursor - 1 + options.length) % options.length);
							return;
						}
						if (event.key === 'Enter' && active !== undefined) {
							event.preventDefault();
							choose(active);
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
					    words already in it. So it is here under the notes opened
					    lately too, for the first letter's answers to be told. */}
					<p className="muted placeholder" role="status">
						{searching ? statusFor(asked, results) : ''}
					</p>
					{!searching && !waiting && (
						<p className="search-heading" id={`${id}-recent`}>
							{t('search.recent')}
						</p>
					)}
					{options.length > 0 && (
						<ul
							id={`${id}-list`}
							role="listbox"
							aria-label={searching ? t('search.results') : undefined}
							aria-labelledby={searching ? undefined : `${id}-recent`}
						>
							{options.map((note, index) => (
								<Row
									key={noteRef(note)}
									id={optionId(note)}
									note={note}
									// A match's excerpt; a note opened lately has
									// none, since nothing was asked of it.
									hit={hits[index]}
									active={index === cursor}
									sourceName={sourceName}
									onChoose={choose}
								/>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
};

/**
 * The search field with the notes' answers: they are searched for here, so the
 * index is this field's, and goes when it does (`useNoteSearch`). It is begun
 * as the field takes the cursor rather than at the first letter. The notes
 * opened lately are read then too (`useRecentNotes`), less the one on screen,
 * which there is no going back to.
 *
 * The answers follow the field a step behind (`useDeferredValue`): a letter goes
 * into the field at once, and its matches and their excerpts are worked out
 * where the next letter can cut in. Worked out with the letter, they held every
 * key on a phone for a fifth of a second, for matches the next key would
 * replace (#275). Until they are ready the last letter's stay up.
 */
export const NoteSearchField = ({
	showing,
	...props
}: Omit<SearchFieldProps, 'results' | 'recent' | 'asked' | 'onFocusChange'> & {
	/** The note on screen, as a `noteRef`, if one is. */
	showing?: string | undefined;
}) => {
	const [focused, setFocused] = useState(false);
	const asked = useDeferredValue(props.query);
	const results = useNoteSearch(asked, focused);
	const recent = useRecentNotes(focused, showing);
	return (
		<SearchField
			{...props}
			results={results}
			recent={recent}
			asked={asked}
			onFocusChange={setFocused}
		/>
	);
};

/**
 * What is in the search field, held here rather than by the page around it, so
 * a letter typed draws the bar and the field again and not the page: on every
 * keystroke, the sidebar, the list and the note beside them were all drawn
 * again for nothing (#275). Above both bars, the compact and the wide, so a
 * query outlives the window changing from one to the other.
 *
 * Component state and not the URL, unlike the open folder and note: those are
 * where the user *is*, and a reload should land there. A half-typed query is
 * not a place — reopening the app into somebody's last search, with the
 * notebooks hidden behind its results, is not where they left off.
 */
export const SearchQuery = ({
	children,
}: {
	children: (query: string, onQuery: (query: string) => void) => ReactNode;
}) => {
	const [query, setQuery] = useState('');
	return children(query, setQuery);
};
