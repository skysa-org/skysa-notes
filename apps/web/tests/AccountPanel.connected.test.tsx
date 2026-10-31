import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type ApiClient, ApiError } from '../src/api/client.js';
import type { pickFiles } from '../src/lib/pickFiles.js';
import { bindConnection, finishImport, showConnection } from '../src/store/connection.js';
import { hashCredential } from '../src/store/credentials.js';
import { activeConnectionId, LOCAL_CONNECTION_ID, PENDING_CREDENTIAL_ID } from '../src/store/db.js';
import { ArchiveLimitError } from '../src/store/exportNotes.js';
import { createFolder } from '../src/store/folders.js';
import { createNote } from '../src/store/notes.js';
import { setScratchpadShown } from '../src/store/scratchpad.js';
import { UNSEEN_AT_PROVIDER } from '../src/sync/account.js';
import { noteById } from './noteRows.js';
import {
	backFromConsent,
	choose,
	clientWith,
	dropbox,
	enabled,
	fakeSync,
	gearLabels,
	holding,
	naming,
	NOTHING_CONNECTED,
	offered,
	openGear,
	renderPanel,
	sentNote,
	settled,
	statusLine,
	type User,
} from './support/accountPanel.js';
import { freshDatabase } from './support/db.js';

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
			'Set up vault',
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
				'Import notes',
				'Import to scratchpad',
				'Show clipboard',
				'Hide scratchpad',
				'Set up vault',
				'Disconnect',
			]);
		});
		const menu = within(screen.getByRole('group', { name: 'Storage' }));
		expect(menu.getByRole('button', { name: 'Disconnect' }).className).toContain('danger');
		// None of it is a button in the panel any more: the gear is the one,
		// beside the line's words, which open how syncing is going.
		expect(
			within(screen.getByRole('region', { name: 'Storage' }))
				.getAllByRole('button')
				.map((button) => button.getAttribute('aria-label') ?? button.className)
		).toEqual(['account-status-button', 'Storage options']);

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
		/**
		 * One item of the menu, then a folder or files from the question it asks,
		 * since no browser's picker takes both.
		 */
		const importBy = async (
			user: User,
			item: 'Import notes' | 'Import to scratchpad',
			how: 'Choose folder' | 'Choose files'
		) => {
			await choose(user, item);
			const asked = await screen.findByRole('alertdialog', { name: item });
			await user.click(within(asked).getByRole('button', { name: how }));
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

			await importBy(user, 'Import notes', 'Choose folder');
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

			// Over the page, where it outlives a sources dropdown that has closed.
			const said = await screen.findByText(
				/Imported 1 note\. They go up to Google Drive as it syncs\./
			);
			expect(said.closest("[data-toast-tone='success']")?.getAttribute('role')).toBe(
				'status'
			);
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

			await importBy(user, 'Import notes', 'Choose files');
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

			await importBy(user, 'Import notes', 'Choose folder');

			const said = await screen.findByText(
				'Nothing to import: no notes or files were found.'
			);
			expect(said.closest("[data-toast-tone='warning']")?.getAttribute('role')).toBe('alert');
			expect(screen.queryByRole('alertdialog')).toBeNull();
		});

		it('asks for a folder or files, and picks neither when that is cancelled', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			const { pick, asked } = picker([new File(['# One'], 'one.md')]);
			renderPanel(clientWith(), db, '/', undefined, undefined, undefined, undefined, pick);

			await choose(user, 'Import notes');
			const question = await screen.findByRole('alertdialog', { name: 'Import notes' });
			// By name: the ✕ in the corner says what it is only to a screen reader.
			expect(
				within(question)
					.getAllByRole('button')
					.map((button) => button.getAttribute('aria-label') ?? button.textContent)
			).toEqual(['Close', 'Cancel', 'Choose files', 'Choose folder']);
			await user.click(within(question).getByRole('button', { name: 'Cancel' }));

			expect(screen.queryByRole('alertdialog')).toBeNull();
			expect(asked).toEqual([]);
		});

		it('brings the notes at the top into the scratchpad, with what they link to, and says what stays out', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			const { pick, asked } = picker([
				inFolder('old/milk.md', 'Milk\n\n![](photo.png)\n![](Work/chart.png)\n'),
				inFolder('old/photo.png', 'png'),
				inFolder('old/spare.pdf', 'pdf'),
				inFolder('old/Work/plan.md', '# Plan\n'),
				inFolder('old/Work/chart.png', 'chart'),
				inFolder('old/Work/unused.png', 'unused'),
				inFolder('old/Work/Q3/budget.md', '# Budget\n'),
			]);
			renderPanel(clientWith(), db, '/', undefined, undefined, undefined, undefined, pick);

			await importBy(user, 'Import to scratchpad', 'Choose folder');
			const dialog = await screen.findByRole('alertdialog', {
				name: 'Import into the scratchpad?',
			});
			expect(asked).toEqual([{ folder: true }]);
			expect(dialog.textContent).toContain(
				'1 note and 2 files it links to will be added to the scratchpad'
			);
			expect(dialog.textContent).toContain(
				'Left out: 2 notes are in folders, and only notes at the top come into the scratchpad: Work/plan.md, Work/Q3/budget.md. To bring them in with their folders as notebooks, use Import notes.'
			);
			expect(dialog.textContent).toContain(
				'Left out: 1 file none of these notes links to: spare.pdf.'
			);

			await user.click(within(dialog).getByRole('button', { name: 'Import' }));

			expect(await screen.findByText(/Imported 1 note and 2 files\./)).toBeTruthy();
			const rows = await db.notes.toArray();
			expect(rows.map((note) => note.path)).toEqual(['.scratchpad/milk.md']);
			// The one in a folder in that folder, where the note's link reaches it.
			expect((await db.files.toArray()).map((file) => file.path).sort()).toEqual([
				'.scratchpad/Work/chart.png',
				'.scratchpad/photo.png',
			]);
			expect(await db.folders.toArray()).toEqual([]);
		});

		it('picks any file for the scratchpad, since its notes bring what they link to', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			const { pick, asked } = picker([
				new File(['Milk\n\n![](photo.png)\n'], 'milk.md'),
				new File(['png'], 'photo.png'),
			]);
			renderPanel(clientWith(), db, '/', undefined, undefined, undefined, undefined, pick);

			await importBy(user, 'Import to scratchpad', 'Choose files');

			const dialog = await screen.findByRole('alertdialog', {
				name: 'Import into the scratchpad?',
			});
			expect(asked).toEqual([{}]);
			expect(dialog.textContent).toContain(
				'1 note and 1 file it links to will be added to the scratchpad'
			);
		});

		it('says only notes in folders were found, for a scratchpad import with none at the top', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			const { pick } = picker([inFolder('old/Work/plan.md', '# Plan\n')]);
			renderPanel(clientWith(), db, '/', undefined, undefined, undefined, undefined, pick);

			await importBy(user, 'Import to scratchpad', 'Choose folder');

			expect(
				await screen.findByText(
					/^Nothing to import: no notes were found at the top of what was chosen\. Left out: 1 note is in a folder/
				)
			).toBeTruthy();
			expect(screen.queryByRole('alertdialog')).toBeNull();
		});

		it('offers the import into the scratchpad only while the scratchpad is shown', async () => {
			const user = userEvent.setup();
			const db = freshDatabase();
			await setScratchpadShown(db, LOCAL_CONNECTION_ID, false);
			renderPanel(clientWith(), db);
			await settled();

			await openGear(user);
			expect(gearLabels()).toEqual(['Import notes', 'Show scratchpad']);
			await user.click(screen.getByRole('button', { name: 'Show scratchpad' }));

			await openGear(user);
			await waitFor(() => {
				expect(gearLabels()).toEqual([
					'Import notes',
					'Import to scratchpad',
					'Hide scratchpad',
				]);
			});
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
			expect(within(menu).queryByRole('button', { name: 'Import notes' })).toBeNull();
			expect(within(menu).queryByRole('button', { name: 'Import to scratchpad' })).toBeNull();
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
		// The answer, as in every question the app asks.
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Disconnect' }));
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
