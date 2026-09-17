import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	type ApiClient,
	ApiError,
	createApiClient,
	type InstanceConfig,
} from '../src/api/client.js';
import { AccountPanel } from '../src/components/AccountPanel.js';
import { bindConnection, unbindConnection } from '../src/store/connection.js';
import {
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
} from '../src/store/db.js';
import { createNote, getNote } from '../src/store/notes.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`panel-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const STORAGE_FIRST: InstanceConfig = { authMode: 'storage-first', providers: ['dropbox'] };

type Client = Pick<ApiClient, 'config' | 'connections' | 'disconnect' | 'connectUrl'>;

const clientWith = (overrides: Partial<Client> = {}): Client => ({
	config: () => Promise.resolve(STORAGE_FIRST),
	connections: () => Promise.resolve({ ok: true, value: [] }),
	disconnect: () => Promise.resolve({ ok: true, value: { revoked: true } }),
	connectUrl: createApiClient().connectUrl,
	...overrides,
});

/** A button once the user can press it. */
const enabled = async (name: string): Promise<HTMLElement> => {
	const button = await screen.findByRole('button', { name });
	await waitFor(() => {
		expect(button.hasAttribute('disabled')).toBe(false);
	});
	return button;
};

const dropbox = {
	id: 'c1',
	provider: 'dropbox' as const,
	displayName: 'ada@example.com',
	accountId: 'dbid:1',
	createdAt: 1,
	lastUsedAt: null,
};

/** The panel at `url`, inside a router, since it reads where it is. */
const renderPanel = (client: Client, database: NotesDatabase, url = '/') => {
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => <AccountPanel client={client} database={database} />,
		}),
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
};

describe('AccountPanel, with nothing connected', () => {
	it('offers to connect, sending the user back to where they were', async () => {
		renderPanel(clientWith(), freshDatabase(), '/?folder=Work&connect=denied');

		const link = await screen.findByRole('link', { name: 'Connect Dropbox' });

		// And without the outcome of the last attempt, or it would be reported
		// again on the way back from this one.
		expect(link.getAttribute('href')).toBe(
			'/api/auth/connect/dropbox/start?returnTo=%2F%3Ffolder%3DWork'
		);
		expect(screen.getByText('Notes are kept on this device only.')).toBeTruthy();
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
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('offers only providers the server has enabled and this build can sync', async () => {
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({
						authMode: 'storage-first',
						providers: ['gdrive', 'onedrive'],
					}),
			}),
			freshDatabase()
		);

		await waitFor(() => {
			expect(screen.getByText('Notes are kept on this device only.')).toBeTruthy();
		});
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('says so when the server cannot be reached', async () => {
		renderPanel(
			clientWith({
				config: () => Promise.reject(new TypeError('offline')),
				connections: () => Promise.reject(new TypeError('offline')),
			}),
			freshDatabase()
		);

		expect(await screen.findByText(/cannot be reached/)).toBeTruthy();
	});
});

describe('AccountPanel, with an account connected', () => {
	it('binds the device to the account the server has, and names it', async () => {
		const db = freshDatabase();
		renderPanel(
			clientWith({ connections: () => Promise.resolve({ ok: true, value: [dropbox] }) }),
			db
		);

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('shows the connection offline, from the device alone', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({ connections: () => Promise.reject(new TypeError('offline')) }),
			db
		);

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
	});

	it('asks before disconnecting, then keeps the notes here and stops syncing', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const disconnect = vi.fn<Client['disconnect']>(() =>
			Promise.resolve({ ok: true, value: { revoked: true } })
		);
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: true, value: [dropbox] }),
				disconnect,
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		expect(disconnect).not.toHaveBeenCalled();
		expect(screen.getByText(/Your notes stay on this device/)).toBeTruthy();
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect(await screen.findByRole('link', { name: 'Connect Dropbox' })).toBeTruthy();
		expect(disconnect).toHaveBeenCalledWith('c1');
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('can be talked out of disconnecting', async () => {
		const user = userEvent.setup();
		const disconnect = vi.fn<Client['disconnect']>();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: true, value: [dropbox] }),
				disconnect,
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByRole('button', { name: 'Disconnect…' })).toBeTruthy();
		expect(disconnect).not.toHaveBeenCalled();
	});

	it('stays connected and says why when the server will not disconnect', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: false, refusal: 'sign_in_required' }),
				disconnect: () => Promise.resolve({ ok: false, refusal: 'sign_in_required' }),
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/session has ended/);
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('stops syncing when the account was disconnected somewhere else', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(clientWith(), db);

		expect(await screen.findByRole('link', { name: 'Connect Dropbox' })).toBeTruthy();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('says so when the server cannot be reached to disconnect', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({
				connections: () => Promise.reject(new TypeError('offline')),
				disconnect: () => Promise.reject(new TypeError('offline')),
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be reached/);
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('cannot be disconnected while the server is still being asked on open', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(clientWith({ connections: () => new Promise(() => undefined) }), db);

		const button = await screen.findByRole('button', { name: 'Disconnect…' });

		expect(button.hasAttribute('disabled')).toBe(true);
	});

	it('moves focus to the step the user is on', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({ connections: () => Promise.resolve({ ok: true, value: [dropbox] }) }),
			db
		);

		await user.click(await enabled('Disconnect…'));
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Disconnect…' }));
	});

	it('leaves focus alone when the user has moved on while a disconnect was answered', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const answer = new Map<'fail', () => void>();
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: true, value: [dropbox] }),
				disconnect: () =>
					new Promise((_resolve, reject) => {
						answer.set('fail', () => {
							reject(new TypeError('offline'));
						});
					}),
			}),
			db
		);
		const elsewhere = document.createElement('textarea');
		document.body.append(elsewhere);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));
		elsewhere.focus();
		answer.get('fail')?.();

		expect(await screen.findByRole('alert')).toBeTruthy();
		expect(document.activeElement).toBe(elsewhere);
		elsewhere.remove();
	});

	it('tells a server that failed apart from one that cannot be reached', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: true, value: [dropbox] }),
				disconnect: () => Promise.reject(new ApiError('DELETE failed with 500', 500)),
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/could not disconnect/);
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('can stop syncing on this device alone when the server cannot be asked', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const disconnect = vi.fn<Client['disconnect']>(() =>
			Promise.resolve({ ok: false, refusal: 'sign_in_required' })
		);
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: false, refusal: 'sign_in_required' }),
				disconnect,
			}),
			db
		);
		expect(screen.queryByRole('button', { name: 'Stop syncing on this device' })).toBeNull();

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));
		await user.click(
			await screen.findByRole('button', { name: 'Stop syncing on this device' })
		);

		expect(await screen.findByRole('link', { name: 'Connect Dropbox' })).toBeTruthy();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it('offers to connect again only where the server lets it', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({ authMode: 'account-first', providers: ['dropbox'] }),
				connections: () => Promise.resolve({ ok: false, refusal: 'sign_in_required' }),
			}),
			db
		);

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		await enabled('Disconnect…');
		expect(screen.queryByRole('link', { name: 'Connect again' })).toBeNull();
	});

	it('offers to connect again when the session has ended', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: false, refusal: 'sign_in_required' }),
			}),
			db,
			'/?folder=Work'
		);

		const link = await screen.findByRole('link', { name: 'Connect again' });
		expect(link.getAttribute('href')).toBe(
			'/api/auth/connect/dropbox/start?returnTo=%2F%3Ffolder%3DWork'
		);
	});
});

describe('AccountPanel, signed in with an account the notes do not belong to', () => {
	const bob = { ...dropbox, id: 'c9', displayName: 'bob@example.com', accountId: 'dbid:2' };

	/** Notes that belong to Ada's account, and a server that has Bob's. */
	const adasNotes = async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await db.notes.update(note.id, { remoteId: 'id:1' });
		await unbindConnection(db);
		return { db, note };
	};

	it('asks before copying the notes into it, and copies them when told to', async () => {
		const user = userEvent.setup();
		const { db, note } = await adasNotes();
		renderPanel(
			clientWith({ connections: () => Promise.resolve({ ok: true, value: [bob] }) }),
			db
		);

		expect(await screen.findByText(/belong to another Dropbox account/)).toBeTruthy();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);

		await user.click(screen.getByRole('button', { name: 'Copy notes into bob@example.com' }));

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c9');
		expect((await getNote(db, note.id))?.remoteId).toBeUndefined();
	});

	it('lets it go instead, keeping the notes as they are', async () => {
		const user = userEvent.setup();
		const { db, note } = await adasNotes();
		const disconnect = vi.fn<Client['disconnect']>(() =>
			Promise.resolve({ ok: true, value: { revoked: true } })
		);
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: true, value: [bob] }),
				disconnect,
			}),
			db
		);

		await user.click(await screen.findByRole('button', { name: 'Disconnect bob@example.com' }));

		expect(await screen.findByRole('link', { name: 'Connect Dropbox' })).toBeTruthy();
		expect(disconnect).toHaveBeenCalledWith('c9');
		expect((await getNote(db, note.id))?.remoteId).toBe('id:1');
	});

	it('stops asking once another tab has answered', async () => {
		const { db } = await adasNotes();
		renderPanel(
			clientWith({ connections: () => Promise.resolve({ ok: true, value: [bob] }) }),
			db
		);
		expect(await screen.findByText(/belong to another Dropbox account/)).toBeTruthy();

		await bindConnection(db, { connectionId: 'c9', provider: 'dropbox', accountId: 'dbid:2' });

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Disconnect bob@example.com/ })).toBeNull();
	});

	it('says so when the server will not let it go, and still asks', async () => {
		const user = userEvent.setup();
		const { db } = await adasNotes();
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: true, value: [bob] }),
				disconnect: () => Promise.resolve({ ok: false, refusal: 'not_entitled' }),
			}),
			db
		);

		await user.click(await screen.findByRole('button', { name: 'Disconnect bob@example.com' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/would not disconnect it/);
		expect(
			screen.getByRole('button', { name: 'Copy notes into bob@example.com' })
		).toBeTruthy();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('says so when letting it go is refused, and still asks', async () => {
		const user = userEvent.setup();
		const { db } = await adasNotes();
		renderPanel(
			clientWith({
				connections: () => Promise.resolve({ ok: true, value: [bob] }),
				disconnect: () => Promise.reject(new TypeError('offline')),
			}),
			db
		);

		await user.click(await screen.findByRole('button', { name: 'Disconnect bob@example.com' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing has changed/);
		expect(
			screen.getByRole('button', { name: 'Copy notes into bob@example.com' })
		).toBeTruthy();
	});
});
