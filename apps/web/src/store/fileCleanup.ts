import { db as appDb, type NotesDatabase } from './db.js';
import { deleteUnlinkedFilesAt } from './fileLinks.js';

/**
 * A file taken out of a note is deleted a little after the note is left, if no
 * note in the source links it by then (2026-10-04).
 *
 * After, not as the link goes: while the note is open the user can undo, and
 * an undo that brought back a link to a file already gone would bring back a
 * missing picture. The editor's history goes with the editor, so once the note
 * is left nothing can bring the link back but typing it again. A few minutes
 * more, and for a source with a remote not before a pull has reached the end
 * since, so that a link another device has added is here to be found: offline,
 * or with sync failing, the files are asked about again a few minutes later,
 * for up to an hour. Opened again before then, the note's files wait for it
 * to be left again.
 *
 * Only the files the note linked when it was opened and the ones put in it
 * while it was, less those it still names, and only after an edit
 * (`useFileCleanup`): a file nobody took out of a note is never looked at,
 * whatever links it. The store
 * asks again of every note in the source before it deletes anything, and
 * deletes nothing where the device may not hold every note
 * (`deleteUnlinkedFilesAt`). A provider puts what it deletes in its trash.
 *
 * Held in memory: a tab closed before the time is up deletes nothing, and the
 * notebook's Attached files still lists what it left.
 */

/** How long after a note is left that the files taken out of it are looked at. */
export const FILE_CLEANUP_DELAY_MS = 3 * 60 * 1000;

/** How many times they are looked at while it is too soon to tell: an hour, at the delay. */
const TRIES = 20;

export interface FileCleanup {
	/** The note `ref` was opened: what waits for it waits for it to be left. */
	readonly opened: (ref: string) => void;
	/**
	 * The note `ref` was left. `paths` — the files, in `connectionId`, that it
	 * may no longer link — are looked at once the delay is up, with any still
	 * waiting for it from an earlier visit.
	 */
	readonly left: (ref: string, connectionId: string, paths: readonly string[]) => void;
	/** Look at everything waiting now. Answers the paths deleted. */
	readonly flush: () => Promise<string[]>;
}

export interface FileCleanupOptions {
	db?: NotesDatabase;
	delay?: number;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	now?: () => number;
}

interface Waiting {
	connectionId: string;
	paths: ReadonlySet<string>;
	/** When the note was last left: a pull has to reach the end after it. */
	leftAt: number;
	tries: number;
	timer?: unknown;
}

export const createFileCleanup = ({
	db = appDb,
	delay = FILE_CLEANUP_DELAY_MS,
	setTimer = (run, ms) => setTimeout(run, ms),
	clearTimer = (timer) => {
		clearTimeout(timer as ReturnType<typeof setTimeout>);
	},
	now = Date.now,
}: FileCleanupOptions = {}): FileCleanup => {
	const waiting = new Map<string, Waiting>();
	// The notes open now, which nothing is looked at for.
	const open = new Set<string>();

	const wait = (ref: string, due: Omit<Waiting, 'timer'>): void => {
		waiting.set(
			ref,
			open.has(ref) ? due : { ...due, timer: setTimer(() => void run(ref), delay) }
		);
	};

	const run = async (ref: string): Promise<string[]> => {
		const due = waiting.get(ref);
		if (due === undefined) return [];
		waiting.delete(ref);
		if (due.timer !== undefined) clearTimer(due.timer);
		try {
			const paths = [...due.paths];
			const deleted = await deleteUnlinkedFilesAt(db, due.connectionId, paths, due.leftAt);
			if (deleted !== undefined) return deleted;
			// Too soon to tell. Left again meanwhile, the note's own visit has
			// put them back, with more.
			if (due.tries + 1 < TRIES && !waiting.has(ref)) {
				const { timer: _gone, ...kept } = due;
				wait(ref, { ...kept, tries: due.tries + 1 });
			}
			return [];
		} catch {
			// Nothing is lost by not deleting: the notebook still lists the file.
			return [];
		}
	};

	return {
		opened: (ref) => {
			open.add(ref);
			const due = waiting.get(ref);
			if (due?.timer === undefined) return;
			clearTimer(due.timer);
			const { timer: _gone, ...kept } = due;
			waiting.set(ref, kept);
		},
		left: (ref, connectionId, paths) => {
			open.delete(ref);
			const due = waiting.get(ref);
			const all = new Set([...(due?.paths ?? []), ...paths]);
			if (due?.timer !== undefined) clearTimer(due.timer);
			if (all.size === 0) {
				waiting.delete(ref);
				return;
			}
			wait(ref, { connectionId, paths: all, leftAt: now(), tries: 0 });
		},
		flush: async () => (await Promise.all([...waiting.keys()].map(run))).flat(),
	};
};

/** The app's one. */
export const fileCleanup = createFileCleanup();
