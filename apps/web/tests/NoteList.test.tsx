import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteList } from '../src/components/NoteList.js';
import { type NoteRecord } from '../src/store/db.js';
import { type NoteHit, SEARCH_LIMIT } from '../src/store/search.js';

/**
 * The note list has three ways of being empty — still loading, no notebook to
 * put a note in, and an empty notebook — and telling the user the wrong one is
 * how an app that is merely slow looks broken.
 */

afterEach(cleanup);

const note = (title: string, body = ''): NoteRecord =>
	({
		id: title,
		title,
		body,
		path: `work/${title}.md`,
		updatedAt: 0,
		dirty: 0,
	}) as NoteRecord;

const renderList = (props: Partial<Parameters<typeof NoteList>[0]> = {}) =>
	render(
		<NoteList
			notes={[note('Alpha')]}
			selectedNoteId={undefined}
			onSelectNote={() => undefined}
			onCreateNote={() => undefined}
			folderPath="work"
			storeLoaded
			query=""
			onQuery={() => undefined}
			results={[]}
			{...props}
		/>
	);

const createButton = () => screen.getByRole('button', { name: 'New note' });

describe('NoteList', () => {
	it('names the open notebook', () => {
		renderList();
		expect(screen.getByRole('heading', { name: 'work' })).toBeDefined();
		expect(screen.getByText('Alpha')).toBeDefined();
	});

	it("shows the note's opening under its title, without the markdown", () => {
		renderList({
			notes: [note('Alpha', '# Alpha\n\n- turn the heap\n\n<br />\n\nevery second week\n')],
		});

		// The heading is the title, already the line above, so the preview starts
		// after it; the bullet and the break the editor writes for an empty
		// paragraph are not the user's words and are not shown (docs/PLAN.md §7).
		const preview = screen.getByText(/turn the heap/);
		expect(preview.textContent).toBe('turn the heap every second week');
	});

	it('says an open notebook is empty', () => {
		renderList({ notes: [] });
		expect(screen.getByText('No notes here yet.')).toBeDefined();
	});

	it('waits while the notes load', () => {
		renderList({ notes: undefined });
		expect(screen.getByText('Loading…')).toBeDefined();
	});

	it('asks for a notebook when there are none', () => {
		renderList({ notes: [], folderPath: undefined });
		expect(screen.getByText('Create a notebook to start writing.')).toBeDefined();
	});

	it('waits rather than asking for a notebook before the store has loaded', () => {
		renderList({ notes: undefined, folderPath: undefined, storeLoaded: false });

		expect(screen.getByText('Loading…')).toBeDefined();
		expect(screen.queryByText('Create a notebook to start writing.')).toBeNull();
	});

	it('cannot create a note with no notebook to put it in', () => {
		renderList({ notes: [], folderPath: undefined });
		expect(createButton().hasAttribute('disabled')).toBe(true);
	});

	it('can create a note once a notebook is open', () => {
		renderList();
		expect(createButton().hasAttribute('disabled')).toBe(false);
	});

	describe('at the root', () => {
		it('names the pane for what it holds rather than showing an empty path', () => {
			renderList({ folderPath: '' });
			expect(screen.getByRole('heading', { name: 'Loose notes' })).toBeDefined();
		});

		it('cannot create a note there', () => {
			// The app never adds to the loose notes; they are what the remote
			// folder already had. See docs/PLAN.md §12.6.
			renderList({ folderPath: '' });
			expect(createButton().hasAttribute('disabled')).toBe(true);
		});

		it('does not ask for a notebook, because there is somewhere to look', () => {
			renderList({ folderPath: '' });
			expect(screen.queryByText('Create a notebook to start writing.')).toBeNull();
			expect(screen.getByText('Alpha')).toBeDefined();
		});
	});
});

describe('the excerpt', () => {
	it('shows the second line of an ordinary note', () => {
		renderList({ notes: [note('Alpha', '# Alpha\n\nthe first line of prose\n')] });

		expect(screen.getByText('the first line of prose')).toBeDefined();
	});

	it('shows one for a note written on a Mac that predates OS X', () => {
		// Every line of such a note ends `\r`, so splitting on `\n` yields a
		// single line, which the heading-dropping `.slice(1)` then removes —
		// leaving the note with no excerpt at all. `splitFrontmatter` accepts
		// those files now, so they are notes like any other.
		renderList({ notes: [note('Alpha', '# Alpha\rthe first line of prose\r')] });

		expect(screen.getByText('the first line of prose')).toBeDefined();
	});
});

/**
 * Searching happens in this pane too: the same rows, answering a different
 * question. What the pane owes the user is that the two are never confused —
 * the notebook's notes while the field is empty, the matches while it is not.
 */
describe('searching', () => {
	const hit = (title: string, excerpt: NoteHit['excerpt']): NoteHit => ({
		note: note(title),
		excerpt,
	});

	const plain = (title: string, text: string) => hit(title, [{ text, hit: false }]);

	it('shows the matches instead of the notebook while there is a query', () => {
		renderList({ query: 'heron', results: [plain('Birds', 'a heron')] });

		expect(screen.getByText('Birds')).toBeDefined();
		expect(screen.queryByText('Alpha')).toBeNull();
	});

	it('names the pane for the search rather than for the notebook behind it', () => {
		renderList({ query: 'heron', results: [plain('Birds', 'a heron')] });
		expect(screen.getByRole('heading', { name: 'Search' })).toBeDefined();
	});

	it('says which notebook a match is in, because a search crosses all of them', () => {
		renderList({ query: 'heron', results: [plain('Birds', 'a heron')] });
		expect(screen.getByText(/^work ·/)).toBeDefined();
	});

	it('marks the words that matched, and leaves the rest of the excerpt alone', () => {
		renderList({
			query: 'heron',
			results: [
				hit('Birds', [
					{ text: 'a ', hit: false },
					{ text: 'heron', hit: true },
					{ text: ' stood still', hit: false },
				]),
			],
		});

		expect(screen.getByText('heron').tagName).toBe('MARK');
		expect(screen.getByText('stood still', { exact: false })).toBeDefined();
	});

	const manyHits = (count: number) =>
		Array.from({ length: count }, (__, at) => plain(`Note ${String(at)}`, 'a heron'));

	it('says when the list is cut short, rather than letting the rest go unmentioned', () => {
		// One more than it shows is what `find` hands back when there are more.
		renderList({ query: 'heron', results: manyHits(SEARCH_LIMIT + 1) });

		expect(screen.getByText(/Showing the first 50/)).toBeDefined();
		expect(screen.getAllByRole('listitem')).toHaveLength(SEARCH_LIMIT);
	});

	it('does not claim it left something out of a list that is exactly full', () => {
		renderList({ query: 'heron', results: manyHits(SEARCH_LIMIT) });

		expect(screen.queryByText(/Showing the first/)).toBeNull();
		expect(screen.getAllByRole('listitem')).toHaveLength(SEARCH_LIMIT);
	});

	it('says nothing of the sort for a list that is all of them', () => {
		renderList({ query: 'heron', results: [plain('Birds', 'a heron')] });
		expect(screen.queryByText(/Showing the first/)).toBeNull();
	});

	it('keeps somewhere to speak from while a search has nothing to say', () => {
		// A region that arrives with its words already in it is often not
		// announced at all, so it is here from the moment the search is.
		renderList({ query: 'heron', results: [plain('Birds', 'a heron')] });

		expect(screen.getByRole('status').textContent).toBe('');
	});

	it('speaks its answer, rather than changing the list in silence', () => {
		renderList({ query: 'heron', results: [] });
		expect(screen.getByRole('status').textContent).toBe('Nothing matches “heron”.');
	});

	it('offers the field as a landmark to jump to', () => {
		renderList();
		expect(screen.getByRole('search')).toBeDefined();
	});

	it('says when nothing matches, and names what was looked for', () => {
		renderList({ query: 'heron', results: [] });
		expect(screen.getByText('Nothing matches “heron”.')).toBeDefined();
	});

	it('waits rather than saying nothing matches before the first answer', () => {
		renderList({ query: 'heron', results: undefined });

		expect(screen.getByText('Searching…')).toBeDefined();
		expect(screen.queryByText(/Nothing matches/)).toBeNull();
	});

	it('gives the notebook back when the field is emptied', () => {
		renderList({ query: '', results: [plain('Birds', 'a heron')] });

		expect(screen.getByText('Alpha')).toBeDefined();
		expect(screen.queryByText('Birds')).toBeNull();
	});

	it('empties the field on Escape, which is the way out', async () => {
		const onQuery = vi.fn();
		renderList({ query: 'heron', results: [], onQuery });

		await userEvent.type(screen.getByRole('searchbox', { name: 'Search notes' }), '{Escape}');

		expect(onQuery).toHaveBeenCalledWith('');
	});

	it('is still possible to type in while a notebook is open', async () => {
		const onQuery = vi.fn();
		renderList({ onQuery });

		await userEvent.type(screen.getByRole('searchbox', { name: 'Search notes' }), 'h');

		expect(onQuery).toHaveBeenCalledWith('h');
	});
});
