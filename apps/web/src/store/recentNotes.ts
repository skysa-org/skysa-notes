import { isScratchPath, isVaultPath } from '@skysa/core';
import { z } from 'zod';

import { type NoteKey, type NoteRecord, noteRef, type NotesDatabase } from './db.js';
import { readJson } from './prefs.js';
import { isLive } from './rowStates.js';

/**
 * The notes opened lately on this device, newest first: what the search field
 * offers before anything is typed in it (`SearchField`), so that going back to
 * a note read a minute ago is a press on the field and one on its name.
 *
 * One list for every source, as search is one question across all of them,
 * and a note in it named by its source and its id together, which is what an
 * id names a note by. Notes only: a scratch card or a password item opened is
 * not one of them (the owner's choice, 2026-10-15) — a card is glanced at more
 * than opened, and a password's label in a list shown on every press on the
 * field is said more often than one a search was typed for.
 *
 * In `prefs`, so it never leaves the device, as where the user was does not
 * (`store/lastOpen.ts`). Ids only — no title, no path — so a note renamed or
 * moved keeps its place in it, and nothing of what the notes say is copied.
 */

/** How many the field lists. */
export const RECENT_SHOWN = 8;

/**
 * How many are kept: more than are listed, so that a few deleted, or the one
 * on screen left out, still leave the list full.
 */
export const RECENT_KEPT = 20;

const KEY = 'recentNotes';

const stored = z.array(z.tuple([z.string(), z.string()]));

/**
 * A row is read whatever is in it. One written by a later version, or
 * hand-edited in devtools, is a list the app cannot use, and so the same as
 * none, rather than an error in the search field.
 */
const read = (value: string | undefined): NoteKey[] => readJson(value, stored) ?? [];

/** The notes opened lately, as keys, newest first. */
export const getRecentKeys = async (db: NotesDatabase): Promise<NoteKey[]> =>
	read((await db.prefs.get(KEY))?.value);

/**
 * Put a note at the head of the list, taking it out of wherever it was. Read
 * and written in one transaction, so two tabs opening notes at once each keep
 * the other's; and not written at all where it is at the head already, which
 * is what reopening the app on the note it was left on asks.
 */
export const rememberRecent = async (
	db: NotesDatabase,
	connectionId: string,
	noteId: string
): Promise<void> => {
	const opened: NoteKey = [connectionId, noteId];
	await db.transaction('rw', db.prefs, async () => {
		const row = await db.prefs.get(KEY);
		const before = read(row?.value);
		const after = [
			opened,
			...before.filter(([source, id]) => source !== connectionId || id !== noteId),
		].slice(0, RECENT_KEPT);
		const value = JSON.stringify(after);
		if (value === row?.value) return;
		await db.prefs.put({ key: KEY, value });
	});
};

/**
 * Rewrite the list, and not at all where nothing changes: inside the caller's
 * transaction, which is the one forgetting or binding the source. `change` is
 * handed the keys newest first and returns them in the same order.
 *
 * Dexie's own promise, not an `async` function's, as `forgetClips` in
 * `store/connection.ts` says why: a native layer more between the transaction
 * and this write is one Dexie does not follow, and it commits early.
 */
const rewrite = (
	db: Pick<NotesDatabase, 'prefs'>,
	change: (keys: readonly NoteKey[]) => NoteKey[]
): Promise<unknown> =>
	db.prefs.get(KEY).then((row) => {
		const value = JSON.stringify(change(read(row?.value)));
		const same = row === undefined ? value === '[]' : value === row.value;
		return same ? undefined : db.prefs.put({ key: KEY, value });
	});

/** A source forgotten: its notes leave the list (`store/sourcePrefs.ts`). */
export const forgetRecentOf = (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<unknown> => rewrite(db, (keys) => keys.filter(([source]) => source !== connectionId));

/**
 * Sources resumed under `connectionId`: their notes keep their places in the
 * list, under the id they are under now. Where that names a note twice, the
 * newer place is the one kept.
 */
export const carryRecent = (
	db: Pick<NotesDatabase, 'prefs'>,
	from: readonly string[],
	connectionId: string
): Promise<unknown> =>
	rewrite(db, (keys) => {
		const moved = keys.map(([source, id]): NoteKey => [
			from.includes(source) ? connectionId : source,
			id,
		]);
		return moved.filter(
			([source, id], at) =>
				moved.findIndex(([other, otherId]) => other === source && otherId === id) === at
		);
	});

/**
 * The notes to list, newest first: those still on the device and not deleted,
 * notes and not cards or password items, and not `skip` — the note on screen,
 * as a `noteRef`, which there is no going back to. At most `RECENT_SHOWN`.
 */
export const listRecentNotes = async (db: NotesDatabase, skip?: string): Promise<NoteRecord[]> => {
	const keys = await getRecentKeys(db);
	const notes = await db.notes.bulkGet(keys);
	return notes
		.filter(
			(note): note is NoteRecord =>
				note !== undefined &&
				isLive(note) &&
				!isScratchPath(note.path) &&
				!isVaultPath(note.path) &&
				noteRef(note) !== skip
		)
		.slice(0, RECENT_SHOWN);
};
