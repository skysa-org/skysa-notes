import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { DatabaseProvider, useDb } from '../src/store/database.js';
import { db } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import { freshDatabase } from './support/db.js';

/**
 * The database a component reads (#455): the one the provider above it names,
 * and the app's own where none does.
 */

describe('the database a component is drawn over', () => {
	it('is the app’s own outside a provider', () => {
		const { result } = renderHook(useDb);

		expect(result.current).toBe(db);
	});

	it('is the provider’s, for the store’s hooks as well', async () => {
		const own = freshDatabase();
		const theirs = await createNote(own, { title: 'Theirs' });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<DatabaseProvider db={own}>{children}</DatabaseProvider>
		);

		const { result } = renderHook(() => ({ db: useDb(), note: useNote(theirs.id) }), {
			wrapper,
		});

		expect(result.current.db).toBe(own);
		await waitFor(() => {
			expect(result.current.note?.title).toBe('Theirs');
		});
		expect(await db.notes.count()).toBe(0);
	});
});
