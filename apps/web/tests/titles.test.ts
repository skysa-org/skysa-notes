import { deriveTitle, UNTITLED_TITLE } from '@skysa/core';
import { describe, expect, it, vi } from 'vitest';

import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { nameShown, titleShown, wordsShown } from '../src/store/titles.js';

// Another language's words, to tell what is shown from what is kept.
vi.mock('../src/i18n/t.js', () => ({ t: (key: string) => `«${key}»` }));

describe('titleShown', () => {
	it('shows a note with nothing to take a name from in the app’s words', () => {
		expect(titleShown(deriveTitle({ body: '' }))).toBe('«notes.untitled»');
		expect(titleShown(UNTITLED_TITLE)).toBe('«notes.untitled»');
	});

	it('shows any other title as it is, a filename’s too', () => {
		expect(titleShown('Q3 plan')).toBe('Q3 plan');
		expect(titleShown(deriveTitle({ filename: 'untitled.md' }))).toBe('untitled');
	});
});

/** A note as the store keeps one: begun with no name unless told otherwise. */
const note = (fields: Partial<NoteRecord>): NoteRecord => ({
	id: 'n1',
	connectionId: LOCAL_CONNECTION_ID,
	path: 'Work/untitled.md',
	title: UNTITLED_TITLE,
	body: '',
	frontmatter: null,
	tags: [],
	contentHash: '',
	dirty: 0,
	deletedLocally: 0,
	createdAt: 0,
	updatedAt: 0,
	...fields,
});

describe('nameShown', () => {
	it('names a note with no name by its first line, as the note shows it', () => {
		expect(nameShown(note({ body: '**Buy** milk\n\nand eggs\n' }))).toBe('Buy milk');
		expect(nameShown(note({ body: '- [ ] Call the bank\n' }))).toBe('Call the bank');
	});

	it('cuts a long first line after its last whole word', () => {
		const body = 'Remember to ask about the quarterly forecast before Friday\n';
		expect(nameShown(note({ body }))).toBe('Remember to ask about the quarterly…');
	});

	it('keeps a line that ends where the cut is whole, and cuts one long word where it reaches', () => {
		const exactly = 'Remember to ask about the quarterly fore';
		expect(nameShown(note({ body: `${exactly} cast\n` }))).toBe(`${exactly}…`);
		const address = `https://example.com/${'a'.repeat(60)}`;
		expect(nameShown(note({ body: `${address}\n` }))).toBe(`${address.slice(0, 40)}…`);
	});

	it('never cuts through an emoji', () => {
		const body = `${'a'.repeat(39)}👩‍👩‍👧 and more\n`;
		expect(nameShown(note({ body }))).toBe(`${'a'.repeat(39)}👩‍👩‍👧…`);
	});

	it('is “Untitled” for a note with no words', () => {
		expect(nameShown(note({ body: '' }))).toBe('«notes.untitled»');
		expect(nameShown(note({ body: '![](photo.png)\n' }))).toBe('«notes.untitled»');
		expect(wordsShown(note({ body: '' }))).toBeUndefined();
	});

	it('is the title of a note with a name', () => {
		expect(nameShown(note({ path: 'Work/q3.md', title: 'Q3', body: 'Q3\n\nPlan\n' }))).toBe(
			'Q3'
		);
		expect(
			nameShown(
				note({
					frontmatter: 'title: Plan\n',
					title: 'Plan',
					body: 'Some words\n',
				})
			)
		).toBe('Plan');
	});

	it('names a note another device made with no name by its words too', () => {
		// Read back from its file: the title is the filename's, not `UNTITLED_TITLE`.
		expect(nameShown(note({ title: 'untitled', body: 'Pick up the parcel\n' }))).toBe(
			'Pick up the parcel'
		);
		expect(
			nameShown(
				note({
					path: '.scratchpad/untitled-2.md',
					title: 'untitled 2',
					body: 'Pick up the parcel\n',
				})
			)
		).toBe('Pick up the parcel');
	});

	it('keeps `untitled-2.md` a name in a notebook, where it may be another tool’s file', () => {
		expect(
			nameShown(note({ path: 'Work/untitled-2.md', title: 'untitled 2', body: 'Words\n' }))
		).toBe('untitled 2');
	});
});
