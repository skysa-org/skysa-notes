import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../src/api/client.js';
import {
	bindConnection,
	detachConnection,
	finishImport,
	showConnection,
} from '../src/store/connection.js';
import { hashCredential } from '../src/store/credentials.js';
import {
	ACTIVE_CONNECTION_KEY,
	activeConnectionId,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	PENDING_CREDENTIAL_ID,
} from '../src/store/db.js';
import { addAttachment } from '../src/store/files.js';
import { beforeClosing } from '../src/store/heldEdits.js';
import { createNote, deleteNote, saveNoteBody } from '../src/store/notes.js';
import { noteById } from './noteRows.js';
import {
	type Answers,
	backFromConsent,
	choose,
	clientWith,
	dropbox,
	enabled,
	fakeSync,
	holding,
	NOTHING_CONNECTED,
	offered,
	renderPanel,
	sentNote,
	statusLine,
	tab,
} from './support/accountPanel.js';
import { freshDatabase } from './support/db.js';

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

	it('discards in two steps: the first only lists what would go, Cancel first', async () => {
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
		// Asked as every question is: Cancel first, and the answer, which has the focus.
		const asked = screen.getByRole('group', { name: 'Discard for good' });
		expect(
			within(asked)
				.getAllByRole('button')
				.map((button) => button.textContent)
		).toEqual(['Cancel', 'Download them first', 'Discard for good']);
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Discard for good' })
		);
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
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Disconnect' }));
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

	it('puts the focus on Move them in the second step, and Escape is its Cancel', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: /^Move/ }));
		const step = await screen.findByRole('group', { name: 'Move to another source' });

		// The answer has the focus, here as everywhere else, after Cancel.
		expect(
			within(step)
				.getAllByRole('button')
				.map((button) => button.textContent)
		).toEqual(['Cancel', 'Move them']);
		expect(document.activeElement).toBe(
			within(step).getByRole('button', { name: 'Move them' })
		);

		// Back a step, as its Cancel goes; and again, out of the question.
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('button', { name: 'Move them' })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Move/ }));
		await user.keyboard('{Escape}');

		expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
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

	it('puts the focus on the discard step’s answer too, where Escape can reach it', async () => {
		const user = userEvent.setup();
		const { db, unsent } = await withSomewhereToPutIt();
		renderPanel(answering(db), db);

		await choose(user, 'Disconnect');
		await user.click(await screen.findByRole('button', { name: 'Discard them…' }));
		const step = await screen.findByRole('group', { name: 'Discard for good' });

		// The button that was pressed went with the step. Left on the page, the
		// focus is nowhere the question's Escape listener can hear.
		expect(document.activeElement).toBe(
			within(step).getByRole('button', { name: 'Discard for good' })
		);

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
		await user.click(within(step).getByRole('button', { name: 'Cancel' }));

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
