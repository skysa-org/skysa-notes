import {
	type AnyRouter,
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { db } from '../src/store/db.js';

/**
 * What the component is handed, not what `parseSearch` returns — the two were
 * different, and every other test of the query string calls `parseSearch`
 * directly, which is how that went unnoticed.
 *
 * The router builds a match's search as `{ ...parentSearch, ...validated }`,
 * and the root route validates nothing, so `parentSearch` is the raw query
 * with every value already through `JSON.parse`. A key the validator merely
 * leaves out is therefore still there. `/?note={"a":1}` reached
 * `db.notes.get({ a: 1 })`, the live query threw during render, and a link
 * took the whole app down.
 */

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
});

const openAt = async (url: string) => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
	return router;
};

/** Exactly what `Route.useSearch()` returns: the leaf match's `search`. */
const received = (router: AnyRouter): Record<string, unknown> =>
	router.state.matches.at(-1)?.search as Record<string, unknown>;

describe('the query string as the app receives it', () => {
	it('never hands a component a value the validator refused', async () => {
		const router = await openAt('/?note={"a":1}&folder=[1]&connect=signin');

		expect(received(router).note).toBeUndefined();
		expect(received(router).folder).toBeUndefined();
		expect(received(router).connect).toBeUndefined();
		// And the app is still the app: not the error screen, not an empty banner.
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByRole('button', { name: 'New notebook' })).toBeDefined();
	});

	it('refuses a value the default parser turned into something else', async () => {
		// `?note=7` arrives as the number 7 and `?folder=true` as a boolean.
		const router = await openAt('/?note=7&folder=true');

		expect(received(router).note).toBeUndefined();
		expect(received(router).folder).toBeUndefined();
	});

	it('still hands over what is valid', async () => {
		const router = await openAt('/?note=n1&folder=Work');

		expect(received(router)).toMatchObject({ note: 'n1', folder: 'Work' });
	});

	it('does not write the refused keys back into the URL', async () => {
		// `connect=ok` is taken out by a navigation as the app opens, which
		// re-serialises the rest — the explicit `undefined`s included.
		const router = await openAt('/?note={"a":1}&folder=Work&connect=ok');

		await waitFor(() => {
			expect(router.state.location.searchStr).not.toContain('connect');
		});
		expect(router.state.location.searchStr).toBe('?folder=Work');
		expect(router.state.location.href).not.toContain('undefined');
	});
});
