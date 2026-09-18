import { useCallback, useEffect, useMemo, useState } from 'react';

import { chordLabel } from '../commands/chord.js';
import { useCommands, useSuspendShortcuts } from '../commands/context.js';
import { type Command } from '../commands/registry.js';

/**
 * One list of everything the app can be asked to do, opened with a chord and
 * driven from the keyboard.
 *
 * It exists because a shortcut nobody can see is a shortcut nobody has: the
 * palette is where the chords are *discovered*, which is why each row prints
 * its own rather than leaving the user to find it in a manual that does not
 * exist. Both come from the same registration, so the two cannot drift.
 */

export interface CommandPaletteProps {
	onClose: () => void;
}

/**
 * Every typed word has to appear somewhere in the row, in any order: "note new"
 * finds "New note". Not a fuzzy match — a palette of this size is read rather
 * than searched, and fuzz here mostly reorders things the user can already see.
 */
const matching = (commands: readonly Command[], query: string): readonly Command[] => {
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word !== '');
	const found =
		words.length === 0
			? commands
			: commands.filter((command) => {
					const haystack = `${command.label} ${command.group}`.toLowerCase();
					return words.every((word) => haystack.includes(word));
				});
	// Sorted, not in the order things happened to register. Registration order is
	// mount order, which changes as the user moves around the app — and a list
	// whose rows move is a list nobody can learn to reach without reading.
	return [...found].sort(
		(one, two) => one.group.localeCompare(two.group) || one.label.localeCompare(two.label)
	);
};

/**
 * The row the cursor starts on: the first that can actually run.
 *
 * Starting at zero put the highlight on a disabled row whenever one sorted
 * first, so opening the palette and pressing Enter did nothing at all — the
 * commands that cannot run are kept visible on purpose, which makes this the
 * normal case rather than an edge one.
 */
const firstUsable = (commands: readonly Command[]): number => {
	const at = commands.findIndex((command) => command.enabled);
	return at === -1 ? 0 : at;
};

/**
 * Mounted only while it is open, which is what empties the field: a palette
 * that remembers last time's query shows a filtered list to somebody who has
 * just asked to see everything.
 */
export const CommandPalette = ({ onClose }: CommandPaletteProps) => {
	const commands = useCommands();
	const [query, setQuery] = useState('');
	// `null` until the user moves: the resting place depends on the list, which
	// is not known until it has been filtered.
	const [at, setAt] = useState<number | null>(null);
	// Every chord is held while this is up. Otherwise `Mod+E` pressed over an
	// open palette flips the note underneath between editors, and the Enter that
	// follows runs a second command on top of it.
	useSuspendShortcuts();
	const takeFocus = useCallback((field: HTMLInputElement | null) => {
		field?.focus();
	}, []);

	// Where focus was when this opened, captured on the first render — before
	// `takeFocus` has taken it. Removing the focused element does *not* put focus
	// back where it came from: the browser drops it on `document.body`, which is
	// nowhere, and a keyboard user who opens the palette and presses Escape has
	// lost their place in the app.
	const [opener] = useState(() => document.activeElement);
	// Unless a command took focus somewhere deliberately — `app.search` puts the
	// cursor in the search field — in which case putting it back undoes the only
	// thing the command does.
	//
	// The question is where focus actually *is* when this closes, not whether a
	// command ran. Asking the second gave the right answer for `app.search` and
	// the wrong one for every command that does not touch focus, which is most of
	// them: running "Edit as markdown" from the palette dropped the user on
	// `document.body` exactly as Escape used to.
	//
	// Body is the whole test, and it is not an approximation: when the focused
	// element is removed, HTML's focus fixup rule puts focus on the body, so
	// landing there means nobody claimed it. Anywhere else is somewhere a command
	// deliberately put it. (`null` alongside it is belt-and-braces —
	// `document.activeElement` is typed nullable and there is no document here
	// without a body.)
	//
	// That this is a *passive* effect is load-bearing and invisible: React runs a
	// deleted component's layout cleanups before it removes that component's DOM,
	// so as a `useLayoutEffect` this would see its own field still focused,
	// decline every time, and silently stop restoring anything.
	useEffect(
		() => () => {
			const now = document.activeElement;
			if (now !== null && now !== document.body) return;
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		},
		[opener]
	);

	const shown = useMemo(() => matching(commands, query), [commands, query]);
	// The highlight is an index, so it has to be pulled back when the list under
	// it shrinks. Not for typing — `onChange` resets it, and the arrows are taken
	// modulo the current length — but for the registry changing underneath: a
	// screen unmounting while the palette is open takes its commands with it, and
	// an index left past the end is an Enter that runs nothing at all.
	const cursor = shown.length === 0 ? 0 : Math.min(at ?? firstUsable(shown), shown.length - 1);
	const active = shown[cursor];

	// The list scrolls, and the highlight is an `aria-activedescendant` rather
	// than focus — so nothing moves it into view on its own, and arrowing past
	// the fold leaves the user driving a selection they cannot see.
	useEffect(() => {
		if (active === undefined) return;
		document.getElementById(`palette-${active.id}`)?.scrollIntoView({ block: 'nearest' });
	}, [active]);

	const choose = (command: Command) => {
		if (!command.enabled) return;
		// Both are synchronous and in one handler, so the unmount follows either
		// way and the order does not decide who ends up with focus — that is
		// settled above, by where focus actually is once this has gone. Closing
		// first is simply the truthful order: the palette is finished.
		onClose();
		command.run();
	};

	return (
		// The backdrop closes on a click, which is what a click outside a dialog
		// means. `onMouseDown` rather than `onClick`: a drag that starts on a row
		// and ends outside it is still a click on the backdrop.
		<div
			className="palette-backdrop"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="palette" role="dialog" aria-modal="true" aria-label="Commands">
				{/* The keys are handled on the field rather than on the dialog
				    because the field is where focus is from the moment this opens,
				    and it is the element a keyboard user is actually addressing. */}
				<input
					// The palette exists to be typed into and is opened by an
					// explicit request, so focus goes here on mount. A ref with a
					// stable identity, so React attaches it once — an inline one is
					// re-attached on every render and would drag focus back out of
					// wherever the user had just put it.
					ref={takeFocus}
					type="text"
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							onClose();
							return;
						}
						// The field is the only thing in here that takes focus, so
						// refusing Tab is the whole trap: focus cannot leave a
						// dialog that claims the rest of the page is inert, and
						// Escape stays reachable because it is bound here.
						if (event.key === 'Tab') {
							event.preventDefault();
							return;
						}
						if (event.key === 'ArrowDown') {
							event.preventDefault();
							setAt(shown.length === 0 ? 0 : (cursor + 1) % shown.length);
							return;
						}
						if (event.key === 'ArrowUp') {
							event.preventDefault();
							setAt(
								shown.length === 0 ? 0 : (cursor - 1 + shown.length) % shown.length
							);
							return;
						}
						if (event.key === 'Enter') {
							event.preventDefault();
							if (active !== undefined) choose(active);
						}
					}}
					className="palette-field"
					aria-label="Search commands"
					placeholder="Type a command"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						// Back to the resting place for the *new* list, which is
						// not this list's first row.
						setAt(null);
					}}
					// The list is the thing being driven, so the field says so and
					// says which row is active — without this a screen reader
					// announces nothing as the arrows move.
					role="combobox"
					// Only while there is a list: with nothing matching, the `ul`
					// is not rendered, and pointing at an element that is not there
					// is worse than saying the box is closed.
					aria-expanded={shown.length > 0}
					aria-controls={shown.length > 0 ? 'palette-list' : undefined}
					aria-activedescendant={
						active === undefined ? undefined : `palette-${active.id}`
					}
				/>

				{shown.length === 0 ? (
					<p className="muted placeholder" role="status">
						Nothing matches “{query}”.
					</p>
				) : (
					<ul id="palette-list" role="listbox" aria-label="Commands">
						{shown.map((command, index) => (
							// The row is the option, with nothing focusable inside
							// it: ARIA gives `option` presentational children, so a
							// `button` in here is announced as plain text while
							// still sitting in the tab order — which is exactly how
							// focus used to escape the dialog.
							//
							// `onMouseDown` rather than `onClick`, to match the
							// backdrop: the pointer acts where the press began, and
							// a press that does not move focus leaves the field
							// holding it, so the keyboard still works afterwards.
							<li
								key={command.id}
								id={`palette-${command.id}`}
								role="option"
								aria-selected={index === cursor}
								aria-disabled={command.enabled ? undefined : true}
								className={index === cursor ? 'palette-row active' : 'palette-row'}
								onMouseDown={(event) => {
									event.preventDefault();
									choose(command);
								}}
							>
								<span className="palette-label">{command.label}</span>
								<span className="palette-group">{command.group}</span>
								{command.chord !== undefined && (
									<kbd className="palette-chord">{chordLabel(command.chord)}</kbd>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
};
