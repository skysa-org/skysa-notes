import { type z } from 'zod';

import { type CodeDisplay, DEFAULT_CODE_DISPLAY } from '../editor/codeDisplay.js';
import { DEFAULT_EDITOR_MODE, type EditorMode, isEditorMode } from '../editor/mode.js';
import { type NotesDatabase } from './db.js';

/**
 * App settings. Small enough that a key/value table is the whole story; every
 * read returns a usable default so a fresh install needs no seeding.
 */

/**
 * A row of JSON, read whatever is in it. One written by a later version, or
 * hand-edited in devtools, is a value the app cannot use, and so the same as
 * none (`undefined`) rather than an error on the way into the app.
 */
export const readJson = <T>(value: string | undefined, schema: z.ZodType<T>): T | undefined => {
	if (value === undefined) return undefined;
	try {
		const parsed = schema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Every pref kept for each source, by name. `sourceKey` takes nothing else, so
 * a pref added for a source is added here, and forgetting the source
 * (`forgetSourcePrefs`) or resuming it under a new id (`carrySourcePrefs`)
 * cannot miss it (#452).
 */
export const PREF_KEYS = [
	'lastOpen',
	'openNotebooks',
	'passwords',
	'pinnedNotebooks',
	'bottomPinnedNotebooks',
	'pinnedNotes',
	'scratchpad',
] as const;

export type SourcePref = (typeof PREF_KEYS)[number];

/** The key of a pref kept for each source: `<name>:<connectionId>`. */
export const sourceKey = (name: SourcePref, connectionId: string): string =>
	`${name}:${connectionId}`;

/**
 * A source forgotten on this device: what it remembered of it goes too. Prefs
 * an earlier release left behind for a source it forgot are left alone, since
 * nothing here can tell one of those from a source this device has not loaded.
 */
export const forgetSourcePrefs = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<void> => {
	await db.prefs.bulkDelete(PREF_KEYS.map((name) => sourceKey(name, connectionId)));
};

/**
 * Detached sources resumed under `connectionId`: the user is back at the same
 * library, so what this device remembered of it comes too, pins and all. The
 * first of `from` to hold a pref gives it, unless `connectionId` holds that
 * pref already; the old ids' rows go either way, as `carryKeys` does with a
 * key.
 */
export const carrySourcePrefs = async (
	db: Pick<NotesDatabase, 'prefs'>,
	from: readonly string[],
	connectionId: string
): Promise<void> => {
	if (from.length === 0) return;
	await Promise.all(
		PREF_KEYS.map(async (name) => {
			const key = sourceKey(name, connectionId);
			const held = await db.prefs.bulkGet(from.map((id) => sourceKey(name, id)));
			const carried = held.find((row) => row !== undefined);
			if (carried !== undefined && (await db.prefs.get(key)) === undefined) {
				await db.prefs.put({ key, value: carried.value });
			}
		})
	);
	await db.prefs.bulkDelete(from.flatMap((id) => PREF_KEYS.map((name) => sourceKey(name, id))));
};

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

export const FORMAT_TOOLBAR_KEY = 'formatToolbarShown';

/**
 * Whether a compact window shows the formatting toolbar under the note, on
 * this device, as the `Format` button last left it. Hidden unless it was
 * shown: it costs a row of a short screen, and the inline toolbar and the
 * slash menu are there without it.
 */
export const getFormatToolbarShown = async (db: NotesDatabase): Promise<boolean> =>
	(await getPreference(db, FORMAT_TOOLBAR_KEY)) === 'true';

export const setFormatToolbarShown = async (db: NotesDatabase, shown: boolean): Promise<void> => {
	await setPreference(db, FORMAT_TOOLBAR_KEY, String(shown));
};

export const INSTALL_DISMISSED_KEY = 'installDismissed';

/**
 * Whether the banner offering to install the app has been dismissed on this
 * device (`install/InstallBanner.tsx`). Once is for good: it is not shown again
 * here. Kept as when, which nothing reads yet.
 */
export const getInstallDismissed = async (db: NotesDatabase): Promise<boolean> =>
	(await getPreference(db, INSTALL_DISMISSED_KEY)) !== undefined;

export const dismissInstall = (db: NotesDatabase, now: Date = new Date()): Promise<void> =>
	setPreference(db, INSTALL_DISMISSED_KEY, now.toISOString());

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
