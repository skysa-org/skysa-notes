import { describe, expect, it } from 'vitest';

import { conflictFilePath, conflictPath } from '../../../src/names/conflicts.js';
import { basename } from '../../../src/paths.js';
import { createFakeProvider } from '../../../src/providers/fake.js';
import {
	AuthError,
	type ChangeEntry,
	ConflictError,
	CursorResetError,
	RateLimitError,
	type RemoteEntry,
	type StorageProvider,
} from '../../../src/providers/types.js';
import type { PullBatch, SyncNote, SyncStore } from '../../../src/sync/store.js';
import { AT, reporting } from '../kit/engine.js';
import { entryAt, remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { editHere } from '../kit/userActions.js';
import { syncWorld } from '../kit/world.js';

/**
 * Files that are not notes — pictures and attachments beside them, and text
 * that is not UTF-8: pushed, moved, pulled, duplicated, and gone by the time
 * they are read (`pull/files`, `push/files`, `pull/attachments`).
 */
const { world, engineWith, pullNow, remoteFile, killTheCursor, noteAt, pulledNote } = syncWorld();

describe('pushing a file', () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13]);
	const OTHER = new Uint8Array([1, 2, 3]);

	/** A file added here: its row, its bytes held until they go, and its upload. */
	const added = (path: string, attempts = 0) => {
		world.store.putFile(
			{ id: 'x1', path, size: PNG.byteLength },
			{ bytes: PNG.slice(), pinned: true }
		);
		return world.store.queue({ op: 'upload', fileId: 'x1', path, attempts });
	};

	/** A note behind the upload in the queue, to see whether it waited. */
	const noteBehind = () => {
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md' });
	};

	const creates = () =>
		world.provider.callLog().filter((call) => call.op === 'createFile').length;

	it('sends the bytes held here, and binds the row to what they made', async () => {
		added('a-1234abcd.png');

		const result = await world.engine.push();

		expect(result).toEqual({ status: 'ok', pulled: 0, pushed: 1, conflicts: [] });
		expect(world.provider.bytesAt('a-1234abcd.png')).toEqual(PNG);
		const made = remoteAt(world.provider, 'a-1234abcd.png');
		expect(world.store.files()).toEqual([
			{
				id: 'x1',
				path: 'a-1234abcd.png',
				remoteId: made?.remoteId,
				remoteVersion: made?.version,
				size: PNG.byteLength,
			},
		]);
		// Up now: kept as that version's, and no longer held for an upload.
		expect(world.store.heldBytes('x1')).toEqual({ bytes: PNG, version: made?.version });
		expect(world.store.ops()).toEqual([]);
	});

	it('makes the folders a file needs, from the top', async () => {
		added('Trips/2026/a.png');

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.bytesAt('Trips/2026/a.png')).toEqual(PNG);
	});

	it('tells the provider what kind of file it is, where it knows', async () => {
		const asked: (string | undefined)[] = [];
		const telling: StorageProvider = {
			...world.provider,
			createFile: (path, bytes, opts) => {
				asked.push(opts?.contentType);
				return world.provider.createFile(path, bytes, opts);
			},
		};
		added('a.png');
		world.store.putFile(
			{ id: 'x2', path: 'b.qqq', size: 3 },
			{ bytes: OTHER.slice(), pinned: true }
		);
		world.store.queue({ op: 'upload', fileId: 'x2', path: 'b.qqq' });

		await engineWith({ provider: telling }).push();

		expect(asked).toEqual(['image/png', undefined]);
	});

	it('takes the same file at its name for its own: a run that never heard back', async () => {
		const sent = await world.provider.createFile('a.png', PNG.slice());
		added('a.png');

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.snapshot().filter((entry) => entry.kind === 'file')).toHaveLength(2);
		expect(world.store.files()).toEqual([
			{
				id: 'x1',
				path: 'a.png',
				...boundTo(sent),
				size: PNG.byteLength,
			},
		]);
	});

	it.each([
		['a different file', () => world.provider.createFile('a.png', OTHER.slice())],
		['a folder', () => world.provider.createFolder('a.png')],
	])('goes beside %s at its name, keeping its extension', async (_what, occupy) => {
		// The remote keeps the path. The note that links the file is not
		// rewritten: it goes on naming what another device put there first.
		const there = await occupy();
		added('a.png');

		expect((await world.engine.push()).status).toBe('ok');
		const beside = conflictFilePath('a.png', AT);
		expect(beside).toMatch(/\.png$/u);
		expect(world.provider.bytesAt(beside)).toEqual(PNG);
		expect(remoteAt(world.provider, 'a.png')?.remoteId).toBe(there.remoteId);
		expect(world.store.files()).toEqual([expect.objectContaining({ id: 'x1', path: beside })]);
	});

	it('goes beside the same file where another row holds it', async () => {
		// Two rows on one file is a link the store cannot keep: the other one
		// is on its way out of that name, or not yet told it moved there.
		const theirs = await world.provider.createFile('a.png', PNG.slice());
		const other = {
			id: 'x0',
			path: 'Old/a.png',
			...boundTo(theirs),
			size: PNG.byteLength,
		};
		world.store.putFile(other);
		added('a.png');

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.store.files()).toEqual([
			expect.objectContaining({ id: 'x1', path: conflictFilePath('a.png', AT) }),
			other,
		]);
	});

	it('copies a file it does not hold from the remote file it copies', async () => {
		await world.provider.createFolder('Trips');
		const original = await world.provider.createFile('Trips/a.png', PNG.slice());
		world.store.putFile({
			id: 'x0',
			path: 'Trips/a.png',
			...boundTo(original),
			size: PNG.byteLength,
		});
		world.store.putFile({ id: 'x1', path: 'Work/a.png', size: PNG.byteLength });
		world.store.queue({
			op: 'upload',
			fileId: 'x1',
			path: 'Work/a.png',
			copyOf: original.remoteId,
		});

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.bytesAt('Work/a.png')).toEqual(PNG);
		expect(world.provider.bytesAt('Trips/a.png')).toEqual(PNG);
		expect(world.store.files().map((file) => file.remoteId)).toEqual([
			original.remoteId,
			remoteAt(world.provider, 'Work/a.png')?.remoteId,
		]);
	});

	it('lets a copy go that has nothing left to copy', async () => {
		world.store.putFile({ id: 'x1', path: 'Work/a.png', size: 8 });
		world.store.queue({ op: 'upload', fileId: 'x1', path: 'Work/a.png', copyOf: 'id:gone' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.files()).toEqual([]);
		expect(world.store.ops()).toEqual([]);
		expect(creates()).toBe(0);
	});

	it('sends nothing for a file deleted before it went, or one already up', async () => {
		world.store.queue({ op: 'upload', fileId: 'nope', path: 'a.png' });
		world.store.putFile({
			id: 'x2',
			path: 'b.png',
			remoteId: 'id:b',
			remoteVersion: 'v1',
			size: 3,
		});
		world.store.queue({ op: 'upload', fileId: 'x2', path: 'b.png' });

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.store.files()).toEqual([
			expect.objectContaining({ id: 'x2', remoteId: 'id:b' }),
		]);
		expect(creates()).toBe(0);
	});

	it('does not hold back what is queued behind an upload that fails', async () => {
		// 25 MB on a poor connection is no reason for a note's edit to wait.
		added('a.png');
		noteBehind();
		world.provider.setFault((call) =>
			call.op === 'createFile' ? new Error('offline') : undefined
		);

		const result = await world.engine.push();

		expect(result).toEqual(
			expect.objectContaining({
				status: 'retry',
				error: 'offline',
				pushed: 1,
				waitingUploads: 1,
			})
		);
		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(world.store.ops()).toEqual([expect.objectContaining({ op: 'upload', attempts: 1 })]);
	});

	it('steps over an upload out of attempts, keeps it, and says it is stuck', async () => {
		// The only copy of the file: never completed for having failed.
		added('a.png', 5);
		noteBehind();

		const result = await world.engine.push();

		expect(result).toEqual(
			expect.objectContaining({ status: 'blocked', pushed: 1, waitingUploads: 1 })
		);
		expect(result.error).toContain('upload a.png');
		expect(world.provider.contentAt('a.md')).toBe('mine\n');
		expect(world.store.ops()).toEqual([expect.objectContaining({ op: 'upload', attempts: 5 })]);
		expect(world.store.heldBytes('x1')?.pinned).toBe(true);
		expect(creates()).toBe(0);
	});

	it('says why a failing upload failed, over one out of attempts', async () => {
		// One stuck says wait for help; one failing says try again soon, which
		// is the sooner of the two.
		added('a.png', 5);
		world.store.putFile(
			{ id: 'x2', path: 'b.png', size: 3 },
			{ bytes: OTHER.slice(), pinned: true }
		);
		world.store.queue({ op: 'upload', fileId: 'x2', path: 'b.png' });
		world.provider.setFault((call) =>
			call.op === 'createFile' ? new Error('offline') : undefined
		);

		const result = await world.engine.push();

		expect(result).toEqual(
			expect.objectContaining({ status: 'retry', error: 'offline', waitingUploads: 2 })
		);
	});

	it('still stops for a rate limit on an upload, which is no fault of the upload', async () => {
		added('a.png');
		noteBehind();
		world.provider.setFault((call) =>
			call.op === 'createFile' ? new RateLimitError('slow down', 9000) : undefined
		);

		const result = await world.engine.push();

		expect(result).toEqual(
			expect.objectContaining({ status: 'retry', pushed: 0, retryAfterMs: 9000 })
		);
		expect(world.store.ops().map((op) => [op.op, op.attempts])).toEqual([
			['upload', 0],
			['write', 0],
		]);
	});

	it('holds back the delete of a file that a failed upload is still to copy', async () => {
		// The note moved and its file was copied, not held here; then the
		// notebook it came from was deleted. Sent first, the delete would leave
		// the copy nothing to read — OneDrive and Dropbox cannot read a deleted
		// file back by its id.
		await world.provider.createFolder('Trips');
		const original = await world.provider.createFile('Trips/a.png', PNG.slice());
		world.store.putFile({ id: 'x1', path: 'Work/a.png', size: PNG.byteLength });
		world.store.queue({
			op: 'upload',
			fileId: 'x1',
			path: 'Work/a.png',
			copyOf: original.remoteId,
		});
		world.store.queue({ op: 'delete-file', path: 'Trips/a.png', remoteId: original.remoteId });
		world.provider.setFault((call) =>
			call.op === 'createFile' ? new Error('offline') : undefined
		);

		expect((await world.engine.push()).status).toBe('retry');
		expect(world.provider.bytesAt('Trips/a.png')).toEqual(PNG);
		expect(world.store.ops().map((op) => [op.op, op.attempts])).toEqual([
			['upload', 1],
			['delete-file', 0],
		]);

		world.provider.setFault(undefined);
		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.bytesAt('Work/a.png')).toEqual(PNG);
		expect(remoteAt(world.provider, 'Trips/a.png')).toBeUndefined();
	});

	/** A copy of `Trips/a.png` the user made in `Work`, and the delete of the original. */
	const copiedThenDeleted = async () => {
		await world.provider.createFolder('Trips');
		const original = await world.provider.createFile('Trips/a.png', PNG.slice());
		world.store.putFile({ id: 'x1', path: 'Work/a.png', size: PNG.byteLength });
		world.store.queue({
			op: 'upload',
			fileId: 'x1',
			path: 'Work/a.png',
			copyOf: original.remoteId,
		});
		world.store.queue({ op: 'delete-file', path: 'Trips/a.png', remoteId: original.remoteId });
		return original;
	};

	const offline = () =>
		world.provider.setFault((call) =>
			call.op === 'createFile' ? new Error('offline') : undefined
		);

	it('still holds back the delete of what it copies through a conflict met in between', async () => {
		// A conflict resolved behind a stepped-over upload is an ordinary day.
		// Forgetting the upload there, the drain would send the delete, and the
		// copy would find nothing to read on its next try.
		await copiedThenDeleted();
		await remoteFile('n.md', 'theirs\n');
		world.store.put({ id: 'n1', path: 'n.md', content: 'mine\n', dirty: true });
		const write = world.store.queue({ op: 'write', noteId: 'n1', path: 'n.md' });
		const del = world.store.ops().find((op) => op.op === 'delete-file');
		if (del === undefined) throw new Error('no delete');
		// The write between the copy and the delete, as the user made them.
		world.store.unqueue(del.seq);
		world.store.queue({ op: 'delete-file', path: del.path, remoteId: del.remoteId });
		offline();

		const result = await world.engine.push();

		expect(write.seq).toBeLessThan(world.store.ops().at(-1)?.seq ?? 0);
		expect(result).toEqual(
			expect.objectContaining({ status: 'retry', error: 'offline', waitingUploads: 1 })
		);
		expect(result.conflicts).toHaveLength(1);
		expect(world.provider.bytesAt('Trips/a.png')).toEqual(PNG);

		world.provider.setFault(undefined);
		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.bytesAt('Work/a.png')).toEqual(PNG);
		expect(remoteAt(world.provider, 'Trips/a.png')).toBeUndefined();
	});

	it.each([
		['a rate limit', () => new RateLimitError('slow down', 9000), 'retry'],
		['an expired token', () => new AuthError('expired'), 'paused'],
		['a failure', () => new Error('refused'), 'retry'],
	])(
		'still says an upload is waiting when a write behind it meets %s',
		async (_what, fault, status) => {
			added('a.png');
			noteBehind();
			world.provider.setFault((call) =>
				call.op === 'createFile'
					? new Error('offline')
					: call.op === 'write'
						? fault()
						: undefined
			);

			const result = await world.engine.push();

			expect(result).toEqual(expect.objectContaining({ status, waitingUploads: 1 }));
		}
	);

	it('still says an upload is waiting when a write behind it is out of attempts', async () => {
		added('a.png');
		world.store.put({ id: 'n1', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: 'a.md', attempts: 5 });
		offline();

		const result = await world.engine.push();

		expect(result).toEqual(expect.objectContaining({ status: 'blocked', waitingUploads: 1 }));
		expect(result.error).toContain('write a.md');
	});

	it('sends the edits queued behind an upload that has failed before ahead of its next try', async () => {
		// Its first try keeps its place, so a file lands ahead of the note that
		// links it. Once it has failed, the note's edits do not wait out every
		// further try of 25 MB on the connection that failed it.
		added('a.png', 1);
		noteBehind();

		expect((await world.engine.push()).status).toBe('ok');
		expect(
			world.provider
				.callLog()
				.filter((call) => call.op === 'createFile' || call.op === 'write')
				.map((call) => call.op)
		).toEqual(['write', 'createFile']);
	});

	it('keeps a copy whose original could not be read just now', async () => {
		// Only "not found" says there is nothing left to copy. Anything else
		// is tried again, and the row is the only thing that says to.
		await copiedThenDeleted();
		world.provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await world.engine.push();

		expect(result).toEqual(expect.objectContaining({ status: 'retry', waitingUploads: 1 }));
		expect(world.store.files()).toEqual([
			{ id: 'x1', path: 'Work/a.png', size: PNG.byteLength },
		]);
		expect(world.store.ops().map((op) => [op.op, op.attempts])).toEqual([
			['upload', 1],
			['delete-file', 0],
		]);
	});

	it('lets a file go that has nothing here and copies nothing', async () => {
		world.store.putFile({ id: 'x1', path: 'a.png', size: 8 });
		world.store.queue({ op: 'upload', fileId: 'x1', path: 'a.png' });

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.store.files()).toEqual([]);
		expect(world.store.ops()).toEqual([]);
		expect(creates()).toBe(0);
	});

	it('finds a free name beside two files from one listing, sending its bytes twice in all', async () => {
		// Dropbox and OneDrive take the whole body before they say a name is
		// taken: trying each conflict name in turn would send 25 MB a try.
		const first = conflictFilePath('a.png', AT);
		await world.provider.createFile('a.png', OTHER.slice());
		await world.provider.createFile(first, OTHER.slice());
		added('a.png');
		const before = creates();

		expect((await world.engine.push()).status).toBe('ok');
		const beside = conflictFilePath('a.png', AT, [basename(first)]);
		expect(beside).not.toBe(first);
		expect(world.provider.bytesAt(beside)).toEqual(PNG);
		expect(creates() - before).toBe(2);
		expect(world.store.files()).toEqual([expect.objectContaining({ id: 'x1', path: beside })]);
	});

	it('does not go beside at a name a file here still holds, sent or not', async () => {
		const first = conflictFilePath('a.png', AT);
		world.store.putFile(
			{ id: 'x0', path: first, size: 3 },
			{ bytes: OTHER.slice(), pinned: true }
		);
		await world.provider.createFile('a.png', OTHER.slice());
		added('a.png');
		world.store.queue({ op: 'upload', fileId: 'x0', path: first });

		expect((await world.engine.push()).status).toBe('ok');
		const beside = conflictFilePath('a.png', AT, [basename(first)]);
		expect(world.store.files().map((file) => [file.id, file.path])).toEqual([
			['x1', beside],
			['x0', first],
		]);
		expect(world.provider.bytesAt(first)).toEqual(OTHER);
		expect(world.provider.bytesAt(beside)).toEqual(PNG);
	});

	it('gives up on a name after so many, and tries again later', async () => {
		// A provider that never stops saying "taken" is spending a request, and
		// up to 25 MB, a turn.
		added('a.png');
		const always: StorageProvider = {
			...world.provider,
			createFile: async (path) => {
				const there = await world.provider.createFile(`${path}.x`, OTHER.slice());
				return Promise.reject(new ConflictError({ ...there, path }));
			},
		};

		const result = await engineWith({ provider: always }).push();

		expect(result).toEqual(expect.objectContaining({ status: 'retry', waitingUploads: 1 }));
		expect(world.provider.snapshot().filter((entry) => entry.path.endsWith('.x'))).toHaveLength(
			9
		);
		expect(world.store.ops()).toEqual([expect.objectContaining({ op: 'upload', attempts: 1 })]);
	});

	it('does not take a file for its own that a queued delete is to take', async () => {
		// Its row gone, its delete still owed: the row that took it would be
		// bound to nothing once the delete went, and its bytes let go.
		const there = await world.provider.createFile('a.png', PNG.slice());
		added('a.png');
		world.store.queue({ op: 'delete-file', path: 'a.png', remoteId: there.remoteId });

		expect((await world.engine.push()).status).toBe('ok');
		const beside = conflictFilePath('a.png', AT);
		expect(remoteAt(world.provider, 'a.png')).toBeUndefined();
		expect(world.provider.bytesAt(beside)).toEqual(PNG);
		expect(world.store.files()).toEqual([
			expect.objectContaining({
				id: 'x1',
				path: beside,
				remoteId: remoteAt(world.provider, beside)?.remoteId,
			}),
		]);
	});

	it('holds an upload to where a held-back delete is still to clear the way', async () => {
		// The notebook deleted, made again, and the same picture added: sent
		// now, it would meet the file on its way out and go beside it, away
		// from the name the note links.
		const original = await copiedThenDeleted();
		world.store.putFile(
			{ id: 'x2', path: 'Trips/a.png', size: PNG.byteLength },
			{ bytes: PNG.slice(), pinned: true }
		);
		world.store.queue({ op: 'upload', fileId: 'x2', path: 'Trips/a.png' });
		// Only the copy fails: the upload behind it would go, if let.
		world.provider.setFault((call) =>
			call.op === 'createFile' && call.path === 'Work/a.png'
				? new Error('offline')
				: undefined
		);

		const result = await world.engine.push();

		expect(result).toEqual(expect.objectContaining({ status: 'retry', waitingUploads: 2 }));
		expect(world.provider.snapshot().filter((entry) => entry.path.endsWith('.png'))).toEqual([
			expect.objectContaining({ path: 'Trips/a.png', remoteId: original.remoteId }),
		]);

		world.provider.setFault(undefined);
		expect((await world.engine.push()).status).toBe('ok');
		const made = remoteAt(world.provider, 'Trips/a.png');
		expect(made?.remoteId).not.toBe(original.remoteId);
		expect(world.store.files()).toEqual([
			expect.objectContaining({ id: 'x2', path: 'Trips/a.png', remoteId: made?.remoteId }),
			expect.objectContaining({ id: 'x1', path: 'Work/a.png' }),
		]);
		expect(world.store.ops()).toEqual([]);
	});

	it('holds back the delete of what a held copy is still to copy', async () => {
		// Held, a copy is as owed as one stepped over, and what it copies must
		// stay readable until it goes.
		await copiedThenDeleted();
		await world.provider.createFolder('Home');
		const other = await world.provider.createFile('Home/a.png', PNG.slice());
		world.store.putFile({ id: 'x2', path: 'Trips/a.png', size: PNG.byteLength });
		world.store.queue({
			op: 'upload',
			fileId: 'x2',
			path: 'Trips/a.png',
			copyOf: other.remoteId,
		});
		world.store.queue({ op: 'delete-file', path: 'Home/a.png', remoteId: other.remoteId });
		offline();

		expect((await world.engine.push()).status).toBe('retry');
		expect(world.provider.bytesAt('Home/a.png')).toEqual(PNG);

		world.provider.setFault(undefined);
		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.bytesAt('Trips/a.png')).toEqual(PNG);
		expect(remoteAt(world.provider, 'Home/a.png')).toBeUndefined();
	});

	it('knows the same file by the size of what it sends', async () => {
		// A copy reads its bytes from the remote; the row's size is only what
		// it was told.
		await world.provider.createFolder('Trips');
		const original = await world.provider.createFile('Trips/a.png', PNG.slice());
		await world.provider.createFolder('Work');
		const there = await world.provider.createFile('Work/a.png', PNG.slice());
		world.store.putFile({ id: 'x1', path: 'Work/a.png', size: 999 });
		world.store.queue({
			op: 'upload',
			fileId: 'x1',
			path: 'Work/a.png',
			copyOf: original.remoteId,
		});

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.store.files()).toEqual([
			expect.objectContaining({ id: 'x1', path: 'Work/a.png', remoteId: there.remoteId }),
		]);
	});

	it('holds the removal of a notebook a held-back delete has a file in still', async () => {
		// Sent now, it would find the file and leave the directory for good:
		// an empty notebook, once the delete lands.
		await copiedThenDeleted();
		const trips = remoteAt(world.provider, 'Trips');
		world.store.queue({ op: 'rmdir', path: 'Trips', remoteId: trips?.remoteId });
		offline();

		expect((await world.engine.push()).status).toBe('retry');
		expect(world.store.ops().map((op) => op.op)).toEqual(['upload', 'delete-file', 'rmdir']);

		world.provider.setFault(undefined);
		expect((await world.engine.push()).status).toBe('ok');
		expect(remoteAt(world.provider, 'Trips')).toBeUndefined();
	});
});

describe('moving a file', () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13]);

	/** A file in `Trips` the user has moved to `Work/a.png`, the move queued. */
	const movedHere = async () => {
		await world.provider.createFolder('Trips');
		const file = await world.provider.createFile('Trips/a.png', PNG.slice());
		world.store.putFile({
			id: 'x1',
			path: 'Work/a.png',
			...boundTo(file),
			size: PNG.byteLength,
		});
		world.store.queue({
			op: 'move-file',
			fileId: 'x1',
			path: 'Trips/a.png',
			targetPath: 'Work/a.png',
		});
		return file;
	};

	it('moves it, into a folder it makes, and records where it landed', async () => {
		const file = await movedHere();

		expect((await world.engine.push()).status).toBe('ok');
		const landed = remoteAt(world.provider, 'Work/a.png');
		expect(landed?.remoteId).toBe(file.remoteId);
		expect(remoteAt(world.provider, 'Trips/a.png')).toBeUndefined();
		expect(world.store.files()).toEqual([
			{
				id: 'x1',
				path: 'Work/a.png',
				remoteId: file.remoteId,
				remoteVersion: landed?.version,
				size: PNG.byteLength,
			},
		]);
		expect(world.store.ops()).toEqual([]);
	});

	it('asks the folder, not the file, whether it is still there', async () => {
		// Reading the file to find out would be to download it: 25 MB, for a
		// yes or a no.
		await movedHere();

		await world.engine.push();

		expect(world.provider.callLog().filter((call) => call.op === 'read')).toEqual([]);
	});

	it('lets a move go whose file is gone from where it was', async () => {
		const file = await movedHere();
		await world.provider.delete(file);

		expect((await world.engine.push()).status).toBe('ok');
		expect(remoteAt(world.provider, 'Work')).toBeUndefined();
		expect(world.store.ops()).toEqual([]);
		expect(world.store.files()[0]?.remoteId).toBe(file.remoteId);
	});

	it('takes the same file at the name for its own, and leaves the one it moved', async () => {
		// Copied there on another device, which kept a note linking the one in
		// `Trips`: taking that one would take the note's picture.
		const file = await movedHere();
		await world.provider.createFolder('Work');
		const there = await world.provider.createFile('Work/a.png', PNG.slice());

		expect((await world.engine.push()).status).toBe('ok');
		expect(remoteAt(world.provider, 'Trips/a.png')?.remoteId).toBe(file.remoteId);
		expect(world.store.files()).toEqual([
			expect.objectContaining({ path: 'Work/a.png', remoteId: there.remoteId }),
		]);
	});

	it('goes beside a different file at the name, keeping its extension', async () => {
		const file = await movedHere();
		await world.provider.createFolder('Work');
		const there = await world.provider.createFile('Work/a.png', new Uint8Array([1]));

		expect((await world.engine.push()).status).toBe('ok');
		const beside = conflictFilePath('Work/a.png', AT);
		expect(remoteAt(world.provider, beside)?.remoteId).toBe(file.remoteId);
		expect(remoteAt(world.provider, 'Work/a.png')?.remoteId).toBe(there.remoteId);
		expect(world.store.files()).toEqual([expect.objectContaining({ id: 'x1', path: beside })]);
	});

	it('takes its own file at the name for a move that landed unheard', async () => {
		// A provider that answers a move to where the file already is with a
		// conflict naming the file itself.
		const file = await movedHere();
		await world.provider.createFolder('Work');
		await world.provider.move(file, 'Work/a.png');
		const strict: StorageProvider = {
			...world.provider,
			move: (ref, path) => {
				const there = remoteAt(world.provider, path);
				return there === undefined
					? world.provider.move(ref, path)
					: Promise.reject(new ConflictError(there));
			},
		};

		const result = await engineWith({ provider: strict }).push();

		expect(result.status).toBe('ok');
		expect(world.store.files()).toEqual([
			expect.objectContaining({ path: 'Work/a.png', remoteId: file.remoteId }),
		]);
		expect(world.provider.snapshot().filter((entry) => entry.kind === 'file')).toHaveLength(2);
	});

	it('goes beside the same file where another row holds it', async () => {
		// Two rows on one file is a link the store cannot keep.
		const file = await movedHere();
		await world.provider.createFolder('Work');
		const there = await world.provider.createFile('Work/a.png', PNG.slice());
		const other = {
			id: 'x0',
			path: 'Old/a.png',
			...boundTo(there),
			size: PNG.byteLength,
		};
		world.store.putFile(other);

		expect((await world.engine.push()).status).toBe('ok');
		const beside = conflictFilePath('Work/a.png', AT);
		expect(remoteAt(world.provider, beside)?.remoteId).toBe(file.remoteId);
		expect(world.store.files()).toEqual([
			other,
			expect.objectContaining({ id: 'x1', path: beside }),
		]);
	});

	it('holds a move to where a held-back delete is still to clear the way', async () => {
		// The same picture moved into a notebook made again where one was
		// deleted: sent now, it would meet the file on its way out.
		const file = await movedHere();
		await world.provider.createFolder('Work');
		const old = await world.provider.createFile('Work/a.png', PNG.slice());
		world.store.putFile({ id: 'x0', path: 'Home/a.png', size: PNG.byteLength });
		world.store.unqueue(world.store.ops()[0]?.seq ?? 0);
		world.store.queue({ op: 'upload', fileId: 'x0', path: 'Home/a.png', copyOf: old.remoteId });
		world.store.queue({ op: 'delete-file', path: 'Work/a.png', remoteId: old.remoteId });
		world.store.queue({
			op: 'move-file',
			fileId: 'x1',
			path: 'Trips/a.png',
			targetPath: 'Work/a.png',
		});
		world.provider.setFault((call) =>
			call.op === 'createFile' ? new Error('offline') : undefined
		);

		expect((await world.engine.push()).status).toBe('retry');
		expect(remoteAt(world.provider, 'Trips/a.png')?.remoteId).toBe(file.remoteId);

		world.provider.setFault(undefined);
		expect((await world.engine.push()).status).toBe('ok');
		expect(remoteAt(world.provider, 'Work/a.png')?.remoteId).toBe(file.remoteId);
		expect(world.store.files()).toEqual([
			expect.objectContaining({ id: 'x0', path: 'Home/a.png' }),
			expect.objectContaining({ id: 'x1', path: 'Work/a.png', remoteId: file.remoteId }),
		]);
	});

	it('moves nothing for a file deleted here, or one never sent', async () => {
		world.store.queue({ op: 'move-file', fileId: 'nope', path: 'a.png', targetPath: 'b.png' });
		world.store.putFile({ id: 'x2', path: 'd.png', size: 3 });
		world.store.queue({ op: 'move-file', fileId: 'x2', path: 'c.png', targetPath: 'd.png' });

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.callLog().filter((call) => call.op === 'move')).toEqual([]);
	});
});

describe('pulling a file that is not a note', () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13]);
	const OTHER = new Uint8Array([1, 2, 3]);
	const opsNow = () => world.store.ops().map(({ seq: _seq, attempts: _attempts, ...op }) => op);

	it('mirrors it as a row, bound, of its size, without reading a byte', async () => {
		await world.provider.createFolder('Trips');
		const file = await world.provider.createFile('Trips/a.png', PNG.slice());

		const result = await world.engine.pull();

		expect(result).toMatchObject({ status: 'ok', pulled: 2 });
		expect(world.store.files()).toEqual([
			{
				id: 'copy-1',
				path: 'Trips/a.png',
				...boundTo(file),
				size: PNG.byteLength,
			},
		]);
		expect(world.store.heldBytes('copy-1')).toBeUndefined();
		expect(world.provider.callLog().filter((call) => call.op === 'read')).toEqual([]);
	});

	it('follows it where it is moved, and as it is replaced, and says nothing of an echo', async () => {
		const file = await world.provider.createFile('a.png', PNG.slice());
		await world.engine.pull();
		await world.provider.createFolder('Trips');
		await world.provider.move(file, 'Trips/a.png');
		world.provider.plantBytes('Trips/a.png', OTHER);

		await world.engine.pull();
		const now = entryAt(world.provider, 'Trips/a.png');
		expect(world.store.files()).toEqual([
			{
				id: 'copy-1',
				path: 'Trips/a.png',
				remoteId: file.remoteId,
				remoteVersion: now.version,
				size: OTHER.byteLength,
			},
		]);

		expect(await pullNow([now])).toMatchObject({ status: 'ok', pulled: 0 });
	});

	it.each([
		['by its id', (id: string) => ({ deleted: true as const, remoteId: id, path: 'a.png' })],
		['by its path alone', () => ({ deleted: true as const, path: 'a.png' })],
	])('lets go of it when it is deleted %s', async (_how, deletion) => {
		const file = await world.provider.createFile('a.png', PNG.slice());
		await world.engine.pull();

		await pullNow([deletion(file.remoteId)]);

		expect(world.store.files()).toEqual([]);
	});

	it('takes a deletion followed by the file somewhere else for a move', async () => {
		// Dropbox's way of telling a move: the old path, and the new place.
		const file = await world.provider.createFile('a.png', PNG.slice());
		await world.engine.pull();

		await pullNow([
			{ deleted: true, path: 'a.png' },
			{ ...file, path: 'b.png' },
		]);

		expect(world.store.files()).toEqual([
			expect.objectContaining({ id: 'copy-1', path: 'b.png', remoteId: file.remoteId }),
		]);
	});

	it('lets go of a row whose file is no longer at its path, for the one that is', async () => {
		// Replaced while the cursor slept, its deletion never told.
		const old = await world.provider.createFile('a.png', PNG.slice());
		await world.engine.pull();
		await world.provider.delete(old);
		const replaced = await world.provider.createFile('a.png', OTHER.slice());

		await pullNow([replaced]);

		expect(world.store.files()).toEqual([
			expect.objectContaining({ path: 'a.png', remoteId: replaced.remoteId }),
		]);
	});

	it('keeps the row, and its bytes, of a file the round moves on after another took its place', async () => {
		const file = await world.provider.createFile('a.png', PNG.slice());
		await world.engine.pull();
		world.store.putFile(world.store.files()[0] ?? { id: '', path: '', size: 0 }, {
			bytes: PNG.slice(),
			version: file.version,
		});
		await world.provider.move(file, 'b.png');
		const other = await world.provider.createFile('a.png', OTHER.slice());

		await pullNow([other, entryAt(world.provider, 'b.png')]);

		expect(world.store.files()).toEqual([
			expect.objectContaining({ path: 'a.png', remoteId: other.remoteId }),
			expect.objectContaining({ id: 'copy-1', path: 'b.png', remoteId: file.remoteId }),
		]);
		expect(world.store.heldBytes('copy-1')?.bytes).toEqual(PNG);
	});

	it('keeps the row, and its bytes, of a file moved out of a notebook deleted in the same round', async () => {
		// As the subfolders a deletion rescues: taken by the cascade, it would
		// come back as a new row with nothing held.
		const folder = await world.provider.createFolder('Trips');
		const file = await world.provider.createFile('Trips/a.png', PNG.slice());
		await world.engine.pull();
		world.store.putFile(world.store.files()[0] ?? { id: '', path: '', size: 0 }, {
			bytes: PNG.slice(),
			version: file.version,
		});
		await world.provider.move(file, 'a.png');
		await world.provider.delete(folder);

		await pullNow([
			{ deleted: true, remoteId: folder.remoteId, path: 'Trips' },
			entryAt(world.provider, 'a.png'),
		]);

		expect(world.store.files()).toEqual([
			expect.objectContaining({ id: 'copy-1', path: 'a.png', remoteId: file.remoteId }),
		]);
		expect(world.store.heldBytes('copy-1')?.bytes).toEqual(PNG);
	});

	it('lets go of a row whose file was deleted out of a folder the same round moves', async () => {
		// Dropbox's way: the folder's new place, and the old path of the file.
		const folder = await world.provider.createFolder('Trips');
		const file = await world.provider.createFile('Trips/a.png', PNG.slice());
		await world.engine.pull();
		await world.provider.delete(file);
		await world.provider.move(folder, 'Holidays');

		await pullNow([
			entryAt(world.provider, 'Holidays'),
			{ deleted: true, path: 'Trips/a.png' },
		]);

		expect(world.store.files()).toEqual([]);
		expect(world.store.folders().map((each) => each.path)).toEqual(['Holidays']);
	});

	describe('beside a file added here', () => {
		const added = (path = 'a.png') => {
			world.store.putFile(
				{ id: 'x1', path, size: PNG.byteLength },
				{ bytes: PNG.slice(), pinned: true }
			);
			world.store.queue({ op: 'upload', fileId: 'x1', path });
		};

		it('takes the same file at its path for the one it is uploading, and owes nothing', async () => {
			// The upload landed and its answer never came back; or the same
			// picture was added on another device.
			added();
			const there = await world.provider.createFile('a.png', PNG.slice());

			await world.engine.pull();

			expect(world.store.files()).toEqual([
				{
					id: 'x1',
					path: 'a.png',
					...boundTo(there),
					size: PNG.byteLength,
				},
			]);
			expect(world.store.heldBytes('x1')).toEqual({ bytes: PNG, version: there.version });
			expect(world.store.ops()).toEqual([]);
		});

		it('moves it aside for a different file at its path, and its upload with it', async () => {
			added();
			const there = await world.provider.createFile('a.png', OTHER.slice());

			await world.engine.pull();

			const aside = conflictFilePath('a.png', AT);
			expect(world.store.files()).toEqual([
				{ id: 'x1', path: aside, size: PNG.byteLength },
				expect.objectContaining({ path: 'a.png', remoteId: there.remoteId }),
			]);
			expect(opsNow()).toEqual([{ op: 'upload', fileId: 'x1', path: aside }]);

			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.bytesAt(aside)).toEqual(PNG);
			expect(world.provider.bytesAt('a.png')).toEqual(OTHER);
		});

		it('steps aside to a name the round is not bringing in', async () => {
			// The name it would have taken is the next entry's.
			added();
			const there = await world.provider.createFile('a.png', OTHER.slice());
			const first = conflictFilePath('a.png', AT);
			const theirs = await world.provider.createFile(first, OTHER.slice());

			await pullNow([there, theirs]);

			const aside = conflictFilePath('a.png', AT, [basename(first)]);
			expect(world.store.files().map((file) => [file.path, file.remoteId])).toEqual([
				[aside, undefined],
				[first, theirs.remoteId],
				['a.png', there.remoteId],
			]);
		});

		it('is not moved aside for a file the user is deleting there', async () => {
			// The delete goes first, and then the upload, to the name it has.
			const file = await world.provider.createFile('a.png', PNG.slice());
			await world.engine.pull();
			world.store.dropFile('copy-1');
			world.store.queue({ op: 'delete-file', path: 'a.png', remoteId: file.remoteId });
			world.store.putFile(
				{ id: 'x1', path: 'a.png', size: OTHER.byteLength },
				{ bytes: OTHER.slice(), pinned: true }
			);
			world.store.queue({ op: 'upload', fileId: 'x1', path: 'a.png' });

			await pullNow([file]);

			expect(world.store.files()).toEqual([
				{ id: 'x1', path: 'a.png', size: OTHER.byteLength },
			]);
			expect(opsNow()).toEqual([
				{ op: 'delete-file', path: 'a.png', remoteId: file.remoteId },
				{ op: 'upload', fileId: 'x1', path: 'a.png' },
			]);
		});

		it('keeps it, and the notebook above it, when the notebook is deleted there', async () => {
			// It exists nowhere else.
			await world.provider.createFolder('Trips');
			await world.provider.createFile('Trips/b.png', OTHER.slice());
			await world.engine.pull();
			added('Trips/a.png');
			await world.provider.delete(entryAt(world.provider, 'Trips'));

			expect((await world.engine.pull()).status).toBe('ok');
			expect(world.store.files()).toEqual([{ id: 'x1', path: 'Trips/a.png', size: 8 }]);
			expect(world.store.folders().map((folder) => folder.path)).toEqual(['Trips']);

			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.bytesAt('Trips/a.png')).toEqual(PNG);
		});
	});

	describe('that the user has moved here, and not yet there', () => {
		/** Pulled into `Trips`, and moved to `Work` here. */
		const moved = async () => {
			await world.provider.createFolder('Trips');
			const file = await world.provider.createFile('Trips/a.png', PNG.slice());
			await world.engine.pull();
			const row = world.store.files()[0];
			if (row === undefined) throw new Error('no row');
			world.store.putFile({ ...row, path: 'Work/a.png' });
			world.store.queue({
				op: 'move-file',
				fileId: row.id,
				path: 'Trips/a.png',
				targetPath: 'Work/a.png',
			});
			return file;
		};

		it('is adopted by the same picture arriving at its target as its own file goes', async () => {
			// Held nowhere here. The deletion leaves the row pending, which is
			// what the store does too; dropped by the store and adopted by the
			// engine, it rejected the batch on every pull for good (#194).
			const file = await moved();
			await world.provider.delete(file);
			await world.provider.createFolder('Work');
			const arrived = await world.provider.createFile('Work/a.png', PNG.slice());

			expect((await world.engine.pull()).status).toBe('ok');

			expect(world.store.files()).toEqual([
				expect.objectContaining({ path: 'Work/a.png', remoteId: arrived.remoteId }),
			]);
			expect(world.store.ops()).toEqual([]);
		});

		it('and the connection syncs on, a note edited meanwhile sent with it', async () => {
			await remoteFile('n.md', 'one\n');
			const file = await moved();
			const note = noteAt('n.md');
			if (note === undefined) throw new Error('no note');
			world.store.put({ ...note, content: 'edited\n', dirty: true });
			world.store.queue({ op: 'write', noteId: note.id, path: 'n.md' });
			await world.provider.delete(file);
			await world.provider.createFolder('Work');
			await world.provider.createFile('Work/a.png', PNG.slice());

			const outcomes = [await world.engine.sync(), await world.engine.sync()];

			expect(outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok']);
			expect(world.provider.contentAt('n.md')).toBe('edited\n');
		});

		it('goes once its upload finds nothing, when its notebook and its file both go there', async () => {
			const work = await world.provider.createFolder('Work');
			const file = await moved();
			await world.provider.delete(work);
			await world.provider.delete(file);

			expect((await world.engine.pull()).status).toBe('ok');
			expect((await world.engine.push()).status).toBe('ok');

			expect(world.store.files()).toEqual([]);
			expect(world.store.ops()).toEqual([]);
		});

		it('is sent again from the bytes held here when another file takes its place there', async () => {
			// The feed says the new file is there, and never that the old one
			// went: the move would find nothing to move.
			const file = await moved();
			const [row] = world.store.files();
			if (row === undefined) throw new Error('no row');
			world.store.putFile(row, { bytes: PNG.slice(), version: file.version });
			await world.provider.delete(file);
			const replaced = await world.provider.createFile('Trips/a.png', OTHER.slice());

			await pullNow([replaced]);
			expect((await world.engine.push()).status).toBe('ok');

			expect(world.provider.bytesAt('Work/a.png')).toEqual(PNG);
			expect(world.provider.bytesAt('Trips/a.png')).toEqual(OTHER);
			expect(
				world.store
					.files()
					.map((each) => each.path)
					.sort()
			).toEqual(['Trips/a.png', 'Work/a.png']);
		});

		it('is sent again when another file takes its place there, and its own goes out of sight', async () => {
			const file = await moved();
			const [row] = world.store.files();
			if (row === undefined) throw new Error('no row');
			world.store.putFile(row, { bytes: PNG.slice(), version: file.version });
			const other = await world.provider.createFile('b.png', OTHER.slice());

			await pullNow([
				{ ...other, path: 'Trips/a.png' },
				{ ...file, path: '.trash/a.png' },
			]);

			expect(world.store.files()).toContainEqual({
				id: row.id,
				path: 'Work/a.png',
				size: PNG.byteLength,
			});
			expect(opsNow()).toContainEqual({ op: 'upload', fileId: row.id, path: 'Work/a.png' });
		});

		it('keeps its move through a rescan that finds its file where it was', async () => {
			const file = await moved();
			const [row] = world.store.files();
			if (row === undefined) throw new Error('no row');
			killTheCursor();

			expect((await world.engine.pull()).status).toBe('ok');

			expect(world.store.files()).toEqual([
				expect.objectContaining({
					id: row.id,
					path: 'Work/a.png',
					remoteId: file.remoteId,
				}),
			]);
			expect(opsNow()).toEqual([
				{ op: 'move-file', fileId: row.id, path: 'Trips/a.png', targetPath: 'Work/a.png' },
			]);
		});

		it('is not taken for gone when its own file is listed again later in the round', async () => {
			const file = await moved();
			const [row] = world.store.files();
			if (row === undefined) throw new Error('no row');
			const other = await world.provider.createFile('b.png', OTHER.slice());
			await world.provider.createFolder('Other');

			await pullNow([
				{ ...other, path: 'Trips/a.png' },
				{ ...file, path: 'Other/a.png' },
			]);

			expect(world.store.files()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: row.id,
						path: 'Work/a.png',
						remoteId: file.remoteId,
					}),
				])
			);
			expect(opsNow()).toContainEqual({
				op: 'move-file',
				fileId: row.id,
				path: 'Other/a.png',
				targetPath: 'Work/a.png',
			});
		});

		it('is sent again when its file moves on into a folder the round then deletes', async () => {
			const file = await moved();
			const [row] = world.store.files();
			if (row === undefined) throw new Error('no row');
			world.store.putFile(row, { bytes: PNG.slice(), version: file.version });
			const other = await world.provider.createFolder('Other');

			await pullNow([
				other,
				{ ...file, path: 'Other/a.png' },
				{ deleted: true, remoteId: other.remoteId, path: 'Other' },
			]);

			expect(world.store.files()).toEqual([
				{ id: row.id, path: 'Work/a.png', size: PNG.byteLength },
			]);
			expect(opsNow()).toEqual([{ op: 'upload', fileId: row.id, path: 'Work/a.png' }]);
		});

		it('stays where the user put it, and its move starts from where the file went', async () => {
			const file = await moved();
			await world.provider.createFolder('Other');
			await world.provider.move(file, 'Other/a.png');

			await world.engine.pull();

			expect(world.store.files()).toEqual([
				expect.objectContaining({ path: 'Work/a.png', remoteId: file.remoteId }),
			]);
			expect(opsNow()).toEqual([
				{
					op: 'move-file',
					fileId: 'copy-1',
					path: 'Other/a.png',
					targetPath: 'Work/a.png',
				},
			]);
			expect((await world.engine.push()).status).toBe('ok');
			expect(entryAt(world.provider, 'Work/a.png').remoteId).toBe(file.remoteId);
		});

		it('steps aside for a different file arriving at the name it is moving to', async () => {
			const file = await moved();
			await world.provider.createFolder('Work');
			const there = await world.provider.createFile('Work/a.png', OTHER.slice());

			await world.engine.pull();

			const aside = conflictFilePath('Work/a.png', AT);
			expect(world.store.files()).toEqual([
				expect.objectContaining({ id: 'copy-1', path: aside, remoteId: file.remoteId }),
				expect.objectContaining({ path: 'Work/a.png', remoteId: there.remoteId }),
			]);
			expect(opsNow()).toEqual([
				{ op: 'move-file', fileId: 'copy-1', path: 'Trips/a.png', targetPath: aside },
			]);
		});

		it('keeps the notebook it is moving into when that is deleted there', async () => {
			await world.provider.createFolder('Work');
			const file = await moved();
			await world.provider.delete(entryAt(world.provider, 'Work'));

			await world.engine.pull();

			expect(world.store.files()).toEqual([
				expect.objectContaining({ path: 'Work/a.png', remoteId: file.remoteId }),
			]);
			expect(world.store.folders().map((folder) => folder.path)).toContain('Work');
			expect((await world.engine.push()).status).toBe('ok');
			expect(entryAt(world.provider, 'Work/a.png').remoteId).toBe(file.remoteId);
		});

		it('steps aside for a file arriving where it is going, though its own news came first', async () => {
			const file = await moved();
			await world.provider.move(file, 'Trips/b.png');
			await world.provider.createFolder('Work');
			const there = await world.provider.createFile('Work/a.png', OTHER.slice());

			await pullNow([entryAt(world.provider, 'Trips/b.png'), there]);

			const aside = conflictFilePath('Work/a.png', AT);
			expect(world.store.files()).toEqual([
				expect.objectContaining({ id: 'copy-1', path: aside, remoteId: file.remoteId }),
				expect.objectContaining({ path: 'Work/a.png', remoteId: there.remoteId }),
			]);
			expect(opsNow()).toEqual([
				{ op: 'move-file', fileId: 'copy-1', path: 'Trips/b.png', targetPath: aside },
			]);
		});

		it('is let go of when its notebook there is deleted after it stepped aside', async () => {
			// Aside, its file is where it was: in the notebook that went. Held
			// nowhere here, so its upload finds nothing to send.
			await moved();
			await world.provider.createFolder('Work');
			const there = await world.provider.createFile('Work/a.png', OTHER.slice());
			const trips = entryAt(world.provider, 'Trips');
			await world.provider.delete(trips);

			await pullNow([there, { deleted: true, remoteId: trips.remoteId, path: 'Trips' }]);
			expect((await world.engine.push()).status).toBe('ok');

			expect(world.store.files()).toEqual([
				expect.objectContaining({ path: 'Work/a.png', remoteId: there.remoteId }),
			]);
			expect(world.store.ops()).toEqual([]);
		});

		it('is where its first queued move says, through a second', async () => {
			// The second starts where the first was going, which the file never
			// reached: its file was in `Trips`, and went with it.
			await moved();
			const row = world.store.files()[0];
			if (row === undefined) throw new Error('no row');
			world.store.putFile({ ...row, path: 'Home/a.png' });
			world.store.queue({
				op: 'move-file',
				fileId: row.id,
				path: 'Work/a.png',
				targetPath: 'Home/a.png',
			});
			const trips = entryAt(world.provider, 'Trips');
			await world.provider.delete(trips);

			await pullNow([{ deleted: true, remoteId: trips.remoteId, path: 'Trips' }]);
			expect(world.store.files()).toEqual([
				{ id: row.id, path: 'Home/a.png', size: PNG.byteLength },
			]);
			await world.engine.push();

			expect(world.store.files()).toEqual([]);
		});

		it.each([
			[
				'by its notebook being deleted there',
				() => world.provider.delete(entryAt(world.provider, 'Trips')),
			],
			[
				'by its own deletion there',
				() => world.provider.delete(entryAt(world.provider, 'Trips/a.png')),
			],
		])('is let go of when its file is taken %s, held nowhere here', async (_how, take) => {
			// Pending after the pull whatever is held, so that what the engine
			// decides next about the row is about a row the store has (#194);
			// its upload then finds nothing to send.
			await moved();
			await take();

			await world.engine.pull();
			const [row] = world.store.files();
			expect(row?.remoteId).toBeUndefined();
			expect(opsNow()).toEqual([{ op: 'upload', fileId: row?.id, path: row?.path }]);
			expect((await world.engine.push()).status).toBe('ok');

			expect(world.store.files()).toEqual([]);
			expect(world.store.ops()).toEqual([]);
		});

		it.each([
			[
				'by its notebook being deleted there',
				() => world.provider.delete(entryAt(world.provider, 'Trips')),
			],
			[
				'by its own deletion there',
				() => world.provider.delete(entryAt(world.provider, 'Trips/a.png')),
			],
			[
				'out of sight of a rescan',
				() => world.provider.delete(entryAt(world.provider, 'Trips/a.png')),
			],
		])('is sent again where the user put it when its file is taken %s', async (how, take) => {
			// The move is the user's, as an edit is: kept as far as this
			// device can keep it.
			const file = await moved();
			const row = world.store.files()[0];
			if (row === undefined) throw new Error('no row');
			world.store.putFile(row, { bytes: PNG.slice(), version: file.version });
			await take();
			if (how.includes('rescan')) killTheCursor();

			await world.engine.pull();

			expect(world.store.files()).toEqual([{ id: 'copy-1', path: 'Work/a.png', size: 8 }]);
			expect(opsNow()).toEqual([{ op: 'upload', fileId: 'copy-1', path: 'Work/a.png' }]);
			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.bytesAt('Work/a.png')).toEqual(PNG);
		});
	});

	it('passes over a file the user has deleted here, whose delete has not run', async () => {
		const file = await world.provider.createFile('a.png', PNG.slice());
		world.store.queue({ op: 'delete-file', path: 'a.png', remoteId: file.remoteId });

		await world.engine.pull();

		expect(world.store.files()).toEqual([]);
	});

	it.each([
		['a clean note, which goes', false, []],
		['an edited note, which is kept and sent again', true, ['a.md']],
	])(
		'lets go of %s whose file is renamed to a file that is not a note',
		async (_what, edited, kept) => {
			const file = await remoteFile('a.md', 'a\n');
			await world.engine.pull();
			const note = noteAt('a.md');
			if (note === undefined) throw new Error('no note');
			if (edited) world.store.put({ ...note, content: 'mine\n', dirty: true });
			await world.provider.move(file, 'a.txt');

			await world.engine.pull();

			expect(world.store.notes().map((each) => each.path)).toEqual(kept);
			expect(world.store.notes().every((each) => each.remoteId === undefined)).toBe(true);
			expect(world.store.files()).toEqual([
				expect.objectContaining({ path: 'a.txt', remoteId: file.remoteId }),
			]);
		}
	);

	it('lets go of the row of a file renamed to a note, which is read as one', async () => {
		const file = await world.provider.createFile('a.txt', new TextEncoder().encode('text\n'));
		await world.engine.pull();
		await world.provider.move(file, 'a.md');

		await world.engine.pull();

		expect(world.store.files()).toEqual([]);
		expect(noteAt('a.md')).toMatchObject({ remoteId: file.remoteId, content: 'text\n' });
	});

	it('carries the rows under a folder moved there', async () => {
		const folder = await world.provider.createFolder('Trips');
		await world.provider.createFile('Trips/a.png', PNG.slice());
		await world.engine.pull();
		await world.provider.move(folder, 'Holidays');

		await world.engine.pull();

		expect(world.store.files().map((file) => file.path)).toEqual(['Holidays/a.png']);
	});

	it('settles two rows a notebook renamed onto a deleted one leaves at one path', async () => {
		// A pending row kept by its notebook's deletion there, and another
		// notebook renamed onto that name by id, its files not listed again:
		// only the backstop (`settleFileClashes`) sees them meet.
		const a = await world.provider.createFolder('A');
		const b = await world.provider.createFolder('B');
		const file = await world.provider.createFile('B/x.png', OTHER.slice());
		await world.engine.pull();
		world.store.putFile(
			{ id: 'x1', path: 'A/x.png', size: PNG.byteLength },
			{ bytes: PNG.slice(), pinned: true }
		);
		world.store.queue({ op: 'upload', fileId: 'x1', path: 'A/x.png' });
		await world.provider.delete(a);
		await world.provider.move(b, 'A');

		await pullNow([{ deleted: true, remoteId: a.remoteId }, entryAt(world.provider, 'A')]);

		expect(world.store.files()).toEqual([
			{ id: 'x1', path: conflictFilePath('A/x.png', AT), size: PNG.byteLength },
			expect.objectContaining({ path: 'A/x.png', remoteId: file.remoteId }),
		]);
	});

	it('lets a row a rename carries go for a file arriving where it was carried', async () => {
		const trips = await world.provider.createFolder('Trips');
		const file = await world.provider.createFile('Trips/a.png', PNG.slice());
		await world.engine.pull();
		await world.provider.delete(file);
		await world.provider.move(trips, 'Holidays');
		const other = await world.provider.createFile('Holidays/a.png', OTHER.slice());

		await pullNow([entryAt(world.provider, 'Holidays'), other]);

		expect(world.store.files()).toEqual([
			expect.objectContaining({ path: 'Holidays/a.png', remoteId: other.remoteId }),
		]);
	});

	it('takes a file rewritten in place at its size as a new version, with no stale bytes', async () => {
		const file = await world.provider.createFile('a.png', PNG.slice());
		await world.engine.pull();
		const [row] = world.store.files();
		if (row === undefined) throw new Error('no row');
		world.store.putFile(row, { bytes: PNG.slice(), version: file.version });
		const now = world.provider.plantBytes('a.png', new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));

		await world.engine.pull();

		expect(world.store.files()).toEqual([{ ...row, remoteVersion: now.version }]);
		expect(world.store.heldBytes(row.id)).toEqual({ bytes: PNG, version: file.version });
		expect(await world.store.fileBytes(row.id)).toBeUndefined();
	});

	describe('gone to a hidden path', () => {
		// `decide` passes a hidden entry over, so it says nothing of where a
		// file went: read as its next place, it kept rows for nothing (#194).
		it.each([
			['by path', (trips: RemoteEntry) => ({ deleted: true as const, path: trips.path })],
			[
				'by id',
				(trips: RemoteEntry) => ({
					deleted: true as const,
					remoteId: trips.remoteId,
					path: trips.path,
				}),
			],
		])('is gone with a notebook deleted %s as it moves on there', async (_how, deletion) => {
			const trips = await world.provider.createFolder('Trips');
			const file = await world.provider.createFile('Trips/a.png', PNG.slice());
			await world.engine.pull();

			await pullNow([deletion(trips), { ...file, path: '.trash/a.png' }]);

			expect(world.store.files()).toEqual([]);
			expect(world.store.folders()).toEqual([]);
		});

		it.each([
			['by path', (file: RemoteEntry) => ({ deleted: true as const, path: file.path })],
			['by id', (file: RemoteEntry) => ({ deleted: true as const, remoteId: file.remoteId })],
		])('is gone when its file is deleted %s as it moves on there', async (_how, deletion) => {
			const file = await world.provider.createFile('a.png', PNG.slice());
			await world.engine.pull();

			await pullNow([deletion(file), { ...file, path: '.trash/a.png' }]);

			expect(world.store.files()).toEqual([]);
		});

		it('is gone when its file is deleted out of a folder the round moves, as it moves on there', async () => {
			const folder = await world.provider.createFolder('Trips');
			const file = await world.provider.createFile('Trips/a.png', PNG.slice());
			await world.engine.pull();
			await world.provider.move(folder, 'Holidays');

			await pullNow([
				entryAt(world.provider, 'Holidays'),
				{ deleted: true, path: 'Trips/a.png' },
				{ ...file, path: '.trash/a.png' },
			]);

			expect(world.store.files()).toEqual([]);
			expect(world.store.folders().map((each) => each.path)).toEqual(['Holidays']);
		});

		it('and a rescan finds nothing to put back', async () => {
			const trips = await world.provider.createFolder('Trips');
			const file = await world.provider.createFile('Trips/a.png', PNG.slice());
			await world.engine.pull();
			await world.provider.createFolder('.trash');
			const moved = await world.provider.move(file, '.trash/a.png');
			await world.provider.delete(trips);

			await pullNow([{ deleted: true, remoteId: trips.remoteId, path: 'Trips' }, moved]);
			killTheCursor();
			expect((await world.engine.pull()).status).toBe('ok');

			expect(world.store.files()).toEqual([]);
		});

		it('gives its path up to a file arriving there as its own moves on', async () => {
			const file = await world.provider.createFile('a.png', PNG.slice());
			await world.engine.pull();
			const other = await world.provider.createFile('b.png', OTHER.slice());

			await pullNow([
				{ ...other, path: 'a.png' },
				{ ...file, path: '.hidden/a.png' },
			]);

			expect(world.store.files()).toEqual([
				expect.objectContaining({ path: 'a.png', remoteId: other.remoteId }),
			]);
		});
	});

	describe('after a rescan', () => {
		it('lets go of a row whose file the scan did not return, and keeps one never sent', async () => {
			const file = await world.provider.createFile('a.png', PNG.slice());
			await world.engine.pull();
			world.store.putFile(
				{ id: 'x1', path: 'b.png', size: 3 },
				{ bytes: OTHER.slice(), pinned: true }
			);
			await world.provider.delete(file);
			killTheCursor();

			expect((await world.engine.pull()).status).toBe('ok');
			expect(world.store.files()).toEqual([{ id: 'x1', path: 'b.png', size: 3 }]);
		});

		it('sends one back up that it holds the bytes of, where the provider says it may have lost it', async () => {
			const file = await world.provider.createFile('a.png', PNG.slice());
			const gone = await world.provider.createFile('b.png', OTHER.slice());
			await world.engine.pull();
			const row = world.store.files().find((each) => each.path === 'a.png');
			if (row === undefined) throw new Error('no row');
			world.store.putFile(row, { bytes: PNG.slice(), version: file.version });
			await world.provider.delete(file);
			await world.provider.delete(gone);
			killTheCursor(true);

			expect((await world.engine.pull()).status).toBe('ok');
			// Both pending again and owed an upload. The one held here goes back
			// up; the other has nothing to send, and goes.
			expect(world.store.files().map((each) => each.remoteId)).toEqual([
				undefined,
				undefined,
			]);
			expect(opsNow().map((op) => op.op)).toEqual(['upload', 'upload']);
			expect((await world.engine.push()).status).toBe('ok');

			expect(world.store.files()).toEqual([
				expect.objectContaining({ id: row.id, path: 'a.png', size: PNG.byteLength }),
			]);
			expect(world.provider.bytesAt('a.png')).toEqual(PNG);
			expect(world.provider.bytesAt('b.png')).toBeUndefined();
		});
	});
});

describe('a file the user duplicated', () => {
	/** A note file as this app writes it, id and all. */
	const noteFile = (id: string, body: string) => `---\nid: ${id}\n---\n\n${body}\n`;

	it('does not let the copy take over the note it was copied from', async () => {
		// Duplicating a file is an ordinary thing to do in a folder the user can
		// see, and the copy carries the original's id. Adopting it writes the
		// copy over the note it came from — unpushed edits included — and leaves
		// the two files fighting over one row on every sync afterwards.
		const entry = await remoteFile('a.md', noteFile('n1', 'original'));
		world.store.put({
			id: 'n1',
			path: 'a.md',
			content: noteFile('n1', 'my unpushed edit'),
			...boundTo(entry),
			dirty: true,
		});
		await world.provider.write('a copy.md', noteFile('n1', 'original'), {});

		await world.engine.pull();

		expect(noteAt('a.md')?.content).toContain('my unpushed edit');
		expect(noteAt('a copy.md')?.id).not.toBe('n1');
		expect(world.store.notes()).toHaveLength(2);
	});

	it('still adopts the id when nothing else holds it', async () => {
		// The other half, and the reason the id is in the file at all: two
		// devices have to agree which note a file is, or every link between them
		// breaks. Only a *taken* id is refused.
		await remoteFile('a.md', noteFile('shared', 'body'));

		await world.engine.pull();

		expect(noteAt('a.md')?.id).toBe('shared');
	});

	it('adopts the id of a note the same batch deleted', async () => {
		// A file moved in a way the provider reports as a delete plus a create.
		// The id in the file is the only thing tying the two halves together, and
		// refusing it because a row still holds it — a row this very batch is
		// about to remove — makes the two devices disagree for ever about which
		// note this is.
		const first = await remoteFile('a.md', '---\nid: keep-me\n---\n\nbody\n');
		await world.engine.pull();
		expect(noteAt('a.md')?.id).toBe('keep-me');
		await world.provider.delete(first);
		const second = await remoteFile('b.md', '---\nid: keep-me\n---\n\nbody\n');

		await pullNow([{ path: 'a.md', deleted: true, remoteId: first.remoteId }, second]);

		expect(world.store.notes()).toHaveLength(1);
		expect(noteAt('b.md')?.id).toBe('keep-me');
	});

	it('refuses an id the same batch has already handed out', async () => {
		await remoteFile('a.md', noteFile('shared', 'body'));
		await remoteFile('b.md', noteFile('shared', 'body'));

		await world.engine.pull();

		const ids = world.store.notes().map((note) => note.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});
});

describe('a file that is gone by the time we read it', () => {
	it('does not stall the pull for ever', async () => {
		// `changes` and `read` are separate round trips on every provider, so a
		// file the feed named can be deleted in between — here by the other
		// device, which edited it and then deleted it inside one cursor window.
		// Throwing unwinds the whole pull, and since the cursor moves only with
		// the batch the next attempt fetches the same batch and dies the same
		// way. Push never runs either, because `sync` stops on a pull that is
		// not `ok`, so the user's unpushed edit never leaves the device.
		const entry = await remoteFile('a.md', 'theirs\n');
		world.store.put({
			id: 'mine',
			path: 'a.md',
			content: 'my edit\n',
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		await world.provider.delete(entry);

		const result = await pullNow([
			entry,
			{ path: 'a.md', deleted: true, remoteId: entry.remoteId },
		]);

		expect(result.status).toBe('ok');
		// And the deletion in the same batch is still acted on: the edit is
		// kept, and cut loose so the next push re-creates the file.
		expect(noteAt('a.md')?.content).toBe('my edit\n');
		expect(noteAt('a.md')?.remoteId).toBeUndefined();
	});

	it('leaves our own note where it is', async () => {
		// Nothing is landing on that path after all, so a note of ours sitting
		// there has not been displaced by anything — moving it aside would
		// rename the user's note for a file that never arrived.
		const entry = await remoteFile('other.md', 'theirs\n');
		world.store.put({
			id: 'theirs',
			path: 'other.md',
			content: 'theirs\n',
			remoteId: entry.remoteId,
			remoteVersion: 'older',
		});
		world.store.put({ id: 'mine', path: 'x.md', content: 'never pushed\n', dirty: true });
		await world.provider.delete(entry);

		const result = await pullNow([{ ...entry, path: 'x.md' }]);

		expect(result.status).toBe('ok');
		expect(noteAt('x.md')?.id).toBe('mine');
	});

	it('still reports a read that failed for any other reason', async () => {
		// Only "it is not there" is news the pull can carry on past. A refused
		// or broken read is a batch that has not been decided, and reporting it
		// as applied would move the cursor past changes nobody looked at.
		await remoteFile('a.md', 'theirs\n');
		world.provider.setFault((call) =>
			call.op === 'read' ? new Error('network down') : undefined
		);

		const result = await world.engine.pull();

		expect(result.status).toBe('retry');
		expect(result.error).toBe('network down');
		expect(world.store.storedCursor()).toBeUndefined();
	});
});

/**
 * docs/ARCHITECTURE.md §7, "A file that is not UTF-8 is left alone". One test per place
 * the engine reads a file, and the same three things asked after each: the pull
 * or push went through, the file holds the bytes it held, and no note is left
 * pointing at it — a note that is can push over bytes this device never read.
 */
describe('a file that is not UTF-8 text', () => {
	/** "café" and a newline as Latin-1: `0xE9` alone is not a UTF-8 sequence. */
	const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
	const COPY = 'a (conflict 2026-09-15T14-32).md';

	const holders = (remoteId: string): SyncNote[] =>
		world.store.notes().filter((note) => note.remoteId === remoteId);

	/** What the engine has asked the provider to change, which is never this file. */
	const sent = (): string[] =>
		world.provider
			.callLog()
			.filter((call) => call.op === 'write' || call.op === 'move' || call.op === 'delete')
			.map((call) => `${call.op} ${call.path ?? ''}`);

	it('imports nothing, and the pull goes through', async () => {
		// A throw here is a pull that never moves its cursor: the same entry
		// and the same bytes next time, and the user's sync is over.
		const file = world.provider.plantBytes('a.md', LATIN1);
		await remoteFile('b.md', 'readable\n');

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.storedCursor()).toBeDefined();
		expect(world.store.notes().map((note) => note.path)).toEqual(['b.md']);
		expect(holders(file.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('reads a file holding a NUL the same way', async () => {
		// UTF-16 with no BOM is valid UTF-8 to a decoder, with a NUL for every
		// other byte; so is most of what a binary holds.
		const utf16 = new Uint8Array([0x68, 0x00, 0x69, 0x00]);
		world.provider.plantBytes('a.md', utf16);

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
		expect(world.provider.bytesAt('a.md')).toEqual(utf16);
	});

	it('moves a note never pushed aside, and its push makes the copy', async () => {
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'a.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'mine', path: 'a.md' });
		const file = world.provider.plantBytes('a.md', LATIN1);

		// By the pull, as for any file arriving at a name of ours: left to the
		// push, the note sits on the file's path until a write has failed there.
		const pulled = await world.engine.pull();

		expect(pulled.status).toBe('ok');
		expect(noteAt(COPY)).toMatchObject({ id: 'mine', content: 'mine\n', dirty: true });
		expect(noteAt('a.md')).toBeUndefined();

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(noteAt(COPY)).toMatchObject({ id: 'mine', content: 'mine\n', dirty: false });
		expect(world.provider.contentAt(COPY)).toBe('mine\n');
		expect(holders(file.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('lets go of a clean note whose file became unreadable, and sends nothing', async () => {
		// Kept, the row holds the file's id and — after the next entry for it —
		// its version, and the first push from it replaces the user's bytes.
		const { entry } = await pulledNote('a.md', 'one\n');
		const before = sent();
		world.provider.plantBytes('a.md', LATIN1);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
		expect(world.store.ops()).toEqual([]);
		expect(sent()).toEqual(before);
		expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
		expect(remoteAt(world.provider, 'a.md')?.remoteId).toBe(entry.remoteId);
	});

	it('cuts a dirty note loose and moves it aside, and its edit goes up beside the file', async () => {
		const { entry, note } = await pulledNote('a.md', 'one\n');
		editHere(world.store, note, 'my edit\n');
		world.provider.plantBytes('a.md', LATIN1);

		const pulled = await world.engine.pull();

		expect(pulled.status).toBe('ok');
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: true });
		expect(noteAt(COPY)?.remoteId).toBeUndefined();
		expect(noteAt('a.md')).toBeUndefined();

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.store.ops()).toEqual([]);
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
		expect(noteAt(COPY)?.remoteId).not.toBe(entry.remoteId);
		expect(world.provider.contentAt(COPY)).toBe('my edit\n');
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('leaves a dirty note the user renamed where they put it', async () => {
		// Nothing is in its way at the new name. Its queued move has no file to
		// move any more and finishes as done; the write makes the file.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		world.store.put({ ...note, path: 'b.md', content: 'my edit\n', dirty: true });
		world.store.queue({ op: 'move', noteId: note.id, path: 'a.md', targetPath: 'b.md' });
		world.store.queue({ op: 'write', noteId: note.id, path: 'b.md' });
		world.provider.plantBytes('a.md', LATIN1);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.store.notes().map((each) => each.path)).toEqual(['b.md']);
		expect(noteAt('b.md')).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
		expect(world.provider.contentAt('b.md')).toBe('my edit\n');
		expect(sent().filter((call) => call.startsWith('move'))).toEqual([]);
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('keeps an edit typed after the note was decided clean', async () => {
		// The store refuses a `delete-note` for a note edited since (§7), the
		// batch rolls back with its cursor, and the next pull meets a dirty note.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		world.provider.plantBytes('a.md', LATIN1);
		const cursor = world.store.storedCursor();
		const typed = { done: false };
		const typing: SyncStore = {
			...world.store,
			applyChanges: (batch) => {
				if (!typed.done) editHere(world.store, note, 'typed just now\n');
				typed.done = true;
				return world.store.applyChanges(batch);
			},
		};
		const racing = engineWith({ store: typing });

		const refused = await racing.pull();

		expect(refused.status).toBe('retry');
		expect(world.store.storedCursor()).toBe(cursor);

		const result = await racing.sync();

		expect(result.status).toBe('ok');
		expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'typed just now\n' });
		expect(world.provider.contentAt(COPY)).toBe('typed just now\n');
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('drops the delete of a note whose file became unreadable', async () => {
		// The user deleted text they had seen, not these bytes. The file is left
		// alone, and the tombstone goes with nothing sent.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		world.store.queue({ op: 'delete', noteId: note.id, path: 'a.md' });
		world.provider.plantBytes('a.md', LATIN1);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
		expect(world.store.ops()).toEqual([]);
		expect(sent().filter((call) => call.startsWith('delete'))).toEqual([]);
		expect(remoteAt(world.provider, 'a.md')?.remoteId).toBe(entry.remoteId);
		expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
	});

	it('takes a file it cannot read for one that is still there', async () => {
		// `stillThere`: the note's own file was renamed and re-saved as Latin-1,
		// and another file took the name. Read as gone, the note would become
		// that other file; a throw would stop the pull. It is there, so the note
		// moves aside, and the file's own entry then lets go of it.
		const { entry, note } = await pulledNote('a.md', 'one\n');
		await world.provider.move(entry, 'old.md');
		const old = world.provider.plantBytes('old.md', LATIN1);
		const theirs = await remoteFile('a.md', 'theirs\n');

		const result = await pullNow([theirs]);

		expect(result.status).toBe('ok');
		expect(noteAt('a.md')).toMatchObject({ content: 'theirs\n', remoteId: theirs.remoteId });
		expect(noteAt('a.md')?.id).not.toBe(note.id);
		expect(noteAt(COPY)?.id).toBe(note.id);

		const next = await pullNow([old]);

		expect(next.status).toBe('ok');
		expect(world.store.notes().map((each) => each.path)).toEqual(['a.md']);
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('old.md')).toEqual(LATIN1);
	});

	describe('a delete queued for a note whose file became unreadable', () => {
		// The tombstone goes and its delete stays queued, naming the note by id.
		// Another device, holding an edit to the same note, sets it aside in a
		// file that carries that id — and a row made under it is what the delete
		// then removes: the other device's edit, from every device.
		const theirCopy = `---\nid: n1\n---\n\ntheir edit\n`;

		const tombstone = async () => {
			await pulledNote('a.md', `---\nid: n1\n---\n\none\n`);
			expect(noteAt('a.md')?.id).toBe('n1');
			world.store.queue({ op: 'delete', noteId: 'n1', path: 'a.md' });
		};
		const resave = (): void => {
			world.provider.plantBytes('a.md', LATIN1);
		};
		const setAsideThere = async (): Promise<void> => {
			await remoteFile(COPY, theirCopy);
		};
		const pullNothing = (): Promise<void> => Promise.resolve();
		const pullBetween = async (): Promise<void> => {
			expect((await world.engine.pull()).status).toBe('ok');
		};

		it.each([
			['in the batch that says so, behind it', resave, pullNothing, setAsideThere],
			['in the batch that says so, ahead of it', setAsideThere, pullNothing, resave],
			['in a later batch', resave, pullBetween, setAsideThere],
			['in an earlier batch', setAsideThere, pullBetween, resave],
		])(
			'is not aimed at the other device’s copy arriving %s',
			async (_, first, between, second) => {
				await tombstone();
				await first();
				await between();
				await second();

				const result = await world.engine.sync();

				expect(result.status).toBe('ok');
				expect(world.store.ops()).toEqual([]);
				expect(sent().filter((call) => call.startsWith('delete'))).toEqual([]);
				expect(world.provider.contentAt(COPY)).toBe(theirCopy);
				expect(noteAt(COPY)?.content).toBe(theirCopy);
				expect(noteAt(COPY)?.id).not.toBe('n1');
				expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
			}
		);
	});

	describe('met by a push', () => {
		it('sets the edit aside in one drain when the note’s own file cannot be read', async () => {
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(world.store, note, 'my edit\n');
			world.provider.plantBytes('a.md', LATIN1);

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([COPY]);
			// The op reached the remote, as a new file, and is counted as one that
			// did. An ordinary conflict's does not: its copy's write is queued.
			expect(result.pushed).toBe(1);
			// Finished, not failed and retried: no attempt was spent on it.
			expect(world.store.ops()).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
			expect(world.provider.contentAt(COPY)).toBe('my edit\n');
			expect(holders(entry.remoteId)).toEqual([]);
			expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('has cut the note loose even when the copy could not be made', async () => {
			// Still bound, the retry goes out against the unreadable file's id.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(world.store, note, 'my edit\n');
			world.provider.plantBytes('a.md', LATIN1);
			world.provider.setFault((call) =>
				call.op === 'write' && call.path === COPY ? new Error('network down') : undefined
			);

			const failed = await world.engine.push();

			expect(failed.status).toBe('retry');
			expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: true });
			expect(holders(entry.remoteId)).toEqual([]);

			world.provider.setFault(undefined);
			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(world.store.notes().map((each) => each.path)).toEqual([COPY]);
			expect(world.provider.contentAt(COPY)).toBe('my edit\n');
			expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('takes the next name when another device has set its own edit aside under the first', async () => {
			// The store has never seen that file, so the name looks free from
			// here and only the create can say otherwise. Thrown, that conflict
			// spends an attempt, and the retry — a create at a name that holds
			// another device's file — is resolved as a conflict with it: a copy
			// of the copy, under two suffixes.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(world.store, note, 'my edit\n');
			world.provider.plantBytes('a.md', LATIN1);
			await remoteFile(COPY, 'their edit\n');
			const next = conflictPath('a.md', AT, [COPY]);

			const result = await world.engine.push();

			expect(result).toMatchObject({ status: 'ok', pushed: 1, conflicts: [next] });
			expect(world.store.ops()).toEqual([]);
			expect(world.provider.contentAt(next)).toBe('my edit\n');
			expect(world.provider.contentAt(COPY)).toBe('their edit\n');
			expect(world.store.notes().map((each) => each.path)).toEqual([next]);
			expect(noteAt(next)).toMatchObject({
				id: note.id,
				dirty: false,
				remoteId: remoteAt(world.provider, next)?.remoteId,
			});
			expect(holders(entry.remoteId)).toEqual([]);
			expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('gives up on a name after as many refusals as a rename does, and says why', async () => {
			const { note } = await pulledNote('a.md', 'one\n');
			editHere(world.store, note, 'my edit\n');
			world.provider.plantBytes('a.md', LATIN1);
			world.provider.setFault((call) =>
				call.op === 'write' ? new ConflictError(entryAt(world.provider, 'a.md')) : undefined
			);
			const before = sent().length;

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			expect(world.store.ops().map((op) => op.attempts)).toEqual([1]);
			// The op's own write, and ten names tried.
			expect(sent().slice(before)).toHaveLength(11);
			// Still the user's edit, still theirs to send, and cut loose.
			expect(world.store.notes()).toHaveLength(1);
			expect(world.store.notes()[0]).toMatchObject({ content: 'my edit\n', dirty: true });
			expect(world.store.notes()[0]?.remoteId).toBeUndefined();
		});

		it('keeps a note bound to its own file when the one in the way is another', async () => {
			// The user renamed the note onto a name an unreadable file has taken.
			// That file says nothing about the note's own, which is fine and
			// elsewhere: a copy made now would leave it behind with no note. So
			// the note steps aside still bound, and its own file follows it.
			const { entry, note } = await pulledNote('mine.md', 'one\n');
			world.store.put({ ...note, path: 'a.md', content: 'my edit\n', dirty: true });
			world.store.queue({ op: 'write', noteId: note.id, path: 'a.md' });
			world.store.queue({ op: 'move', noteId: note.id, path: 'mine.md', targetPath: 'a.md' });
			const file = world.provider.plantBytes('a.md', LATIN1);

			await world.engine.push();

			expect(noteAt(COPY)).toMatchObject({ id: note.id, remoteId: entry.remoteId });

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(world.store.ops()).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ remoteId: entry.remoteId, dirty: false });
			expect(world.provider.contentAt(COPY)).toBe('my edit\n');
			expect(world.provider.contentAt('mine.md')).toBeUndefined();
			expect(holders(file.remoteId)).toEqual([]);
			expect(world.provider.bytesAt('a.md')).toEqual(LATIN1);
		});

		it('sets the edit aside when the file was renamed away and cannot be read', async () => {
			// `runWrite`: nothing at the note's path, so the file is asked after
			// by id. It is there; what it holds is not for this note to replace.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(world.store, note, 'my edit\n');
			await world.provider.move(entry, 'renamed.md');
			world.provider.plantBytes('renamed.md', LATIN1);

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([COPY]);
			expect(world.store.ops()).toEqual([]);
			expect(world.provider.contentAt(COPY)).toBe('my edit\n');
			expect(world.provider.contentAt('a.md')).toBeUndefined();
			expect(holders(entry.remoteId)).toEqual([]);
			expect(world.provider.bytesAt('renamed.md')).toEqual(LATIN1);
		});

		it('sets the edit aside when the file it has just renamed cannot be read', async () => {
			// `followTheRename`: the file changed between the read that found it
			// and the move. The move has put it at the note's path, so the note
			// is what moves on.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			world.store.put({ ...note, path: 'b.md', content: 'my edit\n', dirty: true });
			world.store.queue({ op: 'write', noteId: note.id, path: 'b.md' });
			world.store.queue({ op: 'move', noteId: note.id, path: 'a.md', targetPath: 'b.md' });
			world.provider.setFault((call) => {
				if (call.op === 'move') world.provider.plantBytes('a.md', LATIN1);
				return undefined;
			});

			const result = await world.engine.push();

			const copy = 'b (conflict 2026-09-15T14-32).md';
			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([copy]);
			expect(world.store.ops()).toEqual([]);
			expect(noteAt(copy)).toMatchObject({ id: note.id, content: 'my edit\n' });
			expect(world.provider.contentAt(copy)).toBe('my edit\n');
			expect(holders(entry.remoteId)).toEqual([]);
			expect(world.provider.bytesAt('b.md')).toEqual(LATIN1);
		});

		it('cuts the note loose when its own file cannot be read and another has its name', async () => {
			// `someoneElses`: still bound, the retry is aimed at the unreadable
			// file, is set aside a second time, and the user is handed a note
			// named "(conflict …) (conflict …)".
			const { entry, note } = await pulledNote('x.md', 'one\n');
			world.store.put({ ...note, path: 'a.md', content: 'my edit\n', dirty: true });
			world.store.queue({ op: 'write', noteId: note.id, path: 'a.md' });
			world.store.queue({ op: 'move', noteId: note.id, path: 'x.md', targetPath: 'a.md' });
			await remoteFile('a.md', 'theirs\n');
			world.provider.plantBytes('x.md', LATIN1);

			await world.engine.push();
			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(world.store.ops()).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ id: note.id, content: 'my edit\n', dirty: false });
			expect(world.provider.contentAt(COPY)).toBe('my edit\n');
			expect(world.provider.contentAt('a.md')).toBe('theirs\n');
			expect(holders(entry.remoteId)).toEqual([]);
			expect(world.provider.bytesAt('x.md')).toEqual(LATIN1);
		});

		it('carries out a rename of a file it cannot read, and the next pull lets go of the note', async () => {
			// `runMove`: the move found no folder to go into and asks whether the
			// file is there. It is. A rename changes no bytes.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			world.store.putFolder({ path: 'New' });
			world.store.put({ ...note, path: 'New/a.md' });
			world.store.queue({
				op: 'move',
				noteId: note.id,
				path: 'a.md',
				targetPath: 'New/a.md',
			});
			world.provider.plantBytes('a.md', LATIN1);

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(world.store.ops()).toEqual([]);
			expect(world.provider.bytesAt('New/a.md')).toEqual(LATIN1);

			const next = await world.engine.sync();

			expect(next.status).toBe('ok');
			expect(world.store.notes()).toEqual([]);
			expect(holders(entry.remoteId)).toEqual([]);
			expect(world.provider.bytesAt('New/a.md')).toEqual(LATIN1);
		});
	});

	/**
	 * docs/ARCHITECTURE.md §7: the files left alone are listed, so the user is told what
	 * the app is not showing them. One test per way a file gets onto the list,
	 * and per way it comes off. The list is a notice and no decision reads it,
	 * so nothing here asks more of it than that it is right.
	 */
	describe('is listed', () => {
		const listed = async (): Promise<string[]> =>
			(await world.store.unreadable()).map((file) => `${file.remoteId} ${file.path}`).sort();

		/** Where the list says the user's notes went, by the file that took the name. */
		const movedAside = async (): Promise<Record<string, readonly string[]>> =>
			Object.fromEntries(
				(await world.store.unreadable()).flatMap((file) =>
					file.movedAside === undefined ? [] : [[file.path, file.movedAside]]
				)
			);

		/** Every batch handed to the store, to see what a pull had to say. */
		const watched = (over: StorageProvider = world.provider) => {
			const batches: PullBatch[] = [];
			const watching: SyncStore = {
				...world.store,
				applyChanges: (batch) => {
					batches.push(batch);
					return world.store.applyChanges(batch);
				},
			};
			return {
				batches,
				engine: engineWith({ provider: over, store: watching }),
			};
		};

		it('once it has been found, and the pull counts it', async () => {
			const file = world.provider.plantBytes('a.md', LATIN1);
			await remoteFile('b.md', 'readable\n');

			const result = await world.engine.pull();

			// The note imported and the file listed: the device shows two things
			// it did not before.
			expect(result).toMatchObject({ status: 'ok', pulled: 2, conflicts: [] });
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});

		it('and says nothing when the feed names the file again with nothing changed', async () => {
			// No row holds the file's version, so every mention is a read. A
			// record for each would have `pulled` count a change that is not one.
			const file = world.provider.plantBytes('a.md', LATIN1);
			await world.engine.pull();
			const { batches, engine: again } = watched();
			world.provider.plantBytes('a.md', LATIN1);

			const result = await again.pull();

			expect(result).toMatchObject({ status: 'ok', pulled: 0 });
			expect(batches.map((batch) => batch.changes)).toEqual([[]]);
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});

		it('under its new name when it is renamed, once', async () => {
			const file = world.provider.plantBytes('a.md', LATIN1);
			await world.engine.pull();
			await world.provider.move(file, 'renamed.md');

			const result = await world.engine.pull();

			expect(result).toMatchObject({ status: 'ok', pulled: 1 });
			expect(await listed()).toEqual([`${file.remoteId} renamed.md`]);
		});

		it('with where the user’s note went, and not as a conflict, which it is not', async () => {
			// Nothing was edited twice and no copy was made: a file arrived that
			// could not be read, and the note that had its name was moved. Said
			// as a conflict, the user is told the one thing that did not happen
			// — and the banner is gone by the time they wonder about the name.
			const { entry, note } = await pulledNote('a.md', 'one\n');
			editHere(world.store, note, 'my edit\n');
			world.provider.plantBytes('a.md', LATIN1);

			const result = await world.engine.pull();

			expect(result.conflicts).toEqual([]);
			expect(await listed()).toEqual([`${entry.remoteId} a.md`]);
			expect(await movedAside()).toEqual({ 'a.md': [COPY] });
			expect(noteAt(COPY)?.id).toBe(note.id);
		});

		it('and so is a note never pushed that an unreadable file took the name of', async () => {
			await world.engine.pull();
			const file = world.provider.plantBytes('a.md', LATIN1);
			await world.engine.pull();
			// Made here after the file was listed: the record is a repeat, and
			// the note moving aside is still news.
			world.store.put({ id: 'mine', path: 'a.md', content: 'mine\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'mine', path: 'a.md' });

			const result = await pullNow([file]);

			expect(result.conflicts).toEqual([]);
			expect(noteAt(COPY)).toMatchObject({ id: 'mine' });
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			expect(await movedAside()).toEqual({ 'a.md': [COPY] });
		});

		it('with every note it has moved aside, not only the last', async () => {
			// The name is free here once the first note has moved off it, so the
			// user can make another there — and the file takes that one too the
			// next time it is read. Told only about the last, they go looking
			// for a note that is not where they left it and nothing says where
			// it went.
			await world.engine.pull();
			const file = world.provider.plantBytes('a.md', LATIN1);
			world.store.put({ id: 'first', path: 'a.md', content: 'first\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'first', path: 'a.md' });

			await pullNow([file]);

			world.store.put({ id: 'second', path: 'a.md', content: 'second\n', dirty: true });
			world.store.queue({ op: 'write', noteId: 'second', path: 'a.md' });
			const resaved = world.provider.plantBytes('a.md', LATIN1);

			await pullNow([resaved]);

			const aside = await movedAside();
			expect(aside['a.md']).toHaveLength(2);
			expect(new Set(aside['a.md'])).toEqual(
				new Set(world.store.notes().map((each) => each.path))
			);
			expect(noteAt('a.md')).toBeUndefined();
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});

		it('and keeps saying where they went when the file is listed again elsewhere', async () => {
			// The note is still at the name it was given. A record re-made for
			// the rename and left bare would drop the only explanation of it.
			const { note } = await pulledNote('a.md', 'one\n');
			editHere(world.store, note, 'my edit\n');
			const file = world.provider.plantBytes('a.md', LATIN1);
			await world.engine.pull();
			await world.provider.move(file, 'renamed.md');

			await world.engine.pull();

			expect(await listed()).toEqual([`${file.remoteId} renamed.md`]);
			expect(await movedAside()).toEqual({ 'renamed.md': [COPY] });
		});

		describe('until it reads', () => {
			it('under the same id, and is imported', async () => {
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();
				await world.provider.write('a.md', 'fixed\n', { expectedVersion: file.version });

				const result = await world.engine.pull();

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([]);
				expect(noteAt('a.md')).toMatchObject({
					content: 'fixed\n',
					remoteId: file.remoteId,
				});
			});

			it('under the same id at another name, fixed and renamed between two pulls', async () => {
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();
				const fixed = await world.provider.write('a.md', 'fixed\n', {
					expectedVersion: file.version,
				});
				await world.provider.move(fixed, 'b.md');

				await world.engine.pull();

				expect(await listed()).toEqual([]);
				expect(noteAt('b.md')).toMatchObject({ content: 'fixed\n' });
			});

			it('when a file the device already holds a note for is named again unchanged', async () => {
				// The version the row holds, so nothing is read — and a file this
				// device has read is not one it could not read. Left listed, a
				// notice for a file that reads perfectly well never goes: its
				// entries all take this branch, and only a re-scan clears it.
				const { entry, note } = await pulledNote('a.md', 'one\n');
				await world.store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: entry.remoteId, path: 'zzz.md' } },
					],
				});
				const reads = world.provider.callLog().filter((call) => call.op === 'read').length;

				const result = await pullNow([entry]);

				expect(result.status).toBe('ok');
				expect(world.provider.callLog().filter((call) => call.op === 'read')).toHaveLength(
					reads
				);
				expect(await listed()).toEqual([]);
				expect(noteAt('a.md')?.id).toBe(note.id);
			});

			it('or a note this device already holds is renamed onto its path, and nothing is read', async () => {
				// The version the row holds, so no read: a file this device has
				// read is at the path, and whatever was listed there is not.
				const file = world.provider.plantBytes('a.md', LATIN1);
				const { entry, note } = await pulledNote('b.md', 'one\n');
				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
				await world.provider.delete(file);
				const reads = world.provider.callLog().filter((call) => call.op === 'read').length;

				await pullNow([{ ...entry, path: 'a.md' }]);

				expect(world.provider.callLog().filter((call) => call.op === 'read')).toHaveLength(
					reads
				);
				expect(noteAt('a.md')).toMatchObject({ id: note.id });
				expect(await listed()).toEqual([]);
			});

			it('at the same path under a new id, with no word of the old file going', async () => {
				// A tool that saves by deleting and writing again, on a feed that
				// need not report the deletion of a file replaced at its path.
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();
				await world.provider.delete(file);
				const fixed = await remoteFile('a.md', 'fixed\n');
				expect(fixed.remoteId).not.toBe(file.remoteId);

				const result = await pullNow([fixed]);

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([]);
				expect(noteAt('a.md')).toMatchObject({ content: 'fixed\n' });
			});

			it('or is replaced at its path by another that does not', async () => {
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();
				await world.provider.delete(file);
				const other = world.provider.plantBytes('a.md', LATIN1);

				await pullNow([other]);

				expect(await listed()).toEqual([`${other.remoteId} a.md`]);
			});

			it.each([
				// Forgotten, and a file that is not a note now: a row of its own.
				['a.txt', 2, ['a.txt']],
				['.a.md', 1, []],
			])('or is no longer a note the app would show: %s', async (path, pulled, files) => {
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();
				await world.provider.move(file, path);

				const result = await world.engine.pull();

				expect(result).toMatchObject({ status: 'ok', pulled });
				expect(await listed()).toEqual([]);
				expect(world.store.files().map((each) => each.path)).toEqual(files);
			});
		});

		describe('until it is deleted', () => {
			it('by a deletion that names its id', async () => {
				const file = world.provider.plantBytes('a.md', LATIN1);
				world.provider.plantBytes('b.md', LATIN1);
				await world.engine.pull();
				const other = entryAt(world.provider, 'b.md');

				// The id and not the path: a deletion that carries an id and is
				// matched by path anyway takes whatever has the name now.
				await pullNow([{ deleted: true, remoteId: file.remoteId, path: 'b.md' }]);

				expect(await listed()).toEqual([`${other.remoteId} b.md`]);
			});

			it('by a deletion that names only its path', async () => {
				world.provider.plantBytes('a.md', LATIN1);
				const other = world.provider.plantBytes('ab.md', LATIN1);
				await world.engine.pull();

				await pullNow([{ deleted: true, path: 'a.md' }]);

				expect(await listed()).toEqual([`${other.remoteId} ab.md`]);
			});

			it('by the deletion of a folder above it, which is all a path-only feed says', async () => {
				await world.provider.createFolder('Work');
				await world.provider.createFolder('Work/Old');
				world.provider.plantBytes('Work/Old/a.md', LATIN1);
				const other = world.provider.plantBytes('Workshop.md', LATIN1);
				await world.engine.pull();
				// No row for the folder, so no `delete-folder` to do it in the
				// store: this is the engine's own rule.
				world.store.removeFolder('Work/Old');
				world.store.removeFolder('Work');

				await pullNow([{ deleted: true, path: 'Work' }]);

				expect(await listed()).toEqual([`${other.remoteId} Workshop.md`]);
			});

			it('by the deletion of a folder above it that we hold no row for', async () => {
				// A notebook holding nothing but a file we cannot read looks
				// empty here, so the user removes it: the `rmdir` is refused —
				// the directory is not empty on the remote — and the row goes
				// anyway. Nothing but this deletion will ever mention what was
				// inside it, and left listed the file is named for ever at a
				// path that no longer exists.
				const folder = await world.provider.createFolder('Work');
				const file = world.provider.plantBytes('Work/a.md', LATIN1);
				const other = world.provider.plantBytes('Workshop.md', LATIN1);
				await world.engine.pull();
				expect(await listed()).toEqual(
					[`${file.remoteId} Work/a.md`, `${other.remoteId} Workshop.md`].sort()
				);
				world.store.removeFolder('Work');

				await pullNow([{ deleted: true, remoteId: folder.remoteId, path: 'Work' }]);

				expect(await listed()).toEqual([`${other.remoteId} Workshop.md`]);
			});

			// The file was moved out of the notebook before it went, and the round
			// says both. Either order: read off the decisions so far, the entry
			// behind the deletion puts the record back, but the deletion behind
			// the entry would take it away again.
			it.each([
				['the entry last', false],
				['the entry first', true],
			])('but not when the same round says the file is elsewhere, %s', async (_o, first) => {
				const folder = await world.provider.createFolder('Work');
				const file = world.provider.plantBytes('Work/a.md', LATIN1);
				await world.engine.pull();
				world.store.removeFolder('Work');
				const moved = await world.provider.move(file, 'a.md');
				const gone: ChangeEntry = {
					deleted: true,
					remoteId: folder.remoteId,
					path: 'Work',
				};

				await pullNow(first ? [moved, gone] : [gone, moved]);

				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			});

			it('but not by a deletion that names an id and no path, which says nothing of what was inside', async () => {
				// Graph, for a folder it can no longer place. The notice waits
				// for a re-scan (docs/ARCHITECTURE.md §7).
				const folder = await world.provider.createFolder('Work');
				const file = world.provider.plantBytes('Work/a.md', LATIN1);
				await world.engine.pull();
				world.store.removeFolder('Work');

				await pullNow([{ deleted: true, remoteId: folder.remoteId }]);

				expect(await listed()).toEqual([`${file.remoteId} Work/a.md`]);
			});

			it('by the deletion of a folder above it, on a feed that names the folder by id alone', async () => {
				const folder = await world.provider.createFolder('Work');
				world.provider.plantBytes('Work/a.md', LATIN1);
				await world.engine.pull();

				await pullNow([{ deleted: true, remoteId: folder.remoteId }]);

				expect(await listed()).toEqual([]);
				expect(world.store.folders()).toEqual([]);
			});

			it('when its own entry finds it gone, which is all the word there may be', async () => {
				// Moved into a folder that was then deleted, on a feed that reports
				// folders alone: the file's entry and the folder's deletion, and
				// the record is still at the path the file had before.
				const folder = await world.provider.createFolder('Work');
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();
				const moved = await world.provider.move(file, 'Work/a.md');
				await world.provider.delete(folder);

				const result = await pullNow([moved, { deleted: true, remoteId: folder.remoteId }]);

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([]);
			});

			// Dropbox tells a move as a deletion and an entry, in either order.
			it.each([
				['the entry first', true],
				['the deletion first', false],
			])('but not by the deletion half of a move, %s', async (_order, entryFirst) => {
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();
				const moved = await world.provider.move(file, 'b.md');
				const gone: ChangeEntry = { deleted: true, path: 'a.md' };

				const result = await pullNow(entryFirst ? [moved, gone] : [gone, moved]);

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([`${file.remoteId} b.md`]);
			});

			describe('under a folder the same round moves', () => {
				/** The folder renamed, with the listed file still inside it. */
				const renamedOver = async () => {
					const folder = await world.provider.createFolder('Work');
					const file = world.provider.plantBytes('Work/a.md', LATIN1);
					await world.engine.pull();
					expect(await listed()).toEqual([`${file.remoteId} Work/a.md`]);
					const moved = await world.provider.move(folder, 'Archive');
					return { file, moved };
				};

				// Dropbox tells the rename as every path deleted and every one
				// listed again, in either order. The record went with the folder,
				// so the deletion names a path it is no longer at.
				it.each([
					['the entry last', false],
					['the entry first', true],
				])('keeps it where the folder went, %s', async (_order, entryFirst) => {
					const { file, moved } = await renamedOver();
					const here = { ...file, path: 'Archive/a.md' };
					const gone: ChangeEntry = { deleted: true, path: 'Work/a.md' };

					const result = await pullNow(
						entryFirst ? [moved, here, gone] : [moved, gone, here]
					);

					expect(result.status).toBe('ok');
					expect(await listed()).toEqual([`${file.remoteId} Archive/a.md`]);
				});

				it('and lets go of one deleted out of the folder before the rename', async () => {
					// The same two entries less the one that says where the file
					// is — which is the whole difference between a file carried
					// along and a file that went. Kept, it is named for ever at
					// a path nothing is at.
					const { moved } = await renamedOver();

					const result = await pullNow([moved, { deleted: true, path: 'Work/a.md' }]);

					expect(result.status).toBe('ok');
					expect(await listed()).toEqual([]);
				});
			});

			it('and is listed again when the round that deleted it goes on to say it is there', async () => {
				// A deletion by path, and then the same file at the same path. The
				// list the batch began with says it is listed already; by then it
				// is not.
				const file = world.provider.plantBytes('a.md', LATIN1);
				await world.engine.pull();

				await pullNow([{ deleted: true, path: 'a.md' }, file]);

				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			});
		});

		describe('until a rescan does not see it', () => {
			const twoListed = async () => {
				const kept = world.provider.plantBytes('a.md', LATIN1);
				const gone = world.provider.plantBytes('b.md', LATIN1);
				await world.engine.pull();
				await world.provider.delete(gone);
				return { kept, gone };
			};

			it('and keeps the ones it does', async () => {
				const { kept } = await twoListed();
				killTheCursor();

				const result = await world.engine.pull();

				expect(result).toMatchObject({ status: 'ok', pulled: 1 });
				expect(await listed()).toEqual([`${kept.remoteId} a.md`]);
			});

			it('except a scan that may be missing things, which proves nothing gone', async () => {
				const { kept, gone } = await twoListed();
				killTheCursor(true);

				const result = await world.engine.pull();

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual([`${kept.remoteId} a.md`, `${gone.remoteId} b.md`]);
			});

			it('and is still listed when the scan is interrupted before its last page', async () => {
				// Nothing clears the list when a scan starts: only its last page
				// knows what was not seen.
				const paged = createFakeProvider({ pageSize: 1 });
				await paged.ensureRoot();
				const first = paged.plantBytes('a.md', LATIN1);
				const second = paged.plantBytes('b.md', LATIN1);
				await engineWith({ provider: paged }).pull();
				const dead = world.store.storedCursor();
				const pages = { read: 0 };
				const interrupted = engineWith({
					provider: {
						...paged,
						changes: (cursor) => {
							if (cursor === dead)
								return Promise.reject(new CursorResetError('reset'));
							pages.read += 1;
							return pages.read > 1
								? Promise.reject(new Error('network down'))
								: paged.changes(cursor);
						},
					},
				});

				const result = await interrupted.pull();

				expect(result.status).toBe('retry');
				expect(pages.read).toBe(2);
				expect(await listed()).toEqual(
					[`${first.remoteId} a.md`, `${second.remoteId} b.md`].sort()
				);
			});
		});

		describe('under a folder', () => {
			it('follows the folder when a feed says the folder moved and nothing else', async () => {
				const folder = await world.provider.createFolder('Work');
				const file = world.provider.plantBytes('Work/a.md', LATIN1);
				const other = world.provider.plantBytes('Workshop.md', LATIN1);
				await world.engine.pull();
				await world.provider.move(folder, 'Archive');

				const result = await world.engine.pull();

				expect(result.status).toBe('ok');
				expect(await listed()).toEqual(
					[`${file.remoteId} Archive/a.md`, `${other.remoteId} Workshop.md`].sort()
				);
			});

			it.each([
				['the deletion first', false],
				['the entry first', true],
			])(
				'follows it when the move is told as its old path deleted and the folder alone, %s',
				async (_order, entryFirst) => {
					// Taken at its word, the deletion covers everything under the
					// path, and nothing in the round lists the file again.
					const folder = await world.provider.createFolder('Work');
					const file = world.provider.plantBytes('Work/a.md', LATIN1);
					await world.engine.pull();
					const moved = await world.provider.move(folder, 'Archive');
					const gone: ChangeEntry = { deleted: true, path: 'Work' };

					const result = await pullNow(entryFirst ? [moved, gone] : [gone, moved]);

					expect(result.status).toBe('ok');
					expect(await listed()).toEqual([`${file.remoteId} Archive/a.md`]);
				}
			);

			it('is listed again when the round deletes the folder and then says the file is there', async () => {
				// The folder's deletion takes the record with it in the store, so
				// the entry behind it is not the repeat the batch's list says it is.
				const folder = await world.provider.createFolder('Work');
				const file = world.provider.plantBytes('Work/a.md', LATIN1);
				await world.engine.pull();

				await pullNow([
					{ deleted: true, remoteId: folder.remoteId },
					{ ...folder, remoteId: 'remade' },
					file,
				]);

				expect(await listed()).toEqual([`${file.remoteId} Work/a.md`]);
			});

			it('and a file the same round says is still unreadable there is not listed twice', async () => {
				// The engine has to see the folder's move in what it has decided,
				// or the file reads as renamed and is recorded over its own record.
				const folder = await world.provider.createFolder('Work');
				const file = world.provider.plantBytes('Work/a.md', LATIN1);
				await world.engine.pull();
				const moved = await world.provider.move(folder, 'Archive');
				const entry = { ...file, path: 'Archive/a.md' };
				const { batches, engine: again } = watched(
					reporting(world.provider, [moved, entry])
				);

				await again.pull();

				expect(
					batches.flatMap((batch) => batch.changes.map((change) => change.kind))
				).toEqual(['move-folder']);
				expect(await listed()).toEqual([`${file.remoteId} Archive/a.md`]);
			});
		});

		describe('by a push that meets it', () => {
			it('when the conflict says which file and where', async () => {
				const { entry, note } = await pulledNote('a.md', 'one\n');
				editHere(world.store, note, 'my edit\n');
				world.provider.plantBytes('a.md', LATIN1);

				const result = await world.engine.push();

				expect(result.conflicts).toEqual([COPY]);
				expect(await listed()).toEqual([`${entry.remoteId} a.md`]);
			});

			it('when the note steps aside still bound to a file of its own', async () => {
				const { note } = await pulledNote('mine.md', 'one\n');
				world.store.put({ ...note, path: 'a.md', content: 'my edit\n', dirty: true });
				world.store.queue({ op: 'write', noteId: note.id, path: 'a.md' });
				world.store.queue({
					op: 'move',
					noteId: note.id,
					path: 'mine.md',
					targetPath: 'a.md',
				});
				const file = world.provider.plantBytes('a.md', LATIN1);

				await world.engine.push();

				expect(await listed()).toEqual([`${file.remoteId} a.md`]);
			});

			it('once, when the name the edit was first given turns out to be taken', async () => {
				const { entry, note } = await pulledNote('a.md', 'one\n');
				editHere(world.store, note, 'my edit\n');
				world.provider.plantBytes('a.md', LATIN1);
				await remoteFile(COPY, 'their edit\n');
				const { batches, engine: pushing } = watched();

				await pushing.push();

				expect(
					batches.flatMap((batch) =>
						batch.changes.flatMap((change) =>
							change.kind === 'unreadable' ? [change] : []
						)
					)
				).toEqual([
					{ kind: 'unreadable', file: { remoteId: entry.remoteId, path: 'a.md' } },
				]);
			});

			it('and by the next pull when the push knew the file only by its id', async () => {
				// `runWrite` found nothing at the note's path and asked by id. The
				// file is somewhere, and only its own entry says where.
				const { entry, note } = await pulledNote('a.md', 'one\n');
				editHere(world.store, note, 'my edit\n');
				await world.provider.move(entry, 'renamed.md');
				world.provider.plantBytes('renamed.md', LATIN1);

				await world.engine.push();

				expect(await listed()).toEqual([]);

				await world.engine.pull();

				expect(await listed()).toEqual([`${entry.remoteId} renamed.md`]);
			});
		});

		it('and the list costs nothing when it is lost: the next mention is read and listed again', async () => {
			// No decision rests on the list. A store that lost it is a store the
			// notice is missing from until the file is next named, and no more.
			const file = world.provider.plantBytes('a.md', LATIN1);
			await world.engine.pull();
			await world.store.applyChanges({
				changes: [{ kind: 'forget-unreadable', remoteId: file.remoteId }],
			});

			const result = await pullNow([file]);

			expect(result).toMatchObject({ status: 'ok', pulled: 1 });
			expect(world.store.notes()).toEqual([]);
			expect(await listed()).toEqual([`${file.remoteId} a.md`]);
		});
	});
});
