/**
 * The account panel under test: a client with the answers a test names, the panel
 * drawn over it, and the steps through its menus, for the `AccountPanel.*.test.tsx`
 * files.
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
	useRouterState,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { expect, vi } from 'vitest';

import type { ApiClient, InstanceConfig } from '../../src/api/client.js';
import { AccountPanel, returnPath } from '../../src/components/account/AccountPanel.js';
import { SourcePanel } from '../../src/components/sources/SourcePanel.js';
import { SourceTabs } from '../../src/components/sources/SourceTabs.js';
import { NoticesProvider, useShownNotices } from '../../src/components/ui/notices.js';
import { Toast } from '../../src/components/ui/Toast.js';
import type { pickFiles } from '../../src/lib/pickFiles.js';
import { beginConnect } from '../../src/store/credentials.js';
import { DatabaseProvider } from '../../src/store/database.js';
import type { NotesDatabase } from '../../src/store/db.js';
import type { Library } from '../../src/store/exportNotes.js';
import { createKeeping, type Keeping } from '../../src/store/keeping.js';
import { createNote } from '../../src/store/notes.js';
import type { SchedulerStatus } from '../../src/sync/scheduler.js';
import { updateNote } from '../noteRows.js';
import { holdCredential } from './connection.js';

export const STORAGE_FIRST: InstanceConfig = { authMode: 'storage-first', providers: ['dropbox'] };

export const dropbox = {
	id: 'c1',
	provider: 'dropbox' as const,
	displayName: 'ada@example.com',
	accountId: 'dbid:1',
	createdAt: 1,
	lastUsedAt: null,
	grantId: 'g1',
};

export type Client = Pick<
	ApiClient,
	'config' | 'withCredential' | 'startConnect' | 'checkConnectCode'
>;

/**
 * What the panel is handed.
 *
 * `withCredential` is the seam every authenticated call goes through now, so a
 * test says what the server answers by naming the answers and letting this
 * assemble a client that gives them whatever credential it is shown.
 */
export interface Answers extends Partial<Client> {
	connection?: ApiClient['connection'];
	grants?: ApiClient['grants'];
	revokeGrant?: ApiClient['revokeGrant'];
	signOut?: ApiClient['signOut'];
}

export const clientWith = (answers: Answers = {}): Client & { asked: string[] } => {
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
export const backFromConsent = (db: NotesDatabase) => beginConnect(db, 'dropbox');

/** A device holding a credential for `connectionId`, as connecting leaves it. */
export const holding = (db: NotesDatabase, connectionId: string, credential = 'sk1_held') =>
	holdCredential(db, connectionId, { credential, createdAt: Date.now() });

/** A button once the user can press it. */
export const enabled = async (name: string): Promise<HTMLElement> => {
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
export const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

export type User = ReturnType<typeof userEvent.setup>;

/**
 * The line a connected source's panel ends in, at the foot of the sidebar and
 * in a compact window's source dropdown alike: the source, and how its syncing
 * is going, with who the account is in its tooltip. Found by that tooltip,
 * which only a connected source's line has.
 */
export const statusLine = (label = 'Dropbox'): Promise<HTMLElement> =>
	screen.findByTitle(new RegExp(`^Syncing with ${label}`));

/**
 * The status line once its tooltip names `account`, which is once the server
 * has answered for it: the line itself has room only for how syncing is going.
 */
export const naming = (account: string): Promise<HTMLElement> =>
	screen.findByTitle(
		(_, element) =>
			element?.getAttribute('title')?.split('\n')[0]?.endsWith(` · ${account}`) === true
	);

/** The gear at the end of the status line, once it has something to offer. */
export const gear = (): Promise<HTMLElement> => enabled('Storage options');

/**
 * The gear's menu, opened, or as it is where it is open already. It follows
 * the panel as it renders, so an item that arrives with a later answer — the
 * notes here counted, the server heard from — arrives in it.
 */
export const openGear = async (user: User): Promise<HTMLElement> => {
	const button = await gear();
	if (button.getAttribute('aria-expanded') !== 'true') await user.click(button);
	return screen.findByRole('group', { name: 'Storage' });
};

/** An item of the gear's menu, opened, once it is offered and can be chosen. */
export const offered = async (user: User, name: string): Promise<HTMLElement> => {
	const item = await within(await openGear(user)).findByRole('button', { name });
	await waitFor(() => {
		expect(item.hasAttribute('disabled')).toBe(false);
	});
	return item;
};

/** `name`, chosen from the gear's menu: which closes the menu, and then acts. */
export const choose = async (user: User, name: string): Promise<void> => {
	await user.click(await offered(user, name));
};

/** What the open gear's menu offers, in order. */
export const gearLabels = (): (string | null)[] =>
	within(screen.getByRole('group', { name: 'Storage' }))
		.getAllByRole('button')
		.map((item) => item.textContent);

/** A scheduler that says what the test tells it to. */
export const fakeSync = (initial: Partial<SchedulerStatus> = {}) => {
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
		pause: vi.fn<() => void>(),
		// Nothing to stop: resolves straight away with a release that does nothing.
		halt: vi.fn(() => Promise.resolve(() => undefined)),
		// The clipboard's own tests are in `ClipboardPanel.test.tsx`; here,
		// only what the panel asks of it.
		clipboard: {
			refresh: vi.fn(() => Promise.resolve()),
			flush: vi.fn(() => Promise.resolve()),
			read: vi.fn(() => Promise.resolve({ state: 'gone' as const })),
		},
		keyFile: {
			refresh: vi.fn(() => Promise.resolve()),
			started: vi.fn(() => Promise.resolve()),
			heard: vi.fn(() => Promise.resolve()),
			write: vi.fn(() => Promise.resolve({ status: 'unavailable' as const })),
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

export type FakeSync = ReturnType<typeof fakeSync>;

/**
 * What the shell does with what the panel keeps over the page (`Notices`):
 * one toast, until it is dismissed.
 */
const Staying = () => {
	const { staying, dismissStaying } = useShownNotices();
	return (
		staying !== null && (
			<Toast message={staying.message} tone={staying.tone} onDismiss={dismissStaying} />
		)
	);
};

export const WithNotices = ({ children }: { children: ReactNode }) => (
	<NoticesProvider>
		{children}
		<Staying />
	</NoticesProvider>
);

/** The panel at `url`, inside a router, since it reads where it is. */
export const renderPanel = (
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
			<DatabaseProvider db={database}>
				<WithNotices>
					<SourceTabs
						client={client}
						returnTo={returnPath(href)}
						navigate={(to) => {
							went.push(to);
							go(to);
						}}
					/>
					<AccountPanel
						client={client}
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
				</WithNotices>
			</DatabaseProvider>
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
export const openAdd = async (user: ReturnType<typeof userEvent.setup>) => {
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
export const connectVia = async (user: ReturnType<typeof userEvent.setup>, provider: string) => {
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
export const tab = async (name: string): Promise<HTMLElement> =>
	within(await screen.findByRole('navigation', { name: 'Sources' })).findByRole('button', {
		name,
	});

/** Nothing is connected: what the line at the foot of the panel says then. */
export const NOTHING_CONNECTED = 'On this device only';

/**
 * Nothing is connected, and something could be: the way to it, as a compact
 * window's source dropdown points at it, its `+` having no words.
 */
export const CONNECT_ABOVE = 'Use + above to connect storage.';

/** A note the remote has in full, as a sync leaves it. */
export const sentNote = async (db: NotesDatabase, title: string) => {
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
export const renderDropdown = (
	client: Client,
	database: NotesDatabase,
	sync: FakeSync = fakeSync({ phase: 'local' })
) => {
	const Shell = () => (
		<DatabaseProvider db={database}>
			<WithNotices>
				<SourcePanel
					client={client}
					returnTo="/"
					navigate={() => undefined}
					account={(slot) => (
						<AccountPanel
							client={client}
							sync={sync}
							navigate={() => undefined}
							download={() => undefined}
							downloadAll={() => undefined}
							keeping={createKeeping(() => undefined)}
							slot={slot}
						/>
					)}
				/>
			</WithNotices>
		</DatabaseProvider>
	);
	const router = createRouter({
		routeTree: createRootRoute({ component: Shell }),
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
};
