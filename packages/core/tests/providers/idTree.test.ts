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

		expect(paths(settled)).toEqual(['+Work', '+Work/a.md']);
	});

	it('lists every folder before anything else, outermost first', () => {
		// Every path in a page is where the item is once the page is in, so
		// the page is one moment and not a history. A reader applying entries
		// in order would otherwise let a folder listed after a file carry the
		// file off: `Work/b.md` arriving, then `Work` renamed, puts it in the
		// renamed folder rather than where the page has it.
		const settled = run(seeded(), [
			file('b', 'g', 'b.md'),
			folder('g', 'f', 'Sub'),
			gone('a'),
			folder('f', ROOT_ID, 'Play'),
		]);

		expect(paths(settled)).toEqual(['+Play', '+Play/Sub', '+Play/Sub/b.md', '-Work/a.md']);
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
		expect(paths(second)).toEqual(['+Work', '+Work/a.md']);
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

		expect(placed.entries.find((entry) => entry.remoteId === 'a')).toEqual({
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

	describe('in a tree of thousands', () => {
		// A guard that counts steps up to the size of the tree is no guard in a
		// large one: the stack runs out first, the page throws, the cursor stays
		// where it was, and every pull after it fetches the same page again.
		const crowd: TreeState['nodes'] = Array.from({ length: 12_000 }, (_, index) => [
			`n${String(index)}`,
			ROOT_ID,
			`n${String(index)}.md`,
			false,
		]);
		const crowded = (nodes: TreeState['nodes']): TreeState => ({
			root: ROOT_ID,
			nodes: [...crowd, ...nodes],
			pending: [],
		});

		it('reads a cycle as it does in a small one, asking where things are', () => {
			const held = run(crowded([]), [folder('x', 'y', 'X'), folder('y', 'x', 'Y')], false);
			expect(held.entries).toEqual([]);
			expect(held.arrived).toEqual([]);
			expect(held.pending.map(([id]) => id)).toEqual(['x', 'y']);

			const settled = run(crowded([]), [folder('x', 'y', 'X'), folder('y', 'x', 'Y')]);
			expect(settled.entries).toEqual([
				{ deleted: true, remoteId: 'x' },
				{ deleted: true, remoteId: 'y' },
			]);
			expect(settled.next.nodes).toHaveLength(crowd.length);
		});

		it('reads a cycle as it does in a small one, asking where things were', () => {
			const looped = crowded([
				['x', 'y', 'X', true],
				['y', 'x', 'Y', true],
				['z', 'y', 'z.md', false],
			]);

			const settled = run(looped, [gone('z'), gone('x')]);
			expect(settled.entries).toEqual([
				{ deleted: true, remoteId: 'z' },
				{ deleted: true, remoteId: 'x' },
			]);
			// `y` went with the round's end: nothing reaches it from the root.
			expect(settled.next.nodes).toHaveLength(crowd.length);
		});

		it('comes right when a later page undoes a cycle an earlier one made', () => {
			// `A/B`, then B moved to the root and A moved into it. A feed promises
			// no order, so A can be listed a page ahead of B — and between the two
			// pages the tree holds A under B under A.
			const tree = crowded([
				['a', ROOT_ID, 'A', true],
				['b', 'a', 'B', true],
				['in-a', 'a', 'a.md', false],
				['in-b', 'b', 'b.md', false],
			]);

			const first = run(
				tree,
				[folder('a', 'b', 'A'), file('in-a', 'a', 'a.md', 'v2')],
				false
			);
			expect(first.entries).toEqual([]);
			expect(first.arrived).toEqual([]);
			expect(first.pending.map(([id, , , , was]) => [id, was])).toEqual([
				['a', 'A'],
				['in-a', 'A/a.md'],
			]);

			const second = run(first.next, [folder('b', ROOT_ID, 'B'), gone('in-b')]);
			expect(paths(second)).toEqual(['+B', '+B/A', '+B/A/a.md', '-A/B/b.md']);
			expect(second.arrived).toEqual([]);
			expect(second.pending).toEqual([]);
			expect(second.pruned).toBe(0);
		});
	});

	it('places a chain far deeper than any provider allows', () => {
		const DEPTH = 2000;
		const id = (level: number) => `d${String(level)}`;
		const chain = Array.from({ length: DEPTH }, (_, level) =>
			folder(id(level), level === 0 ? ROOT_ID : id(level - 1), String(level))
		);
		const whole = Array.from({ length: DEPTH }, (_, level) => String(level)).join('/');

		// Deepest first, so nothing is placed until the last item is in.
		const made = run(EMPTY, [file('leaf', id(DEPTH - 1), 'leaf.md'), ...[...chain].reverse()]);
		expect(made.entries).toHaveLength(DEPTH + 1);
		expect(made.entries.at(-1)).toMatchObject({ remoteId: 'leaf', path: `${whole}/leaf.md` });
		// Every folder arrived, and every one but the top is under another.
		expect(made.arrived).toEqual([id(0)]);

		// And where it *was*, from the tree a cursor carried.
		const deleted = run(made.next, [gone('leaf')]);
		expect(deleted.entries).toEqual([
			{ path: `${whole}/leaf.md`, deleted: true, remoteId: 'leaf' },
		]);
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
