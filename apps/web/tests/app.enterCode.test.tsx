import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { dropConnectCode } from '../src/store/connectCode.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { placeIn } from './entry.js';
import { type FakeWindow, windowWidth } from './windowWidth.js';

/**
 * Back from the operator's page for a connect code, which the gate's link
 * opened in this same window: `?enter=code` opens the way to connect storage
 * at the code field, in a wide window and in a compact one.
 *
 * A file of its own for the reason `app.gate.test.tsx` gives: the app's client
 * asks `/api/config` once for the life of the module, and this gate asks for
 * a code.
 */

const GATE = {
	message: 'Sync on this server is part of the paid plan.',
	action: { label: 'Get a connect code', url: 'https://example.com/billing/connect' },
	connectCode: { label: 'Connect code', required: true },
};

let fake: FakeWindow | undefined;

beforeEach(async () => {
	vi.stubGlobal('fetch', (input: string) =>
		input === '/api/config'
			? Promise.resolve(
					Response.json({
						authMode: 'storage-first',
						providers: ['dropbox'],
						connectGate: GATE,
					})
				)
			: Promise.reject(new TypeError('offline'))
	);
	await db.notes.clear();
	await db.folders.clear();
	await db.syncState.clear();
	await db.prefs.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	fake?.restore();
	fake = undefined;
	dropConnectCode();
});

const open = async (url: string, width: number) => {
	fake = windowWidth(width);
	await createFolder(db, { name: 'Work' });
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	return router;
};

const atTheField = async () => {
	const menu = within(await screen.findByRole('group', { name: 'Storage providers' }));
	const field = await menu.findByRole('textbox', { name: 'Connect code' });
	await waitFor(() => {
		expect(document.activeElement).toBe(field);
	});
};

describe('back from getting a connect code', () => {
	it('opens the + menu at the code field, and takes the ask out of the URL', async () => {
		const router = await open('/?enter=code#/Work/', 1400);

		await atTheField();
		await waitFor(() => {
			expect(router.state.location.search).toEqual({});
		});
		// Where the user is stays as it was.
		expect(placeIn(router)).toMatchObject({ folder: 'Work' });
	});

	it('opens the sources dropdown first in a compact window', async () => {
		const router = await open('/?enter=code', 800);

		await atTheField();
		expect(document.querySelector('.app-shell')?.getAttribute('data-panel')).toBe('sources');
		await waitFor(() => {
			expect(router.state.location.search).not.toHaveProperty('enter');
		});
	});

	it('opens nothing without being asked', async () => {
		await open('/#/Work/', 1400);

		await screen.findByRole('button', { name: /Connect storage provider/ });
		expect(screen.queryByRole('group', { name: 'Storage providers' })).toBeNull();
	});
});
