import { useCallback, useMemo, useState } from 'react';

import { chordLabel } from '../commands/chord.js';
import { useCommands } from '../commands/context.js';
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
 * just asked to see everything. Unmounting is also what gives the focus back,
 * since the browser returns it where it was.
 */
export const CommandPalette = ({ onClose }: CommandPaletteProps) => {
	const commands = useCommands();
	const [query, setQuery] = useState('');
	// `null` until the user moves: the resting place depends on the list, which
	// is not known until it has been filtered.
	const [at, setAt] = useState<number | null>(null);
	const takeFocus = useCallback((field: HTMLInputElement | null) => {
		field?.focus();
	}, []);

	const shown = useMemo(() => matching(commands, query), [commands, query]);
	// The highlight is an index, so it has to be pulled back when the list under
	// it shrinks — otherwise Enter on a narrowed list runs nothing at all.
	const cursor = shown.length === 0 ? 0 : Math.min(at ?? firstUsable(shown), shown.length - 1);

	const choose = (command: Command) => {
		if (!command.enabled) return;
		// Closed first: the command may move focus — opening a note, or putting
		// the cursor in the search field — and a dialog closing afterwards would
		// take it straight back.
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
							const command = shown[cursor];
							if (command !== undefined) choose(command);
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
					aria-expanded
					aria-controls="palette-list"
					aria-activedescendant={
						shown[cursor] === undefined ? undefined : `palette-${shown[cursor].id}`
					}
				/>

				{shown.length === 0 ? (
					<p className="muted placeholder" role="status">
						Nothing matches “{query}”.
					</p>
				) : (
					<ul id="palette-list" role="listbox" aria-label="Commands">
						{shown.map((command, index) => (
							<li
								key={command.id}
								id={`palette-${command.id}`}
								role="option"
								aria-selected={index === cursor}
								aria-disabled={command.enabled ? undefined : true}
								className={index === cursor ? 'palette-row active' : 'palette-row'}
							>
								{/* A button, so a pointer can use it and so the
								    disabled ones refuse a click for the same reason
								    they refuse Enter. */}
								<button
									type="button"
									disabled={!command.enabled}
									onMouseEnter={() => {
										setAt(index);
									}}
									onClick={() => {
										choose(command);
									}}
								>
									<span className="palette-label">{command.label}</span>
									<span className="palette-group">{command.group}</span>
									{command.chord !== undefined && (
										<kbd className="palette-chord">
											{chordLabel(command.chord)}
										</kbd>
									)}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
};
