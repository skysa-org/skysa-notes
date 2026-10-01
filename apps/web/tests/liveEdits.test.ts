import { describe, expect, it, vi } from 'vitest';

import { type NoteRecord, noteRef } from '../src/store/db.js';
import { createLiveEdits, shownNote } from '../src/store/liveEdits.js';

/**
 * What is typed into a note is shown everywhere the note is — its row, its
 * name — as it is typed, and laid over the row only while the row is behind
 * it: never over a body that came from elsewhere, and never once the row has
 * caught up.
 */

const note = (fields: Partial<NoteRecord> = {}): NoteRecord => ({
	id: 'n1',
	connectionId: 'local',
	path: 'Work/plans.md',
	title: 'Plans',
	body: '# Plans\n\nBefore.\n',
	frontmatter: null,
	tags: [],
	contentHash: '',
	dirty: 0,
	deletedLocally: 0,
	createdAt: 1_000,
	updatedAt: 1_000,
	...fields,
});

const row = note();
const REF = noteRef(row);

describe('a note shown as it is typed', () => {
	it('is the row itself while nothing is typed', () => {
		const edits = createLiveEdits();
		expect(shownNote(row, edits.get(REF))).toBe(row);
	});

	it('has the body typed, owed to the remote', () => {
		const edits = createLiveEdits();
		edits.typed(REF, '# Plans\n\nAfter.\n', '');
		expect(shownNote(row, edits.get(REF))).toMatchObject({
			body: '# Plans\n\nAfter.\n',
			dirty: 1,
		});
	});

	it('takes the title the body gives it, as saving it would', () => {
		const edits = createLiveEdits();
		const begun = note({ path: 'Work/untitled.md', title: 'Untitled', body: '' });
		edits.typed(noteRef(begun), '# Groceries\n', '');
		expect(shownNote(begun, edits.get(noteRef(begun))).title).toBe('Groceries');

		// A named note's title follows its heading, without renaming its file.
		edits.typed(REF, '# Roadmap\n', '');
		expect(shownNote(row, edits.get(REF))).toMatchObject({
			title: 'Roadmap',
			path: 'Work/plans.md',
		});
	});

	it('keeps a begun note "Untitled" until there is a heading to name it', () => {
		const edits = createLiveEdits();
		const begun = note({ path: 'Work/untitled.md', title: 'Untitled', body: '' });
		edits.typed(noteRef(begun), 'milk\n', '');
		expect(shownNote(begun, edits.get(noteRef(begun))).title).toBe('Untitled');
	});

	it('is not laid over a body pulled from elsewhere since', () => {
		const edits = createLiveEdits();
		edits.typed(REF, 'typed into the old body\n', '');
		const pulled = note({ body: 'from another device\n', bodyOrigin: 'pulled' });
		expect(shownNote(pulled, edits.get(REF))).toBe(pulled);
	});
});

describe('a body once it is stored', () => {
	it('is still shown until the row has it', () => {
		const edits = createLiveEdits();
		edits.typed(REF, 'After.\n', '');
		edits.landed(REF, 'body', 'After.\n', 2_000);
		// The live query has not brought the stored row back yet.
		expect(shownNote(row, edits.get(REF)).body).toBe('After.\n');
	});

	it('gives way to the row once the row has it, as stored', () => {
		const edits = createLiveEdits();
		edits.typed(REF, 'After.\u0000\n', '');
		edits.landed(REF, 'body', 'After.\u0000\n', 2_000);
		const stored = note({ body: 'After.\n', updatedAt: 2_000 });
		expect(shownNote(stored, edits.get(REF))).toBe(stored);
	});

	it('gives way to a later edit from another tab', () => {
		const edits = createLiveEdits();
		edits.typed(REF, 'here\n', '');
		edits.landed(REF, 'body', 'here\n', 2_000);
		const later = note({ body: 'in another tab\n', updatedAt: 3_000 });
		expect(shownNote(later, edits.get(REF))).toBe(later);
	});

	it('leaves alone what has been typed since the write was issued', () => {
		const edits = createLiveEdits();
		edits.typed(REF, 'one\n', '');
		edits.typed(REF, 'one two\n', '');
		edits.landed(REF, 'body', 'one\n', 2_000);
		const stored = note({ body: 'one\n', updatedAt: 2_000 });
		expect(shownNote(stored, edits.get(REF)).body).toBe('one two\n');
	});
});

describe('a name as it is typed', () => {
	it('is shown trimmed, and not while it is blank', () => {
		const edits = createLiveEdits();
		edits.naming(REF, '  Roadmap ');
		expect(shownNote(row, edits.get(REF)).title).toBe('Roadmap');
		edits.naming(REF, '   ');
		expect(shownNote(row, edits.get(REF))).toBe(row);
	});

	it('is the name shown over a heading being typed', () => {
		const edits = createLiveEdits();
		edits.typed(REF, '# Heading\n', '');
		edits.naming(REF, 'Chosen');
		expect(shownNote(row, edits.get(REF))).toMatchObject({
			title: 'Chosen',
			body: '# Heading\n',
		});
	});

	it('goes when it is given up, and the body typed stays', () => {
		const edits = createLiveEdits();
		edits.typed(REF, '# Plans\n\nAfter.\n', '');
		edits.naming(REF, 'Abandoned');
		edits.naming(REF, undefined);
		expect(shownNote(row, edits.get(REF))).toMatchObject({
			title: 'Plans',
			body: '# Plans\n\nAfter.\n',
		});
	});

	it('goes when the rename fails, and stays until the row has it when it does not', () => {
		const edits = createLiveEdits();
		edits.naming(REF, 'Roadmap');
		edits.landed(REF, 'title', 'Roadmap', 2_000);
		expect(shownNote(row, edits.get(REF)).title).toBe('Roadmap');
		expect(shownNote(note({ title: 'Roadmap', updatedAt: 2_000 }), edits.get(REF)).title).toBe(
			'Roadmap'
		);

		edits.naming(REF, 'Refused');
		edits.landed(REF, 'title', 'Refused', undefined);
		expect(shownNote(row, edits.get(REF))).toBe(row);
	});
});

describe('who hears of an edit', () => {
	it('is whoever is showing that note, and no other', () => {
		const edits = createLiveEdits();
		const mine = vi.fn();
		const other = vi.fn();
		const stop = edits.subscribe(REF, mine);
		edits.subscribe('local\u0000other', other);

		edits.typed(REF, 'x\n', '');
		expect(mine).toHaveBeenCalledTimes(1);
		expect(other).not.toHaveBeenCalled();

		stop();
		edits.typed(REF, 'xy\n', '');
		expect(mine).toHaveBeenCalledTimes(1);
	});

	it('is told when its note is let go to make room', () => {
		const edits = createLiveEdits();
		const first = vi.fn();
		edits.typed('ref-0', 'first\n', '');
		edits.subscribe('ref-0', first);
		Array.from({ length: 50 }, (_, index) => {
			edits.typed(`ref-${String(index + 1)}`, 'later\n', '');
		});
		expect(edits.get('ref-0')).toBeUndefined();
		expect(first).toHaveBeenCalledTimes(1);
		expect(edits.get('ref-50')).toBeDefined();
	});
});
