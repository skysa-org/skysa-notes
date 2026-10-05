import { isWithin, rebasePath } from '@skysa/core';
import { z } from 'zod';

import { type NotesDatabase } from './db.js';

/**
 * Some of a source's notebooks, by path, as this device keeps them in `prefs`:
 * the ones open in the sidebar (`openNotebooks.ts`) and the ones pinned to the
 * top of their level (`pins.ts`). How one device has its tree is that device's,
 * and each source is its own notebooks, so one row per source and none synced.
 *
 * Kept by path, and so moved with the notebook when it is renamed or moved and
 * let go of when it is deleted, each in the transaction that changes the
 * paths: here (`moveFolder`, `deleteFolder`) and by a pull (`sync/store.ts`).
 * Oldest added first out past `limit`: a device that has added thousands over
 * the years keeps a row nobody notices.
 */
export interface NotebookPaths {
	readonly get: (db: Pick<NotesDatabase, 'prefs'>, connectionId: string) => Promise<string[]>;
	/**
	 * Add or take away `paths`. Read and written in one transaction, so two tabs
	 * changing it at once each keep the other's.
	 */
	readonly set: (
		db: NotesDatabase,
		connectionId: string,
		paths: readonly string[],
		on: boolean
	) => Promise<void>;
	/**
	 * A notebook has moved from `from` to `to`, and with it every notebook inside
	 * it. Asked inside the transaction that moves it, which holds `prefs`.
	 */
	readonly move: (
		db: Pick<NotesDatabase, 'prefs'>,
		connectionId: string,
		from: string,
		to: string
	) => Promise<void>;
	/**
	 * A notebook is gone, and every notebook inside it, so one made later at one
	 * of those paths starts as a new one does. Asked inside the transaction that
	 * deletes it.
	 */
	readonly forget: (
		db: Pick<NotesDatabase, 'prefs'>,
		connectionId: string,
		gone: string
	) => Promise<void>;
}

const stored = z.array(z.string());

/** Whatever is in the row: one the app cannot read is none, as `lastOpen` has it. */
const read = (value: string | undefined): string[] => {
	if (value === undefined) return [];
	try {
		const parsed = stored.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
};

export const notebookPaths = (name: string, limit: number): NotebookPaths => {
	const keyFor = (connectionId: string): string => `${name}:${connectionId}`;

	const get = async (db: Pick<NotesDatabase, 'prefs'>, connectionId: string) =>
		read((await db.prefs.get(keyFor(connectionId)))?.value);

	const write = (
		db: Pick<NotesDatabase, 'prefs'>,
		connectionId: string,
		paths: readonly string[]
	) => db.prefs.put({ key: keyFor(connectionId), value: JSON.stringify(paths.slice(-limit)) });

	return {
		get,
		set: (db, connectionId, paths, on) =>
			db.transaction('rw', db.prefs, async () => {
				const asked = new Set(paths);
				const others = (await get(db, connectionId)).filter((path) => !asked.has(path));
				// Put back at the end, so one added again is the newest in the
				// order the limit drops from.
				await write(db, connectionId, on ? [...others, ...asked] : others);
			}),
		move: async (db, connectionId, from, to) => {
			const kept = await get(db, connectionId);
			if (!kept.some((path) => isWithin(path, from))) return;
			// Once each: a path already kept at `to` is one the move lands on.
			await write(db, connectionId, [
				...new Set(
					kept.map((path) => (isWithin(path, from) ? rebasePath(path, from, to) : path))
				),
			]);
		},
		forget: async (db, connectionId, gone) => {
			const kept = await get(db, connectionId);
			if (!kept.some((path) => isWithin(path, gone))) return;
			await write(
				db,
				connectionId,
				kept.filter((path) => !isWithin(path, gone))
			);
		},
	};
};
