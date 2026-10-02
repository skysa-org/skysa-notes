import { ancestorPaths, ROOT } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import {
	buildFolderTree,
	containsPath,
	findFolder,
	folderLabel,
	selectedFolderPath,
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
