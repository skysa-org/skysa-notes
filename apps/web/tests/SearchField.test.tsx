import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchField, type SearchFieldProps } from '../src/components/SearchField.js';
import { type NoteRecord } from '../src/store/db.js';
import { type NoteHit, SEARCH_LIMIT } from '../src/store/search.js';

/**
 * The app's search field and the answers that drop from it. What it finds is
 * the store's business and what opening a note does is the route's; what is
 * here is the list, what it says, and that choosing from it ends the search.
 */

afterEach(cleanup);

const note = (title: string): NoteRecord =>
	({
		id: title,
		connectionId: 'local',
		title,
		body: '',
		path: `work/${title}.md`,
		updatedAt: 0,
		dirty: 0,
	}) as NoteRecord;

const hit = (title: string, excerpt: NoteHit['excerpt']): NoteHit => ({
	note: note(title),
	excerpt,
});

const plain = (title: string, text: string) => hit(title, [{ text, hit: false }]);

const manyHits = (count: number) =>
	Array.from({ length: count }, (__, at) => plain(`Note ${String(at)}`, 'a heron'));

/** The field with its query held, as the route holds it. */
const Harness = ({
	initial = '',
	...props
}: Omit<SearchFieldProps, 'query' | 'onQuery'> & { initial?: string }) => {
	const [query, setQuery] = useState(initial);
	return <SearchField query={query} onQuery={setQuery} {...props} />;
};

const field = () => screen.getByRole('combobox', { name: 'Search notes' });
const list = () => screen.queryByRole('listbox', { name: 'Search results' });

/** A query already in the field, and the user back in it. */
const searching = async (props: Omit<SearchFieldProps, 'query' | 'onQuery'>) => {
	const user = userEvent.setup();
	render(<Harness initial="heron" {...props} />);
	await user.click(field());
	return user;
};

describe('the search field', () => {
	it('is a search landmark, with the field named for what it searches', () => {
		render(<SearchField query="" onQuery={() => undefined} />);
		expect(screen.getByRole('search')).toBeDefined();
		expect(field()).toBeDefined();
	});

	it('hands up what is typed', async () => {
		const onQuery = vi.fn();
		render(<SearchField query="" onQuery={onQuery} />);

		await userEvent.type(field(), 'h');

		expect(onQuery).toHaveBeenCalledWith('h');
	});

	it('empties the field on Escape, which is the way out', async () => {
		const onQuery = vi.fn();
		const onDismiss = vi.fn();
		render(<SearchField query="heron" onQuery={onQuery} onDismiss={onDismiss} />);

		await userEvent.type(field(), '{Escape}');

		expect(onQuery).toHaveBeenCalledWith('');
		expect(onDismiss).toHaveBeenCalled();
	});
});

describe('the answers', () => {
	it('drop from the field as the user types, and say what they are', async () => {
		const user = userEvent.setup();
		render(<Harness results={[plain('Birds', 'a heron')]} />);
		expect(list()).toBeNull();

		await user.type(field(), 'heron');

		expect(within(list() as HTMLElement).getByRole('option', { name: /Birds/ })).toBeDefined();
		expect(field().getAttribute('aria-expanded')).toBe('true');
	});

	it('are not there while the field is empty', async () => {
		const user = userEvent.setup();
		render(<Harness results={[plain('Birds', 'a heron')]} />);

		await user.click(field());

		expect(list()).toBeNull();
		expect(field().getAttribute('aria-expanded')).toBe('false');
	});

	it('say which notebook a match is in, because a search crosses all of them', async () => {
		await searching({ results: [plain('Birds', 'a heron')] });
		expect(screen.getByText(/^work ·/)).toBeDefined();
	});

	it('say which source a match is in, when told what to call it', async () => {
		await searching({
			results: [plain('Birds', 'a heron')],
			sourceName: (connectionId) => (connectionId === 'local' ? 'This device' : undefined),
		});
		expect(screen.getByText(/^This device · work ·/)).toBeDefined();
	});

	it('mark the words that matched, and leave the rest of the excerpt alone', async () => {
		await searching({
			results: [
				hit('Birds', [
					{ text: 'a ', hit: false },
					{ text: 'heron', hit: true },
					{ text: ' stood still', hit: false },
				]),
			],
		});

		expect(screen.getByText('heron', { selector: 'mark' }).tagName).toBe('MARK');
		expect(screen.getByText('stood still', { exact: false })).toBeDefined();
	});

	it('say when the list is cut short, rather than letting the rest go unmentioned', async () => {
		// One more than it shows is what `find` hands back when there are more.
		await searching({ results: manyHits(SEARCH_LIMIT + 1) });

		expect(screen.getByText(/Showing the first 50/)).toBeDefined();
		expect(screen.getAllByRole('option')).toHaveLength(SEARCH_LIMIT);
	});

	it('do not claim to have left something out of a list that is exactly full', async () => {
		await searching({ results: manyHits(SEARCH_LIMIT) });

		expect(screen.queryByText(/Showing the first/)).toBeNull();
		expect(screen.getAllByRole('option')).toHaveLength(SEARCH_LIMIT);
	});

	it('keep somewhere to speak from while a search has nothing to say', async () => {
		// A region that arrives with its words already in it is often not
		// announced at all, so it is here from the moment the list is.
		await searching({ results: [plain('Birds', 'a heron')] });
		expect(screen.getByRole('status').textContent).toBe('');
	});

	it('say when nothing matches, and name what was looked for', async () => {
		await searching({ results: [] });
		expect(screen.getByRole('status').textContent).toBe('Nothing matches “heron”.');
	});

	it('wait rather than say nothing matches before the first answer', async () => {
		await searching({ results: undefined });

		expect(screen.getByText('Searching…')).toBeDefined();
		expect(screen.queryByText(/Nothing matches/)).toBeNull();
	});

	it('speak of the query their answers are for, while the field is a letter ahead', async () => {
		// The answers follow the field a step behind (`NoteSearchField`), so
		// "nothing matches" is said of what was looked for, and not of a letter
		// nobody has looked for yet.
		await searching({ results: [], asked: 'hero' });
		expect(screen.getByRole('status').textContent).toBe('Nothing matches “hero”.');
	});

	it('say nothing at all before the first letter has been asked about', async () => {
		// Neither "searching" nor "nothing matches": the answer is a moment
		// away, and either would flash up and be gone at every first letter.
		await searching({ results: undefined, asked: '' });
		expect(screen.queryByRole('status')).toBeNull();
		expect(field().getAttribute('aria-expanded')).toBe('false');
	});

	it('go as the field is emptied, before the answers have caught up with it', async () => {
		// The answers are a step behind the field: emptied, it still has the
		// last letters' matches for a moment, and they are not left under it
		// for Enter to open one of.
		const user = userEvent.setup();
		render(
			<SearchField
				query=""
				asked="heron"
				results={[plain('Birds', 'a heron')]}
				onQuery={() => undefined}
			/>
		);
		await user.click(field());

		expect(list()).toBeNull();
		expect(field().getAttribute('aria-expanded')).toBe('false');
	});

	it('go on a press outside, and come back to the field', async () => {
		const user = await searching({ results: [plain('Birds', 'a heron')] });

		await user.click(document.body);
		expect(list()).toBeNull();

		await user.click(field());
		expect(list()).not.toBeNull();
	});
});

describe('choosing an answer', () => {
	it('hands back the note, not an id, and ends the search', async () => {
		const onChoose = vi.fn();
		const onDismiss = vi.fn();
		const found = plain('Birds', 'a heron');
		const user = await searching({ results: [found], onChoose, onDismiss });

		await user.click(screen.getByRole('option', { name: /Birds/ }));

		expect(onChoose).toHaveBeenCalledWith(found.note);
		// Emptied and put away, so it does not stay open over the note.
		expect(field()).toHaveProperty('value', '');
		expect(list()).toBeNull();
		expect(document.activeElement).not.toBe(field());
		expect(onDismiss).toHaveBeenCalled();
	});

	it('is done from the keyboard: the arrows move, and Enter opens', async () => {
		const onChoose = vi.fn();
		const results = [plain('Birds', 'a heron'), plain('Rivers', 'a heron')];
		const user = await searching({ results, onChoose });

		expect(field().getAttribute('aria-activedescendant')).toBe(
			screen.getByRole('option', { name: /Birds/ }).id
		);
		await user.keyboard('{ArrowDown}');
		expect(screen.getByRole('option', { name: /Rivers/ }).getAttribute('aria-selected')).toBe(
			'true'
		);

		await user.keyboard('{Enter}');

		expect(onChoose).toHaveBeenCalledWith(results[1]?.note);
		expect(field()).toHaveProperty('value', '');
	});

	it('wraps the arrows round the ends', async () => {
		const results = [plain('Birds', 'a heron'), plain('Rivers', 'a heron')];
		const user = await searching({ results });

		await user.keyboard('{ArrowUp}');

		expect(screen.getByRole('option', { name: /Rivers/ }).getAttribute('aria-selected')).toBe(
			'true'
		);
	});
});
