import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandsProvider, useCommands } from '../src/commands/context.js';
import { Sidebar } from '../src/components/Sidebar.js';
import { buildFolderTree, withPins } from '../src/store/tree.js';

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
			// Open, so the notebook inside it is listed: shutting is tested below.
			openNotebooks={new Set(['work'])}
			{...props}
		/>
	);

describe('Sidebar', () => {
	it('lists every notebook', () => {
		renderSidebar();

		// Anchored: the pane header's menu is named for the open notebook too.
		expect(screen.getByRole('button', { name: /^personal/ })).toBeDefined();
		expect(screen.getByRole('button', { name: /work$/ })).toBeDefined();
		expect(screen.getByRole('button', { name: /^meetings/ })).toBeDefined();
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
			screen.getByRole('button', { name: /^personal/ }).getAttribute('aria-current')
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

	it('creates at the top level whatever notebook is open', async () => {
		// The `+` used to put the new notebook inside the open one, which meant
		// that with anything open there was no way to make a top-level notebook
		// at all — and something is open whenever there is anything to open.
		const onCreateFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Standups{Enter}');

		expect(onCreateFolder).toHaveBeenCalledWith(undefined, 'Standups');
	});

	it('still puts one inside, when that is what was asked for', async () => {
		const onCreateFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'Options for “work”' }));
		await userEvent.click(
			await screen.findByRole('button', { name: 'New notebook inside “work”' })
		);
		await userEvent.type(
			screen.getByLabelText('Name for a notebook inside “work”'),
			'Standups{Enter}'
		);

		expect(onCreateFolder).toHaveBeenCalledWith('work', 'Standups');
	});

	it('creates the first notebook at the root', async () => {
		const onCreateFolder = vi.fn();
		renderSidebar({ tree: [], selectedFolder: undefined, onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Personal{Enter}');

		expect(onCreateFolder).toHaveBeenCalledWith(undefined, 'Personal');
	});

	it('makes "Create one" in the empty sidebar the way to the first notebook', async () => {
		const onCreateFolder = vi.fn();
		renderSidebar({ tree: [], selectedFolder: undefined, onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'Create one' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Personal{Enter}');

		expect(onCreateFolder).toHaveBeenCalledWith(undefined, 'Personal');
	});

	it('opens the field when asked from outside, once per asking', async () => {
		const onCreateFolder = vi.fn();
		const props = { tree: [], selectedFolder: undefined, onCreateFolder };
		const { rerender } = renderSidebar(props);
		expect(screen.queryByLabelText('New notebook name')).toBeNull();

		const again = (asked: number) => {
			rerender(
				<Sidebar
					{...props}
					onSelectFolder={() => undefined}
					looseNoteCount={0}
					newNotebookAsked={asked}
				/>
			);
		};
		again(1);
		expect(document.activeElement).toBe(screen.getByLabelText('New notebook name'));
		await userEvent.keyboard('{Escape}');
		expect(screen.queryByLabelText('New notebook name')).toBeNull();

		// The same count again is not a new asking.
		again(1);
		expect(screen.queryByLabelText('New notebook name')).toBeNull();
		again(2);
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Work{Enter}');
		expect(onCreateFolder).toHaveBeenCalledWith(undefined, 'Work');
	});
});

/**
 * Loose notes are `.md` files sitting at the root of the remote app folder.
 * The app never creates one, and it does not move the user's files to tidy them
 * away — so it has to be able to show them (docs/ARCHITECTURE.md §12.6).
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
			screen.getByRole('button', { name: /^personal/ }).getAttribute('aria-current')
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
		// The way out is beside it rather than in it, so it is not announced
		// as part of the news.
		expect(hint.textContent).not.toContain('Cancel');
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
	});

	it('puts it down when Cancel is pressed', async () => {
		const onCancelMove = vi.fn();
		renderSidebar({ onCancelMove, moving: holding('work', 'work') });

		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onCancelMove).toHaveBeenCalled();
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

/**
 * Managing a notebook. `renameFolder` and `deleteFolder` had been in the store,
 * tested, and uncalled — the sidebar could make a notebook and nothing else.
 */

const counted = buildFolderTree({
	paths: ['personal', 'work', 'work/meetings'],
	notePaths: ['work/one.md', 'work/two.md', 'work/meetings/three.md'],
});

const openMenu = async (name: string) => {
	await userEvent.click(screen.getByRole('button', { name: `Options for “${name}”` }));
};

describe('renaming a notebook', () => {
	it('happens in the row, with the name ready to be typed over', async () => {
		const onRenameFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onRenameFolder });

		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

		const field = screen.getByRole('textbox', { name: 'Rename work' });
		expect(field).toHaveProperty('value', 'work');
		await userEvent.keyboard('Projects{Enter}');

		expect(onRenameFolder).toHaveBeenCalledWith('work', 'Projects');
	});

	it('changes only the name: the row keeps its highlight and its count', async () => {
		renderSidebar({ tree: counted, selectedFolder: 'work' });
		const row = screen.getByRole('button', { name: /^work/ });
		expect(row.classList.contains('selected')).toBe(true);
		expect(within(row).getByText('3')).toBeDefined();

		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

		// jsdom draws nothing, so what is asserted is what the stylesheet reads
		// to draw the row as it was: the highlight's class, and the count.
		const editing = screen.getByRole('textbox', { name: 'Rename work' }).parentElement;
		expect(editing?.classList.contains('selected')).toBe(true);
		expect(within(editing as HTMLElement).getByText('3')).toBeDefined();
	});

	it('is abandoned by Escape, and the row comes back', async () => {
		const onRenameFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onRenameFolder });
		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

		await userEvent.keyboard('Projects{Escape}');

		expect(onRenameFolder).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /^work/ })).toBeDefined();
	});

	it('asks for nothing when the name did not change', async () => {
		// Blur commits, so tabbing away from a field nobody typed in would
		// otherwise queue a move on the provider for a rename to the same name.
		const onRenameFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onRenameFolder });
		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));

		await userEvent.keyboard('{Enter}');

		expect(onRenameFolder).not.toHaveBeenCalled();
	});
});

describe('deleting a notebook', () => {
	it('asks first, and counts everything that would go with it', async () => {
		const onDeleteFolder = vi.fn();
		renderSidebar({ tree: counted, selectedFolder: 'work', onDeleteFolder });

		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

		// Three: the two in it and the one in the notebook inside it, which is
		// the part the user cannot see from here.
		const asked = screen.getByRole('alertdialog', { name: 'Delete notebook?' });
		expect(within(asked).getByText(/will be deleted/).textContent).toBe(
			'“work” and the 3 notes in it will be deleted.'
		);
		// Cancel holds the focus: the answer that deletes is never the default.
		expect(document.activeElement).toBe(within(asked).getByRole('button', { name: 'Cancel' }));
		expect(onDeleteFolder).not.toHaveBeenCalled();
	});

	it('counts the files that would go with it, which is the one way a file is deleted', async () => {
		const withFiles = buildFolderTree({
			paths: ['personal', 'work', 'work/meetings'],
			notePaths: ['work/one.md', 'work/two.md', 'work/meetings/three.md'],
			filePaths: ['work/a.png', 'work/meetings/b.pdf', 'personal/c.png'],
		});
		renderSidebar({ tree: withFiles, selectedFolder: 'work' });

		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

		const asked = screen.getByRole('alertdialog', { name: 'Delete notebook?' });
		expect(within(asked).getByText(/will be deleted/).textContent).toBe(
			'“work” and the 3 notes and 2 files in it will be deleted.'
		);
	});

	it('counts the files in a notebook that holds nothing else', async () => {
		const onlyFiles = buildFolderTree({ paths: ['pictures'], filePaths: ['pictures/a.png'] });
		renderSidebar({ tree: onlyFiles, selectedFolder: 'pictures' });

		await openMenu('pictures');
		await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

		const asked = screen.getByRole('alertdialog', { name: 'Delete notebook?' });
		expect(within(asked).getByText(/will be deleted/).textContent).toBe(
			'“pictures” and the 1 file in it will be deleted.'
		);
	});

	it('does not count notes that are not there', async () => {
		renderSidebar({ tree: counted, selectedFolder: 'personal' });

		await openMenu('personal');
		await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

		const asked = screen.getByRole('alertdialog', { name: 'Delete notebook?' });
		expect(within(asked).getByText(/will be deleted/).textContent).toBe(
			'“personal” will be deleted.'
		);
	});

	it('goes through on the second press', async () => {
		const onDeleteFolder = vi.fn();
		renderSidebar({ tree: counted, selectedFolder: 'work', onDeleteFolder });
		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

		await userEvent.click(
			within(screen.getByRole('alertdialog', { name: 'Delete notebook?' })).getByRole(
				'button',
				{
					name: 'Delete',
				}
			)
		);

		expect(onDeleteFolder).toHaveBeenCalledWith('work');
	});

	it('is called off by Cancel and by Escape', async () => {
		const onDeleteFolder = vi.fn();
		renderSidebar({ tree: counted, selectedFolder: 'work', onDeleteFolder });
		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('alertdialog', { name: 'Delete notebook?' })).toBeNull();

		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
		await userEvent.keyboard('{Escape}');

		expect(screen.queryByRole('alertdialog', { name: 'Delete notebook?' })).toBeNull();
		expect(onDeleteFolder).not.toHaveBeenCalled();
	});
});

describe('the notebook menu', () => {
	it('picks the notebook up, which is the same move a drag makes', async () => {
		const onPickUp = vi.fn();
		renderSidebar({ selectedFolder: 'work', onPickUp });

		await openMenu('work');
		await userEvent.click(await screen.findByRole('button', { name: 'Move' }));

		expect(onPickUp).toHaveBeenCalledWith({ kind: 'notebook', path: 'work', name: 'work' });
	});

	it('has nothing to act on at the loose notes, which are not a notebook', () => {
		renderSidebar({ selectedFolder: '', looseNoteCount: 2 });

		expect(screen.queryByRole('button', { name: 'Options for “Loose notes”' })).toBeNull();
		// Nor is there one in the header, about whatever is open.
		expect(screen.queryByRole('button', { name: 'Notebook options' })).toBeNull();
	});

	it('is at the end of every notebook’s row, after its count', () => {
		renderSidebar({ selectedFolder: 'work' });

		for (const name of ['work', 'personal']) {
			const options = screen.getByRole('button', { name: `Options for “${name}”` });
			const row = screen.getByRole('button', { name: new RegExp(`^${name}`) });
			// Beside the row's button, not in it, which HTML does not allow.
			expect(row.contains(options)).toBe(false);
			expect(options.closest('.row-item')).toBe(row.parentElement);
			expect(
				row.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();
		}
	});

	it('is there, disabled, while something is being moved', () => {
		renderSidebar({
			selectedFolder: 'work',
			moving: { kind: 'note', id: 'n1', path: 'work/a.md', name: 'A' },
		});

		expect(
			screen.getByRole('button', { name: 'Options for “personal”' }).hasAttribute('disabled')
		).toBe(true);
	});

	it('closes on Escape without leaving the focus nowhere', async () => {
		renderSidebar({ selectedFolder: 'work' });
		await openMenu('work');

		await userEvent.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Options for “work”' })
		);
	});
});

/** What a row says beside its name, from `aria-describedby`. */
const description = (row: HTMLElement): string | null | undefined => {
	const id = row.getAttribute('aria-describedby');
	return id === null ? null : document.getElementById(id)?.textContent;
};

describe('pinning a notebook', () => {
	it('is offered first in its menu, and pins the notebook it is about', async () => {
		const onPinFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onPinFolder });

		await openMenu('personal');
		const menu = screen.getByRole('group', { name: 'Notebook “personal”' });
		expect(within(menu).getAllByRole('button')[0]?.textContent).toBe('Pin to top');
		await userEvent.click(within(menu).getByRole('button', { name: 'Pin to top' }));

		expect(onPinFolder).toHaveBeenCalledWith('personal', true);
	});

	it('shows one inside another first under its parent, tinted, said to be pinned, and unpins it', async () => {
		const onPinFolder = vi.fn();
		renderSidebar({
			tree: withPins(
				buildFolderTree({ paths: ['personal', 'work', 'work/archive', 'work/meetings'] }),
				new Set(['work/meetings'])
			),
			onPinFolder,
		});

		expect(
			[...document.querySelectorAll('.row-label')].map((label) => label.textContent)
		).toEqual(['personal', 'work', 'meetings', 'archive']);
		const pinned = screen.getByRole('button', { name: /^meetings/ });
		expect(pinned.classList.contains('pinned')).toBe(true);
		expect(description(pinned)).toBe('Pinned');
		// Its name is what it was, which is what it is found by.
		expect(screen.getByRole('button', { name: 'meetings' })).toBe(pinned);
		const other = screen.getByRole('button', { name: /^archive/ });
		expect(other.classList.contains('pinned')).toBe(false);
		expect(description(other)).toBeNull();

		await openMenu('meetings');
		await userEvent.click(await screen.findByRole('button', { name: 'Unpin' }));

		expect(onPinFolder).toHaveBeenCalledWith('work/meetings', false);
	});
});

/**
 * A right-click on a notebook's row opens its `⋯`'s menu: the same items,
 * acting on the notebook clicked rather than the one open.
 */
describe('the notebook right-click menu', () => {
	const rightClick = (name: RegExp) => {
		fireEvent.contextMenu(screen.getByRole('button', { name }), { clientX: 40, clientY: 60 });
	};

	it('offers its `⋯`’s items, about the notebook clicked', () => {
		renderSidebar({ selectedFolder: 'work' });

		rightClick(/^personal/);

		const menu = screen.getByRole('group', { name: 'Notebook “personal”' });
		expect(
			within(menu)
				.getAllByRole('button')
				.map((item) => item.textContent)
		).toEqual(['New notebook inside “personal”', 'Rename', 'Move', 'Delete']);
		// Ready for the keyboard: a menu opened with the menu key is used from here.
		expect(document.activeElement).toBe(within(menu).getAllByRole('button')[0]);
	});

	it('renames the notebook clicked, not the one open', async () => {
		const onRenameFolder = vi.fn();
		renderSidebar({ selectedFolder: 'work', onRenameFolder });

		rightClick(/^personal/);
		await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
		await userEvent.keyboard('Home{Enter}');

		expect(onRenameFolder).toHaveBeenCalledWith('personal', 'Home');
	});

	it('asks before deleting the notebook clicked', async () => {
		const onDeleteFolder = vi.fn();
		renderSidebar({ tree: counted, selectedFolder: 'personal', onDeleteFolder });

		rightClick(/^work/);
		await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const asked = screen.getByRole('alertdialog', { name: 'Delete notebook?' });
		expect(within(asked).getByText(/will be deleted/).textContent).toBe(
			'“work” and the 3 notes in it will be deleted.'
		);
		await userEvent.click(within(asked).getByRole('button', { name: 'Delete' }));

		expect(onDeleteFolder).toHaveBeenCalledWith('work');
	});

	it('picks up the notebook clicked', async () => {
		const onPickUp = vi.fn();
		renderSidebar({ selectedFolder: 'work', onPickUp });

		rightClick(/^meetings/);
		await userEvent.click(screen.getByRole('button', { name: 'Move' }));

		expect(onPickUp).toHaveBeenCalledWith({
			kind: 'notebook',
			path: 'work/meetings',
			name: 'meetings',
		});
	});

	it('closes on Escape and on a press elsewhere', async () => {
		renderSidebar({ selectedFolder: 'work' });

		rightClick(/^personal/);
		await userEvent.keyboard('{Escape}');
		expect(screen.queryByRole('group', { name: 'Notebook “personal”' })).toBeNull();

		rightClick(/^personal/);
		await userEvent.click(screen.getByRole('heading', { name: 'Notebooks' }));
		expect(screen.queryByRole('group', { name: 'Notebook “personal”' })).toBeNull();
	});

	it('leaves the browser its own menu where there is no notebook to act on', () => {
		renderSidebar({ looseNoteCount: 2 });

		const loose = screen.getByRole('button', { name: /Loose notes/ });
		// `fireEvent` answers whether the default went ahead.
		expect(fireEvent.contextMenu(loose)).toBe(true);
		expect(screen.queryByRole('group', { name: /^Notebook/ })).toBeNull();
	});

	it('is not offered while something is being moved', () => {
		renderSidebar({ moving: { kind: 'note', id: 'n', path: 'personal/n.md', name: 'n' } });

		fireEvent.contextMenu(screen.getByRole('button', { name: /into work$/ }));

		expect(screen.queryByRole('group', { name: /^Notebook/ })).toBeNull();
	});
});

describe('opening and shutting a notebook', () => {
	const toggle = (name: string) =>
		screen.getByRole('button', { name: `Notebooks inside \u201c${name}\u201d` });

	it('lists only the top level of a notebook nobody has opened, counting all it holds', () => {
		renderSidebar({ tree: counted, openNotebooks: new Set() });

		expect(screen.queryByRole('button', { name: /^meetings/ })).toBeNull();
		// Its own two notes and the one in the notebook inside it.
		expect(screen.getByRole('button', { name: /^work/ }).textContent).toBe('work3');
		expect(toggle('work').getAttribute('aria-expanded')).toBe('false');
	});

	it('lists what is inside once it is open, still counting all it holds', () => {
		renderSidebar({ tree: counted });

		expect(screen.getByRole('button', { name: /^meetings/ })).toBeDefined();
		// Its list shows the notes inside `meetings` too (`listedUnder`), so
		// opening it changes what is listed beside it, not what it holds.
		expect(screen.getByRole('button', { name: /^work/ }).textContent).toBe('work3');
		expect(screen.getByRole('button', { name: /^meetings/ }).textContent).toBe('meetings1');
		expect(toggle('work').getAttribute('aria-expanded')).toBe('true');
	});

	it('opens and shuts by its chevron, which has no tab stop of its own', async () => {
		const onOpenNotebooks = vi.fn();
		const { rerender } = renderSidebar({ openNotebooks: new Set(), onOpenNotebooks });

		expect(toggle('work').tabIndex).toBe(-1);
		await userEvent.click(toggle('work'));
		expect(onOpenNotebooks).toHaveBeenLastCalledWith(['work'], true);

		rerender(
			<Sidebar
				tree={tree}
				selectedFolder="personal"
				onSelectFolder={() => undefined}
				onCreateFolder={() => undefined}
				looseNoteCount={0}
				openNotebooks={new Set(['work'])}
				onOpenNotebooks={onOpenNotebooks}
			/>
		);
		await userEvent.click(toggle('work'));
		expect(onOpenNotebooks).toHaveBeenLastCalledWith(['work'], false);
	});

	it('opens and shuts with Right and Left on the row, and goes in and out', () => {
		const onOpenNotebooks = vi.fn();
		const { rerender } = renderSidebar({ openNotebooks: new Set(), onOpenNotebooks });
		const work = () => screen.getByRole('button', { name: /^work/ });

		fireEvent.keyDown(work(), { key: 'ArrowRight' });
		expect(onOpenNotebooks).toHaveBeenLastCalledWith(['work'], true);

		rerender(
			<Sidebar
				tree={tree}
				selectedFolder="personal"
				onSelectFolder={() => undefined}
				onCreateFolder={() => undefined}
				looseNoteCount={0}
				openNotebooks={new Set(['work'])}
				onOpenNotebooks={onOpenNotebooks}
			/>
		);
		work().focus();
		fireEvent.keyDown(work(), { key: 'ArrowRight' });
		const meetings = screen.getByRole('button', { name: /^meetings/ });
		expect(document.activeElement).toBe(meetings);

		fireEvent.keyDown(meetings, { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(work());

		fireEvent.keyDown(work(), { key: 'ArrowLeft' });
		expect(onOpenNotebooks).toHaveBeenLastCalledWith(['work'], false);
	});

	it('opens the notebooks the open notebook is in, once', () => {
		const onOpenNotebooks = vi.fn();
		const deep = buildFolderTree({ paths: ['a/b/c', 'd'] });
		const props = {
			tree: deep,
			selectedFolder: 'a/b/c',
			onSelectFolder: () => undefined,
			onCreateFolder: () => undefined,
			looseNoteCount: 0,
			onOpenNotebooks,
		};
		const { rerender } = render(<Sidebar {...props} openNotebooks={new Set()} />);

		expect(onOpenNotebooks).toHaveBeenCalledTimes(1);
		expect(onOpenNotebooks).toHaveBeenCalledWith(['a', 'a/b'], true);

		// The user shut one of them again: that stands.
		rerender(<Sidebar {...props} openNotebooks={new Set(['a/b'])} />);
		expect(onOpenNotebooks).toHaveBeenCalledTimes(1);
	});

	it('sets aside room for a chevron only where a notebook has one', () => {
		const { container, unmount } = renderSidebar({
			tree: buildFolderTree({ paths: ['a', 'b'] }),
		});
		expect(container.querySelector('.tree.nested')).toBeNull();
		unmount();

		expect(renderSidebar().container.querySelector('.tree.nested')).not.toBeNull();
	});
});

describe('a shut notebook while something is being moved', () => {
	// A note in `work`, being filed into `work/meetings`: `work` is where it is
	// already, and no destination.
	const filing = { kind: 'note', id: 'n1', path: 'work/a.md', name: 'a' } as const;

	it('offers its chevron as a stop, since its row is no destination', () => {
		renderSidebar({ openNotebooks: new Set(), moving: filing });

		expect(screen.getByRole('button', { name: /^work/ })).toHaveProperty('disabled', true);
		expect(
			screen.getByRole('button', { name: 'Notebooks inside \u201cwork\u201d' }).tabIndex
		).toBe(0);
	});

	it('takes a drop on its chevron as one on the row', () => {
		const onDrop = vi.fn();
		renderSidebar({
			openNotebooks: new Set(),
			moving: holding('personal', 'personal'),
			onDrop,
		});

		fireEvent.drop(screen.getByRole('button', { name: 'Notebooks inside \u201cwork\u201d' }));
		expect(onDrop).toHaveBeenCalledWith('work');
	});

	it('opens under a drag that rests on it, and not under one passing over', () => {
		const onOpenNotebooks = vi.fn();
		const now = vi.spyOn(Date, 'now');
		renderSidebar({ openNotebooks: new Set(), moving: filing, onOpenNotebooks });
		const row = screen.getByRole('button', { name: /^work/ }).parentElement;
		const over = (at: number) => {
			now.mockReturnValue(at);
			fireEvent.dragOver(row as Element);
		};

		over(1000);
		over(1300);
		// Gone and back: the wait starts again.
		over(2500);
		over(2900);
		expect(onOpenNotebooks).not.toHaveBeenCalled();

		over(3200);
		expect(onOpenNotebooks).toHaveBeenCalledWith(['work'], true);
		now.mockRestore();
	});
});

describe('a shut notebook, otherwise', () => {
	it('says on its row whether what is inside it is showing', () => {
		renderSidebar({ openNotebooks: new Set() });

		expect(screen.getByRole('button', { name: /^work/ }).getAttribute('aria-expanded')).toBe(
			'false'
		);
		expect(
			screen.getByRole('button', { name: /^personal/ }).getAttribute('aria-expanded')
		).toBeNull();
	});

	it('leaves an arrow pressed with a modifier to the browser', () => {
		const onOpenNotebooks = vi.fn();
		renderSidebar({ onOpenNotebooks });
		const work = screen.getByRole('button', { name: /^work/ });

		const back = fireEvent.keyDown(work, { key: 'ArrowLeft', altKey: true });
		fireEvent.keyDown(work, { key: 'ArrowLeft', metaKey: true });

		expect(back).toBe(true);
		expect(onOpenNotebooks).not.toHaveBeenCalled();
	});

	it('reveals the open notebook in a source shown after another, at the same path', () => {
		const onOpenNotebooks = vi.fn();
		const deep = buildFolderTree({ paths: ['a/b'] });
		const props = {
			tree: deep,
			selectedFolder: 'a/b',
			onSelectFolder: () => undefined,
			onCreateFolder: () => undefined,
			looseNoteCount: 0,
			onOpenNotebooks,
		};
		const { rerender } = render(<Sidebar {...props} openNotebooks={new Set(['a'])} />);
		expect(onOpenNotebooks).not.toHaveBeenCalled();

		// Another source: its set is read afresh, and `a` is shut in it.
		rerender(<Sidebar {...props} openNotebooks={undefined} />);
		rerender(<Sidebar {...props} openNotebooks={new Set()} />);
		expect(onOpenNotebooks).toHaveBeenCalledWith(['a'], true);
	});

	it('opens the notebooks around one renamed from the palette', () => {
		const onOpenNotebooks = vi.fn();
		const commands: { current: ReturnType<typeof useCommands> } = { current: [] };
		const Commands = () => {
			commands.current = useCommands();
			return null;
		};
		const { rerender } = render(
			<CommandsProvider>
				<Sidebar
					tree={tree}
					selectedFolder="work/meetings"
					onSelectFolder={() => undefined}
					onCreateFolder={() => undefined}
					looseNoteCount={0}
					openNotebooks={new Set(['work'])}
					onOpenNotebooks={onOpenNotebooks}
				/>
				<Commands />
			</CommandsProvider>
		);
		// The user shut it after it was revealed.
		rerender(
			<CommandsProvider>
				<Sidebar
					tree={tree}
					selectedFolder="work/meetings"
					onSelectFolder={() => undefined}
					onCreateFolder={() => undefined}
					looseNoteCount={0}
					openNotebooks={new Set()}
					onOpenNotebooks={onOpenNotebooks}
				/>
				<Commands />
			</CommandsProvider>
		);
		onOpenNotebooks.mockClear();

		act(() => {
			commands.current.find((command) => command.id === 'notebook.rename')?.run();
		});

		expect(onOpenNotebooks).toHaveBeenCalledWith(['work'], true);
	});
});
