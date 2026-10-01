import { isWithin, parentPath, ROOT } from '@skysa/core';
import { z } from 'zod';

import { type NotesDatabase } from './db.js';
import { getNote, listNotes } from './notes.js';

/**
 * Where the user was, per source, on this device: the notebook open last, and
 * the note open last in each notebook. What the app opens when nothing more
 * specific asks — the URL names nothing, a source has just been shown, a
 * notebook has just been clicked — falling back to the first notebook and the
 * first note only when what is remembered has gone or nothing is yet.
 *
 * In `prefs`, so it never leaves the device: two devices reading the same notes
 * are two people's places, or one person's in two places, and neither is the
 * other's to move. Per source, because each source is its own notebooks and its
 * own notes (§6) — a path or an id remembered in one names nothing in another.
 */

export interface LastOpen {
	/** The notebook open last, as a path. `ROOT` is the loose notes. */
	readonly folder?: string;
	/** The note open last in each notebook, by the notebook's path. */
	readonly notes: Readonly<Record<string, string>>;
}

const NOTHING: LastOpen = { notes: {} };

/**
 * How many notebooks a source remembers a note for. Oldest first out, so a
 * device that has opened thousands of notebooks over the years keeps one row of
 * a size nobody notices rather than one that grows for ever.
 */
const LIMIT = 200;

const stored = z.object({
	folder: z.string().optional(),
	notes: z.record(z.string(), z.string()),
});

const keyFor = (connectionId: string): string => `lastOpen:${connectionId}`;

/**
 * A row is read whatever is in it. One written by a later version, or
 * hand-edited in devtools, is a place the app cannot use — and so the same as
 * none, rather than an error on the way into the app.
 */
const read = (value: string | undefined): LastOpen => {
	if (value === undefined) return NOTHING;
	try {
		const parsed = stored.safeParse(JSON.parse(value));
		if (!parsed.success) return NOTHING;
		const { folder, notes } = parsed.data;
		return folder === undefined ? { notes } : { folder, notes };
	} catch {
		return NOTHING;
	}
};

export const getLastOpen = async (db: NotesDatabase, connectionId: string): Promise<LastOpen> =>
	read((await db.prefs.get(keyFor(connectionId)))?.value);

/**
 * Remember `folder` as the notebook open in this source, and `noteId`, when
 * given, as the note open in it. Read and written in one transaction, so two
 * tabs remembering at once each keep the other's notebooks.
 */
export const rememberOpen = (
	db: NotesDatabase,
	connectionId: string,
	folder: string,
	noteId?: string
): Promise<void> =>
	db.transaction('rw', db.prefs, async () => {
		const before = await getLastOpen(db, connectionId);
		// Taken out and put back, so the notebook is the newest in the order the
		// limit drops from.
		const { [folder]: _was, ...others } = before.notes;
		const notes = noteId === undefined ? before.notes : { ...others, [folder]: noteId };
		const kept = Object.entries(notes).slice(-LIMIT);
		await db.prefs.put({
			key: keyFor(connectionId),
			value: JSON.stringify({ folder, notes: Object.fromEntries(kept) }),
		});
	});

/**
 * Whether a note belongs to a notebook as far as which note to open is
 * concerned: in it, or in a notebook inside it, at any depth. The loose notes
 * are not a notebook — their row lists what sits loose at the root, and a note
 * in any notebook is under the root without being one of those.
 */
export const noteIsUnder = (notePath: string, folder: string): boolean =>
	folder === ROOT ? parentPath(notePath) === ROOT : isWithin(notePath, folder);

export interface PickNoteInput {
	connectionId: string;
	/** The notebook showing. */
	folderPath: string;
	/** The note the URL names, if it names one. */
	open: string | undefined;
	/** The note remembered for this notebook, if there is one. */
	remembered: string | undefined;
}

/**
 * Which note should be open, or `null` for none: the notebook holds nothing.
 *
 * The note the URL names, for as long as it is there to show — wherever it is,
 * since the user put it there. Otherwise the one open last in this notebook,
 * if it is still there and still in it. Otherwise the notebook's first.
 */
export const pickNote = async (
	db: NotesDatabase,
	{ connectionId, folderPath, open, remembered }: PickNoteInput
): Promise<string | null> => {
	const live = async (id: string | undefined) => {
		if (id === undefined) return undefined;
		const note = await getNote(db, id, { connectionId });
		return note?.deletedLocally === 0 ? note : undefined;
	};

	if ((await live(open)) !== undefined) return open ?? null;
	const last = await live(remembered);
	if (last !== undefined && noteIsUnder(last.path, folderPath)) return last.id;
	const [first] = await listNotes(db, { connectionId, folderPath });
	return first?.id ?? null;
};
