import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient, InstanceConfig } from '../src/api/client.js';
import { AccountPanel } from '../src/components/account/AccountPanel.js';
import { bindConnection, detachConnection, finishImport } from '../src/store/connection.js';
import { DatabaseProvider } from '../src/store/database.js';
import { createNote } from '../src/store/notes.js';
import { PROGRESS_FROM } from '../src/sync/progress.js';
import { updateNote } from './noteRows.js';
import {
	type Answers,
	backFromConsent,
	choose,
	clientWith,
	dropbox,
	type FakeSync,
	fakeSync,
	gearLabels,
	holding,
	naming,
	NOTHING_CONNECTED,
	offered,
	openGear,
	renderPanel,
	settled,
	statusLine,
	STORAGE_FIRST,
	WithNotices,
} from './support/accountPanel.js';
import { freshDatabase } from './support/db.js';

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
		expect((await statusLine()).textContent).toBe(`Synced ${time}`);

		await choose(user, 'Sync now');
		expect(sync.syncNow).toHaveBeenCalledTimes(1);
	});

	it('cannot be asked to sync while it is syncing', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'syncing' });
		await connected(sync);

		const line = await statusLine();
		expect(line.textContent).toBe('Syncing…');
		const menu = await openGear(user);
		expect(
			within(menu).getByRole('button', { name: 'Sync now' }).hasAttribute('disabled')
		).toBe(true);

		sync.say({ phase: 'idle' });
		await waitFor(() => {
			expect(line.textContent).toBe('Synced');
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
		expect(line.textContent).toBe('Syncing…');
		expect(screen.queryByRole('progressbar')).toBeNull();

		sync.say({
			phase: 'syncing',
			progress: { stage: 'uploading', done: 120, total: 1000, path: 'Work/Plan.md' },
		});
		const thousand = (1000).toLocaleString();
		await waitFor(() => {
			expect(line.textContent).toBe(`120 of ${thousand} sent`);
		});
		expect(line.title).toBe(
			`Syncing with Dropbox · ada@example.com\nSending changes to Dropbox: 120 of ${thousand}.\nWork/Plan.md`
		);
		const bar = screen.getByRole('progressbar', { name: 'Sync progress' });
		expect([bar.getAttribute('value'), bar.getAttribute('max')]).toEqual(['120', '1000']);

		// Another device's import, read before any of it is applied.
		sync.say({
			phase: 'syncing',
			progress: { stage: 'receiving', done: 5, total: 30, listing: false },
		});
		await waitFor(() => {
			expect(line.textContent).toBe('5 of 30 received');
		});
		expect(line.title).toBe(
			'Syncing with Dropbox · ada@example.com\nReceiving notes from Dropbox: 5 of 30.'
		);

		sync.say({ phase: 'idle' });
		await waitFor(() => {
			expect(line.textContent).toBe('Synced');
		});
		expect(screen.queryByRole('progressbar')).toBeNull();
	});

	it('says when syncing is waiting for another tab, over its count, and goes back to the count after', async () => {
		const progress = { stage: 'uploading', done: 120, total: 1000 } as const;
		const sync = fakeSync({ phase: 'syncing', progress });
		await connected(sync);
		const line = await naming('ada@example.com');
		const thousand = (1000).toLocaleString();
		expect(line.textContent).toBe(`120 of ${thousand} sent`);

		sync.say({ phase: 'syncing', progress, waiting: true });
		await waitFor(() => {
			expect(line.textContent).toBe('Waiting for a tab');
		});
		expect(line.title).toBe(
			'Syncing with Dropbox · ada@example.com\nSyncing is waiting for another tab or window of this app to finish with the notes on this device. If this does not go away, close the app’s other tabs.'
		);

		sync.say({ phase: 'syncing', progress });
		await waitFor(() => {
			expect(line.textContent).toBe(`120 of ${thousand} sent`);
		});
	});

	it('counts a re-scan as it finds notes, with a bar that does not know how many until it does', async () => {
		const sync = fakeSync({
			phase: 'syncing',
			progress: { stage: 'scanning', found: 40, done: 0, listing: true },
		});
		await connected(sync);
		const line = await statusLine();
		expect(line.textContent).toBe('40 notes found');
		expect(
			screen.getByRole('progressbar', { name: 'Sync progress' }).hasAttribute('value')
		).toBe(false);

		sync.say({
			phase: 'syncing',
			progress: { stage: 'scanning', found: 40, done: 10, listing: false },
		});
		await waitFor(() => {
			expect(line.textContent).toBe('10 of 40 received');
		});
		const bar = screen.getByRole('progressbar', { name: 'Sync progress' });
		expect([bar.getAttribute('value'), bar.getAttribute('max')]).toEqual(['10', '40']);
	});

	it('says it is checking for changes while it reads them, counting from enough to count', async () => {
		// Reported on a phone: another device's notebooks moved was minutes of
		// plain "Syncing…" while the round's pages were read.
		const sync = fakeSync({
			phase: 'syncing',
			progress: { stage: 'receiving', done: 0, total: 0, listing: true },
		});
		await connected(sync);
		const line = await naming('ada@example.com');
		expect(line.textContent).toBe('Checking…');
		expect(line.title).toBe(
			'Syncing with Dropbox · ada@example.com\nChecking Dropbox for changes…'
		);
		// No bar for a few, which every quiet sync would flash.
		expect(screen.queryByRole('progressbar')).toBeNull();

		sync.say({
			phase: 'syncing',
			progress: { stage: 'receiving', done: 0, total: PROGRESS_FROM, listing: true },
		});
		await waitFor(() => {
			expect(line.textContent).toBe(`${String(PROGRESS_FROM)} changes found`);
		});
		expect(line.title).toBe(
			`Syncing with Dropbox · ada@example.com\nChecking Dropbox for changes: ${String(PROGRESS_FROM)} changed notes found so far.`
		);
		expect(
			screen.getByRole('progressbar', { name: 'Sync progress' }).hasAttribute('value')
		).toBe(false);

		sync.say({
			phase: 'syncing',
			progress: { stage: 'receiving', done: 0, total: 30, listing: false },
		});
		await waitFor(() => {
			expect(line.textContent).toBe('0 of 30 received');
		});
	});

	it('opens what a sync is doing from its line, and pauses it there', async () => {
		// Asked for on a phone: "Syncing…" for a long time, with nothing to say
		// what it was doing and no way to stop it.
		const user = userEvent.setup();
		const sync = fakeSync({
			phase: 'syncing',
			progress: {
				stage: 'receiving',
				done: 120,
				total: 1000,
				listing: false,
				path: 'Work/Plan.md',
			},
		});
		await connected(sync);
		const thousand = (1000).toLocaleString();

		await user.click(
			await screen.findByRole('button', { name: `120 of ${thousand} received` })
		);

		const details = await screen.findByRole('dialog', {
			name: 'Syncing with Dropbox · ada@example.com',
		});
		expect(within(details).getByRole('status').textContent).toBe(
			`Receiving notes from Dropbox: 120 of ${thousand}.`
		);
		const bar = within(details).getByRole('progressbar', { name: 'Sync progress' });
		expect([bar.getAttribute('value'), bar.getAttribute('max')]).toEqual(['120', '1000']);
		expect(details.querySelector('.run-file')?.getAttribute('title')).toBe('Work/Plan.md');
		await user.click(within(details).getByRole('button', { name: 'Pause syncing' }));
		expect(sync.pause).toHaveBeenCalledTimes(1);

		// Paused: said so, and the way back.
		sync.say({ phase: 'paused' });
		const paused = await screen.findByRole('dialog', { name: 'Syncing paused' });
		expect(within(paused).getByRole('status').textContent).toBe(
			'Syncing with Dropbox is paused on this device. Your edits are kept here and sent when it resumes.'
		);
		expect(within(paused).queryByRole('progressbar')).toBeNull();
		await user.click(within(paused).getByRole('button', { name: 'Resume syncing' }));
		expect(sync.syncNow).toHaveBeenCalledTimes(1);

		// Once the run is over, how syncing stands, and the ✕ alone.
		sync.say({ phase: 'idle' });
		const over = await screen.findByRole('dialog', {
			name: 'Syncing with Dropbox · ada@example.com',
		});
		expect(within(over).getByRole('status').textContent).toBe('Synced');
		expect(
			within(over)
				.getAllByRole('button')
				.map((button) => button.getAttribute('aria-label') ?? button.textContent)
		).toEqual(['Close']);
		await user.click(within(over).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('says it is paused, and resumes from the gear as well', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'paused' });
		await connected(sync);

		const line = await naming('ada@example.com');
		expect(line.textContent).toBe('Paused');
		expect(line.title).toBe(
			'Syncing with Dropbox · ada@example.com\nSyncing with Dropbox is paused on this device. Your edits are kept here and sent when it resumes.'
		);
		await choose(user, 'Sync now');
		expect(sync.syncNow).toHaveBeenCalledTimes(1);
	});

	it('says how syncing is going without naming the source, which the dialog it opens names', async () => {
		// The source's name made the line wrap onto a second line and back as
		// its words changed (2026-10-14). The tab above names it; a phone has
		// no tooltip, so the line opens what does, whatever it says.
		const user = userEvent.setup();
		const at = new Date();
		at.setHours(9, 5, 0, 0);
		await connected(fakeSync({ phase: 'idle', lastSyncAt: at.getTime() }));
		const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

		const line = await naming('ada@example.com');
		expect(line.textContent).toBe(`Synced ${time}`);
		await user.click(within(line).getByRole('button', { name: `Synced ${time}` }));

		const details = screen.getByRole('dialog', {
			name: 'Syncing with Dropbox · ada@example.com',
		});
		expect(within(details).getByRole('status').textContent).toBe(`Synced ${time}`);
		expect(
			within(details)
				.getAllByRole('button')
				.map((button) => button.getAttribute('aria-label') ?? button.textContent)
		).toEqual(['Close']);
	});

	it('is one button whatever it says', async () => {
		const sync = fakeSync({ phase: 'idle' });
		await connected(sync);
		const line = await statusLine();
		const button = line.querySelector('button');
		expect(button?.textContent).toBe('Synced');

		sync.say({ phase: 'syncing' });
		await waitFor(() => {
			expect(line.querySelector('button')?.textContent).toBe('Syncing…');
		});
		sync.say({ phase: 'retrying', error: 'timed out' });
		await waitFor(() => {
			expect(line.querySelector('button')?.textContent).toBe('Trying again shortly');
		});
		// The same element, so a focus on it is not lost as its words change.
		expect(line.querySelector('button')).toBe(button);

		// With nothing syncing it, the line is the source's name, with nothing
		// to open, and the source's tab is the one button of that name.
		sync.say({ phase: 'local' });
		await waitFor(() => {
			expect(line.textContent).toBe('Dropbox');
		});
		expect(line.querySelector('button')).toBeNull();
	});

	it('offers no details while a first import holds the source, whose dialog says it all', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await holding(db, 'c1');
		const sync = fakeSync({ phase: 'syncing' });
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db,
			'/',
			sync
		);

		expect((await statusLine()).querySelector('button')).toBeNull();
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
		expect(line.textContent).toBe('Offline');
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
			expect(line.textContent).toBe('Trying again shortly');
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
		expect(line.textContent).toBe('Not syncing');
		// The tooltip has nothing to add: the whole of it is in the panel.
		expect(line.getAttribute('title')).toBe('Syncing with Dropbox · ada@example.com');
		const why = screen.getByText(
			'Some changes could not be sent to Dropbox. They will be tried again (write a.md failed 8 times).'
		);
		expect(why.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// Dealt with, it goes, and the line says so.
		sync.say({ phase: 'idle' });
		await waitFor(() => {
			expect(line.textContent).toBe('Synced');
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
			'Import notes',
			'Import to scratchpad',
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
					<DatabaseProvider db={db}>
						<WithNotices>
							<AccountPanel
								client={clientWith({ connection })}
								sync={fakeSync({ phase: 'local' })}
							/>
						</WithNotices>
					</DatabaseProvider>
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
