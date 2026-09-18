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

	it('takes a command away with the component that declared it', () => {
		const run = vi.fn();
		const { rerender } = app(
			<>
				<Shortcuts />
				<Declares id="a" run={run} />
			</>
		);
		rerender(
			<CommandsProvider>
				<Shortcuts />
			</CommandsProvider>
		);

		expect(screen.queryByText('Do the thing')).toBeNull();
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
