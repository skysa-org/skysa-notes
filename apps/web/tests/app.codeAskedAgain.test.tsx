import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import {
	dropConnectCode,
	heldConnectCode,
	heldConnectCodeShown,
	holdAcceptedCode,
	holdConnectCode,
} from '../src/store/connectCode.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';

/**
 * The whole app asking about the code it holds, or what the operator's policy
 * gave it to hold in the code's place, once as it loads (`ConnectCodeCheck.hold`
 * in `@skysa/core`): renewed where the policy still takes it, let go of where
 * it does not, and kept where nobody answered.
 *
 * A file of its own because `/api/config` is asked once per client for the
 * life of the module (`api/instanceConfig.ts`), and this one's gate asks for a
 * code, which `app.gate.test.tsx`'s does not.
 */

const GATE = {
	message: 'Sync on this server is part of the paid plan.',
	action: { label: 'Get a code', url: 'https://example.com/code' },
	connectCode: { label: 'Connect code', required: true },
};

const PASS = `dt1.${'Ab_-'.repeat(40)}`;
const RENEWED = `dt1.${'Cd_-'.repeat(40)}`;

/** What `/api/connect-code` answers in this test, and what it was asked. */
let codeAnswer: () => Promise<Response>;
let codeAsked: unknown[];

beforeEach(async () => {
	codeAsked = [];
	codeAnswer = () => Promise.reject(new TypeError('offline'));
	vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
		if (input === '/api/config') {
			return Promise.resolve(
				Response.json({
					authMode: 'storage-first',
					providers: ['dropbox'],
					connectGate: GATE,
				})
			);
		}
		if (input === '/api/connect-code') {
			codeAsked.push(JSON.parse(init?.body as string));
			return codeAnswer();
		}
		return Promise.reject(new TypeError('offline'));
	});
	await db.notes.clear();
	await db.folders.clear();
	await db.syncState.clear();
	await createFolder(db, { name: 'Work' });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	dropConnectCode();
});

/** A pass the policy last answered about `hours` ago, good for a day from then. */
const passFrom = (hours: number) => {
	holdAcceptedCode(
		'K7QM-2XRD',
		{ expiresIn: 86_400, hold: PASS },
		Date.now() - hours * 3_600_000
	);
};

const open = async (url = '/?folder=Work') => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('heading', { name: 'Notebooks' });
};

describe('what the gate holds, asked about again as the app loads', () => {
	it('is renewed with what the policy answers, still unshown', async () => {
		passFrom(2);
		codeAnswer = () =>
			Promise.resolve(
				Response.json({ accepted: true, expiresIn: 180 * 86_400, hold: RENEWED })
			);

		await open();

		await waitFor(() => {
			expect(heldConnectCode()).toBe(RENEWED);
		});
		expect(codeAsked).toEqual([{ code: PASS }]);
		expect(heldConnectCodeShown()).toBe(false);
	});

	it('is let go of where the policy no longer takes it', async () => {
		passFrom(2);
		codeAnswer = () =>
			Promise.resolve(
				Response.json({ accepted: false, reason: 'The subscription is not active.' })
			);

		await open();

		await waitFor(() => {
			expect(heldConnectCode()).toBeUndefined();
		});
	});

	it.each([
		['no answer at all', () => Promise.reject(new TypeError('offline'))],
		[
			'a limit reached',
			() => Promise.resolve(Response.json({ error: 'rate_limited' }, { status: 429 })),
		],
	])('is kept where there was %s', async (_name, answer) => {
		passFrom(2);
		codeAnswer = answer;

		await open();

		await waitFor(() => {
			expect(codeAsked).toHaveLength(1);
		});
		expect(heldConnectCode()).toBe(PASS);
	});

	it('asks nothing within the hour since the policy last answered', async () => {
		passFrom(0.5);

		await open();
		await screen.findByRole('button', { name: /Connect storage provider/ });

		expect(codeAsked).toEqual([]);
		expect(heldConnectCode()).toBe(PASS);
	});

	it('asks nothing about a typed code, which is good for minutes', async () => {
		holdConnectCode('K7QM-2XRD', 900, Date.now() - 2 * 3_600_000 + 1_000_000);

		await open();
		await screen.findByRole('button', { name: /Connect storage provider/ });

		expect(codeAsked).toEqual([]);
	});

	it('keeps a pass through a refused connect, and asks about it at once', async () => {
		passFrom(0.5);
		codeAnswer = () =>
			Promise.resolve(Response.json({ accepted: true, expiresIn: 86_400, hold: RENEWED }));

		await open('/?folder=Work&connect=refused&code=not_allowed');

		const toast = await screen.findByRole('alert');
		// Nothing was typed this time, so nothing typed was turned down.
		expect(toast.textContent).not.toMatch(/code you entered/);
		await waitFor(() => {
			expect(heldConnectCode()).toBe(RENEWED);
		});
		expect(codeAsked).toEqual([{ code: PASS }]);
	});

	it('lets go of a pass after a refused connect where the policy no longer takes it', async () => {
		passFrom(0.5);
		codeAnswer = () => Promise.resolve(Response.json({ accepted: false }));

		await open('/?folder=Work&connect=refused&code=not_allowed');

		await waitFor(() => {
			expect(heldConnectCode()).toBeUndefined();
		});
	});

	it('asks nothing where nothing is held', async () => {
		await open();
		await screen.findByRole('button', { name: /Connect storage provider/ });

		expect(codeAsked).toEqual([]);
	});

	it('asks nothing about a code a refused connect has just let go of', async () => {
		holdConnectCode('K7QM-2XRD', 900);

		await open('/?folder=Work&connect=refused&code=not_allowed');
		await screen.findByRole('alert');
		await screen.findByRole('button', { name: /Connect storage provider/ });

		expect(codeAsked).toEqual([]);
		expect(heldConnectCode()).toBeUndefined();
	});
});
