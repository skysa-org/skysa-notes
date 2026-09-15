import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../src/providers/types.js';
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

		describe('reading', () => {
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
						},
						{ kind: 'displace-note', id: 'ours', path: 'a (conflict x).md' },
					],
					cursor: 'c1',
				});

				expect((await store.noteById('ours'))?.content).toBe('mine\n');
				expect((await store.noteById('ours'))?.path).toBe('a (conflict x).md');
				expect((await store.noteByPath('a.md'))?.id).toBe('theirs');
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
				remote: remote('a.md', 'r1', 'v2'),
				copyId: 'c1',
				copyPath: 'a (conflict 2026-09-15T14-32).md',
				copyContent: 'mine\n',
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
				expect((await store.noteById('c1'))?.content).toBe('mine\n');
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

			it('hands back queued ops in the order they were made', async () => {
				const { store, seedOp } = await harness();
				const first = await seedOp({ op: 'mkdir', path: 'Work' });
				const second = await seedOp({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

				expect((await store.pendingOps()).map((op) => op.seq)).toEqual([first, second]);
			});
		});

		describe('resolveConflict', () => {
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
					remote: remote('a.md', 'r1', 'v2'),
					copyId: 'c1',
					copyPath: 'a (conflict).md',
					copyContent: 'mine\n',
				});

				const ops = await store.pendingOps();
				expect(ops.find((op) => op.seq === seq)).toBeUndefined();
				expect(ops.map((op) => op.path)).toEqual(['a (conflict).md']);
				expect((await store.noteById('n1'))?.content).toBe('theirs\n');
				expect((await store.noteById('c1'))?.content).toBe('mine\n');
			});
		});
	});
};
