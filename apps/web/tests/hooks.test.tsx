import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/store/db.js';
import { useLooseNoteCount, useNote } from '../src/store/hooks.js';
import { createNote, deleteNote, purgeNote } from '../src/store/notes.js';

/**
 * `useLooseNoteCount` is what decides whether the sidebar's "Loose notes" row
 * exists at all, so counting the wrong thing is visible: count every note and
 * the row appears — claiming a number of loose notes — for an app that has none.
 */

afterEach(cleanup);

beforeEach(async () => {
	// The hooks read the singleton database, not an injected one.
	await db.notes.clear();
	await db.folders.clear();
});

const count = async (): Promise<number | undefined> => {
	const { result } = renderHook(useLooseNoteCount);
	await waitFor(() => {
		expect(result.current).not.toBeUndefined();
	});
	return result.current;
};

describe('useLooseNoteCount', () => {
	it('is zero for an app whose notes all live in notebooks', async () => {
		await createNote(db, { title: 'Standup', folderPath: 'work' });
		await createNote(db, { title: 'Retro', folderPath: 'work/meetings' });

		expect(await count()).toBe(0);
	});

	it('counts the notes sitting at the root', async () => {
		await createNote(db, { title: 'Scratch' });
		await createNote(db, { title: 'Ideas' });
		await createNote(db, { title: 'Standup', folderPath: 'work' });

		expect(await count()).toBe(2);
	});

	it('stops counting a note once it is gone', async () => {
		const loose = await createNote(db, { title: 'Scratch' });
		await purgeNote(db, loose.id);

		expect(await count()).toBe(0);
	});
});

describe('useNote', () => {
	it('reads the open note', async () => {
		const note = await createNote(db, { title: 'Open' });
		const { result } = renderHook(() => useNote(note.id));

		await waitFor(() => {
			expect(result.current?.id).toBe(note.id);
		});
	});

	/**
	 * `db.notes.get` returns a tombstone like any other row. The list and the
	 * sidebar have already dropped it, so returning it here left the note fully
	 * editable in the right pane after the rest of the app moved on — and
	 * anything typed went into a row that is purged once the delete is pushed.
	 */
	it('lets go of a note once it is tombstoned', async () => {
		const note = await createNote(db, { title: 'Open' });
		const { result } = renderHook(() => useNote(note.id));
		await waitFor(() => {
			expect(result.current?.id).toBe(note.id);
		});

		await deleteNote(db, note.id);

		await waitFor(() => {
			expect(result.current).toBeUndefined();
		});
	});
});
