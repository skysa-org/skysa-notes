import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type ApiClient, ApiError, type InstanceConfig } from '../src/api/client.js';
import { returnPath } from '../src/components/account/AccountPanel.js';
import { hashCredential } from '../src/store/credentials.js';
import { PENDING_CREDENTIAL_ID } from '../src/store/db.js';
import { createKeeping } from '../src/store/keeping.js';
import { createNote } from '../src/store/notes.js';
import {
	clientWith,
	CONNECT_ABOVE,
	connectVia,
	fakeSync,
	gearLabels,
	NOTHING_CONNECTED,
	offered,
	openAdd,
	openGear,
	renderDropdown,
	renderPanel,
	settled,
	STORAGE_FIRST,
} from './support/accountPanel.js';
import { freshDatabase } from './support/db.js';

describe('AccountPanel, with nothing connected', () => {
	it('says where the notes are, and leaves the way to connect to the `+`, which says what it is', async () => {
		renderPanel(clientWith(), freshDatabase());

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
		// The `+` beside the panel has its words while nothing is connected, once
		// the server has said what it offers — and the panel does not say them
		// again, or point at it, as it did when it ended in a sentence.
		expect(
			await screen.findByRole('button', { name: 'Connect storage provider' })
		).toBeTruthy();
		expect(screen.queryByText(/above to/)).toBeNull();
	});

	it('asks the server what it offers once, for the bar and the panel together', async () => {
		// `/api/*` is never cached below the app, so two components asking on
		// mount would be two round trips on every open (`useInstanceConfig`).
		const config = vi.fn(() => Promise.resolve(STORAGE_FIRST));
		renderPanel(clientWith({ config }), freshDatabase());

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
		expect(
			await screen.findByRole('button', { name: 'Connect storage provider' })
		).toBeTruthy();
		expect(config).toHaveBeenCalledTimes(1);
	});

	it('ends in a line saying where the notes are, with the download and the imports behind the gear', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		renderPanel(clientWith(), db);

		const line = await screen.findByText(NOTHING_CONNECTED);
		// No account to name, so no tooltip.
		expect(line.getAttribute('title')).toBeNull();
		await settled();
		await openGear(user);
		// Nothing to download on a device that holds nothing.
		expect(gearLabels()).toEqual(['Import notes', 'Import to scratchpad', 'Hide scratchpad']);

		await createNote(db, { title: 'First' });
		await waitFor(() => {
			expect(gearLabels()).toEqual([
				'Download all notes',
				'Import notes',
				'Import to scratchpad',
				'Hide scratchpad',
			]);
		});
		// None of it is a button in the panel any more: the gear is the one.
		expect(
			within(screen.getByRole('region', { name: 'Storage' }))
				.getAllByRole('button')
				.map((button) => button.getAttribute('aria-label'))
		).toEqual(['Storage options']);

		// Shut, the menu gives the focus back to the gear.
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('group', { name: 'Storage' })).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Storage options' })
		);
	});

	it('asks before moving the notes on this device into the account, and can stay', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await createNote(db, { title: 'List', folderPath: 'Work' });
		const started: string[] = [];
		const { went } = renderPanel(
			clientWith({
				startConnect: (provider) => {
					started.push(provider);
					return Promise.resolve({
						ok: true,
						value: 'https://dropbox.example/authorize',
					});
				},
			}),
			db
		);

		await connectVia(user, 'Dropbox');

		const question = await screen.findByRole('alertdialog', {
			name: 'Move your notes to Dropbox?',
		});
		expect(within(question).getByText(/will move/).textContent).toBe(
			'Your 1 notebook and 2 notes on this device will move into Dropbox and sync there. Cancel to keep them on this device only.'
		);
		// The answer has the focus, as in every question this app asks — once
		// the dialog's effect has given it, which a loaded machine runs a moment
		// after the dialog is found.
		await waitFor(() => {
			expect(document.activeElement).toBe(
				within(question).getByRole('button', { name: 'Connect and move' })
			);
		});
		// Nothing has been started while the question is out.
		expect(started).toEqual([]);
		expect(await db.credentials.get(PENDING_CREDENTIAL_ID)).toBeUndefined();

		await user.click(within(question).getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('alertdialog')).toBeNull();
		const menu = screen.getByRole('group', { name: 'Storage providers' });
		const dropbox = within(menu).getByRole('button', { name: 'Dropbox' });
		expect(document.activeElement).toBe(dropbox);

		// Escape is Cancel too, and closes the question rather than the menu.
		await user.click(dropbox);
		await screen.findByRole('alertdialog');
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.getByRole('group', { name: 'Storage providers' })).toBeTruthy();

		expect(started).toEqual([]);
		expect(went).toEqual([]);
		expect(await db.credentials.get(PENDING_CREDENTIAL_ID)).toBeUndefined();
	});

	it('connects once the move is agreed to', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Plan', folderPath: 'Work' });
		const { went } = renderPanel(
			clientWith({
				startConnect: () =>
					Promise.resolve({ ok: true, value: 'https://dropbox.example/authorize' }),
			}),
			db
		);

		await connectVia(user, 'Dropbox');
		await user.click(await screen.findByRole('button', { name: 'Connect and move' }));

		await waitFor(() => {
			expect(went).toEqual(['https://dropbox.example/authorize']);
		});
		expect((await db.credentials.get(PENDING_CREDENTIAL_ID))?.provider).toBe('dropbox');
	});

	it('writes a credential down before it leaves, and sends the user back to where they were', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const started: { hash: string; returnTo: string }[] = [];
		const { went } = renderPanel(
			clientWith({
				startConnect: (_provider, hash, returnTo) => {
					started.push({ hash, returnTo });
					return Promise.resolve({
						ok: true,
						value: 'https://dropbox.example/authorize',
					});
				},
			}),
			db,
			'/?folder=Work&connect=denied'
		);

		await connectVia(user, 'Dropbox');

		await waitFor(() => {
			expect(went).toEqual(['https://dropbox.example/authorize']);
		});

		// The credential is written down and awaited *before* the browser leaves.
		// A consent given with nothing written down here is a connection on the
		// server this device cannot reach and cannot revoke (docs/ARCHITECTURE.md §6).
		const pending = await db.credentials.get(PENDING_CREDENTIAL_ID);
		expect(pending?.credential).toMatch(/^sk1_/);
		expect(pending?.provider).toBe('dropbox');
		// What the server is told is the hash, never the credential.
		expect(started[0]?.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(started[0]?.hash).not.toBe(pending?.credential);
		expect(await hashCredential(pending?.credential ?? '')).toBe(started[0]?.hash);
		// Back to where the user was, and without the outcome of the last
		// attempt, or it would be reported again on the way back from this one.
		expect(started[0]?.returnTo).toBe('/?folder=Work');
	});

	it('says so, and goes nowhere, when the server will not start a flow', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const { went } = renderPanel(
			clientWith({
				startConnect: () => Promise.resolve({ ok: false, refusal: 'forbidden_origin' }),
			}),
			db
		);

		await connectVia(user, 'Dropbox');

		expect(await screen.findByText(/would not start connecting/)).toBeTruthy();
		expect(went).toEqual([]);
	});

	it('offers nothing it cannot sign the user in for', async () => {
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({ authMode: 'account-first', providers: ['dropbox'] }),
			}),
			freshDatabase()
		);

		expect(await screen.findByText(/needs a sign-in this server does not offer/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Connect / })).toBeNull();
	});

	it('offers only providers the server has enabled and this build can sync', async () => {
		const offering = (providers: InstanceConfig['providers']) =>
			clientWith({
				config: () => Promise.resolve({ authMode: 'storage-first', providers }),
			});
		renderPanel(offering(['webdav']), freshDatabase());

		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		expect(screen.queryByRole('button', { name: /^Connect / })).toBeNull();
		cleanup();

		// In a compact window's source dropdown, where the panel points at the
		// `+` above it: not where the `+` has nothing to offer.
		renderDropdown(offering(['webdav']), freshDatabase());
		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		expect(screen.queryByText(CONNECT_ABOVE)).toBeNull();
		cleanup();

		// Where it has something, it does.
		renderDropdown(offering(['webdav', 'dropbox']), freshDatabase());
		expect(await screen.findByText(CONNECT_ABOVE)).toBeTruthy();
	});

	it('offers OneDrive and Google Drive alongside Dropbox', async () => {
		const user = userEvent.setup();
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({
						authMode: 'storage-first',
						providers: ['dropbox', 'onedrive', 'gdrive'],
					}),
			}),
			freshDatabase()
		);

		await openAdd(user);

		expect(await screen.findByRole('button', { name: 'OneDrive' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Google Drive' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Dropbox' })).toBeTruthy();
	});

	it('says so when the server cannot be reached', async () => {
		renderPanel(
			clientWith({
				config: () => Promise.reject(new TypeError('offline')),
				connection: () => Promise.reject(new TypeError('offline')),
			}),
			freshDatabase()
		);

		expect(await screen.findByText(/cannot be reached/)).toBeTruthy();
	});

	it.each([
		[
			'answered with a failure',
			() =>
				Promise.reject(
					new ApiError('POST /auth/connect/dropbox/start failed with 500', 500)
				),
			/The server could not start connecting/,
		],
		[
			'could not be reached',
			() => Promise.reject(new TypeError('offline')),
			/The server cannot be reached, so nothing was connected/,
		],
	] as const)(
		'tells a server that %s from one that did not, and says so out loud',
		async (_, startConnect, said) => {
			const user = userEvent.setup();
			const { went } = renderPanel(clientWith({ startConnect }), freshDatabase());

			await connectVia(user, 'Dropbox');

			const problem = await screen.findByText(said);
			expect(problem.textContent).not.toMatch(/this device went wrong/);
			// Announced: it replaces the thing the user just pressed for.
			expect(problem.getAttribute('role')).toBe('alert');
			expect(went).toEqual([]);
		}
	);

	it('does not blame the server when the credential could not be written down', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const startConnect = vi.fn<ApiClient['startConnect']>(() =>
			Promise.resolve({ ok: true, value: 'https://dropbox.example/authorize' })
		);
		const { went } = renderPanel(clientWith({ startConnect }), db);
		// Written down and awaited before the POST, so a store that refuses here
		// really does leave nothing connected anywhere.
		const refused = vi
			.spyOn(db.credentials, 'put')
			.mockRejectedValueOnce(new Error('QuotaExceededError'));

		await connectVia(user, 'Dropbox');

		const problem = await screen.findByText(/on this device went wrong/);
		expect(problem.textContent).toMatch(/nothing was connected/);
		expect(problem.textContent).not.toMatch(/server|reach/i);
		expect(startConnect).not.toHaveBeenCalled();
		expect(went).toEqual([]);
		refused.mockRestore();
	});

	it('claims nothing about a failure that was neither the device nor the server', async () => {
		const user = userEvent.setup();
		// The one thing here that runs after the server has answered: leaving.
		renderPanel(clientWith(), freshDatabase(), '/', fakeSync({ phase: 'local' }), () => {
			throw new Error('jsdom will not navigate');
		});

		await connectVia(user, 'Dropbox');

		const problem = await screen.findByText(/Something went wrong/);
		// The server did answer and a flow may well have begun, so neither
		// "nothing was connected" nor a word about this device is true here.
		expect(problem.textContent).not.toMatch(/server|reach|this device|nothing was/i);
	});
});

describe('AccountPanel, when the notes here are the only copy', () => {
	const MAY_BE_CLEARED =
		'This browser may clear them without warning. To keep them, connect storage or download them.';

	/** A browser that has decided `kept`, and can be told to change its mind. */
	const browserSaying = (kept: boolean) => {
		const box = { kept };
		const keeping = createKeeping(() => ({
			persisted: () => Promise.resolve(box.kept),
			persist: () => Promise.resolve(box.kept),
		}));
		return { keeping, box };
	};

	it('says the browser may clear them, and what keeps them, while it has not agreed to keep them', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Plan' });
		renderPanel(
			clientWith(),
			db,
			'/',
			undefined,
			undefined,
			undefined,
			browserSaying(false).keeping
		);

		expect(await screen.findByText(MAY_BE_CLEARED)).toBeTruthy();
		// And the download it points at is right there, behind the gear under it.
		expect(await offered(user, 'Download all notes')).toBeTruthy();
	});

	it('counts a browser that cannot say as one that has not agreed', async () => {
		const db = freshDatabase();
		await createNote(db, { title: 'Plan' });
		renderPanel(clientWith(), db);

		expect(await screen.findByText(MAY_BE_CLEARED)).toBeTruthy();
	});

	it('says nothing once the browser keeps the store, and stops saying it when it agrees', async () => {
		const db = freshDatabase();
		await createNote(db, { title: 'Plan' });
		const { keeping, box } = browserSaying(false);
		renderPanel(clientWith(), db, '/', undefined, undefined, undefined, keeping);
		await screen.findByText(MAY_BE_CLEARED);

		// Asked from elsewhere — a note being created — and heard here.
		box.kept = true;
		await act(() => keeping.ask(db, 'installed'));

		await waitFor(() => {
			expect(screen.queryByText(MAY_BE_CLEARED)).toBeNull();
		});
		expect(screen.getByText(NOTHING_CONNECTED)).toBeTruthy();
	});

	it('says nothing on a device that holds nothing, until it holds something', async () => {
		const db = freshDatabase();
		renderPanel(
			clientWith(),
			db,
			'/',
			undefined,
			undefined,
			undefined,
			browserSaying(false).keeping
		);

		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		expect(screen.queryByText(MAY_BE_CLEARED)).toBeNull();

		await createNote(db, { title: 'First' });
		expect(await screen.findByText(MAY_BE_CLEARED)).toBeTruthy();
	});

	it('says nothing where the browser already keeps the store', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Plan' });
		const { keeping } = browserSaying(true);
		renderPanel(clientWith(), db, '/', undefined, undefined, undefined, keeping);

		await offered(user, 'Download all notes');
		// Asked, and answered: silence from an answer, not from not having asked.
		await waitFor(() => {
			expect(keeping.state()).toBe('kept');
		});
		expect(screen.queryByText(MAY_BE_CLEARED)).toBeNull();
	});

	it('says nothing before the browser has answered', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Plan' });
		// A browser that never says: the line must not flash up and go again.
		const keeping = createKeeping(() => ({
			persisted: () => new Promise<boolean>(() => undefined),
			persist: () => new Promise<boolean>(() => undefined),
		}));
		renderPanel(clientWith(), db, '/', undefined, undefined, undefined, keeping);

		await offered(user, 'Download all notes');
		await settled();
		expect(keeping.state()).toBe('unknown');
		expect(screen.queryByText(MAY_BE_CLEARED)).toBeNull();
	});

	it('asks the browser again when the tab comes back into view', async () => {
		const db = freshDatabase();
		await createNote(db, { title: 'Plan' });
		const { keeping, box } = browserSaying(false);
		renderPanel(clientWith(), db, '/', undefined, undefined, undefined, keeping);
		await screen.findByText(MAY_BE_CLEARED);

		// Granted somewhere this tab cannot hear: another tab, or site settings.
		box.kept = true;
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});

		await waitFor(() => {
			expect(screen.queryByText(MAY_BE_CLEARED)).toBeNull();
		});
	});
});

describe('returnPath', () => {
	it('comes back to exactly here, without the outcome of a connect before this one', () => {
		// The kind of refusal too: carried back onto a later connect, it would
		// be a refusal saying so about a connect that has not happened.
		expect(
			returnPath('https://notes.example.com/?folder=Work&connect=refused&code=lapsed')
		).toBe('/?folder=Work');
	});
});
