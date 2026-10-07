import { type PreviewLine, previewLineText, readFrontmatter, SCRATCHPAD_FOLDER } from '@skysa/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import {
	createNote,
	deleteNote,
	isUnnamed,
	listScratchNotes,
	moveNote,
	renameNote,
	saveNoteBody,
	setScratchMarks,
} from '../src/store/notes.js';
import {
	CARD_LINES,
	CARD_WORDS,
	cardLines,
	getScratchpadShown,
	PICTURE_LINES,
	scratchGroups,
	scratchMarks,
	setScratchpadShown,
} from '../src/store/scratchpad.js';

/**
 * The scratchpad's store (docs/ARCHITECTURE.md §7, "The scratchpad"): whether
 * a source shows it on this device, a card's pin and colour as its file keeps
 * them, and the ordinary notes in `.scratchpad/` that its cards are.
 */

let db: NotesDatabase;
let counter = 0;

beforeEach(() => {
	counter += 1;
	db = createDatabase(`test-scratchpad-${String(counter)}`);
});

afterEach(async () => {
	await db.delete();
});

const scope = { connectionId: LOCAL_CONNECTION_ID };
const scratch = (input: { title?: string; body?: string } = {}) =>
	createNote(db, { ...scope, folderPath: SCRATCHPAD_FOLDER, ...input });

describe('whether a source shows its scratchpad', () => {
	/** A source connected on this device. */
	const connect = (connectionId: string) =>
		db.syncState.put({ connectionId, clientId: 'this-browser' });

	it('is shown until it is hidden, on this device, for that source alone', async () => {
		await connect('c1');
		expect(await getScratchpadShown(db, LOCAL_CONNECTION_ID)).toBe(true);
		expect(await getScratchpadShown(db, 'c1')).toBe(true);
		await setScratchpadShown(db, 'c1', false);
		expect(await getScratchpadShown(db, 'c1')).toBe(false);
		expect(await getScratchpadShown(db, LOCAL_CONNECTION_ID)).toBe(true);
		await setScratchpadShown(db, 'c1', true);
		expect(await getScratchpadShown(db, 'c1')).toBe(true);
	});

	it('is hidden on a source connected after it was last hidden, and on none there already', async () => {
		await connect('c1');
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, false);
		// Connected before: it shows what it did.
		expect(await getScratchpadShown(db, 'c1')).toBe(true);
		// Connected after: hidden, as the device's own was left.
		await connect('c2');
		expect(await getScratchpadShown(db, 'c2')).toBe(false);
		await setScratchpadShown(db, 'c1', false);
		expect(await getScratchpadShown(db, 'c2')).toBe(false);
	});

	it('is shown on a source connected after it was last shown', async () => {
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, false);
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, true);
		await connect('c1');
		expect(await getScratchpadShown(db, 'c1')).toBe(true);
	});

	it('leaves the notes where they are when it is hidden', async () => {
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, true);
		const note = await scratch({ body: 'Milk\n' });
		await setScratchpadShown(db, LOCAL_CONNECTION_ID, false);
		expect((await listScratchNotes(db, LOCAL_CONNECTION_ID)).map((each) => each.id)).toEqual([
			note.id,
		]);
	});
});

describe('a source’s scratch notes', () => {
	it('are the notes in its scratchpad’s folder, newest made first, and none of a notebook’s', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		const first = await scratch({ body: 'One\n' });
		await createNote(db, { ...scope, folderPath: 'Work', title: 'Plan' });
		const second = await scratch({ body: 'Two\n' });
		await db.notes.update([LOCAL_CONNECTION_ID, first.id], { createdAt: 1_000 });
		await db.notes.update([LOCAL_CONNECTION_ID, second.id], { createdAt: 2_000 });

		expect((await listScratchNotes(db, LOCAL_CONNECTION_ID)).map((each) => each.id)).toEqual([
			second.id,
			first.id,
		]);
	});

	it('leaves out one deleted, and another source’s', async () => {
		const gone = await scratch({ body: 'Gone\n' });
		await deleteNote(db, gone.id, scope);
		await createNote(db, { connectionId: 'c1', folderPath: SCRATCHPAD_FOLDER, body: 'Else\n' });
		expect(await listScratchNotes(db, LOCAL_CONNECTION_ID)).toEqual([]);
	});

	it('are each unnamed until named, the second and third as much as the first', async () => {
		const notes = [await scratch(), await scratch(), await scratch()];
		expect(notes.map((note) => note.path)).toEqual([
			'.scratchpad/untitled.md',
			'.scratchpad/untitled-2.md',
			'.scratchpad/untitled-3.md',
		]);
		expect(notes.map(isUnnamed)).toEqual([true, true, true]);
		const named = await renameNote(db, notes[1]?.id ?? '', 'Trip', scope);
		expect(isUnnamed(named)).toBe(false);
	});

	it('take a name from a first heading typed into one, as a notebook’s first note does', async () => {
		await scratch();
		const second = await scratch();
		const saved = await saveNoteBody(db, second.id, '# Shopping\n\nMilk\n', undefined, scope);
		expect(saved.path).toBe('.scratchpad/shopping.md');
		expect(saved.title).toBe('Shopping');
	});

	it('are numbered names in a notebook that stay names, as they always have', async () => {
		await createFolder(db, { ...scope, name: 'Work' });
		await createNote(db, { ...scope, folderPath: 'Work' });
		const second = await createNote(db, { ...scope, folderPath: 'Work' });
		expect(second.path).toBe('Work/untitled-2.md');
		expect(isUnnamed(second)).toBe(false);
	});
});

describe('a card’s pin and colour', () => {
	it('are written to its file, and read back from it', async () => {
		const note = await scratch({ body: 'Milk\n' });
		const marked = await setScratchMarks(db, note.id, { pinned: true, color: 'yellow' }, scope);
		expect(readFrontmatter(marked.frontmatter)).toMatchObject({
			pinned: true,
			color: 'yellow',
		});
		expect(marked.source).toContain('pinned: true');
		expect(marked.source).toContain('color: yellow');
		expect(marked.dirty).toBe(1);
		expect(marked.body).toBe('Milk\n');
		expect(scratchMarks(marked)).toEqual({ pinned: true, color: 'yellow' });
	});

	it('are each changed alone, and taken away by setting nothing', async () => {
		const note = await scratch();
		await setScratchMarks(db, note.id, { pinned: true, color: 'blue' }, scope);
		const recoloured = await setScratchMarks(db, note.id, { color: 'green' }, scope);
		expect(scratchMarks(recoloured)).toEqual({ pinned: true, color: 'green' });
		const plain = await setScratchMarks(
			db,
			note.id,
			{ pinned: undefined, color: undefined },
			scope
		);
		expect(scratchMarks(plain)).toEqual({ pinned: false, color: undefined });
		expect(plain.source).not.toContain('pinned');
		expect(plain.source).not.toContain('color');
	});

	it('read a colour the app does not know as none, and leave it in the file', () => {
		const note = { frontmatter: 'color: chartreuse\npinned: "yes"\n' };
		expect(scratchMarks(note)).toEqual({ pinned: false, color: undefined });
		expect(scratchMarks({ frontmatter: 'color: " Teal "\n' })).toEqual({
			pinned: false,
			color: 'teal',
		});
	});

	it('go when the card is made a note in a notebook, and nothing else does', async () => {
		await createFolder(db, { ...scope, name: 'Trips' });
		const note = await scratch({ title: 'Lisbon', body: 'Spring\n' });
		await setScratchMarks(db, note.id, { pinned: true, color: 'teal' }, scope);
		const moved = await moveNote(db, note.id, 'Trips', scope);
		expect(moved.path).toBe('Trips/lisbon.md');
		expect(readFrontmatter(moved.frontmatter)).toMatchObject({ title: 'Lisbon' });
		expect(readFrontmatter(moved.frontmatter).pinned).toBeUndefined();
		expect(readFrontmatter(moved.frontmatter).color).toBeUndefined();
		expect(moved.body).toBe('Spring\n');
	});
});

describe('the scratchpad’s groups', () => {
	it('are the pinned, then the rest, each in the order the notes came', () => {
		const notes = [
			{ id: 'a', frontmatter: null },
			{ id: 'b', frontmatter: 'pinned: true\n' },
			{ id: 'c', frontmatter: 'color: red\n' },
			{ id: 'd', frontmatter: 'pinned: true\ncolor: blue\n' },
		];
		const { pinned, others } = scratchGroups(notes);
		expect(pinned.map((note) => note.id)).toEqual(['b', 'd']);
		expect(others.map((note) => note.id)).toEqual(['a', 'c']);
	});
});

describe('what a card shows', () => {
	const words = (count: number, from = 0) =>
		Array.from({ length: count }, (_, at) => `w${String(at + from)}`).join(' ');
	const plain = (text: string): PreviewLine => ({ depth: 0, runs: [{ text, marks: [] }] });
	const texts = (lines: readonly PreviewLine[]) => lines.map(previewLineText);

	it('is every line of a short note, each still a line', () => {
		expect(texts(cardLines([plain('Milk'), plain('Eggs and bread')]))).toEqual([
			'Milk',
			'Eggs and bread',
		]);
	});

	it(`is the first ${String(CARD_WORDS)} words of a long one, cut with "…"`, () => {
		const shown = cardLines([plain(words(40)), plain(words(40, 40))]);
		expect(texts(shown)).toEqual([words(40), `${words(CARD_WORDS - 40, 40)}…`]);
	});

	it('ends in "…" where whole lines are left out', () => {
		expect(texts(cardLines([plain(words(CARD_WORDS)), plain('more')]))).toEqual([
			`${words(CARD_WORDS)}…`,
		]);
	});

	it(`is no more than ${String(CARD_LINES)} lines`, () => {
		const lines = Array.from({ length: CARD_LINES + 3 }, (_, at) => plain(`line${String(at)}`));
		const shown = cardLines(lines);
		expect(shown).toHaveLength(CARD_LINES);
		expect(shown.at(-1)?.runs.at(-1)?.text).toBe(`line${String(CARD_LINES - 1)}…`);
	});

	it('is nothing for a note with nothing in it', () => {
		expect(cardLines([])).toEqual([]);
	});

	it('keeps how a line is set, cut inside its marks', () => {
		const item: PreviewLine = {
			depth: 1,
			marker: { kind: 'bullet' },
			runs: [
				{ text: 'one ', marks: [] },
				{ text: 'two three', marks: ['strong'] },
			],
		};
		const [, cut] = cardLines([plain(words(CARD_WORDS - 2)), item]);
		expect(cut).toEqual({
			depth: 1,
			marker: { kind: 'bullet' },
			runs: [
				{ text: 'one ', marks: [] },
				{ text: 'two…', marks: ['strong'] },
			],
		});
	});

	const picture = (alt: string): PreviewLine => ({
		depth: 0,
		runs: [{ text: alt, marks: [], embed: { kind: 'image', src: 'beach.jpg', alt } }],
	});

	it('keeps a picture with no words, and as much room for it as a picture takes', () => {
		const lines = [plain('Receipt'), picture(''), picture(''), plain('Paid')];
		const shown = cardLines(lines);
		// The second picture would be more than the card's lines.
		expect(1 + 2 * PICTURE_LINES).toBeGreaterThan(CARD_LINES);
		expect(shown).toHaveLength(2);
		expect(shown[1]?.runs).toEqual([...picture('').runs, { text: '…', marks: [] }]);
	});

	it('cuts a line at a picture or a chip only whole', () => {
		const chip: PreviewLine = {
			depth: 0,
			runs: [
				{ text: 'see ', marks: [] },
				{
					text: 'Q3 report',
					marks: [],
					embed: { kind: 'file', href: 'q3.pdf', name: 'Q3 report', fileName: 'q3.pdf' },
				},
				{ text: ' later', marks: [] },
			],
		};
		const [, cut] = cardLines([plain(words(CARD_WORDS - 2)), chip]);
		expect(cut?.runs).toEqual([chip.runs[0], chip.runs[1], { text: '…', marks: [] }]);
	});
});
