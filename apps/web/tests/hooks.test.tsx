import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodeDisplayStore } from '../src/editor/codeDisplay.js';
import { db } from '../src/store/db.js';
import { useCodeDisplay, useLooseNoteCount, useNote, useNoteSearch } from '../src/store/hooks.js';
import { createNote, deleteNote, purgeNote } from '../src/store/notes.js';
import { getCodeDisplay, setCodeDisplay } from '../src/store/prefs.js';

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

/**
 * The one thing about search that only the hook can be asked: what it answers in
 * the moment between the first keystroke and the notes having been read.
 */
describe('useNoteSearch', () => {
	beforeEach(async () => {
		await createNote(db, { title: 'Compost', body: 'turn the heap\n', folderPath: 'garden' });
		await createNote(db, { title: 'Standup', body: 'agenda\n', folderPath: 'work' });
	});

	it('finds a note by a word in its body, from any notebook', async () => {
		const { result } = renderHook(() => useNoteSearch('heap'));

		await waitFor(() => {
			expect(result.current?.map((hit) => hit.note.title)).toEqual(['Compost']);
		});
	});

	it('says it is still looking, rather than that nothing matched, on the first keystroke', async () => {
		// Nobody searching means an empty read, held. The first keystroke is
		// answered before the notes have been read, and answering it from that
		// read says the note is not there — a moment before it appears.
		const { result, rerender } = renderHook(({ query }) => useNoteSearch(query), {
			initialProps: { query: '' },
		});
		await waitFor(() => {
			expect(result.current).toEqual([]);
		});

		rerender({ query: 'heap' });

		expect(result.current).toBeUndefined();
		await waitFor(() => {
			expect(result.current?.length).toBe(1);
		});
	});

	it('answers an empty query with nothing at all', async () => {
		const { result } = renderHook(() => useNoteSearch(''));

		await waitFor(() => {
			expect(result.current).toEqual([]);
		});
	});
});

/**
 * The bridge between the editor's plugins, which are not React and cannot wait
 * for a query, and the table that outlives the session. Both directions matter:
 * a setting that is not read back is forgotten on reload, and one that is not
 * written is forgotten as soon as the note is closed.
 */
describe('useCodeDisplay', () => {
	beforeEach(async () => {
		await db.prefs.clear();
	});

	it('starts the editor off where this device left it', async () => {
		await setCodeDisplay(db, { wrap: true, lineNumbers: true });
		const store = createCodeDisplayStore();

		renderHook(() => {
			useCodeDisplay(store);
		});

		await waitFor(() => {
			expect(store.get()).toEqual({ wrap: true, lineNumbers: true });
		});
	});

	it('writes a change back, so the next session opens the same way', async () => {
		const store = createCodeDisplayStore();
		renderHook(() => {
			useCodeDisplay(store);
		});
		await waitFor(() => {
			expect(store.get()).toEqual({ wrap: false, lineNumbers: false });
		});

		store.set({ wrap: false, lineNumbers: true });

		await waitFor(async () => {
			expect(await getCodeDisplay(db)).toEqual({ wrap: false, lineNumbers: true });
		});
	});
});
