import { describe, expect, it } from 'vitest';

import {
	applyItem,
	arrivals,
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
): Settled & { next: TreeState; arrived: string[] } => {
	const page = pageFrom(from);
	items.forEach((item) => {
		applyItem(page, item);
	});
	const arrived = arrivals(page);
	const settled = settlePage(page, roundEnds);
	return {
		...settled,
		arrived,
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

	it('reports a deletion where the item was, and by id alone one it never placed', () => {
		// The engine matches the second by id: a note this device pushed after
		// its cursor, or nothing at all.
		const settled = run(seeded(), [gone('a'), gone('stranger')]);

		expect(settled.entries).toEqual([
			{ path: 'Work/a.md', deleted: true, remoteId: 'a' },
			{ deleted: true, remoteId: 'stranger' },
		]);
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
		expect(settled.pruned).toBe(1);
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

	it('reports a held item it never placed by id alone, when it is deleted', () => {
		// Held with no earlier path, then deleted: there is nowhere it was, and
		// above all not the root.
		const held = run(EMPTY, [file('a', 'f', 'a.md')], false);
		const deleted = run(held.next, [gone('a')]);

		expect(deleted.entries).toEqual([{ deleted: true, remoteId: 'a' }]);
	});

	it('carries a held item’s details through to the entry', () => {
		const empty: TreeItem = {
			id: 'a',
			gone: false,
			parent: 'f',
			name: 'a.md',
			folder: false,
			version: 'v-a',
			modifiedAt: 'when',
			size: 0,
		};
		const held = run(EMPTY, [empty], false);
		const placed = run(held.next, [folder('f', ROOT_ID, 'Work')]);

		expect(placed.entries[0]).toEqual({
			remoteId: 'a',
			path: 'Work/a.md',
			kind: 'file',
			version: 'v-a',
			modifiedAt: 'when',
			size: 0,
		});
	});

	it('survives a cycle in the tree rather than overflowing', () => {
		const settled = run(EMPTY, [folder('x', 'y', 'X'), folder('y', 'x', 'Y')]);

		expect(settled.entries).toEqual([
			{ deleted: true, remoteId: 'x' },
			{ deleted: true, remoteId: 'y' },
		]);
		expect(settled.next.nodes).toEqual([]);

		// A tree carried in a cursor with a cycle already in it, where asking
		// where a deleted item *was* walks the loop.
		const looped: TreeState = {
			root: ROOT_ID,
			nodes: [
				['x', 'y', 'X', true],
				['y', 'x', 'Y', true],
			],
			pending: [],
		};
		expect(run(looped, [gone('x')]).entries).toEqual([{ deleted: true, remoteId: 'x' }]);
	});

	describe('arrivals', () => {
		it('are folders made in the page, and not files or renamed folders', () => {
			const made = run(seeded(), [
				folder('g', ROOT_ID, 'New'),
				file('n', ROOT_ID, 'new.md'),
				folder('f', ROOT_ID, 'Renamed'),
			]);

			expect(made.arrived).toEqual(['g']);
		});

		it('are only the top-most, since listing one lists what is inside', () => {
			const made = run(EMPTY, [folder('b', 'a', 'B'), folder('a', ROOT_ID, 'A')]);

			expect(made.arrived).toEqual(['a']);
		});

		it('include a folder moved back in from outside', () => {
			// Moved out and pruned, then moved back: the feed names the folder
			// alone, and only a listing can say what came back inside it.
			const out = run(seeded(), [folder('f', 'elsewhere', 'Work')]);
			expect(out.arrived).toEqual([]);
			const back = run(out.next, [folder('f', ROOT_ID, 'Work')]);
			expect(back.arrived).toEqual(['f']);
		});

		it('include a held folder once a later page places it, and not one moved within', () => {
			const tree = run(EMPTY, [folder('p', ROOT_ID, 'P'), folder('q', ROOT_ID, 'Q')]).next;
			const first = run(tree, [folder('h', 'later', 'H'), folder('q', 'p', 'Q')], false);
			expect(first.arrived).toEqual([]);

			const second = run(first.next, [folder('later', ROOT_ID, 'Later')], false);
			expect(second.arrived).toEqual(['later']);
			expect(second.entries.map((entry) => entry.path)).toContain('Later/H');
		});

		it('include a new folder made inside one that was held, once that is placed', () => {
			// B moves under a folder not seen yet and is held, remembering where
			// it was; K is made inside it. When B turns out to be under a folder
			// already known, B has not arrived — its contents are in the tree —
			// but K has.
			const tree = run(EMPTY, [
				folder('a', ROOT_ID, 'A'),
				folder('b', 'a', 'B'),
				folder('c', ROOT_ID, 'C'),
			]).next;
			const held = run(tree, [folder('b', 'unseen', 'B'), folder('k', 'b', 'K')], false);
			expect(held.arrived).toEqual([]);

			const placed = run(held.next, [folder('b', 'c', 'B')]);
			expect(placed.arrived).toEqual(['k']);
		});

		it('include a folder rescued from one deleted earlier in the round', () => {
			// The tree still holds it, under a parent that is gone: nothing says
			// what it held any more, so it is listed like any other arrival.
			const nested = run(EMPTY, [
				folder('a', ROOT_ID, 'A'),
				folder('b', 'a', 'B'),
				file('n', 'b', 'n.md'),
			]).next;
			const deleted = run(nested, [gone('a')], false);
			const rescued = run(deleted.next, [folder('b', ROOT_ID, 'B')]);

			expect(rescued.arrived).toEqual(['b']);
		});

		it('are asked before the round ends as well as at its end', () => {
			const middle = run(seeded(), [folder('g', ROOT_ID, 'New')], false);

			expect(middle.arrived).toEqual(['g']);
		});
	});
});
