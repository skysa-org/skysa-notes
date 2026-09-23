import { useEffect, useRef, useState } from 'react';

import { EMPTY_QUERY, type FindQuery, type FindTarget, type Located } from '../editor/find.js';
import { useFindTarget } from '../editor/findTarget.js';

/**
 * Find and replace, over whichever editor is open.
 *
 * One bar and one query for both editors (docs/ARCHITECTURE.md §7). What differs between
 * rich and raw is only how a match is found and drawn, and that lives behind
 * `FindTarget`; everything the user touches is here, once, so the two modes
 * cannot drift into behaving differently or looking different.
 *
 * The query lives here rather than in an editor because an editor does not
 * survive a mode switch — `NoteView` unmounts one and mounts the other — and
 * what the user typed should.
 */

export interface FindBarProps {
	/**
	 * Changes whenever the user asks for the bar again.
	 *
	 * Re-asking focuses the field and selects what is in it, so a second search
	 * can be typed straight over the first. A token rather than a `key` on the
	 * bar, which would do the focusing by remounting — and would throw the query
	 * away in the process, which is the opposite of what re-asking is for.
	 */
	readonly focusToken: number;
	/** Called when the bar should go away. */
	readonly onClose: () => void;
}

const NOTHING: Located = { total: 0, current: null };

/** "3 of 17", or why there is no number to show. */
const countLabel = (query: FindQuery, located: Located): string => {
	if (query.search === '') return '';
	if (located.total === 0) return 'No results';
	return `${String(located.current ?? 1)} of ${String(located.total)}`;
};

export const FindBar = ({ focusToken, onClose }: FindBarProps) => {
	const target = useFindTarget();
	const [query, setQuery] = useState<FindQuery>(EMPTY_QUERY);
	const [replacing, setReplacing] = useState(false);
	// Only the setter: re-rendering after an action is the whole of what this is
	// for. The count below is read from the editor, which is mutable and tells
	// nobody when it changes, so something has to ask again — and asking after
	// the action means the number describes the document as it is now, rather
	// than what the action predicted before it ran.
	const [, redraw] = useState(0);
	const field = useRef<HTMLInputElement>(null);

	// Only when the editor underneath changes — the bar has just appeared, or a
	// mode switch rebuilt it — and deliberately not on every change of `query`.
	// A query the *user* changed is sent from the handler that changed it, which
	// is an event, and an event is where dispatching into an editor belongs.
	//
	// Dispatching into the rich editor from an effect at all is the awkward case:
	// its React-backed plugin views (the slash menu, the toolbar) call
	// `flushSync` from their `update`, and React refuses that while it is still
	// rendering — four warnings per keystroke, and the menus render a frame late.
	// A microtask puts the transaction after the commit, which is what React's
	// own message asks for.
	//
	// What makes that safe is *not* the destroyed-view guard, which in practice
	// never fires here: it is that `highlight` dispatches a transaction with no
	// steps in it, so arriving late at a view nobody is looking at any more
	// changes nothing and cannot reach `dirty.ts`, both of whose rules begin at
	// `docChanged`. Anything that changes the document — `replace`, or a `next`
	// that did — must not be deferred this way: a document-changing transaction
	// into a view that is about to be destroyed is a silently lost edit, and no
	// guard here would catch it.
	//
	// `query` is read, not depended on: the effect below wants whatever is typed
	// at the moment the editor appears. Declared first, so it is already in step
	// on a render that changes both.
	const typed = useRef(query);
	useEffect(() => {
		typed.current = query;
	}, [query]);

	useEffect(() => {
		if (target === null) return;
		queueMicrotask(() => {
			target.highlight(typed.current);
		});
		return () => {
			target.clear();
		};
	}, [target]);

	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, [focusToken]);

	const located = target?.count(query) ?? NOTHING;

	// Closing hands the note back the caret, sitting on the match the user
	// stopped at — which is what they were looking for it for.
	const close = () => {
		target?.focus();
		onClose();
	};

	// Every control goes through here, so there is one place that says what
	// changing the query means: the bar remembers it and the editor redraws.
	const change = (next: FindQuery) => {
		setQuery(next);
		target?.highlight(next);
	};

	const act = (run: (editor: FindTarget) => void) => {
		if (target === null) return;
		run(target);
		redraw((times) => times + 1);
	};

	return (
		<div className="find-bar" role="search" aria-label="Find in note">
			<div className="find-row">
				<input
					ref={field}
					className="find-input"
					aria-label="Find"
					placeholder="Find"
					value={query.search}
					onChange={(event) => {
						change({ ...query, search: event.target.value });
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') close();
						if (event.key !== 'Enter') return;
						// Enter is next, Shift+Enter is previous: the bar is a
						// text field, so the keys that work in it are the ones
						// the hands are already on.
						event.preventDefault();
						act((editor) => editor.next(query, event.shiftKey));
					}}
				/>
				<span className="find-count" role="status">
					{countLabel(query, located)}
				</span>
				<button
					type="button"
					aria-label="Previous match"
					onClick={() => {
						act((editor) => editor.next(query, true));
					}}
				>
					↑
				</button>
				<button
					type="button"
					aria-label="Next match"
					onClick={() => {
						act((editor) => editor.next(query));
					}}
				>
					↓
				</button>
				<button
					type="button"
					aria-pressed={query.caseSensitive}
					aria-label="Match case"
					title="Match case"
					onClick={() => {
						change({ ...query, caseSensitive: !query.caseSensitive });
					}}
				>
					Aa
				</button>
				<button
					type="button"
					aria-pressed={query.wholeWord}
					aria-label="Whole word"
					title="Whole word"
					onClick={() => {
						change({ ...query, wholeWord: !query.wholeWord });
					}}
				>
					ab
				</button>
				<button
					type="button"
					aria-pressed={query.regexp}
					aria-label="Regular expression"
					title="Regular expression"
					onClick={() => {
						change({ ...query, regexp: !query.regexp });
					}}
				>
					.*
				</button>
				<button
					type="button"
					aria-expanded={replacing}
					aria-label={replacing ? 'Hide replace' : 'Show replace'}
					title="Replace"
					onClick={() => {
						setReplacing(!replacing);
					}}
				>
					⇄
				</button>
				<button type="button" aria-label="Close find" onClick={close}>
					✕
				</button>
			</div>
			{replacing && (
				<div className="find-row">
					<input
						className="find-input"
						aria-label="Replace with"
						placeholder="Replace with"
						value={query.replace}
						onChange={(event) => {
							change({ ...query, replace: event.target.value });
						}}
						onKeyDown={(event) => {
							if (event.key === 'Escape') close();
						}}
					/>
					<button
						type="button"
						onClick={() => {
							act((editor) => editor.replace(query));
						}}
					>
						Replace
					</button>
					<button
						type="button"
						onClick={() => {
							act((editor) => editor.replaceAll(query));
						}}
					>
						All
					</button>
				</div>
			)}
		</div>
	);
};
