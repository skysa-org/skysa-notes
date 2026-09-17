import { describe, expect, it } from 'vitest';

import {
	applyItem,
	nodesOf,
	pageFrom,
	type Settled,
	settlePage,
	type TreeItem,
	type TreeState,
} from '../../src/providers/idTree.js';

/**
 * The tree an id-based feed is read against, driven directly. OneDrive's tests
 * cover it through Graph's wire format; these say what any adapter built on it
 * can rely on, without one.
 */

const ROOT_ID = 'root';

const folder = (id: string, parent: string, name: string): TreeItem => ({
	id,
	gone: false,
	parent,
	name,
	folder: true,
	version: '',
	modifiedAt: '',
	size: -1,
});

const file = (id: string, parent: string, name: string, version = `v-${id}`): TreeItem => ({
	id,
	gone: false,
	parent,
	name,
	folder: false,
	version,
	modifiedAt: '2026-09-17T00:00:00Z',
	size: 3,
});

const gone = (id: string): TreeItem => ({ id, gone: true });

const EMPTY: TreeState = { root: ROOT_ID, nodes: [], pending: [] };

/** One page applied and settled, with the state the next page starts from. */
const run = (
	from: TreeState,
	items: readonly TreeItem[],
	roundEnds = true
): Settled & { next: TreeState } => {
	const page = pageFrom(from);
	items.forEach((item) => {
		applyItem(page, item);
	});
	const settled = settlePage(page, roundEnds);
	return {
		...settled,
		next: { root: from.root, nodes: nodesOf(page), pending: settled.pending },
	};
};

const paths = (settled: Settled) =>
	settled.entries.map((entry) => `${entry.deleted === true ? '-' : '+'}${entry.path}`);

/** A folder `Work` holding `a.md`, already known. */
const seeded = () => run(EMPTY, [folder('f', ROOT_ID, 'Work'), file('a', 'f', 'a.md')]).next;

describe('an id tree', () => {
	it('places what a page lists, whatever order it lists it in', () => {
		const settled = run(EMPTY, [file('a', 'f', 'a.md'), folder('f', ROOT_ID, 'Work')]);

		expect(paths(settled)).toEqual(['+Work/a.md', '+Work']);
	});

	it('reports a renamed folder alone, and places its contents under the new name', () => {
		const renamed = run(seeded(), [folder('f', ROOT_ID, 'Play')]);
		expect(paths(renamed)).toEqual(['+Play']);

		const edited = run(renamed.next, [file('a', 'f', 'a.md', 'v2')]);
		expect(paths(edited)).toEqual(['+Play/a.md']);
	});

	it('keeps an item’s last state when it appears more than once', () => {
		const settled = run(seeded(), [
			file('a', 'f', 'a.md', 'v2'),
			file('b', ROOT_ID, 'b.md'),
			file('a', ROOT_ID, 'moved.md', 'v3'),
		]);

		expect(paths(settled)).toEqual(['+b.md', '+moved.md']);
		expect(settled.entries[1]).toMatchObject({ remoteId: 'a', version: 'v3' });
	});

	it('reports a deletion where the item was, and drops one it never knew', () => {
		const settled = run(seeded(), [gone('a'), gone('stranger')]);

		expect(settled.entries).toEqual([{ path: 'Work/a.md', deleted: true, remoteId: 'a' }]);
	});

	it('reports a deletion where the item was even if its folder moved in the same page', () => {
		const settled = run(seeded(), [folder('f', ROOT_ID, 'Play'), gone('a')]);

		expect(paths(settled)).toEqual(['+Play', '-Work/a.md']);
	});

	it('holds an item whose parent has not arrived until the round ends', () => {
		const first = run(EMPTY, [file('a', 'f', 'a.md')], false);
		expect(first.entries).toEqual([]);
		expect(first.pending).toHaveLength(1);

		const second = run(first.next, [folder('f', ROOT_ID, 'Work')]);
		expect(paths(second)).toEqual(['+Work/a.md', '+Work']);
		expect(second.pending).toEqual([]);
	});

	it('reports an item moved out of the root as deleted where it was', () => {
		const settled = run(seeded(), [file('a', 'elsewhere', 'a.md')]);

		expect(settled.entries).toEqual([{ path: 'Work/a.md', deleted: true, remoteId: 'a' }]);
		expect(settled.next.nodes.map(([id]) => id)).toEqual(['f']);
	});

	it('remembers where a held item was, so it is reported deleted there', () => {
		// Moved out across a page boundary: the first page cannot tell "parent on
		// a later page" from "gone", and the tree has already forgotten the path.
		const held = run(seeded(), [file('a', 'elsewhere', 'a.md')], false);
		expect(held.entries).toEqual([]);

		const ended = run(held.next, []);
		expect(ended.entries).toEqual([{ path: 'Work/a.md', deleted: true, remoteId: 'a' }]);
	});

	it('prunes what a deleted folder held without reporting it', () => {
		const settled = run(seeded(), [gone('f')]);

		expect(settled.entries).toEqual([{ path: 'Work', deleted: true, remoteId: 'f' }]);
		expect(settled.pruned).toBe(1);
		expect(settled.next.nodes).toEqual([]);
	});

	it('keeps what a deleted folder held until the round ends', () => {
		const settled = run(seeded(), [gone('f')], false);

		expect(settled.pruned).toBe(0);
		expect(settled.next.nodes.map(([id]) => id)).toEqual(['a']);
	});

	it('drops the root itself', () => {
		const settled = run(seeded(), [folder(ROOT_ID, 'drive', 'renamed by the user')]);

		expect(settled.entries).toEqual([]);
	});

	it('leaves out a file with no version, and not a folder with none', () => {
		const settled = run(EMPTY, [folder('f', ROOT_ID, 'Work'), file('a', 'f', 'a.md', '')]);

		expect(paths(settled)).toEqual(['+Work']);
	});

	it('says which folders arrived, and not ones merely renamed', () => {
		const made = run(seeded(), [folder('g', ROOT_ID, 'New'), folder('f', ROOT_ID, 'Renamed')]);
		expect(made.arrived).toEqual(['g']);

		// Moved out, pruned, then moved back: the feed names the folder alone, and
		// only a listing can say what came back inside it.
		const out = run(made.next, [folder('g', 'elsewhere', 'New')]);
		expect(out.arrived).toEqual([]);
		const back = run(out.next, [folder('g', ROOT_ID, 'New')]);
		expect(back.arrived).toEqual(['g']);
	});
});
