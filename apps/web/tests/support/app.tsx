import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';

import { routeTree } from '../../src/routeTree.gen.js';
import { db } from '../../src/store/db.js';
import { setDefaultEditorMode } from '../../src/store/prefs.js';

/**
 * The whole app, from its router down, at the address `at`, once the sidebar
 * is drawn. The router renders nothing until it has resolved the route, so
 * "New notebook" is the first sign the app is up. Returns the router, for a
 * test that reads where it is (`tests/entry.ts`).
 */
export const renderApp = async (at = '/') => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [at] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
	return router;
};

/**
 * The same, with notes opening in the markdown editor: most route tests type
 * into a note, and CodeMirror is the editor jsdom can type into.
 */
export const openApp = async (at = '/') => {
	await setDefaultEditorMode(db, 'raw');
	return renderApp(at);
};

/** What `pagehide` does: the pending save goes now, rather than in two seconds. */
export const flushAutosave = () => {
	act(() => {
		window.dispatchEvent(new Event('pagehide'));
	});
};
