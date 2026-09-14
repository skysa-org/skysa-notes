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
