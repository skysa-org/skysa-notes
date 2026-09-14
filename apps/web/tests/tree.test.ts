import { describe, expect, it } from 'vitest';

import { ancestorPaths, buildFolderTree } from '../src/store/tree.js';

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
