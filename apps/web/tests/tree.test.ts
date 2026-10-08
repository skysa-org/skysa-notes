import { ancestorPaths, ROOT } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import {
	buildFolderTree,
	byParent,
	containsPath,
	findFolder,
	folderLabel,
	type FolderNode,
	keptTree,
	listedUnder,
	selectedFolderPath,
	withPins,
} from '../src/store/tree.js';

describe('buildFolderTree', () => {
	it('nests folders by path', () => {
		const tree = buildFolderTree({ paths: ['work', 'work/meetings', 'personal'] });

		expect(tree.map((node) => node.path)).toEqual(['personal', 'work']);
		expect(tree[1]?.children.map((node) => node.path)).toEqual(['work/meetings']);
	});

	it('names a node by its final segment', () => {
		const tree = buildFolderTree({ paths: ['work/meetings'] });
		expect(tree[0]?.name).toBe('work');
		expect(tree[0]?.children[0]?.name).toBe('meetings');
	});

	it('fills in a missing intermediate folder', () => {
		// The row for `work` has not arrived, but `work/meetings` has.
		const tree = buildFolderTree({ paths: ['work/meetings'] });
		expect(tree.map((node) => node.path)).toEqual(['work']);
	});

	it('shows a folder implied by a note, so the note cannot vanish', () => {
		const tree = buildFolderTree({ paths: [], notePaths: ['work/meetings/standup.md'] });
		expect(tree[0]?.path).toBe('work');
		expect(tree[0]?.children[0]?.path).toBe('work/meetings');
	});

	it('counts notes directly inside each folder', () => {
		const tree = buildFolderTree({
			paths: ['work', 'work/meetings'],
			notePaths: ['work/a.md', 'work/b.md', 'work/meetings/c.md', 'root.md'],
		});

		expect(tree[0]?.noteCount).toBe(2);
		expect(tree[0]?.children[0]?.noteCount).toBe(1);
	});

	it('counts the files beside the notes, and draws no notebook for one', () => {
		const tree = buildFolderTree({
			paths: ['work', 'work/meetings'],
			notePaths: ['work/a.md'],
			filePaths: ['work/a.png', 'work/b.pdf', 'work/meetings/c.png', 'pictures/d.png'],
		});

		expect(tree.map((node) => node.path)).toEqual(['work']);
		expect(tree[0]?.fileCount).toBe(2);
		expect(tree[0]?.children[0]?.fileCount).toBe(1);
		expect(tree[0]?.noteCount).toBe(1);
	});

	it('does not count root notes as belonging to any folder', () => {
		const tree = buildFolderTree({ paths: ['work'], notePaths: ['root.md'] });
		expect(tree[0]?.noteCount).toBe(0);
	});

	it('sorts siblings by name', () => {
		const tree = buildFolderTree({ paths: ['zeta', 'alpha', 'mu'] });
		expect(tree.map((node) => node.name)).toEqual(['alpha', 'mu', 'zeta']);
	});

	it('is empty when there is nothing to show', () => {
		expect(buildFolderTree({ paths: [] })).toEqual([]);
	});

	it('ignores the root, which is not a folder row', () => {
		expect(buildFolderTree({ paths: [''] })).toEqual([]);
	});
});

describe('withPins', () => {
	const tree = buildFolderTree({
		paths: ['Alpha', 'Beta', 'Gamma', 'Beta/One', 'Beta/Two', 'Beta/Three'],
	});
	const shape = (nodes: readonly FolderNode[]): unknown[] =>
		nodes.map((node) =>
			node.children.length === 0
				? `${node.name}${node.pinned === true ? '*' : ''}`
				: { [`${node.name}${node.pinned === true ? '*' : ''}`]: shape(node.children) }
		);

	it('puts a pinned notebook first among those beside it, the rest in their order', () => {
		expect(shape(withPins(tree, new Set(['Gamma'])))).toEqual([
			'Gamma*',
			'Alpha',
			{ Beta: ['One', 'Three', 'Two'] },
		]);
	});

	it('puts a pinned notebook inside another first under its parent, not at the top', () => {
		expect(shape(withPins(tree, new Set(['Beta/Two', 'Beta/Three'])))).toEqual([
			'Alpha',
			{ Beta: ['Three*', 'Two*', 'One'] },
			'Gamma',
		]);
	});

	it('leaves the tree as it was with nothing pinned', () => {
		expect(shape(withPins(tree, new Set()))).toEqual(shape(tree));
	});
});

describe('keptTree', () => {
	const PATHS = ['archive', 'work', 'work/meetings', 'work/plans'];
	const build = (notePaths: string[] = [], paths = PATHS) =>
		withPins(buildFolderTree({ paths, notePaths }), new Set());
	const at = findFolder;

	it('is the tree it was where nothing in it changed', () => {
		const before = build(['work/plans/q3.md']);
		expect(keptTree(before, build(['work/plans/q3.md']))).toBe(before);
	});

	it('is new from a changed notebook up, and the notebooks beside them as they were', () => {
		const before = build();
		const after = keptTree(before, build(['work/plans/q3.md']));
		expect(after).not.toBe(before);
		expect(at(after, 'work/plans')?.noteCount).toBe(1);
		expect(at(after, 'work')).not.toBe(at(before, 'work'));
		expect(at(after, 'work/meetings')).toBe(at(before, 'work/meetings'));
		expect(at(after, 'archive')).toBe(at(before, 'archive'));
	});

	it('takes in a notebook made, and lets go of one gone', () => {
		const before = build();
		const made = keptTree(before, build([], [...PATHS, 'work/drafts']));
		expect(at(made, 'work/drafts')).toBeDefined();
		expect(at(made, 'archive')).toBe(at(before, 'archive'));

		const gone = keptTree(before, build([], ['work', 'work/meetings', 'work/plans']));
		expect(at(gone, 'archive')).toBeUndefined();
		expect(at(gone, 'work')).toBe(at(before, 'work'));
	});

	it('is new for a notebook pinned', () => {
		const before = build();
		const after = keptTree(
			before,
			withPins(buildFolderTree({ paths: PATHS }), new Set(['archive']))
		);
		expect(at(after, 'archive')?.pinned).toBe(true);
		expect(at(after, 'archive')).not.toBe(at(before, 'archive'));
		expect(at(after, 'work')).toBe(at(before, 'work'));
	});

	it('is the tree built where there was none before', () => {
		const next = build();
		expect(keptTree(undefined, next)).toBe(next);
	});
});

describe('listedUnder', () => {
	const tree = buildFolderTree({
		paths: ['Work', 'Work/Meetings', 'Work/Projects', 'Work/Projects/Q3', 'Home'],
	});
	// In the order the store hands them over: newest first, every notebook
	// mixed together.
	const notes = [
		{ path: 'Work/Projects/Q3/budget.md' },
		{ path: 'Work/plan.md' },
		{ path: 'Work/Meetings/standup.md' },
		{ path: 'Work/Projects/launch.md' },
		{ path: 'Work/todo.md' },
		{ path: 'Work/Meetings/retro.md' },
	];
	const paths = (listed: readonly { path: string }[]) => listed.map((note) => note.path);
	const none = () => false;

	it('lists its own notes first, then each notebook inside it, at any depth, as the sidebar has them', () => {
		expect(paths(listedUnder(notes, 'Work', tree, none))).toEqual([
			'Work/plan.md',
			'Work/todo.md',
			'Work/Meetings/standup.md',
			'Work/Meetings/retro.md',
			'Work/Projects/launch.md',
			'Work/Projects/Q3/budget.md',
		]);
	});

	it('follows the pinned notebooks to the top of their level, as the sidebar does', () => {
		const pinned = withPins(tree, new Set(['Work/Projects']));

		expect(paths(listedUnder(notes, 'Work', pinned, none))).toEqual([
			'Work/plan.md',
			'Work/todo.md',
			'Work/Projects/launch.md',
			'Work/Projects/Q3/budget.md',
			'Work/Meetings/standup.md',
			'Work/Meetings/retro.md',
		]);
	});

	it('puts the pinned notes first in each notebook, not at the top of the list', () => {
		const pinned = (note: { path: string }) =>
			note.path === 'Work/todo.md' || note.path === 'Work/Meetings/retro.md';

		expect(paths(listedUnder(notes, 'Work', tree, pinned))).toEqual([
			'Work/todo.md',
			'Work/plan.md',
			'Work/Meetings/retro.md',
			'Work/Meetings/standup.md',
			'Work/Projects/launch.md',
			'Work/Projects/Q3/budget.md',
		]);
	});

	it('lists from a notebook inside another only what is under it', () => {
		const under = notes.filter((note) => note.path.startsWith('Work/Projects/'));

		expect(paths(listedUnder(under, 'Work/Projects', tree, none))).toEqual([
			'Work/Projects/launch.md',
			'Work/Projects/Q3/budget.md',
		]);
	});

	it('keeps a note in a notebook the tree does not have yet, after the rest', () => {
		const arrived = [{ path: 'Work/Archive/old.md' }, ...notes];

		expect(paths(listedUnder(arrived, 'Work', tree, none)).at(-1)).toBe('Work/Archive/old.md');
		// And before the tree has loaded at all, its own still come first.
		expect(paths(listedUnder(arrived, 'Work', undefined, none)).slice(0, 2)).toEqual([
			'Work/plan.md',
			'Work/todo.md',
		]);
		expect(listedUnder(arrived, 'Work', undefined, none)).toHaveLength(arrived.length);
	});
});

describe('ancestorPaths', () => {
	it('lists ancestors outermost first', () => {
		expect(ancestorPaths('work/meetings/2026/a.md')).toEqual([
			'work',
			'work/meetings',
			'work/meetings/2026',
		]);
	});

	it('gives a top-level entry no ancestors', () => {
		expect(ancestorPaths('a.md')).toEqual([]);
	});
});

describe('containsPath', () => {
	const tree = buildFolderTree({ paths: ['personal', 'work', 'work/meetings'] });

	it('finds a top-level folder', () => {
		expect(containsPath(tree, 'work')).toBe(true);
	});

	it('finds a nested folder', () => {
		expect(containsPath(tree, 'work/meetings')).toBe(true);
	});

	it('does not find a folder that is not there', () => {
		expect(containsPath(tree, 'archive')).toBe(false);
	});

	it('does not find the root, which is not a notebook', () => {
		expect(containsPath(tree, '')).toBe(false);
	});
});

describe('findFolder', () => {
	const tree = buildFolderTree({
		paths: ['personal', 'work', 'work/meetings'],
		notePaths: ['work/meetings/minutes.md', 'work/meetings/agenda.md'],
	});

	it('finds a nested folder, with its own notes counted', () => {
		expect(findFolder(tree, 'work/meetings')?.noteCount).toBe(2);
		expect(findFolder(tree, 'work')?.noteCount).toBe(0);
	});

	it('finds nothing for a folder that is not there, or the root', () => {
		expect(findFolder(tree, 'archive')).toBeUndefined();
		expect(findFolder(tree, ROOT)).toBeUndefined();
	});
});

describe('selectedFolderPath', () => {
	const tree = buildFolderTree({ paths: ['personal', 'work', 'work/meetings'] });

	it('opens the first notebook when none is asked for', () => {
		expect(selectedFolderPath(tree, undefined, 0, null)).toBe('personal');
	});

	it('falls back to a pinned notebook, since it is the first', () => {
		const tree = withPins(buildFolderTree({ paths: ['personal', 'work'] }), new Set(['work']));
		expect(selectedFolderPath(tree, undefined, 0, null)).toBe('work');
	});

	it('opens the notebook that was asked for', () => {
		expect(selectedFolderPath(tree, 'work/meetings', 0, null)).toBe('work/meetings');
	});

	it('falls back to the first notebook when the one asked for is gone', () => {
		// A stale link, or a notebook deleted underneath the user. Leaving the
		// missing folder selected would strand them in a pane with no notes and
		// no row in the sidebar to show where they are.
		expect(selectedFolderPath(tree, 'archive', 0, null)).toBe('personal');
	});

	it('opens the notebook open last when none is asked for', () => {
		expect(selectedFolderPath(tree, undefined, 0, 'work')).toBe('work');
	});

	it('prefers the notebook asked for to the one open last', () => {
		expect(selectedFolderPath(tree, 'personal', 0, 'work')).toBe('personal');
	});

	it('falls back to the notebook open last when the one asked for is gone', () => {
		expect(selectedFolderPath(tree, 'archive', 0, 'work')).toBe('work');
	});

	it('falls back to the first notebook when the one open last is gone too', () => {
		expect(selectedFolderPath(tree, undefined, 0, 'archive')).toBe('personal');
	});

	it('opens nothing until it knows which was open last', () => {
		// Opening the first and then jumping to the one remembered a frame later
		// reads as the app losing the user's place.
		expect(selectedFolderPath(tree, undefined, 0, undefined)).toBeUndefined();
		// Unless one was asked for, which needs no memory to open.
		expect(selectedFolderPath(tree, 'work', 0, undefined)).toBe('work');
	});

	it('opens the loose notes open last only while there are some', () => {
		expect(selectedFolderPath(tree, undefined, 2, ROOT)).toBe(ROOT);
		expect(selectedFolderPath(tree, undefined, 0, ROOT)).toBe('personal');
	});

	it('opens nothing when there are no notebooks', () => {
		expect(selectedFolderPath([], undefined, 0, null)).toBeUndefined();
		expect(selectedFolderPath([], 'work', 0, null)).toBeUndefined();
	});

	it('keeps the requested notebook while the tree is still loading', () => {
		// Dropping it here would open the first notebook for one frame and then
		// jump, which reads as the app losing the user's place.
		expect(selectedFolderPath(undefined, 'work', 0, null)).toBe('work');
		expect(selectedFolderPath(undefined, undefined, 0, null)).toBeUndefined();
	});

	describe('with loose notes at the root', () => {
		it('opens the root when it is asked for', () => {
			expect(selectedFolderPath(tree, '', 2, null)).toBe('');
		});

		it('still opens a notebook by default', () => {
			// Loose notes are an exception to the structure, not the place to
			// start. The row exists to reach them, not to be landed on.
			expect(selectedFolderPath(tree, undefined, 2, null)).toBe('personal');
		});

		it('opens the root when it is all there is', () => {
			expect(selectedFolderPath([], undefined, 2, null)).toBe('');
			expect(selectedFolderPath([], '', 2, null)).toBe('');
		});
	});

	describe('without loose notes at the root', () => {
		it('refuses the root, which has no row to select', () => {
			// The last loose note was moved or deleted while the URL still said
			// the root. Honouring it would strand the user in a pane the sidebar
			// no longer offers a way back to.
			expect(selectedFolderPath(tree, '', 0, null)).toBe('personal');
		});

		it('opens nothing when there is no notebook either', () => {
			expect(selectedFolderPath([], '', 0, null)).toBeUndefined();
			expect(selectedFolderPath([], undefined, 0, null)).toBeUndefined();
		});

		it('keeps a requested root while the tree is still loading', () => {
			expect(selectedFolderPath(undefined, '', 0, null)).toBe('');
		});
	});

	/**
	 * The tree and the count come from two independent live queries that resolve
	 * in either order. An unknown count is not a count of zero, and reading it
	 * as one opens a notebook for a frame and then snaps back to the root.
	 */
	describe('before the loose notes have been counted', () => {
		it('keeps a requested root rather than demoting it', () => {
			expect(selectedFolderPath(tree, '', undefined, null)).toBe('');
		});

		it('keeps it even when there is a notebook to demote it to', () => {
			// This is the whole bug: `tree` has landed and the count has not, so
			// the fallback below would fire on a root that is about to be fine.
			expect(
				selectedFolderPath(buildFolderTree({ paths: ['personal'] }), '', undefined, null)
			).toBe('');
		});

		it('opens nothing rather than guessing when there are no notebooks', () => {
			// Answering `''` here would head the pane "Loose notes" for a frame
			// before finding out the root is empty. Nothing open reads as the
			// loading state it is.
			expect(selectedFolderPath([], undefined, undefined, null)).toBeUndefined();
		});

		it('still opens the first notebook, which does not depend on the count', () => {
			expect(selectedFolderPath(tree, undefined, undefined, null)).toBe('personal');
			expect(selectedFolderPath(tree, 'work', undefined, null)).toBe('work');
		});
	});
});

describe('folderLabel', () => {
	it('names the root for what it holds', () => {
		expect(folderLabel('')).toBe('Loose notes');
	});

	it('leaves a notebook path alone', () => {
		expect(folderLabel('work/meetings')).toBe('work/meetings');
	});
});

describe('byParent', () => {
	it('groups notes by notebook, in the order each notebook and each note came', () => {
		const notes = ['b/1.md', 'a/1.md', 'b/2.md', 'top.md', 'a/2.md'].map((path) => ({ path }));
		expect(
			[...byParent(notes)].map(([folder, inIt]) => [folder, inIt.map(({ path }) => path)])
		).toEqual([
			['b', ['b/1.md', 'b/2.md']],
			['a', ['a/1.md', 'a/2.md']],
			[ROOT, ['top.md']],
		]);
	});
});
