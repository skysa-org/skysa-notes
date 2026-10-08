import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteList, type NoteListProps } from '../src/components/NoteList.js';
import { type NoteRecord } from '../src/store/db.js';
import type * as VisibleText from '../src/store/visibleText.js';

/**
 * The page draws the list again on every autosave, every sync run and every
 * keystroke in the search field, and hands it new handlers each time. A row is
 * drawn again only when what it shows changes (#275): here, a row's drawing is
 * counted by the opening it asks for, which every drawn row does.
 */
const drawn = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock('../src/store/visibleText.js', async (importOriginal) => {
	const actual = await importOriginal<typeof VisibleText>();
	return {
		...actual,
		openingLines: (body: string, options?: { keep?: boolean }) => {
			drawn.bodies.push(body);
			return actual.openingLines(body, options);
		},
	};
});

afterEach(cleanup);

beforeEach(() => {
	drawn.bodies = [];
});

const note = (title: string): NoteRecord =>
	({
		id: title,
		title,
		body: `${title} body\n`,
		path: `work/${title}.md`,
		updatedAt: 0,
		dirty: 0,
	}) as NoteRecord;

const [alpha, beta, gamma] = [note('Alpha'), note('Beta'), note('Gamma')] as const;

/** The list as the page draws it: every handler made anew. */
const props = (changed: Partial<NoteListProps> = {}): NoteListProps => ({
	notes: [alpha, beta, gamma],
	selectedNoteId: alpha.id,
	onSelectNote: () => undefined,
	onCreateNote: () => undefined,
	onPickUpNote: () => undefined,
	onCancelMove: () => undefined,
	menuFor: () => [{ label: 'Delete', onChoose: () => undefined }],
	folderPath: 'work',
	storeLoaded: true,
	...changed,
});

const drawList = (first: Partial<NoteListProps> = {}) => {
	const { rerender } = render(<NoteList {...props(first)} />);
	drawn.bodies = [];
	return (again: Partial<NoteListProps> = {}) => {
		rerender(<NoteList {...props(again)} />);
	};
};

describe('a row of the note list', () => {
	it('is not drawn again when the page draws the same notes with new handlers', () => {
		const drawAgain = drawList();
		drawAgain({ notes: [alpha, beta, gamma] });
		expect(drawn.bodies).toEqual([]);
	});

	it('is drawn again for its own note changed, and no other is', () => {
		const drawAgain = drawList();
		drawAgain({ notes: [alpha, { ...beta, body: 'Beta edited\n', updatedAt: 1 }, gamma] });
		expect(drawn.bodies).toEqual(['Beta edited\n']);
	});

	it('is drawn again as the selection moves on to it or off it, and no other is', () => {
		const drawAgain = drawList();
		drawAgain({ selectedNoteId: gamma.id });
		expect([...drawn.bodies].sort()).toEqual([alpha.body, gamma.body]);
	});

	it('calls the handler the page gave last, though it was not drawn again', () => {
		const first = vi.fn();
		const last = vi.fn();
		const drawAgain = drawList({ onSelectNote: first });
		drawAgain({ onSelectNote: last });

		fireEvent.click(screen.getByRole('button', { name: /^Beta/ }));

		expect(first).not.toHaveBeenCalled();
		expect(last).toHaveBeenCalledWith(beta);
	});

	it('makes its menu when it is opened, and not before', () => {
		const menuFor = vi.fn((_row: NoteRecord) => [
			{ label: 'Delete', onChoose: () => undefined },
		]);
		const drawAgain = drawList({ menuFor });
		drawAgain({ menuFor });
		expect(menuFor).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Options for “Beta”' }));

		expect(menuFor).toHaveBeenCalledWith(beta);
		expect(menuFor.mock.calls.every(([asked]) => asked === beta)).toBe(true);
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
	});
});
