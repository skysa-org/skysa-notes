import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseChord } from '../src/commands/chord.js';
import {
	CommandsProvider,
	useCommand,
	useCommands,
	useShortcuts,
} from '../src/commands/context.js';
import { createCommandRegistry, reachable } from '../src/commands/registry.js';
import { CommandPalette } from '../src/components/CommandPalette.js';

/**
 * The registry exists so that one list serves both the keyboard and the
 * palette. These are about that being true: a chord that runs a command, a
 * palette that shows the same command with the same chord printed on it, and
 * the ways either could quietly stop being the case.
 */

afterEach(cleanup);

const MOD_K = parseChord('Mod+K');

/** A component that declares one command for as long as it is mounted. */
const Declares = ({
	id,
	label = 'Do the thing',
	group = 'Test',
	chord = MOD_K,
	enabled = true,
	run,
}: {
	id: string;
	label?: string;
	group?: string;
	/** `null` for a command with no chord — `undefined` would take the default. */
	chord?: ReturnType<typeof parseChord> | null;
	enabled?: boolean;
	run: () => void;
}) => {
	useCommand({ id, label, group, chord: chord ?? undefined, enabled, run });
	return null;
};

const Shortcuts = () => {
	useShortcuts();
	return null;
};

const app = (children: ReactNode) => render(<CommandsProvider>{children}</CommandsProvider>);

describe('the registry', () => {
	it('keeps one entry per id, so a re-registration replaces rather than doubles', () => {
		const registry = createCommandRegistry();
		const command = { id: 'a', label: 'A', group: 'G', enabled: true, run: () => undefined };
		registry.register(command);
		registry.register({ ...command, label: 'A again' });

		expect(registry.list()).toHaveLength(1);
		expect(registry.list()[0]?.label).toBe('A again');
	});

	it('hands back the same list until something changes', () => {
		// `useSyncExternalStore` compares snapshots by identity: a `list` that
		// built a new array each call would re-render for ever.
		const registry = createCommandRegistry();
		registry.register({ id: 'a', label: 'A', group: 'G', enabled: true, run: () => undefined });

		expect(registry.list()).toBe(registry.list());
	});

	it('does not let a stale cleanup remove a live registration', () => {
		// React's strict mode mounts twice: the second registration lands before
		// the first one's cleanup runs, and an unconditional delete would take
		// the live command out.
		const registry = createCommandRegistry();
		const first = { id: 'a', label: 'first', group: 'G', enabled: true, run: () => undefined };
		const undoFirst = registry.register(first);
		registry.register({ ...first, label: 'second' });
		undoFirst();

		expect(registry.list().map((command) => command.label)).toEqual(['second']);
	});

	it('takes a command away with the component that declared it', async () => {
		// Through the palette, which is the only thing that can tell the
		// difference: `Declares` renders nothing, so asserting on its label
		// without a palette on screen passes whether the command is gone or not.
		const run = vi.fn();
		const { rerender } = app(
			<>
				<Shortcuts />
				<Declares id="a" run={run} />
				<CommandPalette onClose={() => undefined} />
			</>
		);
		expect(screen.getByText('Do the thing')).toBeDefined();

		rerender(
			<CommandsProvider>
				<Shortcuts />
				<CommandPalette onClose={() => undefined} />
			</CommandsProvider>
		);

		expect(screen.queryByText('Do the thing')).toBeNull();
		// And the chord it held goes with it.
		await userEvent.keyboard('{Meta>}k{/Meta}');
		expect(run).not.toHaveBeenCalled();
	});
});

describe('a chord', () => {
	it('runs the command it belongs to', async () => {
		const run = vi.fn();
		app(
			<>
				<Shortcuts />
				<Declares id="a" run={run} />
			</>
		);

		await userEvent.keyboard('{Meta>}k{/Meta}');

		expect(run).toHaveBeenCalledTimes(1);
	});

	it('is swallowed rather than passed on when the command cannot run', () => {
		// Falling through to the browser's own Mod+N would open a window, which
		// is a stranger answer to a disabled command than nothing happening.
		const run = vi.fn();
		app(
			<>
				<Shortcuts />
				<Declares id="a" enabled={false} run={run} />
			</>
		);
		const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true });
		act(() => {
			window.dispatchEvent(event);
		});

		expect(run).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(true);
	});

	it('reaches a command with a modifier even from inside a text field', () => {
		const field = document.createElement('input');

		expect(reachable(parseChord('Mod+K'), field)).toBe(true);
	});

	it('leaves a bare key alone while the user is typing', () => {
		// Otherwise every shortcut without a modifier is unreachable from the one
		// place people spend their time.
		const field = document.createElement('textarea');

		expect(reachable(parseChord('/'), field)).toBe(false);
		expect(reachable(parseChord('/'), document.createElement('div'))).toBe(true);
	});
});

describe('the palette', () => {
	const openPalette = (run = vi.fn()) => {
		const result = app(
			<>
				<Declares id="a" label="Do the thing" run={run} />
				<Declares id="b" label="Something else" chord={null} run={vi.fn()} />
				<CommandPalette onClose={() => undefined} />
			</>
		);
		return { ...result, run };
	};

	it('lists what is registered, with the chord the app actually listens for', () => {
		openPalette();

		expect(screen.getByRole('option', { name: /Do the thing/ })).toBeDefined();
		// The label is not typed into the palette: it is printed from the same
		// chord the listener matches, so the two cannot drift apart.
		expect(screen.getByText(/⌘K|Ctrl\+K/)).toBeDefined();
	});

	it('runs the highlighted command on Enter', async () => {
		const { run } = openPalette();
		await userEvent.keyboard('{Enter}');

		expect(run).toHaveBeenCalledTimes(1);
	});

	it('narrows on every typed word, in any order', async () => {
		openPalette();
		await userEvent.keyboard('thing do');

		expect(screen.getByRole('option', { name: /Do the thing/ })).toBeDefined();
		expect(screen.queryByRole('option', { name: /Something else/ })).toBeNull();
	});

	it('says so when nothing matches', async () => {
		openPalette();
		await userEvent.keyboard('kingfisher');

		expect(screen.getByText('Nothing matches “kingfisher”.')).toBeDefined();
	});

	it('runs the right command after the list has been narrowed under the cursor', async () => {
		// The highlight is an index. Typing until the list is shorter than it
		// leaves it past the end, and Enter then runs nothing at all.
		const second = vi.fn();
		app(
			<>
				<Declares id="a" label="Alpha" run={vi.fn()} />
				<Declares id="b" label="Bravo" chord={null} run={second} />
				<CommandPalette onClose={() => undefined} />
			</>
		);
		await userEvent.keyboard('{ArrowDown}');
		await userEvent.keyboard('bravo');
		await userEvent.keyboard('{Enter}');

		expect(second).toHaveBeenCalledTimes(1);
	});

	it('shows a command that cannot run rather than hiding it', async () => {
		// A palette whose contents change as the user moves around cannot be
		// learned, and "why is it not there" is a worse question than "why is it
		// greyed out".
		const run = vi.fn();
		app(
			<>
				<Declares id="a" label="Do the thing" enabled={false} run={run} />
				<CommandPalette onClose={() => undefined} />
			</>
		);

		const row = screen.getByRole('option', { name: /Do the thing/ });
		expect(row.getAttribute('aria-disabled')).toBe('true');

		await userEvent.keyboard('{Enter}');
		expect(run).not.toHaveBeenCalled();
	});

	it('closes on Escape', async () => {
		const onClose = vi.fn();
		app(
			<>
				<Declares id="a" run={vi.fn()} />
				<CommandPalette onClose={onClose} />
			</>
		);
		await userEvent.keyboard('{Escape}');

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('opens with the cursor already in its field', () => {
		openPalette();

		expect(document.activeElement).toBe(screen.getByRole('combobox'));
	});
});

describe('useCommands outside a provider', () => {
	it('says so rather than silently registering nothing', () => {
		const Bare = () => {
			useCommands();
			return null;
		};
		// The default error boundary logs; this is the expected failure.
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		expect(() => render(<Bare />)).toThrow(/CommandsProvider/);

		quiet.mockRestore();
	});
});

describe('where the cursor rests', () => {
	it('starts on the first command that can actually run', async () => {
		// The commands that cannot run are kept visible on purpose, so one of them
		// sorting first is the normal case — and starting at row zero meant
		// opening the palette and pressing Enter did nothing at all.
		const usable = vi.fn();
		app(
			<>
				<Declares id="a" label="Alpha" group="A" enabled={false} run={vi.fn()} />
				<Declares id="b" label="Bravo" group="A" chord={null} run={usable} />
				<CommandPalette onClose={() => undefined} />
			</>
		);

		await userEvent.keyboard('{Enter}');

		expect(usable).toHaveBeenCalledTimes(1);
	});

	it('lists commands in a fixed order rather than the order they registered', () => {
		// Registration order is mount order, which changes as the user moves
		// around: a list whose rows move is one nobody can learn to reach.
		app(
			<>
				<Declares id="c" label="Zulu" group="Note" chord={null} run={vi.fn()} />
				<Declares id="a" label="Alpha" group="Note" chord={null} run={vi.fn()} />
				<Declares id="b" label="Bravo" group="App" chord={null} run={vi.fn()} />
				<CommandPalette onClose={() => undefined} />
			</>
		);

		expect(
			screen.getAllByRole('option').map((row) => row.textContent.replace(/(App|Note)$/, ''))
		).toEqual(['Bravo', 'Alpha', 'Zulu']);
	});
});

/**
 * When a chord may *not* fire. Every one of these was found by a reviewer
 * mutating the source and watching the suite stay green: the guards existed and
 * nothing held them in place.
 */
describe('a keystroke the app must not take', () => {
	/** A keydown as the browser delivers it, from a chosen element. */
	const press = (key: string, from: Element, held: Partial<KeyboardEventInit> = {}) => {
		const event = new KeyboardEvent('keydown', {
			key,
			bubbles: true,
			cancelable: true,
			...held,
		});
		act(() => {
			from.dispatchEvent(event);
		});
		return event;
	};

	const listening = (run: () => void, chord: ReturnType<typeof parseChord>) => {
		app(
			<>
				<Shortcuts />
				<Declares id="a" chord={chord} run={run} />
			</>
		);
	};

	it('leaves a bare key to the field the user is typing into', () => {
		// The guard is `reachable`, and until this test it could be deleted
		// outright with the whole suite still green.
		const run = vi.fn();
		listening(run, parseChord('n'));
		const field = document.createElement('input');
		document.body.append(field);

		press('n', field);
		expect(run).not.toHaveBeenCalled();

		press('n', document.body);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('leaves a bare key to an editor, which is not an input at all', () => {
		// Both of this app's editors are contentEditable hosts: Milkdown over
		// ProseMirror and CodeMirror 6. Neither is an `input`, a `textarea` or a
		// `select`, so the tag-name cases say nothing about the one place the
		// user actually writes.
		const run = vi.fn();
		listening(run, parseChord('n'));
		const editor = document.createElement('div');
		editor.contentEditable = 'true';
		// jsdom computes `isContentEditable` from nothing, so it is set directly.
		Object.defineProperty(editor, 'isContentEditable', { value: true });
		document.body.append(editor);

		press('n', editor);

		expect(run).not.toHaveBeenCalled();
	});

	it('leaves alone a keystroke something nearer has already handled', () => {
		// CodeMirror's default keymap binds Ctrl+K to "kill to end of line" on a
		// Mac. A handled binding calls `preventDefault` and lets the event bubble,
		// so without this the raw editor deletes the rest of the line *and* the
		// app opens the palette over it.
		const run = vi.fn();
		listening(run, parseChord('Mod+K'));
		const editor = document.createElement('div');
		document.body.append(editor);
		editor.addEventListener('keydown', (event) => {
			event.preventDefault();
		});

		press('k', editor, { ctrlKey: true });

		expect(run).not.toHaveBeenCalled();
	});

	it('fires once for a key held down, not once per repeat', () => {
		const run = vi.fn();
		listening(run, parseChord('Mod+E'));

		press('e', document.body, { metaKey: true });
		press('e', document.body, { metaKey: true, repeat: true });
		press('e', document.body, { metaKey: true, repeat: true });

		expect(run).toHaveBeenCalledTimes(1);
	});

	it('holds every chord while the palette is open', () => {
		// Otherwise Mod+E pressed over the palette flips the note underneath
		// between editors — flushing a pending edit into an editor the user
		// cannot see — and the Enter that follows runs a second command on top.
		const behind = vi.fn();
		app(
			<>
				<Shortcuts />
				<Declares id="a" chord={parseChord('Mod+E')} run={behind} />
				<CommandPalette onClose={() => undefined} />
			</>
		);

		press('e', screen.getByRole('combobox'), { metaKey: true });

		expect(behind).not.toHaveBeenCalled();
	});

	it('takes them back when the palette closes', () => {
		const behind = vi.fn();
		const { rerender } = app(
			<>
				<Shortcuts />
				<Declares id="a" chord={parseChord('Mod+E')} run={behind} />
				<CommandPalette onClose={() => undefined} />
			</>
		);
		rerender(
			<CommandsProvider>
				<Shortcuts />
				<Declares id="a" chord={parseChord('Mod+E')} run={behind} />
			</CommandsProvider>
		);

		press('e', document.body, { metaKey: true });

		expect(behind).toHaveBeenCalledTimes(1);
	});
});

describe('the palette as a dialog', () => {
	const press = (key: string, from: Element) => {
		const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
		act(() => {
			from.dispatchEvent(event);
		});
		return event;
	};

	const openOver = (
		opener: HTMLElement,
		onClose: () => void = vi.fn(),
		run: () => void = vi.fn()
	) => {
		const result = app(
			<>
				<Declares id="a" label="Do the thing" run={run} />
				<CommandPalette onClose={onClose} />
			</>
		);
		return { ...result, onClose, run, opener };
	};

	/** Something with focus before the palette opens, as a button in the app has. */
	const focused = () => {
		const button = document.createElement('button');
		document.body.append(button);
		button.focus();
		return button;
	};

	it('gives focus back to whatever had it, when it closes having done nothing', () => {
		// Removing the focused element does not return focus where it came from:
		// the browser drops it on `document.body`, and a keyboard user who opens
		// the palette and changes their mind has lost their place in the app.
		const opener = focused();
		const { unmount } = openOver(opener);
		expect(document.activeElement).toBe(screen.getByRole('combobox'));

		unmount();

		expect(document.activeElement).toBe(opener);
	});

	it('leaves focus where a command put it', async () => {
		// `app.search` exists to put the cursor in the search field. Taking focus
		// back afterwards would undo the only thing the command does.
		const opener = focused();
		const elsewhere = document.createElement('input');
		document.body.append(elsewhere);
		const { unmount } = openOver(opener, vi.fn(), () => {
			elsewhere.focus();
		});

		await userEvent.keyboard('{Enter}');
		unmount();

		expect(document.activeElement).toBe(elsewhere);
	});

	it('keeps Tab inside itself', () => {
		// `aria-modal` says the rest of the page is inert. Focus has to agree:
		// the field is the only thing in here that takes it, so Tab is refused
		// rather than allowed to walk out into the page behind.
		openOver(focused());
		const field = screen.getByRole('combobox');

		const event = press('Tab', field);

		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(field);
	});

	it('names the row Enter would run, for a reader that cannot see the highlight', async () => {
		openOver(focused());
		const field = screen.getByRole('combobox');
		const first = screen.getAllByRole('option')[0];

		expect(field.getAttribute('aria-activedescendant')).toBe(first?.id);

		await userEvent.keyboard('kingfisher');
		// Nothing matches, so there is no list to point into and no row to name.
		expect(field.getAttribute('aria-activedescendant')).toBeNull();
		expect(field.getAttribute('aria-controls')).toBeNull();
		expect(field.getAttribute('aria-expanded')).toBe('false');
	});

	it('puts nothing focusable inside a row', () => {
		// ARIA gives `option` presentational children: a button in there is
		// announced as plain text while still sitting in the tab order, which is
		// how focus used to escape the dialog.
		openOver(focused());

		// Within the dialog: the opener this test focuses is a button of its own,
		// and it is outside.
		const dialog = screen.getByRole('dialog');
		const focusable = dialog.querySelectorAll(
			'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
		);

		// Exactly one, and it is the field — which is also what makes refusing
		// Tab a complete trap rather than half of one.
		expect([...focusable]).toEqual([screen.getByRole('combobox')]);
	});
});
