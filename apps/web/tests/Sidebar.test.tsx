import { cleanup, render, screen } from '@testing-library/react';
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

	it('puts a new notebook beside the loose notes, not inside them', async () => {
		// The root is not a notebook, so it cannot be a parent.
		const onCreateFolder = vi.fn();
		renderSidebar({ selectedFolder: '', looseNoteCount: 2, onCreateFolder });

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Archive{Enter}');

		expect(onCreateFolder).toHaveBeenCalledWith(undefined, 'Archive');
	});
});
