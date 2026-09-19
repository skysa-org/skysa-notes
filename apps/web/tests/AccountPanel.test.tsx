import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient, ApiError, type InstanceConfig } from '../src/api/client.js';
import { AccountPanel } from '../src/components/AccountPanel.js';
import { bindConnection, detachConnection, showConnection } from '../src/store/connection.js';
import { beginConnect, hashCredential } from '../src/store/credentials.js';
import {
	ACTIVE_CONNECTION_KEY,
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	type NotesDatabase,
	PENDING_CREDENTIAL_ID,
} from '../src/store/db.js';
import { beforeClosing } from '../src/store/heldEdits.js';
import { createNote, deleteNote, saveNoteBody } from '../src/store/notes.js';
import { type SchedulerStatus } from '../src/sync/scheduler.js';
import { noteById, updateNote } from './noteRows.js';

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

const dropbox = {
	id: 'c1',
	provider: 'dropbox' as const,
	displayName: 'ada@example.com',
	accountId: 'dbid:1',
	createdAt: 1,
	lastUsedAt: null,
	grantId: 'g1',
};

type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect'>;

/**
 * What the panel is handed.
 *
 * `withCredential` is the seam every authenticated call goes through now, so a
 * test says what the server answers by naming the answers and letting this
 * assemble a client that gives them whatever credential it is shown.
 */
interface Answers extends Partial<Client> {
	connection?: ApiClient['connection'];
	grants?: ApiClient['grants'];
	revokeGrant?: ApiClient['revokeGrant'];
	disconnect?: ApiClient['disconnect'];
}

const clientWith = (answers: Answers = {}): Client & { asked: string[] } => {
	const asked: string[] = [];
	return {
		asked,
		config: answers.config ?? (() => Promise.resolve(STORAGE_FIRST)),
		startConnect:
			answers.startConnect ??
			((_provider, _hash, returnTo) =>
				Promise.resolve({
					ok: true,
					value: `https://dropbox.example/authorize?rt=${encodeURIComponent(returnTo)}`,
				})),
		withCredential: (credential: string) => {
			asked.push(credential);
			return {
				connection:
					answers.connection ?? (() => Promise.resolve({ ok: true, value: dropbox })),
				grants: answers.grants ?? (() => Promise.resolve({ ok: true, value: [] })),
				revokeGrant:
					answers.revokeGrant ??
					(() => Promise.resolve({ ok: true, value: { ok: true } })),
				disconnect:
					answers.disconnect ??
					(() => Promise.resolve({ ok: true, value: { revoked: true } })),
			} as unknown as ApiClient;
		},
	};
};

/**
 * A device that has just come back from the provider's consent page: it wrote a
 * credential down before it left, and the panel takes it up on this render.
 * Binding only ever happens this way now — there is no list of connections to
 * discover one in.
 */
const backFromConsent = (db: NotesDatabase) => beginConnect(db, 'dropbox');

/** A device holding a credential for `connectionId`, as connecting leaves it. */
const holding = (db: NotesDatabase, connectionId: string, credential = 'sk1_held') =>
	db.credentials.put({
		id: connectionId,
		credential,
		provider: 'dropbox',
		createdAt: Date.now(),
	});

/** A button once the user can press it. */
const enabled = async (name: string): Promise<HTMLElement> => {
	const button = await screen.findByRole('button', { name });
	await waitFor(() => {
		expect(button.hasAttribute('disabled')).toBe(false);
	});
	return button;
};

/** A scheduler that says what the test tells it to. */
const fakeSync = (initial: Partial<SchedulerStatus> = {}) => {
	const listeners = new Set<(status: SchedulerStatus) => void>();
	const box = new Map<'status', SchedulerStatus>([
		['status', { phase: 'idle', conflicts: [], ...initial }],
	]);
	return {
		status: () => box.get('status') ?? { phase: 'local', conflicts: [] },
		subscribe: (listener: (status: SchedulerStatus) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		syncNow: vi.fn(() => Promise.resolve()),
		resync: vi.fn(() => Promise.resolve()),
		say: (next: Partial<SchedulerStatus>) => {
			const status: SchedulerStatus = { phase: 'idle', conflicts: [], ...next };
			box.set('status', status);
			act(() => {
				listeners.forEach((listener) => {
					listener(status);
				});
			});
		},
	};
};

type FakeSync = ReturnType<typeof fakeSync>;

/** The panel at `url`, inside a router, since it reads where it is. */
const renderPanel = (
	client: Client,
	database: NotesDatabase,
	url = '/',
	sync: FakeSync = fakeSync({ phase: 'local' })
) => {
	// Where the panel would send the browser. jsdom has no navigation, so
	// without this seam a connect test could only prove the button renders.
	const went: string[] = [];
	// And what it would hand the user as a file, by title: no blob URLs either.
	const downloaded: string[][] = [];
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => (
				<AccountPanel
					client={client}
					database={database}
					sync={sync}
					navigate={(to) => went.push(to)}
					download={(notes: readonly NoteRecord[]) =>
						downloaded.push(notes.map((note) => note.title))
					}
				/>
			),
		}),
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	return { went, downloaded };
};

/** A note the remote has in full, as a sync leaves it. */
const sentNote = async (db: NotesDatabase, title: string) => {
	const note = await createNote(db, { title });
	await updateNote(db, note.id, { remoteId: `id:${title}`, remoteVersion: 'v1', dirty: 0 });
	await db.opQueue.where('noteId').equals(note.id).delete();
	return note;
};

describe('AccountPanel, with nothing connected', () => {
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

		await user.click(await screen.findByRole('button', { name: 'Connect Dropbox' }));

		await waitFor(() => {
			expect(went).toEqual(['https://dropbox.example/authorize']);
		});

		// The credential is written down and awaited *before* the browser leaves.
		// A consent given with nothing written down here is a connection on the
		// server this device cannot reach and cannot revoke (docs/PLAN.md §6).
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

		await user.click(await screen.findByRole('button', { name: 'Connect Dropbox' }));

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
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({
						authMode: 'storage-first',
						providers: ['webdav'],
					}),
			}),
			freshDatabase()
		);

		await waitFor(() => {
			expect(screen.getByText('Notes are kept on this device only.')).toBeTruthy();
		});
		expect(screen.queryByRole('button', { name: /^Connect / })).toBeNull();
	});

	it('offers OneDrive and Google Drive alongside Dropbox', async () => {
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

		expect(await screen.findByRole('button', { name: 'Connect OneDrive' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Connect Dropbox' })).toBeTruthy();
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
});

describe('AccountPanel, with an account connected', () => {
	it('binds the device to the account it just consented to, and names it', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('shows the connection offline, from the device alone', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(clientWith({ connection: () => Promise.reject(new TypeError('offline')) }), db);

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
	});

	it('asks before disconnecting, then removes its notes from this device and stops syncing', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1', 'sk1_for-c1');
		const sent = await sentNote(db, 'Sent');
		const disconnect = vi.fn<ApiClient['disconnect']>(() =>
			Promise.resolve({ ok: true, value: { revoked: true } })
		);
		const client = clientWith({
			connection: () => Promise.resolve({ ok: true, value: dropbox }),
			disconnect,
		});
		renderPanel(client, db);

		await user.click(await enabled('Disconnect…'));
		expect(disconnect).not.toHaveBeenCalled();
		// What it says is what happens, and by the account's name.
		expect(
			screen.getByText(
				'Disconnect Dropbox · ada@example.com? Its notes are removed from this device. Nothing is deleted from Dropbox; connect it again to get them back.'
			)
		).toBeTruthy();
		// Everything here has been sent, so there is nothing more to own up to.
		expect(screen.queryByText(/not been sent/)).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect(await screen.findByRole('button', { name: 'Connect Dropbox' })).toBeTruthy();
		// Which connection is disconnected is no longer an argument: it is
		// whichever one the presented credential reaches.
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(client.asked).toContain('sk1_for-c1');
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect(await noteById(db, sent.id)).toBeUndefined();
		// And the credential is gone with the binding: it reaches nothing now.
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('says how much has not been sent, and leaves that here under the source, disconnected', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sent = await sentNote(db, 'Sent');
		const unsent = await createNote(db, { title: 'Unsent' });
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		await user.click(await enabled('Disconnect…'));
		expect(
			await screen.findByText(
				'1 change has not been sent to Dropbox. It will stay on this device under this source, marked disconnected, until you reconnect, discard or download it.'
			)
		).toBeTruthy();
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect(await screen.findByText('Dropbox · ada@example.com is disconnected')).toBeTruthy();
		expect(await noteById(db, sent.id)).toBeUndefined();
		expect((await noteById(db, unsent.id))?.connectionId).toBe('c1');
		expect(await activeConnectionId(db)).toBe('c1');
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('counts the changes in the plural', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		await createNote(db, { title: 'One' });
		await createNote(db, { title: 'Two' });
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		await user.click(await enabled('Disconnect…'));

		expect(
			await screen.findByText(
				'2 changes have not been sent to Dropbox. They will stay on this device under this source, marked disconnected, until you reconnect, discard or download them.'
			)
		).toBeTruthy();
	});

	it('says where to remove OneDrive’s access, which disconnecting cannot', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const onedrive = { ...dropbox, provider: 'onedrive' as const, accountId: 'ms-sub' };
		await bindConnection(db, { connectionId: 'c1', provider: 'onedrive' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: onedrive }) }),
			db
		);

		expect(await screen.findByText(/Syncing with OneDrive/)).toBeTruthy();
		expect(screen.queryByRole('link', { name: 'microsoft.com/consent' })).toBeNull();
		await user.click(await enabled('Disconnect…'));

		expect(
			screen.getByRole('link', { name: 'microsoft.com/consent' }).getAttribute('href')
		).toBe('https://microsoft.com/consent');
		expect(screen.getByRole('link', { name: 'My Apps' }).getAttribute('href')).toBe(
			'https://myapplications.microsoft.com/'
		);
	});

	it('does not send a Dropbox user to remove access by hand', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		await user.click(await enabled('Disconnect…'));
		expect(screen.getByText(/Its notes are removed from this device/)).toBeTruthy();
		expect(screen.queryByText(/keeps this app’s access/)).toBeNull();
		expect(screen.queryByRole('link', { name: 'microsoft.com/consent' })).toBeNull();
	});

	it('can be talked out of disconnecting', async () => {
		const user = userEvent.setup();
		const disconnect = vi.fn<ApiClient['disconnect']>();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
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
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				disconnect: () => Promise.resolve({ ok: false, refusal: 'not_entitled' }),
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/would not disconnect/);
		expect(await activeConnectionId(db)).toBe('c1');
		// Still reachable: a refusal is not a revocation.
		expect(await db.credentials.get('c1')).toBeTruthy();
	});

	it('stops syncing when the credential no longer reaches the account', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: false, refusal: 'credential_revoked' }),
			}),
			db
		);

		expect(await screen.findByRole('button', { name: 'Connect Dropbox' })).toBeTruthy();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		// Thrown away rather than kept: the server spends a hash for ever, so
		// nothing here will ever make it work again.
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('says so when the server cannot be reached to disconnect', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.reject(new TypeError('offline')),
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
		await holding(db, 'c1');
		renderPanel(clientWith({ connection: () => new Promise(() => undefined) }), db);

		const button = await screen.findByRole('button', { name: 'Disconnect…' });

		expect(button.hasAttribute('disabled')).toBe(true);
	});

	it('moves focus to the step the user is on', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
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
		await holding(db, 'c1');
		const answer = new Map<'fail', () => void>();
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
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
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
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
		await holding(db, 'c1');
		const disconnect = vi.fn<ApiClient['disconnect']>(() =>
			Promise.resolve({ ok: false, refusal: 'not_entitled' })
		);
		renderPanel(
			clientWith({
				connection: () => Promise.reject(new TypeError('offline')),
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

		expect(await screen.findByRole('button', { name: 'Connect Dropbox' })).toBeTruthy();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it('offers to connect again only where the server lets it', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({ authMode: 'account-first', providers: ['dropbox'] }),
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
			}),
			db,
			'/',
			fakeSync({ phase: 'attention', refusal: 'credential_revoked' })
		);

		expect(await screen.findByText(/can no longer reach Dropbox/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Connect again' })).toBeNull();
	});

	it('starts a whole new flow to connect again, credential and all', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const started: { hash: string; returnTo: string }[] = [];
		const { went } = renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				startConnect: (_provider, hash, returnTo) => {
					started.push({ hash, returnTo });
					return Promise.resolve({
						ok: true,
						value: 'https://dropbox.example/authorize',
					});
				},
			}),
			db,
			'/?folder=Work',
			fakeSync({ phase: 'attention', refusal: 'credential_revoked' })
		);

		await user.click(await screen.findByRole('button', { name: 'Connect again' }));

		await waitFor(() => {
			expect(went).toEqual(['https://dropbox.example/authorize']);
		});
		// Not a re-auth of the credential that stopped working — there is no such
		// thing. A fresh one is written down and a fresh hash sent.
		const pending = await db.credentials.get(PENDING_CREDENTIAL_ID);
		expect(pending?.credential).toMatch(/^sk1_/);
		expect(pending?.credential).not.toBe('sk1_held');
		expect(started[0]?.hash).toBe(await hashCredential(pending?.credential ?? ''));
		expect(started[0]?.returnTo).toBe('/?folder=Work');
	});
});

describe('AccountPanel, reporting how syncing is going', () => {
	const connected = async (sync: FakeSync, answers: Answers = {}) => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				...answers,
			}),
			db,
			'/',
			sync
		);
		await screen.findByText(/Syncing with Dropbox/);
		return db;
	};

	it('says when it last synced, and syncs when asked', async () => {
		const user = userEvent.setup();
		const at = new Date();
		at.setHours(9, 5, 0, 0);
		const sync = fakeSync({ phase: 'idle', lastSyncAt: at.getTime() });
		await connected(sync);

		const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		expect(screen.getByText(`Synced ${time}`)).toBeTruthy();

		await user.click(await enabled('Sync now'));
		expect(sync.syncNow).toHaveBeenCalledTimes(1);
	});

	it('gives the date of a sync that was not today', async () => {
		const at = new Date('2020-02-03T10:00:00');
		await connected(fakeSync({ phase: 'idle', lastSyncAt: at.getTime() }));

		expect(screen.getByText(`Synced ${at.toLocaleDateString()}`)).toBeTruthy();
	});

	it('cannot be asked to sync while it is syncing', async () => {
		const sync = fakeSync({ phase: 'syncing' });
		await connected(sync);

		expect(screen.getByText('Syncing…')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Sync now' }).hasAttribute('disabled')).toBe(
			true
		);

		sync.say({ phase: 'idle' });
		expect(await screen.findByText('Synced')).toBeTruthy();
		await enabled('Sync now');
	});

	it('says nothing, and offers nothing, before the scheduler has picked the connection up', async () => {
		await connected(fakeSync({ phase: 'local' }));

		expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
		// "Syncing with Dropbox", and nothing about how.
		expect(screen.getByRole('region', { name: 'Storage' }).querySelectorAll('p')).toHaveLength(
			1
		);
	});

	it('says when it is offline, and when it is trying again', async () => {
		const sync = fakeSync({ phase: 'offline' });
		await connected(sync);
		expect(screen.getByText(/^Offline\. Changes are kept on this device/)).toBeTruthy();

		sync.say({ phase: 'retrying', error: 'dropbox 503: unavailable' });
		expect(
			await screen.findByText(
				'Could not sync with Dropbox. Trying again shortly (dropbox 503: unavailable).'
			)
		).toBeTruthy();
	});

	it('offers to connect again when the account needs it', async () => {
		const sync = fakeSync({ phase: 'attention', refusal: 'reauthorize_required' });
		await connected(sync);

		expect(await screen.findByText(/Dropbox needs to be connected again\./)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Connect again' })).toBeTruthy();
		// Said once, as what to do, not again as a failure.
		expect(screen.queryByText(/could not be sent/)).toBeNull();

		// And when a fresh token was refused as well.
		sync.say({ phase: 'attention', error: 'authorization required' });
		expect(await screen.findByText(/Dropbox needs to be connected again\./)).toBeTruthy();
		expect(screen.queryByText(/could not be sent/)).toBeNull();

		sync.say({ phase: 'attention', refusal: 'credential_revoked' });
		expect(await screen.findByText(/This device can no longer reach Dropbox\./)).toBeTruthy();
		expect(screen.getAllByRole('button', { name: 'Connect again' })).toHaveLength(1);
	});

	it.each([
		[
			'does not let it',
			() =>
				Promise.resolve<InstanceConfig>({
					authMode: 'account-first',
					providers: ['dropbox'],
				}),
		],
		['cannot be reached to say', () => Promise.reject(new TypeError('offline'))],
	])(
		'says the account needs connecting again where the server %s, without the link',
		async (_, config) => {
			await connected(fakeSync({ phase: 'attention', refusal: 'reauthorize_required' }), {
				config,
			});
			await enabled('Disconnect…');

			expect(screen.getByText('Dropbox needs to be connected again.')).toBeTruthy();
			expect(screen.queryByRole('button', { name: 'Connect again' })).toBeNull();
		}
	);

	it('does not promise to try again with a provider this build cannot sync', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'webdav' });
		renderPanel(
			clientWith({ connection: () => Promise.reject(new TypeError('offline')) }),
			db,
			'/',
			fakeSync({
				phase: 'attention',
				error: 'This app cannot sync with this storage provider yet.',
			})
		);

		expect(await screen.findByText('This app cannot sync with WebDAV yet.')).toBeTruthy();
		expect(screen.queryByText(/tried again/)).toBeNull();
	});

	it.each([
		['not_entitled', 'This account cannot sync on this server.'],
		['not_found', 'The server no longer has this Dropbox connection.'],
	] as const)('explains a %s refusal', async (refusal, text) => {
		await connected(fakeSync({ phase: 'attention', refusal }));

		expect(screen.getByText(text)).toBeTruthy();
	});

	it('says when changes could not be sent', async () => {
		await connected(fakeSync({ phase: 'attention', error: 'write a.md failed 8 times' }));

		expect(
			screen.getByText(
				'Some changes could not be sent to Dropbox. They will be tried again (write a.md failed 8 times).'
			)
		).toBeTruthy();
	});

	it('says which change is stuck, and by the name the user gave it', async () => {
		// "Some changes could not be sent" leaves the user with nothing to act
		// on. The queue is ordered, so this one op is also why everything
		// behind it is waiting.
		await connected(
			fakeSync({
				phase: 'attention',
				error: 'move Plan.md failed 5 times',
				stuck: {
					op: 'move',
					path: 'Plan.md',
					targetPath: 'Work/Plan.md',
					attempts: 5,
					error: 'insufficient permissions',
				},
			})
		);

		expect(
			screen.getByText(
				'Dropbox would not take the rename of Work/Plan.md after 5 tries (insufficient permissions). Everything queued behind it is waiting. \u201CSync now\u201D tries again.'
			)
		).toBeTruthy();
	});

	it('offers to open the note a stuck change is about', async () => {
		const sync = fakeSync({ phase: 'idle' });
		const db = await connected(sync);
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });

		sync.say({
			phase: 'attention',
			stuck: {
				op: 'write',
				path: note.path,
				noteId: note.id,
				attempts: 5,
				error: 'nope',
			},
		});

		const link = await screen.findByRole('link', { name: 'Open the note' });
		expect(link.getAttribute('href')).toContain(note.id);
	});

	it('offers nothing to open for a notebook, or for a note already deleted', async () => {
		// A stuck `mkdir` is about no note at all, and a stuck `delete` is
		// about one whose row is a tombstone: opening it would be opening
		// nothing.
		const sync = fakeSync({ phase: 'idle' });
		const db = await connected(sync);
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });

		sync.say({
			phase: 'attention',
			stuck: { op: 'mkdir', path: 'Work', attempts: 5 },
		});
		expect(
			screen.getByText(
				'Dropbox would not take the new notebook Work after 5 tries (unknown error). Everything queued behind it is waiting. \u201CSync now\u201D tries again.'
			)
		).toBeTruthy();
		expect(screen.queryByRole('link', { name: 'Open the note' })).toBeNull();

		// The note has to be offered first, or its absence proves nothing: the
		// link is read from the database, and "not yet" looks like "never".
		sync.say({
			phase: 'attention',
			stuck: { op: 'write', path: note.path, noteId: note.id, attempts: 5 },
		});
		expect(await screen.findByRole('link', { name: 'Open the note' })).toBeTruthy();

		await updateNote(db, note.id, { deletedLocally: 1 });
		sync.say({
			phase: 'attention',
			stuck: { op: 'delete', path: note.path, noteId: note.id, attempts: 5 },
		});
		await waitFor(() => {
			expect(screen.queryByRole('link', { name: 'Open the note' })).toBeNull();
		});
	});

	it('offers nothing to open outside the message that names the stuck change', async () => {
		// `stuck` outlives the run that found it — it is not recomputed until a
		// run reaches the queue again — so the offer has to be tied to the
		// message it belongs beside, not to the field being set.
		const sync = fakeSync({ phase: 'idle' });
		const db = await connected(sync);
		const note = await createNote(db, { title: 'Plan', folderPath: 'Work' });
		const stuck = {
			op: 'write' as const,
			path: note.path,
			noteId: note.id,
			attempts: 5,
			error: 'nope',
		};

		sync.say({ phase: 'attention', stuck });
		expect(await screen.findByRole('link', { name: 'Open the note' })).toBeTruthy();

		sync.say({ phase: 'syncing', stuck });
		await waitFor(() => {
			expect(screen.queryByRole('link', { name: 'Open the note' })).toBeNull();
		});

		sync.say({ phase: 'idle', stuck });
		expect(screen.queryByRole('link', { name: 'Open the note' })).toBeNull();
	});

	it('offers no re-scan for a provider this build cannot sync', async () => {
		// There is nothing to read again: no adapter ever read it in the first
		// place, and the button would fail silently.
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'webdav' });
		renderPanel(
			clientWith({ connection: () => Promise.reject(new TypeError('offline')) }),
			db,
			'/',
			fakeSync({ phase: 'attention' })
		);

		expect(await screen.findByText('This app cannot sync with WebDAV yet.')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Re-scan from scratch' })).toBeNull();
	});

	it('reads everything again only after saying what that costs', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle' });
		await connected(sync);

		await user.click(screen.getByRole('button', { name: 'Re-scan from scratch' }));
		expect(screen.getByText(/Read everything in Dropbox again\?/)).toBeTruthy();
		expect(screen.getByText(/are no longer in Dropbox are removed here too/)).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(sync.resync).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Re-scan from scratch' })).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Re-scan from scratch' }));
		await user.click(screen.getByRole('button', { name: 'Re-scan' }));

		expect(sync.resync).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/Read everything in Dropbox again\?/)).toBeNull();
	});

	it('cannot be asked to read everything again while it is syncing', async () => {
		const sync = fakeSync({ phase: 'syncing' });
		await connected(sync);

		expect(
			screen.getByRole('button', { name: 'Re-scan from scratch' }).hasAttribute('disabled')
		).toBe(true);
	});

	it('offers no re-scan before the scheduler has picked the connection up', async () => {
		await connected(fakeSync({ phase: 'local' }));

		expect(screen.queryByRole('button', { name: 'Re-scan from scratch' })).toBeNull();
	});

	it('says when a note was edited in two places at once', async () => {
		const sync = fakeSync({ phase: 'idle', conflicts: ['a (conflict 2026-09-16T10-00).md'] });
		await connected(sync);
		expect(screen.getByText(/^A note was edited here and elsewhere at once\./)).toBeTruthy();

		sync.say({ phase: 'idle', conflicts: ['a', 'b'] });
		expect(await screen.findByText(/^2 notes were edited here and elsewhere/)).toBeTruthy();
	});
});

describe('AccountPanel, when another tab changes the connection', () => {
	it('asks the server again, and names the account now connected', async () => {
		const db = freshDatabase();
		const bob = { ...dropbox, id: 'c2', displayName: 'bob@example.com', accountId: 'dbid:2' };
		const connection = vi
			.fn<ApiClient['connection']>()
			.mockResolvedValueOnce({ ok: true, value: dropbox })
			.mockResolvedValue({ ok: true, value: bob });
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		renderPanel(clientWith({ connection }), db);
		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();

		// Another tab connected a second source and switched to it, writing the
		// credential down before the binding as `claimConnection` does.
		await holding(db, 'c2');
		await bindConnection(db, { connectionId: 'c2', provider: 'dropbox', accountId: 'dbid:2' });

		expect(await screen.findByText(/bob@example\.com/)).toBeTruthy();
		expect(connection).toHaveBeenCalledTimes(2);
	});

	it('does not ask again about a binding its own answer made', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		const connection = vi.fn<ApiClient['connection']>(() =>
			Promise.resolve({ ok: true, value: dropbox })
		);
		renderPanel(clientWith({ connection }), db);
		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(connection).toHaveBeenCalledTimes(1);
	});

	it('asks about a bind that landed while its question on open was still out', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		const first = new Map<
			'answer',
			(result: Awaited<ReturnType<ApiClient['connection']>>) => void
		>();
		const connection = vi
			.fn<ApiClient['connection']>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						first.set('answer', resolve);
					})
			)
			.mockResolvedValue({ ok: true, value: dropbox });
		renderPanel(clientWith({ connection }), db);
		await screen.findByText(/Notes are kept on this device only/);
		await waitFor(() => {
			expect(connection).toHaveBeenCalledTimes(1);
		});

		// Another tab comes back from the consent page with a new session and
		// binds, while this tab's question, sent with the old cookie, is out.
		await holding(db, 'c1');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await screen.findByText(/Syncing with Dropbox/);
		first.get('answer')?.({ ok: false, refusal: 'credential_revoked' });

		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
		expect(screen.queryByText(/can no longer reach/)).toBeNull();
		expect(connection).toHaveBeenCalledTimes(2);
	});

	it('asks once on open, even when React runs its effects twice', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		const connection = vi.fn<ApiClient['connection']>(() =>
			Promise.resolve({ ok: true, value: dropbox })
		);
		const router = createRouter({
			routeTree: createRootRoute({
				component: () => (
					<AccountPanel
						client={clientWith({ connection })}
						database={db}
						sync={fakeSync({ phase: 'local' })}
					/>
				),
			}),
			history: createMemoryHistory({ initialEntries: ['/'] }),
		});
		render(
			<StrictMode>
				<RouterProvider router={router} />
			</StrictMode>
		);

		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connection).toHaveBeenCalledTimes(1);
	});

	it('does not keep asking a server it cannot reach', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const connection = vi.fn<ApiClient['connection']>(() =>
			Promise.reject(new TypeError('offline'))
		);
		renderPanel(clientWith({ connection }), db);
		await screen.findByText(/Syncing with Dropbox/);
		await waitFor(() => {
			expect(connection).toHaveBeenCalledTimes(1);
		});

		await detachConnection(db, { connectionId: 'c1' });
		await holding(db, 'c2');
		await bindConnection(db, { connectionId: 'c2', provider: 'dropbox' });
		await waitFor(() => {
			expect(connection).toHaveBeenCalledTimes(2);
		});
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(connection).toHaveBeenCalledTimes(2);
	});

	it('does not ask when another tab disconnects', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		const connection = vi.fn<ApiClient['connection']>(() =>
			Promise.resolve({ ok: true, value: dropbox })
		);
		renderPanel(clientWith({ connection }), db);
		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();

		await detachConnection(db, { connectionId: 'c1' });

		expect(await screen.findByText(/Notes are kept on this device only/)).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connection).toHaveBeenCalledTimes(1);
	});
});

describe('AccountPanel, with a detached source in front', () => {
	/** Ada's Dropbox, let go holding two notes it never sent and one it had. */
	const detached = async () => {
		const db = freshDatabase();
		await bindConnection(db, {
			connectionId: 'c1',
			provider: 'dropbox',
			accountId: 'dbid:1',
			displayName: 'ada@example.com',
		});
		await holding(db, 'c1');
		await sentNote(db, 'Sent');
		const plan = await createNote(db, { title: 'Plan' });
		const list = await createNote(db, { title: 'List' });
		await detachConnection(db, { connectionId: 'c1' });
		return { db, plan, list };
	};

	it('says which source it is and what it holds, and asks the server nothing', async () => {
		const { db } = await detached();
		const client = clientWith();
		renderPanel(client, db);

		expect(await screen.findByText('Dropbox · ada@example.com is disconnected')).toBeTruthy();
		expect(
			await screen.findByText(/2 changes here were never sent, and are kept on this device/)
		).toBeTruthy();
		expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Discard…' })).toBeTruthy();
		// Not synced, so none of what a live source offers.
		expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Disconnect…' })).toBeNull();
		expect(screen.queryByText(/Syncing with/)).toBeNull();
		// It holds no credential, and there is nothing an answer could change.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(client.asked).toEqual([]);
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
	});

	it('reconnects through the ordinary flow, credential and all', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		const startConnect = vi.fn<ApiClient['startConnect']>(() =>
			Promise.resolve({ ok: true, value: 'https://dropbox.example/authorize' })
		);
		const { went } = renderPanel(clientWith({ startConnect }), db, '/?folder=Work');

		await user.click(await screen.findByRole('button', { name: 'Reconnect' }));

		await waitFor(() => {
			expect(went).toEqual(['https://dropbox.example/authorize']);
		});
		const pending = await db.credentials.get(PENDING_CREDENTIAL_ID);
		expect(startConnect).toHaveBeenCalledWith(
			'dropbox',
			await hashCredential(pending?.credential ?? ''),
			'/?folder=Work'
		);
		// Nothing has happened to the source yet: that is the bind's to decide.
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
	});

	it('takes the rows up again when the same account comes back', async () => {
		const { db, plan } = await detached();
		await backFromConsent(db);
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: { ...dropbox, id: 'c2' } }),
			}),
			db
		);

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect((await noteById(db, plan.id))?.connectionId).toBe('c2');
		expect(await db.syncState.get('c1')).toBeUndefined();
	});

	it('offers no reconnect where the server does not offer the provider', async () => {
		const { db } = await detached();
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({ authMode: 'storage-first', providers: ['onedrive'] }),
			}),
			db
		);

		expect(await screen.findByText('Dropbox · ada@example.com is disconnected')).toBeTruthy();
		await screen.findByRole('button', { name: 'Connect another OneDrive account' });
		expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
		// The rest does not need the server at all.
		expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Discard…' })).toBeTruthy();
	});

	it('says so for a source brought back by a late save, which names no account', async () => {
		const db = freshDatabase();
		await db.syncState.put({
			connectionId: 'c-gone',
			clientId: 'client',
			detached: { at: 1, reason: 'interrupted' },
		});
		await createNote(db, { connectionId: 'c-gone', title: 'Late' });
		renderPanel(clientWith(), db);

		expect(await screen.findByText('A source is disconnected')).toBeTruthy();
		expect(screen.getByText(/no longer knows which account it was/)).toBeTruthy();
		await screen.findByRole('button', { name: 'Connect another Dropbox account' });
		expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
	});

	it('offers the device’s own notes beside a source brought back behind them', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		// Nothing connected, the user writing on the device itself, and then a
		// source made again by a late save: the notes on screen stay on screen.
		await createNote(db, { title: 'Mine' });
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: LOCAL_CONNECTION_ID });
		await db.syncState.put({
			connectionId: 'c-gone',
			clientId: 'client',
			detached: { at: 1, reason: 'interrupted' },
		});
		await createNote(db, { connectionId: 'c-gone', title: 'Late' });
		renderPanel(clientWith(), db);

		expect(await screen.findByText(/Notes are kept on this device only/)).toBeTruthy();
		expect(await screen.findByText('On this device only · showing')).toBeTruthy();
		// The first connect is offered, and not "another": the pile is no account.
		expect(screen.getByRole('button', { name: 'Connect Dropbox' })).toBeTruthy();
		expect(
			screen.queryByRole('button', { name: 'Connect another Dropbox account' })
		).toBeNull();

		await user.click(
			screen.getByRole('button', { name: 'Show A source — disconnected, 1 not sent' })
		);

		expect(await screen.findByText('A source is disconnected')).toBeTruthy();
		expect(
			await screen.findByRole('button', { name: 'Show On this device only' })
		).toBeTruthy();
	});

	it('downloads the notes that were never sent', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		const { downloaded } = renderPanel(clientWith(), db);

		await user.click(await enabled('Download'));

		expect(downloaded.map((titles) => [...titles].sort())).toEqual([['List', 'Plan']]);
		// A download takes nothing away.
		expect(await db.notes.count()).toBe(2);
	});

	it('discards in two steps: the first only lists what would go, with the focus on Cancel', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		const { downloaded } = renderPanel(clientWith(), db);

		await user.click(await enabled('Discard…'));

		const listed = await screen.findByRole('list', { name: 'Notes to discard' });
		expect([...listed.querySelectorAll('li')].map((item) => item.textContent).sort()).toEqual([
			'List',
			'Plan',
		]);
		expect(screen.getByText('Discard these 2 notes?')).toBeTruthy();
		expect(screen.getByText('These exist nowhere else. This cannot be undone.')).toBeTruthy();
		// A stray Enter answers no.
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.getByRole('button', { name: 'Discard for good' })).toBeTruthy();
		// Nothing has gone, and a download is within reach.
		expect(await db.notes.count()).toBe(2);
		await user.click(screen.getByRole('button', { name: 'Download them first' }));
		expect(downloaded).toHaveLength(1);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('button', { name: 'Discard for good' })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard…' }));
		expect(await db.notes.count()).toBe(2);
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
	});

	it('discards for good on the second step, and the source goes with its notes', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		renderPanel(clientWith(), db);

		await user.click(await enabled('Discard…'));
		await user.click(await screen.findByRole('button', { name: 'Discard for good' }));

		expect(await screen.findByText(/Notes are kept on this device only/)).toBeTruthy();
		expect(await db.notes.count()).toBe(0);
		expect(await db.opQueue.count()).toBe(0);
		expect(await db.syncState.count()).toBe(0);
	});

	it('keeps what was written after the list was shown, and says so', async () => {
		const user = userEvent.setup();
		const { db, plan, list } = await detached();
		renderPanel(clientWith(), db);
		await user.click(await enabled('Discard…'));
		await screen.findByRole('list', { name: 'Notes to discard' });

		// Another tab, while the confirm is open: a new note, and a chapter into
		// one that was on the list.
		const late = await createNote(db, { connectionId: 'c1', title: 'Typed since' });
		await saveNoteBody(db, plan.id, '# Plan\n\nan hour of work\n', undefined, {
			connectionId: 'c1',
		});
		await user.click(screen.getByRole('button', { name: 'Discard for good' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(
			/was not on the list, so it has been kept/
		);
		// What was listed as shown went. The note the user was never shown, and
		// the text they were never shown, are still here, in a source still
		// detached: the list promised to discard what it listed, and no more.
		expect((await noteById(db, plan.id))?.body).toBe('# Plan\n\nan hour of work\n');
		expect(await noteById(db, list.id)).toBeUndefined();
		expect((await noteById(db, late.id))?.connectionId).toBe('c1');
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
		expect(
			await screen.findByText(/2 changes here were never sent, and are kept/)
		).toBeTruthy();
	});

	it('keeps what the editor was still holding when Discard for good was pressed', async () => {
		const user = userEvent.setup();
		const { db, plan } = await detached();
		renderPanel(clientWith(), db);
		await user.click(await enabled('Discard…'));
		await screen.findByRole('list', { name: 'Notes to discard' });
		// The panel is not a modal: the user typed into a listed note meanwhile,
		// and the editor is still holding it inside the autosave window.
		const withdraw = beforeClosing(() =>
			saveNoteBody(db, plan.id, '# Plan\n\nstill in the editor\n', undefined, {
				connectionId: 'c1',
			})
		);

		await user.click(screen.getByRole('button', { name: 'Discard for good' }));
		await screen.findByRole('alert');
		withdraw();

		expect((await noteById(db, plan.id))?.body).toBe('# Plan\n\nstill in the editor\n');
	});

	it('discards nothing when the source was connected again while it asked', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		renderPanel(clientWith(), db);
		await user.click(await enabled('Discard…'));
		await screen.findByRole('list', { name: 'Notes to discard' });

		// Another tab, while the confirm is open — and the click lands before
		// this panel has heard, or the panel has already become the live one.
		await holding(db, 'c1');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const confirm = screen.queryByRole('button', { name: 'Discard for good' });
		if (confirm !== null) await user.click(confirm);

		// Either way nothing went, and the panel is the live source's.
		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect(await db.notes.count()).toBe(2);
		expect((await db.syncState.get('c1'))?.detached).toBeUndefined();
		expect(await db.credentials.get('c1')).toBeDefined();
	});

	it('closes the confirm on Escape, as Cancel does', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		renderPanel(clientWith(), db);
		await user.click(await enabled('Discard…'));
		await screen.findByRole('list', { name: 'Notes to discard' });

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: 'Discard for good' })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard…' }));
		expect(await db.notes.count()).toBe(2);
	});

	it('puts the focus in the next panel once the source has gone with its notes', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		renderPanel(clientWith(), db);
		await user.click(await enabled('Discard…'));
		await user.click(await screen.findByRole('button', { name: 'Discard for good' }));

		await screen.findByText(/Notes are kept on this device only/);
		// Not on the page: on what the panel offers now.
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole('button', { name: 'Connect Dropbox' })
			);
		});
	});

	it('says plainly that a delete still owed will be carried out on reconnecting', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		const sent = await sentNote(db, 'Sent');
		await deleteNote(db, sent.id, { connectionId: 'c1' });
		await detachConnection(db, { connectionId: 'c1' });
		renderPanel(clientWith(), db);

		expect(
			await screen.findByText(
				/1 note deleted here will be deleted from Dropbox when you reconnect, even if it has been changed there since/
			)
		).toBeTruthy();
	});

	it('does not let the disconnect confirm close on Escape take a note’s keystrokes', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		renderPanel(clientWith(), db);
		await user.click(await enabled('Disconnect…'));
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Disconnect…' }));
		expect((await db.syncState.get('c1'))?.detached).toBeUndefined();
	});

	it('is listed for what it is behind a live source, and can be shown', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		await holding(db, 'c2', 'sk1_onedrive');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		renderPanel(
			clientWith({
				config: () =>
					Promise.resolve({
						authMode: 'storage-first',
						providers: ['dropbox', 'onedrive'],
					}),
				connection: () =>
					Promise.resolve({
						ok: true,
						value: { ...dropbox, id: 'c2', provider: 'onedrive', accountId: 'ms:1' },
					}),
			}),
			db
		);
		expect(await screen.findByText(/Syncing with OneDrive/)).toBeTruthy();

		await user.click(
			await screen.findByRole('button', {
				name: 'Show Dropbox · ada@example.com — disconnected, 2 not sent',
			})
		);

		expect(await screen.findByText('Dropbox · ada@example.com is disconnected')).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c1');
		// And back again, from the detached source's own panel.
		expect(await screen.findByRole('button', { name: 'Show OneDrive · ms:1' })).toBeTruthy();
	});
});

describe('AccountPanel, with more than one source connected', () => {
	const onedrive = {
		...dropbox,
		id: 'c2',
		provider: 'onedrive' as const,
		displayName: 'ada@work.example',
		accountId: 'ms:1',
	};

	/** Dropbox and OneDrive connected at once, Dropbox in front. */
	const twoSources = async () => {
		const db = freshDatabase();
		await holding(db, 'c2', 'sk1_onedrive');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await holding(db, 'c1', 'sk1_dropbox');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		return db;
	};

	it('names the other source and shows it when asked, moving nothing', async () => {
		const user = userEvent.setup();
		const db = await twoSources();
		const here = await createNote(db, { title: 'On Dropbox' });
		// Whichever source is in front is the one the credential reaches.
		const client = clientWith({
			connection: async () => ({
				ok: true as const,
				value: (await activeConnectionId(db)) === 'c1' ? dropbox : onedrive,
			}),
		});
		renderPanel(client, db);
		expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();

		await user.click(await screen.findByRole('button', { name: 'Show OneDrive · ms:1' }));

		expect(await screen.findByText(/ada@work\.example/)).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c2');
		// Switching is a change of view. The note stays where it was written,
		// and the credential it is synced with stays with it.
		expect((await noteById(db, here.id))?.connectionId).toBe('c1');
		expect((await db.credentials.get('c1'))?.credential).toBe('sk1_dropbox');
	});

	it('tells two accounts at one provider apart', async () => {
		const db = freshDatabase();
		await holding(db, 'c1', 'sk1_one');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c3', 'sk1_two');
		await bindConnection(db, { connectionId: 'c3', provider: 'dropbox', accountId: 'dbid:2' });
		// Answering for the source in front: `rememberAccount` writes what the
		// server says onto that source's row, so a stub that always named the
		// same account would relabel the one being shown.
		renderPanel(
			clientWith({
				connection: () =>
					Promise.resolve({
						ok: true,
						value: { ...dropbox, id: 'c3', accountId: 'dbid:2' },
					}),
			}),
			db
		);

		// The case the list exists for. "Dropbox", twice, one of them "showing",
		// is not a choice anyone can act on.
		expect(await screen.findByRole('button', { name: 'Show Dropbox · dbid:1' })).toBeTruthy();
		await waitFor(() => {
			expect(screen.getByRole('list', { name: 'Connected sources' }).textContent).toContain(
				'Dropbox · dbid:2 · showing'
			);
		});
	});

	it('offers to connect another account without letting the first go', async () => {
		const user = userEvent.setup();
		const db = await twoSources();
		const { went } = renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		await user.click(
			await screen.findByRole('button', { name: 'Connect another Dropbox account' })
		);

		await waitFor(() => {
			expect(went.length).toBe(1);
		});
		expect((await db.credentials.get(PENDING_CREDENTIAL_ID))?.credential).toMatch(/^sk1_/);
		// Nothing was let go to make room.
		expect(await db.syncState.count()).toBe(2);
	});

	it('keeps a disconnect that failed with the source it failed for', async () => {
		const user = userEvent.setup();
		const db = await twoSources();
		// Written while OneDrive is in front, so it is OneDrive's.
		await showConnection(db, 'c2');
		const there = await createNote(db, { title: 'On OneDrive' });
		await showConnection(db, 'c1');
		await db.syncState.update('c2', { cursor: 'cursor-2' });
		renderPanel(
			clientWith({
				connection: async () => ({
					ok: true as const,
					value: (await activeConnectionId(db)) === 'c1' ? dropbox : onedrive,
				}),
				disconnect: () => Promise.reject(new TypeError('offline')),
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));
		expect(
			await screen.findByRole('button', { name: 'Stop syncing on this device' })
		).toBeTruthy();

		await user.click(await screen.findByRole('button', { name: 'Show OneDrive · ms:1' }));
		expect(await screen.findByText(/Syncing with OneDrive/)).toBeTruthy();

		// Dropbox's failure is not OneDrive's. Left on screen, the button would
		// let go of OneDrive — its rows to the device, its cursor gone — while
		// Dropbox, the one the user asked about, stayed live on the server.
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Stop syncing on this device' })).toBeNull();
		expect((await db.syncState.get('c2'))?.cursor).toBe('cursor-2');
		expect((await noteById(db, there.id))?.connectionId).toBe('c2');
		expect(await db.syncState.get('c1')).toBeDefined();
	});

	it('keeps the answer to a disconnect for its source, even when it arrives under another', async () => {
		const user = userEvent.setup();
		const db = await twoSources();
		const out: { fail: (error: Error) => void } = { fail: () => undefined };
		const disconnect = vi.fn<ApiClient['disconnect']>(
			() =>
				new Promise((_resolve, reject) => {
					out.fail = reject;
				})
		);
		renderPanel(
			clientWith({
				connection: async () => ({
					ok: true as const,
					value: (await activeConnectionId(db)) === 'c1' ? dropbox : onedrive,
				}),
				disconnect,
			}),
			db
		);

		await user.click(await enabled('Disconnect…'));
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));
		await user.click(await screen.findByRole('button', { name: 'Show OneDrive · ms:1' }));
		expect(await screen.findByText(/Syncing with OneDrive/)).toBeTruthy();

		// Back on Dropbox with its disconnect still out: not one to start again.
		await user.click(await screen.findByRole('button', { name: 'Show Dropbox · dbid:1' }));
		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Disconnect…' }).hasAttribute('disabled')).toBe(
			true
		);

		await user.click(await screen.findByRole('button', { name: 'Show OneDrive · ms:1' }));
		expect(await screen.findByText(/Syncing with OneDrive/)).toBeTruthy();
		await act(async () => {
			out.fail(new TypeError('offline'));
			await Promise.resolve();
		});
		// Not OneDrive's failure, and not said under its name.
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Stop syncing on this device' })).toBeNull();

		// But not lost either: it is there when the user comes back to Dropbox.
		await user.click(await screen.findByRole('button', { name: 'Show Dropbox · dbid:1' }));
		expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be reached/);
		expect(screen.getByRole('button', { name: 'Stop syncing on this device' })).toBeTruthy();
		expect(disconnect).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole('button', { name: 'Stop syncing on this device' }));
		await waitFor(async () => {
			expect(await db.syncState.get('c1')).toBeUndefined();
		});
		expect(await db.syncState.get('c2')).toBeDefined();
	});

	it('says nothing about sources when only one is connected', async () => {
		const db = freshDatabase();
		await holding(db, 'c1');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		expect(await screen.findByText(/Syncing with Dropbox/)).toBeTruthy();
		expect(screen.queryByRole('list', { name: 'Connected sources' })).toBeNull();
	});
});

describe('AccountPanel, listing the devices holding a connection', () => {
	const connected = async (answers: Answers) => {
		const db = freshDatabase();
		await holding(db, 'c1', 'sk1_here');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		const client = clientWith({
			connection: () => Promise.resolve({ ok: true, value: dropbox }),
			...answers,
		});
		renderPanel(client, db);
		await screen.findByText(/Syncing with Dropbox/);
		return { db, client };
	};

	const GRANTS = [
		{ id: 'g1', createdAt: 1, lastUsedAt: 1, expired: false, current: true },
		{ id: 'g2', createdAt: 2, lastUsedAt: 2, expired: false, current: false },
	];

	it('names the other devices, and asks with this connection’s credential', async () => {
		const { client } = await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
		});

		const devices = await screen.findByRole('list', { name: 'Devices' });

		expect(devices.querySelectorAll('li').length).toBe(2);
		expect(screen.getByText(/This device/)).toBeTruthy();
		expect(client.asked).toContain('sk1_here');
		// This one cannot be removed from itself: disconnecting is that.
		expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBe(1);
	});

	it('removes a device and asks again, so the list is what the server has', async () => {
		const user = userEvent.setup();
		const revokeGrant = vi.fn<ApiClient['revokeGrant']>(() =>
			Promise.resolve({ ok: true, value: { ok: true } })
		);
		const grants = vi
			.fn<ApiClient['grants']>()
			.mockResolvedValueOnce({ ok: true, value: GRANTS })
			.mockResolvedValue({ ok: true, value: [GRANTS[0]!] });
		await connected({ grants, revokeGrant });
		await screen.findByRole('list', { name: 'Devices' });

		await user.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(() => {
			expect(screen.queryByRole('list', { name: 'Devices' })).toBeNull();
		});
		expect(revokeGrant).toHaveBeenCalledWith('g2');
	});

	it('says so when a device will not go, and leaves the list alone', async () => {
		const user = userEvent.setup();
		await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
			revokeGrant: () => Promise.resolve({ ok: false, refusal: 'not_found' }),
		});
		await screen.findByRole('list', { name: 'Devices' });

		await user.click(screen.getByRole('button', { name: 'Remove' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/would not remove it/);
		expect(screen.getByRole('list', { name: 'Devices' }).querySelectorAll('li').length).toBe(2);
	});

	it('asks again when the user switches source, so the list is that source’s', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await holding(db, 'c2', 'sk1_second');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await holding(db, 'c1', 'sk1_first');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const second = { id: 'g9', createdAt: 3, lastUsedAt: 3, expired: false, current: false };
		const client = clientWith({
			connection: async () => ({
				ok: true as const,
				value:
					(await activeConnectionId(db)) === 'c1'
						? dropbox
						: { ...dropbox, id: 'c2', provider: 'onedrive' as const },
			}),
			grants: async () => ({
				ok: true as const,
				value: (await activeConnectionId(db)) === 'c1' ? GRANTS : [...GRANTS, second],
			}),
		});
		renderPanel(client, db);
		await waitFor(async () => {
			expect((await screen.findByRole('list', { name: 'Devices' })).children.length).toBe(2);
		});

		await user.click(await screen.findByRole('button', { name: 'Show OneDrive · ms:1' }));

		// Left alone, the list would still be Dropbox's, under a panel naming
		// OneDrive — and pressing Remove would send a grant id this connection
		// has never heard of.
		await waitFor(async () => {
			expect((await screen.findByRole('list', { name: 'Devices' })).children.length).toBe(3);
		});
	});

	it('drops an answer about one source that arrives once another is showing', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await holding(db, 'c2', 'sk1_second');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await holding(db, 'c1', 'sk1_first');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const second = { id: 'g9', createdAt: 3, lastUsedAt: 3, expired: false, current: false };
		type Answer = Awaited<ReturnType<ApiClient['grants']>>;
		const slow: { resolve: (answer: Answer) => void } = { resolve: () => undefined };
		const held = new Promise<Answer>((resolve) => {
			slow.resolve = resolve;
		});
		const client = clientWith({
			connection: async () => ({
				ok: true as const,
				value:
					(await activeConnectionId(db)) === 'c1'
						? dropbox
						: { ...dropbox, id: 'c2', provider: 'onedrive' as const },
			}),
			// Dropbox's answer is still out when the user moves on.
			grants: async () =>
				(await activeConnectionId(db)) === 'c1'
					? held
					: { ok: true as const, value: [...GRANTS, second] },
		});
		renderPanel(client, db);

		await user.click(await screen.findByRole('button', { name: 'Show OneDrive · ms:1' }));
		await waitFor(async () => {
			expect((await screen.findByRole('list', { name: 'Devices' })).children.length).toBe(3);
		});

		await act(async () => {
			slow.resolve({ ok: true, value: GRANTS });
			await held;
		});

		expect(screen.getByRole('list', { name: 'Devices' }).children.length).toBe(3);
	});

	it('says nothing where this is the only device, or the server cannot be asked', async () => {
		await connected({ grants: () => Promise.resolve({ ok: true, value: [GRANTS[0]!] }) });
		expect(screen.queryByRole('list', { name: 'Devices' })).toBeNull();

		cleanup();
		await connected({ grants: () => Promise.reject(new TypeError('offline')) });
		expect(screen.queryByRole('list', { name: 'Devices' })).toBeNull();
	});
});
