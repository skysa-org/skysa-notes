import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { bindConnection, detachConnection } from '../src/store/connection.js';
import { db } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';

/**
 * The whole app, through the real router, because the pieces below it are each
 * tested in isolation and the wiring between them is not. Every part of the
 * loose-notes feature can be disconnected in `routes/index.tsx` — the count not
 * passed to `selectedFolderPath`, the URL sentinel not applied — without a
 * single unit test noticing, and the result is a row the user can click that
 * does nothing, or a folder that cannot survive a reload.
 */

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

beforeEach(async () => {
	// The storage panel asks the server on open. There is no server here, and
	// an app that cannot reach it has to work anyway.
	vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.syncState.clear();
});

/** The note list's heading: the second on the page, after "Notebooks". */
const paneHeading = (): string | null | undefined => screen.getAllByRole('heading')[1]?.textContent;

/**
 * Opens the app at `url` and waits until `pane` is open and the app has stopped
 * moving.
 *
 * Waiting for the absence of "Loading…" is not enough, and the difference is
 * the bug this file exists to catch: with the tree resolved and the count of
 * loose notes still pending, a requested root shows "Loose notes" over an empty
 * list — nothing is loading, and the app is still about to change its mind. So
 * the gate is the pane the test expects, plus a turn of the event loop to catch
 * it flipping away again afterwards.
 */
const open = async (url: string, pane: string) => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);

	// The router renders nothing at all until it has resolved the route, so
	// without this the store check runs against an empty document.
	await screen.findByRole('heading', { name: 'Notebooks' });
	await waitFor(() => {
		expect(screen.queryAllByText('Loading…')).toHaveLength(0);
		expect(paneHeading()).toBe(pane);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	expect(paneHeading()).toBe(pane);

	return router;
};

/** Is there a row in the sidebar for the loose notes? */
const looseRow = () => screen.queryByRole('button', { name: /Loose notes/ });

/** A note sitting loose at the root: what a remote folder hands us. */
const looseNote = (title: string) => createNote(db, { title });

describe('the app', () => {
	it('says how connecting storage went, once, and takes it out of the URL', async () => {
		await createFolder(db, { name: 'Work' });
		const router = await open('/?folder=Work&connect=ok', 'Work');

		expect((await screen.findByRole('status')).textContent).toMatch(/Storage connected/);
		await waitFor(() => {
			expect(router.state.location.search).toEqual({ folder: 'Work' });
		});
	});

	it('says why connecting storage did not happen', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?connect=denied', 'Work');

		expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled/);
	});

	it('ignores an outcome the server cannot send', async () => {
		// `conflict`, `signin` and `occupied` were real until Phase 7 retired
		// them server-side, and `signin` outlived its own product — there is no
		// sign-in to send anyone to (docs/PLAN.md §6). A stale bookmark, or a
		// hand-typed query, must not resurrect the message.
		await createFolder(db, { name: 'Work' });
		await open('/?connect=signin', 'Work');

		// Not a theoretical input: `validateSearch` is meant to drop anything
		// outside `CONNECT_OUTCOMES` and at runtime does not, so the value
		// reaches the component. Before this was handled it rendered an empty
		// red banner — a bar saying nothing.
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.queryByText(/Sign in/)).toBeNull();
	});

	it('says to leave the files permission ticked when the user took it away', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?connect=partial', 'Work');

		expect((await screen.findByRole('alert')).textContent).toMatch(
			/leave that permission ticked/
		);
	});

	it('says the server will not have the account when its operator refused it', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?connect=refused', 'Work');

		expect((await screen.findByRole('alert')).textContent).toMatch(
			/cannot sync on this server/
		);
	});

	it('puts the connect outcome away once the user moves on', async () => {
		const user = userEvent.setup();
		await createFolder(db, { name: 'Work' });
		await createFolder(db, { name: 'Play' });
		await open('/?folder=Play&connect=denied', 'Play');
		expect(await screen.findByText(/was cancelled/)).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Work' }));

		await waitFor(() => {
			expect(screen.queryByText(/was cancelled/)).toBeNull();
		});
	});

	it('lets the user put the connect outcome away without doing anything else', async () => {
		// The point of the toast over the banner it replaced. The outcome does
		// not say what to do next in every case — "storage connected" is the end
		// of it — and before this the only way to be rid of the message was to
		// go and click something, which is not an answer to a notice the user
		// has simply read.
		const user = userEvent.setup();
		await createFolder(db, { name: 'Work' });
		await open('/?connect=ok', 'Work');
		expect(await screen.findByText(/Storage connected/)).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Dismiss' }));

		await waitFor(() => {
			expect(screen.queryByText(/Storage connected/)).toBeNull();
		});
		// And the app is still the app: the notice went, not the screen.
		expect(screen.getByRole('button', { name: 'Work' })).toBeTruthy();
	});

	it('puts the connect outcome away when the user touches anything else', async () => {
		// Not a navigation — `select` has always cleared these, and that is the
		// case the test above covers. This is a press on a heading, which does
		// nothing else whatsoever: reading a toast is acknowledging it, and a
		// card about a connection that is over should not have to be aimed at
		// to be rid of.
		const user = userEvent.setup();
		await createFolder(db, { name: 'Work' });
		await open('/?connect=ok', 'Work');
		expect(await screen.findByText(/Storage connected/)).toBeTruthy();

		await user.click(screen.getByRole('heading', { name: 'Notebooks' }));

		await waitFor(() => {
			expect(screen.queryByText(/Storage connected/)).toBeNull();
		});
	});

	it('colours the outcome by what it is, and announces it to match', async () => {
		// Three tones, and the two that are not errors are the ones worth
		// pinning: an unticked permission is not a failure — everything worked
		// as asked and a tickbox fixes it — where a server that will not have
		// the account cannot be retried into working.
		await createFolder(db, { name: 'Work' });

		await open('/?connect=partial', 'Work');
		const partial = await screen.findByRole('alert');
		expect(partial.className).toContain('toast-warning');
		cleanup();

		await open('/?connect=refused', 'Work');
		const refused = await screen.findByRole('alert');
		expect(refused.className).toContain('toast-error');
		cleanup();

		await open('/?connect=ok', 'Work');
		// A success waits its turn rather than interrupting: `status`, not
		// `alert`.
		const ok = await screen.findByRole('status');
		expect(ok.className).toContain('toast-success');
	});

	it('keeps showing the notes when an account is connected, and what was never sent when it is disconnected', async () => {
		// The rows move to the new connection in one transaction; the app reads
		// whichever connection is active, and follows without a reload. Let go
		// before anything was sent, the source stays in front, detached, with the
		// notes still in it: nothing unsent disappears from under the user.
		await createFolder(db, { name: 'Work' });
		await createNote(db, { title: 'Standup', folderPath: 'Work' });
		await open('/', 'Work');
		await screen.findByText('Standup');

		await act(async () => {
			await bindConnection(db, { connectionId: 'dropbox-1', provider: 'dropbox' });
		});
		await waitFor(() => {
			expect(screen.getByRole('button', { name: /Work/ })).toBeTruthy();
		});
		expect(await screen.findByText('Standup')).toBeTruthy();

		await act(async () => {
			await detachConnection(db, { connectionId: 'dropbox-1' });
		});
		expect(await screen.findByText('Standup')).toBeTruthy();
		expect(paneHeading()).toBe('Work');
		expect(await screen.findByRole('note')).toHaveProperty(
			'textContent',
			expect.stringContaining('Dropbox is disconnected')
		);
	});

	it('opens the first notebook when the root is empty', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/', 'Work');

		expect(looseRow()).toBeNull();
	});

	it('offers no Loose notes row when every note is in a notebook', async () => {
		await createFolder(db, { name: 'Work' });
		await createNote(db, { title: 'Standup', folderPath: 'Work' });
		await open('/', 'Work');

		expect(looseRow()).toBeNull();
	});

	it('opens the loose notes when the row is clicked', async () => {
		// The headline user story. Without the count reaching
		// `selectedFolderPath`, this click silently does nothing.
		await createFolder(db, { name: 'Work' });
		await looseNote('Scratch');
		const router = await open('/', 'Work');

		await userEvent.click(screen.getByRole('button', { name: /Loose notes/ }));

		await waitFor(() => {
			expect(paneHeading()).toBe('Loose notes');
		});
		// The heading and the list are separate live queries: the pane can be
		// renamed a tick before its notes arrive.
		expect(await screen.findByText('Scratch')).toBeDefined();
		expect(router.state.location.search).toEqual({ folder: '/' });
	});

	it('comes back to the loose notes after a reload', async () => {
		// The point of the `/` sentinel: written as an empty param it would be
		// dropped, and the root would be unreachable by link or bookmark.
		await createFolder(db, { name: 'Work' });
		await looseNote('Scratch');
		await open('/?folder=%2F', 'Loose notes');

		expect(screen.getByText('Scratch')).toBeDefined();
	});

	it('cannot create a note in the loose notes', async () => {
		await looseNote('Scratch');
		await open('/?folder=%2F', 'Loose notes');

		expect(screen.getByRole('button', { name: 'New note' }).hasAttribute('disabled')).toBe(
			true
		);
	});

	it('shows a folder of nothing but loose notes rather than calling it empty', async () => {
		// The §12.6 case exactly: a remote folder with loose `.md` files and no
		// notebooks at all. Telling this user to create a notebook would be the
		// app claiming they have nothing.
		await looseNote('Scratch');
		await open('/', 'Loose notes');

		expect(screen.getByText('Scratch')).toBeDefined();
		expect(screen.queryByText('Create a notebook to start writing.')).toBeNull();
	});

	it('falls back to a notebook when a stale link asks for an empty root', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=%2F', 'Work');

		expect(looseRow()).toBeNull();
	});

	it('never lands on the loose notes when a notebook could be opened', async () => {
		await createFolder(db, { name: 'Work' });
		await looseNote('Scratch');
		await open('/', 'Work');

		expect(looseRow()).not.toBeNull();
	});

	it('opens a notebook created from the loose notes, at the root', async () => {
		// That the new notebook is a sibling rather than a child is pinned in
		// `Sidebar.test.tsx`, at the callback: `createFolder` maps `''` and
		// `undefined` to the same path, so only the argument can tell them apart.
		// What this adds is the URL leaving the sentinel behind afterwards.
		await looseNote('Scratch');
		const router = await open('/?folder=%2F', 'Loose notes');

		await userEvent.click(screen.getByRole('button', { name: 'New notebook' }));
		await userEvent.type(screen.getByLabelText('New notebook name'), 'Work{Enter}');

		await waitFor(() => {
			expect(router.state.location.search).toEqual({ folder: 'Work' });
		});
		expect((await db.folders.toArray()).map((folder) => folder.path)).toEqual(['Work']);
	});
});

/**
 * Search is the one thing in the app that answers across notebooks, so the
 * wiring it needs is wiring nothing else has: the query has to reach a read of
 * every note rather than the open folder's, the field has to survive the list
 * under it changing, and opening a match has to take the user to where that note
 * actually lives. Each of those can be disconnected in `routes/index.tsx`
 * without a single unit test noticing.
 */
describe('searching', () => {
	const field = () => screen.getByRole('searchbox', { name: 'Search notes' });

	const type = async (what: string) => {
		await userEvent.type(field(), what);
		// The results are a live query: a turn of the loop, then the list.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	};

	beforeEach(async () => {
		await createFolder(db, { name: 'Work' });
		await createFolder(db, { name: 'Garden' });
		await createNote(db, { title: 'Standup', body: 'agenda for Monday\n', folderPath: 'Work' });
		await createNote(db, {
			title: 'Compost',
			body: 'turn the heap every second week\n',
			folderPath: 'Garden',
		});
	});

	it('finds a note in a notebook the user is not in, and says which one', async () => {
		await open('/?folder=Work', 'Work');

		await type('heap');

		expect(await screen.findByText('Compost')).toBeDefined();
		expect(screen.getByText(/^Garden ·/)).toBeDefined();
		// The notebook the user is standing in is not what is listed.
		expect(screen.queryByText('Standup')).toBeNull();
	});

	it('marks the word it matched inside the note', async () => {
		await open('/?folder=Work', 'Work');

		await type('heap');

		await waitFor(() => {
			expect(screen.getByText('heap').tagName).toBe('MARK');
		});
	});

	it('opens a match in its own notebook, not in the one behind the search', async () => {
		// Without this the sidebar highlights Work while a note from Garden is
		// open beside it, and emptying the field leaves that note in no list.
		const router = await open('/?folder=Work', 'Work');
		await type('heap');
		const match = await screen.findByText('Compost');

		await userEvent.click(match);

		await waitFor(() => {
			expect(router.state.location.search).toMatchObject({ folder: 'Garden' });
		});
		const compost = (await db.notes.toArray()).find((note) => note.title === 'Compost');
		expect(router.state.location.search).toMatchObject({ note: compost?.id });
	});

	it('gives the notebook back when the field is emptied', async () => {
		await open('/?folder=Work', 'Work');
		await type('heap');
		expect(await screen.findByText('Compost')).toBeDefined();

		await userEvent.clear(field());

		expect(await screen.findByText('Standup')).toBeDefined();
		await waitFor(() => {
			expect(screen.queryByText('Compost')).toBeNull();
		});
	});

	it('follows an edit made while the search is open', async () => {
		// The results are a live query over the notes table, not a snapshot
		// taken when the user stopped typing.
		await open('/?folder=Work', 'Work');
		await type('kingfisher');
		expect(await screen.findByText(/Nothing matches/)).toBeDefined();

		const standup = (await db.notes.toArray()).find((note) => note.title === 'Standup');
		await act(async () => {
			await saveNoteBody(db, standup?.id ?? '', 'a kingfisher on the wire\n');
		});

		expect(await screen.findByText('Standup')).toBeDefined();
	});

	it('leaves the search when a note is created, so the new note is in the list', async () => {
		// The `+` button stays live while a search is open. Without leaving the
		// search, the note is created, opened in the editor — and shown in no
		// list at all, because the pane is still answering a query it does not
		// match.
		await open('/?folder=Work', 'Work');
		await type('heap');
		expect(await screen.findByText('Compost')).toBeDefined();

		await userEvent.click(screen.getByRole('button', { name: 'New note' }));

		expect(await screen.findByText('Untitled')).toBeDefined();
		expect(field()).toHaveProperty('value', '');
	});

	it('says plainly when nothing matches', async () => {
		await open('/?folder=Work', 'Work');

		await type('bicycle');

		expect(await screen.findByText('Nothing matches “bicycle”.')).toBeDefined();
	});
});

describe('the command palette', () => {
	const openPalette = async () => {
		await userEvent.keyboard('{Meta>}k{/Meta}');
		return screen.findByRole('dialog', { name: 'Commands' });
	};

	it('opens on the chord and lists what the app can do', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work', 'Work');

		await openPalette();

		expect(screen.getByRole('option', { name: /New note/ })).toBeDefined();
		expect(screen.getByRole('option', { name: /Search notes/ })).toBeDefined();
		// Declared by `NoteView`, not by the shell: the point of the registry is
		// that a screen can offer a command without the shell knowing about it.
		expect(screen.getByRole('option', { name: /Edit as/ })).toBeDefined();
	});

	it('makes a note when the command is run, and opens it', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work', 'Work');

		await openPalette();
		await userEvent.keyboard('new note{Enter}');

		expect(await screen.findByDisplayValue('Untitled')).toBeDefined();
		expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
	});

	it('puts the cursor in the search field when asked to search', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work', 'Work');

		await openPalette();
		await userEvent.keyboard('search{Enter}');

		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole('searchbox', { name: 'Search notes' })
			);
		});
	});

	it('closes on Escape without doing anything', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work', 'Work');

		await openPalette();
		await userEvent.keyboard('{Escape}');

		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
		});
		expect(screen.queryByDisplayValue('Untitled')).toBeNull();
	});

	it('makes a note on the bare key, and only where that key is not a letter', async () => {
		// `Mod+N` opens a browser window and `Mod+Shift+N` a private one, in
		// Chrome, Edge and Safari alike, and the page is never asked — so a bare
		// key is what is left. That is what `reachable` is for: in the search
		// field the same key is the letter the user typed.
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work', 'Work');

		const search = screen.getByRole('searchbox', { name: 'Search notes' });
		await userEvent.type(search, 'n');
		expect(screen.queryByDisplayValue('Untitled')).toBeNull();
		expect((search as HTMLInputElement).value).toBe('n');

		await userEvent.clear(search);
		act(() => {
			search.blur();
		});
		await userEvent.keyboard('n');

		expect(await screen.findByDisplayValue('Untitled')).toBeDefined();
	});

	it('offers the note commands as unavailable when there is no note open', async () => {
		await createFolder(db, { name: 'Work' });
		await open('/?folder=Work', 'Work');

		await openPalette();

		// Shown, not hidden: a palette whose contents move about as the user does
		// cannot be learned.
		expect(screen.getByRole('option', { name: /Edit as/ }).getAttribute('aria-disabled')).toBe(
			'true'
		);
	});
});
