import { beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { getDefaultEditorMode, getPreference, setDefaultEditorMode } from '../src/store/prefs.js';

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
});
