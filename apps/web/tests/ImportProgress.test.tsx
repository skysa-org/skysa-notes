import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiClient, type Result } from '../src/api/client.js';
import { CommandsProvider } from '../src/commands/context.js';
import { ImportDialog, importMessage, ImportPanel } from '../src/components/ImportProgress.js';
import { bindConnection } from '../src/store/connection.js';
import {
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NotesDatabase,
	type SyncStateRecord,
} from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';
import { type SchedulerStatus } from '../src/sync/scheduler.js';

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const syncing = (progress?: SchedulerStatus['progress']): SchedulerStatus => ({
	phase: 'syncing',
	conflicts: [],
	...(progress === undefined ? {} : { progress }),
});

describe('what an import says', () => {
	it.each([
		[syncing(), 'Getting ready…'],
		[
			syncing({ stage: 'scanning', found: 1240, done: 0, listing: true }),
			`Looking for notes in Dropbox: ${(1240).toLocaleString()} found so far.`,
		],
		[
			syncing({ stage: 'scanning', found: 40, done: 12, listing: false }),
			'Downloading notes from Dropbox: 12 of 40.',
		],
		[syncing({ stage: 'uploading', done: 3, total: 9 }), 'Uploading notes to Dropbox: 3 of 9.'],
		[{ phase: 'idle', conflicts: [] }, 'Finishing…'],
		[
			{ phase: 'offline', conflicts: [] },
			'Offline. The import carries on when the connection is back.',
		],
		[{ phase: 'retrying', conflicts: [] }, 'Could not reach Dropbox. Trying again shortly.'],
	] as const)('%#: %s', (status, said) => {
		expect(importMessage(status, 'Dropbox')).toBe(said);
	});
});

/** A scheduler the test says the status of, and whose hold is recorded. */
const fakeSync = (initial: SchedulerStatus) => {
	const listeners = new Set<(status: SchedulerStatus) => void>();
	const box = { status: initial };
	return {
		status: () => box.status,
		subscribe: (listener: (status: SchedulerStatus) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		halt: vi.fn(() => Promise.resolve(() => undefined)),
		say: (status: SchedulerStatus) => {
			box.status = status;
			act(() => {
				listeners.forEach((listener) => {
					listener(status);
				});
			});
		},
	};
};

const server = (answer: () => Promise<Result<{ revoked: boolean }>>) => {
	const disconnect = vi.fn<ApiClient['disconnect']>(answer);
	return {
		disconnect,
		withCredential: () =>
			({ disconnect }) as unknown as ReturnType<ApiClient['withCredential']>,
	};
};

/** A device used before connecting, part-way through its first import. */
const importing = async (): Promise<{ db: NotesDatabase; source: SyncStateRecord }> => {
	const db = createDatabase(`import-ui-${crypto.randomUUID()}`);
	opened.push(db);
	await createNote(db, { title: 'Mine', body: 'mine\n' });
	await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
	await db.credentials.put({ id: 'c1', credential: 'sk1_c1', provider: 'dropbox', createdAt: 0 });
	const source = await db.syncState.get('c1');
	if (source === undefined) throw new Error('not bound');
	return { db, source };
};

describe('the import dialog', () => {
	it('says what it is doing, with a bar that does not pretend to know until it can', async () => {
		const { db, source } = await importing();
		const sync = fakeSync(syncing({ stage: 'scanning', found: 12, done: 0, listing: true }));
		render(
			<CommandsProvider>
				<ImportDialog source={source} database={db} sync={sync} />
			</CommandsProvider>
		);

		const dialog = screen.getByRole('dialog', { name: 'Connecting Dropbox' });
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(screen.getByRole('status').textContent).toBe(
			'Looking for notes in Dropbox: 12 found so far.'
		);
		const bar = () => screen.getByRole('progressbar', { name: 'Import progress' });
		expect(bar().hasAttribute('value')).toBe(false);
		// Cancel has the focus, as it does everywhere the app asks something.
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

		// Listed: the whole count is known, so the bar is a fraction, and the
		// file it has just read is named beneath it.
		sync.say(
			syncing({ stage: 'scanning', found: 12, done: 3, listing: false, path: 'Work/Plan.md' })
		);

		expect(screen.getByRole('status').textContent).toBe(
			'Downloading notes from Dropbox: 3 of 12.'
		);
		expect(bar().getAttribute('value')).toBe('3');
		expect(bar().getAttribute('max')).toBe('12');
		const file = () => document.querySelector('.import-file');
		expect(file()?.textContent).toBe('Work/Plan.md');

		sync.say(syncing({ stage: 'uploading', done: 2, total: 5, path: 'Loose.md' }));

		expect(screen.getByRole('status').textContent).toBe('Uploading notes to Dropbox: 2 of 5.');
		expect(bar().getAttribute('value')).toBe('2');
		expect(bar().getAttribute('max')).toBe('5');
		expect(file()?.textContent).toBe('Loose.md');

		// A path too long for its line gives way in the middle: its end, which
		// names the file, is kept whole, and the whole of it is there to hover.
		const long = 'Recipes/Weeknight dinners/Lemon chicken with capers and olives.md';
		sync.say(syncing({ stage: 'uploading', done: 3, total: 5, path: long }));

		expect(file()?.getAttribute('title')).toBe(long);
		expect(file()?.querySelector('.import-file-start')?.textContent).toBe(long.slice(0, -24));
		expect(file()?.querySelector('.import-file-end')?.textContent).toBe(long.slice(-24));
	});

	it('cancels, and the device is as it was', async () => {
		const user = userEvent.setup();
		const { db, source } = await importing();
		const sync = fakeSync(syncing());
		const client = server(() => Promise.resolve({ ok: true, value: { revoked: true } }));
		render(
			<CommandsProvider>
				<ImportDialog source={source} database={db} client={client} sync={sync} />
			</CommandsProvider>
		);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(async () => {
			expect(await db.syncState.get('c1')).toBeUndefined();
		});
		expect(sync.halt).toHaveBeenCalledWith('c1');
		expect(client.disconnect).toHaveBeenCalledTimes(1);
		expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(1);
	});

	it('offers to cancel here alone, or to carry on, when the server cannot be reached', async () => {
		const user = userEvent.setup();
		const { db, source } = await importing();
		const client = server(() => Promise.reject(new TypeError('offline')));
		render(
			<CommandsProvider>
				<ImportDialog
					source={source}
					database={db}
					client={client}
					sync={fakeSync(syncing())}
				/>
			</CommandsProvider>
		);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be reached/);
		expect(screen.getByRole('button', { name: 'Keep importing' })).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Cancel here anyway' }));

		await waitFor(async () => {
			expect(await db.syncState.get('c1')).toBeUndefined();
		});
		expect(client.disconnect).toHaveBeenCalledTimes(1);
	});

	it('goes on importing when the user says so', async () => {
		const user = userEvent.setup();
		const { db, source } = await importing();
		const client = server(() => Promise.reject(new TypeError('offline')));
		render(
			<CommandsProvider>
				<ImportPanel
					source={source}
					database={db}
					client={client}
					sync={fakeSync(syncing())}
				/>
			</CommandsProvider>
		);
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await user.click(await screen.findByRole('button', { name: 'Keep importing' }));

		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
		expect((await db.syncState.get('c1'))?.importing).toBeDefined();
	});
});
