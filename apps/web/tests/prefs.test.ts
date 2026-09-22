import { beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import {
	getCodeDisplay,
	getDefaultEditorMode,
	getPreference,
	setCodeDisplay,
	setDefaultEditorMode,
} from '../src/store/prefs.js';

let db: NotesDatabase;

beforeEach(async () => {
	db = createDatabase(`prefs-${crypto.randomUUID()}`);
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
