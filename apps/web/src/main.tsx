import './styles.css';

import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { routeTree } from './routeTree.gen';
import { syncScheduler } from './sync/runtime.js';

const router = createRouter({
	routeTree,
	// The app renders from local state before any network call, so there is
	// nothing to wait on at boot.
	defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

// Before the first render, and never stopped: it follows the connection on
// its own, and syncs nothing while there is none.
syncScheduler.start();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root is missing from index.html');

createRoot(rootElement).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>
);
