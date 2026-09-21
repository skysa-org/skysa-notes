import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeletedNotice, UNDO_WINDOW_MS } from '../src/components/DeletedNotice.js';
import { routeTree } from '../src/routeTree.gen.js';
import { bindConnection, detachConnection } from '../src/store/connection.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, getNote, purgeNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';

/**
 * Delete is one click and asks nothing, so the way back is the whole of its
 * safety — and it has to work for as long as it is offered, which is longer
 * than the tombstone lasts once sync is pushing.
 */

afterEach(async () => {
	cleanup();
	vi.useRealTimers();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
	await db.credentials.clear();
});

const openApp = async (...titles: string[]) => {
	await setDefaultEditorMode(db, 'raw');
	await createFolder(db, { parentPath: undefined, name: 'Work' });
	const notes = await Promise.all(
		titles.map((title) =>
			createNote(db, { folderPath: 'Work', title, body: `${title} body\n` })
		)
	);
	await db.opQueue.clear();
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
	return { notes, router };
};

const openAndDelete = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
	await user.click(await screen.findByRole('button', { name: new RegExp(title) }));
	await screen.findByDisplayValue(title);
	await user.click(screen.getByRole('button', { name: 'Delete' }));
	return screen.findByRole('status');
};

const opsFor = async (id: string) =>
	(await db.opQueue.where('noteId').equals(id).toArray()).map((op) => op.op);

describe('deleting a note', () => {
	it('says so, offers the way back, and leaves focus where it was', async () => {
		const user = userEvent.setup();
		const { notes } = await openApp('Alpha');

		const notice = await openAndDelete(user, 'Alpha');

		expect(notice.textContent).toContain('Deleted “Alpha”.');
		expect(within(notice).getByRole('button', { name: 'Undo' })).toBeTruthy();
		expect(notice.contains(document.activeElement)).toBe(false);
		// Above the panes, not among them: see `app-shell`'s three columns.
		expect(notice.closest('.app-shell')).toBeNull();
		expect((await getNote(db, notes[0]?.id ?? ''))?.deletedLocally).toBe(1);
	});

	it('brings the same note back, open, when undone before the delete has been sent', async () => {
		const user = userEvent.setup();
		const { notes, router } = await openApp('Alpha');
		const id = notes[0]?.id ?? '';
		const notice = await openAndDelete(user, 'Alpha');
		expect(await opsFor(id)).toEqual(['delete']);

		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		expect(await screen.findByDisplayValue('Alpha')).toBeTruthy();
		expect(router.state.location.search).toMatchObject({ note: id });
		expect((await getNote(db, id))?.deletedLocally).toBe(0);
		// The delete is withdrawn rather than left to run behind the restore.
		expect(await opsFor(id)).toEqual(['write']);
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('brings it back with its text after sync has pushed the delete and purged the row', async () => {
		const user = userEvent.setup();
		const { notes } = await openApp('Alpha');
		const id = notes[0]?.id ?? '';
		const notice = await openAndDelete(user, 'Alpha');
		await db.opQueue.clear();
		await purgeNote(db, id);

		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		expect(await screen.findByDisplayValue('Alpha')).toBeTruthy();
		const back = await getNote(db, id);
		expect(back?.body).toBe('Alpha body\n');
		expect(back?.dirty).toBe(1);
		expect(back?.remoteId).toBeUndefined();
		expect(await opsFor(id)).toEqual(['write']);
	});

	it('offers only the last delete back, and the first stays deleted', async () => {
		const user = userEvent.setup();
		const { notes } = await openApp('Alpha', 'Beta');
		await openAndDelete(user, 'Alpha');

		await openAndDelete(user, 'Beta');
		await waitFor(() => {
			expect(screen.getAllByRole('status').map((each) => each.textContent)).toEqual([
				'Deleted “Beta”.UndoDismiss',
			]);
		});
		await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' }));

		await screen.findByDisplayValue('Beta');
		const alpha = notes.find((note) => note.title === 'Alpha');
		expect((await getNote(db, alpha?.id ?? ''))?.deletedLocally).toBe(1);
	});

	it('can be undone from the palette, while the notice is up', async () => {
		const user = userEvent.setup();
		const { notes } = await openApp('Alpha');
		await openAndDelete(user, 'Alpha');

		await user.keyboard('{Control>}k{/Control}');
		const palette = await screen.findByRole('dialog', { name: 'Commands' });
		await user.click(within(palette).getByText('Undo delete'));

		await waitFor(async () => {
			expect((await getNote(db, notes[0]?.id ?? ''))?.deletedLocally).toBe(0);
		});
	});

	it('says where it went when its source was disconnected meanwhile, and what can be done there', async () => {
		const user = userEvent.setup();
		const held = (id: string) =>
			db.credentials.put({ id, credential: `sk1_${id}`, provider: 'dropbox', createdAt: 0 });
		await held('c-ada');
		await bindConnection(db, {
			connectionId: 'c-ada',
			provider: 'dropbox',
			accountId: 'dbid:ada',
			displayName: 'ada@example.com',
		});
		const { notes } = await openApp('Alpha');
		const id = notes[0]?.id ?? '';
		// The remote has it, so its delete is owed — which is what keeps the
		// tombstone, and the source, on the device through the disconnect.
		await db.notes.update(['c-ada', id], { remoteId: 'ada:1', dirty: 0 });
		const notice = await openAndDelete(user, 'Alpha');
		// Inside the undo window: another source connected, and Ada's let go.
		await held('c-bob');
		await act(async () => {
			await bindConnection(db, {
				connectionId: 'c-bob',
				provider: 'dropbox',
				accountId: 'dbid:bob',
			});
			await detachConnection(db, { connectionId: 'c-ada' });
		});

		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		// The message itself, not the whole card: a toast carries its own
		// Dismiss, and `textContent` takes that in too.
		const back = await screen.findByRole('alert');
		expect(
			within(back).getByText(
				'“Alpha” is back, in Dropbox · ada@example.com, which is disconnected. Reconnect it, or download the note.'
			)
		).toBeTruthy();
		// In its own source — not Bob's, and not the device's own pile.
		expect(await db.notes.get(['c-ada', id])).toMatchObject({ deletedLocally: 0 });
		expect(await db.notes.where('connectionId').notEqual('c-ada').count()).toBe(0);
	});

	it('can be dismissed', async () => {
		const user = userEvent.setup();
		await openApp('Alpha');
		const notice = await openAndDelete(user, 'Alpha');

		await user.click(within(notice).getByRole('button', { name: 'Dismiss' }));

		expect(screen.queryByRole('status')).toBeNull();
	});
});

describe('the notice of a delete', () => {
	it('goes after its window, and not while the user is reaching for it', () => {
		vi.useFakeTimers();
		const onDismiss = vi.fn();
		render(<DeletedNotice title="Alpha" onUndo={() => undefined} onDismiss={onDismiss} />);

		act(() => {
			vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
		});
		expect(onDismiss).not.toHaveBeenCalled();

		// A button that vanishes as it is reached for is worse than none.
		fireEvent.mouseEnter(screen.getByRole('status'));
		act(() => {
			vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
		});
		expect(onDismiss).not.toHaveBeenCalled();

		fireEvent.mouseLeave(screen.getByRole('status'));
		act(() => {
			vi.advanceTimersByTime(UNDO_WINDOW_MS);
		});
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
