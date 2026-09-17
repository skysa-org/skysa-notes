import {
	conflictContent,
	contentHash,
	createFakeProvider,
	createSyncEngine,
	type RemoteEntry,
} from '@skysa/core';
import { afterEach, describe, expect, it } from 'vitest';

// The suite lives beside the port it checks, in `packages/core`, and is not a
// `*.test.ts` there so that it runs only where a store registers it. `core`
// cannot import `apps/*`, so this store registers here instead.
import { describeSyncStoreContract } from '../../../packages/core/tests/sync/storeContract.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import {
	createNote,
	deleteNote,
	getNote,
	importNoteFile,
	listNotes,
	noteFile,
	noteFileContents,
	noteRecordFromFile,
	restoreNote,
	saveNoteBody,
} from '../src/store/notes.js';
import {
	createDexieSyncStore,
	type DexieSyncStoreOptions,
	UnboundConnectionError,
} from '../src/sync/store.js';

const CONNECTION = 'dropbox-1';

/**
 * A store for a connection the device is bound to — the only kind the app
 * makes, and the only kind that writes.
 */
const boundStore = async (db: NotesDatabase, options: DexieSyncStoreOptions) => {
	await db.syncState.put({ connectionId: options.connectionId, clientId: 'this-browser' });
	return createDexieSyncStore(db, options);
};

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

/** A database of its own for every test, so nothing leaks between them. */
const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`sync-store-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const remote = (path: string, id = 'r1', version = 'v1'): RemoteEntry => ({
	remoteId: id,
	path,
	kind: 'file',
	version,
	modifiedAt: '2026-01-01T00:00:00.000Z',
	size: 1,
});

describeSyncStoreContract('Dexie', async () => {
	const db = freshDatabase();
	const store = await boundStore(db, { connectionId: CONNECTION });
	return {
		store,
		seed: async (note) => {
			await db.notes.put({
				...noteRecordFromFile({
					id: note.id,
					connectionId: CONNECTION,
					path: note.path,
					source: note.content,
					hash: await contentHash(note.content),
					now: 0,
				}),
				...(note.remoteId === undefined ? {} : { remoteId: note.remoteId }),
				...(note.remoteVersion === undefined ? {} : { remoteVersion: note.remoteVersion }),
				...(note.syncedHash === undefined ? {} : { syncedHash: note.syncedHash }),
				dirty: note.dirty === true ? 1 : 0,
			});
		},
		seedFolder: async (folder) => {
			await db.folders.put({ connectionId: CONNECTION, createdAt: 0, ...folder });
		},
		seedOp: async (op) => {
			// In the app a queued delete always comes with its tombstone:
			// `deleteNote` makes the one and the push queue the other.
			if (op.op === 'delete' && op.noteId !== undefined) {
				await db.notes.update(op.noteId, { deletedLocally: 1, dirty: 1 });
			}
			return db.opQueue.add({ connectionId: CONNECTION, attempts: 0, queuedAt: 0, ...op });
		},
	};
});

describe('the Dexie sync store, beyond the contract', () => {
	it('hands the engine a pulled file byte for byte, not re-serialized', async () => {
		// A file another tool wrote has no frontmatter, and one this app wrote on
		// another device may spell a timestamp differently. Re-serializing either
		// gives the engine bytes the remote never had — a change nobody made.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const file = '---\nupdated: 2026-01-01T00:00:00Z\n---\n# Shopping\r\n\r\nmilk\r\n';

		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Shopping.md',
					content: file,
					remote: remote('Shopping.md'),
					syncedHash: 'hash',
				},
			],
		});

		expect((await store.noteById('n1'))?.content).toBe(file);
		const row = await getNote(db, 'n1');
		expect(row?.title).toBe('Shopping');
		expect(row?.body).toBe('# Shopping\r\n\r\nmilk\r\n');
		expect(row?.contentHash).toBe(await contentHash(file));
		expect(noteFileContents(row!)).not.toBe(file);
	});

	it('hands the engine what an edit here serialized to, not what was pulled', async () => {
		// The other half of the same field. A push that sent the pulled bytes
		// after the user edited would put the old note back on the remote.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.md',
					content: 'before\n',
					remote: remote('a.md'),
					syncedHash: 'hash',
				},
			],
		});

		const edited = await saveNoteBody(db, 'n1', 'after\n');

		const note = await store.noteById('n1');
		expect(note?.dirty).toBe(true);
		expect(note?.content).toBe(noteFileContents(edited));
		expect(note?.content).toContain('after\n');
	});

	it('answers for notes the app created before anything was pulled', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const created = await createNote(db, { connectionId: CONNECTION, body: 'hello\n' });

		expect((await store.noteById(created.id))?.content).toBe(noteFileContents(created));
	});

	it('finds the live note at a path a tombstone still holds', async () => {
		// The app lets a new note take a name a deleted one has not given up yet.
		// A file arriving at that path written into the tombstone is purged with
		// it by the queued delete — taking the file on the remote too.
		//
		// Both orders, because IndexedDB hands the two rows back in the order of
		// their ids, and a store that took the first one would pass with the
		// tombstone sorting second.
		for (const [goneId, liveId] of [
			['a-gone', 'b-live'],
			['b-gone', 'a-live'],
		] as const) {
			const db = freshDatabase();
			const store = await boundStore(db, { connectionId: CONNECTION });
			const row = (id: string) =>
				noteRecordFromFile({
					id,
					connectionId: CONNECTION,
					path: 'Plans.md',
					source: 'x\n',
					hash: '',
					now: 0,
				});
			await db.notes.bulkPut([
				{ ...row(goneId), remoteId: 'r1', deletedLocally: 1, dirty: 1 },
				row(liveId),
			]);

			expect((await store.noteByPath('Plans.md'))?.id).toBe(liveId);
		}
	});

	it('lets a note created here take the name of one deleted but not yet pushed', async () => {
		// Which is how the app comes to hold two rows at one path at all.
		const db = freshDatabase();
		const gone = await createNote(db, { connectionId: CONNECTION, title: 'Plans' });
		await deleteNote(db, gone.id);
		const live = await createNote(db, { connectionId: CONNECTION, title: 'Plans' });

		expect(live.path).toBe(gone.path);
	});

	it('keeps what a pull cannot know about a note it rewrites', async () => {
		// Which editor it was open in, when it was first seen here, and above all
		// that the user deleted it: §7 has the delete win, and the op behind it
		// purges the row the pull wrote back.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.md',
					content: 'x\n',
					remote: remote('a.md'),
					syncedHash: 'hash',
				},
			],
		});
		await db.notes.update('n1', { editorMode: 'raw', createdAt: 42, deletedLocally: 1 });

		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.md',
					content: 'y\n',
					remote: remote('a.md', 'r1', 'v2'),
					syncedHash: 'hash',
				},
			],
		});

		const row = await getNote(db, 'n1');
		expect(row?.body).toBe('y\n');
		expect(row?.editorMode).toBe('raw');
		expect(row?.createdAt).toBe(42);
		expect(row?.deletedLocally).toBe(1);
	});

	it('leaves a note the user deleted to its delete, when a rescan asks for a reupload', async () => {
		// A tombstone is reported clean — `isDirty` says so, because reported
		// dirty it would meet a remote change as a conflict and come back in the
		// sidebar holding text the user deleted. So the engine names it for
		// reupload rather than `detach-note`, and forgetting the remote here
		// would take the `remoteId` its queued delete is addressed by: the
		// delete would purge the row with nothing removed, and the file would
		// come back on the next pull. It owes the remote its delete and nothing
		// else. There is no tombstone in the memory store, so this cannot live
		// in the shared contract.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.md',
					content: 'x\n',
					remote: remote('a.md'),
					syncedHash: 'hash',
				},
			],
		});
		await deleteNote(db, 'n1');
		const queued = await store.pendingOps();

		await store.applyPull({ changes: [{ kind: 'reupload-note', id: 'n1' }] });

		const row = await getNote(db, 'n1');
		expect(row?.deletedLocally).toBe(1);
		expect(row?.remoteId).toBe('r1');
		// And no write behind the delete: the ops are the ones the delete left.
		expect(await store.pendingOps()).toEqual(queued);
	});

	it('keeps a folder’s remote id when an ensure-folder does not carry one', async () => {
		const db = freshDatabase();
		// A clock that moves on every call, so a row written twice cannot keep its
		// first time by landing in the same millisecond.
		let clock = 0;
		const store = await boundStore(db, { connectionId: CONNECTION, now: () => ++clock });
		await store.applyPull({
			changes: [{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' }],
		});

		const first = await db.folders.get([CONNECTION, 'Work']);

		await store.applyPull({ changes: [{ kind: 'ensure-folder', path: 'Work' }] });

		expect((await store.folderByPath('Work'))?.remoteId).toBe('f1');
		expect((await db.folders.get([CONNECTION, 'Work']))?.createdAt).toBe(first?.createdAt);
	});

	it('makes no row for the app folder itself', async () => {
		// A row for the root is reconciled away after the next cursor reset as a
		// folder the scan did not mention — and every path is within the root.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyPull({ changes: [{ kind: 'ensure-folder', path: '', remoteId: 'root' }] });

		expect(await db.folders.count()).toBe(0);
	});

	it('does nothing for a folder deletion where it holds no folder', async () => {
		// The contract's promise, and the one a store that cascaded anyway would
		// break: the notes here are not under a notebook this store knows about.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await db.notes.put({
			...noteRecordFromFile({
				id: 'n1',
				connectionId: CONNECTION,
				path: 'Work/a.md',
				source: 'x\n',
				hash: '',
				now: 0,
			}),
			remoteId: 'r1',
		});

		await store.applyPull({ changes: [{ kind: 'delete-folder', path: 'Work' }], cursor: 'c1' });

		expect(await store.noteById('n1')).toBeDefined();
		expect(await store.cursor()).toBe('c1');
	});

	it('refuses a conflict copy whose id is already a note, and changes nothing', async () => {
		// The engine promises a fresh id. Writing the copy over a note that holds
		// it would be losing one note to save another.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remote: remote('a.md'),
					syncedHash: 'hash',
				},
				{
					kind: 'upsert-note',
					id: 'n2',
					path: 'b.md',
					content: 'other\n',
					remote: remote('b.md', 'r2'),
					syncedHash: 'hash',
				},
			],
			cursor: 'c1',
		});

		await expect(
			store.applyPull({
				changes: [
					{
						kind: 'conflict',
						resolution: {
							noteId: 'n1',
							remoteContent: 'theirs\n',
							remoteHash: 'hash',
							remote: remote('a.md', 'r1', 'v2'),
							copyId: 'n2',
							copyPath: 'a (conflict).md',
							copyContent: 'mine\n',
						},
					},
				],
				cursor: 'c2',
			})
		).rejects.toThrow();

		expect((await store.noteById('n1'))?.content).toBe('mine\n');
		expect((await store.noteById('n2'))?.content).toBe('other\n');
		expect(await store.cursor()).toBe('c1');
	});

	it('sees nothing that belongs to another connection', async () => {
		const db = freshDatabase();
		const mine = await boundStore(db, { connectionId: CONNECTION });
		const theirs = await boundStore(db, { connectionId: 'other' });
		await theirs.applyPull({
			changes: [
				{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' },
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Work/a.md',
					content: 'x\n',
					remote: remote('Work/a.md'),
					syncedHash: 'hash',
				},
			],
			cursor: 'theirs',
		});
		const other = await db.opQueue.add({
			connectionId: 'other',
			op: 'write',
			noteId: 'n1',
			path: 'Work/a.md',
			attempts: 0,
			queuedAt: 0,
		});

		expect(await mine.cursor()).toBeUndefined();
		expect(await mine.noteById('n1')).toBeUndefined();
		expect(await mine.noteByPath('Work/a.md')).toBeUndefined();
		expect(await mine.noteByRemoteId('r1')).toBeUndefined();
		expect(await mine.allNotes()).toEqual([]);
		expect(await mine.notesUnder('')).toEqual([]);
		expect(await mine.folderByPath('Work')).toBeUndefined();
		expect(await mine.folderByRemoteId('f1')).toBeUndefined();
		expect(await mine.foldersWithRemote()).toEqual([]);
		expect(await mine.pendingOps()).toEqual([]);
		await expect(mine.failOp(other, 'nope')).rejects.toThrow();

		// And a change about a note it does not own leaves that note alone.
		await mine.applyPull({
			changes: [
				{ kind: 'delete-note', id: 'n1' },
				{ kind: 'delete-folder', path: 'Work' },
			],
		});
		expect(await theirs.noteById('n1')).toBeDefined();
		expect(await theirs.folderByPath('Work')).toBeDefined();

		// Nor does a folder move of its own reach the other account's queue.
		await mine.applyPull({ changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive' }] });
		expect((await theirs.pendingOps()).map((op) => op.path)).toEqual(['Work/a.md']);
		expect((await theirs.noteById('n1'))?.path).toBe('Work/a.md');
	});

	it('keeps the client id a connection already has when it stores a cursor', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await db.syncState.put({
			connectionId: CONNECTION,
			clientId: 'this-browser',
			rootId: 'root',
		});

		await store.applyPull({ changes: [], cursor: 'c1' });

		expect(await db.syncState.get(CONNECTION)).toEqual({
			connectionId: CONNECTION,
			clientId: 'this-browser',
			rootId: 'root',
			cursor: 'c1',
		});
	});
});

/** A store with one clean note pulled into it, as the engine would leave it. */
const pulled = async (content = 'x\n') => {
	const db = freshDatabase();
	const store = await boundStore(db, { connectionId: CONNECTION });
	await store.applyPull({
		changes: [
			{
				kind: 'upsert-note',
				id: 'n1',
				path: 'a.md',
				content,
				remote: remote('a.md'),
				syncedHash: 'hash',
			},
		],
		cursor: 'c1',
	});
	return { db, store };
};

describe('a pull that lands after the user has typed', () => {
	// The engine reads the note clean, goes to the network, and hands the batch
	// over afterwards. An autosave can land in that window.
	it('is refused rather than overwriting the edit and calling the note clean', async () => {
		const { db, store } = await pulled();
		await saveNoteBody(db, 'n1', 'typed meanwhile\n');

		await expect(
			store.applyPull({
				changes: [
					{
						kind: 'upsert-note',
						id: 'n1',
						path: 'a.md',
						content: 'v2\n',
						remote: remote('a.md', 'r1', 'v2'),
						syncedHash: 'hash',
					},
				],
				cursor: 'c2',
			})
		).rejects.toThrow();

		const row = await getNote(db, 'n1');
		expect(row?.body).toBe('typed meanwhile\n');
		expect(row?.dirty).toBe(1);
		expect(await store.cursor()).toBe('c1');
	});

	it('is refused rather than deleting the note that was typed into', async () => {
		const { db, store } = await pulled();
		await saveNoteBody(db, 'n1', 'typed meanwhile\n');

		await expect(
			store.applyPull({ changes: [{ kind: 'delete-note', id: 'n1' }] })
		).rejects.toThrow();
		expect((await getNote(db, 'n1'))?.body).toBe('typed meanwhile\n');
	});

	it('makes the conflict copy from what was typed, not from what was read', async () => {
		const { db, store } = await pulled();
		const before = (await store.noteById('n1'))?.content ?? '';
		await saveNoteBody(db, 'n1', 'typed meanwhile\n');

		await store.applyPull({
			changes: [
				{
					kind: 'conflict',
					resolution: {
						noteId: 'n1',
						remoteContent: 'theirs\n',
						remoteHash: 'hash',
						remote: remote('a.md', 'r1', 'v2'),
						copyId: 'c1',
						copyPath: 'a (conflict).md',
						copyContent: conflictContent(before, 'c1'),
					},
				},
			],
		});

		const copy = await getNote(db, 'c1');
		// The body keeps the blank line after the frontmatter block verbatim.
		expect(copy?.body.trim()).toBe('typed meanwhile');
		// Hashed inside the transaction, since it was not known up front.
		expect(copy?.contentHash).toBe(await contentHash(noteFile(copy!)));
	});
});

describe('another connection’s note under the same id', () => {
	it('is refused rather than taken over, unpushed edits and all', async () => {
		// Ids live in frontmatter, so a folder reconnected under a new
		// connection while the old rows are still here names every one of them.
		const db = freshDatabase();
		const theirs = await createNote(db, { connectionId: 'other', body: 'unpushed\n' });
		// Clean, so what refuses this is whose note it is and not that it was
		// edited — a pushed note is taken over just the same.
		await db.notes.update(theirs.id, { dirty: 0 });
		const store = await boundStore(db, { connectionId: CONNECTION });

		await expect(
			store.applyPull({
				changes: [
					{
						kind: 'upsert-note',
						id: theirs.id,
						path: 'a.md',
						content: 'remote\n',
						remote: remote('a.md'),
						syncedHash: 'hash',
					},
				],
			})
		).rejects.toThrow();

		const row = await getNote(db, theirs.id);
		expect(row?.connectionId).toBe('other');
		expect(row?.body).toBe('unpushed\n');
	});

	it('is left alone by every other change and outcome that names it', async () => {
		const db = freshDatabase();
		const theirs = await boundStore(db, { connectionId: 'other' });
		const mine = await boundStore(db, { connectionId: CONNECTION });
		await theirs.applyPull({
			changes: [
				{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' },
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Work/a.md',
					content: 'x\n',
					remote: remote('Work/a.md'),
					syncedHash: 'hash',
				},
			],
		});
		const seq = await db.opQueue.add({
			connectionId: 'other',
			op: 'delete',
			noteId: 'n1',
			path: 'Work/a.md',
			attempts: 0,
			queuedAt: 0,
		});

		await mine.applyPull({
			changes: [
				{ kind: 'detach-note', id: 'n1' },
				{ kind: 'displace-note', id: 'n1', path: 'moved.md' },
				{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f9' },
			],
		});
		await expect(mine.completeOp(seq, { kind: 'purged', noteId: 'n1' })).rejects.toThrow();
		await expect(
			mine.resolveConflict(seq, {
				noteId: 'n1',
				remoteContent: 'y\n',
				remoteHash: 'hash',
				remote: remote('Work/a.md'),
				copyId: 'c1',
				copyPath: 'c.md',
				copyContent: conflictContent('x\n', 'c1'),
			})
		).rejects.toThrow();

		const note = await theirs.noteById('n1');
		expect(note?.path).toBe('Work/a.md');
		expect(note?.remoteId).toBe('r1');
		expect((await theirs.folderByPath('Work'))?.remoteId).toBe('f1');
		expect(await theirs.folderByPath('Archive')).toBeUndefined();

		// Even an op of this connection's own that names the other's note.
		const own = await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'delete',
			noteId: 'n1',
			path: 'Work/a.md',
			attempts: 0,
			queuedAt: 0,
		});
		await mine.completeOp(own, { kind: 'purged', noteId: 'n1' });
		expect(await theirs.noteById('n1')).toMatchObject({ remoteId: 'r1', dirty: false });
		expect((await theirs.pendingOps()).map((op) => op.seq)).toEqual([seq]);
		expect(await mine.opBySeq(seq)).toBeUndefined();
		expect(await theirs.opBySeq(seq)).toMatchObject({ seq, op: 'delete' });
	});
});

describe('a note deleted here', () => {
	it('stays deleted when the remote changed it meanwhile, end to end', async () => {
		// `deleteNote` marks the row dirty. Handed to the engine that way, a
		// remote change is a conflict, and its copy is a new live note holding
		// the text the user deleted — back in the sidebar and on the remote.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const provider = createFakeProvider();
		await provider.ensureRoot();
		const engine = createSyncEngine({
			provider,
			store,
			now: () => new Date('2026-09-15T14:32:00Z'),
		});
		const entry = await provider.write('a.md', 'one\n', {});
		expect((await engine.sync()).status).toBe('ok');
		const [note] = await listNotes(db, { connectionId: CONNECTION });

		await deleteNote(db, note!.id);
		await provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(await db.notes.count()).toBe(0);
		expect(provider.contentAt('a.md')).toBeUndefined();
	});

	it('keeps its file exactly as it was, even from before files were kept', async () => {
		// A row written before `source` existed re-serializes with `updatedAt`
		// in it, and deleting moves `updatedAt`. Neither delete nor restore is
		// an edit to the file.
		const db = freshDatabase();
		const created = await createNote(db, { connectionId: CONNECTION, body: 'hello\n' });
		const { source: _source, ...old } = created;
		await db.notes.put(old);
		const before = noteFile(old);

		await deleteNote(db, created.id);
		expect(noteFile((await getNote(db, created.id))!)).toBe(before);
		await restoreNote(db, created.id);
		expect(noteFile((await getNote(db, created.id))!)).toBe(before);
	});

	it('is kept, cut loose from its file, when restored before its delete landed', async () => {
		const { db, store } = await pulled();
		await deleteNote(db, 'n1');
		// Read by the engine, and at the network, when the user restores it.
		const [remove] = await store.pendingOps();
		await restoreNote(db, 'n1');

		await store.completeOp(remove?.seq ?? -1, { kind: 'purged', noteId: 'n1' });

		const row = await getNote(db, 'n1');
		expect(row?.deletedLocally).toBe(0);
		expect(row?.remoteId).toBeUndefined();
		expect(row?.dirty).toBe(1);
		// The file is gone, so the note is owed one: exactly one.
		expect((await store.pendingOps()).map((op) => [op.op, op.noteId])).toEqual([
			['write', 'n1'],
		]);
	});

	it('goes when the remote deletes it too', async () => {
		// Marked dirty by `deleteNote`, clean to the engine — so the engine
		// decides a plain delete, and a store that checked the raw flag would
		// refuse that batch on every pull, for ever.
		const { db, store } = await pulled();
		await deleteNote(db, 'n1');

		await store.applyPull({ changes: [{ kind: 'delete-note', id: 'n1' }], cursor: 'c2' });

		expect(await getNote(db, 'n1')).toBeUndefined();
		expect(await store.cursor()).toBe('c2');
	});

	it('makes no conflict copy when a write queued before the delete meets a remote change', async () => {
		// The push side of the delete winning. The write reaches the provider
		// first, finds the file changed, and the conflict lands on a note that
		// has been deleted since. A copy would be a live note holding the text
		// the user deleted, queued to be written back to the remote.
		//
		// The delete also withdraws every write queued for the note, this one
		// included — it is at the network, so only its queue row goes. So the
		// resolution arrives for an op that is no longer queued, which is the
		// other half of what this pins.
		const { db, store } = await pulled();
		await saveNoteBody(db, 'n1', 'edited then deleted\n');
		const [write] = await store.pendingOps();
		const read = (await store.noteById('n1'))?.content ?? '';
		// A second write, owed to an edit made while the first was in flight.
		await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'write',
			noteId: 'n1',
			path: 'a.md',
			attempts: 0,
			queuedAt: 0,
		});
		await deleteNote(db, 'n1');
		const remove = (await db.opQueue.toArray()).find((op) => op.op === 'delete')?.seq;

		await store.resolveConflict(write?.seq ?? -1, {
			noteId: 'n1',
			remoteContent: 'theirs\n',
			remoteHash: 'hash',
			remote: remote('a.md', 'r1', 'v2'),
			copyId: 'c1',
			copyPath: 'a (conflict).md',
			copyContent: conflictContent(read, 'c1'),
		});

		expect(await getNote(db, 'c1')).toBeUndefined();
		expect((await store.pendingOps()).map((op) => op.seq)).toEqual([remove]);
		const row = await getNote(db, 'n1');
		expect(row?.deletedLocally).toBe(1);
		expect(row?.remoteVersion).toBe('v2');
	});

	it('goes with its folder when the folder is deleted remotely', async () => {
		// Clean to the engine, so clean to the cascade too. Kept as though it
		// held unpushed writing, it would be detached and left behind — a live
		// row for a note the user deleted, with nothing left to purge it.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyPull({
			changes: [
				{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' },
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Work/a.md',
					content: 'x\n',
					remote: remote('Work/a.md'),
					syncedHash: 'hash',
				},
			],
		});
		await deleteNote(db, 'n1');

		await store.applyPull({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

		expect(await getNote(db, 'n1')).toBeUndefined();
	});

	it('is clean as far as a pull is concerned, and written back clean', async () => {
		const { db, store } = await pulled();
		await deleteNote(db, 'n1');
		expect((await store.noteById('n1'))?.dirty).toBe(false);

		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.md',
					content: 'v2\n',
					remote: remote('a.md', 'r1', 'v2'),
					syncedHash: 'hash',
				},
			],
		});

		const row = await getNote(db, 'n1');
		expect(row?.dirty).toBe(0);
		expect(row?.deletedLocally).toBe(1);
	});
});

describe('where a change puts a note', () => {
	it('makes the folders above every path a change puts a note at', async () => {
		const { db, store } = await pulled();
		await store.applyPull({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n2',
					path: 'b.md',
					content: 'b\n',
					remote: remote('b.md', 'r2'),
					syncedHash: 'hash',
				},
				{
					kind: 'upsert-note',
					id: 'n3',
					path: 'c.md',
					content: 'c\n',
					remote: remote('c.md', 'r3'),
					syncedHash: 'hash',
				},
				{ kind: 'move-note', id: 'n1', path: 'Moved/a.md', remote: remote('Moved/a.md') },
				{ kind: 'displace-note', id: 'n2', path: 'Displaced/b.md' },
				{ kind: 'ensure-folder', path: 'Deep/Er/Est', remoteId: 'f1' },
			],
		});
		await db.notes.update('n3', { dirty: 1 });
		const content = (await store.noteById('n3'))?.content ?? '';
		await store.applyPull({
			changes: [
				{
					kind: 'conflict',
					resolution: {
						noteId: 'n3',
						remoteContent: 'theirs\n',
						remoteHash: 'hash',
						remote: remote('Remote/c.md', 'r3', 'v2'),
						copyId: 'copy',
						copyPath: 'Copies/c (conflict).md',
						copyContent: conflictContent(content, 'copy'),
					},
				},
			],
		});

		const folders = (await db.folders.toArray()).map((folder) => folder.path).sort();
		expect(folders).toEqual([
			'Copies',
			'Deep',
			'Deep/Er',
			'Deep/Er/Est',
			'Displaced',
			'Moved',
			'Remote',
		]);
		// The remote takes the path it claims.
		expect((await store.noteById('n3'))?.path).toBe('Remote/c.md');
	});

	it('keeps what the app knows about a note the remote wins a conflict over', async () => {
		const { db, store } = await pulled();
		await db.notes.update('n1', { editorMode: 'raw', createdAt: 42 });
		await saveNoteBody(db, 'n1', 'mine\n');
		const content = (await store.noteById('n1'))?.content ?? '';

		await store.applyPull({
			changes: [
				{
					kind: 'conflict',
					resolution: {
						noteId: 'n1',
						remoteContent: 'theirs\n',
						remoteHash: 'hash',
						remote: remote('a.md', 'r1', 'v2'),
						copyId: 'copy',
						copyPath: 'a (conflict).md',
						copyContent: conflictContent(content, 'copy'),
					},
				},
			],
		});

		const row = await getNote(db, 'n1');
		expect(row?.editorMode).toBe('raw');
		expect(row?.createdAt).toBe(42);
		expect(row?.dirty).toBe(0);
	});

	it('records where a move landed, and a moved folder’s new remote id', async () => {
		const { db, store } = await pulled();
		const seq = await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'move',
			noteId: 'n1',
			path: 'a.md',
			targetPath: 'b.md',
			attempts: 0,
			queuedAt: 0,
		});
		await store.completeOp(seq, {
			kind: 'moved',
			noteId: 'n1',
			remote: remote('b.md', 'r1', 'v2'),
		});
		expect((await store.noteById('n1'))?.path).toBe('b.md');

		await store.applyPull({
			changes: [{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' }],
		});
		await store.applyPull({
			changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f2' }],
		});
		expect((await store.folderByPath('Archive'))?.remoteId).toBe('f2');
	});

	it('writes nothing for a connection the device has let go of', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyPull({
			changes: [{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' }],
		});
		await db.syncState.clear();

		await expect(
			store.applyPull({
				changes: [
					{
						kind: 'upsert-note',
						id: 'n1',
						path: 'Work/a.md',
						content: 'x\n',
						remote: remote('Work/a.md'),
						syncedHash: 'hash',
					},
				],
				cursor: 'c2',
			})
		).rejects.toThrow(UnboundConnectionError);

		expect(await db.syncState.count()).toBe(0);
		expect(await db.notes.count()).toBe(0);
	});
});

describe('importing a file over a tombstone', () => {
	it('brings the note back, which is what importing a file asks for', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { connectionId: CONNECTION, title: 'Kept' });
		await deleteNote(db, note.id);

		await importNoteFile(db, {
			connectionId: CONNECTION,
			path: note.path,
			source: noteFile(note),
		});

		expect((await getNote(db, note.id))?.deletedLocally).toBe(0);
	});
});
