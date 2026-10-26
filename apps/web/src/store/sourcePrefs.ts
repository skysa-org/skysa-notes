import { z } from 'zod';

import { type NotesDatabase } from './db.js';
import { mergeLastOpen } from './lastOpen.js';
import { OPEN_KEPT } from './openNotebooks.js';
import { PINS_KEPT } from './pins.js';
import { PREF_KEYS, readJson, sourceKey, type SourcePref } from './prefs.js';
import { carryRecent, forgetRecentOf } from './recentNotes.js';

/**
 * What this device remembers of a source, kept with the source's notes
 * wherever they go (#452): the prefs kept by source (`PREF_KEYS`), and the
 * one list kept for every source that names them, the recent notes.
 *
 * - **Held for the account** when the source leaves the device
 *   (`holdSourcePrefs`), under a key no connection takes (`heldFor`), and
 *   given back when the account is connected again, under whatever id it has
 *   then. A source whose account nobody named has nothing to be given back
 *   to, and is forgotten. Its recent notes are not held: they leave with it.
 * - **Carried** with rows that go into another source for good: a detached
 *   source of the account resumed under a new id, and the device's own notes
 *   going into a source (`carrySourcePrefs`). Not with notes moved into another
 *   account's source (`moveUnsyncedTo`): those are some of a source's notes,
 *   and its pins name notebooks of its own, which the other account's of the
 *   same name are not.
 *
 * Merged, where they meet what that source remembers already (`MERGES`). Prefs
 * an earlier release left behind for a source it forgot are left alone:
 * nothing here can tell those rows from a source this device has not loaded.
 *
 * Every write here is Dexie's own promise, not an `async` function's, for the
 * reason `forgetClips` in `store/connection.ts` gives: they run inside a
 * transaction a layer or two down, and each native layer between it and a
 * write is one more than Dexie follows it through.
 */

/** Where an account's prefs wait while none of its sources is on the device. */
export const heldFor = (account: string): string => `account:${account}`;

/**
 * How prefs carried meet the one that comes first (`mergeInto`), which is the
 * newest: a list of paths or ids is both, the first's last, as the newest in
 * the order its limit drops from; the place open last keeps the first's
 * notebook and takes the others' notes (`mergeLastOpen`); a setting is the
 * first's, or the first carried. Named for every pref, so a new one has to say.
 */
type Merge = (own: string | undefined, carried: readonly string[]) => string | undefined;

const list = z.array(z.string());

const both =
	(limit: number): Merge =>
	(own, carried) => {
		const theirs = carried.flatMap((value) => readJson(value, list) ?? []);
		if (theirs.length === 0) return own;
		const all = [...theirs, ...(readJson(own, list) ?? [])];
		return JSON.stringify(all.filter((item, at) => all.lastIndexOf(item) === at).slice(-limit));
	};

const ownFirst: Merge = (own, carried) => own ?? carried[0];

const MERGES: Readonly<Record<SourcePref, Merge>> = {
	lastOpen: mergeLastOpen,
	openNotebooks: both(OPEN_KEPT),
	passwords: ownFirst,
	pinnedNotebooks: both(PINS_KEPT),
	bottomPinnedNotebooks: both(PINS_KEPT),
	pinnedNotes: both(PINS_KEPT),
	scratchpad: ownFirst,
};

type Ends = Readonly<Record<'pinnedNotebooks' | 'bottomPinnedNotebooks', string | undefined>>;

/**
 * A notebook is pinned to one end, as `setNotebookPin` keeps it. One pinned to
 * the top under one id and to the bottom under another goes to the end the
 * first of them has it at, in `mergeInto`'s order; the other list lets it go.
 */
const oneEnd = (
	merged: Ends,
	ids: readonly string[],
	value: (name: SourcePref, id: string) => string | undefined
): Ends => {
	const placed = ids.flatMap((id) => [
		...(readJson(value('pinnedNotebooks', id), list) ?? []).map(
			(path) => [path, 'top'] as const
		),
		...(readJson(value('bottomPinnedNotebooks', id), list) ?? []).map(
			(path) => [path, 'bottom'] as const
		),
	]);
	// Reversed, so the first to place a notebook is the one the map keeps.
	const end = new Map([...placed].reverse());
	const at = (raw: string | undefined, wanted: 'top' | 'bottom') => {
		const paths = readJson(raw, list);
		return paths === undefined
			? raw
			: JSON.stringify(paths.filter((path) => end.get(path) === wanted));
	};
	return {
		pinnedNotebooks: at(merged.pinnedNotebooks, 'top'),
		bottomPinnedNotebooks: at(merged.bottomPinnedNotebooks, 'bottom'),
	};
};

/**
 * Merge the prefs of `from` into `connectionId`'s: read in one go and written
 * in one. `connectionId`'s own come first, unless `theirsFirst`, where what is
 * carried is the newer. `from`'s rows go, unless they are to be `kept`, and
 * nothing is written where nothing changes.
 */
const mergeInto = (
	db: Pick<NotesDatabase, 'prefs'>,
	from: readonly string[],
	connectionId: string,
	{ kept = false, theirsFirst = false }: { kept?: boolean; theirsFirst?: boolean } = {}
): Promise<unknown> => {
	const ids = theirsFirst ? [...from, connectionId] : [connectionId, ...from];
	const keys = PREF_KEYS.flatMap((name) => ids.map((id) => sourceKey(name, id)));
	return db.prefs.bulkGet(keys).then((rows) => {
		const stored = new Map(keys.map((key, at) => [key, rows[at]?.value]));
		const value = (name: SourcePref, id: string) => stored.get(sourceKey(name, id));
		const merged = Object.fromEntries(
			PREF_KEYS.map((name) => {
				const [first, ...rest] = ids.map((id) => value(name, id));
				const carried = rest.flatMap((each) => each ?? []);
				return [name, carried.length === 0 ? first : MERGES[name](first, carried)];
			})
		) as Record<SourcePref, string | undefined>;
		const after = { ...merged, ...oneEnd(merged, ids, value) };
		const changed = PREF_KEYS.flatMap((name) => {
			const now = after[name];
			return now === undefined || now === value(name, connectionId)
				? []
				: [{ key: sourceKey(name, connectionId), value: now }];
		});
		const gone = kept
			? []
			: from.flatMap((id) =>
					PREF_KEYS.flatMap((name) =>
						value(name, id) === undefined ? [] : [sourceKey(name, id)]
					)
				);
		return (changed.length === 0 ? Promise.resolve() : db.prefs.bulkPut(changed)).then(() =>
			gone.length === 0 ? undefined : db.prefs.bulkDelete(gone)
		);
	});
};

/** A source and its account forgotten on this device: what it remembered goes too. */
const forgetSourcePrefs = (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<unknown> =>
	db.prefs
		.bulkDelete(PREF_KEYS.map((name) => sourceKey(name, connectionId)))
		.then(() => forgetRecentOf(db, connectionId));

/**
 * A source leaving the device: what it remembered waits for its `account`
 * (`accountKey`), merged into what that account holds already as the newer of
 * the two, and is given back to it on the next bind. Forgotten where no
 * account was named.
 */
export const holdSourcePrefs = (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string,
	account: string | undefined
): Promise<unknown> =>
	account === undefined
		? forgetSourcePrefs(db, connectionId)
		: mergeInto(db, [connectionId], heldFor(account), { theirsFirst: true }).then(() =>
				forgetRecentOf(db, connectionId)
			);

/**
 * Rows of `from` gone into `connectionId` for good: a source resumed, the
 * account's held prefs (`heldFor`), the device's own notes. What each
 * remembered goes with them, recent notes included, and `from`'s rows go.
 */
export const carrySourcePrefs = (
	db: Pick<NotesDatabase, 'prefs'>,
	from: readonly string[],
	connectionId: string
): Promise<unknown> =>
	from.length === 0
		? Promise.resolve()
		: mergeInto(db, from, connectionId).then(() => carryRecent(db, from, connectionId));
