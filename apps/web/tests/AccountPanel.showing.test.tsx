import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { t } from '../src/i18n/t.js';
import { bindConnection, finishImport } from '../src/store/connection.js';
import { LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { getScratchpadShown } from '../src/store/scratchpad.js';
import {
	choose,
	clientWith,
	dropbox,
	type FakeSync,
	fakeSync,
	gear,
	gearLabels,
	holding,
	NOTHING_CONNECTED,
	offered,
	openGear,
	renderPanel,
	settled,
	statusLine,
} from './support/accountPanel.js';
import { freshDatabase } from './support/db.js';

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

describe('AccountPanel, secrets for a source', () => {
	const connected = async (sync: FakeSync) => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await finishImport(db, 'c1');
		await holding(db, 'c1');
		renderPanel(
			clientWith({ connection: () => Promise.resolve({ ok: true, value: dropbox }) }),
			db,
			'/',
			sync
		);
		await statusLine();
		return db;
	};

	it('opens the vault from the gear, reading the key file again, and gives the focus back on close', async () => {
		const user = userEvent.setup();
		const sync = fakeSync({ phase: 'idle' });
		await connected(sync);

		await choose(user, 'Set up vault');
		const dialog = await screen.findByRole('dialog', { name: 'Vault' });
		expect(sync.keyFile.refresh).toHaveBeenCalledWith('c1');

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('dialog', { name: 'Vault' })).toBeNull();
		expect(dialog.isConnected).toBe(false);
		expect(document.activeElement).toBe(await gear());
	});

	it('is called what it opens to once the source is set up', async () => {
		const user = userEvent.setup();
		const db = await connected(fakeSync({ phase: 'idle' }));
		await db.keyFiles.put({ connectionId: 'c1', state: 'ok', recipient: 'age1…' });

		await offered(user, 'Vault');
		expect(gearLabels()).not.toContain('Set up vault');
	});

	it('is not offered where nothing syncs the source', async () => {
		const user = userEvent.setup();
		await connected(fakeSync({ phase: 'local' }));
		await openGear(user);
		// From the catalog, so a later rename cannot make this pass for nothing.
		expect(gearLabels()).not.toContain(t('secrets.menu.setUp'));
		expect(gearLabels()).not.toContain(t('secrets.menu.open'));
	});
});
