import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { SHARE_CACHE } from '../src/share/received.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { fakeCaches } from './fakeCaches.js';

/**
 * `?share=<id>`, where the service worker sends the page once it has kept what
 * the share sheet posted (docs/ARCHITECTURE.md §8, "Shared to the app"),
 * through the real router: read, asked about, and taken out of the URL so a
 * reload does not ask again. What each answer does is `TakeShare.test.tsx`'s.
 */

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

beforeEach(async () => {
	vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
	await db.notes.clear();
	await db.folders.clear();
	await db.syncState.clear();
	await db.prefs.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('a share arriving in the URL', () => {
	it('is read, taken out of the URL, and put to the user', async () => {
		const { storage, urls } = fakeCaches();
		vi.stubGlobal('caches', storage);
		const cache = await storage.open(SHARE_CACHE);
		await cache.put(`/share/${ID}`, new Response(JSON.stringify({ text: 'hi', files: [] })));
		await createFolder(db, { name: 'Work' });
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: [`/?folder=Work&share=${ID}`] }),
		});
		render(<RouterProvider router={router} />);

		// Nothing connected: the device's own notes have no clipboard.
		expect(
			await screen.findByRole('dialog', { name: 'Nothing was added to the clipboard' })
		).toBeDefined();
		await waitFor(() => {
			expect(router.state.location.search).toEqual({ folder: 'Work' });
		});

		await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => {
			expect(urls(SHARE_CACHE)).toEqual([]);
		});
	});
});
