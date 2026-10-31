import { beforeEach, describe, expect, it } from 'vitest';

import { contentHash } from '../../../src/hash.js';
import { conflictPath } from '../../../src/names/conflicts.js';
import { basename, isHidden } from '../../../src/paths.js';
import { createFakeProvider } from '../../../src/providers/fake.js';
import {
	AuthError,
	ConflictError,
	NotFoundError,
	RateLimitError,
	type StorageProvider,
} from '../../../src/providers/types.js';
import { AT, reporting } from '../kit/engine.js';
import { remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';

/**
 * Sending the queue: writes, moves and deletes, and what a push does when one
 * is interrupted, withdrawn, or finds its file or folder not where it was;
 * then our own changes coming back to us in the next pull (`push/drain`,
 * `push/notes`, and the folders and conflict names a write needs:
 * `push/folders`, `push/conflicts`).
 */
const { world, engineWith, pullNow, remoteFile, noteAt } = syncWorld();

describe('push', () => {
	it('creates a note that has never been pushed', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(world.store.ops()).toEqual([]);
	});

	it('sends the version it expects, so a racing write is caught', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'two\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		await world.engine.push();
		expect(world.provider.contentAt('a.md')).toBe('two\n');
	});

	it('leaves a note dirty when the user typed again mid-flight', async () => {
		// The bytes that landed are not the bytes on the device. Calling the note
		// clean here is exactly how a save disappears.
		world.store.put({ id: 'n1', path: 'a.md', content: 'first\n', dirty: true });
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		const original = world.store.completeOp;
		const engineWithEdit = engineWith({
			store: {
				...world.store,
				completeOp: async (seq, outcome) => {
					world.store.put({
						id: 'n1',
						path: 'a.md',
						content: 'first and more\n',
						dirty: true,
					});
					await original(seq, outcome);
				},
			},
		});

		await engineWithEdit.push();

		expect(op.seq).toBe(1);
		expect(noteAt('a.md')?.dirty).toBe(true);
		expect(noteAt('a.md')?.content).toBe('first and more\n');
	});

	it('re-creates a note whose remote copy was deleted', async () => {
		// §7's rule for a remote delete of a dirty note, arriving the other way round: the
		// push finds nothing there. The retry is a create, not an overwrite.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.delete(entry);

		await world.engine.push();

		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(noteAt('a.md')?.dirty).toBe(false);
	});

	it('writes the local edit aside when the push loses a race', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		const result = await world.engine.push();

		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
		expect(noteAt('a.md')?.content).toBe('theirs\n');
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).md']);
		expect(noteAt('a (conflict 2026-09-15T14-32).md')?.content).toContain('mine\n');
	});

	it('does not replay the op that conflicted', async () => {
		// Its content is safe in the copy; sending it again would overwrite the
		// remote with the very bytes the user has just been given a copy of.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		await world.engine.push();

		expect(world.store.ops().map((op) => op.path)).toEqual([
			'a (conflict 2026-09-15T14-32).md',
		]);
	});

	it('makes the folder before the note that goes in it', async () => {
		world.store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/a.md')).toBe('mine\n');
	});

	it('moves a note that already exists remotely', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();

		expect(world.provider.contentAt('b.md')).toBe('one\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
	});

	it('holds the version a move hands back only over bytes it has seen under it', async () => {
		// The fake gives a moved file a new version, as OneDrive does. It
		// is the version of whatever the move found, which nobody here has read.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();

		// Read, found to be the bytes last synced, and held under the version
		// they were read under.
		const read = await world.provider.read({ remoteId: entry.remoteId, path: 'b.md' });
		expect(noteAt('b.md')?.remoteVersion).toBe(read.version);
		expect(read.version).not.toBe(entry.version);
	});

	it('goes on holding the version it had when the moved file is not the one it synced', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		await world.engine.push();

		// Moved all the same: the rename is the user's, and takes no bytes.
		expect(world.provider.contentAt('b.md')).toBe('theirs\n');
		expect(noteAt('b.md')?.remoteVersion).toBe(entry.version);
		// So the pull does not take the file for one it has already seen.
		await world.engine.pull();
		expect(noteAt('b.md')?.content).toBe('theirs\n');
	});

	it('does the same when the moved file cannot be read, rather than failing a rename that landed', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'one\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		world.provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(noteAt('b.md')?.remoteVersion).toBe(entry.version);
	});

	it('deletes remotely and then drops the tombstone', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		await world.engine.push();

		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(world.store.notes()).toEqual([]);
	});

	it('treats a delete of something already gone as done', async () => {
		// The fake's `delete` is idempotent by contract, so deleting the file
		// first proves nothing — the call would succeed either way. A provider
		// that reports the missing file instead is the case that matters, and
		// it is the one Dropbox produces (`path_lookup/not_found`).
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'one\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });

		const strict = engineWith({
			provider: {
				...world.provider,
				delete: () => Promise.reject(new NotFoundError('a.md')),
			},
		});
		const result = await strict.push();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
	});

	it('stops at the op that failed rather than stepping over it', async () => {
		// The queue is ordered because later ops depend on earlier ones. Pushing
		// past a failure would write a note into a folder that was never made.
		world.store.put({ id: 'n1', path: 'Work/a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/a.md' });
		world.provider.setFault((call) =>
			call.op === 'createFolder' ? new Error('offline') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(2);
		expect(world.provider.contentAt('Work/a.md')).toBeUndefined();
	});

	describe('writing notes at once', () => {
		/**
		 * The provider, with each write and folder it is asked for logged as it
		 * starts and as it ends, a moment apart, so writes sent together are
		 * seen to overlap and ones sent in turn are seen not to.
		 */
		const logged = (base: StorageProvider) => {
			const events: string[] = [];
			const around =
				<A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) =>
				async (...args: A): Promise<R> => {
					events.push(`+${name}`);
					await new Promise((resolve) => setTimeout(resolve, 1));
					return call(...args).finally(() => {
						events.push(`-${name}`);
					});
				};
			return {
				events,
				provider: {
					...base,
					write: around('write', base.write),
					createFolder: around('mkdir', base.createFolder),
				},
			};
		};

		/** The most calls the log ever had out at once. */
		const most = (events: readonly string[]): number =>
			events.reduce(
				({ out, top }, event) => {
					const next = out + (event.startsWith('+') ? 1 : -1);
					return { out: next, top: Math.max(top, next) };
				},
				{ out: 0, top: 0 }
			).top;

		const queueNotes = (paths: readonly string[]) => {
			paths.forEach((path, at) => {
				world.store.put({ id: `n${String(at)}`, path, content: `${path}\n`, dirty: true });
				world.store.queue({ op: 'write', noteId: `n${String(at)}`, path });
			});
		};

		const pushing = (base: StorageProvider) => engineWith({ provider: base }).push();

		/** A provider that takes four at once, as Google Drive does. */
		beforeEach(async () => {
			world.provider = createFakeProvider({
				startAt: new Date('2026-01-01T00:00:00Z'),
				writesAtOnce: 4,
			});
			await world.provider.ensureRoot();
			world.engine = engineWith();
		});

		it('writes one at a time to a provider that does not say it takes more', async () => {
			// Dropbox locks its namespace for each write, and writes that meet
			// there are refused as a rate limit.
			const one = createFakeProvider({ startAt: new Date('2026-01-01T00:00:00Z') });
			await one.ensureRoot();
			queueNotes(['a.md', 'b.md', 'c.md']);
			const { events, provider: counted } = logged(one);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(most(events)).toBe(1);
		});

		it('makes a missing notebook once for the notes sent together', async () => {
			// Each finds it missing — deleted on another device while they had
			// edits — and on Drive, each making it made one apiece.
			queueNotes(['Work/a.md', 'Work/b.md', 'Work/c.md', 'Work/d.md']);
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(events.filter((event) => event === '+mkdir')).toHaveLength(1);
			expect(world.provider.contentAt('Work/d.md')).toBe('Work/d.md\n');
		});

		it('sends a note with a rename queued alone, so a name another gives up is free', async () => {
			// b→c, then a→b, both edited first. Sent together, the write of the
			// note going to b.md found the other still there and was set beside
			// it as a conflict, and the user's rename was lost.
			const first = await remoteFile('a.md', 'a\n');
			const second = await remoteFile('b.md', 'b\n');
			world.store.put({
				id: 'n1',
				path: 'b.md',
				content: 'a, edited\n',
				dirty: true,
				...boundTo(first),
				syncedHash: await contentHash('a\n'),
			});
			world.store.put({
				id: 'n2',
				path: 'c.md',
				content: 'b, edited\n',
				dirty: true,
				...boundTo(second),
				syncedHash: await contentHash('b\n'),
			});
			world.store.queue({ op: 'write', noteId: 'n2', path: 'b.md' });
			world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
			world.store.queue({ op: 'move', noteId: 'n2', path: 'b.md', targetPath: 'c.md' });
			world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([]);
			expect(world.provider.contentAt('b.md')).toBe('a, edited\n');
			expect(world.provider.contentAt('c.md')).toBe('b, edited\n');
			expect(world.store.notes().find((note) => note.id === 'n1')?.path).toBe('b.md');
		});

		it('writes up to four notes at once, and every one of them', async () => {
			// One at a time, a thousand notes on Google Drive took most of half
			// an hour, each waiting on the one before though none depends on
			// another.
			const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'];
			queueNotes(paths);
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(result.pushed).toBe(6);
			expect(most(events)).toBe(4);
			expect(world.store.ops()).toEqual([]);
			paths.forEach((path) => {
				expect(world.provider.contentAt(path)).toBe(`${path}\n`);
			});
		});

		it('makes a notebook alone, before the notes behind it', async () => {
			// What a later op can depend on goes in its turn, by itself: a note
			// sent beside its notebook's `mkdir` could reach the remote first.
			world.store.put({ id: 'n1', path: 'a.md', content: 'a\n', dirty: true });
			world.store.put({ id: 'n2', path: 'Work/b.md', content: 'b\n', dirty: true });
			world.store.put({ id: 'n3', path: 'Work/c.md', content: 'c\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
			world.store.queue({ op: 'mkdir', path: 'Work' });
			world.store.queue({ op: 'write', noteId: 'n2', path: 'Work/b.md' });
			world.store.queue({ op: 'write', noteId: 'n3', path: 'Work/c.md' });
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(events.slice(0, 4)).toEqual(['+write', '-write', '+mkdir', '-mkdir']);
			expect(most(events.slice(4))).toBe(2);
			expect(world.provider.contentAt('Work/c.md')).toBe('c\n');
		});

		it('stops where a write failed, and keeps what landed beside it', async () => {
			queueNotes(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
			world.provider.setFault((call) =>
				call.op === 'write' && call.path === 'b.md' ? new Error('offline') : undefined
			);

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			// The three sent with it are done. The one behind them was never
			// sent: the drain stopped at the failure, as it would have alone.
			expect(world.store.ops().map((op) => op.path)).toEqual(['b.md', 'e.md']);
			expect(world.store.ops()[0]?.attempts).toBe(1);
			expect(world.provider.contentAt('d.md')).toBe('d.md\n');
			expect(world.provider.contentAt('e.md')).toBeUndefined();
		});

		it('waits out a rate limit one of them met, without counting it', async () => {
			queueNotes(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
			world.provider.setFault((call) =>
				call.op === 'write' && call.path === 'c.md'
					? new RateLimitError('slow down', 4000)
					: undefined
			);

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			expect(result.retryAfterMs).toBe(4000);
			expect(world.store.ops().map((op) => op.path)).toEqual(['c.md', 'e.md']);
			expect(world.store.ops()[0]?.attempts).toBe(0);
		});

		it('waits out a rate limit met beside a conflict, rather than sending through it', async () => {
			// The conflict, handled first, let the drain go on, and the write
			// the provider had just told to wait went again at once.
			const entry = await remoteFile('a.md', 'one\n');
			world.store.put({
				id: 'n0',
				path: 'a.md',
				content: 'mine\n',
				dirty: true,
				...boundTo(entry),
			});
			world.store.put({ id: 'n1', path: 'b.md', content: 'b\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'n0', path: 'a.md' });
			world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
			await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
			const sent: string[] = [];
			world.provider.setFault((call) => {
				if (call.op !== 'write' || call.path === undefined) return undefined;
				sent.push(call.path);
				return call.path === 'b.md' ? new RateLimitError('slow down', 4000) : undefined;
			});

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			expect(result.retryAfterMs).toBe(4000);
			expect(sent.filter((path) => path === 'b.md')).toHaveLength(1);
			// Neither counted: the conflict is met again, and settled, next time.
			expect(world.store.ops().map((op) => [op.path, op.attempts])).toEqual([
				['a.md', 0],
				['b.md', 0],
			]);
		});

		it('refreshes once for writes sent together that met an expired token, and sends only those again', async () => {
			queueNotes(['a.md', 'b.md', 'c.md', 'd.md']);
			const sent = new Map<string, number>();
			let refreshed = 0;
			world.provider.setFault((call) => {
				if (call.op !== 'write' || call.path === undefined) return undefined;
				sent.set(call.path, (sent.get(call.path) ?? 0) + 1);
				return refreshed === 0 && (call.path === 'b.md' || call.path === 'c.md')
					? new AuthError('expired')
					: undefined;
			});
			const withAuth = engineWith({
				reauthorize: () => {
					refreshed += 1;
					return Promise.resolve();
				},
			});

			const result = await withAuth.push();

			expect(result.status).toBe('ok');
			expect(refreshed).toBe(1);
			expect(Object.fromEntries(sent)).toEqual({
				'a.md': 1,
				'b.md': 2,
				'c.md': 2,
				'd.md': 1,
			});
		});

		it('resolves a conflict one of them met, and goes on', async () => {
			const entry = await remoteFile('b.md', 'one\n');
			world.store.put({ id: 'n0', path: 'a.md', content: 'a\n', dirty: true });
			world.store.put({
				id: 'n1',
				path: 'b.md',
				content: 'mine\n',
				dirty: true,
				...boundTo(entry),
			});
			world.store.put({ id: 'n2', path: 'c.md', content: 'c\n', dirty: true });
			world.store.put({ id: 'n3', path: 'd.md', content: 'd\n', dirty: true });
			world.store.put({ id: 'n4', path: 'e.md', content: 'e\n', dirty: true });
			['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].forEach((path, at) => {
				world.store.queue({ op: 'write', noteId: `n${String(at)}`, path });
			});
			await world.provider.write('b.md', 'theirs\n', { expectedVersion: entry.version });

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toHaveLength(1);
			expect(world.provider.contentAt('b.md')).toBe('theirs\n');
			expect(world.provider.contentAt('e.md')).toBe('e\n');
		});
	});

	/**
	 * Two places ask the provider "is it still there?" by reading it and taking
	 * any rejection for a no. That is only true of a not-found. Everything else
	 * — a rate limit, an outage, a response the adapter could not make sense of
	 * — is the provider failing to answer, and a failure to answer read as "gone"
	 * does the one thing the question was asked to avoid.
	 */
	it('does not re-create a note because the provider would not say', async () => {
		// The file is at `moved.md` — renamed on another device — so `a.md` is
		// genuinely free and an `add` there would succeed. That is what makes the
		// probe load-bearing: the write finds nothing at the path, and the only
		// thing standing between the user and a second copy of their note is the
		// answer to "is it still there under the id we hold?".
		//
		// Only `read` faults, and not with a not-found: the provider is failing to
		// answer rather than answering. Taken for a no, the re-create runs and
		// succeeds, and the user has two notes where they had one.
		const seeded = await world.provider.write('moved.md', 'mine\n', {});
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			...boundTo(seeded),
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) =>
			call.op === 'read' ? new Error('service unavailable') : undefined
		);

		const result = await world.engine.push();

		// (`isHidden` drops the marker file, which `ensureRoot` writes and which
		// is a file like any other.)
		const notes = world.provider.snapshot().filter((entry) => !isHidden(entry.path));
		expect(notes.map((entry) => entry.path)).toEqual(['moved.md']);
		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(1);
	});

	it('does not discard a rename because the provider would not say', async () => {
		// Worse than the last one: `runMove` completes the op as done when it
		// decides the source is gone, so the user's rename goes with nothing
		// reported and nothing left to retry.
		const seeded = await world.provider.write('a.md', 'mine\n', {});
		world.store.put({
			id: 'n1',
			path: 'Work/a.md',
			content: 'mine\n',
			...boundTo(seeded),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'Work/a.md' });
		world.provider.setFault((call) => {
			if (call.op === 'move') return new NotFoundError('Work/a.md');
			return call.op === 'read' ? new Error('service unavailable') : undefined;
		});

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(1);
	});

	/**
	 * A rate limit is the one failure that says nothing about the op: the
	 * provider did not look at it. Counted like any other, five throttles in a
	 * row would block a write the remote never saw, and the user would be told
	 * their note cannot be sent.
	 */
	it('does not count a rate limit against the op', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down', 4000) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(0);
		expect(world.store.lastError(op.seq)).toBeUndefined();
		// And the wait the provider asked for reaches the caller, which is the
		// only thing that knows when to come back.
		expect(result.retryAfterMs).toBe(4000);
		expect(result.error).toContain('slow down');
	});

	it('says nothing about a wait when the provider named none', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		// Absent, not zero: the caller's own backoff is what applies.
		expect(result.retryAfterMs).toBeUndefined();
	});

	it('does not count a rate limit met while resolving a push conflict', async () => {
		// The conflict rule reads the remote entry before it can decide
		// anything, and that read is a request like any other. Counted under the
		// conflict's name, a provider throttling every read would spend the
		// write's attempts on a file it never looked at — and the wait it asked
		// for would be thrown away with it.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			...boundTo(entry),
		});
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		world.provider.setFault((call) =>
			call.op === 'read' ? new RateLimitError('slow down', 6000) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(0);
		expect(world.store.lastError(op.seq)).toBeUndefined();
		expect(result.retryAfterMs).toBe(6000);
		expect(result.error).toContain('slow down');
		// And nothing was decided: no conflict copy over a read that never came.
		expect(result.conflicts).toEqual([]);
		expect(world.store.notes().map((note) => note.path)).toEqual(['a.md']);
	});

	it('counts an ordinary failure met while resolving a push conflict', async () => {
		// The other half of the same rule: a resolution that fails for a reason
		// that is not a rate limit must still move the op's attempts, or it can
		// never reach `blocked` however long it goes on failing.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			dirty: true,
			...boundTo(entry),
		});
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });
		world.provider.setFault((call) =>
			call.op === 'read' ? new Error('read failed') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toContain('read failed');
	});

	it('still blocks an op that has already failed too often, rate limit or not', async () => {
		// The attempts rule is about what has happened, not about today's
		// failure: an op at the limit is surfaced before the provider is asked.
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md', attempts: 5 });
		world.provider.setFault(() => new RateLimitError('slow down', 1000));

		expect((await world.engine.push()).status).toBe('blocked');
	});

	it('carries the wait out of a pull that was rate limited', async () => {
		world.provider.setFault((call) =>
			call.op === 'changes' ? new RateLimitError('slow down', 9000) : undefined
		);

		const result = await world.engine.pull();

		expect(result.status).toBe('retry');
		expect(result.retryAfterMs).toBe(9000);
	});

	it('records the failure against the op it belongs to', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) => (call.op === 'write' ? new Error('offline') : undefined));

		await world.engine.push();

		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toBe('offline');
	});

	it('gives up on an op that has failed too many times', async () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md', attempts: 5 });

		const result = await world.engine.push();

		expect(result.status).toBe('blocked');
		expect(result.error).toContain('a.md');
	});

	it('skips an op whose note has been purged', async () => {
		world.store.queue({ op: 'write', noteId: 'gone', path: 'a.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('a move whose file is no longer there', () => {
	it('finishes rather than blocking the queue for ever', async () => {
		// The other device deleted the file between the rename and the push.
		// Nothing will ever make this move succeed, and the queue is ordered, so
		// failing it strands every op behind it — over a rename, which is the
		// least of what the user has waiting. The note keeps its contents; the
		// pull that reports the deletion cuts it loose or takes it away.
		const entry = await remoteFile('a.md', 'body\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'body\n',
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		world.store.put({ id: 'n2', path: 'c.md', content: 'behind it\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n2', path: 'c.md' });
		await world.provider.delete(entry);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		// And the op behind it got its turn.
		expect(world.provider.contentAt('c.md')).toBe('behind it\n');
	});
});

describe('a note the user is still typing into', () => {
	it('stays dirty when it changed while the push was in flight', async () => {
		// The store clears `dirty` only if the note still holds the bytes that
		// were sent, and the push is the only thing that knows which those were.
		// Reporting what the note holds *now* calls an edit that never left the
		// device saved, and the next remote change overwrites it.
		world.store.put({ id: 'mine', path: 'a.md', content: 'first\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'mine', path: 'a.md' });
		const whileTyping: StorageProvider = {
			...world.provider,
			write: async (path, content, opts) => {
				const entry = await world.provider.write(path, content, opts);
				world.store.put({
					id: 'mine',
					path: 'a.md',
					content: 'and then more\n',
					dirty: true,
				});
				return entry;
			},
		};

		const result = await engineWith({ provider: whileTyping }).push();

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')?.content).toBe('and then more\n');
		expect(noteAt('a.md')?.dirty).toBe(true);
	});
});

describe('a push interrupted after the write landed', () => {
	it('adopts the version instead of conflicting a note with itself', async () => {
		// The write reached the remote and the store could not be told before
		// the tab closed, so the op is still queued carrying a version the
		// remote has moved past. The retry conflicts — over bytes identical to
		// the ones it just sent. Pull has this rule; push needs it too.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });

		// The interruption: the write lands, the store never hears about it.
		const landed = await world.provider.write('a.md', 'edited\n', {
			expectedVersion: entry.version,
		});

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('a.md')?.remoteVersion).toBe(landed.version);
		expect(noteAt('a.md')?.dirty).toBe(false);
		expect(world.store.ops()).toEqual([]);
	});

	it('records the failure when the resolution itself cannot finish', async () => {
		// Reading the remote to resolve a conflict can fail in its own right.
		// Left uncounted, the op's `attempts` never moves and it can never reach
		// `blocked` however long it has been failing.
		const entry = await remoteFile('a.md', 'theirs\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'mine\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		const op = world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		world.provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toBeDefined();
	});
});

describe('a write whose file is not where it was', () => {
	it('waits for the rename rather than creating a second copy', async () => {
		// `write` is addressed by path, so a file renamed remotely is missing
		// from its old one and reports exactly what a deleted file reports. §7's
		// answer to a deleted file is to re-create it — which here would leave
		// the user with two notes where they had one, and the next pull would
		// import the stray as a third.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.move(entry, 'renamed.md');

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(
			world.provider.snapshot().filter((node) => node.kind === 'file' && !isHidden(node.path))
		).toHaveLength(1);
		expect(world.store.ops()).toHaveLength(1);

		// And the next sync finds out where it went. The fake changes a file's
		// version on a move, as OneDrive's eTag does and Dropbox's rev does not,
		// but the file still holds the bytes this note last synced — so it was
		// renamed, not edited, and the note follows it with its edit, which then
		// goes out to the new name. No copy (docs/ARCHITECTURE.md §7).
		const synced = await world.engine.sync();

		expect(synced.status).toBe('ok');
		expect(synced.conflicts).toEqual([]);
		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('renamed.md')).toMatchObject({ id: 'n1', content: 'edited\n', dirty: false });
		expect(world.provider.contentAt('renamed.md')).toBe('edited\n');
	});

	it('does the rename itself when the move is queued behind it', async () => {
		// The user edited a note and then renamed it, so the queue is a write
		// and then a move and the note's path is already the new one — which the
		// remote has never heard of. The write 404s, the file is still there
		// under the id we hold, and "wait for the next pull to rebase it" is an
		// answer to the wrong question: no pull will rebase a rename the remote
		// knows nothing about, and the ordered queue never reaches the move that
		// would fix it. The user's edit would sit here for ever, with every op
		// behind it.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.contentAt('b.md')).toBe('edited\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(noteAt('b.md')?.dirty).toBe(false);
	});

	it('waits out a rate limit met while reading the file it has just moved, and says so', async () => {
		// Not "has changed on the remote": nobody changed it, and an op failed
		// under that name spends an attempt on a throttle.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		// The first read finds the file by its id; the second is the one after
		// the move.
		world.provider.setFault((call) =>
			call.op === 'read' && call.attempt === 2
				? new RateLimitError('slow down', 3000)
				: undefined
		);

		const limited = await world.engine.push();

		expect(limited.retryAfterMs).toBe(3000);
		expect(world.store.ops()[0]?.attempts ?? 0).toBe(0);

		// And then the edit goes up over the file it was always for, as itself.
		world.provider.setFault(undefined);
		expect((await world.engine.push()).conflicts).toEqual([]);
		expect(world.provider.contentAt('b.md')).toBe('edited\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('keeps both where there is no record of what the note synced, rather than guess', async () => {
		// A dirty row from before the hash was kept. The moved file cannot be
		// told from one another device edited, so the write is not sent over it:
		// the remote keeps the path and the edit goes beside it. A copy nobody
		// needed, where the other guess is an edit nobody can get back.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();
		const result = await world.engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(world.provider.contentAt('b.md')).toBe('one\n');
		// The copy carries a frontmatter id of its own, and the words.
		expect(world.store.notes().some((note) => note.content.endsWith('edited\n'))).toBe(true);
		expect(world.store.ops().filter((op) => op.op === 'move')).toEqual([]);
	});

	it('makes the notebook the note was moved into, when the remote has not got it yet', async () => {
		// Edited, then dragged into a notebook made on this device. The `mkdir`
		// for it is queued, but behind the write, which gets there first — and a
		// provider answers the move into a folder that is not there with the
		// same not-found as a file that is not there. `runMove` asks which; this
		// has to as well, or the write fails the same way every time.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'Work/Inner/a.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'Work/Inner/a.md' });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'mkdir', path: 'Work/Inner' });
		world.store.queue({
			op: 'move',
			noteId: 'n1',
			path: 'a.md',
			targetPath: 'Work/Inner/a.md',
		});

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.contentAt('Work/Inner/a.md')).toBe('edited\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
	});

	it('does not move a file changed on the remote since the pull, to write over it', async () => {
		// Moved first, the write would be checked against the version the move
		// hands back rather than the one the note was in step with, and the
		// other device's edit would be gone with no conflict anywhere.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		await world.provider.write('a.md', 'theirs\n', { expectedVersion: entry.version });

		expect((await world.engine.push()).status).toBe('retry');
		expect(world.provider.contentAt('a.md')).toBe('theirs\n');
		expect(world.provider.contentAt('b.md')).toBeUndefined();

		// And the next pull answers it as the conflict it is: both kept.
		await world.engine.sync();
		const texts = [
			...world.store.notes().map((note) => note.content),
			...world.provider.snapshot().map((node) => world.provider.contentAt(node.path)),
		];
		expect(texts).toContain('theirs\n');
		expect(texts.some((text) => text?.includes('edited'))).toBe(true);
	});

	it('moves a note aside from a name taken while its rename was being followed', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		const other = await remoteFile('other.md', 'other\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		world.provider.setFault((call) =>
			call.op === 'move' ? new ConflictError({ ...other, path: 'b.md' }) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(result.conflicts).toEqual([]);
		const mine = world.store.notes().find((note) => note.id === 'n1');
		expect(mine).toMatchObject({ content: 'edited\n', remoteId: entry.remoteId });
		expect(mine?.path).toContain('conflict');
		expect(world.store.ops().find((op) => op.op === 'move')?.targetPath).toBe(mine?.path);
		expect(world.store.notes()).toHaveLength(1);
	});

	it('moves a note aside from a file it does not hold, at the name it was renamed to', async () => {
		// Another device wrote `b.md` after our pull. The write finds a file
		// there, and it is not this note's: its id says so. A conflict would give
		// this note that file's contents and id, and orphan its own file.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(entry),
			syncedHash: await contentHash('one\n'),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });
		const theirs = await remoteFile('b.md', 'other\n');

		await world.engine.push();
		await world.engine.sync();

		const mine = world.store.notes().find((note) => note.id === 'n1');
		expect(mine).toMatchObject({ content: 'edited\n', remoteId: entry.remoteId, dirty: false });
		expect(mine?.path).toContain('conflict');
		expect(world.provider.contentAt(mine?.path ?? '')).toBe('edited\n');
		expect(world.provider.contentAt('b.md')).toBe('other\n');
		expect(world.provider.contentAt('a.md')).toBeUndefined();
		expect(world.store.notes().find((note) => note.remoteId === theirs.remoteId)?.content).toBe(
			'other\n'
		);
	});

	it('steps aside to one conflict name, not two, when the first is taken on the remote', async () => {
		// A note that keeps a file of its own cannot take the name by writing
		// there, the way a note with none does \u2014 the path belongs to somebody
		// else's file and its own may be perfectly good. Chosen from the store
		// alone, the name another device took for its own copy in the same
		// minute is chosen anyway: the retry meets that file, steps the note
		// aside again from a name that already carries a suffix, and spends a
		// second of five attempts on it with the queue stopped behind.
		const mine = await remoteFile('a.md', 'one\n');
		await remoteFile('b.md', 'theirs\n');
		const theirCopy = conflictPath('b.md', AT);
		await remoteFile(theirCopy, 'somebody else\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		await world.engine.push();
		await world.engine.push();

		// One suffix, with the counter `conflictName` adds for a name taken in
		// the same minute \u2014 not `(conflict \u2026) (conflict \u2026)`.
		const note = world.store.notes().find((each) => each.id === 'n1');
		expect(note?.path).toBe(conflictPath('b.md', AT, [basename(theirCopy)]));
		// Still bound to its own file, and nothing of ours written or moved
		// onto either of theirs.
		expect(note?.remoteId).toBe(mine.remoteId);
		expect(world.provider.contentAt(theirCopy)).toBe('somebody else\n');
		expect(world.provider.contentAt('b.md')).toBe('theirs\n');
		// And the op was not stepped aside a second time: it is still aimed at
		// the one name the note was given.
		expect(world.store.ops().map((op) => op.path)).not.toContain(
			conflictPath(conflictPath('b.md', AT), AT)
		);
	});

	it('fails the op rather than step aside to a name it has not looked at', async () => {
		// A hundred names beside `b.md` taken in one minute is not a state a
		// user produces, but running out of tries must not answer it with the
		// next name unasked: that one is taken too, and the note displaced onto
		// it would stand on another note's path. It gives up instead, as
		// `freeFolderPath` does, and the op is left to be retried.
		const mine = await remoteFile('a.md', 'one\n');
		await remoteFile('b.md', 'theirs\n');
		const taken = Array.from({ length: 101 }).reduce<string[]>(
			(names) => [...names, basename(conflictPath('b.md', AT, names))],
			[]
		);
		taken.forEach((name, i) =>
			world.store.put({ id: `copy${i}`, path: name, content: 'copy\n' })
		);
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'b.md' });

		const result = await world.engine.push();

		// One attempt spent, on the op that met the name, and nothing moved.
		expect(result.status).toBe('retry');
		expect(world.store.ops().map((op) => op.attempts)).toEqual([1, 0]);
		expect(world.store.notes().find((each) => each.id === 'n1')?.path).toBe('b.md');
		expect(world.store.notes().filter((each) => each.path === taken.at(-1))).toHaveLength(1);
	});

	it('does the same with no rename queued to carry the file after it', async () => {
		// The same choice of name, reached without the queued `move` that lets
		// `followTheRename` move the file. What becomes of the op afterwards is
		// its own question \u2014 there is nothing here to move the file and the
		// write finds nothing at the new path \u2014 but the note is moved aside
		// once, to a name that is free on the remote, rather than twice.
		const mine = await remoteFile('a.md', 'one\n');
		await remoteFile('b.md', 'theirs\n');
		const theirCopy = conflictPath('b.md', AT);
		await remoteFile(theirCopy, 'somebody else\n');
		world.store.put({
			id: 'n1',
			path: 'b.md',
			content: 'edited\n',
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'b.md' });

		await world.engine.push();
		await world.engine.push();

		const note = world.store.notes().find((each) => each.id === 'n1');
		expect(note?.path).toBe(conflictPath('b.md', AT, [basename(theirCopy)]));
		expect(note?.remoteId).toBe(mine.remoteId);
		expect(note?.content).toBe('edited\n');
		expect(world.provider.contentAt(theirCopy)).toBe('somebody else\n');
	});

	it('answers a file replaced at the note\u2019s own path with the conflict rule, not by moving aside', async () => {
		// Deleted and written again — a new id at the same path — after our pull.
		// Moved aside, this note would keep its frontmatter id beside a file that
		// claims the same one. The conflict copy takes a fresh id instead.
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		await world.provider.delete(entry);
		await remoteFile('a.md', 'theirs\n');

		const result = await world.engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(world.store.notes().find((note) => note.id === 'n1')?.content).toBe('theirs\n');
		expect(world.store.notes().find((note) => note.id !== 'n1')?.content).toContain('edited');
	});

	it('is one note when the version survives the move, as Dropbox rev does', async () => {
		const entry = await remoteFile('a.md', 'one\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'edited\n',
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
		const moved = await world.provider.move(entry, 'renamed.md');

		// The one thing the fake models differently, fed in as Dropbox sends it.
		const stable = engineWith({
			provider: reporting(world.provider, [{ ...moved, version: entry.version }]),
		});
		await stable.pull();

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('renamed.md')?.content).toBe('edited\n');
		expect(noteAt('renamed.md')?.dirty).toBe(true);
	});
});

describe('a queued move whose destination folder is not on the remote yet', () => {
	it('makes the folder rather than dropping the rename', async () => {
		// The user made a notebook here and dragged a note into it. Nothing
		// queues a `mkdir` for a folder that has only ever been moved into, so
		// the `move` is the first thing to name it — and the provider answers
		// not found for a missing destination exactly as it does for a missing
		// source. Reading that as "the file is gone" completes the op and the
		// user's drag is lost with nothing said anywhere.
		const file = await remoteFile('x.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'Work/Deep/x.md',
			content: 'x\n',
			...boundTo(file),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'x.md', targetPath: 'Work/Deep/x.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/Deep/x.md')).toBe('x\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('still drops a move whose file is genuinely gone', async () => {
		const file = await remoteFile('x.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'x.md',
			content: 'x\n',
			...boundTo(file),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'x.md', targetPath: 'y.md' });
		await world.provider.delete(file);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.snapshot().some((entry) => entry.path === 'y.md')).toBe(false);
	});
});

describe('a write whose remote folder is gone', () => {
	it('makes the folder rather than blocking the queue for ever', async () => {
		// The ordinary case of a notebook deleted on another device while a note
		// inside it had unsaved work. The pull keeps that note and cuts it loose
		// — an unsaved edit outranks a remote deletion — which leaves nothing on
		// the remote above it. Every write then fails the same way, and the
		// ordered queue strands every op behind it for every note.
		const folder = await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await world.engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		world.store.put({ ...mine, content: 'my edit\n', dirty: true });
		world.store.queue({ op: 'write', noteId: mine.id, path: 'Work/a.md' });
		await world.provider.delete(folder);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/a.md')).toBe('my edit\n');
		expect(world.store.ops()).toEqual([]);
	});

	it('leaves a kept note a notebook to be in', async () => {
		// The cascade takes the folder rows on the way down. A note left at a
		// path with no notebook behind it is invisible in the sidebar while
		// still holding its name.
		const folder = await world.provider.createFolder('Work');
		await remoteFile('Work/a.md', 'x\n');
		await world.engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		world.store.put({ ...mine, content: 'my edit\n', dirty: true });
		await world.provider.delete(folder);

		await pullNow([{ path: 'Work', deleted: true, remoteId: folder.remoteId }]);

		expect(noteAt('Work/a.md')?.content).toBe('my edit\n');
		expect(world.store.folders().map((each) => each.path)).toEqual(['Work']);
	});

	it('does not leave a folder behind for a note that moved out of it', async () => {
		// The other half: the row is only wanted where a note actually ends up.
		const folder = await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.md', 'one\n');
		await world.engine.pull();
		const mine = noteAt('Work/a.md');
		if (mine === undefined) throw new Error('nothing at Work/a.md');
		world.store.put({ ...mine, content: 'mine\n', dirty: true });
		await world.provider.move(file, 'a.md');
		await world.provider.delete(folder);
		const out = remoteAt(world.provider, 'a.md');
		if (out === undefined) throw new Error('no file at a.md');

		await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.md', deleted: true, remoteId: file.remoteId },
			out,
		]);

		expect(world.store.folders()).toEqual([]);
	});
});

describe('a pull carrying our own echo of a rename we have not pushed', () => {
	it('leaves the note where the user put it', async () => {
		// The feed cannot say whose rename it is; the queue can. Moving the row
		// back undoes what the user just did in front of them, and frees the
		// path they renamed *to* — so a file arriving there in the same batch is
		// imported rather than displaced, and the queued move then conflicts on
		// that path for ever with the whole queue behind it.
		const file = await remoteFile('a.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'c.md',
			content: 'x\n',
			...boundTo(file),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'c.md' });
		const theirs = await remoteFile('c.md', 'theirs\n');

		await pullNow([file, theirs]);
		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		// Ours was displaced by theirs rather than moved back to `a.md`, and its
		// queued rename went with it.
		expect(noteAt('c.md')?.content).toBe('theirs\n');
		expect(world.store.notes().find((each) => each.id === 'n1')?.path).toContain('conflict');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('a queued rename onto a path the remote will not give up', () => {
	it('lands beside it instead of stranding the queue', async () => {
		const one = await remoteFile('x.md', 'one\n');
		const two = await remoteFile('y.md', 'two\n');
		world.store.put({
			id: 'n1',
			path: 'y.md',
			content: 'two\n',
			...boundTo(two),
		});
		world.store.put({
			id: 'n2',
			path: 'z.md',
			content: 'one\n',
			...boundTo(one),
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'y.md', targetPath: 'z.md' });
		await world.provider.move(one, 'z.md');

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.notes().find((each) => each.id === 'n1')?.path).toBe(
			conflictPath('z.md', AT)
		);
		expect(noteAt('z.md')?.id).toBe('n2');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('our own echo arriving with a new version', () => {
	it('still leaves a queued rename where the user put it', async () => {
		// The other half of the same rule. Here the version has moved on — our
		// own write coming back — so the bytes are read and found to match, and
		// the path still differs because the rename has not been pushed.
		const file = await remoteFile('a.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'c.md',
			content: 'x\n',
			remoteId: file.remoteId,
			remoteVersion: 'stale',
		});
		world.store.queue({ op: 'move', noteId: 'n1', path: 'a.md', targetPath: 'c.md' });

		await pullNow([file]);

		expect(world.store.notes().map((each) => each.path)).toEqual(['c.md']);
		expect(world.store.notes()[0]?.remoteVersion).toBe(file.version);
	});
});

describe('an op withdrawn after the queue was read', () => {
	it('is passed over, not sent', async () => {
		// The engine reads the queue once. A restore that withdraws a delete
		// while an earlier op is out would otherwise still delete the file.
		const kept = await remoteFile('a.md', 'keep\n');
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: 'keep\n',
			...boundTo(kept),
		});
		const remove = world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		const stale = await world.store.pendingOps();
		await world.store.completeOp(remove.seq, { kind: 'done' });

		const result = await engineWith({
			store: { ...world.store, pendingOps: () => Promise.resolve(stale) },
		}).push();

		expect(result).toMatchObject({ status: 'ok', pushed: 0 });
		expect(world.provider.callLog().filter((call) => call.op === 'delete')).toEqual([]);
		expect(world.provider.contentAt('a.md')).toBe('keep\n');
	});
});

describe('a write that finds nothing, with an unrelated rename queued', () => {
	it('does not rename the remote file to somewhere the user did not ask for', async () => {
		// `followTheRename` exists for the rename that *explains* the missing
		// path — one whose target is where the note now is. Any other queued
		// move says nothing about it, and acting on it moves the user's file
		// somewhere they never named.
		const file = await remoteFile('a.md', 'x\n');
		world.store.put({
			id: 'n1',
			path: 'c.md',
			content: 'mine\n',
			...boundTo(file),
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: 'c.md' });
		world.store.queue({ op: 'move', noteId: 'n1', path: 'c.md', targetPath: 'd.md' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.provider.snapshot().map((each) => each.path)).toContain('a.md');
		expect(world.provider.snapshot().map((each) => each.path)).not.toContain('c.md');
	});
});
