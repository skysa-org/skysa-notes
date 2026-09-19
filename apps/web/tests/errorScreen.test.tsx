import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorScreen } from '../src/components/ErrorScreen.js';
import { Route as IndexRoute } from '../src/routes/index.js';
import { routeTree } from '../src/routeTree.gen.js';

/**
 * A throw during render used to replace the whole app with the router's own
 * unstyled fallback and nothing to press. What can throw there is mostly the
 * store — quota, an upgrade another tab is blocking — so the screen has to say
 * the notes are safe and offer a way back that is not the address bar.
 */

let failing = true;

const Flaky = () => {
	if (failing) throw new Error('QuotaExceededError: the disk is full');
	return <p>The notes</p>;
};

const openBroken = () => {
	const rootRoute = createRootRoute({ component: Outlet, errorComponent: ErrorScreen });
	const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Flaky });
	const router = createRouter({
		routeTree: rootRoute.addChildren([index]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
};

beforeEach(() => {
	failing = true;
	// React reports every caught render error to the console, and the router
	// adds its own; both are the behaviour under test, not noise worth reading.
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('the error screen', () => {
	it('stands in for a screen that threw, and says the notes are safe', async () => {
		openBroken();

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Something went wrong');
		expect(alert.textContent).toContain('have not been touched');
		expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
		// Not the router's fallback, which is what rendered before.
		expect(alert.textContent).not.toContain('Something went wrong!');
	});

	it('keeps the message folded away, and shows the message only', async () => {
		openBroken();

		const details = (await screen.findByRole('alert')).querySelector('details');
		expect(details?.open).toBe(false);
		expect(details?.querySelector('pre')?.textContent).toBe(
			'QuotaExceededError: the disk is full'
		);
		// A stack names files and lines; it has no business on a user's screen.
		expect(details?.textContent).not.toContain('errorScreen.test');
	});

	it('renders the screen again on "Try again"', async () => {
		const user = userEvent.setup();
		openBroken();
		await screen.findByRole('alert');

		failing = false;
		await user.click(screen.getByRole('button', { name: 'Try again' }));

		expect(await screen.findByText('The notes')).toBeDefined();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('does not throw over something that is not an Error', () => {
		render(<ErrorScreen error={'plain string'} reset={() => undefined} />);

		expect(screen.getByRole('alert').querySelector('pre')?.textContent).toBe('plain string');
	});

	it('is what the real routes fall back to', () => {
		// The root is the last boundary there is. The index route has its own so
		// the root's layout — and the "new version" prompt in it — outlives it.
		expect(routeTree.options.errorComponent).toBe(ErrorScreen);
		expect(IndexRoute.options.errorComponent).toBe(ErrorScreen);
	});
});
