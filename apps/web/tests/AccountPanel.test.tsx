import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
	useRouterState,
} from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient, ApiError, type InstanceConfig } from '../src/api/client.js';
import { AccountPanel, returnPath } from '../src/components/AccountPanel.js';
import { SourcePanel, SourceTabs } from '../src/components/SourceTabs.js';
import { type pickFiles } from '../src/editor/pickFiles.js';
import {
	bindConnection,
	detachConnection,
	finishImport,
	showConnection,
} from '../src/store/connection.js';
import { beginConnect, hashCredential } from '../src/store/credentials.js';
import {
	ACTIVE_CONNECTION_KEY,
	activeConnectionId,
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	PENDING_CREDENTIAL_ID,
} from '../src/store/db.js';
import { ArchiveLimitError, type Library } from '../src/store/exportNotes.js';
import { addAttachment } from '../src/store/files.js';
import { createFolder } from '../src/store/folders.js';
import { beforeClosing } from '../src/store/heldEdits.js';
import { createKeeping, type Keeping } from '../src/store/keeping.js';
import { createNote, deleteNote, saveNoteBody } from '../src/store/notes.js';
import { getScratchpadShown } from '../src/store/scratchpad.js';
import { UNSEEN_AT_PROVIDER } from '../src/sync/account.js';
import { PROGRESS_FROM } from '../src/sync/progress.js';
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

type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect' | 'checkConnectCode'>;

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
	signOut?: ApiClient['signOut'];
}

const clientWith = (answers: Answers = {}): Client & { asked: string[] } => {
	const asked: string[] = [];
	return {
		asked,
		config: answers.config ?? (() => Promise.resolve(STORAGE_FIRST)),
		checkConnectCode:
			answers.checkConnectCode ??
			(() => Promise.resolve({ ok: true, value: { accepted: true, expiresIn: 900 } })),
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
				signOut:
					answers.signOut ??
					(() => Promise.resolve({ ok: true, value: { disconnected: false } })),
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

/**
 * Long enough for the panel's live queries to have answered. An absence checked
 * sooner proves only that they had not, which is true of any panel whatever it
 * goes on to show.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

type User = ReturnType<typeof userEvent.setup>;

/**
 * The line a connected source's panel ends in, at the foot of the sidebar and
 * in a compact window's source dropdown alike: the source, and how its syncing
 * is going, with who the account is in its tooltip. Found by that tooltip,
 * which only a connected source's line has.
 */
const statusLine = (label = 'Dropbox'): Promise<HTMLElement> =>
	screen.findByTitle(new RegExp(`^Syncing with ${label}`));

/**
 * The status line once its tooltip names `account`, which is once the server
 * has answered for it: the line itself has room only for the source.
 */
const naming = (account: string): Promise<HTMLElement> =>
	screen.findByTitle(
		(_, element) =>
			element?.getAttribute('title')?.split('\n')[0]?.endsWith(` · ${account}`) === true
	);

/** The gear at the end of the status line, once it has something to offer. */
const gear = (): Promise<HTMLElement> => enabled('Storage options');

/**
 * The gear's menu, opened, or as it is where it is open already. It follows
 * the panel as it renders, so an item that arrives with a later answer — the
 * notes here counted, the server heard from — arrives in it.
 */
const openGear = async (user: User): Promise<HTMLElement> => {
	const button = await gear();
	if (button.getAttribute('aria-expanded') !== 'true') await user.click(button);
	return screen.findByRole('group', { name: 'Storage' });
};

/** An item of the gear's menu, opened, once it is offered and can be chosen. */
const offered = async (user: User, name: string): Promise<HTMLElement> => {
	const item = await within(await openGear(user)).findByRole('button', { name });
	await waitFor(() => {
		expect(item.hasAttribute('disabled')).toBe(false);
	});
	return item;
};

/** `name`, chosen from the gear's menu: which closes the menu, and then acts. */
const choose = async (user: User, name: string): Promise<void> => {
	await user.click(await offered(user, name));
};

/** What the open gear's menu offers, in order. */
const gearLabels = (): (string | null)[] =>
	within(screen.getByRole('group', { name: 'Storage' }))
		.getAllByRole('button')
		.map((item) => item.textContent);

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
		/**
		 * Whether the panel is listening yet. It mounts when the store's
		 * answer lands, outside `act`, and React subscribes it in an effect run
		 * on a later task: a status said before then reaches no one until that
		 * effect catches up, after whatever the test checked next.
		 */
		listening: () => listeners.size > 0,
		syncNow: vi.fn(() => Promise.resolve()),
		resync: vi.fn(() => Promise.resolve()),
		// Nothing to stop: resolves straight away with a release that does nothing.
		halt: vi.fn(() => Promise.resolve(() => undefined)),
		// The clipboard's own tests are in `ClipboardPanel.test.tsx`; here,
		// only what the panel asks of it.
		clipboard: {
			refresh: vi.fn(() => Promise.resolve()),
			flush: vi.fn(() => Promise.resolve()),
			read: vi.fn(() => Promise.resolve({ state: 'gone' as const })),
		},
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
	sync: FakeSync = fakeSync({ phase: 'local' }),
	/** What leaving does, for a test about a navigation that does not work. */
	go: (url: string) => void = () => undefined,
	/** What handing a whole source over does, for a test about one that fails. */
	saveAll: (library: Library) => void = () => undefined,
	/** What the browser says about keeping the store: by default, as jsdom, nothing. */
	keep: Keeping = createKeeping(() => undefined),
	/** What the picker hands back, for an import: jsdom opens none. */
	pick?: typeof pickFiles
) => {
	// Where the panel would send the browser. jsdom has no navigation, so
	// without this seam a connect test could only prove the button renders.
	const went: string[] = [];
	// And what it would hand the user as a file, by title: no blob URLs either.
	const downloaded: string[][] = [];
	// And the files that went with them, by path.
	const downloadedFiles: string[][] = [];
	// And a whole source, by its notes' titles and its notebooks' paths.
	const downloadedAll: { notes: string[]; folders: string[] }[] = [];
	// The bar as well as the panel, because since the tabs arrived the two are
	// one screen: connecting and switching are the bar's, and everything about
	// the source in front is the panel's. A harness holding only the panel
	// could no longer reach half of what these tests are about.
	const Shell = () => {
		const href = useRouterState({ select: (state) => state.location.href });
		return (
			<>
				<SourceTabs
					db={database}
					client={client}
					returnTo={returnPath(href)}
					navigate={(to) => {
						went.push(to);
						go(to);
					}}
				/>
				<AccountPanel
					client={client}
					database={database}
					sync={sync}
					navigate={(to) => {
						went.push(to);
						go(to);
					}}
					download={(library) => {
						downloaded.push(library.notes.map((note) => note.title));
						downloadedFiles.push(library.files.map((file) => file.path));
					}}
					keeping={keep}
					{...(pick === undefined ? {} : { pick })}
					downloadAll={(library) => {
						saveAll(library);
						downloadedAll.push({
							notes: library.notes.map((note) => note.title).sort(),
							folders: library.folders.map((folder) => folder.path),
						});
					}}
				/>
			</>
		);
	};
	const router = createRouter({
		routeTree: createRootRoute({ component: Shell }),
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	return { went, downloaded, downloadedFiles, downloadedAll };
};

/**
 * The `+` menu, opened. Connecting is the bar's now, not the panel's. The `+`
 * says what it is while nothing is connected, and is named for "another" once
 * something is.
 */
const openAdd = async (user: ReturnType<typeof userEvent.setup>) => {
	await user.click(
		await screen.findByRole('button', {
			name: /^(Connect another account|Connect storage provider)$/,
		})
	);
};

/**
 * Open the `+` and start a flow for one provider. Scoped to the menu, because
 * a tab and a menu entry are both called "Dropbox" on a device that already
 * has one.
 */
const connectVia = async (user: ReturnType<typeof userEvent.setup>, provider: string) => {
	await openAdd(user);
	const menu = await screen.findByRole('group', { name: 'Storage providers' });
	await user.click(within(menu).getByRole('button', { name: provider }));
};

/**
 * The tab for a source, by the short name the bar gives it. Awaited, because
 * the bar is a live query over the whole of `connectedSources` and the panel
 * beside it renders first — a synchronous `getByRole` here found the panel's
 * words and then no bar at all.
 */
const tab = async (name: string): Promise<HTMLElement> =>
	within(await screen.findByRole('navigation', { name: 'Sources' })).findByRole('button', {
		name,
	});

/** Nothing is connected: what the line at the foot of the panel says then. */
const NOTHING_CONNECTED = 'On this device only';

/**
 * Nothing is connected, and something could be: the way to it, as a compact
 * window's source dropdown points at it, its `+` having no words.
 */
const CONNECT_ABOVE = 'Use + above to connect storage.';

/** A note the remote has in full, as a sync leaves it. */
const sentNote = async (db: NotesDatabase, title: string) => {
	const note = await createNote(db, { title });
	await updateNote(db, note.id, { remoteId: `id:${title}`, remoteVersion: 'v1', dirty: 0 });
	await db.opQueue.where('noteId').equals(note.id).delete();
	return note;
};

/**
 * The panel as a compact window's source dropdown has it (`SourcePanel`): its
 * actions in the `⋯` at the end of the showing source's row, rather than
 * behind a gear at the end of its status line.
 */
const renderDropdown = (
	client: Client,
	database: NotesDatabase,
	sync: FakeSync = fakeSync({ phase: 'local' })
) => {
	const Shell = () => (
		<SourcePanel
			db={database}
			client={client}
			returnTo="/"
			navigate={() => undefined}
			account={(slot) => (
				<AccountPanel
					client={client}
					database={database}
					sync={sync}
					navigate={() => undefined}
					download={() => undefined}
					downloadAll={() => undefined}
					keeping={createKeeping(() => undefined)}
					slot={slot}
				/>
			)}
		/>
	);
	const router = createRouter({
		routeTree: createRootRoute({ component: Shell }),
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
};

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
		expect(gearLabels()).toEqual(['Import a folder', 'Import files', 'Hide scratchpad']);

		await createNote(db, { title: 'First' });
		await waitFor(() => {
			expect(gearLabels()).toEqual([
				'Download all notes',
				'Import a folder',
				'Import files',
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
		// Cancel has the focus, as in every question this app asks — once the
		// dialog's effect has given it, which a loaded machine runs a moment
		// after the dialog is found.
		await waitFor(() => {
			expect(document.activeElement).toBe(
				within(question).getByRole('button', { name: 'Cancel' })
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

describe('AccountPanel, downloading every note', () => {
	it('offers nothing to download on a device that holds nothing, until it does', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		renderPanel(clientWith(), db);

		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		const menu = await openGear(user);
		expect(within(menu).queryByRole('button', { name: 'Download all notes' })).toBeNull();

		await createNote(db, { title: 'First' });
		expect(await offered(user, 'Download all notes')).toBeTruthy();
	});

	it('hands over everything on a device with nothing connected, empty notebooks too', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createFolder(db, { name: 'Ideas' });
		await createNote(db, { title: 'Plan', folderPath: 'Work' });
		await createNote(db, { title: 'Loose' });
		const { downloadedAll } = renderPanel(clientWith(), db);

		await choose(user, 'Download all notes');

		await waitFor(() => {
			expect(downloadedAll).toEqual([
				{ notes: ['Loose', 'Plan'], folders: ['Ideas', 'Work'] },
			]);
		});
	});

	it("hands over the source in front, and nothing of the device's own or another's", async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'On this device', connectionId: LOCAL_CONNECTION_ID });
		await bindConnection(db, { connectionId: 'c2', provider: 'dropbox', accountId: 'dbid:2' });
		await finishImport(db, 'c2');
		await createNote(db, { title: 'In the other', connectionId: 'c2' });
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await finishImport(db, 'c1');
		await showConnection(db, 'c1');
		await holding(db, 'c1');
		await createNote(db, { title: 'In front', connectionId: 'c1' });
		const { downloadedAll } = renderPanel(clientWith(), db, '/', fakeSync());

		await statusLine();
		await choose(user, 'Download all notes');

		await waitFor(() => {
			expect(downloadedAll).toEqual([{ notes: ['In front'], folders: [] }]);
		});
	});

	it('says why, where it was asked, when the notes will not go in one archive', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Plan' });
		renderPanel(clientWith(), db, '/', fakeSync({ phase: 'local' }), undefined, () => {
			throw new ArchiveLimitError('entries', 'Too many notes for one archive');
		});

		await choose(user, 'Download all notes');

		expect((await screen.findByRole('alert')).textContent).toBe(
			'There are too many notes, notebooks and files here for one archive, which holds at most 65,534. Nothing was downloaded.'
		);
		// And it is there to try again.
		expect(await offered(user, 'Download all notes')).toBeTruthy();
	});

	it('is put away while the disconnect question is open, which has a download of its own', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await finishImport(db, 'c1');
		await holding(db, 'c1');
		await sentNote(db, 'Sent');
		renderPanel(clientWith(), db, '/', fakeSync());

		await offered(user, 'Download all notes');
		await choose(user, 'Disconnect');

		await screen.findByRole('button', { name: 'Disconnect' });
		await openGear(user);
		// What syncing offers is still there; the download is not, nor the
		// imports beside it, nor a second way to disconnect.
		expect(gearLabels()).toEqual([
			'Sync now',
			'Re-scan from scratch',
			'Show clipboard',
			'Hide scratchpad',
		]);
	});

	it('is not offered while a later source is still importing, when it would be half of one', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c2', provider: 'dropbox', accountId: 'dbid:2' });
		await finishImport(db, 'c2');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await showConnection(db, 'c1');
		await holding(db, 'c1');
		await createNote(db, { title: 'Arrived so far', connectionId: 'c1' });
		renderPanel(clientWith(), db, '/', fakeSync());

		await statusLine();
		await settled();
		const menu = await openGear(user);
		expect(within(menu).queryByRole('button', { name: 'Download all notes' })).toBeNull();

		await finishImport(db, 'c1');
		expect(await offered(user, 'Download all notes')).toBeTruthy();
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

describe('AccountPanel, with an account connected', () => {
	it('binds the device to the account it just consented to, and names it', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		expect(await statusLine()).toBeTruthy();
		expect(await naming('ada@example.com')).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('names the source in its line, and the account in the line’s tooltip', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		const line = await naming('ada@example.com');
		// Before the scheduler has picked the source up, the source and nothing
		// about how it is going.
		expect(line.textContent).toBe('Dropbox');
		expect(line.getAttribute('title')).toBe('Syncing with Dropbox · ada@example.com');
		// The heading the panel used to start with is that tooltip now.
		expect(screen.queryByText(/Syncing with/)).toBeNull();
		expect(screen.queryByText(/ada@example\.com/)).toBeNull();
	});

	it('shows the connection offline, from the device alone', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(clientWith({ connection: () => Promise.reject(new TypeError('offline')) }), db);

		const line = await statusLine();
		// With no account to name: the server cannot say, and the device was
		// never told.
		await settled();
		expect(line.getAttribute('title')).toBe('Syncing with Dropbox');
	});

	it('has everything that can be done to it behind the gear at the end of its line, in order', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await finishImport(db, 'c1');
		await holding(db, 'c1');
		await sentNote(db, 'Sent');
		const sync = fakeSync({ phase: 'idle' });
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db,
			'/',
			sync
		);

		await offered(user, 'Disconnect');
		await waitFor(() => {
			expect(gearLabels()).toEqual([
				'Sync now',
				'Re-scan from scratch',
				'Download all notes',
				'Import a folder',
				'Import files',
				'Show clipboard',
				'Hide scratchpad',
				'Disconnect',
			]);
		});
		const menu = within(screen.getByRole('group', { name: 'Storage' }));
		expect(menu.getByRole('button', { name: 'Disconnect' }).className).toContain('danger');
		// None of it is a button in the panel any more: the gear is the one.
		expect(
			within(screen.getByRole('region', { name: 'Storage' }))
				.getAllByRole('button')
				.map((button) => button.getAttribute('aria-label'))
		).toEqual(['Storage options']);

		// Chosen, the menu shuts first and hands the focus back, then it acts.
		await user.click(menu.getByRole('button', { name: 'Sync now' }));
		expect(screen.queryByRole('group', { name: 'Storage' })).toBeNull();
		expect(sync.syncNow).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Storage options' })
		);
	});

	it('greys the gear out while it has nothing to offer, and puts the focus back on it after', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		// Still in its first import, so nothing about syncing, downloading or
		// importing is offered: only the way to let it go.
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db,
			'/',
			fakeSync()
		);

		await offered(user, 'Disconnect');
		expect(gearLabels()).toEqual(['Disconnect']);
		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: 'Disconnect' });

		// And not that while the question it asks is open, which is the way on.
		const button = screen.getByRole('button', { name: 'Storage options' });
		expect(button.hasAttribute('disabled')).toBe(true);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(button.hasAttribute('disabled')).toBe(false);
		expect(document.activeElement).toBe(button);
	});

	it('asks before disconnecting, then removes its notes from this device and stops syncing', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1', 'sk1_for-c1');
		const sent = await sentNote(db, 'Sent');
		const signOut = vi.fn<ApiClient['signOut']>(() =>
			Promise.resolve({ ok: true, value: { disconnected: false } })
		);
		const client = clientWith({
			connection: () => Promise.resolve({ ok: true, value: dropbox }),
			signOut,
		});
		renderPanel(client, db);

		await choose(user, 'Disconnect');
		expect(signOut).not.toHaveBeenCalled();
		// What it says is what happens, and by the account's name.
		expect(
			await screen.findByText(
				'Disconnect Dropbox · ada@example.com from this device? Its notes are removed from this device. Nothing is deleted from Dropbox; connect it again to get them back.'
			)
		).toBeTruthy();
		// No other device holds it, so the account goes too, and is said to.
		expect(
			screen.getByText(
				'This is the only device connected to it, so the account is disconnected too.'
			)
		).toBeTruthy();
		// Everything here has been sent, so there is nothing to decide about.
		expect(screen.queryByText(/have not reached/)).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
		// Which connection is disconnected is no longer an argument: it is
		// whichever one the presented credential reaches.
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(client.asked).toContain('sk1_for-c1');
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect(await noteById(db, sent.id)).toBeUndefined();
		// And the credential is gone with the binding: it reaches nothing now.
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('says so beside the question when its download fails, from either step', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		await createNote(db, { title: 'Unsent' });
		const { downloaded } = renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);
		const failure = 'The notes could not be downloaded. Try again.';
		// The store will not give the bytes up.
		const failing = () =>
			vi.spyOn(db.fileBytes, 'bulkGet').mockRejectedValue(new Error('disk'));
		await choose(user, 'Disconnect');
		const failed = failing();

		await user.click(await screen.findByRole('button', { name: 'Download them' }));

		expect((await screen.findByText(failure)).getAttribute('role')).toBe('alert');
		// Tried again and done, it no longer says so.
		failed.mockRestore();
		await user.click(screen.getByRole('button', { name: 'Download them' }));
		await waitFor(() => {
			expect(downloaded).toHaveLength(1);
		});
		expect(screen.queryByText(failure)).toBeNull();
		failing();
		await user.click(screen.getByRole('button', { name: 'Discard them…' }));
		await user.click(await enabled('Download them first'));
		expect(await screen.findByText(failure)).toBeTruthy();
		expect(await db.notes.count()).toBe(1);
	});

	it('asks what becomes of what was never sent, and tells the server nothing until it is answered', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		await sentNote(db, 'Sent');
		await createNote(db, { title: 'Unsent' });
		const signOut = vi.fn<ApiClient['signOut']>(() =>
			Promise.resolve({ ok: true, value: { disconnected: false } })
		);
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				signOut,
			}),
			db
		);

		await choose(user, 'Disconnect');

		expect(
			await screen.findByText(
				'1 change on this device has not reached Dropbox, and cannot once it is disconnected.'
			)
		).toBeTruthy();
		expect(screen.getByText('1 note not yet sent')).toBeTruthy();
		expect(
			[
				...screen
					.getByRole('list', { name: 'Notes that have not been sent' })
					.querySelectorAll('li'),
			].map((item) => item.textContent)
		).toEqual(['Unsent']);
		// The only source there is, so there is nowhere to move it to.
		expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
		expect(screen.getByRole('button', { name: 'Discard them…' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Download them' })).toBeTruthy();
		// A stray Enter answers no, and nothing has been asked of the server. The
		// focus is moved by an effect after the render, so waited for, as below.
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
		});
		expect(signOut).not.toHaveBeenCalled();
		expect(await db.credentials.get('c1')).toBeDefined();
	});

	it('discards what was never sent when that is the answer, and the source goes with it', async () => {
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

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Discard them…' }));
		// Two steps, and the second one says what it costs.
		expect(
			await screen.findByText(
				'Discard this note? They exist nowhere else. This cannot be undone.'
			)
		).toBeTruthy();
		await user.click(screen.getByRole('button', { name: 'Discard for good' }));

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
		expect(await noteById(db, sent.id)).toBeUndefined();
		expect(await noteById(db, unsent.id)).toBeUndefined();
		expect(await db.syncState.count()).toBe(0);
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('counts the changes in the plural, and says why they cannot be sent', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		await createNote(db, { title: 'One' });
		await createNote(db, { title: 'Two' });
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db,
			'/',
			fakeSync({ phase: 'offline' })
		);

		await choose(user, 'Disconnect');

		expect(
			await screen.findByText(
				'2 changes on this device have not reached Dropbox, and cannot once it is disconnected. They cannot be sent right now (this device is offline). Cancel and try again later to keep them.'
			)
		).toBeTruthy();
		expect(screen.getByText('2 notes not yet sent')).toBeTruthy();
	});

	it('cancels without touching anything, and leaves the unsent work where it is', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const unsent = await createNote(db, { title: 'Unsent' });
		const signOut = vi.fn<ApiClient['signOut']>();
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				signOut,
			}),
			db
		);

		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: 'Discard them…' });
		await user.keyboard('{Escape}');

		expect(await offered(user, 'Disconnect')).toBeTruthy();
		expect(signOut).not.toHaveBeenCalled();
		expect((await noteById(db, unsent.id))?.connectionId).toBe('c1');
		expect((await db.syncState.get('c1'))?.detached).toBeUndefined();
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

		expect(await statusLine('OneDrive')).toBeTruthy();
		expect(screen.queryByRole('link', { name: 'microsoft.com/consent' })).toBeNull();
		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: 'Disconnect' });

		expect(
			screen.getByRole('link', { name: 'microsoft.com/consent' }).getAttribute('href')
		).toBe('https://microsoft.com/consent');
		expect(screen.getByRole('link', { name: 'My Apps' }).getAttribute('href')).toBe(
			'https://myapplications.microsoft.com/'
		);
	});

	describe('importing', () => {
		/** A picker that hands back these files, and remembers what it was asked for. */
		const picker = (files: File[]) => {
			const asked: Parameters<typeof pickFiles>[0][] = [];
			const pick: typeof pickFiles = (options) => {
				asked.push(options);
				return Promise.resolve(files);
			};
			return { pick, asked };
		};
		const inFolder = (relative: string, content: string): File => {
			const file = new File([content], relative.split('/').at(-1) ?? relative);
			Object.defineProperty(file, 'webkitRelativePath', { value: relative });
			return file;
		};

		it('asks what will come in and what stays out, then brings it in', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			const gdrive = { ...dropbox, provider: 'gdrive' as const, accountId: 'g' };
			await bindConnection(db, { connectionId: 'c1', provider: 'gdrive', accountId: 'g' });
			await finishImport(db, 'c1');
			await holding(db, 'c1');
			const { pick, asked } = picker([
				inFolder('old/Work/plan.md', '# Plan\n'),
				inFolder('old/Work/.hidden.md', 'h'),
				inFolder('old/.DS_Store', 'x'),
			]);
			renderPanel(
				clientWith({ connection: () => Promise.resolve({ ok: true, value: gdrive }) }),
				db,
				'/',
				fakeSync(),
				undefined,
				undefined,
				undefined,
				pick
			);

			await choose(user, 'Import a folder');
			const dialog = await screen.findByRole('alertdialog', {
				name: 'Import into Google Drive?',
			});
			expect(asked).toEqual([{ folder: true }]);
			expect(dialog.textContent).toContain(
				'1 note, in 1 notebook, will be added to Google Drive'
			);
			expect(dialog.textContent).toContain('Left out: 1 note has a name');
			expect(dialog.textContent).toContain('Work/.hidden.md');
			expect(await db.notes.count()).toBe(0);

			await user.click(within(dialog).getByRole('button', { name: 'Import' }));

			expect(
				await screen.findByText(
					/Imported 1 note\. They go up to Google Drive as it syncs\./
				)
			).toBeTruthy();
			const note = await db.notes
				.where('[connectionId+path]')
				.equals(['c1', 'Work/plan.md'])
				.first();
			expect(note?.dirty).toBe(1);
			expect(note?.source).toBe('# Plan\n');
		});

		it('brings nothing in when the question is cancelled', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			const { pick, asked } = picker([new File(['# One'], 'one.md')]);
			renderPanel(clientWith(), db, '/', undefined, undefined, undefined, undefined, pick);

			await choose(user, 'Import files');
			expect(asked[0]?.accept).toContain('.zip');
			const dialog = await screen.findByRole('alertdialog', {
				name: 'Import into this device?',
			});
			await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

			expect(screen.queryByRole('alertdialog')).toBeNull();
			expect(await db.notes.count()).toBe(0);
		});

		it('says so when there is nothing to bring in, and asks nothing', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			const { pick } = picker([inFolder('old/.DS_Store', 'x')]);
			renderPanel(clientWith(), db, '/', undefined, undefined, undefined, undefined, pick);

			await choose(user, 'Import a folder');

			expect(
				await screen.findByText('Nothing to import: no notes or files were found.')
			).toBeTruthy();
			expect(screen.queryByRole('alertdialog')).toBeNull();
		});

		it('is not offered while a first import is filling the source', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
			// Held, so the source stays while its menu is looked at: one with no
			// credential is let go as soon as the panel asks about it.
			await holding(db, 'c1');
			renderPanel(clientWith(), db, '/', fakeSync());

			expect(await statusLine()).toBeTruthy();
			const menu = await openGear(user);
			expect(within(menu).queryByRole('button', { name: 'Import a folder' })).toBeNull();
			expect(within(menu).queryByRole('button', { name: 'Import files' })).toBeNull();
			// Only the way to let the source go, which an import does not hold up.
			expect(gearLabels()).toEqual(['Disconnect']);
		});
	});

	it('says Google Drive hides what the app did not put in its folder, from the gear', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const gdrive = { ...dropbox, provider: 'gdrive' as const, accountId: 'g-sub' };
		await bindConnection(db, { connectionId: 'c1', provider: 'gdrive' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: gdrive }) }),
			db
		);

		expect(await statusLine('Google Drive')).toBeTruthy();
		const summary = UNSEEN_AT_PROVIDER.gdrive?.summary ?? '';
		const detail = UNSEEN_AT_PROVIDER.gdrive?.detail ?? '';
		expect(detail).toContain('skysa-notes folder');
		// Not in the panel, where it would be a paragraph at the foot of the
		// sidebar for good: behind the gear, before the way to let the source go.
		expect(screen.queryByText(summary)).toBeNull();
		expect(screen.queryByText(detail)).toBeNull();
		await openGear(user);
		expect(gearLabels()).toEqual(['About Google Drive', 'Disconnect']);

		await choose(user, 'About Google Drive');

		// Over everything, with the focus on its Close.
		const dialog = await screen.findByRole('dialog', { name: summary });
		expect(within(dialog).getByText(detail)).toBeTruthy();
		const close = within(dialog).getByRole('button', { name: 'Close' });
		expect(document.activeElement).toBe(close);
		await user.click(close);

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Storage options' })
		);
	});

	it('says nothing of the kind for a provider that shows the app its whole folder', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(clientWith(), db);

		expect(await statusLine()).toBeTruthy();
		await openGear(user);
		// Nothing about Dropbox before the way to let it go.
		expect(gearLabels()).toEqual(['Disconnect']);
		expect(screen.queryByText(UNSEEN_AT_PROVIDER.gdrive?.summary ?? '')).toBeNull();
	});

	describe('with other devices in the account', () => {
		const onedrive = { ...dropbox, provider: 'onedrive' as const, accountId: 'ms-sub' };
		const here = { id: 'g1', createdAt: 1, lastUsedAt: 1, expired: false, current: true };
		const other = (id: string, expired = false) => ({
			id,
			createdAt: 2,
			lastUsedAt: 2,
			expired,
			current: false,
		});
		const disconnecting = async (grants: ApiClient['grants']) => {
			const user = userEvent.setup();
			const db = freshDatabase();
			await bindConnection(db, { connectionId: 'c1', provider: 'onedrive' });
			await holding(db, 'c1');
			const signOut = vi.fn<ApiClient['signOut']>(() =>
				Promise.resolve({ ok: true, value: { disconnected: false } })
			);
			renderPanel(
				clientWith({
					connection: () => Promise.resolve({ ok: true, value: onedrive }),
					grants,
					signOut,
				}),
				db
			);
			await choose(user, 'Disconnect');
			await screen.findByRole('button', { name: 'Disconnect' });
			return { user, db, signOut };
		};

		it('says they keep syncing, and sends nobody to withdraw the access they use', async () => {
			const { user, db, signOut } = await disconnecting(() =>
				Promise.resolve({ ok: true, value: [here, other('g2')] })
			);

			expect(
				await screen.findByText(
					'The other device connected to it stays connected and keeps syncing.'
				)
			).toBeTruthy();
			expect(screen.queryByText(/only device/)).toBeNull();
			expect(screen.queryByRole('link', { name: 'microsoft.com/consent' })).toBeNull();

			await user.click(screen.getByRole('button', { name: 'Disconnect' }));
			expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
			// This device, and only this one, is signed out.
			expect(signOut).toHaveBeenCalledTimes(1);
			expect(await db.credentials.get('c1')).toBeUndefined();
		});

		it('counts them', async () => {
			await disconnecting(() =>
				Promise.resolve({ ok: true, value: [here, other('g2'), other('g3')] })
			);

			expect(
				await screen.findByText(
					'The 2 other devices connected to it stay connected and keep syncing.'
				)
			).toBeTruthy();
		});

		it('does not count one signed out for being idle, which the server does not', async () => {
			await disconnecting(() =>
				Promise.resolve({ ok: true, value: [here, other('g2', true)] })
			);

			expect(
				await screen.findByText(
					'This is the only device connected to it, so the account is disconnected too.'
				)
			).toBeTruthy();
			expect(screen.getByRole('link', { name: 'microsoft.com/consent' })).toBeTruthy();
		});

		it('says both outcomes where the server has not said which', async () => {
			await disconnecting(() => Promise.reject(new TypeError('offline')));

			expect(
				await screen.findByText(
					'Other devices connected to it stay connected. If this is the last one, the account is disconnected too.'
				)
			).toBeTruthy();
			expect(screen.getByRole('link', { name: 'microsoft.com/consent' })).toBeTruthy();
		});
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

		await choose(user, 'Disconnect');
		expect(await screen.findByText(/Its notes are removed from this device/)).toBeTruthy();
		expect(screen.queryByText(/keeps this app’s access/)).toBeNull();
		expect(screen.queryByRole('link', { name: 'microsoft.com/consent' })).toBeNull();
	});

	it('can be talked out of disconnecting', async () => {
		const user = userEvent.setup();
		const signOut = vi.fn<ApiClient['signOut']>();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				signOut,
			}),
			db
		);

		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: 'Disconnect' });
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(await offered(user, 'Disconnect')).toBeTruthy();
		expect(signOut).not.toHaveBeenCalled();
	});

	it('stays connected and says why when the server will not disconnect', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				signOut: () => Promise.resolve({ ok: false, refusal: 'not_entitled' }),
			}),
			db
		);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

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

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
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
				signOut: () => Promise.reject(new TypeError('offline')),
			}),
			db
		);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be reached/);
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it('cannot be disconnected while the server is still being asked on open', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(clientWith({ connection: () => new Promise(() => undefined) }), db);

		const item = await within(await openGear(user)).findByRole('button', {
			name: 'Disconnect',
		});

		expect(item.hasAttribute('disabled')).toBe(true);
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

		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: 'Disconnect' });
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
		});

		// Back on the gear the question was asked from: the item that asked it
		// went with the menu.
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Storage options' })
		);
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
				signOut: () =>
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

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
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
				signOut: () => Promise.reject(new ApiError('DELETE failed with 500', 500)),
			}),
			db
		);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/could not disconnect/);
		expect(await activeConnectionId(db)).toBe('c1');
	});

	it.each([
		[
			'could not be reached',
			() => Promise.reject(new TypeError('offline')),
			/The server cannot be reached/,
		],
		[
			'answered with a failure',
			() => Promise.reject(new ApiError('DELETE /connection failed with 500', 500)),
			/The server could not disconnect the account/,
		],
	] as const)(
		'still names the server where the server is what failed, and it %s',
		async (_, signOut, said) => {
			const user = userEvent.setup();
			const db = freshDatabase();
			await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
			await holding(db, 'c1');
			renderPanel(
				clientWith({
					connection: () => Promise.resolve({ ok: true, value: dropbox }),
					signOut,
				}),
				db
			);

			await choose(user, 'Disconnect');
			await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

			// The call did leave the device, so the wording that sends the user to
			// the connection is the true one — and the local one would be a lie.
			const problem = await screen.findByText(said);
			expect(problem.textContent).not.toMatch(/this device went wrong/);
			expect(await activeConnectionId(db)).toBe('c1');
		}
	);

	it('does not claim the account is still connected once the server has let it go', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const signOut = vi.fn<ApiClient['signOut']>(() =>
			Promise.resolve({ ok: true, value: { disconnected: false } })
		);
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				signOut,
			}),
			db
		);

		await choose(user, 'Disconnect');
		// Everything after the server's yes is this device's own work, so this is
		// where the store is made to refuse: the account really is disconnected.
		const refused = vi
			.spyOn(db.credentials, 'delete')
			.mockRejectedValueOnce(new Error('QuotaExceededError'));
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

		const problem = await screen.findByText(/on this device went wrong/);
		// The account is gone at the provider and its refresh token with it, so
		// the old wording — "the account was not disconnected" — was a plain lie.
		expect(problem.textContent).toMatch(/may already be disconnected/);
		expect(problem.textContent).not.toMatch(/was not disconnected|still connected/);
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(refused).toHaveBeenCalledTimes(1);
		// And the proof that the two halves really did come apart.
		expect(await db.credentials.get('c1')).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c1');
		refused.mockRestore();
	});

	it('reads a client that throws where it stands as the server, not the device', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				// Not what the real client does — `call` is async — but `client` is
				// an injected seam, and a label that only holds for promises is a
				// label the signature does not keep.
				signOut: () => {
					throw new TypeError('the seam refused');
				},
			}),
			db
		);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

		const problem = await screen.findByText(/The server cannot be reached/);
		expect(problem.textContent).not.toMatch(/this device/);
	});

	it('does not blame a server for a failure that never left the device', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		// Refused, which is what puts "Stop syncing on this device" on offer — and
		// that asks the server nothing at all.
		const signOut = vi.fn<ApiClient['signOut']>(() =>
			Promise.resolve({ ok: false, refusal: 'not_entitled' })
		);
		renderPanel(
			clientWith({
				connection: () => Promise.resolve({ ok: true, value: dropbox }),
				signOut,
			}),
			db
		);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
		await choose(user, 'Stop syncing on this device');
		// The store is broken only once the question is up: the list it is about
		// is read from that same store, and a store that refused before now is a
		// different message about a different moment ("could not be read").
		const answering = await screen.findByRole('button', { name: 'Disconnect' });
		const refused = vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
			throw new Error('QuotaExceededError');
		});
		await user.click(answering);

		const problem = await screen.findByText(/on this device went wrong/);
		// Nothing was asked of a server, so nothing here may send the user to
		// look at one, or to try one again.
		expect(problem.textContent).not.toMatch(/server|reach|connection/i);
		expect(problem.getAttribute('role')).toBe('alert');
		expect(refused).toHaveBeenCalledTimes(1);
		// The claim the message makes, pinned: one call to disconnect the account
		// (the first attempt, which was refused) and none for this one.
		expect(signOut).toHaveBeenCalledTimes(1);
		// Still here to try again, and still syncing meanwhile.
		expect(await activeConnectionId(db)).toBe('c1');
		refused.mockRestore();
	});

	it('can stop syncing on this device alone when the server cannot be asked', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const signOut = vi.fn<ApiClient['signOut']>(() =>
			Promise.resolve({ ok: false, refusal: 'not_entitled' })
		);
		renderPanel(
			clientWith({
				connection: () => Promise.reject(new TypeError('offline')),
				signOut,
			}),
			db
		);
		// Not on offer before the server has refused anything.
		const menu = await openGear(user);
		await within(menu).findByRole('button', { name: 'Disconnect' });
		expect(
			within(menu).queryByRole('button', { name: 'Stop syncing on this device' })
		).toBeNull();

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
		await choose(user, 'Stop syncing on this device');
		// The same question again, with no server behind it.
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect(signOut).toHaveBeenCalledTimes(1);
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

		const again = await screen.findByRole('button', { name: 'Connect again' });
		// A button of the panel's under the message, not a word inside it,
		// which a phone's taller button wrapped against the text.
		expect(again.closest('p')).toBeNull();
		await user.click(again);

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

describe('AccountPanel, showing the clipboard', () => {
	const connectedHere = async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await finishImport(db, 'c1');
		await holding(db, 'c1');
		return db;
	};

	it('shows it before the storage panel once asked, on this device, and hides it again', async () => {
		const user = userEvent.setup();
		const db = await connectedHere();
		const sync = fakeSync({ phase: 'idle' });
		renderPanel(clientWith(), db, '/', sync);

		expect(screen.queryByRole('region', { name: 'Clipboard' })).toBeNull();
		await choose(user, 'Show clipboard');

		const region = await screen.findByRole('region', { name: 'Clipboard' });
		const storage = screen.getByRole('region', { name: 'Storage' });
		// A section of its own, just before the panel and ruled off from it
		// the whole width, not a part of it.
		expect(storage.contains(region)).toBe(false);
		expect(region.nextElementSibling).toBe(storage);
		expect(storage.contains(await statusLine())).toBe(true);
		expect((await db.syncState.get('c1'))?.clipboard).toBe(true);
		// What the other devices have pasted is read as it is shown.
		await waitFor(() => {
			expect(sync.clipboard.refresh).toHaveBeenCalledWith('c1');
		});

		await choose(user, 'Hide clipboard');
		await waitFor(() => {
			expect(screen.queryByRole('region', { name: 'Clipboard' })).toBeNull();
		});
		expect((await db.syncState.get('c1'))?.clipboard).toBeUndefined();
	});

	it('is not offered while the first import holds the source', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Kept' });
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(clientWith(), db, '/', fakeSync({ phase: 'idle' }));

		await openGear(user);
		expect(gearLabels()).not.toContain('Show clipboard');
	});

	it('is not offered with nothing connected', async () => {
		const user = userEvent.setup();
		renderPanel(clientWith(), freshDatabase());

		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		await openGear(user);
		expect(gearLabels()).not.toContain('Show clipboard');
	});
});

describe('AccountPanel, showing the scratchpad', () => {
	it('hides a connected source’s, on this device, and shows it again', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await finishImport(db, 'c1');
		await holding(db, 'c1');
		renderPanel(clientWith(), db, '/', fakeSync({ phase: 'idle' }));

		// Shown until it is hidden.
		await choose(user, 'Hide scratchpad');
		await waitFor(async () => {
			expect(await getScratchpadShown(db, 'c1')).toBe(false);
		});
		expect(await getScratchpadShown(db, LOCAL_CONNECTION_ID)).toBe(true);

		await choose(user, 'Show scratchpad');
		await waitFor(async () => {
			expect(await getScratchpadShown(db, 'c1')).toBe(true);
		});
	});

	it('hides the device’s own, with nothing connected, as the clipboard is not', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		renderPanel(clientWith(), db);

		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		await choose(user, 'Hide scratchpad');

		await waitFor(async () => {
			expect(await getScratchpadShown(db, LOCAL_CONNECTION_ID)).toBe(false);
		});
		await openGear(user);
		expect(gearLabels()).toContain('Show scratchpad');
	});

	it('is not offered while the first import holds the source', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Kept' });
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		renderPanel(clientWith(), db, '/', fakeSync({ phase: 'idle' }));

		await openGear(user);
		expect(gearLabels()).not.toContain('Show scratchpad');
		expect(gearLabels()).not.toContain('Hide scratchpad');
	});
});

describe('AccountPanel, reporting how syncing is going', () => {
	const connected = async (sync: FakeSync, answers: Answers = {}) => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		// Through its first import, as a source that has been connected a while
		// has been: while one is filling it, nothing about syncing is offered.
		await finishImport(db, 'c1');
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
		await statusLine();
		await waitFor(() => {
			expect(sync.listening()).toBe(true);
		});
		return db;
	};

	it('says when it last synced, and syncs when asked', async () => {
		const user = userEvent.setup();
		const at = new Date();
		at.setHours(9, 5, 0, 0);
		const sync = fakeSync({ phase: 'idle', lastSyncAt: at.getTime() });
		await connected(sync);

		const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		expect((await statusLine()).textContent).toBe(`Dropbox · Synced ${time}`);

		await choose(user, 'Sync now');
		expect(sync.syncNow).toHaveBeenCalledTimes(1);
	});

	it('gives the date of a sync that was not today', async () => {
		const at = new Date('2020-02-03T10:00:00');
		await connected(fakeSync({ phase: 'idle', lastSyncAt: at.getTime() }));

		expect((await statusLine()).textContent).toBe(
			`Dropbox · Synced ${at.toLocaleDateString()}`
		);
	});

	it('cannot be asked to sync while it is syncing', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'syncing' });
		await connected(sync);

		const line = await statusLine();
		expect(line.textContent).toBe('Dropbox · Syncing…');
		const menu = await openGear(user);
		expect(
			within(menu).getByRole('button', { name: 'Sync now' }).hasAttribute('disabled')
		).toBe(true);

		sync.say({ phase: 'idle' });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Synced');
		});
		expect(await offered(user, 'Sync now')).toBeTruthy();
	});

	it('counts a long run in its line, with a bar under it, and leaves a short one at syncing', async () => {
		const sync = fakeSync({
			phase: 'syncing',
			progress: { stage: 'uploading', done: 3, total: PROGRESS_FROM - 1 },
		});
		await connected(sync);
		const line = await naming('ada@example.com');
		expect(line.textContent).toBe('Dropbox · Syncing…');
		expect(screen.queryByRole('progressbar')).toBeNull();

		sync.say({
			phase: 'syncing',
			progress: { stage: 'uploading', done: 120, total: 1000, path: 'Work/Plan.md' },
		});
		const thousand = (1000).toLocaleString();
		await waitFor(() => {
			expect(line.textContent).toBe(`Dropbox · Sending 120 of ${thousand}`);
		});
		expect(line.title).toBe(
			`Syncing with Dropbox · ada@example.com\nSending changes to Dropbox: 120 of ${thousand}.\nWork/Plan.md`
		);
		const bar = screen.getByRole('progressbar', { name: 'Sync progress' });
		expect([bar.getAttribute('value'), bar.getAttribute('max')]).toEqual(['120', '1000']);

		// Another device's import, read before any of it is applied.
		sync.say({ phase: 'syncing', progress: { stage: 'receiving', done: 5, total: 30 } });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Receiving 5 of 30');
		});
		expect(line.title).toBe(
			'Syncing with Dropbox · ada@example.com\nReceiving notes from Dropbox: 5 of 30.'
		);

		sync.say({ phase: 'idle' });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Synced');
		});
		expect(screen.queryByRole('progressbar')).toBeNull();
	});

	it('says when syncing is waiting for another tab, over its count, and goes back to the count after', async () => {
		const progress = { stage: 'uploading', done: 120, total: 1000 } as const;
		const sync = fakeSync({ phase: 'syncing', progress });
		await connected(sync);
		const line = await naming('ada@example.com');
		const thousand = (1000).toLocaleString();
		expect(line.textContent).toBe(`Dropbox · Sending 120 of ${thousand}`);

		sync.say({ phase: 'syncing', progress, waiting: true });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Waiting for another tab');
		});
		expect(line.title).toBe(
			'Syncing with Dropbox · ada@example.com\nSyncing is waiting for another tab or window of this app to finish with the notes on this device. If this does not go away, close the app’s other tabs.'
		);

		sync.say({ phase: 'syncing', progress });
		await waitFor(() => {
			expect(line.textContent).toBe(`Dropbox · Sending 120 of ${thousand}`);
		});
	});

	it('counts a re-scan as it finds notes, with a bar that does not know how many until it does', async () => {
		const sync = fakeSync({
			phase: 'syncing',
			progress: { stage: 'scanning', found: 40, done: 0, listing: true },
		});
		await connected(sync);
		const line = await statusLine();
		expect(line.textContent).toBe('Dropbox · Looking for notes: 40 found');
		expect(
			screen.getByRole('progressbar', { name: 'Sync progress' }).hasAttribute('value')
		).toBe(false);

		sync.say({
			phase: 'syncing',
			progress: { stage: 'scanning', found: 40, done: 10, listing: false },
		});
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Receiving 10 of 40');
		});
		const bar = screen.getByRole('progressbar', { name: 'Sync progress' });
		expect([bar.getAttribute('value'), bar.getAttribute('max')]).toEqual(['10', '40']);
	});

	it('says nothing, and offers nothing, before the scheduler has picked the connection up', async () => {
		const user = userEvent.setup();
		await connected(fakeSync({ phase: 'local' }));

		// The line, naming the source, and nothing about how it is going.
		expect((await statusLine()).textContent).toBe('Dropbox');
		expect(screen.getByRole('region', { name: 'Storage' }).querySelectorAll('p')).toHaveLength(
			1
		);
		const menu = await openGear(user);
		expect(within(menu).queryByRole('button', { name: 'Sync now' })).toBeNull();
	});

	it('says when it is offline, and when it is trying again, in a few words with the rest in the tooltip', async () => {
		const sync = fakeSync({ phase: 'offline' });
		await connected(sync);

		const line = await statusLine();
		expect(line.textContent).toBe('Dropbox · Offline');
		// Under who the account is, once the server has said.
		await waitFor(() => {
			expect(line.getAttribute('title')).toBe(
				'Syncing with Dropbox · ada@example.com\nOffline. Changes are kept on this device and sync when the connection is back.'
			);
		});
		// And not said again in the panel: it is not something to deal with.
		expect(screen.queryByText(/^Offline\. Changes are kept on this device/)).toBeNull();

		sync.say({ phase: 'retrying', error: 'dropbox 503: unavailable' });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Trying again shortly');
		});
		expect(line.getAttribute('title')).toBe(
			'Syncing with Dropbox · ada@example.com\nCould not sync with Dropbox. Trying again shortly (dropbox 503: unavailable).'
		);
		expect(screen.queryByText(/^Could not sync with Dropbox/)).toBeNull();
	});

	it('says only that it has stopped in its line, and why above it, where it stays', async () => {
		const sync = fakeSync({ phase: 'attention', error: 'write a.md failed 8 times' });
		await connected(sync);

		const line = await naming('ada@example.com');
		expect(line.textContent).toBe('Dropbox · Not syncing');
		// The tooltip has nothing to add: the whole of it is in the panel.
		expect(line.getAttribute('title')).toBe('Syncing with Dropbox · ada@example.com');
		const why = screen.getByText(
			'Some changes could not be sent to Dropbox. They will be tried again (write a.md failed 8 times).'
		);
		expect(why.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// Dealt with, it goes, and the line says so.
		sync.say({ phase: 'idle' });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Synced');
		});
		expect(screen.queryByText(/could not be sent/)).toBeNull();
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
			const user = userEvent.setup();
			await connected(fakeSync({ phase: 'attention', refusal: 'reauthorize_required' }), {
				config,
			});
			await offered(user, 'Disconnect');

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

	it.each([
		['not_allowed', 'This account is not allowed to sync on this server.'],
		['lapsed', "This account's access to sync on this server has lapsed."],
		['limit_reached', 'This server is at its limit for syncing accounts.'],
	] as const)('says which kind of refusal a %s is', async (code, text) => {
		await connected(
			fakeSync({ phase: 'attention', refusal: 'not_entitled', denial: { code } })
		);

		expect(screen.getByText(text)).toBeTruthy();
	});

	it("says why in the operator's words, and what their gate offers, under a refusal", async () => {
		await connected(
			fakeSync({
				phase: 'attention',
				refusal: 'not_entitled',
				denial: { code: 'lapsed', reason: 'Your plan ended on 3 May.' },
			}),
			{
				config: () =>
					Promise.resolve({
						...STORAGE_FIRST,
						connectGate: {
							message: 'Sync here is part of the paid plan.',
							action: { label: 'Renew', url: 'https://example.com/renew' },
						},
					}),
			}
		);

		expect(
			screen.getByText("This account's access to sync on this server has lapsed.")
		).toBeTruthy();
		const link = await screen.findByRole('link', { name: 'Renew' });
		expect(link.getAttribute('href')).toBe('https://example.com/renew');
		// In this window, as the `+` menu's gate link is.
		expect(link.getAttribute('target')).toBeNull();
		expect(link.getAttribute('rel')).toBe('noreferrer');
		expect(link.parentElement?.textContent).toBe('Your plan ended on 3 May. Renew');
	});

	it('says the reason alone where the instance has no gate, and nothing more where there is neither', async () => {
		await connected(
			fakeSync({
				phase: 'attention',
				refusal: 'not_entitled',
				denial: { reason: 'Not on the list.' },
			})
		);

		expect(screen.getByText('This account cannot sync on this server.')).toBeTruthy();
		expect(screen.getByText('Not on the list.')).toBeTruthy();
		await settled();
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('says a reason only beside the line it explains', async () => {
		// Not while the phase is past it, and not for a provider this build
		// cannot sync, where the line says that instead.
		await connected(
			fakeSync({
				phase: 'idle',
				refusal: 'not_entitled',
				denial: { reason: 'Not on the list.' },
			})
		);
		expect(screen.queryByText('Not on the list.')).toBeNull();
		cleanup();

		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'webdav' });
		renderPanel(
			clientWith({ connection: () => Promise.reject(new TypeError('offline')) }),
			db,
			'/',
			fakeSync({
				phase: 'attention',
				refusal: 'not_entitled',
				denial: { reason: 'Not on the list.' },
			})
		);
		expect(await screen.findByText('This app cannot sync with WebDAV yet.')).toBeTruthy();
		expect(screen.queryByText('Not on the list.')).toBeNull();
	});

	it('does not say an old reason once the refusal is over', async () => {
		const sync = fakeSync({
			phase: 'attention',
			refusal: 'not_entitled',
			denial: { reason: 'Not on the list.' },
		});
		await connected(sync);
		expect(screen.getByText('Not on the list.')).toBeTruthy();

		sync.say({ phase: 'idle' });

		expect(screen.queryByText('Not on the list.')).toBeNull();
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

		// By path, as a link reads, and by id in the entry it opens.
		const link = await screen.findByRole('link', { name: 'Open the note' });
		expect(link.getAttribute('href')).toBe('/#/work/plan');
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
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'webdav' });
		// Done importing, so that the provider is the only reason left, and held,
		// so that the source stays while its menu is looked at.
		await finishImport(db, 'c1');
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.reject(new TypeError('offline')) }),
			db,
			'/',
			fakeSync({ phase: 'attention' })
		);

		expect(await screen.findByText('This app cannot sync with WebDAV yet.')).toBeTruthy();
		const menu = await openGear(user);
		// What syncing offers is there, the re-scan is not.
		expect(within(menu).getByRole('button', { name: 'Sync now' })).toBeTruthy();
		expect(within(menu).queryByRole('button', { name: 'Re-scan from scratch' })).toBeNull();
	});

	it('reads everything again only after saying what that costs', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle' });
		await connected(sync);

		await choose(user, 'Re-scan from scratch');
		expect(screen.getByText(/Read everything in Dropbox again\?/)).toBeTruthy();
		expect(screen.getByText(/are no longer in Dropbox are removed here too/)).toBeTruthy();
		// Asked once: the gear does not offer it again while it is being asked.
		await openGear(user);
		expect(gearLabels()).not.toContain('Re-scan from scratch');
		await user.keyboard('{Escape}');

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(sync.resync).not.toHaveBeenCalled();
		expect(await offered(user, 'Re-scan from scratch')).toBeTruthy();

		await choose(user, 'Re-scan from scratch');
		await user.click(screen.getByRole('button', { name: 'Re-scan' }));

		expect(sync.resync).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/Read everything in Dropbox again\?/)).toBeNull();
	});

	it('cannot be asked to read everything again while it is syncing', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'syncing' });
		await connected(sync);

		const menu = await openGear(user);
		expect(
			within(menu)
				.getByRole('button', { name: 'Re-scan from scratch' })
				.hasAttribute('disabled')
		).toBe(true);
	});

	it('offers no re-scan before the scheduler has picked the connection up', async () => {
		const user = userEvent.setup();
		await connected(fakeSync({ phase: 'local' }));

		await openGear(user);
		// Nothing about syncing at all, and the rest as ever.
		expect(gearLabels()).toEqual([
			'Import a folder',
			'Import files',
			'Hide scratchpad',
			'Disconnect',
		]);
	});

	it('says when a note was edited in two places at once', async () => {
		const sync = fakeSync({ phase: 'idle', conflicts: ['a (conflict 2026-09-16T10-00).md'] });
		await connected(sync);
		expect(screen.getByText(/^A note was edited here and elsewhere at once\./)).toBeTruthy();

		sync.say({ phase: 'idle', conflicts: ['a', 'b'] });
		expect(await screen.findByText(/^2 notes were edited here and elsewhere/)).toBeTruthy();
	});

	describe('files that are not UTF-8 text', () => {
		const file = (path: string, at: number) => ({ remoteId: `id:${String(at)}`, path });

		it('says nothing when there are none', async () => {
			const user = userEvent.setup();
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', { unreadable: [] });

			expect(await offered(user, 'Sync now')).toBeTruthy();
			expect(screen.queryByText(/not UTF-8 text/)).toBeNull();
		});

		it('names the one file, says it is untouched, and says what to do', async () => {
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', { unreadable: [file('Work/old.md', 1)] });

			const notice = await screen.findByText(/not UTF-8 text/);

			expect(notice.textContent).toBe(
				'Work/old.md in Dropbox is not UTF-8 text, so it is left alone: not shown here, not changed. Save it as UTF-8, or delete it, and it will be read.'
			);
			// Where the user is looking, not announced: it is there on every
			// render until they fix the file (`SyncState`).
			expect(notice.getAttribute('role')).toBeNull();
			expect(notice.getAttribute('aria-live')).toBeNull();
			// After the conflicts and above the line the panel ends in, as the rest
			// of what sync has to say is.
			const line = await statusLine();
			expect(
				notice.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();
		});

		it('names a few in order', async () => {
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', {
				unreadable: [file('c.md', 1), file('a.md', 2), file('Work/b.md', 3)],
			});

			expect((await screen.findByText(/not UTF-8 text/)).textContent).toBe(
				'3 files in Dropbox are not UTF-8 text, so they are left alone: a.md, c.md, Work/b.md. Save them as UTF-8, or delete them, and they will be read.'
			);
		});

		it('names five of many and counts the rest', async () => {
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', {
				unreadable: ['g', 'c', 'a', 'h', 'e', 'b', 'f', 'd'].map((name, at) =>
					file(`${name}.md`, at)
				),
			});

			expect((await screen.findByText(/not UTF-8 text/)).textContent).toBe(
				'8 files in Dropbox are not UTF-8 text, so they are left alone: a.md, b.md, c.md, d.md, e.md, … and 3 more. Save them as UTF-8, or delete them, and they will be read.'
			);
		});

		it('says where a note of theirs went when one of them took its name', async () => {
			// Not in the conflicts line above: nothing was edited twice and no copy
			// was made. Here, beside the file that caused it, and for as long as
			// the file is listed — the banner is gone by the time they wonder.
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', {
				unreadable: [{ ...file('a.md', 1), movedAside: ['a (conflict 2026-09-16).md'] }],
			});

			expect((await screen.findByText(/not UTF-8 text/)).textContent).toBe(
				'a.md in Dropbox is not UTF-8 text, so it is left alone: not shown here, not changed. Save it as UTF-8, or delete it, and it will be read. A note of yours had that name; it is now at a (conflict 2026-09-16).md.'
			);
		});

		it('and where each of them went, named once, when there are several', async () => {
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', {
				unreadable: [
					{ ...file('b.md', 1), movedAside: ['b (2).md', 'b (1).md'] },
					{ ...file('a.md', 2), movedAside: ['b (1).md'] },
				],
			});

			expect((await screen.findByText(/not UTF-8 text/)).textContent).toBe(
				'2 files in Dropbox are not UTF-8 text, so they are left alone: a.md, b.md. Save them as UTF-8, or delete them, and they will be read. Notes of yours had those names; they are now at b (1).md, b (2).md.'
			);
		});

		it('puts every path in a <bdi>, so a name cannot reorder the sentence', async () => {
			// A path is the user's text in a sentence of ours. Left bare, one
			// written right-to-left drags the comma after it, or the words around
			// it, to the wrong side and the list reads as another list.
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', {
				unreadable: [{ ...file('a.md', 1), movedAside: ['moved.md'] }, file('b.md', 2)],
			});
			const notice = await screen.findByText(/not UTF-8 text/);

			expect([...notice.querySelectorAll('bdi')].map((each) => each.textContent)).toEqual([
				'a.md',
				'b.md',
				'moved.md',
			]);
			// And one long unbroken name wraps rather than widening the panel.
			expect(notice.classList.contains('wrap-anywhere')).toBe(true);
		});

		it('stops saying so once the list is empty again', async () => {
			const db = await connected(fakeSync({ phase: 'idle' }));
			await db.syncState.update('c1', { unreadable: [file('old.md', 1)] });
			await screen.findByText(/not UTF-8 text/);

			await db.syncState
				.where('connectionId')
				.equals('c1')
				.modify((state) => {
					delete state.unreadable;
				});

			await waitFor(() => {
				expect(screen.queryByText(/not UTF-8 text/)).toBeNull();
			});
		});
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
		expect(await naming('ada@example.com')).toBeTruthy();

		// Another tab connected a second source and switched to it, writing the
		// credential down before the binding as `claimConnection` does.
		await holding(db, 'c2');
		await bindConnection(db, { connectionId: 'c2', provider: 'dropbox', accountId: 'dbid:2' });

		expect(await naming('bob@example.com')).toBeTruthy();
		expect(connection).toHaveBeenCalledTimes(2);
	});

	it('does not ask again about a binding its own answer made', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		const connection = vi.fn<ApiClient['connection']>(() =>
			Promise.resolve({ ok: true, value: dropbox })
		);
		renderPanel(clientWith({ connection }), db);
		expect(await naming('ada@example.com')).toBeTruthy();
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
		await screen.findByText(NOTHING_CONNECTED);
		await waitFor(() => {
			expect(connection).toHaveBeenCalledTimes(1);
		});

		// Another tab comes back from the consent page with a new session and
		// binds, while this tab's question, sent with the old cookie, is out.
		await holding(db, 'c1');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await statusLine();
		first.get('answer')?.({ ok: false, refusal: 'credential_revoked' });

		expect(await naming('ada@example.com')).toBeTruthy();
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

		expect(await naming('ada@example.com')).toBeTruthy();
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
		await statusLine();
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
		expect(await naming('ada@example.com')).toBeTruthy();

		await detachConnection(db, { connectionId: 'c1' });

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
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
		// Not synced, so none of what a live source offers: no line saying how
		// it is going, and no gear with syncing and disconnecting in it.
		expect(screen.queryByRole('button', { name: 'Storage options' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
		expect(screen.queryByTitle(/Syncing with/)).toBeNull();
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

		expect(await statusLine()).toBeTruthy();
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
		// Connecting anything at all is the bar's `+`, not this panel's.
		await screen.findByRole('button', { name: 'Connect another account' });
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
		// Connecting anything at all is the bar's `+`, not this panel's.
		await screen.findByRole('button', { name: 'Connect another account' });
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

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
		// The pile is in front, and is a tab like any other.
		expect((await tab('This device')).getAttribute('aria-current')).toBe('true');
		// The way to connect is the bar's `+`, and it is the same `+` whether
		// this is the first account or the fourth — the panel used to offer
		// "Connect Dropbox" or "Connect another Dropbox account" depending.
		expect(screen.getByRole('button', { name: 'Connect another account' })).toBeTruthy();
		// And the source with no provider is not called "This device" too,
		// which is what naming every provider-less row after the pile would do.
		await user.click(await tab('A source — disconnected'));

		expect(await screen.findByText('A source is disconnected')).toBeTruthy();
		expect(await screen.findByRole('button', { name: 'This device' })).toBeTruthy();
	});

	it('downloads a file never uploaded, with nothing else unsent', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		const plan = await createNote(db, { title: 'Plan' });
		const added = await addAttachment(db, {
			noteId: plan.id,
			name: 'a.png',
			bytes: new TextEncoder().encode('a').buffer,
		});
		// The note is up; the file it links is not.
		await db.notes.update(['c1', plan.id], { remoteId: 'r-plan', dirty: 0 });
		await db.opQueue.filter((op) => op.noteId === plan.id).delete();
		await detachConnection(db, { connectionId: 'c1' });
		const { downloaded, downloadedFiles } = renderPanel(clientWith(), db);

		await user.click(await enabled('Download'));

		await waitFor(() => {
			expect(downloadedFiles).toEqual([[added.path]]);
		});
		expect(downloaded).toEqual([[]]);
	});

	it('says so when a download fails, from either step', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		const { downloaded } = renderPanel(clientWith(), db);
		const failure = 'The notes could not be downloaded. Try again.';
		// The store will not give the bytes up.
		const failing = () =>
			vi.spyOn(db.fileBytes, 'bulkGet').mockRejectedValue(new Error('disk'));
		const failed = failing();

		await user.click(await enabled('Download'));

		expect(await screen.findByText(failure)).toBeTruthy();
		// Tried again and done, it no longer says so.
		failed.mockRestore();
		await user.click(await enabled('Download'));
		await waitFor(() => {
			expect(downloaded).toHaveLength(1);
		});
		expect(screen.queryByText(failure)).toBeNull();
		// And from the discard's second step, where it matters most: a user who
		// thinks they have a copy is a user who discards.
		failing();
		await user.click(await enabled('Discard…'));
		await user.click(await enabled('Download them first'));
		expect(await screen.findByText(failure)).toBeTruthy();
		expect(await db.notes.count()).toBe(2);
	});

	it('says a file never uploaded goes with what is discarded', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		const plan = await createNote(db, { title: 'Plan' });
		await addAttachment(db, {
			noteId: plan.id,
			name: 'a.png',
			bytes: new TextEncoder().encode('a').buffer,
		});
		await detachConnection(db, { connectionId: 'c1' });
		renderPanel(clientWith(), db);

		await user.click(await enabled('Discard…'));

		expect(
			await screen.findByText('Also never sent, and also forgotten: 1 file not uploaded.')
		).toBeTruthy();
	});

	it('downloads the notes that were never sent', async () => {
		const user = userEvent.setup();
		const { db } = await detached();
		const { downloaded } = renderPanel(clientWith(), db);

		await user.click(await enabled('Download'));

		await waitFor(() => {
			expect(downloaded.map((titles) => [...titles].sort())).toEqual([['List', 'Plan']]);
		});
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
		await user.click(await enabled('Download them first'));
		await waitFor(() => {
			expect(downloaded).toHaveLength(1);
		});

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

		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
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
		expect(await statusLine()).toBeTruthy();
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

		await screen.findByText(NOTHING_CONNECTED);
		// Not on the page, and not on the bar's `+`, which belongs to another
		// component: on the first thing the panel now offers, which with the
		// source list and the connect buttons in the tab bar, and the imports
		// in its menu, is the gear.
		const first = await screen.findByRole('button', { name: 'Storage options' });
		await waitFor(() => {
			expect(document.activeElement).toBe(first);
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
		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: 'Disconnect' });
		// Moved there by an effect after the render that shows the question, so
		// waited for: under a loaded full run the question can be found first.
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
		});

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
		// Back on the gear the question was asked from.
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Storage options' })
		);
		expect((await db.syncState.get('c1'))?.detached).toBeUndefined();
	});

	it('offers nowhere to move to while it is the only source', async () => {
		const { db } = await detached();
		renderPanel(clientWith(), db);

		expect(await screen.findByText('Dropbox · ada@example.com is disconnected')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
	});

	it('offers no move where all it holds is a delete the other account has no file for', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await holding(db, 'c1');
		const doomed = await sentNote(db, 'Doomed');
		await deleteNote(db, doomed.id, { connectionId: 'c1' });
		await detachConnection(db, { connectionId: 'c1' });
		await holding(db, 'c2', 'sk1_onedrive');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await showConnection(db, 'c1');
		renderPanel(clientWith(), db);

		expect(await screen.findByRole('button', { name: 'Discard…' })).toBeTruthy();
		// There is a source to move to, and nothing a move could carry there.
		expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();

		// And the discard is still reached by its own name, which says what it is.
		await user.click(screen.getByRole('button', { name: 'Discard…' }));
		expect(await screen.findByText('Discard what this source never sent?')).toBeTruthy();
	});

	it('moves what it never sent into a live source, in two steps', async () => {
		const user = userEvent.setup();
		const { db, plan, list } = await detached();
		await holding(db, 'c2', 'sk1_onedrive');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await showConnection(db, 'c1');
		renderPanel(
			clientWith({
				connection: () =>
					Promise.resolve({
						ok: true,
						value: { ...dropbox, id: 'c2', provider: 'onedrive', accountId: 'ms:1' },
					}),
			}),
			db
		);

		await user.click(await enabled('Move 2 notes to OneDrive · ms:1…'));
		expect(
			await screen.findByText('2 notes will be uploaded to OneDrive · ms:1.')
		).toBeTruthy();
		// Nothing has moved yet: the first button only offers it.
		expect((await noteById(db, plan.id))?.connectionId).toBe('c1');

		await user.click(screen.getByRole('button', { name: 'Move them' }));

		await waitFor(async () => {
			expect(await db.syncState.get('c1')).toBeUndefined();
		});
		expect((await noteById(db, plan.id))?.connectionId).toBe('c2');
		expect((await noteById(db, list.id))?.connectionId).toBe('c2');
		// As new writing in the other account, owed a write apiece.
		expect((await noteById(db, plan.id))?.dirty).toBe(1);
		expect((await noteById(db, plan.id))?.remoteId).toBeUndefined();
		expect(await db.opQueue.where('connectionId').equals('c2').count()).toBe(2);
	});

	it('keeps a note written into since the list was made, and says so', async () => {
		const user = userEvent.setup();
		const { db, plan, list } = await detached();
		await holding(db, 'c2', 'sk1_onedrive');
		await bindConnection(db, { connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		await showConnection(db, 'c1');
		renderPanel(
			clientWith({
				connection: () =>
					Promise.resolve({
						ok: true,
						value: { ...dropbox, id: 'c2', provider: 'onedrive', accountId: 'ms:1' },
					}),
			}),
			db
		);
		await user.click(await enabled('Move 2 notes to OneDrive · ms:1…'));
		await screen.findByRole('button', { name: 'Move them' });

		// Another tab, while the second step was on screen.
		await saveNoteBody(db, plan.id, '# Plan\n\nan hour of work\n', undefined, {
			connectionId: 'c1',
		});
		await user.click(screen.getByRole('button', { name: 'Move them' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(
			/was not on the list, so it has been kept here/
		);
		// The one the list stood for went; the one written into did not, and the
		// source stays around it rather than following it into another account.
		expect((await noteById(db, list.id))?.connectionId).toBe('c2');
		expect((await noteById(db, plan.id))?.connectionId).toBe('c1');
		expect((await noteById(db, plan.id))?.body).toBe('# Plan\n\nan hour of work\n');
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
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
		expect(await statusLine('OneDrive')).toBeTruthy();

		await user.click(await screen.findByRole('button', { name: 'Dropbox — disconnected' }));

		expect(await screen.findByText('Dropbox · ada@example.com is disconnected')).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c1');
		// And back again, from the detached source's own panel.
		expect(await screen.findByRole('button', { name: 'OneDrive' })).toBeTruthy();
	});
});

describe('AccountPanel, asked what becomes of what was never sent', () => {
	const onedrive = {
		...dropbox,
		id: 'c2',
		provider: 'onedrive' as const,
		displayName: 'ada@work.example',
		accountId: 'ms:1',
	};

	/**
	 * Dropbox in front with one unsent note, and another source to move it to.
	 * `more` connects a third, for the case where the user has to be asked which.
	 */
	const withSomewhereToPutIt = async (more = false) => {
		const db = freshDatabase();
		// Each through its first import, as a source that has been connected a
		// while has been.
		const connect = async (input: Parameters<typeof bindConnection>[1]) => {
			await bindConnection(db, input);
			await finishImport(db, input.connectionId);
		};
		await holding(db, 'c2', 'sk1_onedrive');
		await connect({ connectionId: 'c2', provider: 'onedrive', accountId: 'ms:1' });
		if (more) {
			await holding(db, 'c3', 'sk1_gdrive');
			await connect({ connectionId: 'c3', provider: 'gdrive', accountId: 'g:1' });
		}
		await holding(db, 'c1', 'sk1_dropbox');
		await connect({ connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		const unsent = await createNote(db, { title: 'Unsent', body: '# Unsent\n\nonly here\n' });
		return { db, unsent };
	};

	/** Whichever source is in front is the one the credential reaches. */
	const answering = (db: NotesDatabase, answers: Answers = {}) =>
		clientWith({
			connection: async () => ({
				ok: true as const,
				value: (await activeConnectionId(db)) === 'c1' ? dropbox : onedrive,
			}),
			...answers,
		});

	it('offers to move it to the one other source, by the name the list gives it', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		const signOut = vi.fn<ApiClient['signOut']>(() =>
			Promise.resolve({ ok: true, value: { disconnected: false } })
		);
		renderPanel(answering(db, { signOut }), db);

		await choose(user, 'Disconnect');
		await user.click(
			await screen.findByRole('button', { name: 'Move 1 note to OneDrive · ms:1…' })
		);

		// A second step, which says what will be in each account afterwards, and
		// still nothing asked of the server.
		expect(await screen.findByText('1 note will be uploaded to OneDrive · ms:1.')).toBeTruthy();
		expect(signOut).not.toHaveBeenCalled();

		await user.click(screen.getByRole('button', { name: 'Move them' }));

		expect(await statusLine('OneDrive')).toBeTruthy();
		expect(signOut).toHaveBeenCalledTimes(1);
		// The note is in the other account now, as new writing, and Dropbox is gone.
		const landed = await noteById(db, unsent.id);
		expect(landed?.connectionId).toBe('c2');
		expect(landed?.dirty).toBe(1);
		expect(landed?.body).toBe('# Unsent\n\nonly here\n');
		expect(await db.syncState.get('c1')).toBeUndefined();
		expect(await db.credentials.get('c1')).toBeUndefined();
	});

	it('asks which source, where there is more than one it could be', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt(true);
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: /^Move/ });

		const choices = screen.getAllByRole('radio');
		expect(choices.map((choice) => choice.getAttribute('value'))).toEqual(['c2', 'c3']);
		expect(
			screen.getByRole('button', { name: 'Move 1 note to OneDrive · ms:1…' })
		).toBeTruthy();

		await user.click(screen.getByRole('radio', { name: 'Google Drive · g:1' }));
		await user.click(
			await screen.findByRole('button', { name: 'Move 1 note to Google Drive · g:1…' })
		);
		await user.click(await screen.findByRole('button', { name: 'Move them' }));

		await waitFor(async () => {
			expect((await noteById(db, unsent.id))?.connectionId).toBe('c3');
		});
	});

	it('puts the focus on Cancel in the second step, and Escape closes the lot', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: /^Move/ }));
		const step = await screen.findByRole('group', { name: 'Move to another source' });

		// A stray Enter answers no, here as everywhere else.
		expect(document.activeElement).toBe(step.querySelector('button.ghost'));

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: 'Move them' })).toBeNull();
		expect(await offered(user, 'Disconnect')).toBeTruthy();
		expect((await noteById(db, unsent.id))?.connectionId).toBe('c1');
	});

	it('says what it is not moving, and that those files stay where they are', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		// Pushed once and edited since: the older version stays in Dropbox.
		const edited = await sentNote(db, 'Edited');
		await saveNoteBody(db, edited.id, '# Edited\n\nmore\n', undefined, {
			connectionId: 'c1',
		});
		// Deleted here, the delete never sent: Dropbox keeps that file as it is.
		const doomed = await sentNote(db, 'Doomed');
		await deleteNote(db, doomed.id, { connectionId: 'c1' });
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');

		expect(await screen.findByText('2 notes not yet sent · 1 delete')).toBeTruthy();
		expect(
			screen.getByText(
				'Moving takes the notes, not the rest: 1 delete was never sent; Dropbox keeps those files as they are.'
			)
		).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Move 2 notes to OneDrive · ms:1…' }));

		expect(
			await screen.findByText(
				'2 notes will be uploaded to OneDrive · ms:1. 1 of them also exists in Dropbox in an older version, which stays there. 1 delete was never sent; Dropbox keeps those files as they are.'
			)
		).toBeTruthy();
	});

	it('does not mistake a notebook the disconnect itself exposed for one written since', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		// A notebook nothing on the remote has an id for, holding one note the
		// remote has in full and one it has never seen. While the sent note is
		// there the notebook is not unsent — a file cannot be in a directory that
		// does not exist — and so it is not on the list. The disconnect removes
		// that note, and the notebook then reads as unsent, having had nothing
		// done to it.
		await db.folders.put({ connectionId: 'c1', path: 'Ideas', createdAt: 0 });
		const sent = await sentNote(db, 'Sent');
		await db.notes.update(['c1', sent.id], { path: 'Ideas/sent.md' });
		await db.notes.update(['c1', unsent.id], { path: 'Ideas/unsent.md' });
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Discard them…' }));
		await user.click(await screen.findByRole('button', { name: 'Discard for good' }));

		// The whole of it goes. Counted as something written after the list was
		// shown, the source would stay on the device holding an empty notebook
		// and the user would be told their answer had not been carried out.
		expect(await statusLine('OneDrive')).toBeTruthy();
		expect(await db.syncState.get('c1')).toBeUndefined();
		expect(await db.folders.where('connectionId').equals('c1').count()).toBe(0);
		expect(await noteById(db, unsent.id)).toBeUndefined();
	});

	it('names five of many and puts the rest behind a disclosure', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await holding(db, 'c1');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'].reduce<Promise<unknown>>(
			async (made, title) => {
				await made;
				return createNote(db, { title });
			},
			Promise.resolve()
		);
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		const named = await screen.findByRole('list', { name: 'Notes that have not been sent' });

		expect(named.querySelectorAll('li').length).toBe(5);
		expect(screen.getByText('… and 2 more')).toBeTruthy();
		expect(
			screen
				.getByRole('list', { name: 'The rest of the notes that have not been sent' })
				.querySelectorAll('li').length
		).toBe(2);
	});

	it('will not move or discard while a save of this source is failing', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		// An editor holding text the store would not take: the rows are not the
		// whole of what the user wrote, so the list is not the whole of what goes.
		const withdraw = beforeClosing(() => Promise.resolve([JSON.stringify(['c1', unsent.id])]));
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');

		expect((await screen.findByRole('alert')).textContent).toMatch(/could not be saved yet/);
		expect(screen.getByRole('button', { name: /^Move/ }).hasAttribute('disabled')).toBe(true);
		expect(screen.getByRole('button', { name: 'Discard them…' }).hasAttribute('disabled')).toBe(
			true
		);
		// Downloading is still there: it takes nothing away.
		expect(screen.getByRole('button', { name: 'Download them' }).hasAttribute('disabled')).toBe(
			false
		);
		withdraw();
	});

	it('names the account a move writes into by the name the server gave it', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await holding(db, 'c2', 'sk1_onedrive');
		// The server has said what this account is called. An id is what the
		// switcher shows, for reasons of its own; the one confirm that writes
		// into another account has to be readable.
		await bindConnection(db, {
			connectionId: 'c2',
			provider: 'onedrive',
			accountId: 'ms:AAAAB3NzaC1yc2E',
			displayName: 'ada@work.example',
		});
		await holding(db, 'c1', 'sk1_dropbox');
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await createNote(db, { title: 'Unsent' });
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');

		expect(
			await screen.findByRole('button', {
				name: 'Move 1 note to OneDrive · ada@work.example…',
			})
		).toBeTruthy();
	});

	it('offers no move where nothing it moves is on the list', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		// Only a delete, which belongs to the account being left: "Move 0 notes"
		// would be a discard reached through a button that says Move.
		await db.notes.clear();
		const doomed = await sentNote(db, 'Doomed');
		await deleteNote(db, doomed.id, { connectionId: 'c1' });
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');

		expect(await screen.findByRole('button', { name: 'Discard them…' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
		// And nothing about what a move would leave behind, since there is none.
		expect(screen.queryByText(/Moving takes the notes/)).toBeNull();
	});

	it('will not offer a source its files have not been checked against, and says why', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		// Reconnected, and offline ever since, so `verifyResume` has never run.
		// Every row reads as unsent, and the whole library is on the list.
		await sentNote(db, 'One');
		await sentNote(db, 'Two');
		await db.syncState.update('c1', { resumeUnverified: true });
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');

		expect(
			await screen.findByText(
				'Everything this device holds for Dropbox is listed below. This source was connected again and its files have not been checked against Dropbox yet, so nothing here can be told apart from work that was never sent. Most of it is probably already there. Cancel, and connecting again while this device is online settles it.'
			)
		).toBeTruthy();
		// A bulk copy into another account, on a count known to be wrong, is the
		// one thing this must not offer.
		expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
		// The other three are all still there, Cancel included.
		expect(screen.getByRole('button', { name: 'Discard them…' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Download them' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Discard them…' }));

		// And the second step does not promise what it cannot know either.
		expect(
			await screen.findByText(/Most are probably still in Dropbox, but this device has not/)
		).toBeTruthy();
	});

	it('counts a notebook the same way in the headline, the breakdown and the move', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		// A notebook the remote never made, with the unsent note inside it: the
		// notebook goes up with that note and is not a second change to report.
		await db.folders.put({ connectionId: 'c1', path: 'Ideas', createdAt: 0 });
		const rows = await db.notes.where('connectionId').equals('c1').toArray();
		await db.notes.update(['c1', rows[0]?.id ?? ''], { path: 'Ideas/unsent.md' });
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');

		expect(
			await screen.findByText(
				'1 change on this device has not reached Dropbox, and cannot once it is disconnected.'
			)
		).toBeTruthy();
		expect(screen.getByText('1 note not yet sent')).toBeTruthy();
		expect(
			screen.getByRole('button', { name: 'Move 1 note to OneDrive · ms:1…' })
		).toBeTruthy();
	});

	it('counts a file added here and not uploaded, which is lost with the source', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		const sent = await sentNote(db, 'Sent');
		await addAttachment(db, {
			noteId: sent.id,
			name: 'a.png',
			bytes: new TextEncoder().encode('a').buffer,
		});
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');

		expect(
			await screen.findByText('1 note not yet sent · 1 file not yet uploaded')
		).toBeTruthy();
		expect(
			screen.getByText(
				'2 changes on this device have not reached Dropbox, and cannot once it is disconnected.'
			)
		).toBeTruthy();
	});

	it('names an empty notebook an unsent rename left behind, in both steps of the move', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		// A notebook nothing has ever made on the remote, with nothing in it: a
		// change of the user's in its own right, and it goes with the notes.
		await db.folders.put({ connectionId: 'c1', path: 'Empty', createdAt: 0 });
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		expect(await screen.findByText('1 note not yet sent · 1 notebook')).toBeTruthy();

		await user.click(
			screen.getByRole('button', { name: 'Move 1 note and 1 notebook to OneDrive · ms:1…' })
		);

		expect(
			await screen.findByText('1 note and 1 notebook will be uploaded to OneDrive · ms:1.')
		).toBeTruthy();
	});

	it('puts the focus on Cancel in the discard step too, where Escape can reach it', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Discard them…' }));
		const step = await screen.findByRole('group', { name: 'Discard for good' });

		// The button that was pressed went with the step. Left on the page, the
		// focus is nowhere the panel's Escape listener can hear.
		expect(document.activeElement).toBe(step.querySelector('button.ghost'));

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: 'Discard for good' })).toBeNull();
		expect(await offered(user, 'Disconnect')).toBeTruthy();
		expect((await noteById(db, unsent.id))?.connectionId).toBe('c1');
	});

	it('puts the focus back on the Move button when the second step is cancelled', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: /^Move/ }));
		const step = await screen.findByRole('group', { name: 'Move to another source' });
		// The step's own Cancel, which goes back rather than closing the question.
		await user.click(step.querySelector('button.ghost') as HTMLElement);

		const offer = await screen.findByRole('button', { name: /^Move/ });
		expect(document.activeElement).toBe(offer);
	});

	it('keeps a note whose save starts failing while the question is being read', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await screen.findByRole('button', { name: 'Discard them…' });
		// Only now does a save begin failing: the dialog's own guard was computed
		// before the question was asked, and cannot know about this.
		const withdraw = beforeClosing(() => Promise.resolve([JSON.stringify(['c1', unsent.id])]));

		await user.click(screen.getByRole('button', { name: 'Discard them…' }));
		await user.click(await screen.findByRole('button', { name: 'Discard for good' }));

		// The note, and the source around it, are kept rather than removed with
		// the rest: the row is where the text lands once it can be written.
		expect((await screen.findByText(/text that could not be saved/)).getAttribute('role')).toBe(
			'alert'
		);
		expect((await noteById(db, unsent.id))?.connectionId).toBe('c1');
		expect((await db.syncState.get('c1'))?.detached).toBeDefined();
		withdraw();
	});

	it('sends what it can first, and asks anyway when the provider will not answer', async () => {
		// The store is made before the clock is: `fake-indexeddb` keeps its own
		// transactions alive on timers, and one opened under a frozen clock never
		// completes.
		const { db } = await withSomewhereToPutIt();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const sync = fakeSync({ phase: 'idle' });
			// A push that never lands, as a provider that has stopped answering.
			sync.syncNow.mockImplementation(() => new Promise(() => undefined));
			renderPanel(answering(db), db, '/', sync);

			await choose(user, 'Disconnect');
			expect(await screen.findByText('Sending your last changes…')).toBeTruthy();
			expect(sync.syncNow).toHaveBeenCalledTimes(1);
			expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});

			// Ten seconds is the whole of anyone's patience: the question is the
			// same either way, and what the push does land is one thing less on it.
			expect(await screen.findByRole('button', { name: /^Move/ })).toBeTruthy();
			expect(
				screen.getByText(
					'1 change on this device has not reached Dropbox, and cannot once it is disconnected.'
				)
			).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not wait on a push where the source is not syncing anyway', async () => {
		const user = userEvent.setup();
		const { db } = await withSomewhereToPutIt();
		const sync = fakeSync({ phase: 'attention', error: 'boom' });
		renderPanel(answering(db), db, '/', sync);

		await choose(user, 'Disconnect');

		expect(await screen.findByRole('button', { name: /^Move/ })).toBeTruthy();
		expect(sync.syncNow).not.toHaveBeenCalled();
	});

	it('takes an editor open on a moved note with it', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		const shown = await noteById(db, unsent.id);
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: /^Move/ }));
		await user.click(await screen.findByRole('button', { name: 'Move them' }));
		await statusLine('OneDrive');

		// The editor still holds the note as it was under Dropbox, and its key is
		// no longer there. The save follows the row into the other account, which
		// is where the user can now see the note.
		await saveNoteBody(db, unsent.id, '# Unsent\n\nand one more line\n', {
			origin: shown?.bodyOrigin ?? '',
			note: shown!,
		});

		const rows = await db.notes.where('id').equals(unsent.id).toArray();
		expect(rows.map((note) => note.connectionId)).toEqual(['c2']);
		expect(rows[0]?.body).toBe('# Unsent\n\nand one more line\n');
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
		expect(await naming('ada@example.com')).toBeTruthy();

		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));

		expect(await naming('ada@work.example')).toBeTruthy();
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

		// Two accounts at one provider, told apart by a number rather than by
		// the account id the old list used. That is thinner, and deliberately
		// so: the number is stable and short enough for a tab, and renaming is
		// the answer for anyone who needs to know which is which at a glance.
		// The panel below still names the one in front by its account.
		expect(await tab('Dropbox')).toBeTruthy();
		expect(await tab('Dropbox 2')).toBeTruthy();
		// The second is the one bound last, so it is the one showing.
		expect((await tab('Dropbox 2')).getAttribute('aria-current')).toBe('true');
		expect((await tab('Dropbox')).getAttribute('aria-current')).toBeNull();
		expect(await naming('ada@example.com')).toBeTruthy();
	});

	it('offers to connect another account without letting the first go', async () => {
		const user = userEvent.setup();
		const db = await twoSources();
		const { went } = renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db
		);

		await connectVia(user, 'Dropbox');

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
				signOut: () => Promise.reject(new TypeError('offline')),
			}),
			db
		);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
		expect(await offered(user, 'Stop syncing on this device')).toBeTruthy();

		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));
		expect(await statusLine('OneDrive')).toBeTruthy();

		// Dropbox's failure is not OneDrive's. Left on offer, the item would
		// let go of OneDrive — its rows to the device, its cursor gone — while
		// Dropbox, the one the user asked about, stayed live on the server.
		expect(screen.queryByRole('alert')).toBeNull();
		const menu = await openGear(user);
		await within(menu).findByRole('button', { name: 'Disconnect' });
		expect(
			within(menu).queryByRole('button', { name: 'Stop syncing on this device' })
		).toBeNull();
		expect((await db.syncState.get('c2'))?.cursor).toBe('cursor-2');
		expect((await noteById(db, there.id))?.connectionId).toBe('c2');
		expect(await db.syncState.get('c1')).toBeDefined();
	});

	it('keeps the answer to a disconnect for its source, even when it arrives under another', async () => {
		const user = userEvent.setup();
		const db = await twoSources();
		const out: { fail: (error: Error) => void } = { fail: () => undefined };
		const signOut = vi.fn<ApiClient['signOut']>(
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
				signOut,
			}),
			db
		);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));
		expect(await statusLine('OneDrive')).toBeTruthy();

		// Back on Dropbox with its disconnect still out: not one to start again.
		await user.click(await screen.findByRole('button', { name: 'Dropbox' }));
		expect(await statusLine()).toBeTruthy();
		const dropboxMenu = await openGear(user);
		expect(
			within(dropboxMenu).getByRole('button', { name: 'Disconnect' }).hasAttribute('disabled')
		).toBe(true);

		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));
		expect(await statusLine('OneDrive')).toBeTruthy();
		await act(async () => {
			out.fail(new TypeError('offline'));
			await Promise.resolve();
		});
		// Not OneDrive's failure, and not said under its name.
		expect(screen.queryByRole('alert')).toBeNull();
		const oneDriveMenu = await openGear(user);
		await within(oneDriveMenu).findByRole('button', { name: 'Disconnect' });
		expect(
			within(oneDriveMenu).queryByRole('button', { name: 'Stop syncing on this device' })
		).toBeNull();

		// But not lost either: it is there when the user comes back to Dropbox.
		await user.click(await screen.findByRole('button', { name: 'Dropbox' }));
		expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be reached/);
		expect(await offered(user, 'Stop syncing on this device')).toBeTruthy();
		expect(signOut).toHaveBeenCalledTimes(1);

		await choose(user, 'Stop syncing on this device');
		await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
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

		expect(await statusLine()).toBeTruthy();
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
		await statusLine();
		return { db, client };
	};

	const GRANTS = [
		{ id: 'g1', createdAt: 1, lastUsedAt: 1, expired: false, current: true },
		{ id: 'g2', createdAt: 2, lastUsedAt: 2, expired: false, current: false },
	];

	/** The count of the other devices, in the status line, once the server has said it. */
	const counted = (count: number): Promise<HTMLElement> =>
		screen.findByRole('button', {
			name: `${count === 1 ? '1 other device' : `${String(count)} other devices`} signed in on this account`,
		});

	/** Any count of other devices at all. */
	const ANY_COUNT = /^\d+ other devices? signed in on this account$/;

	/** The other devices, opened over everything from their count. */
	const openDevices = async (user: User): Promise<HTMLElement> => {
		await user.click(await screen.findByRole('button', { name: ANY_COUNT }));
		return screen.findByRole('dialog', { name: 'Other devices signed in on this account' });
	};

	it('names the other devices, and asks with this connection’s credential', async () => {
		const user = userEvent.setup();
		const { client } = await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
		});

		const dialog = await openDevices(user);
		const devices = within(dialog).getByRole('list', { name: 'Other devices' });

		// This one is not listed: it cannot be removed from itself, which is
		// what disconnecting is.
		expect(devices.querySelectorAll('li').length).toBe(1);
		expect(screen.queryByText(/This device/)).toBeNull();
		expect(client.asked).toContain('sk1_here');
		expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBe(1);
	});

	it('folds them behind how many there are, which is said either way', async () => {
		const user = userEvent.setup();
		const third = { id: 'g3', createdAt: 3, lastUsedAt: 3, expired: false, current: false };
		await connected({
			grants: () => Promise.resolve({ ok: true, value: [...GRANTS, third] }),
		});

		// In the status line, beside the gear: the count, and not the rows.
		const count = await counted(2);
		expect(count.getAttribute('title')).toBe('2 other devices signed in on this account');
		expect(count.parentElement).toBe((await statusLine()).parentElement);
		expect(
			count.parentElement?.contains(screen.getByRole('button', { name: 'Storage options' }))
		).toBe(true);
		expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

		await user.click(count);
		const dialog = await screen.findByRole('dialog', {
			name: 'Other devices signed in on this account',
		});
		expect(within(dialog).getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
	});

	it('says one other device as one', async () => {
		await connected({ grants: () => Promise.resolve({ ok: true, value: GRANTS }) });
		expect(await counted(1)).toBeTruthy();
	});

	it('opens them over everything, and Close or Escape goes back to the count', async () => {
		const user = userEvent.setup();
		await connected({ grants: () => Promise.resolve({ ok: true, value: GRANTS }) });
		const count = await counted(1);

		await user.click(count);
		const dialog = await screen.findByRole('dialog', {
			name: 'Other devices signed in on this account',
		});
		const close = within(dialog).getByRole('button', { name: 'Close' });
		expect(document.activeElement).toBe(close);
		await user.click(close);

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(count);

		await user.click(count);
		await screen.findByRole('dialog', { name: 'Other devices signed in on this account' });
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(count);
	});

	it('names each by what its browser said it was, and an older one plainly', async () => {
		const user = userEvent.setup();
		const named = { ...GRANTS[1]!, device: 'Safari on iPhone' };
		const older = { id: 'g3', createdAt: 3, lastUsedAt: 3, expired: true, current: false };
		await connected({
			grants: () => Promise.resolve({ ok: true, value: [GRANTS[0]!, named, older] }),
		});

		const rows = within(await openDevices(user))
			.getByRole('list', { name: 'Other devices' })
			.querySelectorAll('li > span');
		expect([...rows].map((row) => row.textContent)).toEqual([
			expect.stringMatching(/^Safari on iPhone, last used /),
			expect.stringMatching(/^A device, last used .* · signed out for being idle$/),
		]);
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
		const dialog = await openDevices(user);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		await waitFor(() => {
			expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();
		});
		expect(revokeGrant).toHaveBeenCalledWith('g2');
		// Left open, saying so, rather than taken away from under the focus; and
		// the count it was opened from has gone with the last of them.
		expect(
			within(dialog).getByText('No other device is signed in on this account.')
		).toBeTruthy();
		expect(screen.queryByRole('button', { name: ANY_COUNT })).toBeNull();

		await user.click(within(dialog).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		// With the count gone, to the gear beside where it was.
		expect(document.activeElement).toBe(await gear());
	});

	it('says so when a device will not go, and leaves the list alone', async () => {
		const user = userEvent.setup();
		await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
			revokeGrant: () => Promise.resolve({ ok: false, refusal: 'not_found' }),
		});
		const dialog = await openDevices(user);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		// Said in the dialog, where it was asked.
		expect((await within(dialog).findByRole('alert')).textContent).toMatch(
			/would not remove it/
		);
		expect(
			within(dialog).getByRole('list', { name: 'Other devices' }).querySelectorAll('li')
				.length
		).toBe(1);
	});

	it.each([
		[
			'answered with a failure',
			() => Promise.reject(new ApiError('DELETE /connection/grants/g2 failed with 500', 500)),
			/The server could not remove that device/,
		],
		[
			'could not be reached',
			() => Promise.reject(new TypeError('offline')),
			/The server cannot be reached, so nothing was removed/,
		],
	] as const)('tells a server that %s from one that did not', async (_, revokeGrant, said) => {
		const user = userEvent.setup();
		await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
			revokeGrant,
		});
		const dialog = await openDevices(user);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		const problem = await screen.findByText(said);
		expect(problem.textContent).not.toMatch(/this device went wrong/);
	});

	it('does not blame the server when the credential could not be read', async () => {
		const user = userEvent.setup();
		const revokeGrant = vi.fn<ApiClient['revokeGrant']>(() =>
			Promise.resolve({ ok: true, value: { ok: true } })
		);
		const { db } = await connected({
			grants: () => Promise.resolve({ ok: true, value: GRANTS }),
			revokeGrant,
		});
		const dialog = await openDevices(user);
		// The credential is read from this device before anything is asked of
		// the server, so this failure is strictly before the revoke.
		//
		// Refused for as long as the click is being answered, rather than once:
		// the panel is not the only reader — `reconcileAccount` and the token
		// source ask for the same credential — and a single rejection is taken
		// by whichever of them asks first, which is a race the test would lose
		// about a third of the time.
		const refused = vi
			.spyOn(db.credentials, 'get')
			.mockImplementation(() => Promise.reject(new Error('the store refused')) as never);

		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

		const problem = await screen.findByText(/on this device went wrong/);
		refused.mockRestore();
		expect(problem.textContent).toMatch(/nothing was removed/);
		expect(problem.textContent).not.toMatch(/server|reach/i);
		expect(revokeGrant).not.toHaveBeenCalled();
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
		expect(await counted(1)).toBeTruthy();

		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));

		// Left alone, the list would still be Dropbox's, under a line naming
		// OneDrive — and pressing Remove would send a grant id this connection
		// has never heard of.
		expect(await counted(2)).toBeTruthy();
		const dialog = await openDevices(user);
		expect(within(dialog).getByRole('list', { name: 'Other devices' }).children.length).toBe(2);
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

		await user.click(await screen.findByRole('button', { name: 'OneDrive' }));
		expect(await counted(2)).toBeTruthy();

		await act(async () => {
			slow.resolve({ ok: true, value: GRANTS });
			await held;
		});

		expect(screen.getByRole('button', { name: ANY_COUNT }).getAttribute('aria-label')).toBe(
			'2 other devices signed in on this account'
		);
		const dialog = await openDevices(user);
		expect(within(dialog).getByRole('list', { name: 'Other devices' }).children.length).toBe(2);
	});

	it('says nothing where this is the only device, or the server cannot be asked', async () => {
		await connected({ grants: () => Promise.resolve({ ok: true, value: [GRANTS[0]!] }) });
		await settled();
		expect(screen.queryByRole('button', { name: ANY_COUNT })).toBeNull();
		expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();

		cleanup();
		await connected({ grants: () => Promise.reject(new TypeError('offline')) });
		await settled();
		expect(screen.queryByRole('button', { name: ANY_COUNT })).toBeNull();
		expect(screen.queryByRole('list', { name: 'Other devices' })).toBeNull();
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

/**
 * In a compact window's source dropdown the panel's actions are the showing
 * source's `⋯`, as each notebook's are, and the panel ends in the status line
 * the sidebar's foot ends in, without the gear (`SourcePanel`'s `account`).
 */
describe('AccountPanel, in the source dropdown of a compact window', () => {
	const onedrive = {
		...dropbox,
		id: 'c2',
		provider: 'onedrive' as const,
		displayName: 'bo@example.com',
		accountId: 'live:bo',
		grantId: 'g2',
	};

	/**
	 * Dropbox showing, and OneDrive beside it, each holding a note, and a server
	 * that answers each credential with its own account.
	 */
	const connected = async (sync: FakeSync, answers: Answers = {}) => {
		const db = freshDatabase();
		await bindConnection(db, {
			connectionId: 'c2',
			provider: 'onedrive',
			accountId: 'live:bo',
		});
		await finishImport(db, 'c2');
		await holding(db, 'c2', 'sk1_c2');
		await createNote(db, { title: 'Elsewhere', connectionId: 'c2' });
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:1' });
		await finishImport(db, 'c1');
		await holding(db, 'c1', 'sk1_c1');
		await createNote(db, { title: 'Kept', connectionId: 'c1' });
		await showConnection(db, 'c1');
		const base = clientWith(answers);
		const client: Client = {
			...base,
			withCredential: (credential: string) =>
				({
					...base.withCredential(credential),
					connection: () =>
						Promise.resolve({
							ok: true,
							value: credential === 'sk1_c2' ? onedrive : dropbox,
						}),
				}) as unknown as ApiClient,
		};
		renderDropdown(client, db, sync);
		await statusLine();
		return db;
	};

	const sources = () => screen.getByRole('region', { name: 'Sources' });

	/** A source's row's `⋯`, once it can be pressed. */
	const rowOptions = async (name: string) => {
		const button = await within(sources()).findByRole('button', {
			name: `Options for “${name}”`,
		});
		await waitFor(() => {
			expect(button.hasAttribute('disabled')).toBe(false);
		});
		return button;
	};

	const openOptions = async (user: ReturnType<typeof userEvent.setup>, name = 'Dropbox') => {
		await user.click(await rowOptions(name));
		return within(await screen.findByRole('group', { name: `Source “${name}”` }));
	};

	/** What the open `⋯` offers, in order. */
	const labels = (name = 'Dropbox') =>
		within(screen.getByRole('group', { name: `Source “${name}”` }))
			.getAllByRole('button')
			.map((button) => button.textContent);

	it('offers syncing, the download and disconnecting in the `⋯` at the end of the showing source’s row', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle' });
		await connected(sync);
		const storage = screen.getByRole('region', { name: 'Storage' });

		const options = await rowOptions('Dropbox');
		// The panel's one button is the gear, which has the same.
		expect(
			within(storage)
				.getAllByRole('button')
				.map((each) => each.getAttribute('aria-label'))
		).toEqual(['Storage options']);
		// On the row, as every notebook's and note's is: the header has only
		// its `+`.
		const row = within(sources()).getByRole('button', { name: 'Dropbox' });
		expect(row.getAttribute('aria-current')).toBe('true');
		expect(options.closest('.row-item')).toBe(row.parentElement);
		const header = sources().querySelector('.pane-header') as HTMLElement;
		expect(
			within(header)
				.getAllByRole('button')
				.map((each) => each.textContent)
		).toEqual(['+']);

		const menu = await openOptions(user);
		await waitFor(() => {
			expect(labels()).toEqual([
				'Rename',
				'Sync now',
				'Re-scan from scratch',
				'Download all notes',
				'Import a folder',
				'Import files',
				'Show clipboard',
				'Hide scratchpad',
				'Disconnect',
			]);
		});
		expect(menu.getByRole('button', { name: 'Disconnect' }).className).toContain('danger');

		await user.click(menu.getByRole('button', { name: 'Sync now' }));
		expect(sync.syncNow).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('group', { name: 'Source “Dropbox”' })).toBeNull();
	});

	it('asks about a re-scan and a disconnect in the panel, once chosen from the `⋯`', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle' });
		await connected(sync);

		await user.click(
			(await openOptions(user)).getByRole('button', { name: 'Re-scan from scratch' })
		);
		expect(screen.getByText(/Read everything in Dropbox again\?/)).toBeTruthy();
		// Asked once: the menu does not offer it again while it is being asked.
		await openOptions(user);
		expect(labels()).not.toContain('Re-scan from scratch');
		await user.keyboard('{Escape}');
		await user.click(screen.getByRole('button', { name: 'Re-scan' }));
		expect(sync.resync).toHaveBeenCalledTimes(1);

		const menu = await openOptions(user);
		await waitFor(() => {
			expect(menu.getByRole('button', { name: 'Disconnect' }).hasAttribute('disabled')).toBe(
				false
			);
		});
		await user.click(menu.getByRole('button', { name: 'Disconnect' }));
		// The note here was never sent, so the question is what becomes of it.
		const storage = within(screen.getByRole('region', { name: 'Storage' }));
		expect(await storage.findByRole('button', { name: 'Download them' })).toBeTruthy();
	});

	it('shows what cannot be chosen while it is syncing, and starts at what can', async () => {
		const user = userEvent.setup();
		await connected(fakeSync({ phase: 'syncing' }));

		// Once the panel knows there is something to download, which it reads.
		await (await openOptions(user)).findByRole('button', { name: 'Download all notes' });
		await user.keyboard('{Escape}');

		const menu = await openOptions(user);
		expect(menu.getByRole('button', { name: 'Sync now' }).hasAttribute('disabled')).toBe(true);
		expect(
			menu.getByRole('button', { name: 'Re-scan from scratch' }).hasAttribute('disabled')
		).toBe(true);
		// Renaming it is never held up by a sync.
		expect(document.activeElement).toBe(menu.getByRole('button', { name: 'Rename' }));
	});

	it('ends in the line the foot of the sidebar ends in, gear and all', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle', lastSyncAt: Date.now() });
		await connected(sync);
		const storage = within(screen.getByRole('region', { name: 'Storage' }));

		const line = await naming('ada@example.com');
		expect(line.textContent).toMatch(/^Dropbox · Synced \d/);
		expect(line.getAttribute('title')).toBe('Syncing with Dropbox · ada@example.com');
		// Said once, in the line: not again as a heading or a sentence over it.
		expect(storage.queryByText(/Syncing with/)).toBeNull();
		expect(storage.queryByText(/^Synced/)).toBeNull();

		// At the line's end, as at the foot of the sidebar (2026-10-07), with
		// what the source's `⋯` has, but its name, which the row is.
		const gear = screen.getByRole('button', { name: 'Storage options' });
		expect(gear.parentElement?.parentElement).toBe(line.parentElement);
		await user.click(gear);
		await waitFor(() => {
			expect(gearLabels()).toEqual([
				'Sync now',
				'Re-scan from scratch',
				'Download all notes',
				'Import a folder',
				'Import files',
				'Show clipboard',
				'Hide scratchpad',
				'Disconnect',
			]);
		});
		await user.keyboard('{Escape}');

		sync.say({ phase: 'offline' });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Offline');
		});
		expect(storage.queryByText(/^Offline\./)).toBeNull();
	});

	it('says how far a long run has got in the line, with the bar under it', async () => {
		const sync = fakeSync({
			phase: 'syncing',
			progress: { stage: 'receiving', done: 25, total: 400 },
		});
		await connected(sync);

		const line = await naming('ada@example.com');
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox · Receiving 25 of 400');
		});
		expect(line.getAttribute('title')).toBe(
			'Syncing with Dropbox · ada@example.com\nReceiving notes from Dropbox: 25 of 400.'
		);
		expect(screen.queryByText('Receiving notes from Dropbox: 25 of 400.')).toBeNull();
		const bar = screen.getByRole('progressbar', { name: 'Sync progress' });
		expect([bar.getAttribute('value'), bar.getAttribute('max')]).toEqual(['25', '400']);

		sync.say({ phase: 'idle' });
		await waitFor(() => {
			expect(screen.queryByRole('progressbar')).toBeNull();
		});
	});

	it('offers another source’s actions on its own row, and shows that source to do them', async () => {
		const user = userEvent.setup();
		const db = await connected(fakeSync({ phase: 'idle' }));

		await openOptions(user, 'OneDrive');
		await waitFor(() => {
			expect(labels('OneDrive')).toEqual([
				'Rename',
				'Sync now',
				'Re-scan from scratch',
				'Download all notes',
				'Disconnect',
			]);
		});

		// Showing it is what syncs it: the scheduler syncs the source in front.
		await user.click(screen.getByRole('button', { name: 'Sync now' }));
		await waitFor(async () => {
			expect(await activeConnectionId(db)).toBe('c2');
		});
		expect(await statusLine('OneDrive')).toBeTruthy();
	});

	it('counts the other devices in the line, and opens them over everything', async () => {
		const user = userEvent.setup();
		const here = { id: 'g1', createdAt: 1, lastUsedAt: 1, expired: false, current: true };
		const other = { id: 'g2', createdAt: 2, lastUsedAt: 2, expired: false, current: false };
		const grants = vi
			.fn<ApiClient['grants']>()
			.mockResolvedValueOnce({ ok: true, value: [here, other] })
			.mockResolvedValue({ ok: true, value: [here] });
		await connected(fakeSync({ phase: 'idle' }), { grants });

		// Beside the words, as at the foot of the sidebar, and not as rows.
		const count = await screen.findByRole('button', {
			name: '1 other device signed in on this account',
		});
		expect(count.parentElement).toBe((await statusLine()).parentElement);
		expect(screen.queryByText(/other devices? signed in/)).toBeNull();
		expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

		await user.click(count);
		const dialog = await screen.findByRole('dialog', {
			name: 'Other devices signed in on this account',
		});
		// Pressed inside it, the dropdown under it stays open.
		await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
		await waitFor(() => {
			expect(
				within(dialog).getByText('No other device is signed in on this account.')
			).toBeTruthy();
		});
		expect(screen.queryByRole('button', { name: /other devices? signed in/ })).toBeNull();

		await user.click(within(dialog).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		// With the count gone, to the gear beside it.
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Storage options' })
		);
	});

	it('puts the focus back on whichever menu a question was asked from', async () => {
		const user = userEvent.setup();
		await connected(fakeSync({ phase: 'idle' }));
		const gear = screen.getByRole('button', { name: 'Storage options' });
		const storage = within(screen.getByRole('region', { name: 'Storage' }));

		await user.click(gear);
		const items = within(await screen.findByRole('group', { name: 'Storage' }));
		await waitFor(() => {
			expect(items.getByRole('button', { name: 'Disconnect' }).hasAttribute('disabled')).toBe(
				false
			);
		});
		// The question is drawn again once it has counted what is unsent, so
		// its Cancel is pressed only once that has come.
		await user.click(items.getByRole('button', { name: 'Disconnect' }));
		await storage.findByRole('button', { name: 'Download them' });
		await user.click(storage.getByRole('button', { name: 'Cancel' }));
		expect(document.activeElement).toBe(gear);

		const menu = await openOptions(user);
		await user.click(menu.getByRole('button', { name: 'Disconnect' }));
		await storage.findByRole('button', { name: 'Download them' });
		await user.click(storage.getByRole('button', { name: 'Cancel' }));
		expect(document.activeElement).toBe(await rowOptions('Dropbox'));
	});

	it('says Google Drive hides what the app did not put in its folder, from the `⋯`', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const gdrive = { ...dropbox, provider: 'gdrive' as const, accountId: 'g-sub' };
		await bindConnection(db, { connectionId: 'c1', provider: 'gdrive' });
		await holding(db, 'c1');
		renderDropdown(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: gdrive }) }),
			db
		);

		expect(await statusLine('Google Drive')).toBeTruthy();
		const summary = UNSEEN_AT_PROVIDER.gdrive?.summary ?? '';
		const detail = UNSEEN_AT_PROVIDER.gdrive?.detail ?? '';
		// Not in the panel: in the source's `⋯`, before the way to let it go.
		expect(screen.queryByText(summary)).toBeNull();
		expect(screen.queryByText(detail)).toBeNull();
		const options = await rowOptions('Google Drive');
		await user.click(options);
		await waitFor(() => {
			expect(labels('Google Drive')).toEqual(['Rename', 'About Google Drive', 'Disconnect']);
		});

		await user.click(screen.getByRole('button', { name: 'About Google Drive' }));

		const dialog = await screen.findByRole('dialog', { name: summary });
		expect(within(dialog).getByText(detail)).toBeTruthy();
		await user.click(within(dialog).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(options);
	});

	it('asks another source’s questions in its own panel, once it is showing', async () => {
		const user = userEvent.setup();
		const db = await connected(fakeSync({ phase: 'idle' }));

		await openOptions(user, 'OneDrive');
		await user.click(screen.getByRole('button', { name: 'Re-scan from scratch' }));
		expect(await screen.findByText(/Read everything in OneDrive again\?/)).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c2');

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await openOptions(user, 'Dropbox');
		await user.click(screen.getByRole('button', { name: 'Disconnect' }));
		// Dropbox is showing now, in a panel of its own, and asks about the note
		// it never sent.
		await waitFor(async () => {
			expect(await activeConnectionId(db)).toBe('c1');
		});
		expect(await screen.findByRole('button', { name: 'Download them' })).toBeTruthy();
		expect(
			within(screen.getByRole('region', { name: 'Storage' })).getByText('Kept')
		).toBeTruthy();
	});

	it('points at the `+` above with nothing connected, and has the download in the `⋯`', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		renderDropdown(clientWith(), db);

		expect(await screen.findByText(CONNECT_ABOVE)).toBeTruthy();
		// The line the sidebar's foot ends in, and its gear, which has what
		// can be done here before there is a note to give the device a row.
		expect(screen.getByText(NOTHING_CONNECTED)).toBeTruthy();
		await settled();
		await openGear(user);
		expect(gearLabels()).toEqual(['Import a folder', 'Import files', 'Hide scratchpad']);
		await user.keyboard('{Escape}');

		await createNote(db, { title: 'Loose' });
		const options = await rowOptions('This device');
		await user.click(options);
		await screen.findByRole('group', { name: 'Source “This device”' });
		expect(labels('This device')).toEqual([
			'Download all notes',
			'Import a folder',
			'Import files',
			'Hide scratchpad',
		]);
	});
});
