import { describe, expect, it } from 'vitest';

import {
	ancestorPaths,
	basename,
	isHidden,
	isWithin,
	parentPath,
	rebasePath,
} from '../../src/paths.js';
import { createDropboxProvider, type FetchLike } from '../../src/providers/dropbox.js';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import { createGDriveProvider } from '../../src/providers/gdrive.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import type { StorageProvider } from '../../src/providers/types.js';
import { conflictFilePath } from '../../src/sync/conflicts.js';
import { createSyncEngine, type SyncEngine, type SyncOutcome } from '../../src/sync/engine.js';
import type { SyncNote } from '../../src/sync/store.js';
import { createDropboxStub } from '../providers/dropboxStub.js';
import { createGDriveStub } from '../providers/gdriveStub.js';
import { createOneDriveStub } from '../providers/onedriveStub.js';
import { createMemoryStore, type MemoryStore } from './memoryStore.js';

/**
 * docs/ARCHITECTURE.md §7's conflict rule, and the engine as a whole, over every
 * provider: the in-memory fake in both of its folder modes and each adapter
 * over its wire stub. `engine.test.ts` pins every branch against the fake; this
 * asks whether the answers survive what each provider actually reports — a
 * move as a deletion and an entry, a feed with no paths, a version that changes
 * on a move.
 *
 * Two devices share one remote. Each is an engine over its own store and its
 * own adapter, as two browsers would be, and the user's actions are made the
 * way `apps/web/src/store/queue.ts` queues them.
 */

interface Remote {
	/** The state underneath, whatever the wire says. */
	readonly backing: FakeProvider;
	/** An adapter of its own, for one more device. */
	readonly adapter: () => StorageProvider;
}

const over = <T>(
	create: (options: {
		fetch: FetchLike;
		getAccessToken: () => Promise<string>;
		appVersion: string;
		clientId: string;
	}) => T,
	fetch: FetchLike
): T =>
	create({
		fetch,
		getAccessToken: () => Promise.resolve('stub-token'),
		appVersion: '0.1.0',
		clientId: 'stub-client',
	});

const START = new Date('2026-01-01T00:00:00Z');

const REMOTES: readonly (readonly [string, () => Remote])[] = [
	[
		'the fake, reporting folders alone',
		() => {
			const backing = createFakeProvider({ startAt: START, folderChanges: 'folder-only' });
			return { backing, adapter: () => backing };
		},
	],
	[
		'the fake, reporting whole subtrees',
		() => {
			const backing = createFakeProvider({ startAt: START, folderChanges: 'recursive' });
			return { backing, adapter: () => backing };
		},
	],
	[
		'dropbox over its stub',
		() => {
			const stub = createDropboxStub({ startAt: START });
			return {
				backing: stub.backing,
				adapter: () => over(createDropboxProvider, stub.fetch),
			};
		},
	],
	[
		'dropbox over its stub, one entry per page',
		() => {
			const stub = createDropboxStub({ startAt: START, pageSize: 1 });
			return {
				backing: stub.backing,
				adapter: () => over(createDropboxProvider, stub.fetch),
			};
		},
	],
	[
		'onedrive over its stub',
		() => {
			const stub = createOneDriveStub({ startAt: START });
			return {
				backing: stub.backing,
				adapter: () => over(createOneDriveProvider, stub.fetch),
			};
		},
	],
	[
		'onedrive over its stub, one entry per page',
		() => {
			const stub = createOneDriveStub({ startAt: START, pageSize: 1 });
			return {
				backing: stub.backing,
				adapter: () => over(createOneDriveProvider, stub.fetch),
			};
		},
	],
	[
		'gdrive over its stub',
		() => {
			const stub = createGDriveStub({ startAt: START });
			return {
				backing: stub.backing,
				adapter: () => over(createGDriveProvider, stub.fetch),
			};
		},
	],
	[
		'gdrive over its stub, one entry per page',
		() => {
			const stub = createGDriveStub({ startAt: START, pageSize: 1 });
			return {
				backing: stub.backing,
				adapter: () => over(createGDriveProvider, stub.fetch),
			};
		},
	],
];

const AT = new Date('2026-09-15T14:32:10Z');
const COPY = /^(.*) \(conflict [^)]+\)\.md$/;

interface Device {
	readonly name: string;
	readonly store: MemoryStore;
	readonly engine: SyncEngine;
}

const device = async (
	remote: Remote,
	name: string,
	/** Something put between the engine and the provider, to act at a chosen call. */
	around: (provider: StorageProvider) => StorageProvider = (provider) => provider
): Promise<Device> => {
	const provider = around(remote.adapter());
	await provider.ensureRoot();
	const store = createMemoryStore();
	const counter = { next: 0 };
	const engine = createSyncEngine({
		provider,
		store,
		now: () => AT,
		newId: () => {
			counter.next += 1;
			return `${name}-copy-${String(counter.next)}`;
		},
	});
	return { name, store, engine };
};

// ---------------------------------------------------------------- the user

/** A note the user deleted whose delete has not gone yet: a tombstone, not a note. */
const buried = (d: Device, id: string): boolean =>
	d.store.ops().some((op) => op.op === 'delete' && op.noteId === id);

const live = (d: Device): SyncNote[] => d.store.notes().filter((note) => !buried(d, note.id));

const liveAt = (d: Device, path: string): SyncNote => {
	const note = live(d).find((each) => each.path === path);
	if (note === undefined) throw new Error(`${d.name} has no note at ${path}`);
	return note;
};

/**
 * A name a live note holds. Not a deleted one's: the web app frees that name
 * at once (`takenNamesIn`), and a note made there sits beside the tombstone
 * until its delete has gone.
 */
const taken = (d: Device, path: string): boolean => live(d).some((note) => note.path === path);

const queueWrite = (d: Device, note: SyncNote): void => {
	const queued = d.store.ops().some((op) => op.op === 'write' && op.noteId === note.id);
	if (!queued) d.store.queue({ op: 'write', noteId: note.id, path: note.path });
};

const counters = { note: 0, file: 0 };

/**
 * The notebook a note is going into, as `createNote` and `moveNote` do it: both
 * call `ensureFolder` for the folder they are putting the note in, so a note
 * never lands under a path with no row and no `mkdir` owed for it.
 */
const intoNotebook = (d: Device, path: string): void => {
	const folder = parentPath(path);
	if (folder !== '') addNotebook(d, folder);
};

const create = (d: Device, path: string, content: string): SyncNote => {
	counters.note += 1;
	intoNotebook(d, path);
	const note = { id: `${d.name}-${String(counters.note)}`, path, content, dirty: true };
	d.store.put(note);
	queueWrite(d, { ...note });
	return { ...note };
};

const edit = (d: Device, path: string, content: string): void => {
	const note = { ...liveAt(d, path), content, dirty: true };
	d.store.put(note);
	queueWrite(d, note);
};

/** As `queueMove`: one move per note, from wherever the file still is. */
const rename = (d: Device, path: string, to: string): void => {
	const note = liveAt(d, path);
	intoNotebook(d, to);
	d.store.put({ ...note, path: to });
	const moves = d.store.ops().filter((op) => op.op === 'move' && op.noteId === note.id);
	const origin = moves[0]?.path ?? path;
	moves.forEach((op) => {
		d.store.unqueue(op.seq);
	});
	if (note.remoteId !== undefined && origin !== to) {
		d.store.queue({ op: 'move', noteId: note.id, path: origin, targetPath: to });
	}
};

/**
 * As `queue.ts` withdrawMkdirs: a notebook gone before its `mkdir` was ever
 * sent leaves no directory to remove, so the `mkdir` must not go either.
 */
const withdrawMkdirs = (d: Device, path: string): void => {
	d.store
		.ops()
		.filter((op) => op.op === 'mkdir' && isWithin(op.path, path))
		.forEach((op) => {
			d.store.unqueue(op.seq);
		});
};

/** As `queue.ts` queueMkdir: an `rmdir` at this path or above it is withdrawn. */
const askForNotebook = (d: Device, path: string): void => {
	d.store
		.ops()
		.filter((op) => op.op === 'rmdir' && isWithin(path, op.path))
		.forEach((op) => {
			d.store.unqueue(op.seq);
		});
	if (!d.store.ops().some((op) => op.op === 'mkdir' && op.path === path)) {
		d.store.queue({ op: 'mkdir', path });
	}
};

/**
 * As `store/folders.ts` ensureFolder and createFolder: the row, a `mkdir` that
 * records its id, and the same for every notebook above it that is missing —
 * without which a `createFolder` would be asked for a directory whose parent is
 * not there, which some providers refuse.
 */
const addNotebook = (d: Device, path: string): void => {
	[...ancestorPaths(path), path].forEach((at) => {
		if (d.store.folders().some((folder) => folder.path === at)) return;
		d.store.putFolder({ path: at });
		askForNotebook(d, at);
	});
};

/**
 * As `store/files.ts` addAttachment will: the row, its bytes held until they
 * go, and the upload. Its name is stamped with its bytes, as the app's are, so
 * one name is one file wherever it is added.
 */
const attach = (d: Device, path: string, bytes: Uint8Array<ArrayBuffer>): string => {
	counters.file += 1;
	intoNotebook(d, path);
	const id = `${d.name}-file-${String(counters.file)}`;
	d.store.putFile({ id, path, size: bytes.byteLength }, { bytes: bytes.slice(), pinned: true });
	d.store.queue({ op: 'upload', fileId: id, path });
	return id;
};

/**
 * A notebook's files, as `moveFolder` will move them: each row re-pathed, and
 * a `move-file` from wherever the file still is for each one that went up.
 * One that has not goes up from where it is now.
 */
const moveFiles = (d: Device, path: string, to: string): void => {
	d.store
		.files()
		.filter((file) => isWithin(file.path, path))
		.forEach((file) => {
			const at = rebasePath(file.path, path, to);
			d.store.putFile({ ...file, path: at });
			const moves = d.store
				.ops()
				.filter((op) => op.op === 'move-file' && op.fileId === file.id);
			const origin = moves[0]?.path ?? file.path;
			moves.forEach((op) => {
				d.store.unqueue(op.seq);
			});
			if (file.remoteId !== undefined && origin !== at) {
				d.store.queue({ op: 'move-file', fileId: file.id, path: origin, targetPath: at });
			}
		});
};

/**
 * A notebook's files, as `deleteFolder` will delete them: each row and its
 * bytes, a `delete-file` for each one that went up, and the upload of each one
 * that did not withdrawn — there is nothing left to send.
 */
const removeFiles = (d: Device, path: string): void => {
	d.store
		.files()
		.filter((file) => isWithin(file.path, path))
		.forEach((file) => {
			d.store
				.ops()
				.filter((op) => op.fileId === file.id)
				.forEach((op) => {
					d.store.unqueue(op.seq);
				});
			d.store.dropFile(file.id);
			if (file.remoteId !== undefined) {
				d.store.queue({ op: 'delete-file', path: file.path, remoteId: file.remoteId });
			}
		});
};

/** As `store/folders.ts` deleteFolder: the notes' and files' deletes, then the directory. */
const removeNotebook = (d: Device, path: string): void => {
	const id = d.store.folders().find((folder) => folder.path === path)?.remoteId;
	live(d)
		.filter((note) => isWithin(note.path, path))
		.forEach((note) => {
			remove(d, note.path);
		});
	removeFiles(d, path);
	d.store
		.folders()
		.filter((folder) => isWithin(folder.path, path))
		.forEach((folder) => {
			d.store.removeFolder(folder.path);
		});
	withdrawMkdirs(d, path);
	if (id !== undefined) d.store.queue({ op: 'rmdir', path, remoteId: id });
};

/** As `store/folders.ts` moveFolder: mkdir, the notes' and files' moves, then the directory. */
const renameNotebook = (d: Device, path: string, to: string): void => {
	const id = d.store.folders().find((folder) => folder.path === path)?.remoteId;
	const inside = d.store.folders().filter((folder) => isWithin(folder.path, path));
	inside.forEach((folder) => {
		d.store.removeFolder(folder.path);
	});
	// The destination's own parents first, as `moveFolder`'s `ensureFolder` does.
	[...ancestorPaths(to)].forEach((at) => {
		if (d.store.folders().some((folder) => folder.path === at)) return;
		d.store.putFolder({ path: at });
		askForNotebook(d, at);
	});
	inside.forEach((folder) => {
		const at = rebasePath(folder.path, path, to);
		d.store.putFolder({ path: at });
		askForNotebook(d, at);
	});
	live(d)
		.filter((note) => isWithin(note.path, path))
		.forEach((note) => {
			rename(d, note.path, rebasePath(note.path, path, to));
		});
	moveFiles(d, path, to);
	withdrawMkdirs(d, path);
	if (id !== undefined) d.store.queue({ op: 'rmdir', path, remoteId: id });
};

/** As `deleteNote`: the row stays as a tombstone until its delete has gone. */
const remove = (d: Device, path: string): void => {
	const note = liveAt(d, path);
	d.store.put({ ...note, dirty: false });
	d.store.queue({ op: 'delete', noteId: note.id, path: note.path });
};

// ---------------------------------------------------------------- the checks

/**
 * A sync that did not fail. `retry` is allowed: a push that meets a file of
 * ours at a note's path moves the note aside and answers `retry`, to write it
 * where it now is next time. `quiet` accepts only a round of `ok`s.
 */
const synced = async (d: Device, trace: () => string = () => ''): Promise<SyncOutcome> => {
	const outcome = await d.engine.sync();
	expect(['ok', 'retry'], `${d.name}: ${outcome.error ?? ''}\n${trace()}`).toContain(
		outcome.status
	);
	return outcome;
};

/** Both devices sync until neither has anything left to say. */
const quiet = async (a: Device, b: Device, trace: () => string): Promise<void> => {
	const rounds = Array.from({ length: 8 });
	const settled = await rounds.reduce<Promise<boolean>>(async (done) => {
		if (await done) return true;
		const one = await synced(a, trace);
		const two = await synced(b, trace);
		const moved = one.pulled + one.pushed + two.pulled + two.pushed;
		// Only a round that went through: a pull that fails with nothing to do
		// moves nothing either.
		const ok = one.status === 'ok' && two.status === 'ok';
		return ok && moved === 0 && a.store.ops().length === 0 && b.store.ops().length === 0;
	}, Promise.resolve(false));
	expect(settled, `the devices never went quiet\n${trace()}`).toBe(true);
};

/**
 * The notes the remote holds. A file that is not text (`plantBytes`) is not one
 * of them: no device can read it, so none may hold it (docs/ARCHITECTURE.md §7).
 */
const remoteFiles = (remote: Remote): Record<string, string> =>
	Object.fromEntries(
		remote.backing
			.snapshot()
			.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
			.flatMap((entry) => {
				const content = remote.backing.contentAt(entry.path);
				return content === undefined ? [] : [[entry.path, content]];
			})
	);

/**
 * The files the remote holds that no device can read, which each device lists
 * for its user instead (docs/ARCHITECTURE.md §7). Only what would have been a note.
 */
const remoteUnreadable = (remote: Remote): string[] =>
	remote.backing
		.snapshot()
		.filter(
			(entry) =>
				entry.kind === 'file' &&
				!isHidden(entry.path) &&
				entry.path.endsWith('.md') &&
				remote.backing.contentAt(entry.path) === undefined
		)
		.map((entry) => entry.path)
		.sort();

/** A file's place, for comparing a device's rows with the remote. */
interface Place {
	path: string;
	remoteId: string | undefined;
	size: number | undefined;
}

const byPlace = (x: Place, y: Place): number => x.path.localeCompare(y.path);

/** The files the remote holds that are not notes: what every device mirrors as rows. */
const remoteAttachments = (remote: Remote): Place[] =>
	remote.backing
		.snapshot()
		.filter(
			(entry) => entry.kind === 'file' && !isHidden(entry.path) && !entry.path.endsWith('.md')
		)
		.map((entry) => ({ path: entry.path, remoteId: entry.remoteId, size: entry.size }))
		.sort(byPlace);

const fileRows = (d: Device): Place[] =>
	d.store
		.files()
		.map((file) => ({ path: file.path, remoteId: file.remoteId, size: file.size }))
		.sort(byPlace);

const listedUnreadable = async (d: Device): Promise<string[]> =>
	(await d.store.unreadable()).map((file) => file.path).sort();

const localFiles = (d: Device): Record<string, string> =>
	Object.fromEntries(d.store.notes().map((note) => [note.path, note.content]));

/** Quiet, and then the one thing that matters: both devices hold what the remote holds. */
const converged = async (
	remote: Remote,
	a: Device,
	b: Device,
	trace: () => string = () => ''
): Promise<Record<string, string>> => {
	await quiet(a, b, trace);
	const files = remoteFiles(remote);
	expect(localFiles(a), trace()).toEqual(files);
	expect(localFiles(b), trace()).toEqual(files);
	// And each says which files it is not showing: those, and no others.
	expect(await listedUnreadable(a), trace()).toEqual(remoteUnreadable(remote));
	expect(await listedUnreadable(b), trace()).toEqual(remoteUnreadable(remote));
	// And every file that is not a note is a row on each device, bound to it,
	// at its path: none left to send, none the remote no longer has.
	expect(fileRows(a), `a\n${trace()}`).toEqual(remoteAttachments(remote));
	expect(fileRows(b), `b\n${trace()}`).toEqual(remoteAttachments(remote));
	// And every row names the file that is actually at its path. The general
	// form of the ghost family: the paths and the bytes above can all agree
	// while a row points at another file, or at one that is gone — and then the
	// next edit is written against a version of something else, or of nothing,
	// with no conflict anywhere to say so. Asking for the id at the path rather
	// than merely for an id the remote still has catches both halves, so the
	// existence check it replaces adds nothing: a row whose path holds its id
	// is a row whose file exists.
	const idAt = new Map(remote.backing.snapshot().map((entry) => [entry.path, entry.remoteId]));
	[a, b].forEach((d) => {
		expect(d.store.notes().filter((note) => note.dirty)).toEqual([]);
		expect(d.store.anomalies()).toEqual([]);
		const remotes = d.store.notes().map((note) => note.remoteId);
		expect(remotes).toEqual([...new Set(remotes)]);
		const adrift = d.store
			.notes()
			.filter((note) => note.remoteId !== undefined && idAt.get(note.path) !== note.remoteId)
			.map((note) => `${note.path} -> ${note.remoteId ?? ''}`);
		expect(adrift, `${d.name}\n${trace()}`).toEqual([]);
	});
	return files;
};

/** Every folder the remote holds. */
const remoteFolders = (remote: Remote): string[] =>
	remote.backing
		.snapshot()
		.filter((entry) => entry.kind === 'folder' && !isHidden(entry.path))
		.map((entry) => entry.path)
		.sort();

/**
 * Whether this provider's listings are the whole truth about a folder. Drive's
 * are not — `drive.file` hides what the user put there — so it is never asked
 * to remove one, and the empty directory stays. Every assertion about what is
 * left has to say which of the two it is.
 */
const tidies = (remote: Remote): boolean => remote.adapter().listsEverything;

/** The conflict copies of `path`, by content. */
const copiesOf = (files: Record<string, string>, path: string): string[] =>
	Object.entries(files)
		.filter(([name]) => COPY.exec(name)?.[1] === path.replace(/\.md$/, ''))
		.map(([, content]) => content);

const setUp = async (make: () => Remote) => {
	const remote = make();
	const a = await device(remote, 'a');
	const b = await device(remote, 'b');
	return { remote, a, b };
};

/** A note both devices have synced. */
const shared = async (a: Device, b: Device, path: string, content: string): Promise<void> => {
	create(a, path, content);
	await synced(a);
	await synced(b);
	expect(liveAt(b, path).content).toBe(content);
};

describe.each(REMOTES)('the engine over %s', (_, make) => {
	describe('the conflict rule', () => {
		it('keeps the path for the remote and the other edit beside it', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			edit(a, 'plan.md', 'from a\n');
			edit(b, 'plan.md', 'from b\n');

			await synced(a);
			await synced(b);

			const files = await converged(remote, a, b);
			expect(files['plan.md']).toBe('from a\n');
			expect(copiesOf(files, 'plan.md')).toEqual([expect.stringContaining('from b')]);
		});

		it('keeps an edit here when the file was deleted there', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			remove(b, 'plan.md');
			await synced(b);
			edit(a, 'plan.md', 'kept\n');

			await synced(a);

			const files = await converged(remote, a, b);
			expect(files).toEqual({ 'plan.md': 'kept\n' });
		});

		it('lets a delete here win over an edit there that it never saw', async () => {
			// §7, "A locally deleted note keeps its row": the delete is something
			// the user did, and the edit may be their own from the other device.
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			remove(a, 'plan.md');
			edit(b, 'plan.md', 'edited\n');
			await synced(b);

			await synced(a);

			expect(await converged(remote, a, b)).toEqual({});
		});

		it('follows a rename there under an edit here, with no copy', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			rename(b, 'plan.md', 'renamed.md');
			await synced(b);
			edit(a, 'plan.md', 'edited\n');

			await synced(a);

			expect(await converged(remote, a, b)).toEqual({ 'renamed.md': 'edited\n' });
		});

		it('moves a note made offline aside when the other device took its name first', async () => {
			const { remote, a, b } = await setUp(make);
			create(a, 'Untitled.md', 'from a\n');
			create(b, 'Untitled.md', 'from b\n');

			await synced(a);
			await synced(b);

			const files = await converged(remote, a, b);
			expect(files['Untitled.md']).toBe('from a\n');
			expect(copiesOf(files, 'Untitled.md')).toEqual([expect.stringContaining('from b')]);
		});

		it('makes the copy when the conflict is found by the push rather than the pull', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			edit(b, 'plan.md', 'from b\n');
			await synced(b);
			edit(a, 'plan.md', 'from a\n');

			// Straight to the push, with the other device's write unseen.
			expect((await a.engine.push()).conflicts).toHaveLength(1);

			const files = await converged(remote, a, b);
			expect(files['plan.md']).toBe('from b\n');
			expect(copiesOf(files, 'plan.md')).toEqual([expect.stringContaining('from a')]);
		});

		it('brings the copy one device made to the other, in a folder', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'Work/plan.md', 'base\n');
			edit(a, 'Work/plan.md', 'from a\n');
			edit(b, 'Work/plan.md', 'from b\n');
			await synced(b);
			await synced(a);

			const files = await converged(remote, a, b);
			expect(files['Work/plan.md']).toBe('from b\n');
			expect(copiesOf(files, 'Work/plan.md')).toEqual([expect.stringContaining('from a')]);
			expect(live(b).map((note) => note.path)).toContain(
				Object.keys(files).find((path) => COPY.test(path))
			);
		});
	});

	describe('a note another tool saved in an encoding that is not UTF-8', () => {
		/** "café" as Latin-1 writes it: `0xE9` alone is not a UTF-8 sequence. */
		const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);

		/** Saved in place, as an editor does: the same file, new bytes. */
		const resaved = (remote: Remote, path: string): string =>
			remote.backing.plantBytes(path, LATIN1).remoteId;

		const leftAlone = (remote: Remote, path: string, id: string, devices: Device[]): void => {
			expect(remote.backing.bytesAt(path)).toEqual(LATIN1);
			devices.forEach((d) => {
				expect(d.store.notes().filter((note) => note.remoteId === id)).toEqual([]);
			});
		};

		it('is left alone, and goes from a device that had not touched it', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			await shared(a, b, 'other.md', 'other\n');
			const id = resaved(remote, 'plan.md');

			expect(await converged(remote, a, b)).toEqual({ 'other.md': 'other\n' });
			leftAlone(remote, 'plan.md', id, [a, b]);
		});

		it('keeps an edit made here as a file beside it, found by the pull', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			edit(a, 'plan.md', 'from a\n');
			const id = resaved(remote, 'plan.md');

			await synced(a);

			const files = await converged(remote, a, b);
			expect(Object.keys(files)).toHaveLength(1);
			expect(copiesOf(files, 'plan.md')).toEqual(['from a\n']);
			leftAlone(remote, 'plan.md', id, [a, b]);
		});

		it('and the same when it is the push that finds it', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			edit(a, 'plan.md', 'from a\n');
			const id = resaved(remote, 'plan.md');

			// Straight to the push, with the other tool's save unseen. One drain:
			// the copy is up, and the op did not spend an attempt getting there.
			const pushed = await a.engine.push();
			expect(pushed.status).toBe('ok');
			expect(pushed.conflicts).toHaveLength(1);
			expect(a.store.ops()).toEqual([]);

			const files = await converged(remote, a, b);
			expect(Object.keys(files)).toHaveLength(1);
			expect(copiesOf(files, 'plan.md')).toEqual(['from a\n']);
			leftAlone(remote, 'plan.md', id, [a, b]);
		});

		it('gives a rename here one conflict name, not two', async () => {
			// The note's own file cannot be read and another device has taken
			// the name it was renamed to. Still bound when it steps aside, its
			// retry is set aside a second time.
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			edit(a, 'plan.md', 'from a\n');
			rename(a, 'plan.md', 'taken.md');
			create(b, 'taken.md', 'from b\n');
			await synced(b);
			const id = resaved(remote, 'plan.md');

			// Two pushes and no pull between them, which would cut the note
			// loose itself: the first steps aside, the second is the retry.
			await a.engine.push();
			await a.engine.push();

			const files = await converged(remote, a, b);
			expect(files['taken.md']).toBe('from b\n');
			expect(copiesOf(files, 'taken.md')).toEqual(['from a\n']);
			expect(Object.keys(files)).toHaveLength(2);
			leftAlone(remote, 'plan.md', id, [a, b]);
		});
	});

	describe('a file listed as not UTF-8 text', () => {
		const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);

		const entryAt = (remote: Remote, path: string) => {
			const found = remote.backing.snapshot().find((entry) => entry.path === path);
			if (found === undefined) throw new Error(`nothing on the remote at ${path}`);
			return found;
		};

		it('is listed while it cannot be read, and not once it is fixed or gone', async () => {
			// `converged` asks both devices for exactly the unreadable files the
			// remote holds, each time.
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'plan.md', 'base\n');
			remote.backing.plantBytes('plan.md', LATIN1);

			expect(await converged(remote, a, b)).toEqual({});
			expect(await listedUnreadable(a)).toEqual(['plan.md']);

			// Saved again as UTF-8, in place: read, imported, and off the list.
			await remote.backing.write('plan.md', 'fixed\n', {
				expectedVersion: entryAt(remote, 'plan.md').version,
			});

			expect(await converged(remote, a, b)).toEqual({ 'plan.md': 'fixed\n' });
			expect(await listedUnreadable(a)).toEqual([]);

			remote.backing.plantBytes('plan.md', LATIN1);

			expect(await converged(remote, a, b)).toEqual({});
			expect(await listedUnreadable(b)).toEqual(['plan.md']);

			await remote.backing.delete(entryAt(remote, 'plan.md'));

			expect(await converged(remote, a, b)).toEqual({});
			expect(await listedUnreadable(a)).toEqual([]);
			expect(await listedUnreadable(b)).toEqual([]);
		});

		it('is listed where it is, through a rename, a notebook’s rename and a notebook’s deletion', async () => {
			// Each provider tells these its own way: a move as a deletion and
			// an entry, a folder by id alone, a subtree entry by entry.
			const { remote, a, b } = await setUp(make);
			await remote.backing.createFolder('Work');
			remote.backing.plantBytes('Work/old.md', LATIN1);
			await converged(remote, a, b);
			expect(await listedUnreadable(a)).toEqual(['Work/old.md']);

			await remote.backing.move(entryAt(remote, 'Work/old.md'), 'Work/older.md');
			await converged(remote, a, b);
			expect(await listedUnreadable(a)).toEqual(['Work/older.md']);

			await remote.backing.move(entryAt(remote, 'Work'), 'Archive');
			await converged(remote, a, b);
			expect(await listedUnreadable(a)).toEqual(['Archive/older.md']);

			await remote.backing.delete(entryAt(remote, 'Archive'));
			await converged(remote, a, b);
			expect(await listedUnreadable(a)).toEqual([]);
		});
	});

	describe('a notebook removed here', () => {
		it('leaves the provider no directory when a notebook is deleted', async () => {
			const { remote, a, b } = await setUp(make);
			addNotebook(a, 'Work');
			await shared(a, b, 'Work/plan.md', 'base\n');
			expect(remoteFolders(remote)).toEqual(['Work']);

			removeNotebook(a, 'Work');

			const files = await converged(remote, a, b);
			expect(files).toEqual({});
			expect(remoteFolders(remote)).toEqual(tidies(remote) ? [] : ['Work']);
			// And the other device lets the notebook go too, rather than
			// keeping a row the remote has nothing behind. Where the directory
			// stays, so does the empty notebook, on both devices.
			expect(b.store.folders().map((folder) => folder.path)).toEqual(
				tidies(remote) ? [] : ['Work']
			);
		});

		it('leaves the provider only the new directory when a notebook is renamed', async () => {
			const { remote, a, b } = await setUp(make);
			addNotebook(a, 'Work');
			await shared(a, b, 'Work/plan.md', 'base\n');

			renameNotebook(a, 'Work', 'Plans');

			const files = await converged(remote, a, b);
			expect(files).toEqual({ 'Plans/plan.md': 'base\n' });
			expect(remoteFolders(remote)).toEqual(tidies(remote) ? ['Plans'] : ['Plans', 'Work']);
			expect(b.store.folders().map((folder) => folder.path)).toEqual(
				tidies(remote) ? ['Plans'] : ['Plans', 'Work']
			);
		});

		it('keeps a notebook made again at the name of one just removed', async () => {
			// The round after the removal carries our own deletion back — on
			// Dropbox as a path and nothing else — and the user has made a
			// notebook at that name since. Taken for the new row it deletes the
			// notebook they just made, and everything they have put in it.
			const { remote, a, b } = await setUp(make);
			addNotebook(a, 'Work');
			await shared(a, b, 'Work/plan.md', 'base\n');
			removeNotebook(a, 'Work');
			await synced(a);
			addNotebook(a, 'Work');
			create(a, 'Work/fresh.md', 'fresh\n');

			const files = await converged(remote, a, b);
			expect(files).toEqual({ 'Work/fresh.md': 'fresh\n' });
			expect(remoteFolders(remote)).toEqual(['Work']);
			expect(a.store.folders().map((folder) => folder.path)).toEqual(['Work']);
			expect(b.store.folders().map((folder) => folder.path)).toEqual(['Work']);
		});

		it('keeps the directory when the other device has put a file in it', async () => {
			// The file is not ours to delete: this device has never pulled it,
			// and the notebook's delete says nothing about it.
			const { remote, a, b } = await setUp(make);
			addNotebook(a, 'Work');
			await shared(a, b, 'Work/plan.md', 'base\n');
			create(b, 'Work/theirs.md', 'theirs\n');
			await synced(b);

			removeNotebook(a, 'Work');

			const files = await converged(remote, a, b);
			expect(files).toEqual({ 'Work/theirs.md': 'theirs\n' });
			expect(remoteFolders(remote)).toEqual(['Work']);
		});
	});

	describe('a file that is not a note', () => {
		// Not UTF-8, so no device could take either for a note's text.
		const PNG = new Uint8Array([0xff, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

		it('reaches the other device as a row, its bytes left on the remote', async () => {
			const { remote, a, b } = await setUp(make);
			attach(a, 'Trips/photo-1234abcd.png', PNG);

			await converged(remote, a, b);
			const [row] = b.store.files();
			expect(row).toEqual(
				expect.objectContaining({ path: 'Trips/photo-1234abcd.png', size: PNG.byteLength })
			);
			// Fetched when it is first shown, not when it is pulled.
			expect(b.store.heldBytes(row?.id ?? '')).toBeUndefined();
			expect(remote.backing.bytesAt('Trips/photo-1234abcd.png')).toEqual(PNG);
		});

		it.each([
			['the pull', false],
			['the push', true],
		])('is one file when both devices added it, found by %s', async (_how, between) => {
			// The name is stamped with the bytes: the same picture, added twice.
			const { remote, a, b } = await setUp(make);
			attach(a, 'photo-1234abcd.png', PNG);
			attach(b, 'photo-1234abcd.png', PNG);
			if (between) await b.engine.pull();
			await synced(a);
			if (between) await b.engine.push();

			await converged(remote, a, b);
			expect(remoteAttachments(remote)).toEqual([
				expect.objectContaining({ path: 'photo-1234abcd.png' }),
			]);
		});

		it.each([
			['the pull', false],
			['the push', true],
		])(
			'goes beside a different file the other device put at its name first, found by %s',
			async (_how, between) => {
				// Only a name the app did not choose can do this; the remote
				// keeps the path, and the other goes beside it.
				const { remote, a, b } = await setUp(make);
				attach(a, 'photo.png', PNG);
				attach(b, 'photo.png', JPG);
				if (between) await b.engine.pull();
				await synced(a);
				if (between) await b.engine.push();

				await converged(remote, a, b);
				const beside = conflictFilePath('photo.png', AT);
				expect(remote.backing.bytesAt('photo.png')).toEqual(PNG);
				expect(remote.backing.bytesAt(beside)).toEqual(JPG);
				expect(remoteAttachments(remote)).toHaveLength(2);
			}
		);

		it('moves with its notebook, and leaves no directory behind', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'Work/plan.md', 'base\n');
			attach(a, 'Work/photo.png', PNG);
			await converged(remote, a, b);
			const sent = remoteAttachments(remote)[0]?.remoteId;

			renameNotebook(a, 'Work', 'Plans');

			await converged(remote, a, b);
			// Moved, not sent again.
			expect(remoteAttachments(remote)).toEqual([
				expect.objectContaining({ path: 'Plans/photo.png', remoteId: sent }),
			]);
			expect(remoteFolders(remote)).toEqual(tidies(remote) ? ['Plans'] : ['Plans', 'Work']);
		});

		it('goes with its notebook, and leaves no directory behind', async () => {
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'Work/plan.md', 'base\n');
			attach(a, 'Work/photo.png', PNG);
			await converged(remote, a, b);

			removeNotebook(a, 'Work');

			expect(await converged(remote, a, b)).toEqual({});
			expect(remoteAttachments(remote)).toEqual([]);
			expect(remoteFolders(remote)).toEqual(tidies(remote) ? [] : ['Work']);
		});

		it('keeps the directory, and the file, that the other device added to a notebook deleted here', async () => {
			// Never pulled here, so not this device's to delete.
			const { remote, a, b } = await setUp(make);
			await shared(a, b, 'Work/plan.md', 'base\n');
			attach(b, 'Work/theirs.png', PNG);
			await synced(b);

			removeNotebook(a, 'Work');

			await converged(remote, a, b);
			expect(remoteAttachments(remote)).toEqual([
				expect.objectContaining({ path: 'Work/theirs.png' }),
			]);
			expect(remoteFolders(remote)).toEqual(['Work']);
		});

		it.each([
			['sent again from the bytes held there', true],
			['let go of where nothing holds its bytes', false],
		])(
			'is %s when it was moved out of a notebook the other device deleted',
			async (_how, held) => {
				// The move is the user's, as an edit is, and outranks the
				// deletion as far as the device that made it can keep it.
				const { remote, a, b } = await setUp(make);
				await shared(a, b, 'Trips/plan.md', 'base\n');
				attach(held ? b : a, 'Trips/photo.png', PNG);
				await converged(remote, a, b);
				addNotebook(b, 'Work');
				moveFiles(b, 'Trips/photo.png', 'Work/photo.png');
				removeNotebook(a, 'Trips');
				await synced(a);

				await converged(remote, a, b);
				expect(remoteAttachments(remote)).toEqual(
					held ? [expect.objectContaining({ path: 'Work/photo.png' })] : []
				);
				if (held) expect(remote.backing.bytesAt('Work/photo.png')).toEqual(PNG);
			}
		);
	});

	describe('two devices, at random', () => {
		const run = async (seed: number, attaching = false): Promise<void> => {
			const { remote, a, b } = await setUp(make);
			const soak = createSoak(seed, [a, b], attaching);
			await Array.from({ length: 30 }).reduce<Promise<void>>(async (done) => {
				await done;
				await soak.step(soak.pick([a, b]));
			}, Promise.resolve());

			const files = await converged(remote, a, b, soak.trace);
			const everything = Object.values(files).join('');
			const lost = soak.written().filter((token) => !everything.includes(token));
			expect(
				lost.filter((token) => !soak.mayBeLost(token)),
				soak.trace()
			).toEqual([]);

			// And every file added is on the remote with the bytes it was
			// added with, unless a notebook it was in was deleted.
			const sent = new Map(
				remoteAttachments(remote).map((entry) => [
					tokenOf(entry.path),
					remote.backing.bytesAt(entry.path),
				])
			);
			const missing = soak.attached().filter((token) => !sent.has(token));
			expect(
				missing.filter((token) => !soak.mayBeLost(token)),
				soak.trace()
			).toEqual([]);
			const wrong = [...sent].filter(
				([token, bytes]) => !equalBytes(bytes, attachmentBytes(token))
			);
			expect(wrong, soak.trace()).toEqual([]);

			// And no device holds a notebook the remote has no directory for.
			// That is the ghost this whole op exists to prevent: a row with
			// nothing behind it shows an empty notebook in the sidebar that
			// nothing the user does here will ever make real.
			//
			// Not the other way about — the two devices need not hold the same
			// notebooks. A device that removes one whose directory outlives the
			// removal, because another device's file is still in it, is not told
			// about that directory again until it re-scans, and is right not to
			// have the notebook meanwhile.
			const directories = new Set(
				remote.backing
					.snapshot()
					.filter((entry) => entry.kind === 'folder' && !isHidden(entry.path))
					.map((entry) => entry.path)
			);
			[a, b].forEach((d) => {
				const ghosts = d.store
					.folders()
					.map((folder) => folder.path)
					.filter((path) => !directories.has(path));
				expect(ghosts, `${d.name}\n${soak.trace()}`).toEqual([]);
			});
		};

		// Every seed that has failed is a test in `engine.test.ts` too. A new
		// failure prints the steps that led to it.
		it.each(Array.from({ length: 120 }, (__, seed) => seed + 1))(
			'lose nothing and agree, seed %i',
			(seed) => run(seed)
		);

		// And with files beside the notes, added, moved with their notebooks
		// and deleted with them.
		it.each(Array.from({ length: ATTACHING_SEEDS }, (__, seed) => seed + 1))(
			'lose nothing and agree with files beside the notes, seed %i',
			(seed) => run(seed, true)
		);
	});
});

// ---------------------------------------------------------------- the soak

/** mulberry32: small, seedable, and the same on every machine. */
const random = (seed: number): (() => number) => {
	const state = { value: seed >>> 0 };
	return () => {
		state.value = (state.value + 0x6d2b79f5) >>> 0;
		const t1 = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
		const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
		return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
	};
};

const PATHS = ['a.md', 'b.md', 'c.md', 'Work/d.md', 'Work/e.md'];
/** Where the soak adds files: beside the notes, and in each notebook. */
const FILE_FOLDERS = ['', 'Work', 'Play', 'Work/Inner'];
const ATTACHING_SEEDS = 40;

/**
 * A file's bytes, from the token its name carries — so a name is one file's
 * bytes wherever it is, as the app's hash-stamped names are. Not UTF-8, so no
 * device could take it for a note.
 */
const attachmentBytes = (token: string): Uint8Array<ArrayBuffer> =>
	new Uint8Array([0xff, ...new TextEncoder().encode(token)]);

/** The token a file's name carries, past any conflict suffix. */
const tokenOf = (path: string): string => basename(path).split(/[ .]/u)[0] ?? '';

const equalBytes = (x: Uint8Array | undefined, y: Uint8Array): boolean =>
	x !== undefined && x.length === y.length && x.every((byte, i) => byte === y[i]);
/** Notebooks the soak makes, renames and removes. `Work` is where PATHS point. */
const NOTEBOOKS = ['Work', 'Play', 'Work/Inner'];

/**
 * Random edits, creates, renames, deletes and syncs on two devices. Every
 * edit writes a token no other edit writes, and every token must end up in
 * some file — except where a delete may take it: §7 lets a delete win over an
 * edit made elsewhere that it never saw, so a token written into a note some
 * device deleted, while that note still pointed at the deleted file, may go.
 */
const createSoak = (seed: number, devices: readonly Device[], attaching = false) => {
	const next = random(seed);
	// Files are added on a stream of their own, so the seeds without them
	// take the same steps they always have.
	const nextFile = random(seed ^ 0x5bd1e995);
	const tokens: string[] = [];
	const files: string[] = [];
	const doomed = new Set<string>();
	/** Remote files some device has deleted, and notes deleted before they had one. */
	const deletedFiles = new Set<string>();
	const deletedNotes = new Set<string>();
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

	const token = (d: Device, note: SyncNote | undefined, id: string): string => {
		const made = `t${String(seed)}-${String(tokens.length)}`;
		tokens.push(made);
		const gone =
			deletedNotes.has(`${d.name}:${id}`) ||
			(note?.remoteId !== undefined && deletedFiles.has(note.remoteId));
		if (gone) doomed.add(made);
		return made;
	};

	/**
	 * A note some device is about to delete: §7 lets a delete win over an edit
	 * made elsewhere that it never saw, so whatever either device holds of that
	 * file may go with it.
	 */
	const willTake = (d: Device, note: SyncNote): void => {
		deletedNotes.add(`${d.name}:${note.id}`);
		if (note.remoteId !== undefined) deletedFiles.add(note.remoteId);
		const held = devices.flatMap((each) =>
			each.store
				.notes()
				.filter((other) =>
					note.remoteId === undefined
						? other.id === note.id
						: other.remoteId === note.remoteId
				)
				.map((other) => other.content)
		);
		tokens
			.filter((each) => held.some((content) => content.includes(each)))
			.forEach((each) => doomed.add(each));
	};

	const log: string[] = [];
	const trace = (): string => log.join('\n');
	const say = (d: Device, what: string): void => {
		log.push(`${d.name} ${what}`);
	};

	/** A file added, with a name no other file has. */
	const attachOne = (d: Device): void => {
		const made = `f${String(seed)}-${String(files.length)}`;
		files.push(made);
		const folder = FILE_FOLDERS[Math.floor(nextFile() * FILE_FOLDERS.length)] ?? '';
		const path = folder === '' ? `${made}.png` : `${folder}/${made}.png`;
		say(d, `attach ${path}`);
		attach(d, path, attachmentBytes(made));
	};

	const step = async (d: Device): Promise<void> => {
		if (attaching && nextFile() < 0.2) {
			attachOne(d);
			return;
		}
		const notes = live(d);
		const roll = next();
		if (roll < 0.25 || notes.length === 0) {
			const free = PATHS.filter((path) => !taken(d, path));
			if (free.length === 0) return;
			const note = create(d, pick(free), '');
			const made = token(d, undefined, note.id);
			say(d, `create ${note.path} ${made}`);
			edit(d, note.path, `${made}\n`);
			return;
		}
		const note = pick(notes);
		if (roll < 0.5) {
			const made = token(d, note, note.id);
			say(d, `edit ${note.path} ${made}`);
			edit(d, note.path, `${note.content}${made}\n`);
			return;
		}
		if (roll < 0.6) {
			const free = PATHS.filter((path) => !taken(d, path));
			if (free.length === 0) return;
			const to = pick(free);
			say(d, `rename ${note.path} -> ${to}`);
			rename(d, note.path, to);
			return;
		}
		if (roll < 0.7) {
			willTake(d, note);
			say(d, `delete ${note.path}`);
			remove(d, note.path);
			return;
		}
		if (roll < 0.75) {
			const free = NOTEBOOKS.filter(
				(path) => !d.store.folders().some((folder) => folder.path === path)
			);
			if (free.length === 0) return;
			const at = pick(free);
			say(d, `notebook ${at}`);
			addNotebook(d, at);
			return;
		}
		const notebooks = d.store.folders().map((folder) => folder.path);
		if (notebooks.length === 0) {
			say(d, 'sync');
			await synced(d, trace);
			return;
		}
		if (roll < 0.8) {
			const from = pick(notebooks);
			const free = NOTEBOOKS.filter(
				(path) => !isWithin(path, from) && !taken(d, path) && !notebooks.includes(path)
			);
			if (free.length === 0) return;
			const to = pick(free);
			say(d, `rename notebook ${from} -> ${to}`);
			renameNotebook(d, from, to);
			return;
		}
		if (roll < 0.85) {
			const at = pick(notebooks);
			// Everything inside goes with it, exactly as a note's own delete does.
			live(d)
				.filter((note) => isWithin(note.path, at))
				.forEach((note) => {
					willTake(d, note);
				});
			// Its files too: by id, wherever the other device has put them since.
			d.store
				.files()
				.filter((file) => isWithin(file.path, at))
				.forEach((file) => doomed.add(tokenOf(file.path)));
			say(d, `remove notebook ${at}`);
			removeNotebook(d, at);
			return;
		}
		say(d, 'sync');
		await synced(d, trace);
	};

	return {
		pick,
		step,
		written: () => [...tokens],
		trace,
		mayBeLost: (made: string) => doomed.has(made),
		attached: () => [...files],
	};
};

/**
 * A move hands back a version — a new one on OneDrive, and everywhere the
 * version of the file as the move found it: of bytes nobody has read. Held as the note's own, it says "in step"
 * about a file that may have been edited since the last pull — the pull then
 * skips the file as already seen, and a write checked against it overwrites
 * the other device's edit with no conflict anywhere. Both were found by the
 * two-browser soak (seeds 578 and 461), where they turned on timing; here the
 * other device's edit is put exactly where it has to land.
 */
describe.each(REMOTES)('a rename going up past an edit made elsewhere, over %s', (_, make) => {
	it('does not leave the note holding the old text and calling itself in step', async () => {
		const { remote, a, b } = await setUp(make);
		await shared(a, b, 'plan.md', 'base\n');
		rename(b, 'plan.md', 'ideas.md');
		// Between this device's pull and its push, which is all the room it needs.
		await b.engine.pull();
		edit(a, 'plan.md', 'from a\n');
		await synced(a);

		await b.engine.push();

		const files = await converged(remote, a, b);
		expect(files).toEqual({ 'ideas.md': 'from a\n' });
	});

	it('does not write over that edit when its own is queued in front of the rename', async () => {
		const remote = make();
		const b = await device(remote, 'b');
		const once = { done: false };
		// The write finds nothing at the new name, finds the file by its id, in
		// step — and the other device's edit lands before the move does.
		const a = await device(remote, 'a', (provider) => ({
			...provider,
			move: async (...args) => {
				if (!once.done) {
					once.done = true;
					edit(b, 'plan.md', 'from b\n');
					await synced(b);
				}
				return provider.move(...args);
			},
		}));
		await shared(a, b, 'plan.md', 'base\n');
		edit(a, 'plan.md', 'from a\n');
		rename(a, 'plan.md', 'ideas.md');

		await a.engine.push();

		// The conflict rule, exactly: the remote keeps the path, and the edit that
		// met it is beside it. Two files, and nothing left to send.
		const files = await converged(remote, a, b);
		expect(files['ideas.md']).toBe('from b\n');
		expect(copiesOf(files, 'ideas.md')).toEqual([expect.stringContaining('from a')]);
		expect(Object.keys(files)).toHaveLength(2);
	});

	it('nor when the rename was queued first and the edit behind it', async () => {
		const { remote, a, b } = await setUp(make);
		await shared(a, b, 'plan.md', 'base\n');
		rename(b, 'plan.md', 'ideas.md');
		edit(b, 'ideas.md', 'from b\n');
		await b.engine.pull();
		edit(a, 'plan.md', 'from a\n');
		await synced(a);

		await b.engine.push();

		const files = await converged(remote, a, b);
		expect(files['ideas.md']).toBe('from a\n');
		expect(copiesOf(files, 'ideas.md')).toEqual([expect.stringContaining('from b')]);
		expect(Object.keys(files)).toHaveLength(2);
	});

	/** The read that tells a moved file's bytes fails once; nobody else is editing. */
	const readFailsOnce = (provider: StorageProvider): StorageProvider => {
		const failed = { yet: false, moved: false };
		return {
			...provider,
			move: async (...args) => {
				failed.moved = true;
				return provider.move(...args);
			},
			read: (...args) => {
				if (failed.moved && !failed.yet) {
					failed.yet = true;
					return Promise.reject(new Error('the network went away'));
				}
				return provider.read(...args);
			},
		};
	};

	it('does not make a conflict of an edit nobody else touched, when the moved file could not be read', async () => {
		// Edited and then renamed, which is the order every rename in the app
		// queues them in. Where a move renews the version, the file has to be
		// read to know whose bytes the new one is for; that read failing must
		// not turn the user's edit into a copy beside a file with no other editor.
		const remote = make();
		const a = await device(remote, 'a');
		const b = await device(remote, 'b', readFailsOnce);
		await shared(a, b, 'plan.md', 'base\n');
		edit(b, 'plan.md', 'from b\n');
		rename(b, 'plan.md', 'ideas.md');

		await b.engine.push();
		await b.engine.push();

		expect(await converged(remote, a, b)).toEqual({ 'ideas.md': 'from b\n' });
	});

	it('nor with the rename in front', async () => {
		const remote = make();
		const a = await device(remote, 'a');
		const b = await device(remote, 'b', readFailsOnce);
		await shared(a, b, 'plan.md', 'base\n');
		rename(b, 'plan.md', 'ideas.md');
		edit(b, 'ideas.md', 'from b\n');

		await b.engine.push();
		await b.engine.push();

		expect(await converged(remote, a, b)).toEqual({ 'ideas.md': 'from b\n' });
	});
});
