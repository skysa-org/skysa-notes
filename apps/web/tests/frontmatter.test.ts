import type * as Core from '@skysa/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { frontmatterOf } from '../src/store/frontmatter.js';
import { keepRows } from '../src/store/kept.js';
import { isUnnamed } from '../src/store/notes.js';
import { scratchMarks } from '../src/store/scratchpad.js';

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

/** `count` unnamed scratch notes, each with a frontmatter block of its own. */
const cards = (label: string, count: number): NoteRecord[] =>
	Array.from({ length: count }, (_, at) => ({
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
	}));

/** One draw of the wall: what each card asks. */
const draw = (wall: readonly NoteRecord[]) => {
	wall.forEach((card) => {
		isUnnamed(card);
		scratchMarks(card);
	});
};

describe("a note's frontmatter", () => {
	// First: the cards drawn by the tests after it raise the room kept.
	it('is kept for 400 blocks before any list has been drawn', () => {
		const wall = cards('Early', 400);
		draw(wall);
		draw(wall);
		expect(reads.count).toBe(400);
	});

	it('is read once per block, whether the card asks if it is named or for its marks', () => {
		const [card] = cards('Asked', 1);
		isUnnamed(card);
		scratchMarks(card);
		expect(reads.count).toBe(1);
	});

	it('is one read per card of a wall longer than the cache was, drawn again and again', () => {
		const wall = cards('Card', 1_000);
		keepRows('test-wall', wall.length);
		draw(wall);
		draw(wall);
		draw(wall);
		expect(reads.count).toBe(1_000);
	});

	it('is not read at all for a note with none', () => {
		const [card] = cards('Bare', 1);
		const bare = { ...card, frontmatter: null };
		expect(isUnnamed(bare)).toBe(true);
		expect(scratchMarks(bare)).toEqual({ pinned: false, color: undefined });
		expect(reads.count).toBe(0);
	});

	it('gives the same marks while its block is kept, and reads a block edited afresh', () => {
		const [card] = cards('Marked', 1);
		expect(scratchMarks(card)).toBe(scratchMarks({ ...card }));

		const pinned = { ...card, frontmatter: `${card.frontmatter ?? ''}pinned: true\n` };
		expect(scratchMarks(pinned)).toEqual({ pinned: true, color: 'yellow' });
		expect(reads.count).toBe(2);
	});

	it('is what core reads it as', () => {
		expect(frontmatterOf('title: Plan\npinned: true\n')).toEqual({
			title: 'Plan',
			pinned: true,
		});
		expect(frontmatterOf(null)).toEqual({});
	});
});
