import { z } from 'zod';

import { type NotesDatabase } from './db.js';
import { mergeLastOpen } from './lastOpen.js';
import { PREF_KEYS, readJson, sourceKey, type SourcePref } from './prefs.js';
import { carryRecent, forgetRecentOf } from './recentNotes.js';

/**
 * What this device remembers of a source, kept with the source (#452): let go
 * of when the source is forgotten here, and carried to it when a detached
 * source of the same account is resumed under a new id, since the user is
 * back at the same library. The prefs kept by source (`PREF_KEYS`), and the
 * one list kept for every source that names them, the recent notes.
 *
 * Prefs an earlier release left behind for a source it forgot are left alone:
 * nothing here can tell those rows from a source this device has not loaded.
 */

/**
 * How a pref carried home meets the one the source holds already, its own
 * first: a list of paths or ids is both, its own last, as the newest in the
 * order a limit drops from; the place open last keeps its own notebook and
 * takes the others' notes (`mergeLastOpen`); a setting is its own, or the
 * first carried. Named for every pref, so a new one has to say.
 */
type Merge = (own: string | undefined, carried: readonly string[]) => string | undefined;

const list = z.array(z.string());

const both: Merge = (own, carried) => {
	const lists = carried.flatMap((value) => readJson(value, list) ?? []);
	if (lists.length === 0) return own;
	const all = [...lists.flat(), ...(readJson(own, list) ?? [])];
	return JSON.stringify(all.filter((item, at) => all.lastIndexOf(item) === at));
};

const ownFirst: Merge = (own, carried) => own ?? carried[0];

const MERGES: Readonly<Record<SourcePref, Merge>> = {
	lastOpen: mergeLastOpen,
	openNotebooks: both,
	passwords: ownFirst,
	pinnedNotebooks: both,
	bottomPinnedNotebooks: both,
	pinnedNotes: both,
	scratchpad: ownFirst,
};

/**
 * A source forgotten on this device: what it remembered of it goes too.
 *
 * This and `carrySourcePrefs` are Dexie's own promises, not `async`
 * functions', for the reason `forgetClips` in `store/connection.ts` gives:
 * they run inside a transaction, a layer or two down, and each native layer
 * between it and a write is one more than Dexie follows it through.
 */
export const forgetSourcePrefs = (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<unknown> =>
	db.prefs
		.bulkDelete(PREF_KEYS.map((name) => sourceKey(name, connectionId)))
		.then(() => forgetRecentOf(db, connectionId));

/**
 * Detached sources resumed under `connectionId`: what this device remembered
 * of each goes with its rows, merged into what `connectionId` remembers
 * already (`MERGES`), and the old ids' rows go. Read in one go and written in
 * one, inside the bind's transaction.
 */
export const carrySourcePrefs = (
	db: Pick<NotesDatabase, 'prefs'>,
	from: readonly string[],
	connectionId: string
): Promise<unknown> => {
	const ids = [connectionId, ...from];
	const keys = PREF_KEYS.flatMap((name) => ids.map((id) => sourceKey(name, id)));
	return db.prefs
		.bulkGet(keys)
		.then((rows) => {
			const value = new Map(keys.map((key, at) => [key, rows[at]?.value]));
			const merged = PREF_KEYS.flatMap((name) => {
				const key = sourceKey(name, connectionId);
				const own = value.get(key);
				const carried = from.flatMap((id) => value.get(sourceKey(name, id)) ?? []);
				const after = carried.length === 0 ? own : MERGES[name](own, carried);
				return after === undefined || after === own ? [] : [{ key, value: after }];
			});
			return db.prefs.bulkPut(merged);
		})
		.then(() =>
			db.prefs.bulkDelete(from.flatMap((id) => PREF_KEYS.map((name) => sourceKey(name, id))))
		)
		.then(() => carryRecent(db, from, connectionId));
};
