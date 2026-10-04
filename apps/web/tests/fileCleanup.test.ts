import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type NotesDatabase, type SyncStateRecord } from '../src/store/db.js';
import { createFileCleanup } from '../src/store/fileCleanup.js';
import { deleteUnlinkedFilesAt } from '../src/store/fileLinks.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';

/**
 * A file taken out of a note, deleted a little after the note is left if no
 * note links it then (`store/fileCleanup.ts`), and only where the device holds
 * every note in the source (`deleteUnlinkedFilesAt`).
 */

const CONNECTION = 'dropbox-1';
const REF = 'note-1';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`file-cleanup-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const file = (db: NotesDatabase, id: string, path: string, connectionId = CONNECTION) =>
	db.files.put({ connectionId, id, path, size: 10, remoteId: `r-${id}` });

/** When the note is left, by the cleanup's clock; a pull has reached the end after. */
const LEFT_AT = 1000;

const pulled = (overrides: Partial<SyncStateRecord> = {}): SyncStateRecord => ({
	connectionId: CONNECTION,
	clientId: 'client',
	cursor: 'c1',
	lastSyncAt: LEFT_AT + 1,
	...overrides,
});

/** Timers run by hand. */
const clock = () => {
	const timers = new Map<number, { run: () => void; ms: number }>();
	const ids = { next: 0 };
	return {
		now: () => LEFT_AT,
		setTimer: (run: () => void, ms: number) => {
			ids.next += 1;
			timers.set(ids.next, { run, ms });
			return ids.next;
		},
		clearTimer: (timer: unknown) => {
			timers.delete(timer as number);
		},
		pending: () => [...timers.values()].map((timer) => timer.ms),
		/** Run every timer due, and let what they started settle. */
		elapse: async () => {
			const due = [...timers.entries()];
			timers.clear();
			due.forEach(([, timer]) => {
				timer.run();
			});
			// The delete is a transaction; give it time to land.
			await new Promise((resolve) => setTimeout(resolve, 50));
		},
	};
};

const paths = async (db: NotesDatabase) => (await db.files.toArray()).map((row) => row.path);

describe('the files taken out of a note', () => {
	it('are deleted once the note has been left a while, if nothing links them', async () => {
		const db = freshDatabase();
		await db.syncState.put(pulled());
		await file(db, 'a', 'Work/a.png');
		await file(db, 'b', 'Work/b.png');
		await createNote(db, {
			connectionId: CONNECTION,
			folderPath: 'Work',
			title: 'Other',
			body: '![b](b.png)\n',
		});
		const timers = clock();
		const cleanup = createFileCleanup({ db, delay: 180_000, ...timers });

		cleanup.left(REF, CONNECTION, ['Work/a.png', 'Work/b.png']);

		expect(timers.pending()).toEqual([180_000]);
		expect(await paths(db)).toHaveLength(2);
		await timers.elapse();
		expect(await paths(db)).toEqual(['Work/b.png']);
	});

	it('wait while the note is open again, and are looked at once it is left again', async () => {
		const db = freshDatabase();
		await db.syncState.put(pulled());
		await file(db, 'a', 'Work/a.png');
		const timers = clock();
		const cleanup = createFileCleanup({ db, ...timers });
		cleanup.left(REF, CONNECTION, ['Work/a.png']);

		cleanup.opened(REF);

		expect(timers.pending()).toEqual([]);
		await timers.elapse();
		expect(await paths(db)).toEqual(['Work/a.png']);

		// Left again with nothing new: what was waiting still is.
		cleanup.left(REF, CONNECTION, []);
		expect(timers.pending()).toHaveLength(1);
		await timers.elapse();
		expect(await paths(db)).toEqual([]);
	});

	it('are kept when the note links them again before the time is up', async () => {
		const db = freshDatabase();
		await db.syncState.put(pulled());
		await file(db, 'a', 'Work/a.png');
		const note = await createNote(db, {
			connectionId: CONNECTION,
			folderPath: 'Work',
			title: 'Plan',
			body: 'Text.\n',
		});
		const timers = clock();
		const cleanup = createFileCleanup({ db, ...timers });
		cleanup.left(REF, CONNECTION, ['Work/a.png']);

		await saveNoteBody(db, note.id, '![a](A.png)\n', undefined, { connectionId: CONNECTION });
		await timers.elapse();

		expect(await paths(db)).toEqual(['Work/a.png']);
	});

	it('wait for nothing when a note is left with nothing taken out', () => {
		const timers = clock();
		const cleanup = createFileCleanup({ db: freshDatabase(), ...timers });

		cleanup.left(REF, CONNECTION, []);

		expect(timers.pending()).toEqual([]);
	});

	it('wait for a pull to reach the end after the note was left, asking again meanwhile', async () => {
		// Offline, or with sync failing, a link another device added since is
		// not here to be found.
		const db = freshDatabase();
		await db.syncState.put(pulled({ lastSyncAt: LEFT_AT - 1 }));
		await file(db, 'a', 'Work/a.png');
		const timers = clock();
		const cleanup = createFileCleanup({ db, ...timers });
		cleanup.left(REF, CONNECTION, ['Work/a.png']);

		await timers.elapse();

		expect(await paths(db)).toEqual(['Work/a.png']);
		expect(timers.pending()).toHaveLength(1);
		await db.syncState.put(pulled());
		await timers.elapse();
		expect(await paths(db)).toEqual([]);
	});

	it('are let be after an hour of it being too soon to tell', async () => {
		const db = freshDatabase();
		await db.syncState.put(pulled({ lastSyncAt: undefined }));
		await file(db, 'a', 'Work/a.png');
		const timers = clock();
		const cleanup = createFileCleanup({ db, ...timers });
		cleanup.left(REF, CONNECTION, ['Work/a.png']);

		await Array.from({ length: 20 }).reduce<Promise<void>>(async (before) => {
			await before;
			await timers.elapse();
		}, Promise.resolve());

		expect(timers.pending()).toEqual([]);
		expect(await paths(db)).toEqual(['Work/a.png']);
	});

	it('are not asked about again while the note is open', async () => {
		const db = freshDatabase();
		await db.syncState.put(pulled({ lastSyncAt: undefined }));
		await file(db, 'a', 'Work/a.png');
		const timers = clock();
		const cleanup = createFileCleanup({ db, ...timers });
		cleanup.left(REF, CONNECTION, ['Work/a.png']);

		// Opened again while the first look is under way.
		const looking = cleanup.flush();
		cleanup.opened(REF);
		await looking;

		expect(timers.pending()).toEqual([]);
		cleanup.left(REF, CONNECTION, []);
		expect(timers.pending()).toHaveLength(1);
	});

	it('are all looked at at once when flushed', async () => {
		const db = freshDatabase();
		await file(db, 'a', 'a.png', 'local');
		const cleanup = createFileCleanup({ db, ...clock() });
		cleanup.left(REF, 'local', ['a.png']);

		expect(await cleanup.flush()).toEqual(['a.png']);
	});
});

describe('deleting the files at some paths', () => {
	it('deletes in the device’s own library, which has no remote to hold more notes', async () => {
		const db = freshDatabase();
		await file(db, 'a', 'a.png', 'local');

		expect(await deleteUnlinkedFilesAt(db, 'local', ['A.PNG'], LEFT_AT)).toEqual(['a.png']);
	});

	it.each<[string, Partial<SyncStateRecord>]>([
		['never pulled to the end', { cursor: undefined }],
		['still importing', { importing: { lock: true, returnTo: 'local' } }],
		['resumed and not yet checked', { resumeUnverified: true }],
		['detached', { detached: { at: 1, reason: 'disconnected' } }],
	])(
		'is too soon to tell in a source %s, whose notes the device may not all hold',
		async (_why, state) => {
			const db = freshDatabase();
			await db.syncState.put(pulled(state));
			await file(db, 'a', 'Work/a.png');

			expect(
				await deleteUnlinkedFilesAt(db, CONNECTION, ['Work/a.png'], LEFT_AT)
			).toBeUndefined();
			expect(await paths(db)).toEqual(['Work/a.png']);
		}
	);
});
