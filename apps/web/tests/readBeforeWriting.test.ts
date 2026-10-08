import type * as Core from '@skysa/core';
import type { PullChange, RemoteEntry } from '@skysa/core';
import Dexie, { type Transaction } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindConnection, finishImport } from '../src/store/connection.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { importLibrary, planImport } from '../src/store/importLibrary.js';
import { importNoteFile } from '../src/store/notes.js';
import { createDexieSyncStore } from '../src/sync/store.js';
import { noteById } from './noteRows.js';

/**
 * A note's file is read (`parseNoteFile`) before the transaction that writes
 * it opens, and once. A read is most of what a note costs to bring in, and a
 * transaction holds every other reader of the notes off until it is done: an
 * import of a few thousand notes, read in its transaction and in one piece,
 * held the page still for twelve seconds on a phone (#275).
 */

/** Each read, and whether a transaction was open when it was made. */
const reads = vi.hoisted(() => ({ made: [] as { inTransaction: boolean }[] }));

vi.mock('@skysa/core', async (importOriginal) => {
	const actual = await importOriginal<typeof Core>();
	return {
		...actual,
		parseNoteFile: (...args: Parameters<typeof actual.parseNoteFile>) => {
			// Typed as always there; it is null outside a transaction.
			const open = Dexie.currentTransaction as Transaction | null;
			reads.made.push({ inTransaction: open !== null });
			return actual.parseNoteFile(...args);
		},
	};
});

const CONNECTION = 'dropbox-1';

const opened: NotesDatabase[] = [];

beforeEach(() => {
	reads.made = [];
});

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`read-before-writing-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const remote = (path: string, id: string): RemoteEntry => ({
	remoteId: id,
	path,
	kind: 'file',
	version: 'v1',
	modifiedAt: '2026-01-01T00:00:00.000Z',
	size: 1,
});

const upsert = (id: string, path: string, content: string): PullChange => ({
	kind: 'upsert-note',
	id,
	path,
	content,
	remote: remote(path, `r-${id}`),
	syncedHash: '',
});

describe('a note’s file, brought in', () => {
	it('is read before a pull’s transaction opens, once for each note', async () => {
		const db = freshDatabase();
		await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
		const store = createDexieSyncStore(db, { connectionId: CONNECTION });
		await store.applyPull({ changes: [upsert('n1', 'Plan.md', '# Plan\n\nfirst\n')] });
		reads.made = [];

		await store.applyPull({
			changes: [
				// One already here, with a new body: asked whether it brings the
				// body the row has, which needs no read.
				upsert('n1', 'Plan.md', '# Plan\n\nsecond\n'),
				upsert('n2', 'Work/Minutes.md', '# Minutes\n'),
				upsert('n3', 'Work/untitled-thing.md', 'no heading\n'),
			],
			cursor: 'c1',
		});

		expect(reads.made).toEqual([
			{ inTransaction: false },
			{ inTransaction: false },
			{ inTransaction: false },
		]);
		expect((await noteById(db, 'n1'))?.body).toBe('# Plan\n\nsecond\n');
		expect((await noteById(db, 'n2'))?.title).toBe('Minutes');
		expect((await noteById(db, 'n3'))?.title).toBe('untitled thing');
	});

	it('is read before an import’s transaction opens, once for each note', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: CONNECTION, provider: 'dropbox' });
		await finishImport(db, CONNECTION);
		const plan = planImport({
			files: Object.entries({
				'Work/plan.md': '# Plan\n',
				'Work/minutes.md': '---\ntitle: "Minutes"\n---\n\nwords\n',
				'loose.md': 'no heading\n',
			}).map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text) })),
			folders: [],
			skipped: [],
		});
		reads.made = [];

		await importLibrary(db, CONNECTION, plan);

		expect(reads.made).toEqual([
			{ inTransaction: false },
			{ inTransaction: false },
			{ inTransaction: false },
		]);
		const titles = (await db.notes.toArray()).map((note) => note.title).sort();
		expect(titles).toEqual(['Minutes', 'Plan', 'loose']);
	});

	it('is read once when it is imported on its own', async () => {
		const db = freshDatabase();
		await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });

		await importNoteFile(db, {
			connectionId: CONNECTION,
			path: 'Plan.md',
			source: '# Plan\n',
		});

		expect(reads.made).toEqual([{ inTransaction: false }]);
	});
});
