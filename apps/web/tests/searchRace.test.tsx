import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two writes in quick succession, with the read the first one triggers slower
 * than the read the second one triggers. That is what a sync round landing under
 * an open search looks like, and it is the one thing about `useNoteSearch` that
 * cannot be seen without control over how long a read takes.
 *
 * Dexie aborts a superseded live query but cannot un-run it: the overtaken
 * callback still completes. So refreshing the index inside that callback let the
 * loser write the index *after* the winner — and because the winner's value is
 * what the results are computed from, nothing ever recomputed over it, and the
 * pane kept showing a note whose words had already gone.
 */
import { db } from '../src/store/db.js';
import { useNoteSearch } from '../src/store/hooks.js';
import type * as Notes from '../src/store/notes.js';
import { createNote, saveNoteBody } from '../src/store/notes.js';
import { noteById } from './noteRows.js';

const reads = { count: 0, slowly: 2, delay: 60 };

// Hoisted above the imports above, which is what lets the hook see the slow
// read: `listNotes` is what `useNoteSearch` calls, and how long it takes is the
// only thing this test needs to control.
vi.mock('../src/store/notes.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Notes>();
	return {
		...actual,
		listNotes: async (...args: Parameters<typeof actual.listNotes>) => {
			reads.count += 1;
			const notes = await actual.listNotes(...args);
			if (reads.count === reads.slowly) {
				await new Promise((resolve) => setTimeout(resolve, reads.delay));
			}
			return notes;
		},
	};
});

afterEach(cleanup);

beforeEach(async () => {
	reads.count = 0;
	await db.notes.clear();
	await db.folders.clear();
});

const settle = async (ms: number) => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
};

describe('a read overtaken by a later one', () => {
	it('leaves the index agreeing with the notes, not with whichever read finished last', async () => {
		const note = await createNote(db, { title: 'Compost', body: 'nothing yet\n' });
		const { result, rerender } = renderHook(({ query }) => useNoteSearch(query), {
			initialProps: { query: 'kingfisher' },
		});
		await waitFor(() => {
			expect(result.current).toEqual([]);
		});

		// The word arrives, and is gone again before the read that would have
		// found it comes back.
		await act(async () => {
			await saveNoteBody(db, note.id, 'a kingfisher on the wire\n');
		});
		await settle(5);
		await act(async () => {
			await saveNoteBody(db, note.id, 'nothing at all now\n');
		});
		await settle(200);
		expect((await noteById(db, note.id))?.body).toContain('nothing at all now');
		expect(result.current).toEqual([]);

		// And the next letter is answered from the index, so this is where an
		// index left holding the older read says the note is still there.
		rerender({ query: 'kingfish' });
		await settle(50);

		expect(result.current).toEqual([]);
	});
});
