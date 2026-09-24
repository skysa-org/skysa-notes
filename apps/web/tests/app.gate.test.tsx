import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';

/**
 * The whole app on an instance whose operator gates connecting (issue #131),
 * where a refusal can offer something to do instead.
 *
 * A file of its own because `/api/config` is asked once per client for the
 * life of the module (`api/instanceConfig.ts`), and the app's client is one
 * module-level `api`: an answer with a gate in it would still be the answer in
 * every test after this one in `app.test.tsx`.
 */

const GATE = {
	message: 'Sync on this server is part of the paid plan.',
	action: { label: 'See plans', url: 'https://example.com/plans' },
};

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
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const open = async (url: string) => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('heading', { name: 'Notebooks' });
	return router;
};

/** The alerts a node that went into the page is or holds. */
const alertsIn = (node: Node): HTMLElement[] => {
	if (!(node instanceof HTMLElement)) return [];
	return node.matches('[role="alert"]')
		? [node]
		: [...node.querySelectorAll<HTMLElement>('[role="alert"]')];
};

describe('a refused connect, on an instance with a gate', () => {
	it("offers the operator's way forward beside the refusal", async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work&connect=refused&code=not_allowed');

		const toast = await screen.findByRole('alert');
		expect(toast.textContent).toMatch(
			/not allowed to sync on this server, so storage was not connected/
		);
		// There from the first moment the alert is: a link added after it would
		// have the whole alert read out again.
		const link = within(toast).getByRole('link', { name: 'See plans' });
		expect(link.getAttribute('href')).toBe(GATE.action.url);
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('holds the toast until it has its link, so the alert is never read without it', async () => {
		// Whether each alert had its link at the moment it went into the page.
		// Polling for it cannot tell: by the next poll a late link has arrived.
		const atInsertion: boolean[] = [];
		const observer = new MutationObserver((records) => {
			records
				.flatMap((record) => [...record.addedNodes])
				.flatMap(alertsIn)
				.forEach((alert) => {
					atInsertion.push(alert.querySelector('a') !== null);
				});
		});
		observer.observe(document.body, { childList: true, subtree: true });
		await createFolder(db, { name: 'Work' });

		await open('/?folder=Work&connect=refused&code=lapsed');
		await within(await screen.findByRole('alert')).findByRole('link', { name: 'See plans' });
		observer.disconnect();

		expect(atInsertion).toEqual([true]);
	});

	it('offers it for a refusal whose kind the policy did not say', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work&connect=refused');

		const toast = await screen.findByRole('alert');
		expect(toast.textContent).toMatch(/cannot sync on this server/);
		expect(within(toast).getByRole('link', { name: 'See plans' })).toBeTruthy();
	});

	it('offers nothing beside an outcome that is not a refusal', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work&connect=failed');

		const toast = await screen.findByRole('alert');
		expect(toast.textContent).toMatch(/could not be connected/);
		// Given the config time to arrive: the gate is known by now, and still
		// not offered, since trying again is the answer to a failure.
		await screen.findByRole('button', { name: /Connect storage provider/ });
		expect(within(toast).queryByRole('link')).toBeNull();
	});
});
