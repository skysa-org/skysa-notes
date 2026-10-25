import { beforeEach, describe, expect, it } from 'vitest';

import { type NotesDatabase } from '../src/store/db.js';
import {
	getCodeDisplay,
	getDefaultEditorMode,
	getPreference,
	setCodeDisplay,
	setDefaultEditorMode,
	setPreference,
} from '../src/store/prefs.js';
import { GENERATOR_DEFAULT, getGeneratorOptions, setGeneratorOptions } from '../src/store/vault.js';
import { freshDatabase } from './support/db.js';

let db: NotesDatabase;

beforeEach(async () => {
	db = freshDatabase();
	await db.open();
});

describe('preferences', () => {
	it('has a usable default before anything is stored', async () => {
		expect(await getDefaultEditorMode(db)).toBe('rich');
		expect(await getPreference(db, 'nothing')).toBeUndefined();
	});

	it('remembers the mode the user chose', async () => {
		await setDefaultEditorMode(db, 'raw');
		expect(await getDefaultEditorMode(db)).toBe('raw');
	});

	it('falls back rather than trusting a value it does not recognise', async () => {
		await db.prefs.put({ key: 'defaultEditorMode', value: 'vim' });
		expect(await getDefaultEditorMode(db)).toBe('rich');
	});

	/**
	 * Wrapping and line numbers are the device's, not the note's: markdown has
	 * nowhere to write either, so they are read back here or they are lost on
	 * every reload.
	 */
	it('shows code blocks plainly until it is told otherwise', async () => {
		expect(await getCodeDisplay(db)).toEqual({ wrap: false, lineNumbers: false });
	});

	it('remembers how the user left code blocks', async () => {
		await setCodeDisplay(db, { wrap: true, lineNumbers: true });
		expect(await getCodeDisplay(db)).toEqual({ wrap: true, lineNumbers: true });

		await setCodeDisplay(db, { wrap: false, lineNumbers: true });
		expect(await getCodeDisplay(db)).toEqual({ wrap: false, lineNumbers: true });
	});

	/** Two keys, so a row written by some later version reads as "off". */
	it('reads anything but "true" as off', async () => {
		await db.prefs.put({ key: 'codeBlockWrap', value: 'sometimes' });
		expect((await getCodeDisplay(db)).wrap).toBe(false);
	});
});

describe('how a password is made', () => {
	it('is twenty characters with symbols until chosen, then as chosen, kept in bounds', async () => {
		expect(await getGeneratorOptions(db)).toEqual(GENERATOR_DEFAULT);
		expect(GENERATOR_DEFAULT).toEqual({ length: 20, symbols: true });

		await setGeneratorOptions(db, { length: 12, symbols: false });
		expect(await getGeneratorOptions(db)).toEqual({ length: 12, symbols: false });

		await setGeneratorOptions(db, { length: 500, symbols: true });
		expect(await getGeneratorOptions(db)).toEqual({ length: 64, symbols: true });
	});

	it('falls back rather than trusting what it cannot read', async () => {
		for (const junk of ['not json', '[]', '{"length":"12","symbols":true}', '{"length":12}']) {
			await setPreference(db, 'passwordGenerator', junk);
			expect(await getGeneratorOptions(db)).toEqual(GENERATOR_DEFAULT);
		}
		await setPreference(db, 'passwordGenerator', '{"length":3,"symbols":false}');
		expect(await getGeneratorOptions(db)).toEqual({ length: 8, symbols: false });
	});
});
