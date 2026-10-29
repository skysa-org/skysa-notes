import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeletedNotice, UNDO_WINDOW_MS } from '../src/components/list/DeletedNotice.js';
import { bindConnection, detachConnection, finishImport } from '../src/store/connection.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, getNote, purgeNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { placeIn } from './entry.js';
import { renderApp } from './support/app.js';
import { holdCredential } from './support/connection.js';

/**
 * Delete is one click and asks nothing, so the way back is the whole of its
 * safety — and it has to work for as long as it is offered, which is longer
 * than the tombstone lasts once sync is pushing.
 */

afterEach(() => {
	cleanup();
	vi.useRealTimers();
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
	const router = await renderApp();
	return { notes, router };
};

const openAndDelete = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
	await user.click(await screen.findByRole('button', { name: new RegExp(`^${title}`) }));
	await screen.findByDisplayValue(title);
	// The `⋯` at the end of the note's row.
	await user.click(screen.getByRole('button', { name: `Options for “${title}”` }));
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

	it('names a note with no name by its first words', async () => {
		const user = userEvent.setup();
		await openApp();
		await createNote(db, { folderPath: 'Work', body: 'Pick up the parcel\n' });

		await user.click(await screen.findByRole('button', { name: 'Options for “Untitled”' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		expect((await screen.findByRole('status')).textContent).toContain(
			'Deleted “Pick up the parcel”.'
		);
	});

	it('brings the same note back, open, when undone before the delete has been sent', async () => {
		const user = userEvent.setup();
		const { notes, router } = await openApp('Alpha');
		const id = notes[0]?.id ?? '';
		const notice = await openAndDelete(user, 'Alpha');
		expect(await opsFor(id)).toEqual(['delete']);

		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		expect(await screen.findByDisplayValue('Alpha')).toBeTruthy();
		expect(placeIn(router)).toMatchObject({ note: id });
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
				'Deleted “Beta”.Undo',
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

	const held = (id: string) => holdCredential(db, id);

	/** Ada's Dropbox, the source showing. */
	const connectAda = async () => {
		await held('c-ada');
		await bindConnection(db, {
			connectionId: 'c-ada',
			provider: 'dropbox',
			accountId: 'dbid:ada',
			displayName: 'ada@example.com',
		});
		await finishImport(db, 'c-ada');
	};

	/**
	 * Its note on the remote, so its delete is owed — which is what keeps the
	 * tombstone, and the source, on the device through the disconnect.
	 */
	const sent = (id: string) => db.notes.update(['c-ada', id], { remoteId: 'ada:1', dirty: 0 });

	/** Inside the undo window: another source connected, and Ada's let go. */
	const letAdaGo = async () => {
		await held('c-bob');
		await act(async () => {
			await bindConnection(db, {
				connectionId: 'c-bob',
				provider: 'dropbox',
				accountId: 'dbid:bob',
			});
			await finishImport(db, 'c-bob');
			await detachConnection(db, { connectionId: 'c-ada' });
		});
	};

	it('says where it went when its source was disconnected meanwhile, and what can be done there', async () => {
		const user = userEvent.setup();
		await connectAda();
		const { notes } = await openApp('Alpha');
		const id = notes[0]?.id ?? '';
		await sent(id);
		const notice = await openAndDelete(user, 'Alpha');
		await letAdaGo();

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

	it('says a note with no name is back by its first words', async () => {
		const user = userEvent.setup();
		await connectAda();
		await openApp();
		const note = await createNote(db, { folderPath: 'Work', body: 'Pick up the parcel\n' });
		await sent(note.id);
		await user.click(await screen.findByRole('button', { name: 'Options for “Untitled”' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));
		const notice = await screen.findByRole('status');
		await letAdaGo();

		await user.click(within(notice).getByRole('button', { name: 'Undo' }));

		const back = await screen.findByRole('alert');
		expect(
			within(back).getByText(
				'“Pick up the parcel” is back, in Dropbox · ada@example.com, which is disconnected. Reconnect it, or download the note.'
			)
		).toBeTruthy();
	});

	it('can be dismissed', async () => {
		const user = userEvent.setup();
		await openApp('Alpha');
		const notice = await openAndDelete(user, 'Alpha');

		await user.click(within(notice).getByRole('button', { name: 'Dismiss' }));

		expect(screen.queryByRole('status')).toBeNull();
	});

	it('goes when the user presses anything else on the page', async () => {
		const user = userEvent.setup();
		const { notes } = await openApp('Alpha', 'Beta');
		await openAndDelete(user, 'Beta');

		await user.click(screen.getByRole('button', { name: /^Alpha/ }));

		await waitFor(() => {
			expect(screen.queryByRole('status')).toBeNull();
		});
		const beta = notes.find((note) => note.title === 'Beta');
		expect((await getNote(db, beta?.id ?? ''))?.deletedLocally).toBe(1);
	});
});

describe('the notice of a delete', () => {
	/** The notice, and something else on the page to press. */
	const withElsewhere = (keep = false) => {
		const onDismiss = vi.fn();
		render(
			<>
				<button type="button">Elsewhere</button>
				<div role="dialog" aria-modal="true">
					<button type="button">In a dialog</button>
				</div>
				<DeletedNotice
					title="Alpha"
					onUndo={() => undefined}
					onDismiss={onDismiss}
					keep={keep}
				/>
			</>
		);
		return onDismiss;
	};

	it('goes at a press anywhere else, but not on itself or in a dialog over the page', () => {
		const onDismiss = withElsewhere();

		fireEvent.pointerDown(screen.getByRole('button', { name: 'Undo' }));
		fireEvent.pointerDown(screen.getByRole('status'));
		fireEvent.pointerDown(screen.getByRole('button', { name: 'In a dialog' }));
		expect(onDismiss).not.toHaveBeenCalled();

		fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('stays at a press elsewhere when it keeps, since it may hold the only copy', () => {
		const onDismiss = withElsewhere(true);

		fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));

		expect(onDismiss).not.toHaveBeenCalled();
	});

	it('is dismissed by an × in its corner, which is named for what it does', () => {
		withElsewhere();

		const dismiss = screen.getByRole('button', { name: 'Dismiss' });
		expect(dismiss.classList.contains('toast-close')).toBe(true);
		expect(dismiss.textContent).toBe('');
	});

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
