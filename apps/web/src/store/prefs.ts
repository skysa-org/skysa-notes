import { type CodeDisplay, DEFAULT_CODE_DISPLAY } from '../editor/codeDisplay.js';
import { DEFAULT_EDITOR_MODE, type EditorMode, isEditorMode } from '../editor/mode.js';
import { type NotesDatabase } from './db.js';

/**
 * App settings. Small enough that a key/value table is the whole story; every
 * read returns a usable default so a fresh install needs no seeding.
 */

export const DEFAULT_EDITOR_MODE_KEY = 'defaultEditorMode';

export const getPreference = async (db: NotesDatabase, key: string): Promise<string | undefined> =>
	(await db.prefs.get(key))?.value;

export const setPreference = async (
	db: NotesDatabase,
	key: string,
	value: string
): Promise<void> => {
	await db.prefs.put({ key, value });
};

/** The mode a note opens in when it has no remembered mode of its own. */
export const getDefaultEditorMode = async (db: NotesDatabase): Promise<EditorMode> => {
	const stored = await getPreference(db, DEFAULT_EDITOR_MODE_KEY);
	return isEditorMode(stored) ? stored : DEFAULT_EDITOR_MODE;
};

export const setDefaultEditorMode = async (db: NotesDatabase, mode: EditorMode): Promise<void> => {
	await setPreference(db, DEFAULT_EDITOR_MODE_KEY, mode);
};

export const CODE_BLOCK_WRAP_KEY = 'codeBlockWrap';
export const CODE_BLOCK_LINE_NUMBERS_KEY = 'codeBlockLineNumbers';

/**
 * How code blocks are shown, for every note on this device.
 *
 * Two keys rather than one row of JSON, because they are two independent
 * answers and a half-written blob is a shape this table has no way to describe.
 * Anything that is not the string `true` is false, so a row from a future
 * version that means something else reads as the default rather than as an
 * error.
 */
export const getCodeDisplay = async (db: NotesDatabase): Promise<CodeDisplay> => {
	const [wrap, lineNumbers] = await Promise.all([
		getPreference(db, CODE_BLOCK_WRAP_KEY),
		getPreference(db, CODE_BLOCK_LINE_NUMBERS_KEY),
	]);

	return {
		wrap: wrap === undefined ? DEFAULT_CODE_DISPLAY.wrap : wrap === 'true',
		lineNumbers:
			lineNumbers === undefined ? DEFAULT_CODE_DISPLAY.lineNumbers : lineNumbers === 'true',
	};
};

export const setCodeDisplay = async (db: NotesDatabase, display: CodeDisplay): Promise<void> => {
	await Promise.all([
		setPreference(db, CODE_BLOCK_WRAP_KEY, String(display.wrap)),
		setPreference(db, CODE_BLOCK_LINE_NUMBERS_KEY, String(display.lineNumbers)),
	]);
};
