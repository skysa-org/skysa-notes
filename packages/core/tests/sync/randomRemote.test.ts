import { describe, expect, it } from 'vitest';

import { isHidden, isWithin, joinPath, parentPath, rebasePath } from '../../src/paths.js';
import { createDropboxProvider, type FetchLike } from '../../src/providers/dropbox.js';
import { createFakeProvider, type FakeProvider } from '../../src/providers/fake.js';
import { createGDriveProvider } from '../../src/providers/gdrive.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import type { ChangeEntry, RemoteEntry, StorageProvider } from '../../src/providers/types.js';
import { createSyncEngine } from '../../src/sync/engine.js';
import { createDropboxStub } from '../providers/dropboxStub.js';
import { createGDriveStub } from '../providers/gdriveStub.js';
import { createOneDriveStub } from '../providers/onedriveStub.js';
import { createMemoryStore } from './memoryStore.js';

/**
 * One device, and a remote changed at random underneath it by somebody else:
 * files written, edited, moved and deleted, folders made, renamed, moved into
 * one another and deleted, a few at a time between pulls. After every pull the
 * device must hold exactly what the remote holds — every note at its path with
 * its bytes, and every folder — over each adapter's wire stub at small page
 * sizes, where a round of changes spans several pages.
 *
 * Nothing is edited here, so there is nothing to conflict with: any difference
 * is the engine reading the feed wrongly.
 */

interface Remote {
	readonly backing: FakeProvider;
	readonly adapter: StorageProvider;
}

const START = new Date('2026-01-01T00:00:00Z');

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

const PAGE_SIZES = [1, 2, 3];

const fake =
	(folderChanges: 'folder-only' | 'recursive') =>
	(pageSize: number): Remote => {
		const backing = createFakeProvider({ startAt: START, pageSize, folderChanges });
		return { backing, adapter: backing };
	};

/**
 * The fake's feed told as Dropbox tells it: a deletion is a path and nothing
 * else, and a thing moved is its old path deleted and then its new place — a
 * folder's children with it, whose old paths the folder's deletion covers.
 * The Dropbox stub reports a move as the new place alone, so without this the
 * id-less old-path deletions the engine has to see through are never made.
 * https://www.dropboxforum.com/t5/Dropbox-API-Support-Feedback/Handling-renamed-folders-in-list-folder-list-folder-continue/td-p/225665
 */
const dropboxShaped =
	(folderChanges: 'folder-only' | 'recursive') =>
	(pageSize: number): Remote => {
		const backing = createFakeProvider({ startAt: START, pageSize, folderChanges });
		const at = new Map<string, string>();
		const told = (entry: ChangeEntry): ChangeEntry[] => {
			if (entry.deleted === true) {
				if (entry.path === undefined) return [];
				const gone = entry.path;
				[...at].forEach(([id, path]) => {
					if (isWithin(path, gone)) at.delete(id);
				});
				return [{ path: gone, deleted: true }];
			}
			const was = at.get(entry.remoteId);
			const moved = was !== undefined && was !== entry.path;
			if (moved && entry.kind === 'folder') {
				[...at].forEach(([id, path]) => {
					if (isWithin(path, was)) at.set(id, rebasePath(path, was, entry.path));
				});
			}
			at.set(entry.remoteId, entry.path);
			return moved ? [{ path: was, deleted: true }, entry] : [entry];
		};
		const adapter: StorageProvider = {
			...backing,
			changes: async (cursor) => {
				const set = await backing.changes(cursor);
				return { ...set, entries: set.entries.flatMap(told) };
			},
		};
		return { backing, adapter };
	};

/**
 * The three wire stubs, the fake both ways, and the fake told as Dropbox. The fake and the Dropbox stub
 * replay what happened in order, a folder rename as the folder alone and a
 * deletion at the path it had then; the OneDrive and Drive stubs report each
 * page as it stands at the end, as Graph and Drive do.
 */
const REMOTES: readonly (readonly [string, (pageSize: number) => Remote])[] = [
	[
		'dropbox',
		(pageSize) => {
			const stub = createDropboxStub({ startAt: START, pageSize });
			return { backing: stub.backing, adapter: over(createDropboxProvider, stub.fetch) };
		},
	],
	[
		'onedrive',
		(pageSize) => {
			const stub = createOneDriveStub({ startAt: START, pageSize });
			return { backing: stub.backing, adapter: over(createOneDriveProvider, stub.fetch) };
		},
	],
	[
		'gdrive',
		(pageSize) => {
			const stub = createGDriveStub({ startAt: START, pageSize });
			return { backing: stub.backing, adapter: over(createGDriveProvider, stub.fetch) };
		},
	],
	['the fake, reporting folders alone', fake('folder-only')],
	['the fake, reporting every descendant', fake('recursive')],
	['the fake told as Dropbox, listing every descendant', dropboxShaped('recursive')],
	['the fake told as Dropbox, listing folders alone', dropboxShaped('folder-only')],
];

const CASES = REMOTES.flatMap(([name, make]) =>
	PAGE_SIZES.map((pageSize) => ({
		name: `${name}, ${String(pageSize)} per page`,
		make: () => make(pageSize),
	}))
);

/** Seeds CI runs. Raise it locally to look for more; 2000 passed when this was written. */
const SEEDS = 100;

/** mulberry32, as in `overProviders.test.ts`. */
const random = (seed: number): (() => number) => {
	const state = { value: seed >>> 0 };
	return () => {
		state.value = (state.value + 0x6d2b79f5) >>> 0;
		const t1 = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
		const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
		return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
	};
};

const NAMES = ['A', 'B', 'C'];
const FILES = ['a.md', 'b.md', 'c.md'];

const files = (backing: FakeProvider): RemoteEntry[] =>
	backing.snapshot().filter((entry) => entry.kind === 'file' && !isHidden(entry.path));

const folders = (backing: FakeProvider): RemoteEntry[] =>
	backing.snapshot().filter((entry) => entry.kind === 'folder');

const createRemote = (seed: number, backing: FakeProvider) => {
	const next = random(seed);
	const log: string[] = [];
	const counter = { value: 0 };
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	const taken = (path: string): boolean =>
		backing.snapshot().some((entry) => entry.path.toLowerCase() === path.toLowerCase());
	/** A free name in a random folder, or the root. */
	const freePath = (names: readonly string[], not?: string): string | undefined => {
		const parents = [
			'',
			...folders(backing)
				.map((entry) => entry.path)
				.filter((path) => not === undefined || !isWithin(path, not)),
		];
		const candidates = parents.flatMap((parent) =>
			names.map((name) => joinPath(parent, name)).filter((path) => !taken(path))
		);
		return candidates.length === 0 ? undefined : pick(candidates);
	};

	const step = async (): Promise<void> => {
		const roll = next();
		const body = (): string => {
			counter.value += 1;
			return `body ${String(counter.value)}\n`;
		};
		const someFile = files(backing);
		const someFolder = folders(backing);
		if (roll < 0.25 || someFile.length === 0) {
			const path = freePath(FILES);
			if (path === undefined) return;
			log.push(`write ${path}`);
			await backing.write(path, body(), {});
			return;
		}
		if (roll < 0.4) {
			const file = pick(someFile);
			log.push(`edit ${file.path}`);
			await backing.write(file.path, body(), { expectedVersion: file.version });
			return;
		}
		if (roll < 0.5) {
			const file = pick(someFile);
			const to = freePath(FILES);
			if (to === undefined) return;
			log.push(`move ${file.path} -> ${to}`);
			await backing.move(file, to);
			return;
		}
		if (roll < 0.6) {
			const file = pick(someFile);
			log.push(`delete ${file.path}`);
			await backing.delete(file);
			return;
		}
		if (roll < 0.72 || someFolder.length === 0) {
			const path = freePath(NAMES);
			if (path === undefined) return;
			log.push(`mkdir ${path}`);
			await backing.createFolder(path);
			return;
		}
		if (roll < 0.9) {
			const folder = pick(someFolder);
			const to = freePath(NAMES, folder.path);
			if (to === undefined || parentPath(to) === folder.path) return;
			log.push(`move ${folder.path}/ -> ${to}/`);
			await backing.move(folder, to);
			return;
		}
		const folder = pick(someFolder);
		log.push(`rmdir ${folder.path}`);
		await backing.delete(folder);
	};

	return {
		next,
		step,
		note: (line: string) => log.push(line),
		trace: () => log.join('\n'),
	};
};

describe.each(CASES)('a remote changed at random, over $name', ({ make }) => {
	it.each(Array.from({ length: SEEDS }, (__, seed) => seed + 1))(
		'is followed exactly by a pull after every burst, seed %i',
		async (seed) => {
			const { backing, adapter } = make();
			await adapter.ensureRoot();
			const store = createMemoryStore();
			const remote = createRemote(seed, backing);
			// What each page said, for the trace a failure prints.
			const reporting: StorageProvider = {
				...adapter,
				changes: async (cursor) => {
					const set = await adapter.changes(cursor);
					remote.note(
						`  page: ${set.entries
							.map((entry) =>
								entry.deleted === true
									? `-${entry.path ?? ''}#${entry.remoteId ?? ''}`
									: `+${entry.path}#${entry.remoteId}@${entry.version}`
							)
							.join(' ')}`
					);
					return set;
				},
			};
			const engine = createSyncEngine({ provider: reporting, store, now: () => START });

			await Array.from({ length: 12 }).reduce<Promise<void>>(async (done) => {
				await done;
				const burst = 1 + Math.floor(remote.next() * 4);
				await Array.from({ length: burst }).reduce<Promise<void>>(async (inner) => {
					await inner;
					await remote.step();
				}, Promise.resolve());

				const outcome = await engine.pull();
				expect(outcome.status, `${remote.trace()}\n${outcome.error ?? ''}`).toBe('ok');
				expect(store.anomalies(), remote.trace()).toEqual([]);
				// Each note at a path of its own, and bound to the file there: two
				// rows at one path, or a row pointing at another file, would both
				// read the same bytes and pass the comparison below.
				expect(
					store
						.notes()
						.map((note) => `${note.path} ${note.remoteId ?? ''}`)
						.sort(),
					remote.trace()
				).toEqual(
					files(backing)
						.map((entry) => `${entry.path} ${entry.remoteId}`)
						.sort()
				);
				expect(
					Object.fromEntries(store.notes().map((note) => [note.path, note.content])),
					remote.trace()
				).toEqual(
					Object.fromEntries(
						files(backing).map((entry) => [entry.path, backing.contentAt(entry.path)])
					)
				);
				expect(
					store
						.folders()
						.map((folder) => folder.path)
						.sort(),
					remote.trace()
				).toEqual(
					folders(backing)
						.map((entry) => entry.path)
						.sort()
				);
			}, Promise.resolve());
		}
	);
});
