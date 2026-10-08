import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from '@testing-library/react';
import { Component, type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteSearchField } from '../src/components/SearchField.js';
import { db } from '../src/store/db.js';
import { useNoteSearch } from '../src/store/hooks.js';
import { createNote } from '../src/store/notes.js';
import type * as Search from '../src/store/search.js';

/**
 * When a search's index is built, and when it is let go (docs/ARCHITECTURE.md
 * §7, "Search"). Built as the field takes the cursor, so the first letter is
 * answered from an index already there: a phone takes about a second over a few
 * thousand notes, and begun at the first letter that second was the user's to
 * wait through (#275). Let go once the field has neither the cursor nor a query.
 */

/**
 * The indexes made, the refreshes begun, and the builds stopped; and, for a
 * test that has to say how a refresh ends, what each of the next ones does in
 * place of refreshing (handed the real refresh, to run or not).
 */
const made = vi.hoisted(() => ({
	indexes: 0,
	refreshes: [] as Promise<boolean>[],
	stops: 0,
	instead: [] as ((refresh: () => Promise<boolean>) => Promise<boolean>)[],
}));

vi.mock('../src/store/search.js', async (importOriginal) => {
	const actual = await importOriginal<typeof Search>();
	return {
		...actual,
		createNoteSearch: (): Search.NoteSearch => {
			made.indexes += 1;
			const search = actual.createNoteSearch();
			return {
				...search,
				refresh: (notes) => {
					const instead = made.instead.shift();
					const refresh =
						instead === undefined
							? search.refresh(notes)
							: instead(() => search.refresh(notes));
					made.refreshes.push(refresh);
					return refresh;
				},
				stop: () => {
					made.stops += 1;
					search.stop();
				},
			};
		},
	};
});

afterEach(cleanup);

beforeEach(async () => {
	made.indexes = 0;
	made.refreshes = [];
	made.stops = 0;
	made.instead = [];
	await db.notes.clear();
	await db.folders.clear();
	await createNote(db, { title: 'Compost', body: 'turn the heap\n', folderPath: 'garden' });
});

/** Until an index has been begun, and every refresh begun is done. */
const built = async () => {
	await waitFor(() => {
		expect(made.refreshes.length).toBeGreaterThan(0);
	});
	await act(async () => {
		await Promise.all(made.refreshes);
	});
};

const titles = (hits: readonly Search.NoteHit[] | undefined) => hits?.map((hit) => hit.note.title);

describe('the index behind a search', () => {
	const searching = (initialProps: { query: string; focused: boolean }) =>
		renderHook(({ query, focused }) => useNoteSearch(query, focused), { initialProps });

	it('is built once the field has the cursor, so the first letter is answered at once', async () => {
		const { result, rerender } = searching({ query: '', focused: true });
		await built();

		rerender({ query: 'heap', focused: true });

		// In the render the letter came in, not one after it.
		expect(titles(result.current)).toEqual(['Compost']);
	});

	it('is not built while the field has neither the cursor nor a query', async () => {
		const { result } = searching({ query: '', focused: false });

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		expect(result.current).toEqual([]);
		expect(made.indexes).toBe(0);
	});

	it('is let go once the field has neither, and built again for the next search', async () => {
		const { result, rerender } = searching({ query: '', focused: true });
		await built();

		rerender({ query: '', focused: false });
		expect(made.stops).toBe(1);
		rerender({ query: 'heap', focused: false });

		// A new search, so a new index, and nothing to answer from until it is
		// built: not the last search's.
		expect(made.indexes).toBe(2);
		expect(result.current).toBeUndefined();
		await waitFor(() => {
			expect(titles(result.current)).toEqual(['Compost']);
		});
	});

	it('answers from no index that a later refresh took over before it was done', async () => {
		// The first refresh is overtaken by a second, read for a note saved
		// meanwhile — a sync landing as the search opens — and says so having
		// indexed nothing. The second is held until the test lets it go.
		const overtaken = Promise.withResolvers<boolean>();
		const second = Promise.withResolvers<undefined>();
		made.instead = [
			() => overtaken.promise,
			async (refresh) => {
				await second.promise;
				return refresh();
			},
		];
		const { result } = searching({ query: 'heap', focused: true });
		await waitFor(() => {
			expect(made.refreshes).toHaveLength(1);
		});
		await act(async () => {
			await createNote(db, { title: 'Heap', body: 'a heap\n' });
		});
		await waitFor(() => {
			expect(made.refreshes).toHaveLength(2);
		});

		await act(async () => {
			overtaken.resolve(false);
			await overtaken.promise;
		});

		// Still looking: the index has none of the notes yet, and an answer from
		// it would say nothing matches.
		expect(result.current).toBeUndefined();

		await act(async () => {
			second.resolve(undefined);
			await made.refreshes[1];
		});
		expect(titles(result.current)?.toSorted()).toEqual(['Compost', 'Heap']);
	});

	it('is kept while the field holds a query, with the cursor or without it', async () => {
		const { result, rerender } = searching({ query: 'heap', focused: true });
		await waitFor(() => {
			expect(titles(result.current)).toEqual(['Compost']);
		});

		rerender({ query: 'heap', focused: false });
		rerender({ query: 'hea', focused: false });

		expect(titles(result.current)).toEqual(['Compost']);
		expect(made.indexes).toBe(1);
	});
});

describe('the search field', () => {
	const Harness = () => {
		const [query, setQuery] = useState('');
		return <NoteSearchField query={query} onQuery={setQuery} />;
	};
	const field = () => screen.getByRole('combobox', { name: 'Search notes' });

	it('builds its index as it takes the cursor, and answers the first letter from it', async () => {
		render(<Harness />);

		act(() => {
			field().focus();
		});
		await built();
		fireEvent.change(field(), { target: { value: 'heap' } });

		expect(screen.getByRole('option', { name: /Compost/ })).toBeDefined();
		expect(screen.queryByText('Searching…')).toBeNull();
	});

	it('keeps its index when the window loses the focus and the field keeps it', async () => {
		// Another app, another tab: coming back gives the field the cursor
		// again, and an index let go meanwhile would be a second's build again.
		render(<Harness />);
		act(() => {
			field().focus();
		});
		await built();

		const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
		try {
			act(() => {
				field().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
			});
		} finally {
			hasFocus.mockRestore();
		}

		expect(made.stops).toBe(0);
		expect(document.activeElement).toBe(field());
	});

	it('lets its index go as it loses the cursor with nothing in it', async () => {
		render(<Harness />);
		act(() => {
			field().focus();
		});
		await built();

		act(() => {
			field().blur();
		});

		expect(made.stops).toBe(1);
	});
});

/** What a page's root does with an error thrown as it is drawn: catch it, and say so. */
class Caught extends Component<{ children: ReactNode }, { error?: Error }> {
	override state: { error?: Error } = {};

	static getDerivedStateFromError = (error: Error) => ({ error });

	override render = () =>
		/* eslint-disable functional/no-this-expressions -- a boundary has to be a class */
		this.state.error === undefined ? this.props.children : <p>{this.state.error.message}</p>;
	/* eslint-enable functional/no-this-expressions */
}

describe('an index that fails to build', () => {
	it('is thrown where the answers are drawn, not left saying it is still looking', async () => {
		made.instead = [() => Promise.reject(new Error('the index broke'))];
		const Answers = () => {
			const found = useNoteSearch('heap', true);
			return <p>{found === undefined ? 'Searching…' : 'Answered'}</p>;
		};

		render(
			<Caught>
				<Answers />
			</Caught>
		);

		expect(await screen.findByText('the index broke')).toBeDefined();
	});
});
