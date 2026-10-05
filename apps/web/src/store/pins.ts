import { isWithin } from '@skysa/core';
import { z } from 'zod';

import { type NotesDatabase } from './db.js';
import { notebookPaths } from './notebookPaths.js';

/**
 * Notebooks and notes pinned to the top of their list, per source, on this
 * device (docs/ARCHITECTURE.md §7, "Pinned to the top"). A pinned notebook
 * comes first among the notebooks beside it, under its own parent; a pinned
 * note first in its notebook's list. Neither is synced: a provider has
 * nowhere to keep it but the note itself, and the markdown is the note.
 */

/**
 * How many of each a source keeps pinned. A list long enough that nobody
 * pinning by hand reaches it, and a row that stays small if they do.
 */
const LIMIT = 500;

/**
 * Notebooks, by path, as open notebooks are kept (`notebookPaths`): moved with
 * a notebook renamed or moved, and let go of with one deleted.
 */
const notebooks = notebookPaths('pinnedNotebooks', LIMIT);

export const getPinnedNotebooks = notebooks.get;

/**
 * Pin or unpin a notebook, letting go of any pinned notebook that is no longer
 * there. A notebook with a row is let go of when it is deleted; one there only
 * because something is in it goes when the last thing leaves, with nothing to
 * say so, and a notebook made later at its path would come up pinned. There as
 * the tree has it (`buildFolderTree`): a row, a row inside it, or a live note.
 */
export const setNotebookPinned = (
	db: NotesDatabase,
	connectionId: string,
	path: string,
	pinned: boolean
): Promise<void> =>
	db.transaction('rw', [db.prefs, db.folders, db.notes], async () => {
		const [folders, notes, kept] = await Promise.all([
			db.folders.where('connectionId').equals(connectionId).toArray(),
			db.notes.where('connectionId').equals(connectionId).toArray(),
			notebooks.get(db, connectionId),
		]);
		const inside = [
			...folders.map((folder) => folder.path),
			...notes.filter((note) => note.deletedLocally === 0).map((note) => note.path),
		];
		const there = (each: string) => inside.some((held) => isWithin(held, each));
		await notebooks.set(
			db,
			connectionId,
			kept.filter((each) => each !== path && !there(each)),
			false
		);
		await notebooks.set(db, connectionId, [path], pinned);
	});

export const movePinnedNotebooks = notebooks.move;

export const forgetPinnedNotebooks = notebooks.forget;

/**
 * Notes, by id, which a note keeps through a rename and a move, so nothing has
 * to follow it. A note that is gone is let go of the next time a note's pin
 * changes, rather than in every place a note can go from: one deleted here and
 * taken back keeps its pin.
 */
const NOTES = 'pinnedNotes';

const notesKey = (connectionId: string): string => `${NOTES}:${connectionId}`;

const stored = z.array(z.string());

const read = (value: string | undefined): string[] => {
	if (value === undefined) return [];
	try {
		const parsed = stored.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
};

export const getPinnedNotes = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<string[]> => read((await db.prefs.get(notesKey(connectionId)))?.value);

/** Pin or unpin a note, letting go of any pinned note there is no row for. */
export const setNotePinned = (
	db: NotesDatabase,
	connectionId: string,
	id: string,
	pinned: boolean
): Promise<void> =>
	db.transaction('rw', db.prefs, db.notes, async () => {
		const others = (await getPinnedNotes(db, connectionId)).filter((each) => each !== id);
		const rows = await db.notes.bulkGet(
			others.map((each): [string, string] => [connectionId, each])
		);
		const kept = others.filter((_, at) => rows[at] !== undefined);
		await db.prefs.put({
			key: notesKey(connectionId),
			value: JSON.stringify([...kept, ...(pinned ? [id] : [])].slice(-LIMIT)),
		});
	});

/** What a source has pinned, as a list shows it. */
export interface Pins {
	readonly notebooks: ReadonlySet<string>;
	readonly notes: ReadonlySet<string>;
}

const keyShape = z.tuple([z.array(z.string()), z.array(z.string())]);

/**
 * Pins as a string, the same for the same pins: what a live query hands back,
 * so a run that finds the pins as they were gives nothing new to re-render, or
 * to ask `pickNote` again with. A sync run re-runs a query that reads the
 * source with every cursor it writes.
 */
export const pinsKey = (pins: Pins): string =>
	JSON.stringify([[...pins.notebooks], [...pins.notes]]);

export const pinsFromKey = (key: string): Pins => {
	const [paths, ids] = keyShape.parse(JSON.parse(key));
	return { notebooks: new Set(paths), notes: new Set(ids) };
};

export const getPins = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<Pins> => {
	const [paths, ids] = await Promise.all([
		getPinnedNotebooks(db, connectionId),
		getPinnedNotes(db, connectionId),
	]);
	return { notebooks: new Set(paths), notes: new Set(ids) };
};

/**
 * The pinned first, then the rest, each in the order it came in: pinning moves
 * a row above the others without changing how the list is otherwise sorted.
 */
export const pinnedFirst = <T>(items: readonly T[], pinned: (item: T) => boolean): T[] => [
	...items.filter(pinned),
	...items.filter((item) => !pinned(item)),
];
