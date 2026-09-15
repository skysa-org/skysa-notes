import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/store/db.js';
import { useLooseNoteCount } from '../src/store/hooks.js';
import { createNote, purgeNote } from '../src/store/notes.js';

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
