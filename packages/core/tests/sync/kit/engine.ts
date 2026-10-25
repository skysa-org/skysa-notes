import { beforeEach } from 'vitest';

import type { ChangeEntry, StorageProvider } from '../../../src/providers/types.js';
import { createSyncEngine, type SyncEngineOptions } from '../../../src/sync/engine.js';
import type { SyncStore } from '../../../src/sync/store.js';

/**
 * The engine as the sync tests drive it: at one moment (`AT`), over a
 * provider that reports what it is told (`reporting`, `paging`), and built
 * over a test file's own provider and store (`engineFixture`).
 */

/** The moment every engine here runs at, so a conflict copy's name is known. */
export const AT = new Date('2026-09-15T14:32:10Z');

/**
 * The same provider, but `changes` reports exactly what it is told to. The fake
 * reports a move as one entry; real providers disagree about that, and the
 * disagreement is where notes get lost, so the shapes they produce are fed in
 * directly rather than waited for.
 */
export const reporting = (
	base: StorageProvider,
	entries: readonly ChangeEntry[]
): StorageProvider => ({
	...base,
	changes: () => Promise.resolve({ entries, cursor: 'reported', more: false }),
});

/** The same provider, with `changes` handing out these pages one call at a time. */
export const paging = (
	base: StorageProvider,
	pages: readonly (readonly ChangeEntry[] | Error)[]
) => {
	const served = { count: 0 };
	return {
		...base,
		changes: () => {
			const index = served.count;
			served.count += 1;
			const page = pages[index];
			if (page === undefined) throw new Error('asked for a page past the round');
			if (page instanceof Error) return Promise.reject(page);
			return Promise.resolve({
				entries: page,
				cursor: `page-${String(index)}`,
				more: index < pages.length - 1,
			});
		},
	};
};

interface World {
	provider: StorageProvider;
	store: SyncStore;
}

/**
 * Engines over the provider and store a test file holds, read each time one
 * is made, so a test that puts a new provider in place gets engines over it.
 * Called once, at the top of the file: it resets its ids before each test.
 */
export const engineFixture = (world: () => World) => {
	const fresh = { count: 0 };
	beforeEach(() => {
		fresh.count = 0;
	});

	/**
	 * Ids for a second engine's new rows. Distinct from the test file's own
	 * engine's, so an assertion that a note kept its identity cannot pass by
	 * minting the same name twice — and distinct from each other, so two new
	 * files in one batch do not land on one row and fail the test for a
	 * reason of its own making.
	 */
	const freshId = (): string => {
		fresh.count += 1;
		return `fresh-${String(fresh.count)}`;
	};

	/** An engine over the file's provider and store at `AT`, with what a test changes. */
	const engineWith = (overrides: Partial<SyncEngineOptions> = {}) =>
		createSyncEngine({ ...world(), now: () => AT, ...overrides });

	/** Pulls exactly these entries, whatever the provider would have reported. */
	const pullNow = (entries: readonly ChangeEntry[]) =>
		engineWith({ provider: reporting(world().provider, entries), newId: freshId }).pull();

	/** Pulls these pages as one round, in order. */
	const pullPages = (pages: readonly (readonly ChangeEntry[] | Error)[]) =>
		engineWith({ provider: paging(world().provider, pages), newId: freshId }).pull();

	return { engineWith, pullNow, pullPages, freshId };
};
