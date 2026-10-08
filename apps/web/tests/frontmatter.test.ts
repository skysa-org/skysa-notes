import type * as Core from '@skysa/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';

/** Every YAML read the cache asks core for. */
const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock('@skysa/core', async (importOriginal) => {
	const actual = await importOriginal<typeof Core>();
	return {
		...actual,
		readFrontmatter: (frontmatter: string | null) => {
			reads.count += 1;
			return actual.readFrontmatter(frontmatter);
		},
	};
});

beforeEach(() => {
	reads.count = 0;
});

/**
 * The scratchpad asks every card's frontmatter whether it is named, and what
 * its pin and colour are, on every draw — and it draws on every autosave of
 * any note. A block is read once, and kept for as many cards as are drawn.
 */

/**
 * The store as a tab starts with it: nothing kept, no list drawn. What is kept
 * outlives a test, and how much may be depends on the lists drawn before.
 */
const fresh = async () => {
	vi.resetModules();
	const [{ frontmatterOf }, { keepRows }, { isUnnamed }, { scratchMarks }] = await Promise.all([
		import('../src/store/frontmatter.js'),
		import('../src/store/kept.js'),
		import('../src/store/notes.js'),
		import('../src/store/scratchpad.js'),
	]);
	/** One draw of the wall: what each card asks. */
	const draw = (wall: readonly NoteRecord[]) => {
		wall.forEach((note) => {
			isUnnamed(note);
			scratchMarks(note);
		});
	};
	return { frontmatterOf, keepRows, isUnnamed, scratchMarks, draw };
};

/** An unnamed scratch note with a frontmatter block of its own. */
const card = (label: string, at = 0): NoteRecord => ({
	id: `${label}-${String(at)}`,
	connectionId: LOCAL_CONNECTION_ID,
	path: `.scratchpad/untitled-${String(at + 1)}.md`,
	title: 'Untitled',
	body: 'a\n',
	frontmatter: `id: ${label}-${String(at)}\ncolor: yellow\n`,
	tags: [],
	contentHash: 'h',
	source: null,
	dirty: 0,
	deletedLocally: 0,
	createdAt: 1,
	updatedAt: 1,
});

const cards = (label: string, count: number): NoteRecord[] =>
	Array.from({ length: count }, (_, at) => card(label, at));

describe("a note's frontmatter", () => {
	it('is kept for 400 blocks before any list has been drawn', async () => {
		const { draw } = await fresh();
		const wall = cards('Early', 400);
		draw(wall);
		draw(wall);
		expect(reads.count).toBe(400);
	});

	it('is read once per block, whether the card asks if it is named or for its marks', async () => {
		const { isUnnamed, scratchMarks } = await fresh();
		const asked = card('Asked');
		isUnnamed(asked);
		scratchMarks(asked);
		expect(reads.count).toBe(1);
	});

	it('is one read per card of a wall longer than the cache was, drawn again and again', async () => {
		const { keepRows, draw } = await fresh();
		const wall = cards('Card', 1_000);
		keepRows('wall', wall.length);
		draw(wall);
		draw(wall);
		draw(wall);
		expect(reads.count).toBe(1_000);
	});

	it('lets go of what was asked least lately, not of what was kept first', async () => {
		const { keepRows, frontmatterOf, draw } = await fresh();
		// Room for 500: the wall's 400 and a hundred more.
		const wall = cards('Wall', 400);
		keepRows('wall', wall.length);
		draw(wall);
		// Each a block asked once, between draws: an edit, a card opened.
		cards('Once', 200).forEach((once) => {
			frontmatterOf(once.frontmatter);
			draw(wall);
		});
		expect(reads.count).toBe(400 + 200);
	});

	it('is not read at all for a note with none', async () => {
		const { isUnnamed, scratchMarks } = await fresh();
		const bare = { ...card('Bare'), frontmatter: null };
		expect(isUnnamed(bare)).toBe(true);
		expect(scratchMarks(bare)).toEqual({ pinned: false, color: undefined });
		expect(reads.count).toBe(0);
	});

	it('gives the same marks while its block is kept, and reads a block edited afresh', async () => {
		const { scratchMarks } = await fresh();
		const marked = card('Marked');
		expect(scratchMarks(marked)).toBe(scratchMarks({ ...marked }));

		const pinned = { ...marked, frontmatter: `${marked.frontmatter ?? ''}pinned: true\n` };
		expect(scratchMarks(pinned)).toEqual({ pinned: true, color: 'yellow' });
		expect(reads.count).toBe(2);
	});

	it('is what core reads it as, and cannot be changed by whoever is handed it', async () => {
		const { frontmatterOf } = await fresh();
		const read = frontmatterOf('title: Plan\npinned: true\ntags: [a]\n');
		expect(read).toEqual({ title: 'Plan', pinned: true, tags: ['a'] });
		expect(Object.isFrozen(read)).toBe(true);
		expect(Object.isFrozen(read.tags)).toBe(true);
		expect(frontmatterOf(null)).toEqual({});
	});
});
