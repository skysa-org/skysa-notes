import { isWithin } from '@skysa/core';
import { z } from 'zod';

import { type NotesDatabase } from './db.js';
import { type NotebookPaths, notebookPaths } from './notebookPaths.js';
import { isLive } from './rowStates.js';

/**
 * Notebooks and notes pinned to the top of their list, per source, on this
 * device (docs/ARCHITECTURE.md §7, "Pinned to the top"). A pinned notebook
 * comes first among the notebooks beside it, under its own parent, or last
 * where it is pinned to the bottom; a pinned note first in its notebook's
 * list. Neither is synced: a provider has nowhere to keep it but the note
 * itself, and the markdown is the note.
 */

/**
 * How many of each a source keeps pinned. A list long enough that nobody
 * pinning by hand reaches it, and a row that stays small if they do.
 */
const LIMIT = 500;

/** Which end of the notebooks beside it a notebook is pinned to. */
export type NotebookPin = 'top' | 'bottom';

/**
 * Notebooks, by path, as open notebooks are kept (`notebookPaths`): moved with
 * a notebook renamed or moved, and let go of with one deleted. One list for
 * each end, the bottom's in a row of its own (2026-10-14), so a version from
 * before it reads the top's as it always did, and sees the rest unpinned.
 */
const notebooks = {
	top: notebookPaths('pinnedNotebooks', LIMIT),
	bottom: notebookPaths('bottomPinnedNotebooks', LIMIT),
} as const satisfies Record<NotebookPin, NotebookPaths>;

export const getPinnedNotebooks = notebooks.top.get;

export const getBottomPinnedNotebooks = notebooks.bottom.get;

/**
 * Pin a notebook to the top or the bottom, or unpin it (`undefined`), letting
 * go of any pinned notebook that is no longer there. Pinned to one end, it is
 * no longer pinned to the other. A notebook with a row is let go of when it is
 * deleted; one there only because something is in it goes when the last thing
 * leaves, with nothing to say so, and a notebook made later at its path would
 * come up pinned. There as the tree has it (`buildFolderTree`): a row, a row
 * inside it, or a live note.
 */
export const setNotebookPin = (
	db: NotesDatabase,
	connectionId: string,
	path: string,
	pin: NotebookPin | undefined
): Promise<void> =>
	db.transaction('rw', [db.prefs, db.folders, db.notes], async () => {
		const [folders, notes, top, bottom] = await Promise.all([
			db.folders.where('connectionId').equals(connectionId).toArray(),
			db.notes.where('connectionId').equals(connectionId).toArray(),
			notebooks.top.get(db, connectionId),
			notebooks.bottom.get(db, connectionId),
		]);
		const inside = [
			...folders.map((folder) => folder.path),
			...notes.filter(isLive).map((note) => note.path),
		];
		const there = (each: string) => inside.some((held) => isWithin(held, each));
		// This one, wherever it was pinned, and every one no longer there.
		const lettingGo = (kept: readonly string[]) =>
			kept.filter((each) => each === path || !there(each));
		await notebooks.top.set(db, connectionId, lettingGo(top), false);
		await notebooks.bottom.set(db, connectionId, lettingGo(bottom), false);
		if (pin !== undefined) await notebooks[pin].set(db, connectionId, [path], true);
	});

/** A notebook moved: its pin, at either end, and those inside it, go with it. */
export const movePinnedNotebooks = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string,
	from: string,
	to: string
): Promise<void> => {
	await notebooks.top.move(db, connectionId, from, to);
	await notebooks.bottom.move(db, connectionId, from, to);
};

/** A notebook deleted: its pin, at either end, and those inside it, go. */
export const forgetPinnedNotebooks = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string,
	gone: string
): Promise<void> => {
	await notebooks.top.forget(db, connectionId, gone);
	await notebooks.bottom.forget(db, connectionId, gone);
};

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
	/** Notebooks pinned to the top. */
	readonly notebooks: ReadonlySet<string>;
	/** Notebooks pinned to the bottom. */
	readonly bottomNotebooks: ReadonlySet<string>;
	readonly notes: ReadonlySet<string>;
}

const keyShape = z.tuple([z.array(z.string()), z.array(z.string()), z.array(z.string())]);

/**
 * Pins as a string, the same for the same pins: what a live query hands back,
 * so a run that finds the pins as they were gives nothing new to re-render, or
 * to ask `pickNote` again with. A sync run re-runs a query that reads the
 * source with every cursor it writes.
 */
export const pinsKey = (pins: Pins): string =>
	JSON.stringify([[...pins.notebooks], [...pins.bottomNotebooks], [...pins.notes]]);

export const pinsFromKey = (key: string): Pins => {
	const [top, bottom, ids] = keyShape.parse(JSON.parse(key));
	return { notebooks: new Set(top), bottomNotebooks: new Set(bottom), notes: new Set(ids) };
};

export const getPins = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<Pins> => {
	const [top, bottom, ids] = await Promise.all([
		getPinnedNotebooks(db, connectionId),
		getBottomPinnedNotebooks(db, connectionId),
		getPinnedNotes(db, connectionId),
	]);
	return { notebooks: new Set(top), bottomNotebooks: new Set(bottom), notes: new Set(ids) };
};

/**
 * The pinned first, then the rest, each in the order it came in: pinning moves
 * a row above the others without changing how the list is otherwise sorted.
 */
export const pinnedFirst = <T>(items: readonly T[], pinned: (item: T) => boolean): T[] => [
	...items.filter(pinned),
	...items.filter((item) => !pinned(item)),
];

/**
 * Those pinned to the top first, then the rest, then those pinned to the
 * bottom, each in the order it came in, as `pinnedFirst` has it.
 */
export const pinnedToEnds = <T>(
	items: readonly T[],
	pinOf: (item: T) => NotebookPin | undefined
): T[] => [
	...items.filter((item) => pinOf(item) === 'top'),
	...items.filter((item) => pinOf(item) === undefined),
	...items.filter((item) => pinOf(item) === 'bottom'),
];
