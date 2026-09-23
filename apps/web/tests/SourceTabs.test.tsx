import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { type ApiClient, type InstanceConfig } from '../src/api/client.js';
import { SourcePanel, SourceTabs } from '../src/components/SourceTabs.js';
import {
	bindConnection,
	connectedSources,
	detachConnection,
	renameSource,
	showConnection,
} from '../src/store/connection.js';
import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { inOrder, tabName } from '../src/sync/account.js';

/**
 * The bar across the top of the app: which set of notes is showing, what the
 * others are called, and the way to another account.
 *
 * A device can hold several storage accounts at once, each its own silo
 * (docs/PLAN.md §6), and a name is the only thing standing between the user
 * and writing into the wrong one.
 */

const STORAGE_FIRST: InstanceConfig = {
	authMode: 'storage-first',
	providers: ['dropbox', 'onedrive'],
};

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`tabs-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

type Client = Pick<ApiClient, 'config' | 'startConnect'>;

const clientWith = (config: () => Promise<InstanceConfig> = () => Promise.resolve(STORAGE_FIRST)) =>
	({
		config,
		startConnect: (_provider: unknown, _hash: unknown, returnTo: string) =>
			Promise.resolve({ ok: true, value: `https://provider.example/go?rt=${returnTo}` }),
	}) as unknown as Client;

/**
 * Bound in sequence, and each with its own instant, because the order of the
 * bar and the numbering in it are both `boundAt`. Two rows written inside one
 * millisecond fall back to the connection id, which is a real rule but not the
 * one these tests are about.
 */
const bindInOrder = async (
	db: NotesDatabase,
	sources: readonly {
		connectionId: string;
		provider: 'dropbox' | 'onedrive';
		accountId: string;
	}[]
) => {
	for (const source of sources) {
		await bindConnection(db, source);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
};

const tabs = (): (string | null)[] =>
	within(screen.getByRole('navigation', { name: 'Sources' }))
		.getAllByRole('button')
		.map((button) => button.textContent);

const show = (db: NotesDatabase, client: Client = clientWith()) =>
	render(<SourceTabs db={db} client={client} returnTo="/" navigate={() => undefined} />);

describe('the source tabs', () => {
	it('says nothing at all until something is connected', async () => {
		const db = freshDatabase();
		show(db);

		// `connectedSources` is a live query, so "nothing yet" and "nothing at
		// all" both start as no bar. Waiting for the query to settle is what
		// tells them apart.
		await waitFor(async () => {
			expect(await connectedSources(db)).toEqual([]);
		});
		expect(screen.queryByRole('navigation', { name: 'Sources' })).toBeNull();
	});

	it('shows the bar for the search it carries even with nothing connected', async () => {
		// The search lives at the end of the bar, and it is the app's, not any
		// source's: a device with nothing connected still has its own notes.
		const db = freshDatabase();
		render(
			<SourceTabs
				db={db}
				client={clientWith(() => Promise.reject(new Error('down')))}
				returnTo="/"
				navigate={() => undefined}
				search={<input type="search" aria-label="Search notes" />}
			/>
		);

		expect(await screen.findByRole('searchbox', { name: 'Search notes' })).toBeDefined();
		await waitFor(async () => {
			expect(await connectedSources(db)).toEqual([]);
		});
		expect(screen.getByRole('searchbox', { name: 'Search notes' })).toBeDefined();
	});

	it('shows one connection as one tab, so the way to a second is where it will always be', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		show(db);

		expect(await screen.findByRole('navigation', { name: 'Sources' })).toBeTruthy();
		expect(tabs()).toEqual(['Dropbox']);
		expect(await screen.findByRole('button', { name: 'Connect another account' })).toBeTruthy();
	});

	it('numbers a second account of the same provider, and leaves the first alone', async () => {
		const db = freshDatabase();
		await bindInOrder(db, [
			{ connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:ada' },
			{ connectionId: 'c2', provider: 'onedrive', accountId: 'live:bo' },
			{ connectionId: 'c3', provider: 'dropbox', accountId: 'dbid:cy' },
		]);
		show(db);

		// Numbered per provider and not across the bar: the OneDrive between
		// them is not "Dropbox 2", and the second Dropbox is.
		await waitFor(() => {
			expect(tabs()).toEqual(['Dropbox', 'OneDrive', 'Dropbox 2']);
		});
	});

	it('gives up a number when the account it was counting against goes', async () => {
		// The trade `tabName` names: a derived number follows the set. Letting
		// the first Dropbox go leaves one Dropbox, which is called "Dropbox"
		// rather than left as a "Dropbox 2" with no 1 in front of it.
		const db = freshDatabase();
		await bindInOrder(db, [
			{ connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:ada' },
			{ connectionId: 'c3', provider: 'dropbox', accountId: 'dbid:cy' },
		]);
		const sources = inOrder(await connectedSources(db));
		expect(sources.map((source) => tabName(source, sources))).toEqual(['Dropbox', 'Dropbox 2']);

		await detachConnection(db, { connectionId: 'c1' });
		const after = inOrder(await connectedSources(db));

		// Nothing was unsent, so the row went with the binding and there is one
		// Dropbox left. It is called "Dropbox": no 2 without a 1 above it.
		expect(after.map((source) => tabName(source, after))).toEqual(['Dropbox']);
	});

	it('marks the one showing, and switches to another when it is pressed', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindInOrder(db, [
			{ connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:ada' },
			{ connectionId: 'c2', provider: 'onedrive', accountId: 'live:bo' },
		]);
		await showConnection(db, 'c1');
		show(db);

		const dropbox = await screen.findByRole('button', { name: 'Dropbox' });
		expect(dropbox.getAttribute('aria-current')).toBe('true');

		await user.click(screen.getByRole('button', { name: 'OneDrive' }));

		await waitFor(async () => {
			const sources = await connectedSources(db);
			expect(sources.find((source) => source.active)?.connectionId).toBe('c2');
		});
	});

	it('turns the tab into its own name when the one showing is pressed again', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await showConnection(db, 'c1');
		show(db);

		await user.click(await screen.findByRole('button', { name: 'Dropbox' }));

		// Selected, not appended to: a rename is nearly always a replacement.
		const field = screen.getByRole('textbox', { name: 'Rename Dropbox' });
		await user.keyboard('Work');
		await user.keyboard('{Enter}');

		await waitFor(async () => {
			expect((await db.syncState.get('c1'))?.label).toBe('Work');
		});
		expect(field.isConnected).toBe(false);
		expect(await screen.findByRole('button', { name: 'Work' })).toBeTruthy();
	});

	it('puts the field in the tab\u2019s own box rather than a box of its own', async () => {
		// jsdom lays nothing out, so the width cannot be measured here. What
		// can be pinned is the structure the sizing rests on: the field wears
		// the tab\u2019s classes, so it has the tab\u2019s padding, type and lit
		// edge, and the input inside it is the thing with no box at all.
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await showConnection(db, 'c1');
		show(db);

		await user.click(await screen.findByRole('button', { name: 'Dropbox' }));

		const field = screen.getByRole('textbox', { name: 'Rename Dropbox' });
		const box = field.parentElement;
		expect(box?.className).toContain('source-tab');
		expect(box?.className).toContain('source-tab-active');
		expect(box?.className).toContain('source-tab-editing');
		expect(field.className).toBe('source-tab-rename');
	});

	it('leaves the name alone when the rename is abandoned', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await showConnection(db, 'c1');
		show(db);

		await user.click(await screen.findByRole('button', { name: 'Dropbox' }));
		await user.keyboard('Work');
		await user.keyboard('{Escape}');

		await waitFor(() => {
			expect(screen.queryByRole('textbox')).toBeNull();
		});
		expect((await db.syncState.get('c1'))?.label).toBeUndefined();
		expect(screen.getByRole('button', { name: 'Dropbox' })).toBeTruthy();
	});

	it('does not offer to rename the device’s own pile, which is not a connection', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createNote(db, { title: 'Written before anything was connected' });
		show(db);

		const pile = await screen.findByRole('button', { name: 'This device' });
		expect(pile.getAttribute('aria-current')).toBe('true');

		await user.click(pile);

		// No row to write a name onto, so no field — rather than a rename that
		// looks as though it worked and is gone on the next render.
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('says which source syncs nowhere, in words and not only in colour', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await createNote(db, { connectionId: 'c1', title: 'Never sent' });
		await detachConnection(db, { connectionId: 'c1' });
		show(db);

		await waitFor(() => {
			expect(tabs()).toEqual(['Dropbox — disconnected']);
		});
	});

	it('offers the providers this deployment has, and nothing when it cannot ask', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		show(db);

		await user.click(await screen.findByRole('button', { name: 'Connect another account' }));

		const menu = within(await screen.findByRole('group', { name: 'Storage providers' }));
		expect(menu.getByRole('button', { name: 'Dropbox' })).toBeTruthy();
		expect(menu.getByRole('button', { name: 'OneDrive' })).toBeTruthy();
	});

	it('offers the way to connect before there is anything to switch between', async () => {
		// The bar is the only place a connection is made now — the storage
		// panel gave that up — so it cannot wait for a first account to appear
		// before it does.
		const db = freshDatabase();
		show(db);

		expect(await screen.findByRole('button', { name: 'Connect another account' })).toBeTruthy();
		expect(
			within(screen.getByRole('navigation', { name: 'Sources' })).queryAllByRole('button')
		).toHaveLength(0);
	});

	it('does not call a source of unknown provider "This device" as well', async () => {
		// A save landing after the connection went brings a row back with no
		// provider on it (`ensureDetached`). It is not the pile — it holds an
		// account's work and can be reconnected — and two tabs of one name is
		// the state a bar of names exists to prevent.
		const db = freshDatabase();
		await createNote(db, { title: 'Mine' });
		await db.syncState.put({
			connectionId: 'c-gone',
			clientId: 'client',
			detached: { at: 1, reason: 'interrupted' },
		});
		await createNote(db, { connectionId: 'c-gone', title: 'Late' });
		show(db);

		await waitFor(() => {
			expect(tabs()).toEqual(['A source — disconnected', 'This device']);
		});
	});

	it('names a tab the same way to a screen reader as it does on the screen', async () => {
		// The name from contents is not simply the text of the two spans: it
		// joins them by its own rules, and "A source" plus " — disconnected"
		// came out as something no caller could predict. Said outright now.
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await createNote(db, { connectionId: 'c1', title: 'Never sent' });
		await detachConnection(db, { connectionId: 'c1' });
		show(db);

		const found = await screen.findByRole('button', { name: 'Dropbox — disconnected' });
		expect(found.textContent).toBe('Dropbox — disconnected');
	});

	it('offers nothing to connect when the server cannot be asked', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		show(
			db,
			clientWith(() => Promise.reject(new TypeError('offline')))
		);

		// The tabs still work: they are read from this device, and switching
		// between what is already here needs no server at all.
		expect(await screen.findByRole('button', { name: 'Dropbox' })).toBeTruthy();
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Connect another account' })).toBeNull();
		});
	});

	it('keeps a name the user chose when another source is let go', async () => {
		// The pin `tabName` promises: a derived name follows the set, a chosen
		// one does not.
		const db = freshDatabase();
		await bindInOrder(db, [
			{ connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:ada' },
			{ connectionId: 'c3', provider: 'dropbox', accountId: 'dbid:cy' },
		]);
		await renameSource(db, 'c3', 'Work');

		const sources = inOrder(await connectedSources(db));
		expect(sources.map((source) => tabName(source, sources))).toEqual(['Dropbox', 'Work']);
	});

	it('puts the derived name back when a chosen one is cleared', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await renameSource(db, 'c1', 'Work');

		await renameSource(db, 'c1', '   ');

		expect((await db.syncState.get('c1'))?.label).toBeUndefined();
		const sources = await connectedSources(db);
		expect(tabName(sources[0] ?? { connectionId: 'c1' }, sources)).toBe('Dropbox');
	});

	it('refuses to name the pile, which has no row to name', async () => {
		const db = freshDatabase();
		await createNote(db, { title: 'Loose' });

		expect(await renameSource(db, LOCAL_CONNECTION_ID, 'Mine')).toBe(false);
	});
});

describe('the source panel, in a compact window', () => {
	const showPanel = (
		db: NotesDatabase,
		{ client = clientWith(), onChosen = () => undefined } = {}
	) =>
		render(
			<SourcePanel
				db={db}
				client={client}
				returnTo="/"
				navigate={() => undefined}
				account={<section aria-label="Storage">Syncing with Dropbox</section>}
				onChosen={onChosen}
			/>
		);

	const panel = () => screen.getByRole('region', { name: 'Sources' });

	it('lists the sources, then the storage panel, then the way to another account', async () => {
		const db = freshDatabase();
		await bindInOrder(db, [
			{ connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:ada' },
			{ connectionId: 'c2', provider: 'onedrive', accountId: 'live:bo' },
		]);
		await showConnection(db, 'c1');
		showPanel(db);

		const connect = await within(panel()).findByRole('group', {
			name: 'Connect another account',
		});
		// The sources are a live query and the providers the server's answer,
		// so either can arrive first.
		const list = await within(panel()).findByRole('list');
		const [dropbox, onedrive] = within(list).getAllByRole('button');
		expect(dropbox?.textContent).toBe('Dropbox');
		expect(dropbox?.getAttribute('aria-current')).toBe('true');
		expect(onedrive?.textContent).toBe('OneDrive');
		expect(onedrive?.getAttribute('aria-current')).toBeNull();

		// In that order on the page: what is syncing sits between the sources
		// and the way to add another.
		const storage = within(panel()).getByRole('region', { name: 'Storage' });
		expect(
			(onedrive as Node).compareDocumentPosition(storage) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(
			storage.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// Both at the foot of the panel, together (`.source-panel-foot`).
		expect(storage.parentElement).toBe(connect.parentElement);
		expect(storage.parentElement?.classList.contains('source-panel-foot')).toBe(true);
		// A group of its own, so a provider and a source of the same name are
		// not two identical buttons side by side.
		expect(within(connect).getByRole('button', { name: 'Dropbox' })).toBeDefined();
		expect(within(connect).getByRole('button', { name: 'OneDrive' })).toBeDefined();
	});

	it('shows the source chosen, and says it is done', async () => {
		const db = freshDatabase();
		await bindInOrder(db, [
			{ connectionId: 'c1', provider: 'dropbox', accountId: 'dbid:ada' },
			{ connectionId: 'c2', provider: 'onedrive', accountId: 'live:bo' },
		]);
		await showConnection(db, 'c1');
		const user = userEvent.setup();
		let chosen = 0;
		showPanel(db, {
			onChosen: () => {
				chosen += 1;
			},
		});

		const list = await within(panel()).findByRole('list');
		await user.click(await within(list).findByRole('button', { name: 'OneDrive' }));

		expect(chosen).toBe(1);
		await waitFor(async () => {
			const showing = (await connectedSources(db)).find((source) => source.active);
			expect(showing?.connectionId).toBe('c2');
		});
	});

	it('says a disconnected source is disconnected, in words', async () => {
		const db = freshDatabase();
		await bindConnection(db, {
			connectionId: 'c1',
			provider: 'dropbox',
			accountId: 'dbid:ada',
		});
		await createNote(db, { connectionId: 'c1', title: 'Kept', body: 'Kept\n' });
		await detachConnection(db, { connectionId: 'c1' });
		showPanel(db);

		expect(
			await within(panel()).findByRole('button', { name: /— disconnected$/ })
		).toBeDefined();
	});

	it('still holds the storage panel with nothing to connect and nothing connected', () => {
		const db = freshDatabase();
		showPanel(db, { client: clientWith(() => Promise.reject(new Error('down'))) });

		expect(within(panel()).getByRole('region', { name: 'Storage' })).toBeDefined();
	});
});
