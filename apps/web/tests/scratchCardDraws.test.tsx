import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Scratchpad, type ScratchpadProps } from '../src/components/Scratchpad.js';
import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import type * as VisibleText from '../src/store/visibleText.js';

/**
 * The page draws the scratchpad again on every autosave and sync run, and
 * hands it new handlers each time. A card is drawn again only when what it
 * shows changes (#275): here, a card's drawing is counted by the opening it
 * asks for, which every drawn card does.
 */
const drawn = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock('../src/store/visibleText.js', async (importOriginal) => {
	const actual = await importOriginal<typeof VisibleText>();
	return {
		...actual,
		openingBlocks: (body: string, options?: { keep?: boolean }) => {
			drawn.bodies.push(body);
			return actual.openingBlocks(body, options);
		},
	};
});

afterEach(cleanup);

beforeEach(() => {
	drawn.bodies = [];
});

const card = (id: string): NoteRecord =>
	({
		connectionId: LOCAL_CONNECTION_ID,
		id,
		title: 'Untitled',
		body: `${id} body\n`,
		frontmatter: null,
		path: `.scratchpad/untitled-${id}.md`,
		updatedAt: 0,
		createdAt: 0,
		dirty: 0,
		deletedLocally: 0,
	}) as NoteRecord;

const [milk, eggs, bread] = [card('milk'), card('eggs'), card('bread')] as const;

/** The scratchpad as the page draws it: every handler made anew. */
const props = (changed: Partial<ScratchpadProps> = {}): ScratchpadProps => ({
	notes: [milk, eggs, bread],
	takingId: undefined,
	editor: undefined,
	onTake: () => undefined,
	onCloseTake: () => undefined,
	openId: undefined,
	onOpen: () => undefined,
	onMark: () => undefined,
	onMove: () => undefined,
	onDelete: () => undefined,
	liveEdits: undefined,
	...changed,
});

const drawPad = (first: Partial<ScratchpadProps> = {}) => {
	const { rerender } = render(<Scratchpad {...props(first)} />);
	drawn.bodies = [];
	return (again: Partial<ScratchpadProps> = {}) => {
		rerender(<Scratchpad {...props(again)} />);
	};
};

describe('a scratchpad card', () => {
	it('is not drawn again when the page draws the same notes with new handlers', () => {
		const drawAgain = drawPad();
		drawAgain({ notes: [milk, eggs, bread] });
		expect(drawn.bodies).toEqual([]);
	});

	it('is drawn again for its own note changed, and no other is', () => {
		const drawAgain = drawPad();
		drawAgain({ notes: [milk, { ...eggs, body: 'eggs, a dozen\n', updatedAt: 1 }, bread] });
		expect(drawn.bodies).toEqual(['eggs, a dozen\n']);
	});

	it('is drawn again as it opens or closes, and no other is', () => {
		const drawAgain = drawPad({ openId: milk.id });
		drawAgain({ openId: bread.id });
		expect([...drawn.bodies].sort()).toEqual([bread.body, milk.body]);
	});

	it('calls the handlers the page gave last, though it was not drawn again', () => {
		const first = { onOpen: vi.fn(), onMark: vi.fn() };
		const last = { onOpen: vi.fn(), onMark: vi.fn() };
		const drawAgain = drawPad(first);
		drawAgain(last);

		const eggsCard = document.querySelector('[data-id="eggs"]');
		if (!(eggsCard instanceof HTMLElement)) throw new Error('no card');
		fireEvent.click(within(eggsCard).getByRole('button', { name: /eggs body/ }));
		fireEvent.click(within(eggsCard).getByRole('button', { name: 'Pin' }));

		expect(first.onOpen).not.toHaveBeenCalled();
		expect(first.onMark).not.toHaveBeenCalled();
		expect(last.onOpen).toHaveBeenCalledWith(eggs);
		expect(last.onMark).toHaveBeenCalledWith(eggs, { pinned: true });
	});
});
