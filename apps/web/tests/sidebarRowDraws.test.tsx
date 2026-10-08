import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RowOptionsModule from '../src/components/RowOptions.js';
import { Sidebar, type SidebarProps } from '../src/components/Sidebar.js';
import { buildFolderTree, keptTree } from '../src/store/tree.js';

/**
 * The page draws the sidebar again on every autosave, every sync run and
 * every move of a drag, and builds the tree again for the first two. A
 * notebook's row is drawn again only when something about it changes (#275):
 * here, a row's drawing is counted by its `⋯`, which every notebook's row has.
 */
const drawn = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock('../src/components/RowOptions.js', async (importOriginal) => {
	const actual = await importOriginal<typeof RowOptionsModule>();
	return {
		...actual,
		RowOptions: (props: Parameters<typeof actual.RowOptions>[0]) => {
			drawn.names.push(props.name);
			return actual.RowOptions(props);
		},
	};
});

afterEach(cleanup);

beforeEach(() => {
	drawn.names = [];
});

const PATHS = ['archive', 'personal', 'work', 'work/meetings', 'work/plans'];
const NOTES = ['work/meetings/monday.md', 'personal/list.md'];
const build = (notePaths = NOTES) => buildFolderTree({ paths: PATHS, notePaths });

/** The sidebar as the page draws it: every handler made anew. */
const props = (changed: Partial<SidebarProps> = {}): SidebarProps => ({
	tree: build(),
	selectedFolder: 'personal',
	onSelectFolder: () => undefined,
	onCreateFolder: () => undefined,
	onPickUp: () => undefined,
	onDrop: () => undefined,
	onCancelMove: () => undefined,
	onOpenNotebooks: () => undefined,
	looseNoteCount: 0,
	openNotebooks: new Set(['work']),
	...changed,
});

const drawSidebar = (first: Partial<SidebarProps> = {}) => {
	const shown = props(first);
	const { rerender } = render(<Sidebar {...shown} />);
	drawn.names = [];
	return (again: Partial<SidebarProps> = {}) => {
		rerender(
			<Sidebar
				{...props({ tree: shown.tree, openNotebooks: shown.openNotebooks, ...again })}
			/>
		);
	};
};

const sorted = () => [...drawn.names].sort();

describe("a notebook's row", () => {
	it('is not drawn again when the page draws the same tree with new handlers', () => {
		const drawAgain = drawSidebar();
		drawAgain();
		expect(drawn.names).toEqual([]);
	});

	it('is not drawn again for a tree built again the same', () => {
		const first = build();
		const drawAgain = drawSidebar({ tree: first });
		drawAgain({ tree: keptTree(first, build()) });
		expect(drawn.names).toEqual([]);
	});

	it('is drawn again for a count that changed beneath it, and no other is', () => {
		const first = build();
		const drawAgain = drawSidebar({ tree: first });
		drawAgain({ tree: keptTree(first, build([...NOTES, 'work/plans/q3.md'])) });
		expect(sorted()).toEqual(['plans', 'work']);
	});

	it('is drawn again as the selection moves on to it or off it, with the rows above', () => {
		const drawAgain = drawSidebar({ selectedFolder: 'archive' });
		drawAgain({ selectedFolder: 'work/meetings' });
		expect(sorted()).toEqual(['archive', 'meetings', 'work']);
	});

	it('is drawn again as a drag comes on to it or leaves it, and no other is', () => {
		const moving = {
			kind: 'note',
			id: 'n1',
			path: 'work/meetings/monday.md',
			name: 'Monday',
		} as const;
		drawSidebar({ moving });
		fireEvent.dragOver(screen.getByRole('button', { name: 'Move “Monday” into archive' }));
		expect(sorted()).toEqual(['archive']);

		drawn.names = [];
		fireEvent.dragOver(screen.getByRole('button', { name: 'Move “Monday” into personal' }));
		expect(sorted()).toEqual(['archive', 'personal']);
	});

	it('is drawn again as notebooks open or shut only where it is open itself', () => {
		const drawAgain = drawSidebar();
		drawAgain({ openNotebooks: new Set(['work']) });
		expect(sorted()).toEqual(['work']);

		drawn.names = [];
		drawAgain({ openNotebooks: new Set() });
		expect(sorted()).toEqual(['work']);
	});

	it('calls the handler the page gave last, though it was not drawn again', () => {
		const first = vi.fn();
		const last = vi.fn();
		const drawAgain = drawSidebar({ onSelectFolder: first });
		drawAgain({ onSelectFolder: last });

		fireEvent.click(screen.getByRole('button', { name: /^archive/ }));

		expect(first).not.toHaveBeenCalled();
		expect(last).toHaveBeenCalledWith('archive');
	});
});
