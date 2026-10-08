import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { useLastOpen } from '../src/store/hooks.js';
import type * as LastOpenModule from '../src/store/lastOpen.js';
import { rememberOpen } from '../src/store/lastOpen.js';

/**
 * The store's answer to where the user was can run clicks behind the clicks
 * that wrote it (`lastWritten`, #283), so `useLastOpen` hands out what this
 * tab wrote until the store has been read since. Here the store's reads can
 * be held, and answer only once let go.
 */
const reads = vi.hoisted(() => ({ held: false, waiting: [] as (() => void)[] }));

vi.mock('../src/store/lastOpen.js', async (importOriginal) => {
	const actual = await importOriginal<typeof LastOpenModule>();
	return {
		...actual,
		getLastOpen: async (...args: Parameters<typeof actual.getLastOpen>) => {
			const lastOpen = await actual.getLastOpen(...args);
			if (reads.held) await new Promise<void>((resolve) => reads.waiting.push(resolve));
			return lastOpen;
		},
	};
});

afterEach(async () => {
	cleanup();
	reads.held = false;
	for (const resolve of reads.waiting.splice(0)) resolve();
	await db.prefs.clear();
});

const KEY = `lastOpen:${LOCAL_CONNECTION_ID}`;

describe('where the user was, as the app is handed it', () => {
	it('is what this tab wrote, before the store has said so', async () => {
		const { result } = renderHook(() => useLastOpen(LOCAL_CONNECTION_ID));
		await waitFor(() => {
			expect(result.current).toEqual({ notes: {} });
		});

		// Every read from here on is held: the store answers nothing more.
		reads.held = true;
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', 'w1');

		await waitFor(() => {
			expect(result.current).toEqual({ folder: 'Work', notes: { Work: 'w1' } });
		});
	});

	it('is what another tab wrote after it', async () => {
		const { result } = renderHook(() => useLastOpen(LOCAL_CONNECTION_ID));
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', 'w1');
		await waitFor(() => {
			expect(result.current?.folder).toBe('Work');
		});

		// Another tab's write lands in the store as this one's would.
		const theirs = { folder: 'Home', notes: { Work: 'w1', Home: 'h1' } };
		await db.prefs.put({ key: KEY, value: JSON.stringify(theirs) });

		await waitFor(() => {
			expect(result.current).toEqual(theirs);
		});
	});

	it('is nothing this tab wrote for another source', async () => {
		await rememberOpen(db, LOCAL_CONNECTION_ID, 'Work', 'w1');

		const { result } = renderHook(() => useLastOpen('c-dropbox'));

		await waitFor(() => {
			expect(result.current).toEqual({ notes: {} });
		});
	});
});
