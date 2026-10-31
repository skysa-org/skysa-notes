import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../src/api/client.js';
import { bindConnection, finishImport, showConnection } from '../src/store/connection.js';
import { activeConnectionId, PENDING_CREDENTIAL_ID } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { UNSEEN_AT_PROVIDER } from '../src/sync/account.js';
import { noteById } from './noteRows.js';
import {
	type Answers,
	choose,
	type Client,
	clientWith,
	CONNECT_ABOVE,
	connectVia,
	dropbox,
	type FakeSync,
	fakeSync,
	gearLabels,
	holding,
	naming,
	NOTHING_CONNECTED,
	offered,
	openGear,
	renderDropdown,
	renderPanel,
	settled,
	statusLine,
	tab,
} from './support/accountPanel.js';
import { freshDatabase } from './support/db.js';

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
		// The panel's one button for them is the gear, which has the same,
		// beside the line's words, which open how syncing is going.
		expect(
			within(storage)
				.getAllByRole('button')
				.map((each) => each.getAttribute('aria-label') ?? each.className)
		).toEqual(['account-status-button', 'Storage options']);
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
				'Import notes',
				'Import to scratchpad',
				'Show clipboard',
				'Hide scratchpad',
				'Set up vault',
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
		expect(line.textContent).toMatch(/^Synced \d/);
		expect(line.getAttribute('title')).toBe('Syncing with Dropbox · ada@example.com');
		// Said once, in the line: not again as a heading or a sentence over it.
		expect(storage.queryByText(/Syncing with/)).toBeNull();
		expect(storage.getAllByText(/^Synced/)).toEqual([line.querySelector('button')]);

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
				'Import notes',
				'Import to scratchpad',
				'Show clipboard',
				'Hide scratchpad',
				'Set up vault',
				'Disconnect',
			]);
		});
		await user.keyboard('{Escape}');

		sync.say({ phase: 'offline' });
		await waitFor(() => {
			expect(line.textContent).toBe('Offline');
		});
		expect(storage.queryByText(/^Offline\./)).toBeNull();
	});

	it('says how far a long run has got in the line, with the bar under it', async () => {
		const sync = fakeSync({
			phase: 'syncing',
			progress: { stage: 'receiving', done: 25, total: 400, listing: false },
		});
		await connected(sync);

		const line = await naming('ada@example.com');
		await waitFor(() => {
			expect(line.textContent).toBe('25 of 400 received');
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

	it('opens what a sync is doing from the line there too, and pauses it', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({
			phase: 'syncing',
			progress: { stage: 'receiving', done: 0, total: 0, listing: true },
		});
		await connected(sync);

		await user.click(await screen.findByRole('button', { name: 'Checking…' }));
		const details = await screen.findByRole('dialog', {
			name: 'Syncing with Dropbox · ada@example.com',
		});
		expect(within(details).getByRole('status').textContent).toBe(
			'Checking Dropbox for changes…'
		);
		// Of how many it cannot say yet.
		expect(
			within(details)
				.getByRole('progressbar', { name: 'Sync progress' })
				.hasAttribute('value')
		).toBe(false);
		await user.click(within(details).getByRole('button', { name: 'Pause syncing' }));
		expect(sync.pause).toHaveBeenCalledTimes(1);
	});

	it('opens another source’s vault from its row, once it is showing', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle' });
		const db = await connected(sync);

		await openOptions(user, 'OneDrive');
		await user.click(await screen.findByRole('button', { name: 'Set up vault' }));

		expect(await screen.findByRole('dialog', { name: 'Vault' })).toBeTruthy();
		expect(await activeConnectionId(db)).toBe('c2');
		expect(sync.keyFile.refresh).toHaveBeenCalledWith('c2');
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
				'Set up vault',
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

	it('waits to ask about a re-scan chosen from another source’s `⋯` until that one syncs', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle' });
		const db = await connected(sync);
		// What the scheduler says of the next source to show, before it has
		// begun to sync it.
		sync.say({ phase: 'local' });

		await openOptions(user, 'OneDrive');
		await user.click(screen.getByRole('button', { name: 'Re-scan from scratch' }));
		await waitFor(async () => {
			expect(await activeConnectionId(db)).toBe('c2');
		});
		expect(screen.queryByText(/Read everything in OneDrive again\?/)).toBeNull();

		sync.say({ phase: 'idle' });
		expect(await screen.findByText(/Read everything in OneDrive again\?/)).toBeTruthy();
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
		expect(gearLabels()).toEqual(['Import notes', 'Import to scratchpad', 'Hide scratchpad']);
		await user.keyboard('{Escape}');

		await createNote(db, { title: 'Loose' });
		const options = await rowOptions('This device');
		await user.click(options);
		await screen.findByRole('group', { name: 'Source “This device”' });
		expect(labels('This device')).toEqual([
			'Download all notes',
			'Import notes',
			'Import to scratchpad',
			'Hide scratchpad',
		]);
	});
});
