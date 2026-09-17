import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../src/providers/types.js';
import { conflictContent } from '../../src/sync/conflicts.js';
import type { SyncStore } from '../../src/sync/store.js';

/**
 * What any `SyncStore` has to do, whatever it is built on. The engine's
 * correctness rests on promises the port makes but the type cannot state — that
 * a pull batch commits all at once, that a folder move drags the queued ops
 * with it, that a note stays dirty if it changed while it was being pushed —
 * and an implementation that quietly drops one of them loses an edit somewhere
 * far away from itself.
 *
 * Deliberately not a `*.test.ts`: `vitest.config.ts` collects only those, so
 * this runs where it is registered rather than twice.
 */

export interface StoreHarness {
	store: SyncStore;
	/** Seed a note directly, bypassing the engine. */
	seed: (note: {
		id: string;
		path: string;
		content: string;
		remoteId?: string;
		remoteVersion?: string;
		syncedHash?: string;
		dirty?: boolean;
	}) => void | Promise<void>;
	seedFolder: (folder: { path: string; remoteId?: string }) => void | Promise<void>;
	/** Queue an op and return the seq it was given. */
	seedOp: (op: {
		op: 'write' | 'move' | 'delete' | 'mkdir';
		path: string;
		noteId?: string;
		targetPath?: string;
	}) => number | Promise<number>;
}

const remote = (path: string, id = 'r1', version = 'v1'): RemoteEntry => ({
	remoteId: id,
	path,
	kind: 'file',
	version,
	modifiedAt: '2026-01-01T00:00:00.000Z',
	size: 1,
});

export const describeSyncStoreContract = (
	name: string,
	create: () => StoreHarness | Promise<StoreHarness>
): void => {
	describe(`SyncStore contract: ${name}`, () => {
		const harness = create;

		describe('the bytes a note last synced', () => {
			// What tells a remote rename from a remote edit on a provider whose
			// version changes on a move. A store that drops it is correct in every
			// other way and hands the user a conflict copy for every such rename.
			const hashOf = async (store: SyncStore, id: string) =>
				(await store.noteById(id))?.syncedHash;

			it('reads back what was seeded', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'x\n',
					remoteId: 'r1',
					syncedHash: 'h1',
				});
				expect(await hashOf(store, 'n1')).toBe('h1');
			});

			it('records it with a note a pull brings in', async () => {
				const { store } = await harness();
				await store.applyPull({
					changes: [
						{
							kind: 'upsert-note',
							id: 'n1',
							path: 'a.md',
							content: 'x\n',
							remote: remote('a.md'),
							syncedHash: 'h1',
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('h1');
			});

			it('replaces it when a version or move names one, and keeps it when not', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'x\n',
					remoteId: 'r1',
					syncedHash: 'h1',
					dirty: true,
				});
				await seed({
					id: 'n2',
					path: 'b.md',
					content: 'y\n',
					remoteId: 'r2',
					syncedHash: 'h2',
				});

				await store.applyPull({
					changes: [
						{ kind: 'adopt-version', id: 'n1', remote: remote('a.md', 'r1', 'v2') },
						{
							kind: 'move-note',
							id: 'n2',
							path: 'c.md',
							remote: remote('c.md', 'r2', 'v2'),
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('h1');
				expect(await hashOf(store, 'n2')).toBe('h2');

				await store.applyPull({
					changes: [
						{
							kind: 'adopt-version',
							id: 'n1',
							remote: remote('a.md', 'r1', 'v3'),
							syncedHash: 'h3',
						},
						{
							kind: 'move-note',
							id: 'n2',
							path: 'd.md',
							remote: remote('d.md', 'r2', 'v3'),
							syncedHash: 'h4',
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('h3');
				expect(await hashOf(store, 'n2')).toBe('h4');
				// And an edit waiting to go out is still waiting.
				expect((await store.noteById('n1'))?.dirty).toBe(true);
			});

			it('takes the remote\u2019s with the remote\u2019s bytes in a conflict, and gives the copy none', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					syncedHash: 'old',
					dirty: true,
				});
				await store.applyPull({
					changes: [
						{
							kind: 'conflict',
							resolution: {
								noteId: 'n1',
								remoteContent: 'theirs\n',
								remoteHash: 'theirs',
								remote: remote('a.md', 'r1', 'v2'),
								copyId: 'c1',
								copyPath: 'a (conflict).md',
								copyContent: conflictContent('mine\n', 'c1'),
							},
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('theirs');
				expect(await hashOf(store, 'c1')).toBeUndefined();
			});

			it('records what a push sent, even when the note has moved on since', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'x and more\n',
					syncedHash: 'old',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });

				await store.completeOp(seq, {
					kind: 'pushed',
					noteId: 'n1',
					remote: remote('a.md', 'r1', 'v2'),
					content: 'x\n',
					syncedHash: 'sent',
				});
				expect(await hashOf(store, 'n1')).toBe('sent');
			});

			it('forgets it with the remote, when a note is detached or its folder goes', async () => {
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'x\n',
					remoteId: 'r1',
					syncedHash: 'h1',
					dirty: true,
				});
				await seed({
					id: 'n2',
					path: 'Work/b.md',
					content: 'y\n',
					remoteId: 'r2',
					syncedHash: 'h2',
					dirty: true,
				});

				await store.applyPull({
					changes: [
						{ kind: 'detach-note', id: 'n1' },
						{ kind: 'delete-folder', path: 'Work' },
					],
				});
				expect(await hashOf(store, 'n1')).toBeUndefined();
				expect(await hashOf(store, 'n2')).toBeUndefined();
			});
		});

		describe('reading', () => {
			it('still answers for a note whose delete is still queued', async () => {
				// The op carries only a `noteId`, and the `remoteId` it needs to
				// remove the file lives on the row. A store that hid the row the
				// moment the user pressed delete would have the engine find
				// nothing, finish the op as though there were nothing to send,
				// and leave the file on the remote for ever.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', remoteId: 'r1' });
				const seq = await seedOp({ op: 'delete', noteId: 'n1', path: 'a.md' });

				expect((await store.noteById('n1'))?.remoteId).toBe('r1');
				// Every read, not just this one. A store with a `deleted` flag
				// and filtered indexes satisfies `noteById` alone and still
				// loses a note the first time one is deleted here and edited on
				// another device: the pull cannot see the row, mints a second
				// note at that path, and the queued delete removes the file that
				// was just imported.
				expect((await store.noteByPath('a.md'))?.id).toBe('n1');
				expect((await store.noteByRemoteId('r1'))?.id).toBe('n1');
				expect((await store.allNotes()).map((note) => note.id)).toContain('n1');
				expect((await store.notesUnder('')).map((note) => note.id)).toContain('n1');

				// And it goes when the op says the remote copy is gone, not before.
				await store.completeOp(seq, { kind: 'purged', noteId: 'n1' });
				expect(await store.noteById('n1')).toBeUndefined();
				expect(await store.noteByPath('a.md')).toBeUndefined();
			});

			it('finds a note by id, path and remote id', async () => {
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', remoteId: 'r1' });

				expect((await store.noteById('n1'))?.path).toBe('a.md');
				expect((await store.noteByPath('a.md'))?.id).toBe('n1');
				expect((await store.noteByRemoteId('r1'))?.id).toBe('n1');
			});

			it('answers undefined rather than throwing for something absent', async () => {
				const { store } = await harness();

				expect(await store.noteById('nope')).toBeUndefined();
				expect(await store.noteByPath('nope.md')).toBeUndefined();
				expect(await store.noteByRemoteId('nope')).toBeUndefined();
				expect(await store.folderByRemoteId('nope')).toBeUndefined();
			});

			it('lists every note in the store for the root', async () => {
				// The root is asked for by name — every loose note's parent is
				// the root — and an implementation that reads `folderPath` as a
				// prefix and answers `startsWith(folderPath + '/')` returns
				// nothing for it. A conflict copy at the root then stops
				// avoiding names already taken and overwrites the copy there.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'loose.md', content: 'x\n' });
				await seed({ id: 'n2', path: 'Work/a.md', content: 'x\n' });

				const under = await store.notesUnder('');
				expect(under.map((note) => note.id).sort()).toEqual(['n1', 'n2']);
			});

			it('lists notes beneath a folder at every depth', async () => {
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'Work/a.md', content: 'x\n' });
				await seed({ id: 'n2', path: 'Work/Deep/b.md', content: 'x\n' });
				await seed({ id: 'n3', path: 'Other/c.md', content: 'x\n' });

				const under = await store.notesUnder('Work');
				expect(under.map((note) => note.id).sort()).toEqual(['n1', 'n2']);
			});

			it('finds a folder by path and by remote id', async () => {
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });

				expect((await store.folderByPath('Work'))?.remoteId).toBe('f1');
				expect((await store.folderByRemoteId('f1'))?.path).toBe('Work');
				expect(await store.folderByPath('Nope')).toBeUndefined();
			});

			it('lists only the folders that have reached the remote', async () => {
				// What a rescan reconciles against. A folder created here and not
				// pushed yet was never in the scan, so treating it as missing
				// would delete a notebook the moment the cursor died.
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seedFolder({ path: 'Fresh' });

				expect((await store.foldersWithRemote()).map((folder) => folder.path)).toEqual([
					'Work',
				]);
			});

			it('has no cursor before the first pull', async () => {
				const { store } = await harness();
				expect(await store.cursor()).toBeUndefined();
			});
		});

		describe('applyPull', () => {
			it('stores a new note and the cursor together', async () => {
				const { store } = await harness();
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
					cursor: 'c1',
				});

				expect((await store.noteByPath('a.md'))?.content).toBe('x\n');
				expect((await store.noteByPath('a.md'))?.dirty).toBe(false);
				expect(await store.cursor()).toBe('c1');
			});

			it('leaves the cursor alone when the batch does not carry one', async () => {
				// How a full scan applies its pages: the scan is one logical
				// batch, and a cursor written halfway through claims a scan that
				// has not finished.
				const { store } = await harness();
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

				expect(await store.noteByPath('a.md')).toBeDefined();
				expect(await store.cursor()).toBeUndefined();
			});

			it('writes an updated note under the id the engine names', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'old\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
				});
				await store.applyPull({
					changes: [
						{
							kind: 'upsert-note',
							id: 'n1',
							path: 'a.md',
							content: 'new\n',
							remote: remote('a.md', 'r1', 'v2'),
							syncedHash: 'hash',
						},
					],
					cursor: 'c1',
				});

				const note = await store.noteByPath('a.md');
				expect(note?.id).toBe('n1');
				expect(note?.content).toBe('new\n');
				expect(note?.remoteVersion).toBe('v2');
			});

			it('adopts a version without touching anything else', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'x\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyPull({
					changes: [
						{ kind: 'adopt-version', id: 'n1', remote: remote('a.md', 'r1', 'v2') },
					],
					cursor: 'c1',
				});

				const note = await store.noteById('n1');
				expect(note?.remoteVersion).toBe('v2');
				expect(note?.content).toBe('x\n');
				expect(note?.dirty).toBe(true);
			});

			it('forgets the remote but keeps the note when it is detached', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyPull({
					changes: [{ kind: 'detach-note', id: 'n1' }],
					cursor: 'c1',
				});

				const note = await store.noteById('n1');
				expect(note?.content).toBe('mine\n');
				expect(note?.remoteId).toBeUndefined();
				expect(note?.remoteVersion).toBeUndefined();
				expect(note?.dirty).toBe(true);
			});

			it('takes the contents of a folder with it when the folder is deleted', async () => {
				// The engine sends one `delete-folder` and nothing else, because a
				// provider that reports only the folder gives it nothing else to
				// send. A store that deleted just the row would leave every note
				// inside it at a path with no folder — invisible in the sidebar,
				// and still claiming a remote file that no longer exists.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seedFolder({ path: 'Work/Deep', remoteId: 'f2' });
				await seed({ id: 'n1', path: 'Work/a.md', content: 'x\n', remoteId: 'r1' });
				await seed({ id: 'n2', path: 'Work/Deep/b.md', content: 'x\n', remoteId: 'r2' });
				await seed({ id: 'n3', path: 'Other/c.md', content: 'x\n', remoteId: 'r3' });

				await store.applyPull({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

				expect(await store.folderByPath('Work')).toBeUndefined();
				expect(await store.folderByPath('Work/Deep')).toBeUndefined();
				expect(await store.noteById('n1')).toBeUndefined();
				expect(await store.noteById('n2')).toBeUndefined();
				expect(await store.noteById('n3')).toBeDefined();
			});

			it('keeps an edited note when its folder is deleted remotely', async () => {
				// Never lose user data (CLAUDE.md). The folder is gone, but the
				// edit in it was never anywhere else, so the note survives as a
				// local one rather than following the folder into the bin.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({
					id: 'n1',
					path: 'Work/a.md',
					content: 'mine\n',
					remoteId: 'r1',
					dirty: true,
				});

				await store.applyPull({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

				const note = await store.noteById('n1');
				expect(note?.content).toBe('mine\n');
				expect(note?.remoteId).toBeUndefined();
				expect(note?.dirty).toBe(true);
			});

			it('makes the folders above a note that has none', async () => {
				// The engine emits `ensure-folder` only for folders the remote
				// reported, and a feed that mentions a file without its parent
				// is ordinary. A note at a path with no notebook behind it is
				// invisible in the sidebar and still holding its name.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n' });

				await store.applyPull({
					changes: [
						{
							kind: 'upsert-note',
							id: 'n2',
							path: 'Work/Meetings/b.md',
							content: 'deep\n',
							remote: remote('Work/Meetings/b.md', 'r2'),
							syncedHash: 'hash',
						},
					],
					cursor: 'c1',
				});

				expect((await store.notesUnder('Work')).map((note) => note.id)).toEqual(['n2']);
				expect(await store.folderByPath('Work')).toBeDefined();
				expect(await store.folderByPath('Work/Meetings')).toBeDefined();
			});

			it('keeps a folder its id over an ensure-folder that names none', async () => {
				// The engine puts a row back over the notes a cascade kept,
				// without an id, and a folder moved onto that path in the same
				// batch already has one. Forgotten, the deletion of that folder
				// by id finds nothing, and the notebook stays for ever.
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });

				await store.applyPull({
					changes: [{ kind: 'ensure-folder', path: 'Work' }],
					cursor: 'c1',
				});

				expect((await store.folderByPath('Work'))?.remoteId).toBe('f1');
			});

			it('moves a displaced note without touching its contents', async () => {
				// It is only being got out of the way of a remote note landing
				// on its path. The text is the user's, it has never been
				// anywhere else, and it still needs pushing.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });

				await store.applyPull({
					changes: [{ kind: 'displace-note', id: 'n1', path: 'a (conflict x).md' }],
					cursor: 'c1',
				});

				const note = await store.noteById('n1');
				expect(note?.path).toBe('a (conflict x).md');
				expect(note?.content).toBe('mine\n');
				expect(note?.dirty).toBe(true);
				expect(await store.noteByPath('a.md')).toBeUndefined();
			});

			it('holds two notes at one path while a batch is mid-flight', async () => {
				// A note moving out of the way is a change of its own and can
				// come later in the batch. A unique index on `path` would reject
				// this and be retried for ever; making room by deleting what is
				// there takes that note's unpushed edits with it.
				const { store, seed } = await harness();
				await seed({ id: 'ours', path: 'a.md', content: 'mine\n', dirty: true });
				await seed({ id: 'theirs', path: 'b.md', content: 'theirs\n', remoteId: 'r2' });

				await store.applyPull({
					changes: [
						{
							kind: 'move-note',
							id: 'theirs',
							path: 'a.md',
							remote: remote('a.md', 'r2'),
						},
						{ kind: 'displace-note', id: 'ours', path: 'a (conflict x).md' },
					],
					cursor: 'c1',
				});

				expect((await store.noteByPath('a.md'))?.id).toBe('theirs');
				expect((await store.noteById('ours'))?.content).toBe('mine\n');
			});

			it('does not make room for an upsert by deleting what is there', async () => {
				// The note at that path is about to be moved by a change further
				// down the batch. Deleting it to clear the way takes its unpushed
				// edits with it — and that is the shape of a store that "helps"
				// by enforcing one row per path.
				const { store, seed } = await harness();
				await seed({ id: 'ours', path: 'a.md', content: 'mine\n', dirty: true });
				await seed({ id: 'theirs', path: 'b.md', content: 'theirs\n', remoteId: 'r2' });

				await store.applyPull({
					changes: [
						{
							kind: 'upsert-note',
							id: 'theirs',
							path: 'a.md',
							content: 'theirs\n',
							remote: remote('a.md', 'r2'),
							syncedHash: 'hash',
						},
						{ kind: 'displace-note', id: 'ours', path: 'a (conflict x).md' },
					],
					cursor: 'c1',
				});

				expect((await store.noteById('ours'))?.content).toBe('mine\n');
				expect((await store.noteById('ours'))?.path).toBe('a (conflict x).md');
				expect((await store.noteByPath('a.md'))?.id).toBe('theirs');
			});

			it('points a displaced note\u2019s queued ops at where it went', async () => {
				// A queued `move` is the user's rename, and its target is the
				// path the remote has just taken. Left pointing there it
				// conflicts on every push and can never succeed — and since the
				// queue is ordered and a dead op stops the drain, every later op
				// for every other note is stranded behind it.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'Groceries.md', content: 'mine\n', remoteId: 'r1' });
				const seq = await seedOp({
					op: 'move',
					noteId: 'n1',
					path: 'Untitled.md',
					targetPath: 'Groceries.md',
				});

				await store.applyPull({
					changes: [
						{ kind: 'displace-note', id: 'n1', path: 'Groceries (conflict x).md' },
					],
					cursor: 'c1',
				});

				const op = (await store.pendingOps()).find((each) => each.seq === seq);
				expect(op?.targetPath).toBe('Groceries (conflict x).md');
			});

			it('leaves another note\u2019s ops alone when one is displaced', async () => {
				// Somebody else queued to move into that path is not resolved by
				// this: their op still has a race to lose, and rewriting it would
				// send their note somewhere the user never asked for.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'mine\n' });
				await seed({ id: 'n2', path: 'b.md', content: 'theirs\n', remoteId: 'r2' });
				const seq = await seedOp({
					op: 'move',
					noteId: 'n2',
					path: 'b.md',
					targetPath: 'a.md',
				});

				await store.applyPull({
					changes: [{ kind: 'displace-note', id: 'n1', path: 'a (conflict x).md' }],
					cursor: 'c1',
				});

				const op = (await store.pendingOps()).find((each) => each.seq === seq);
				expect(op?.targetPath).toBe('a.md');
			});

			it('accepts a displacement of a note that is already gone', async () => {
				// Same reasoning as the deletes: a batch the store rejects is
				// retried for ever, because the cursor moves only with it.
				const { store } = await harness();

				await store.applyPull({
					changes: [{ kind: 'displace-note', id: 'nobody', path: 'x.md' }],
					cursor: 'c1',
				});

				expect(await store.cursor()).toBe('c1');
			});

			it('accepts a delete for a note that is already gone', async () => {
				// A provider that reports a folder deletion recursively names the
				// folder and then everything that was in it, and the folder took
				// them already. A store that rejected would fail the batch, and
				// the cursor moves only with the batch — so the same batch would
				// be retried for ever and the user's sync would never recover.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.md', content: 'x\n', remoteId: 'r1' });

				await store.applyPull({
					changes: [
						{ kind: 'delete-folder', path: 'Work' },
						{ kind: 'delete-note', id: 'n1' },
						{ kind: 'detach-note', id: 'n1' },
					],
					cursor: 'c1',
				});

				expect(await store.noteById('n1')).toBeUndefined();
				expect(await store.cursor()).toBe('c1');
			});

			it('applies the changes in the order they are given', async () => {
				// The engine reaches every decision against the store as it was
				// and relies on them being carried out one after another. A
				// store that grouped by kind to batch its writes — all the
				// deletes, then all the puts — would drop the note this batch
				// re-establishes, and would look perfectly reasonable doing it.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'old\n', remoteId: 'r1' });

				await store.applyPull({
					changes: [
						{ kind: 'delete-note', id: 'n1' },
						{
							kind: 'upsert-note',
							id: 'n1',
							path: 'a.md',
							content: 'new\n',
							remote: remote('a.md', 'r2'),
							syncedHash: 'hash',
						},
					],
					cursor: 'c1',
				});

				expect((await store.noteById('n1'))?.content).toBe('new\n');
			});

			it('leaves one row at a path an upsert names', async () => {
				// Two notes at one path is a row the sidebar shows twice and two
				// queued writes racing for one file. The note the engine names
				// ends up there; whatever was there before has moved.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'old\n', remoteId: 'r1' });

				await store.applyPull({
					changes: [
						{
							kind: 'upsert-note',
							id: 'n1',
							path: 'b.md',
							content: 'moved\n',
							remote: remote('b.md', 'r1'),
							syncedHash: 'hash',
						},
					],
				});

				expect(await store.noteByPath('a.md')).toBeUndefined();
				expect((await store.noteByPath('b.md'))?.id).toBe('n1');
			});

			it('accepts a delete for a folder that is not there', async () => {
				// Same reasoning as the delete of a note that is already gone: a
				// batch that rejects is a batch that is retried for ever.
				const { store } = await harness();

				await store.applyPull({
					changes: [{ kind: 'delete-folder', path: 'Nowhere' }],
					cursor: 'c1',
				});

				expect(await store.cursor()).toBe('c1');
			});

			describe('a decision about a note edited since it was made', () => {
				// The engine reads a note, goes to the network for the remote
				// file, and only then hands over the batch. What the user typed in
				// between is in the store and nowhere else.
				const edited = {
					id: 'n1',
					path: 'a.md',
					content: 'typed since\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				};

				it('refuses an upsert, rather than overwriting it and calling it clean', async () => {
					const { store, seed } = await harness();
					await seed(edited);

					await expect(
						store.applyPull({
							changes: [
								{
									kind: 'upsert-note',
									id: 'n1',
									path: 'a.md',
									content: 'remote\n',
									remote: remote('a.md', 'r1', 'v2'),
									syncedHash: 'hash',
								},
							],
							cursor: 'c1',
						})
					).rejects.toThrow();

					const note = await store.noteById('n1');
					expect(note?.content).toBe('typed since\n');
					expect(note?.dirty).toBe(true);
					expect(await store.cursor()).toBeUndefined();
				});

				it('refuses a delete', async () => {
					const { store, seed } = await harness();
					await seed(edited);

					await expect(
						store.applyPull({
							changes: [{ kind: 'delete-note', id: 'n1' }],
							cursor: 'c1',
						})
					).rejects.toThrow();

					expect((await store.noteById('n1'))?.content).toBe('typed since\n');
				});

				it('makes a conflict copy from the note as it stands, not as it was read', async () => {
					// No refusal: the note is dirty either way, and refusing would stall
					// every pull for as long as someone keeps typing into it.
					const { store, seed } = await harness();
					await seed(edited);

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
									copyContent: conflictContent('what the engine read\n', 'c1'),
								},
							},
						],
						cursor: 'c1',
					});

					expect((await store.noteById('c1'))?.content).toBe(
						conflictContent('typed since\n', 'c1')
					);
				});
			});

			it('rolls the whole batch back when part of it fails', async () => {
				// The cursor and the changes it describes are one promise. A
				// cursor stored ahead of its batch skips work that never
				// happened, and nothing ever asks for it again.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', remoteId: 'r1' });
				await store.applyPull({ changes: [], cursor: 'c1' });

				await expect(
					store.applyPull({
						changes: [
							{
								kind: 'upsert-note',
								id: 'n2',
								path: 'b.md',
								content: 'y\n',
								remote: remote('b.md', 'r2'),
								syncedHash: 'hash',
							},
							// Nothing has this id, so a store that checks its
							// inputs rejects — which is the point.
							{ kind: 'adopt-version', id: 'missing', remote: remote('b.md', 'r2') },
						],
						cursor: 'c2',
					})
				).rejects.toThrow();

				expect(await store.cursor()).toBe('c1');
				expect(await store.noteByPath('b.md')).toBeUndefined();
			});
		});

		describe('a folder move', () => {
			it('carries the notes and the queued ops with it', async () => {
				const { store, seed, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.md', content: 'x\n', dirty: true });
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

				await store.applyPull({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				expect((await store.noteById('n1'))?.path).toBe('Archive/a.md');
				// An op left naming the old path writes to somewhere that no
				// longer exists — and on a provider that creates missing parents,
				// resurrects the folder the user just moved.
				const ops = await store.pendingOps();
				expect(ops.find((op) => op.seq === seq)?.path).toBe('Archive/a.md');
			});

			it('carries a remotely moved note’s queued ops with it', async () => {
				// `move-note` moves a note just as surely as `move-folder` does,
				// and an op left aimed at the path the note has left fails on
				// every attempt — which stops the ordered queue for every note,
				// not only this one.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', remoteId: 'r1' });
				const seq = await seedOp({
					op: 'move',
					noteId: 'n1',
					path: 'a.md',
					targetPath: 'renamed.md',
				});

				await store.applyPull({
					changes: [
						{ kind: 'move-note', id: 'n1', path: 'b.md', remote: remote('b.md', 'r1') },
					],
					cursor: 'c1',
				});

				const moved = (await store.pendingOps()).find((op) => op.seq === seq);
				expect(moved?.path).toBe('b.md');
			});

			it('carries a queued move’s target with it too', async () => {
				// `targetPath` is the half that says where the note is going, and
				// a store that rebases only `path` leaves the move aimed at a
				// folder that no longer exists. It then fails on every attempt,
				// and the ordered queue strands every op behind it — for every
				// note, not just this one.
				const { store, seed, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.md', content: 'x\n', remoteId: 'r1' });
				const seq = await seedOp({
					op: 'move',
					noteId: 'n1',
					path: 'Work/a.md',
					targetPath: 'Work/renamed.md',
				});

				await store.applyPull({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				const moved = (await store.pendingOps()).find((op) => op.seq === seq);
				expect(moved?.path).toBe('Archive/a.md');
				expect(moved?.targetPath).toBe('Archive/renamed.md');
			});

			it('does not clean a dirty note on the way', async () => {
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });

				await store.applyPull({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				expect((await store.noteById('n1'))?.dirty).toBe(true);
				expect((await store.noteById('n1'))?.content).toBe('mine\n');
			});

			it('can be found again by its remote id afterwards', async () => {
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await store.applyPull({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				expect((await store.folderByRemoteId('f1'))?.path).toBe('Archive');
			});
		});

		describe('a conflict', () => {
			const resolution = {
				noteId: 'n1',
				remoteContent: 'theirs\n',
				remoteHash: 'hash',
				remote: remote('a.md', 'r1', 'v2'),
				copyId: 'c1',
				copyPath: 'a (conflict 2026-09-15T14-32).md',
				copyContent: conflictContent('mine\n', 'c1'),
			};

			it('gives the remote the path and the local edit a note of its own', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyPull({ changes: [{ kind: 'conflict', resolution }], cursor: 'x' });

				expect((await store.noteById('n1'))?.content).toBe('theirs\n');
				expect((await store.noteById('n1'))?.dirty).toBe(false);
				expect((await store.noteById('c1'))?.content).toBe(conflictContent('mine\n', 'c1'));
				expect((await store.noteById('c1'))?.dirty).toBe(true);
			});

			it('queues the copy, because it exists nowhere else yet', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyPull({ changes: [{ kind: 'conflict', resolution }], cursor: 'x' });

				const ops = await store.pendingOps();
				expect(ops.map((op) => op.path)).toContain('a (conflict 2026-09-15T14-32).md');
			});

			it('drops the write the losing edit had queued', async () => {
				// That op carries the content the copy now holds, and the note
				// itself holds the remote's bytes. Replaying it writes the
				// remote's own content straight back to it under a new version,
				// which every other device pulls as a change that changed
				// nothing — and which can lose a race against a real edit made
				// between the two. The user's writing is not at risk: it is in
				// the copy, which is queued in its place.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });
				await store.applyPull({ changes: [{ kind: 'conflict', resolution }], cursor: 'x' });

				const ops = await store.pendingOps();
				expect(ops.some((op) => op.seq === seq)).toBe(false);
				expect(ops.map((op) => op.path)).toContain('a (conflict 2026-09-15T14-32).md');
			});

			it('leaves the user’s rename queued', async () => {
				// The conflict rule is about content. A queued `move` is the
				// user's own rename of the note, and nothing about the remote
				// winning the path makes it wrong to ask for it.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				const seq = await seedOp({
					op: 'move',
					noteId: 'n1',
					path: 'a.md',
					targetPath: 'b.md',
				});
				await store.applyPull({ changes: [{ kind: 'conflict', resolution }], cursor: 'x' });

				expect((await store.pendingOps()).some((op) => op.seq === seq)).toBe(true);
			});

			it('does not give the copy the remote the original had', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyPull({ changes: [{ kind: 'conflict', resolution }], cursor: 'x' });

				// Two notes pointing at one remote file means the next push has
				// them overwrite each other for ever.
				expect((await store.noteById('c1'))?.remoteId).toBeUndefined();
			});
		});

		describe('finishing an op', () => {
			it('records what landed and calls the note clean', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', dirty: true });
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });

				await store.completeOp(seq, {
					kind: 'pushed',
					noteId: 'n1',
					remote: remote('a.md', 'r9', 'v9'),
					content: 'x\n',
					syncedHash: 'hash',
				});

				const note = await store.noteById('n1');
				expect(note?.remoteId).toBe('r9');
				expect(note?.remoteVersion).toBe('v9');
				expect(note?.dirty).toBe(false);
				expect(await store.pendingOps()).toEqual([]);
			});

			it('leaves the note dirty when it changed while it was in flight', async () => {
				// The bytes that landed are not the bytes here. Calling this
				// clean is how the last thing the user typed disappears.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x and more\n', dirty: true });
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });

				await store.completeOp(seq, {
					kind: 'pushed',
					noteId: 'n1',
					remote: remote('a.md', 'r9', 'v9'),
					content: 'x\n',
					syncedHash: 'hash',
				});

				const note = await store.noteById('n1');
				expect(note?.dirty).toBe(true);
				expect(note?.content).toBe('x and more\n');
				// The version still has to be adopted, or the next push sends an
				// expectation the remote has already moved past.
				expect(note?.remoteVersion).toBe('v9');
			});

			it('does not touch the dirty flag after a move', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'b.md', content: 'x\n', remoteId: 'r1', dirty: true });
				const seq = await seedOp({
					op: 'move',
					noteId: 'n1',
					path: 'a.md',
					targetPath: 'b.md',
				});

				await store.completeOp(seq, {
					kind: 'moved',
					noteId: 'n1',
					remote: remote('b.md', 'r1', 'v2'),
				});

				const note = await store.noteById('n1');
				expect(note?.dirty).toBe(true);
				expect(note?.remoteVersion).toBe('v2');
			});

			it('drops the tombstone once the delete has landed', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', remoteId: 'r1' });
				const seq = await seedOp({ op: 'delete', noteId: 'n1', path: 'a.md' });

				await store.completeOp(seq, { kind: 'purged', noteId: 'n1' });

				expect(await store.noteById('n1')).toBeUndefined();
				expect(await store.pendingOps()).toEqual([]);
			});

			it('counts a failure without losing the op', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', dirty: true });
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });

				await store.failOp(seq, 'offline');

				const ops = await store.pendingOps();
				expect(ops).toHaveLength(1);
				expect(ops[0]?.attempts).toBe(1);
			});

			it('hands back one queued op as it stands, and nothing once it is done', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.md', content: 'x\n', dirty: true });
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });
				await store.failOp(seq, 'offline');

				expect(await store.opBySeq(seq)).toMatchObject({ seq, op: 'write', attempts: 1 });
				await store.completeOp(seq, { kind: 'done' });
				expect(await store.opBySeq(seq)).toBeUndefined();
			});

			it('hands back queued ops in the order they were made', async () => {
				const { store, seedOp } = await harness();
				const first = await seedOp({ op: 'mkdir', path: 'Work' });
				const second = await seedOp({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

				expect((await store.pendingOps()).map((op) => op.seq)).toEqual([first, second]);
			});
		});

		describe('resolveConflict', () => {
			it('leaves nothing behind when it refuses', async () => {
				// One transaction, like a pull batch: a copy id that is taken fails
				// the resolution after the note has already been rewritten, and the
				// rewrite must not survive it.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					dirty: true,
				});
				await seed({ id: 'c1', path: 'other.md', content: 'other\n' });
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });

				await expect(
					store.resolveConflict(seq, {
						noteId: 'n1',
						remoteContent: 'theirs\n',
						remoteHash: 'hash',
						remote: remote('a.md', 'r1', 'v2'),
						copyId: 'c1',
						copyPath: 'a (conflict).md',
						copyContent: conflictContent('mine\n', 'c1'),
					})
				).rejects.toThrow();

				expect((await store.noteById('n1'))?.content).toBe('mine\n');
				expect((await store.noteById('n1'))?.dirty).toBe(true);
				expect((await store.noteById('c1'))?.content).toBe('other\n');
				expect((await store.pendingOps()).map((op) => op.seq)).toEqual([seq]);
			});

			it('makes the folders above the path the remote takes', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });

				await store.resolveConflict(seq, {
					noteId: 'n1',
					remoteContent: 'theirs\n',
					remoteHash: 'hash',
					remote: remote('Moved/There/a.md', 'r1', 'v2'),
					copyId: 'c1',
					copyPath: 'a (conflict).md',
					copyContent: conflictContent('mine\n', 'c1'),
				});

				expect(await store.folderByPath('Moved')).toBeDefined();
				expect(await store.folderByPath('Moved/There')).toBeDefined();
			});

			it('finishes the op in the same breath as the copy', async () => {
				// Replaying it would overwrite the remote with the bytes the user
				// has just been handed a copy of.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.md',
					content: 'mine\n',
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', noteId: 'n1', path: 'a.md' });

				await store.resolveConflict(seq, {
					noteId: 'n1',
					remoteContent: 'theirs\n',
					remoteHash: 'hash',
					remote: remote('a.md', 'r1', 'v2'),
					copyId: 'c1',
					copyPath: 'a (conflict).md',
					copyContent: conflictContent('mine\n', 'c1'),
				});

				const ops = await store.pendingOps();
				expect(ops.find((op) => op.seq === seq)).toBeUndefined();
				expect(ops.map((op) => op.path)).toEqual(['a (conflict).md']);
				expect((await store.noteById('n1'))?.content).toBe('theirs\n');
				expect((await store.noteById('c1'))?.content).toBe(conflictContent('mine\n', 'c1'));
			});
		});
	});
};
