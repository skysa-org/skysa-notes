import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar.js';
import { buildFolderTree } from '../src/store/tree.js';

/**
 * The sidebar lists notebooks and nothing else. The root is where notebooks
 * live rather than a notebook itself, so it has no row — and a note therefore
 * always belongs to a notebook the user can see.
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
