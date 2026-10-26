import { isVaultPath, isWithin, parentPath, ROOT } from '@skysa/core';
import { z } from 'zod';

import { type NotesDatabase } from './db.js';
import { createEmitter } from './emitter.js';
import { getNote, listNotes } from './notes.js';
import { readJson, sourceKey } from './prefs.js';
import { isLive } from './rowStates.js';
import { type FolderNode, listedUnder } from './tree.js';

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

const keyFor = (connectionId: string): string => sourceKey('lastOpen', connectionId);

/**
 * A row is read whatever is in it. One written by a later version, or
 * hand-edited in devtools, is a place the app cannot use — and so the same as
 * none, rather than an error on the way into the app.
 */
const read = (value: string | undefined): LastOpen => {
	const parsed = readJson(value, stored);
	if (parsed === undefined) return NOTHING;
	const { folder, notes } = parsed;
	return folder === undefined ? { notes } : { folder, notes };
};

export const getLastOpen = async (db: NotesDatabase, connectionId: string): Promise<LastOpen> =>
	read((await db.prefs.get(keyFor(connectionId)))?.value);

/**
 * A source's place, with the places of the sources it is taking in (a source
 * resumed under a new id, `store/sourcePrefs.ts`): its own notebook open last
 * where it has one, and the note open last in each notebook from all of them,
 * its own where two name one notebook. Its own value, as it was, where nothing
 * carried can be read.
 */
export const mergeLastOpen = (
	own: string | undefined,
	carried: readonly string[]
): string | undefined => {
	const places = carried.flatMap((value) => readJson(value, stored) ?? []);
	if (places.length === 0) return own;
	const mine = readJson(own, stored);
	// Theirs first and its own last, so its own are the newest in the order
	// the limit drops from, and win where two name one notebook.
	const entries = [...places, ...(mine === undefined ? [] : [mine])].flatMap((place) =>
		Object.entries(place.notes)
	);
	const notes = entries.filter(
		([folder], at) => entries.findLastIndex(([other]) => other === folder) === at
	);
	const folder = mine?.folder ?? places.find((place) => place.folder !== undefined)?.folder;
	return JSON.stringify({
		...(folder === undefined ? {} : { folder }),
		notes: Object.fromEntries(notes.slice(-LIMIT)),
	});
};

/**
 * What this tab has written, ahead of the store's answer. A live query's
 * answer follows a write by a read, and by another for each write that lands
 * while it reads, since Dexie starts it over; and a click makes a write or
 * two. So under load the store's answer can be clicks behind, and a notebook
 * clicked meanwhile opened on what it said before — the newest note — which
 * was then remembered over the note the user had left open there (#283).
 * `useLastOpen` hands out what was written until the store has been read
 * since it landed. A new object each write, so one can be told from the next.
 */
const written = new WeakMap<NotesDatabase, ReadonlyMap<string, LastOpen>>();
const writes = createEmitter();

/** What this tab wrote last for a source, once it has landed. */
export const lastWritten = (db: NotesDatabase, connectionId: string): LastOpen | undefined =>
	written.get(db)?.get(connectionId);

/** Be told each time one of this tab's writes lands. */
export const onWritten = writes.subscribe;

/**
 * Remember `folder` as the notebook open in this source, and `noteId`, when
 * given, as the note open in it. Read and written in one transaction, so two
 * tabs remembering at once each keep the other's notebooks.
 *
 * A write that would change nothing is not made: asked of the row as it
 * stands in that transaction, after every write this tab asked for before and
 * every other tab's that has landed. Asked of a live answer instead, which can
 * be a write behind, a tab that moved and straight back would be taken to be
 * where the memory says, and its first move would land after it.
 */
export const rememberOpen = async (
	db: NotesDatabase,
	connectionId: string,
	folder: string,
	noteId?: string
): Promise<void> => {
	const lastOpen = await db.transaction('rw', db.prefs, async () => {
		const row = await db.prefs.get(keyFor(connectionId));
		const before = read(row?.value);
		// Taken out and put back, so the notebook is the newest in the order the
		// limit drops from.
		const { [folder]: _was, ...others } = before.notes;
		const notes = noteId === undefined ? before.notes : { ...others, [folder]: noteId };
		const kept = Object.entries(notes).slice(-LIMIT);
		const after: LastOpen = { folder, notes: Object.fromEntries(kept) };
		const value = JSON.stringify(after);
		if (value === row?.value) return undefined;
		await db.prefs.put({ key: keyFor(connectionId), value });
		return after;
	});
	if (lastOpen === undefined) return;
	written.set(db, new Map(written.get(db)).set(connectionId, lastOpen));
	writes.emit();
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
	/**
	 * The source's notebooks, the pinned first at each level (`withPins`), in
	 * whose order the notes of the notebooks inside this one are listed. Handed
	 * in for the reason `pinned` is.
	 */
	tree?: readonly FolderNode[] | undefined;
}

/**
 * Which note should be open, or `null` for none: the notebook holds nothing,
 * nor does any notebook inside it.
 *
 * The note the URL names, for as long as it is there to show — wherever it is,
 * since the user put it there; but never a password, which opens only in the
 * passwords' own place (docs/ARCHITECTURE.md §7, "Passwords in the vault"),
 * not in the note editor, its fence and all. Otherwise the one open last in this notebook,
 * if it is still there and still in it. Otherwise the notebook's first, as its
 * list has it (`listedUnder`): its own notes before those of the notebooks
 * inside it, and a pinned notebook or note before the rest (`store/pins.ts`).
 * A notebook that holds only notebooks opens on the first note the user sees
 * listed under it, not a new one beside them.
 */
export const pickNote = async (
	db: NotesDatabase,
	{ connectionId, folderPath, open, remembered, pinned, tree }: PickNoteInput
): Promise<string | null> => {
	const live = async (id: string | undefined) => {
		if (id === undefined) return undefined;
		const note = await getNote(db, id, { connectionId });
		return isLive(note) ? note : undefined;
	};

	const named = await live(open);
	if (named !== undefined && !isVaultPath(named.path)) return named.id;
	const last = await live(remembered);
	if (last !== undefined && noteIsUnder(last.path, folderPath)) return last.id;
	// The same read as the notebook's own notes alone: `listNotes` reads every
	// note in the source and filters.
	const notes = (await listNotes(db, { connectionId })).filter((note) =>
		noteIsUnder(note.path, folderPath)
	);
	const [first] = listedUnder(notes, folderPath, tree, (note) => pinned?.has(note.id) === true);
	return first?.id ?? null;
};
