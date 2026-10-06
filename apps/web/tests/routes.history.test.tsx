import {
	createMemoryHistory,
	createRouter,
	type RouterHistory,
	RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen.js';
import { bindConnection, finishImport, showConnection } from '../src/store/connection.js';
import { activeConnectionId, db, LOCAL_CONNECTION_ID } from '../src/store/db.js';
import { createFolder } from '../src/store/folders.js';
import { createNote, renameNote } from '../src/store/notes.js';
import { setDefaultEditorMode } from '../src/store/prefs.js';
import { hashIn, noteUrl, placeIn } from './entry.js';

/**
 * Where the user is, through the browser's own history (`routes/place.ts`):
 * the hash names it by path for a person or a link to read, each entry holds
 * it by id, and a step the user takes is an entry Back undoes, while what the
 * app works out by itself takes no step of its own.
 */

const DROPBOX = 'c-dropbox';

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
	await db.prefs.clear();
	await db.syncState.clear();
	await db.credentials.clear();
});

const openApp = async (at = '/') => {
	await setDefaultEditorMode(db, 'raw');
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [at] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole('button', { name: 'New notebook' });
	return router;
};

const titleField = () => screen.queryByLabelText<HTMLInputElement>('Note title');

const showing = async (title: string) => {
	await waitFor(() => {
		expect(titleField()?.value).toBe(title);
	});
};

/** A note made at a known moment, since two creates can share a millisecond. */
const noteAt = async (folderPath: string, title: string, createdAt: number) => {
	const note = await createNote(db, { folderPath, title, body: `${title}\n` });
	await db.notes.update([note.connectionId, note.id], { createdAt });
	return note;
};

const back = async (router: { history: RouterHistory }) => {
	await act(async () => {
		router.history.back();
		await Promise.resolve();
	});
};

const forward = async (router: { history: RouterHistory }) => {
	await act(async () => {
		router.history.forward();
		await Promise.resolve();
	});
};

/** Long enough for anything the app was about to do by itself to have been done. */
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

describe('the page title', () => {
	it('names the notebooks the open note is in, then the note', async () => {
		await createFolder(db, { name: 'Work' });
		await createFolder(db, { parentPath: 'Work', name: 'Projects' });
		const plan = await noteAt('Work/Projects', 'Q3 plan', 1_000);

		await openApp(noteUrl(plan));

		await waitFor(() => {
			expect(document.title).toBe('Work > Projects > Q3 plan');
		});
	});

	it('follows the note open, and its name when it is renamed', async () => {
		await createFolder(db, { name: 'Work' });
		const older = await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();
		await openApp(noteUrl(older));
		await waitFor(() => {
			expect(document.title).toBe('Work > Older');
		});

		await user.click(await screen.findByRole('button', { name: /^Newer/ }));
		await waitFor(() => {
			expect(document.title).toBe('Work > Newer');
		});
		await renameNote(
			db,
			(await db.notes.toArray()).find((n) => n.title === 'Newer')?.id ?? '',
			'Latest'
		);

		await waitFor(() => {
			expect(document.title).toBe('Work > Latest');
		});
	});
});

describe('a link to a note by its path', () => {
	it('opens that note, and holds it by id from then on', async () => {
		await createFolder(db, { name: 'Work' });
		const older = await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);

		const router = await openApp('/#/work/older');

		// Not the newest, which is what the notebook alone would open on.
		await showing('Older');
		await waitFor(() => {
			expect(placeIn(router)).toEqual({ folder: 'Work', note: older.id });
		});
		expect(hashIn(router)).toBe('/work/older');
	});

	it('reads names with spaces, capitals and another script', async () => {
		await createFolder(db, { name: 'Work Stuff' });
		const note = await noteAt('Work Stuff', '日本 Plan', 1_000);
		await noteAt('Work Stuff', 'Newer', 2_000);

		await openApp(noteUrl(note));

		await showing('日本 Plan');
	});

	it('opens the notebook where the note it names is not there', async () => {
		await createFolder(db, { name: 'Archive' });
		await createFolder(db, { name: 'Work' });
		await noteAt('Archive', 'Elsewhere', 1_000);
		const newer = await noteAt('Work', 'Newer', 2_000);

		const router = await openApp('/#/work/renamed-since');

		await showing('Newer');
		expect(screen.getByRole('heading', { name: 'Work' })).toBeDefined();
		await waitFor(() => {
			expect(hashIn(router)).toBe('/work/newer');
		});
		expect(placeIn(router)).toEqual({ folder: 'Work', note: newer.id });
	});

	it('opens where the user was for a hash that is not a place', async () => {
		await createFolder(db, { name: 'Work' });
		await noteAt('Work', 'Plans', 1_000);

		const router = await openApp('/#section-2');

		await showing('Plans');
		await waitFor(() => {
			expect(hashIn(router)).toBe('/work/plans');
		});
	});
});

describe('the hash', () => {
	it('follows the open note when it is renamed, in place of the entry', async () => {
		await createFolder(db, { name: 'Work' });
		const plan = await noteAt('Work', 'Plan', 1_000);
		const router = await openApp(noteUrl(plan));
		await showing('Plan');
		await settle();
		const steps = router.history.length;

		await renameNote(db, plan.id, 'Q3 plan');

		await waitFor(() => {
			expect(hashIn(router)).toBe('/work/q3-plan');
		});
		expect(router.history.length).toBe(steps);
		expect(placeIn(router)).toEqual({ folder: 'Work', note: plan.id });
	});
});

describe('going back and forward', () => {
	it('steps back to the note open before, and forward again', async () => {
		await createFolder(db, { name: 'Work' });
		const older = await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();
		const router = await openApp(noteUrl(older));
		await showing('Older');

		await user.click(await screen.findByRole('button', { name: /^Newer/ }));
		await showing('Newer');
		await back(router);

		await showing('Older');
		expect(hashIn(router)).toBe('/work/older');
		await forward(router);
		await showing('Newer');
	});

	it('steps back out of a notebook clicked, to the note open before it', async () => {
		await createFolder(db, { name: 'Archive' });
		await createFolder(db, { name: 'Work' });
		await noteAt('Archive', 'Elsewhere', 1_000);
		const plans = await noteAt('Work', 'Plans', 1_000);
		const user = userEvent.setup();
		const router = await openApp(noteUrl(plans));
		await showing('Plans');

		await user.click(await screen.findByRole('button', { name: /^Archive/ }));
		await showing('Elsewhere');
		await back(router);

		await showing('Plans');
		expect(screen.getByRole('heading', { name: 'Work' })).toBeDefined();
	});

	it('takes no step for what the app chose by itself', async () => {
		await createFolder(db, { name: 'Archive' });
		await createFolder(db, { name: 'Work' });
		await noteAt('Archive', 'Elsewhere', 1_000);
		await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();

		// Opened at the start URL: the notebook and the note are both the app's.
		const router = await openApp('/');
		await showing('Elsewhere');
		await settle();
		expect(router.history.length).toBe(1);

		// One click on a notebook is one step, the note it opens on included.
		await user.click(await screen.findByRole('button', { name: /^Work/ }));
		await showing('Newer');
		await settle();
		expect(router.history.length).toBe(2);
		expect(hashIn(router)).toBe('/work/newer');

		await back(router);
		await showing('Elsewhere');
	});

	it('comes back to a note renamed since, by its new name', async () => {
		await createFolder(db, { name: 'Work' });
		const older = await noteAt('Work', 'Older', 1_000);
		await noteAt('Work', 'Newer', 2_000);
		const user = userEvent.setup();
		const router = await openApp(noteUrl(older));
		await showing('Older');
		await user.click(await screen.findByRole('button', { name: /^Newer/ }));
		await showing('Newer');

		// As a pull would: the entry Back comes to still spells the old path.
		await renameNote(db, older.id, 'Oldest');
		await back(router);

		await showing('Oldest');
		await waitFor(() => {
			expect(hashIn(router)).toBe('/work/oldest');
		});
	});

	it('comes back to a notebook open above the note’s own', async () => {
		await createFolder(db, { name: 'Projects' });
		await createFolder(db, { parentPath: 'Projects', name: 'Alpha' });
		const reading = await noteAt('Projects/Alpha', 'Reading', 1_000);
		await noteAt('Projects', 'Overview', 1_000);
		const user = userEvent.setup();
		const router = await openApp(noteUrl(reading));
		await showing('Reading');
		await screen.findByRole('heading', { name: 'Projects/Alpha' });

		// The note stays open, and the hash still names it; the entry holds the
		// notebook the hash cannot say.
		await user.click(await screen.findByRole('button', { name: /^Projects/ }));
		await screen.findByRole('heading', { name: 'Projects' });
		await settle();
		expect(titleField()?.value).toBe('Reading');
		expect(hashIn(router)).toBe('/projects/alpha/reading');
		expect(placeIn(router)).toEqual({ folder: 'Projects', note: reading.id });

		await back(router);

		await screen.findByRole('heading', { name: 'Projects/Alpha' });
		expect(titleField()?.value).toBe('Reading');
	});

	it('goes back to the source a step was taken in, and forward again', async () => {
		await db.credentials.put({
			id: DROPBOX,
			credential: `sk1_${DROPBOX}`,
			provider: 'dropbox',
			createdAt: 0,
		});
		await bindConnection(db, { connectionId: DROPBOX, provider: 'dropbox', accountId: 'acct' });
		await finishImport(db, DROPBOX);
		await createFolder(db, { connectionId: DROPBOX, parentPath: undefined, name: 'Plans' });
		await createNote(db, { connectionId: DROPBOX, folderPath: 'Plans', title: 'Roadmap' });
		// A notebook of the same name on both sides, which a path alone would
		// mistake for the other.
		await createFolder(db, { connectionId: DROPBOX, parentPath: undefined, name: 'Inbox' });
		await createNote(db, { connectionId: DROPBOX, folderPath: 'Inbox', title: 'Triage' });
		await createFolder(db, {
			connectionId: LOCAL_CONNECTION_ID,
			parentPath: undefined,
			name: 'Inbox',
		});
		const scribble = await createNote(db, {
			connectionId: LOCAL_CONNECTION_ID,
			folderPath: 'Inbox',
			title: 'Scribble',
		});
		await showConnection(db, LOCAL_CONNECTION_ID);
		const user = userEvent.setup();
		const router = await openApp(noteUrl(scribble));
		await showing('Scribble');

		await user.click(screen.getByRole('button', { name: 'Dropbox' }));
		// Its first notebook, as nothing is remembered there: `Inbox`, but
		// Dropbox's.
		await showing('Triage');
		await settle();
		await back(router);

		await showing('Scribble');
		await waitFor(async () => {
			expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		});
		await forward(router);
		await waitFor(async () => {
			expect(await activeConnectionId(db)).toBe(DROPBOX);
		});
		await showing('Triage');
	});
	it('stays in the first source connected when Back comes to the device’s own notes', async () => {
		// Connecting the first source takes the device's own notes into it, and
		// once they are all there the device's pile is no longer offered.
		await createFolder(db, { parentPath: undefined, name: 'Inbox' });
		const scribble = await createNote(db, { folderPath: 'Inbox', title: 'Scribble' });
		const router = await openApp(noteUrl(scribble));
		await showing('Scribble');
		await settle();

		await db.credentials.put({
			id: DROPBOX,
			credential: `sk1_${DROPBOX}`,
			provider: 'dropbox',
			createdAt: 0,
		});
		await bindConnection(db, { connectionId: DROPBOX, provider: 'dropbox', accountId: 'acct' });
		await finishImport(db, DROPBOX);
		await waitFor(async () => {
			expect(await db.notes.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(
				0
			);
		});
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'This device' })).toBeNull();
		});
		await showing('Scribble');
		await settle();
		await back(router);
		await settle();

		expect(await activeConnectionId(db)).toBe(DROPBOX);
		await showing('Scribble');
	});
});
