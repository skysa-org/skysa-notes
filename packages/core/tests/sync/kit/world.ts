import { afterEach, beforeEach, expect } from 'vitest';

import { createFakeProvider, type FakeProvider } from '../../../src/providers/fake.js';
import { CursorResetError } from '../../../src/providers/types.js';
import type { SyncEngine } from '../../../src/sync/engine.js';
import { createMemoryStore, type MemoryStore } from '../memoryStore.js';
import { engineFixture } from './engine.js';
import { expectSoundStore } from './invariants.js';

/**
 * What an engine test works against, made new before every test (#460). A
 * test that wants another provider or store puts it here, and engines made
 * afterwards (`engineWith`) are over it.
 */
interface SyncWorld {
	provider: FakeProvider;
	store: MemoryStore;
	/** The file's engine, over the world as `beforeEach` left it. */
	engine: SyncEngine;
}

/**
 * The engine tests' world and the helpers over it, for a test file to take
 * once at the top. Registers the hooks that make the world before each test
 * and check the store after it (`expectSoundStore`), so every file that takes
 * it is held to the same invariants.
 */
export const syncWorld = () => {
	// Filled in before the first test runs, and again before every one after.
	const world = {} as SyncWorld;
	/** How many `copy-N` ids the file's engine has given out. */
	const ids = { count: 0 };

	beforeEach(async () => {
		ids.count = 0;
		world.provider = createFakeProvider({ startAt: new Date('2026-01-01T00:00:00Z') });
		await world.provider.ensureRoot();
		world.store = createMemoryStore();
		world.engine = engineWith({ newId: copyId });
	});

	// The provider and store alone: the rest of the world is not an engine's option.
	const { engineWith, pullNow, pullPages } = engineFixture(() => ({
		provider: world.provider,
		store: world.store,
	}));

	/** The file engine's ids, `copy-N`, for a test that builds that engine again. */
	const copyId = (): string => {
		ids.count += 1;
		return `copy-${String(ids.count)}`;
	};

	afterEach(() => {
		expectSoundStore(world.store);
	});

	/** Puts a file on the remote and returns what the provider called it. */
	const remoteFile = async (path: string, content: string) =>
		world.provider.write(path, content, {});

	/**
	 * Kills the stored cursor once, so the next pull is a full rescan. The
	 * assertion is the point: without a cursor to lose the test is really about a
	 * first sync, which takes the same path by accident and would stay green with
	 * the reset handling deleted entirely.
	 */
	const killTheCursor = (uploadDifferences?: boolean): void => {
		expect(world.store.storedCursor()).toBeDefined();
		const thrown = { done: false };
		world.provider.setFault((call) => {
			if (call.op !== 'changes' || thrown.done) return undefined;
			thrown.done = true;
			return new CursorResetError('reset', uploadDifferences);
		});
	};

	const noteAt = (path: string) => world.store.notes().find((note) => note.path === path);

	/** A note pulled from the remote the ordinary way, with a cursor stored. */
	const pulledNote = async (path: string, content: string) => {
		const entry = await remoteFile(path, content);
		await world.engine.pull();
		const note = noteAt(path);
		if (note === undefined) throw new Error(`no note at ${path}`);
		return { entry, note };
	};

	const folderPaths = () =>
		world.store
			.folders()
			.map((folder) => folder.path)
			.sort();

	const notePaths = () =>
		world.store
			.notes()
			.map((note) => note.path)
			.sort();

	return {
		world,
		copyId,
		engineWith,
		pullNow,
		pullPages,
		remoteFile,
		killTheCursor,
		noteAt,
		pulledNote,
		folderPaths,
		notePaths,
	};
};
