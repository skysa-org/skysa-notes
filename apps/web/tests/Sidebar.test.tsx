import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar.js';
import { buildFolderTree } from '../src/store/tree.js';

/**
 * The sidebar lists notebooks and nothing else — except when the root itself
 * holds notes, which a remote folder can arrive already doing. Then one row
 * appears for them, and only then: every note the user has must be reachable,
 * and no row may claim to hold notes that are not there.
 */

afterEach(cleanup);

const tree = buildFolderTree({ paths: ['personal', 'work', 'work/meetings'] });

const renderSidebar = (props: Partial<Parameters<typeof Sidebar>[0]> = {}) =>
	render(
		<Sidebar
			tree={tree}
			selectedFolder="personal"
			onSelectFolder={() => undefined}
			onCreateFolder={() => undefined}
			looseNoteCount={0}
			{...props}
		/>
	);

describe('Sidebar', () => {
	it('lists every notebook', () => {
		renderSidebar();

		expect(screen.getByRole('button', { name: /personal/ })).toBeDefined();
		expect(screen.getByRole('button', { name: /work$/ })).toBeDefined();
		expect(screen.getByRole('button', { name: /meetings/ })).toBeDefined();
	});

	it('has no "All notes" row', () => {
		renderSidebar();
		expect(screen.queryByText('All notes')).toBeNull();
	});

	it('marks the open notebook as current', () => {
		renderSidebar({ selectedFolder: 'work' });

		expect(screen.getByRole('button', { name: /work$/ }).getAttribute('aria-current')).toBe(
			'true'
		);
		expect(
			screen.getByRole('button', { name: /personal/ }).getAttribute('aria-current')
		).toBeNull();
	});

	it('says so when there are no notebooks yet', () => {
		renderSidebar({ tree: [], selectedFolder: undefined });
		expect(screen.getByText(/No notebooks yet/)).toBeDefined();
	});

	it('waits rather than claiming there are none while loading', () => {
		renderSidebar({ tree: undefined, selectedFolder: undefined });

		expect(screen.getByText('Loading…')).toBeDefined();
		expect(screen.queryByText(/No notebooks yet/)).toBeNull();
	});

	it('creates a notebook inside the open one', async () => {
		const onCreateFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Standups{Enter}');

		expect(onCreateFolder).toHaveBeenCalledWith('work', 'Standups');
	});

	it('creates the first notebook at the root', async () => {
		const onCreateFolder = vi.fn();
		renderSidebar({ tree: [], selectedFolder: undefined, onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Personal{Enter}');

		expect(onCreateFolder).toHaveBeenCalledWith(undefined, 'Personal');
	});
});

/**
 * Loose notes are `.md` files sitting at the root of the remote app folder.
 * The app never creates one, and it does not move the user's files to tidy them
 * away — so it has to be able to show them (docs/PLAN.md §12.6).
 */
describe('the Loose notes row', () => {
	const looseRow = () => screen.queryByRole('button', { name: /Loose notes/ });

	it('is absent when the root holds no notes', () => {
		renderSidebar({ looseNoteCount: 0 });
		expect(looseRow()).toBeNull();
	});

	it('is absent while the count is still loading', () => {
		// Flashing a row in and then out again is worse than showing it late.
		renderSidebar({ looseNoteCount: undefined });
		expect(looseRow()).toBeNull();
	});

	it('says it is still loading rather than showing an empty sidebar', () => {
		// No notebooks and no count yet: there is genuinely nothing to list, but
		// a blank pane beside a note list that says "Loading…" reads as the two
		// halves of the app disagreeing about whether anything is coming.
		renderSidebar({ tree: [], selectedFolder: undefined, looseNoteCount: undefined });

		expect(screen.getByText('Loading…')).toBeDefined();
		expect(screen.queryByText(/No notebooks yet/)).toBeNull();
	});

	it('does not interrupt the notebooks to say the count is still loading', () => {
		// The notebooks are already listed; a "Loading…" row among them would be
		// about something the user cannot see.
		renderSidebar({ looseNoteCount: undefined });
		expect(screen.queryByText('Loading…')).toBeNull();
	});

	it('appears when the root holds notes, and says how many', () => {
		renderSidebar({ looseNoteCount: 3 });

		expect(looseRow()).not.toBeNull();
		expect(screen.getByRole('button', { name: /Loose notes/ }).textContent).toContain('3');
	});

	it('is not the "All notes" row we removed', () => {
		renderSidebar({ looseNoteCount: 3 });
		expect(screen.queryByText('All notes')).toBeNull();
	});

	it('comes after the notebooks', () => {
		// It names an exception to the structure, so it does not head the list.
		renderSidebar({ looseNoteCount: 1 });

		const labels = screen
			.getAllByRole('button')
			.map((button) => button.textContent)
			.filter((text) => text !== '+');
		expect(labels[labels.length - 1]).toContain('Loose notes');
	});

	it('opens the root when clicked', async () => {
		const onSelectFolder = vi.fn();
		renderSidebar({ looseNoteCount: 2, onSelectFolder });

		await userEvent.click(screen.getByRole('button', { name: /Loose notes/ }));

		expect(onSelectFolder).toHaveBeenCalledWith('');
	});

	it('is marked current while the root is open', () => {
		renderSidebar({ looseNoteCount: 2, selectedFolder: '' });

		expect(
			screen.getByRole('button', { name: /Loose notes/ }).getAttribute('aria-current')
		).toBe('true');
		expect(
			screen.getByRole('button', { name: /personal/ }).getAttribute('aria-current')
		).toBeNull();
	});

	it('is not marked current while a notebook is open', () => {
		renderSidebar({ looseNoteCount: 2, selectedFolder: 'personal' });

		expect(
			screen.getByRole('button', { name: /Loose notes/ }).getAttribute('aria-current')
		).toBeNull();
	});

	it('shows even when there are no notebooks at all', () => {
		// Otherwise a folder holding nothing but loose notes looks empty, and
		// every note in it is unreachable.
		renderSidebar({ tree: [], selectedFolder: '', looseNoteCount: 4 });
		expect(looseRow()).not.toBeNull();
	});

	it('does not let "no notebooks yet" stand above four notes', () => {
		// Both statements were true at once, and together they read as the app
		// contradicting itself about whether there is anything here.
		renderSidebar({ tree: [], selectedFolder: '', looseNoteCount: 4 });
		expect(screen.queryByText(/No notebooks yet/)).toBeNull();
	});

	it('still says there are no notebooks when the root is empty too', () => {
		renderSidebar({ tree: [], selectedFolder: undefined, looseNoteCount: 0 });
		expect(screen.getByText(/No notebooks yet/)).toBeDefined();
	});

	it('puts a new notebook beside the loose notes, not inside them', async () => {
		// The root is not a notebook, so it cannot be a parent.
		const onCreateFolder = vi.fn();
		renderSidebar({ selectedFolder: '', looseNoteCount: 2, onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Archive{Enter}');

		expect(onCreateFolder).toHaveBeenCalledWith(undefined, 'Archive');
	});
});

/**
 * Re-arranging. The tree is the user's directory structure, so a drag here
 * moves a directory or a file on the provider; the rules about which drops are
 * allowed are `store/rearrange.ts`, and what this file is about is that the
 * rows offer them, refuse the rest, and say which is which in words.
 */

/** jsdom has no `DataTransfer`, and the row writes to the one it is given. */
const transfer = () => ({ effectAllowed: 'none', setData: vi.fn() });

const holding = (path: string, name: string) => ({ kind: 'notebook', path, name }) as const;

describe('picking a notebook up', () => {
	it('hands the row up as what is being moved', () => {
		const onPickUp = vi.fn();
		renderSidebar({ onPickUp });

		fireEvent.dragStart(screen.getByRole('button', { name: /work$/ }), {
			dataTransfer: transfer(),
		});

		expect(onPickUp).toHaveBeenCalledWith({ kind: 'notebook', path: 'work', name: 'work' });
	});

	it('puts something on the drag, or Firefox starts no drag at all', () => {
		const dataTransfer = transfer();
		renderSidebar();

		fireEvent.dragStart(screen.getByRole('button', { name: /work$/ }), { dataTransfer });

		expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'work');
		expect(dataTransfer.effectAllowed).toBe('move');
	});

	it('lets go again when the drag ends nowhere', () => {
		const onCancelMove = vi.fn();
		renderSidebar({ onCancelMove, moving: holding('work', 'work') });

		fireEvent.dragEnd(screen.getByRole('button', { name: 'work — cannot go here' }));

		expect(onCancelMove).toHaveBeenCalled();
	});
});

describe('while something is being moved', () => {
	it('says what is in the air, and how to put it down', () => {
		renderSidebar({ moving: holding('work', 'work') });

		const hint = screen.getByRole('status');
		expect(hint.textContent).toContain('work');
		expect(hint.textContent).toContain('Escape');
	});

	it('names every row for where the thing would land', () => {
		renderSidebar({ moving: holding('work', 'work') });

		expect(screen.getByRole('button', { name: 'Move “work” into personal' })).toBeDefined();
	});

	it('refuses the notebook itself and everything inside it', () => {
		renderSidebar({ moving: holding('work', 'work') });

		const itself = screen.getByRole('button', { name: 'work — cannot go here' });
		const inside = screen.getByRole('button', { name: 'meetings — cannot go here' });
		expect(itself.hasAttribute('disabled')).toBe(true);
		expect(inside.hasAttribute('disabled')).toBe(true);
	});

	it('refuses the notebook it is already in', () => {
		renderSidebar({ moving: holding('work/meetings', 'meetings') });

		expect(
			screen.getByRole('button', { name: 'work — cannot go here' }).hasAttribute('disabled')
		).toBe(true);
	});

	it('offers the top level only to something that can come out to it', () => {
		renderSidebar({ moving: holding('work/meetings', 'meetings') });
		expect(
			screen.getByRole('button', { name: 'Move “meetings” to the top level' })
		).toBeDefined();

		cleanup();
		// Already there: the row would be a destination with nothing to do.
		renderSidebar({ moving: holding('work', 'work') });
		expect(screen.queryByText('Top level')).toBeNull();
	});

	it('does not offer the top level to a note, which the app never leaves loose', () => {
		renderSidebar({
			moving: { kind: 'note', id: 'n1', path: 'work/one.md', name: 'One' },
			looseNoteCount: 2,
		});

		expect(screen.queryByText('Top level')).toBeNull();
		// And the loose notes themselves are not a destination either.
		expect(
			screen
				.getByRole('button', { name: 'Loose notes — cannot go here' })
				.hasAttribute('disabled')
		).toBe(true);
	});

	it('puts it down where the row was clicked, rather than going there', async () => {
		const user = userEvent.setup();
		const onDrop = vi.fn();
		const onSelectFolder = vi.fn();
		renderSidebar({ onDrop, onSelectFolder, moving: holding('work', 'work') });

		await user.click(screen.getByRole('button', { name: 'Move “work” into personal' }));

		expect(onDrop).toHaveBeenCalledWith('personal');
		expect(onSelectFolder).not.toHaveBeenCalled();
	});

	it('drops on the row the pointer is over', () => {
		const onDrop = vi.fn();
		renderSidebar({ onDrop, moving: holding('work', 'work') });
		const target = screen.getByRole('button', { name: 'Move “work” into personal' });

		fireEvent.dragOver(target);
		fireEvent.drop(target);

		expect(onDrop).toHaveBeenCalledWith('personal');
	});

	it('takes the new-notebook button away, since the tree is being held', () => {
		renderSidebar({ moving: holding('work', 'work') });

		expect(screen.getByRole('button', { name: 'New notebook' }).hasAttribute('disabled')).toBe(
			true
		);
	});
});
