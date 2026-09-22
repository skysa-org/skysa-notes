import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchField } from '../src/components/SearchField.js';

/**
 * The app's search field, in the source bar. It is the field alone: what it
 * finds is the store's business and where the answers go is the route's.
 */

afterEach(cleanup);

describe('the search field', () => {
	it('is a search landmark, with the field named for what it searches', () => {
		render(<SearchField query="" onQuery={() => undefined} />);
		expect(screen.getByRole('search')).toBeDefined();
		expect(screen.getByRole('searchbox', { name: 'Search notes' })).toBeDefined();
	});

	it('hands up what is typed', async () => {
		const onQuery = vi.fn();
		render(<SearchField query="" onQuery={onQuery} />);

		await userEvent.type(screen.getByRole('searchbox', { name: 'Search notes' }), 'h');

		expect(onQuery).toHaveBeenCalledWith('h');
	});

	it('empties the field on Escape, which is the way out', async () => {
		const onQuery = vi.fn();
		render(<SearchField query="heron" onQuery={onQuery} />);

		await userEvent.type(screen.getByRole('searchbox', { name: 'Search notes' }), '{Escape}');

		expect(onQuery).toHaveBeenCalledWith('');
	});
});
