import { ROOT } from '@skysa/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteList } from '../src/components/NoteList.js';
import { type NoteRecord } from '../src/store/db.js';

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
		// paragraph are not the user's words and are not shown (docs/ARCHITECTURE.md §7).
		const preview = screen.getByText(/turn the heap/);
		expect(preview.textContent).toBe('turn the heap | every second week');
	});

	it('passes over a line that says only when the note was made, as OneNote writes one', () => {
		renderList({
			notes: [
				{
					...note(
						'Links',
						'# Links\n\n*Monday, January 13, 2020 2:44 PM*\n\nAdd okta to the site\n'
					),
					createdAt: Date.UTC(2020, 0, 13, 19, 44, 34),
				},
				{
					...note('Plans', '# Plans\n\nMonday, January 13, 2020: what we agreed\n'),
					createdAt: Date.UTC(2020, 0, 13, 19, 44, 34),
				},
			],
		});

		expect(screen.getByText(/okta/).textContent).toBe('Add okta to the site');
		// More than the date is the user's own words, and stays.
		expect(screen.getByText(/what we agreed/).textContent).toBe(
			'Monday, January 13, 2020: what we agreed'
		);
	});

	it('passes over the date above the title, and a time on the line after it', () => {
		const made = Date.UTC(2020, 0, 13, 19, 44, 34);
		renderList({
			notes: [
				{
					...note('Links', 'Monday, January 13, 2020\n\n# Links\n\nAdd okta\n'),
					createdAt: made,
				},
				{
					...note(
						'Plans',
						'# Plans\n\nMonday, January 13, 2020\n\n2:44 PM\n\nAgree the plan\n'
					),
					createdAt: made,
				},
			],
		});

		expect(screen.getByText(/okta/).textContent).toBe('Add okta');
		expect(screen.getByText(/Agree/).textContent).toBe('Agree the plan');
	});

	it('marks where one line of the note ends and the next begins', () => {
		renderList({
			notes: [note('Alpha', '# Alpha\n\nBuy milk\nCall the bank\n\nThen   lunch.\n')],
		});

		// Broken inside a paragraph or between two, it is a line on screen; the
		// spaces inside a line are still only spaces.
		expect(screen.getByText(/Buy milk/).textContent).toBe(
			'Buy milk | Call the bank | Then lunch.'
		);
	});

	it('shows the words the rich editor shows, and none of the syntax around them', () => {
		renderList({
			notes: [
				note(
					'Alpha',
					'# Alpha\n\nA **bold** plan, a [link](https://example.com) and `code`.\n\n- [ ] a task\n'
				),
			],
		});

		expect(screen.getByText(/bold plan/).textContent).toBe(
			'A bold plan, a link and code. | a task'
		);
	});

	it('keeps the first line when the note does not open with its title', () => {
		// This body is what Milkdown writes when the user presses Enter at the
		// very start of a note (pinned in tests/rich.test.ts). Dropping the first
		// readable line on the assumption that it is the heading lost "turn the
		// heap" — a line the user wrote — from the row.
		renderList({
			notes: [note('Alpha', '<br />\n\nturn the heap\n\nevery second week\n')],
		});

		expect(screen.getByText(/turn the heap/).textContent).toBe(
			'turn the heap | every second week'
		);
	});

	it('does not print a heading twice when it was written with emphasis', () => {
		// The title comes from the parsed heading, so `# **Alpha**` derives
		// "Alpha" while the line still reads `**Alpha**`. Same heading, two
		// spellings.
		renderList({ notes: [note('Alpha', '# **Alpha**\n\nthen the body\n')] });

		expect(screen.getByText(/then the body/).textContent).toBe('then the body');
	});

	it('does not print a heading twice when its own text contains an underscore', () => {
		// `mdast-util-to-string` removes the characters that *were* emphasis and
		// leaves the rest, so a title of `setup_guide` keeps its underscore.
		// Ignoring emphasis on the line but not on the title left "setupguide"
		// against "setup_guide", and the heading was printed twice after all.
		renderList({
			notes: [note('setup_guide', '# setup_guide\n\nrun the installer\n')],
		});

		expect(screen.getByText(/run the installer/).textContent).toBe('run the installer');
	});

	it('keeps an introduction that comes before the heading', () => {
		renderList({ notes: [note('Alpha', 'a word first\n\n# Alpha\n\nthen the body\n')] });

		expect(screen.getByText(/a word first/).textContent).toBe(
			'a word first | Alpha | then the body'
		);
	});

	it('says an open notebook is empty, and offers to make its first note', () => {
		let created = 0;
		renderList({
			notes: [],
			onCreateNote: () => {
				created += 1;
			},
		});
		expect(screen.getByText(/No notes here yet\./).textContent).toBe(
			'No notes here yet. Create one.'
		);

		screen.getByRole('button', { name: 'Create one' }).click();
		expect(created).toBe(1);
	});

	it('does not offer to make a note among the loose ones, which are only imported', () => {
		renderList({ notes: [], folderPath: ROOT });
		expect(screen.getByText('No notes here yet.')).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Create one' })).toBeNull();
	});

	it('waits while the notes load', () => {
		renderList({ notes: undefined });
		expect(screen.getByText('Loading…')).toBeDefined();
	});

	it('opens the note’s menu on a right-click, about the note clicked', () => {
		const chosen: string[] = [];
		renderList({
			notes: [note('Alpha'), note('Beta')],
			menuFor: (row) => [
				{
					label: 'Delete',
					onChoose: () => {
						chosen.push(row.title);
					},
				},
			],
		});

		fireEvent.contextMenu(screen.getByRole('button', { name: /^Beta/ }), {
			clientX: 10,
			clientY: 10,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		expect(chosen).toEqual(['Beta']);
		expect(screen.queryByRole('group', { name: 'Note “Beta”' })).toBeNull();
	});

	it('ends every row in a `⋯` with the same menu, about that row’s note', () => {
		const chosen: string[] = [];
		renderList({
			notes: [note('Alpha'), note('Beta'), note('Draft')],
			unsavedNoteId: 'Draft',
			menuFor: (row) => [
				{
					label: 'Delete',
					onChoose: () => {
						chosen.push(row.title);
					},
				},
			],
		});

		const beta = screen.getByRole('button', { name: 'Options for “Beta”' });
		// Beside the row's button rather than in it, at the row's end.
		expect(screen.getByRole('button', { name: /^Beta/ }).contains(beta)).toBe(false);
		expect(beta.closest('.row-item')).toBe(
			screen.getByRole('button', { name: /^Beta/ }).parentElement
		);
		fireEvent.click(beta);
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(chosen).toEqual(['Beta']);

		// A note not stored yet has nothing to move or delete.
		expect(
			screen.getByRole('button', { name: 'Options for “Draft”' }).hasAttribute('disabled')
		).toBe(true);
		// And the header has only its `+`.
		expect(screen.queryByRole('button', { name: 'Note options' })).toBeNull();
	});

	it('tints a pinned note and says it is pinned, beside its name', () => {
		renderList({ notes: [note('Alpha'), note('Beta')], pinnedNoteIds: new Set(['Alpha']) });

		const pinned = screen.getByRole('button', { name: /^Alpha/ });
		expect(pinned.classList.contains('pinned')).toBe(true);
		const described = pinned.getAttribute('aria-describedby');
		expect(described === null ? null : document.getElementById(described)?.textContent).toBe(
			'Pinned'
		);
		const other = screen.getByRole('button', { name: /^Beta/ });
		expect(other.classList.contains('pinned')).toBe(false);
		expect(other.hasAttribute('aria-describedby')).toBe(false);
	});

	it('leaves the browser its own menu where it is given none', () => {
		renderList({ notes: [note('Alpha')] });
		expect(fireEvent.contextMenu(screen.getByRole('button', { name: /^Alpha/ }))).toBe(true);
	});

	it('asks for a notebook when there are none', () => {
		renderList({ notes: [], folderPath: undefined });
		expect(screen.getByText('Create a notebook to start writing.')).toBeDefined();
	});

	it('makes the ask for a notebook the way to one, where it is given', () => {
		let asked = 0;
		renderList({
			notes: [],
			folderPath: undefined,
			onCreateNotebook: () => {
				asked += 1;
			},
		});

		screen.getByRole('button', { name: 'Create a notebook' }).click();
		expect(asked).toBe(1);
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
			// folder already had. See docs/ARCHITECTURE.md §12.6.
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
