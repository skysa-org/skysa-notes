import { describe, expect, it } from 'vitest';

import { isHidden, isWithin, rebasePath } from '../../src/paths.js';
import { createDropboxProvider, type FetchLike } from '../../src/providers/dropbox.js';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import { createGDriveProvider } from '../../src/providers/gdrive.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import type { StorageProvider } from '../../src/providers/types.js';
import { createSyncEngine, type SyncEngine, type SyncOutcome } from '../../src/sync/engine.js';
import type { SyncNote } from '../../src/sync/store.js';
import { createDropboxStub } from '../providers/dropboxStub.js';
import { createGDriveStub } from '../providers/gdriveStub.js';
import { createOneDriveStub } from '../providers/onedriveStub.js';
import { createMemoryStore, type MemoryStore } from './memoryStore.js';

/**
 * docs/PLAN.md §7's conflict rule, and the engine as a whole, over every
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

const device = async (remote: Remote, name: string): Promise<Device> => {
	const provider = remote.adapter();
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

const counters = { note: 0 };

const create = (d: Device, path: string, content: string): SyncNote => {
	counters.note += 1;
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

/** As `store/folders.ts` createFolder: the row, and a `mkdir` that records its id. */
const addNotebook = (d: Device, path: string): void => {
	d.store.putFolder({ path });
	d.store.queue({ op: 'mkdir', path });
};

/** As `store/folders.ts` deleteFolder: the notes' deletes, then the directory. */
const removeNotebook = (d: Device, path: string): void => {
	const id = d.store.folders().find((folder) => folder.path === path)?.remoteId;
	live(d)
		.filter((note) => isWithin(note.path, path))
		.forEach((note) => {
			remove(d, note.path);
		});
	d.store
		.folders()
		.filter((folder) => isWithin(folder.path, path))
		.forEach((folder) => {
			d.store.removeFolder(folder.path);
		});
	if (id !== undefined) d.store.queue({ op: 'rmdir', path, remoteId: id });
};

/** As `store/folders.ts` moveFolder: mkdir, the notes' moves, then the directory. */
const renameNotebook = (d: Device, path: string, to: string): void => {
	const id = d.store.folders().find((folder) => folder.path === path)?.remoteId;
	const inside = d.store.folders().filter((folder) => isWithin(folder.path, path));
	inside.forEach((folder) => {
		d.store.removeFolder(folder.path);
	});
	inside.forEach((folder) => {
		const at = rebasePath(folder.path, path, to);
		d.store.putFolder({ path: at });
		d.store.queue({ op: 'mkdir', path: at });
	});
	live(d)
		.filter((note) => isWithin(note.path, path))
		.forEach((note) => {
			rename(d, note.path, rebasePath(note.path, path, to));
		});
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

const remoteFiles = (remote: Remote): Record<string, string> =>
	Object.fromEntries(
		remote.backing
			.snapshot()
			.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
			.map((entry) => [entry.path, remote.backing.contentAt(entry.path) ?? ''])
	);

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
	[a, b].forEach((d) => {
		expect(d.store.notes().filter((note) => note.dirty)).toEqual([]);
		expect(d.store.anomalies()).toEqual([]);
		const remotes = d.store.notes().map((note) => note.remoteId);
		expect(remotes).toEqual([...new Set(remotes)]);
	});
	return files;
};

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

	describe('a notebook removed here', () => {
		/** Every folder the remote holds. */
		const remoteFolders = (remote: Remote): string[] =>
			remote.backing
				.snapshot()
				.filter((entry) => entry.kind === 'folder' && !isHidden(entry.path))
				.map((entry) => entry.path)
				.sort();

		it('leaves the provider no directory when a notebook is deleted', async () => {
			const { remote, a, b } = await setUp(make);
			addNotebook(a, 'Work');
			await shared(a, b, 'Work/plan.md', 'base\n');
			expect(remoteFolders(remote)).toEqual(['Work']);

			removeNotebook(a, 'Work');

			const files = await converged(remote, a, b);
			expect(files).toEqual({});
			expect(remoteFolders(remote)).toEqual([]);
			// And the other device lets the notebook go too, rather than
			// keeping a row the remote has nothing behind.
			expect(b.store.folders()).toEqual([]);
		});

		it('leaves the provider only the new directory when a notebook is renamed', async () => {
			const { remote, a, b } = await setUp(make);
			addNotebook(a, 'Work');
			await shared(a, b, 'Work/plan.md', 'base\n');

			renameNotebook(a, 'Work', 'Plans');

			const files = await converged(remote, a, b);
			expect(files).toEqual({ 'Plans/plan.md': 'base\n' });
			expect(remoteFolders(remote)).toEqual(['Plans']);
			expect(b.store.folders().map((folder) => folder.path)).toEqual(['Plans']);
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

	describe('two devices, at random', () => {
		const run = async (seed: number): Promise<void> => {
			const { remote, a, b } = await setUp(make);
			const soak = createSoak(seed, [a, b]);
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
		};

		// Every seed that has failed is a test in `engine.test.ts` too. A new
		// failure prints the steps that led to it.
		it.each(Array.from({ length: 120 }, (__, seed) => seed + 1))(
			'lose nothing and agree, seed %i',
			run
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

/**
 * Random edits, creates, renames, deletes and syncs on two devices. Every
 * edit writes a token no other edit writes, and every token must end up in
 * some file — except where a delete may take it: §7 lets a delete win over an
 * edit made elsewhere that it never saw, so a token written into a note some
 * device deleted, while that note still pointed at the deleted file, may go.
 */
const createSoak = (seed: number, devices: readonly Device[]) => {
	const next = random(seed);
	const tokens: string[] = [];
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

	const log: string[] = [];
	const trace = (): string => log.join('\n');
	const say = (d: Device, what: string): void => {
		log.push(`${d.name} ${what}`);
	};

	const step = async (d: Device): Promise<void> => {
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
			deletedNotes.add(`${d.name}:${note.id}`);
			if (note.remoteId !== undefined) deletedFiles.add(note.remoteId);
			// What either device already holds of that file may go with it.
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
			say(d, `delete ${note.path}`);
			remove(d, note.path);
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
	};
};
