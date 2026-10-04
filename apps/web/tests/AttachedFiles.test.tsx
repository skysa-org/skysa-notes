import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachedFiles, sizeOf } from '../src/components/AttachedFiles.js';
import { notebookMenuItems } from '../src/components/NotebookMenu.js';
import { createDatabase, LOCAL_CONNECTION_ID, type NotesDatabase } from '../src/store/db.js';
import { createNote } from '../src/store/notes.js';

/**
 * A notebook's Attached files: each file in it, the notes that link it under
 * its name, and Delete for one that none does.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const freshDatabase = (): NotesDatabase => {
	const db = createDatabase(`attached-files-${crypto.randomUUID()}`);
	opened.push(db);
	return db;
};

const file = (db: NotesDatabase, id: string, path: string, size: number) =>
	db.files.put({ connectionId: LOCAL_CONNECTION_ID, id, path, size });

const seeded = async () => {
	const db = freshDatabase();
	await file(db, 'linked', 'Trip/coast.png', 2_400_000);
	await file(db, 'loose', 'Trip/old-map.pdf', 3000);
	await createNote(db, {
		connectionId: LOCAL_CONNECTION_ID,
		folderPath: 'Trip',
		title: 'Packing',
		body: '![coast](coast.png)\n',
	});
	return db;
};

const show = (db: NotesDatabase, onClose = vi.fn()) => {
	render(<AttachedFiles name="Trip" path="Trip" onClose={onClose} database={db} />);
	return onClose;
};

/**
 * A file's row, once the list has it. Its Delete comes only once the store has
 * said whether the device holds every note, which may be after: find it.
 */
const rowOf = async (name: string) => {
	const label = await screen.findByText(name);
	const row = label.closest('li');
	if (row === null) throw new Error(`no row for ${name}`);
	return within(row);
};

describe('Attached files', () => {
	it('lists each file with its size and the notes it is in', async () => {
		const db = await seeded();
		show(db);

		expect(screen.getByRole('dialog', { name: 'Attached files in “Trip”' })).toBeDefined();
		const linked = await rowOf('coast.png');
		expect(linked.getByText('2.3 MB')).toBeDefined();
		expect(linked.getByText('In Packing')).toBeDefined();
		expect(linked.queryByRole('button', { name: /Delete/ })).toBeNull();

		const loose = await rowOf('old-map.pdf');
		expect(loose.getByText('Not in any note')).toBeDefined();
		expect(await loose.findByRole('button', { name: 'Delete old-map.pdf' })).toBeDefined();
	});

	it('deletes a file no note links once asked twice, and the list follows', async () => {
		const db = await seeded();
		show(db);
		const user = userEvent.setup();

		const loose = await rowOf('old-map.pdf');
		await user.click(await loose.findByRole('button', { name: 'Delete old-map.pdf' }));
		expect(await db.files.get([LOCAL_CONNECTION_ID, 'loose'])).toBeDefined();
		await user.click(
			within(loose.getByRole('group', { name: 'Delete old-map.pdf' })).getByRole('button', {
				name: 'Delete',
			})
		);

		await waitFor(() => {
			expect(screen.queryByText('old-map.pdf')).toBeNull();
		});
		expect(await db.files.get([LOCAL_CONNECTION_ID, 'loose'])).toBeUndefined();
		expect(screen.getByText('coast.png')).toBeDefined();
	});

	it('keeps it when the second answer is Keep', async () => {
		const db = await seeded();
		show(db);
		const user = userEvent.setup();

		const loose = await rowOf('old-map.pdf');
		await user.click(await loose.findByRole('button', { name: 'Delete old-map.pdf' }));
		await user.click(loose.getByRole('button', { name: 'Keep' }));

		expect(loose.getByRole('button', { name: 'Delete old-map.pdf' })).toBeDefined();
		expect(await db.files.get([LOCAL_CONNECTION_ID, 'loose'])).toBeDefined();
	});

	it('keeps the focus on the question, and back on Delete when kept', async () => {
		const db = await seeded();
		show(db);
		const user = userEvent.setup();

		const loose = await rowOf('old-map.pdf');
		await user.click(await loose.findByRole('button', { name: 'Delete old-map.pdf' }));
		expect(document.activeElement).toBe(loose.getByRole('button', { name: 'Keep' }));

		await user.click(loose.getByRole('button', { name: 'Keep' }));
		expect(document.activeElement).toBe(
			loose.getByRole('button', { name: 'Delete old-map.pdf' })
		);
	});

	it('closes on Escape with the focus nowhere', async () => {
		const db = await seeded();
		const user = userEvent.setup();
		const onClose = show(db);
		await rowOf('old-map.pdf');

		(document.activeElement as HTMLElement | null)?.blur();
		await user.keyboard('{Escape}');

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('offers no Delete while the device may not hold every note in the source', async () => {
		const db = freshDatabase();
		await db.syncState.put({
			connectionId: 'drop',
			clientId: 'client',
			importing: { lock: true, returnTo: LOCAL_CONNECTION_ID },
		});
		await db.files.put({
			connectionId: 'drop',
			id: 'loose',
			path: 'Trip/old-map.pdf',
			size: 3,
		});
		show(db);

		const loose = await rowOf('old-map.pdf');
		expect(
			await screen.findByText(/Not every note in this storage is on this device/)
		).toBeDefined();
		expect(loose.getByText('Not in any note')).toBeDefined();
		expect(loose.queryByRole('button', { name: /Delete/ })).toBeNull();
	});

	it('closes on Close and on Escape', async () => {
		const db = await seeded();
		const user = userEvent.setup();
		const onClose = show(db);

		await user.click(screen.getByRole('button', { name: 'Close' }));
		expect(onClose).toHaveBeenCalledTimes(1);

		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});

describe('the notebook menu', () => {
	const actions = {
		onNewInside: vi.fn(),
		onRename: vi.fn(),
		onMove: vi.fn(),
		onDelete: vi.fn(),
	};

	it('offers Attached files before Delete where the notebook has files', () => {
		const labels = notebookMenuItems('Trip', { ...actions, onFiles: vi.fn() }).map(
			(item) => item.label
		);

		expect(labels.slice(-2)).toEqual(['Attached files', 'Delete']);
	});

	it('does not where it has none', () => {
		const labels = notebookMenuItems('Trip', actions).map((item) => item.label);

		expect(labels).not.toContain('Attached files');
	});
});

describe('a size', () => {
	it.each([
		[1, '1 byte'],
		[512, '512 bytes'],
		[2048, '2 KB'],
		[2_400_000, '2.3 MB'],
	])('of %d bytes reads %s', (bytes, words) => {
		expect(sizeOf(bytes)).toBe(words);
	});
});
