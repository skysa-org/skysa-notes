import { expect } from 'vitest';

import type { MemoryStore } from '../memoryStore.js';

/**
 * What must be true of the store between batches, whatever the provider said,
 * for a test file to assert after every test (`afterEach`) rather than in the
 * handful that happen to think of it.
 *
 * - **No anomalies.** The store forgives a `delete-note` for a note that is not
 *   there, because a batch that rejects is a batch that is retried for ever.
 *   That forgiveness must never be what is holding a test up.
 * - **One note per path, one per remote id.** Two rows at one path is a note
 *   the sidebar shows twice and two queued writes racing for one file; two
 *   rows with one `remoteId` is worse — `noteByRemoteId` only ever hands back
 *   one of them, so the other is stale for ever and every edit to it conflicts.
 * - **The same two for files:** a picture shown twice, or a link the store
 *   cannot keep.
 *
 * Each is a soft assertion, so a store wrong in two ways says both.
 */
export const expectSoundStore = (store: MemoryStore): void => {
	expect.soft(store.anomalies()).toEqual([]);
	const notes = store.notes();
	const notePaths = notes.map((note) => note.path);
	expect.soft(notePaths).toEqual([...new Set(notePaths)]);
	const noteRemotes = notes.flatMap((note) =>
		note.remoteId === undefined ? [] : [note.remoteId]
	);
	expect.soft(noteRemotes).toEqual([...new Set(noteRemotes)]);
	const files = store.files();
	const filePaths = files.map((file) => file.path);
	expect.soft(filePaths).toEqual([...new Set(filePaths)]);
	const fileRemotes = files.flatMap((file) =>
		file.remoteId === undefined ? [] : [file.remoteId]
	);
	expect.soft(fileRemotes).toEqual([...new Set(fileRemotes)]);
};
