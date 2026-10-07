import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScratchModal, Scratchpad, type ScratchpadProps } from '../src/components/Scratchpad.js';
import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { CARD_WORDS } from '../src/store/scratchpad.js';

/**
 * The scratchpad on screen (docs/ARCHITECTURE.md §7, "The scratchpad"): the
 * box to take a note in, the cards under it with the pinned first, what a card
 * shows of its note, and what its buttons ask the route to do.
 */

afterEach(cleanup);

const card = (
	id: string,
	{
		title,
		body = '',
		frontmatter = null,
	}: { title?: string; body?: string; frontmatter?: string | null } = {}
): NoteRecord =>
	({
		connectionId: LOCAL_CONNECTION_ID,
		id,
		title: title ?? 'Untitled',
		body,
		frontmatter: title === undefined ? frontmatter : `title: ${title}\n${frontmatter ?? ''}`,
		path: title === undefined ? `.scratchpad/untitled-${id}.md` : `.scratchpad/${id}.md`,
		updatedAt: 0,
		createdAt: 0,
		dirty: 0,
		deletedLocally: 0,
	}) as NoteRecord;

const milk = card('3', { body: 'Milk\n' });

const renderPad = (props: Partial<ScratchpadProps> = {}) => {
	const calls = {
		onTake: vi.fn(),
		onCloseTake: vi.fn(),
		onOpen: vi.fn(),
		onMark: vi.fn(),
		onMove: vi.fn(),
		onDelete: vi.fn(),
	};
	render(
		<Scratchpad
			notes={[]}
			takingId={undefined}
			editor={undefined}
			openId={undefined}
			liveEdits={undefined}
			{...calls}
			{...props}
		/>
	);
	return calls;
};

const cardNames = () =>
	[...document.querySelectorAll('.scratch-card')].map(
		(element) => (element as HTMLElement).dataset.id
	);

describe('the cards', () => {
	it('put the pinned first, under a name of their own beside the rest', () => {
		renderPad({
			notes: [
				card('a', { body: 'One\n' }),
				card('b', { body: 'Two\n', frontmatter: 'pinned: true\n' }),
				card('c', { body: 'Three\n' }),
			],
		});
		expect(cardNames()).toEqual(['b', 'a', 'c']);
		const [pinned, others] = screen.getAllByRole('region', { name: /Pinned|Others/ });
		expect(within(pinned!).getByText('Two')).toBeDefined();
		expect(within(others!).getByText('One')).toBeDefined();
		expect(screen.getByRole('heading', { name: 'Pinned' })).toBeDefined();
		expect(screen.getByRole('heading', { name: 'Others' })).toBeDefined();
	});

	it('name no group where there is only one', () => {
		renderPad({ notes: [card('a', { body: 'One\n' }), card('b', { body: 'Two\n' })] });
		expect(screen.queryByRole('heading', { name: 'Others' })).toBeNull();
		expect(screen.queryByRole('heading', { name: 'Pinned' })).toBeNull();
	});

	it('leave out the note being taken until it is put down', () => {
		renderPad({
			notes: [card('a', { body: 'One\n' }), card('b', { body: 'Two\n' })],
			takingId: 'a',
			editor: <div>editor</div>,
		});
		expect(cardNames()).toEqual(['b']);
	});

	it('say what the scratchpad is for when there are none, and nothing while read', () => {
		renderPad({ notes: [] });
		expect(screen.getByText('Notes you take here show up as cards.')).toBeDefined();
		cleanup();
		renderPad({ notes: undefined });
		expect(screen.queryByText('Notes you take here show up as cards.')).toBeNull();
	});
});

describe('what a card shows', () => {
	it('is its name where it has one, over the opening of what it says', () => {
		renderPad({ notes: [card('trip', { title: 'Trip', body: 'Lisbon\n\nPorto\n' })] });
		const open = screen.getByRole('button', { name: /^Trip/ });
		expect(open.querySelector('.scratch-card-title')?.textContent).toBe('Trip');
		expect(
			[...open.querySelectorAll('.scratch-card-line')].map((line) => line.textContent)
		).toEqual(['Lisbon', 'Porto']);
	});

	it('is no name where it has none, and no "Untitled" either', () => {
		renderPad({ notes: [card('1', { body: 'Milk\n' })] });
		const open = screen.getByRole('button', { name: /^Milk/ });
		expect(open.querySelector('.scratch-card-title')).toBeNull();
		expect(screen.queryByText('Untitled')).toBeNull();
	});

	it('is "Empty note" for a note with nothing in it', () => {
		renderPad({ notes: [card('1')] });
		expect(screen.getByText('Empty note')).toBeDefined();
	});

	it(`is the first ${String(CARD_WORDS)} or so words, cut with "…"`, () => {
		const words = Array.from({ length: 80 }, (_, at) => `w${String(at)}`);
		renderPad({ notes: [card('1', { body: `${words.join(' ')}\n` })] });
		const line = document.querySelector('.scratch-card-line');
		expect(line?.textContent).toBe(`${words.slice(0, CARD_WORDS).join(' ')}…`);
	});

	it('shows its colour, for the glow to be drawn by', () => {
		renderPad({ notes: [card('1', { body: 'Milk\n', frontmatter: 'color: teal\n' })] });
		expect(document.querySelector<HTMLElement>('.scratch-card')?.dataset.color).toBe('teal');
	});
});

describe('a card’s buttons', () => {
	it('open its note', () => {
		const calls = renderPad({ notes: [milk] });
		fireEvent.click(screen.getByRole('button', { name: /^Milk/ }));
		expect(calls.onOpen).toHaveBeenCalledWith(milk);
	});

	it('pin it, and unpin it once it is', () => {
		const pinned = card('2', { body: 'Eggs\n', frontmatter: 'pinned: true\n' });
		const calls = renderPad({ notes: [milk, pinned] });
		const [pinnedPin, milkPin] = screen.getAllByRole('button', { name: 'Pin' });
		expect(pinnedPin?.getAttribute('aria-pressed')).toBe('true');
		expect(milkPin?.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(milkPin!);
		expect(calls.onMark).toHaveBeenLastCalledWith(milk, { pinned: true });
		fireEvent.click(pinnedPin!);
		expect(calls.onMark).toHaveBeenLastCalledWith(pinned, { pinned: undefined });
	});

	it('colour it from the palette, the colour it has pressed, and take it away', () => {
		const yellow = card('1', { body: 'Milk\n', frontmatter: 'color: yellow\n' });
		const calls = renderPad({ notes: [yellow] });
		fireEvent.click(screen.getByRole('button', { name: 'Color' }));
		const colours = screen.getByRole('group', { name: 'Color' });
		expect(
			within(colours)
				.getAllByRole('button')
				.map((button) => button.textContent)
		).toEqual([
			'No color',
			'Red',
			'Orange',
			'Yellow',
			'Green',
			'Teal',
			'Blue',
			'Purple',
			'Pink',
		]);
		expect(
			within(colours).getByRole('button', { name: 'Yellow' }).getAttribute('aria-pressed')
		).toBe('true');
		fireEvent.click(within(colours).getByRole('button', { name: 'Blue' }));
		expect(calls.onMark).toHaveBeenLastCalledWith(yellow, { color: 'blue' });

		fireEvent.click(screen.getByRole('button', { name: 'Color' }));
		fireEvent.click(screen.getByRole('button', { name: 'No color' }));
		expect(calls.onMark).toHaveBeenLastCalledWith(yellow, { color: undefined });
	});

	it('make it a note in a notebook, or delete it, from its ⋯', () => {
		const calls = renderPad({ notes: [milk] });
		fireEvent.click(screen.getByRole('button', { name: 'Options for “Milk”' }));
		fireEvent.click(screen.getByRole('button', { name: 'Move to notebook' }));
		expect(calls.onMove).toHaveBeenCalledWith(milk);

		fireEvent.click(screen.getByRole('button', { name: 'Options for “Milk”' }));
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(calls.onDelete).toHaveBeenCalledWith(milk);
	});

	it('offer no move while something else is being moved', () => {
		renderPad({ notes: [milk], onMove: undefined });
		fireEvent.click(screen.getByRole('button', { name: 'Options for “Milk”' }));
		expect(screen.queryByRole('button', { name: 'Move to notebook' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
	});
});

describe('the box to take a note in', () => {
	it('is one line that begins a note when pressed', () => {
		const calls = renderPad();
		fireEvent.click(screen.getByRole('button', { name: 'Take a note…' }));
		expect(calls.onTake).toHaveBeenCalledOnce();
	});

	it('holds the editor in place of the line while a note is taken', () => {
		renderPad({ editor: <textarea aria-label="Body" /> });
		expect(screen.queryByRole('button', { name: 'Take a note…' })).toBeNull();
		expect(screen.getByRole('textbox', { name: 'Body' })).toBeDefined();
	});

	it('closes on Escape, and on a press outside it, but not on one inside', () => {
		const calls = renderPad({
			notes: [milk],
			editor: <textarea aria-label="Body" />,
		});
		const body = screen.getByRole('textbox', { name: 'Body' });
		fireEvent.pointerDown(body);
		expect(calls.onCloseTake).not.toHaveBeenCalled();
		fireEvent.keyDown(body, { key: 'Escape' });
		expect(calls.onCloseTake).toHaveBeenCalledOnce();
		fireEvent.pointerDown(screen.getByRole('button', { name: /^Milk/ }));
		expect(calls.onCloseTake).toHaveBeenCalledTimes(2);
	});

	it('stays open for an Escape a panel of its toolbar answered', () => {
		// As the toolbar's panels hear it: first, on the document (`FormatToolbar`).
		const claim = (event: KeyboardEvent) => {
			event.preventDefault();
		};
		document.addEventListener('keydown', claim, true);
		try {
			const calls = renderPad({ editor: <button type="button">Bold</button> });
			fireEvent.keyDown(screen.getByRole('button', { name: 'Bold' }), { key: 'Escape' });
			expect(calls.onCloseTake).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener('keydown', claim, true);
		}
	});

	it('closes on an Escape the text answered, which is the user leaving it', () => {
		const calls = renderPad({
			editor: (
				<div
					className="ProseMirror"
					role="textbox"
					tabIndex={0}
					aria-label="Text"
					onKeyDown={(event) => {
						event.preventDefault();
					}}
				/>
			),
		});
		fireEvent.keyDown(screen.getByRole('textbox', { name: 'Text' }), { key: 'Escape' });
		expect(calls.onCloseTake).toHaveBeenCalledOnce();
	});
});

describe('a card open in a dialog', () => {
	const renderModal = () => {
		const onClose = vi.fn();
		render(
			<ScratchModal color="green" onClose={onClose}>
				<button type="button">Inside</button>
			</ScratchModal>
		);
		return onClose;
	};

	it('is a dialog with the focus, in the card’s colour', () => {
		renderModal();
		const dialog = screen.getByRole('dialog', { name: 'Scratch note' });
		expect(document.activeElement).toBe(dialog);
		expect(dialog.dataset.color).toBe('green');
	});

	it('closes on Escape and on a press beside it, not on one in it', () => {
		const onClose = renderModal();
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }));
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.pointerDown(document.querySelector('.scratch-backdrop')!);
		expect(onClose).toHaveBeenCalledOnce();
		fireEvent.keyDown(screen.getByRole('button', { name: 'Inside' }), { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});
