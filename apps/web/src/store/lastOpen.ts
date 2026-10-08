import { isWithin, parentPath, ROOT } from '@skysa/core';
import { z } from 'zod';

import { type NotesDatabase } from './db.js';
import { getNote, listNotes } from './notes.js';
import { pinnedFirst } from './pins.js';

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
 * What this tab has written, ahead of the store's answer. A live query's
 * answer follows a write by a read, and by another for each write that lands
 * while it reads, since Dexie starts it over; and a click makes a write or
 * two. So under load the store's answer can be clicks behind, and a notebook
 * clicked meanwhile opened on what it said before — the newest note — which
 * was then remembered over the note the user had left open there (#283).
 * `useLastOpen` hands out what was written until the store has been read
 * since it landed.
 */
export interface Written {
	readonly lastOpen: LastOpen;
	/** Which of this tab's writes it was, counting from one. */
	readonly write: number;
}

interface Writes {
	readonly landed: number;
	readonly bySource: ReadonlyMap<string, Written>;
}

const writes = new WeakMap<NotesDatabase, Writes>();
const listeners = new Set<() => void>();

/** How many of this tab's writes have landed: a read begun now sees them all. */
export const writesLanded = (db: NotesDatabase): number => writes.get(db)?.landed ?? 0;

/** What this tab wrote last for a source, once it has landed. */
export const lastWritten = (db: NotesDatabase, connectionId: string): Written | undefined =>
	writes.get(db)?.bySource.get(connectionId);

/** Be told each time one of this tab's writes lands. */
export const onWritten = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/**
 * Remember `folder` as the notebook open in this source, and `noteId`, when
 * given, as the note open in it. Read and written in one transaction, so two
 * tabs remembering at once each keep the other's notebooks.
 */
export const rememberOpen = async (
	db: NotesDatabase,
	connectionId: string,
	folder: string,
	noteId?: string
): Promise<void> => {
	const lastOpen = await db.transaction('rw', db.prefs, async () => {
		const before = await getLastOpen(db, connectionId);
		// Taken out and put back, so the notebook is the newest in the order the
		// limit drops from.
		const { [folder]: _was, ...others } = before.notes;
		const notes = noteId === undefined ? before.notes : { ...others, [folder]: noteId };
		const kept = Object.entries(notes).slice(-LIMIT);
		const after: LastOpen = { folder, notes: Object.fromEntries(kept) };
		await db.prefs.put({ key: keyFor(connectionId), value: JSON.stringify(after) });
		return after;
	});
	const before = writes.get(db);
	const landed = (before?.landed ?? 0) + 1;
	const bySource = new Map(before?.bySource).set(connectionId, { lastOpen, write: landed });
	writes.set(db, { landed, bySource });
	listeners.forEach((listener) => {
		listener();
	});
};

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
	/**
	 * The source's pinned notes (`store/pins.ts`), which come first. Handed in
	 * rather than read here: one more read in this answer made it late enough,
	 * under load, to lose the race a notebook just moved has to win.
	 */
	pinned?: ReadonlySet<string> | undefined;
}

/**
 * Which note should be open, or `null` for none: the notebook holds nothing.
 *
 * The note the URL names, for as long as it is there to show — wherever it is,
 * since the user put it there. Otherwise the one open last in this notebook,
 * if it is still there and still in it. Otherwise the notebook's first, as its
 * list has it: a pinned note before the rest (`store/pins.ts`).
 */
export const pickNote = async (
	db: NotesDatabase,
	{ connectionId, folderPath, open, remembered, pinned }: PickNoteInput
): Promise<string | null> => {
	const live = async (id: string | undefined) => {
		if (id === undefined) return undefined;
		const note = await getNote(db, id, { connectionId });
		return note?.deletedLocally === 0 ? note : undefined;
	};

	if ((await live(open)) !== undefined) return open ?? null;
	const last = await live(remembered);
	if (last !== undefined && noteIsUnder(last.path, folderPath)) return last.id;
	const notes = await listNotes(db, { connectionId, folderPath });
	const [first] =
		pinned === undefined ? notes : pinnedFirst(notes, (note) => pinned.has(note.id));
	return first?.id ?? null;
};
