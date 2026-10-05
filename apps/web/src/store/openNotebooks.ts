import { isWithin, rebasePath } from '@skysa/core';
import { z } from 'zod';

import { type NotesDatabase } from './db.js';

/**
 * Which notebooks are open in the sidebar, per source, on this device: the
 * ones whose notebooks inside them are listed. Every other notebook with
 * notebooks inside it is shut, so a library of hundreds of notebooks nested
 * three deep opens as the short list of its top level (docs/ARCHITECTURE.md
 * §7, "The sidebar opens as far as it is asked").
 *
 * Open rather than shut is what is kept, so a notebook nobody has opened is
 * shut wherever it came from: made on another device, pulled, imported.
 *
 * In `prefs`, as `store/lastOpen.ts` is and for its reasons: how far one
 * device has the tree open is that device's, and each source is its own
 * notebooks. Kept by path, and so moved with the notebook when it is renamed
 * or moved (`moveFolder`) and let go of when it is deleted (`deleteFolder`),
 * each in the transaction that changes the paths.
 */

/**
 * How many notebooks a source keeps open. Oldest opened first out: a device
 * that has opened thousands over the years keeps a row nobody notices, and
 * what it lets go of is shut, which is where a notebook starts anyway.
 */
const LIMIT = 500;

const stored = z.array(z.string());

const keyFor = (connectionId: string): string => `openNotebooks:${connectionId}`;

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

export const getOpenNotebooks = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string
): Promise<string[]> => read((await db.prefs.get(keyFor(connectionId)))?.value);

const write = (db: Pick<NotesDatabase, 'prefs'>, connectionId: string, paths: readonly string[]) =>
	db.prefs.put({ key: keyFor(connectionId), value: JSON.stringify(paths.slice(-LIMIT)) });

/**
 * Open or shut `paths`. Read and written in one transaction, so two tabs
 * opening notebooks at once each keep the other's.
 */
export const setNotebooksOpen = (
	db: NotesDatabase,
	connectionId: string,
	paths: readonly string[],
	open: boolean
): Promise<void> =>
	db.transaction('rw', db.prefs, async () => {
		const asked = new Set(paths);
		const others = (await getOpenNotebooks(db, connectionId)).filter(
			(path) => !asked.has(path)
		);
		// Put back at the end, so a notebook opened again is the newest in the
		// order the limit drops from.
		await write(db, connectionId, open ? [...others, ...asked] : others);
	});

/**
 * A notebook has moved from `from` to `to`, and with it every notebook inside
 * it: those that were open are open where they are now. Asked inside the
 * transaction that moves it, which holds `prefs`.
 */
export const moveOpenNotebooks = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string,
	from: string,
	to: string
): Promise<void> => {
	const open = await getOpenNotebooks(db, connectionId);
	if (!open.some((path) => isWithin(path, from))) return;
	await write(
		db,
		connectionId,
		open.map((path) => (isWithin(path, from) ? rebasePath(path, from, to) : path))
	);
};

/**
 * A notebook is gone, and every notebook inside it: none of them is open, so a
 * notebook made later at one of those paths starts shut, as a new one does.
 * Asked inside the transaction that deletes it.
 */
export const forgetOpenNotebooks = async (
	db: Pick<NotesDatabase, 'prefs'>,
	connectionId: string,
	gone: string
): Promise<void> => {
	const open = await getOpenNotebooks(db, connectionId);
	if (!open.some((path) => isWithin(path, gone))) return;
	await write(
		db,
		connectionId,
		open.filter((path) => !isWithin(path, gone))
	);
};
