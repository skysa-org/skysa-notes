import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NoteList } from '../src/components/NoteList.js';
import { type NoteRecord } from '../src/store/db.js';

/**
 * The note list has three ways of being empty — still loading, no notebook to
 * put a note in, and an empty notebook — and telling the user the wrong one is
 * how an app that is merely slow looks broken.
 */

afterEach(cleanup);

const note = (title: string): NoteRecord =>
	({
		id: title,
		title,
		body: '',
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
