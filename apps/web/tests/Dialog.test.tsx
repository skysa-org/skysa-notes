import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog, DialogActions, InlineDialog, revealField } from '../src/components/ui/Dialog.js';

/**
 * Every dialog's frame (docs/ARCHITECTURE.md §7, "Dialogs"; the owner's
 * rules, 2026-10-15): a ✕ where there is a way out, and a press outside as
 * well; Cancel in the row only while something is asked; the answer on the
 * right; and a middle that scrolls under a row that stays, keeping the field
 * being typed in in sight.
 */

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The buttons in the dialog's row, by what each says. */
const row = (): string[] =>
	[...document.querySelectorAll('.dialog-actions button')].map((button) => button.textContent);

/** The ✕ in the corner, where there is one. */
const corner = () => document.querySelector<HTMLButtonElement>('.modal-head button');

const Asking = ({ onClose, busy }: { onClose?: () => void; busy?: boolean }) => (
	<Dialog title="Delete it?" text="It goes for good." onClose={onClose} busy={busy}>
		<DialogActions
			primary={
				<button type="button" className="danger">
					Delete
				</button>
			}
		>
			<button type="button">Keep a copy</button>
		</DialogActions>
	</Dialog>
);

describe('a dialog’s way out', () => {
	it('is a ✕ in its corner, and the row’s Cancel while something is asked', async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<Asking onClose={onClose} />);

		expect(corner()?.getAttribute('aria-label')).toBe('Close');
		// Cancel first, then whatever else, and the answer last.
		expect(row()).toEqual(['Cancel', 'Keep a copy', 'Delete']);

		await user.click(screen.getByRole('button', { name: 'Close' }));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('is the ✕ alone once nothing is asked, and no row where there is nothing to put in it', () => {
		render(
			<Dialog title="What it keeps" onClose={vi.fn()} cancel={false}>
				<p>Nothing but notes.</p>
				<DialogActions />
			</Dialog>
		);

		expect(corner()).not.toBeNull();
		expect(document.querySelector('.dialog-actions')).toBeNull();
		expect(document.querySelector('.dialog-foot')).toBeNull();
		// Nothing else to take it: the ✕ has the focus.
		expect(document.activeElement).toBe(corner());
	});

	it('is none at all where the dialog has to be answered: no ✕, no Cancel', () => {
		render(<Asking />);

		expect(corner()).toBeNull();
		expect(row()).toEqual(['Keep a copy', 'Delete']);
	});

	it('is a press on the page around it, and not one in it', async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<Asking onClose={onClose} />);
		const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
		if (backdrop === null) throw new Error('no backdrop');

		await user.click(screen.getByText('It goes for good.'));
		expect(onClose).not.toHaveBeenCalled();
		await user.click(backdrop);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('is not a press begun in the dialog and let go outside it, as a drag across a field is', () => {
		const onClose = vi.fn();
		render(<Asking onClose={onClose} />);
		const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
		if (backdrop === null) throw new Error('no backdrop');

		fireEvent.pointerDown(screen.getByText('It goes for good.'));
		// Down and up on different elements: the click lands on what holds both.
		fireEvent.click(backdrop);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('is not a press begun outside it and let go in it', async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<Asking onClose={onClose} />);
		const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
		if (backdrop === null) throw new Error('no backdrop');

		await user.pointer([
			{ keys: '[MouseLeft>]', target: backdrop },
			{ target: screen.getByText('It goes for good.') },
			{ keys: '[/MouseLeft]' },
		]);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('is a press outside still when the page draws again while it is held', () => {
		const first = vi.fn();
		const onClose = vi.fn();
		const { rerender } = render(<Asking onClose={first} />);
		const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
		if (backdrop === null) throw new Error('no backdrop');

		fireEvent.pointerDown(backdrop);
		// A handler made anew, as an inline one is on every draw.
		rerender(<Asking onClose={onClose} />);
		fireEvent.pointerUp(backdrop);
		fireEvent.click(backdrop);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(first).not.toHaveBeenCalled();
	});

	it('waits while something it would not stop is under way: the ✕, a press outside and Escape', async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<Asking onClose={onClose} busy />);
		const backdrop = document.querySelector<HTMLElement>('.modal-backdrop');
		if (backdrop === null) throw new Error('no backdrop');

		expect(corner()?.disabled).toBe(true);
		await user.click(backdrop);
		await user.keyboard('{Escape}');
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe('a dialog’s row', () => {
	it('is at the foot of one over everything, and in place in a question asked in a panel', () => {
		render(
			<>
				<Asking onClose={vi.fn()} />
				<InlineDialog label="Disconnect?" onClose={vi.fn()}>
					<DialogActions primary={<button type="button">Disconnect</button>} />
				</InlineDialog>
			</>
		);

		const over = document.querySelector('.modal .dialog-actions');
		const inPlace = document.querySelector('[role="group"] .dialog-actions');
		expect(over?.parentElement?.className).toBe('dialog-foot');
		expect(inPlace?.closest('.dialog-foot')).toBeNull();
		// The question asked in place has no ✕: its Cancel is its way out.
		expect(
			[...(inPlace?.querySelectorAll('button') ?? [])].map((button) => button.textContent)
		).toEqual(['Cancel', 'Disconnect']);
	});
});

describe('the focus', () => {
	/** A dialog that says nothing until what it shows is known, then asks. */
	const Finding = () => {
		const [known, setKnown] = useState(false);
		return (
			<Dialog title="Vault" onClose={vi.fn()} cancel={known}>
				{known ? (
					<DialogActions primary={<button type="button">Make a key</button>} />
				) : (
					<button
						type="button"
						className="find"
						tabIndex={-1}
						onClick={() => {
							setKnown(true);
						}}
					>
						Checking…
					</button>
				)}
			</Dialog>
		);
	};

	it('goes on from the ✕ to the answer a step then draws, where it was put on the ✕ for want of one', () => {
		render(<Finding />);
		expect(document.activeElement).toBe(corner());

		act(() => {
			document.querySelector<HTMLButtonElement>('.find')?.click();
		});
		// Taken by a mutation observer, which reports after the render.
		return vi.waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Make a key' }));
		});
	});
});

describe('the middle, as the window gets shorter', () => {
	/** A box laid out at `top`..`bottom`, as jsdom lays out nothing. */
	const at = (element: Element, top: number, bottom: number) => {
		vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
			top,
			bottom,
			height: bottom - top,
			left: 0,
			right: 300,
			width: 300,
			x: 0,
			y: top,
			toJSON: () => ({}),
		});
	};

	/** What the middle was scrolled by. */
	const scrolledBy = (body: HTMLElement) => {
		const by: number[] = [];
		Object.defineProperty(body, 'scrollBy', {
			configurable: true,
			value: ({ top }: { top: number }) => by.push(top),
		});
		return by;
	};

	const Form = () => (
		<Dialog title="A form" onClose={vi.fn()} onSubmit={vi.fn()}>
			<input aria-label="Name" />
			<input aria-label="Place" />
			<DialogActions primary={<button type="submit">Save</button>} />
		</Dialog>
	);

	const parts = () => {
		const body = document.querySelector<HTMLElement>('.modal-body');
		const foot = document.querySelector<HTMLElement>('.dialog-foot');
		if (body === null || foot === null) throw new Error('no middle');
		Object.defineProperty(foot, 'offsetHeight', { configurable: true, value: 60 });
		return { body, foot };
	};

	it('brings the field being typed in back into sight over the row, a frame after the window got shorter', () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
		render(<Form />);
		const { body } = parts();
		const place = screen.getByLabelText('Place');
		place.focus();
		const by = scrolledBy(body);

		// The keyboard up: the middle ends at 300, its row over the last 60.
		at(body, 100, 300);
		at(place, 260, 290);
		fireEvent(window, new Event('resize'));
		expect(by).toEqual([]);
		frames.forEach((frame) => {
			frame(0);
		});

		// Its bottom 12px over the row: 290 - (300 - 60 - 12).
		expect(by).toEqual([62]);
	});

	it('brings a field above the top down, and leaves one in sight where it is', () => {
		render(<Form />);
		const { body } = parts();
		const name = screen.getByLabelText('Name');
		const by = scrolledBy(body);
		at(body, 100, 300);

		at(name, 150, 180);
		revealField(body, name);
		expect(by).toEqual([]);

		at(name, 60, 90);
		revealField(body, name);
		expect(by).toEqual([-52]);
	});

	it('never scrolls a field taller than the room past its own top', () => {
		render(<Form />);
		const { body } = parts();
		const name = screen.getByLabelText('Name');
		const by = scrolledBy(body);
		at(body, 100, 300);
		at(name, 150, 400);

		revealField(body, name);
		// Its top to the top of the room, no further: 150 - (100 + 12).
		expect(by).toEqual([38]);
	});

	it('says when there is more above or below, for the lines under the title and over the row', () => {
		render(<Form />);
		const { body } = parts();
		const dialog = document.querySelector('.modal');
		Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 });
		Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 500 });

		fireEvent.scroll(body);
		expect(dialog?.hasAttribute('data-more')).toBe(true);
		expect(dialog?.hasAttribute('data-scrolled')).toBe(false);

		Object.defineProperty(body, 'scrollTop', { configurable: true, value: 300 });
		fireEvent.scroll(body);
		expect(dialog?.hasAttribute('data-more')).toBe(false);
		expect(dialog?.hasAttribute('data-scrolled')).toBe(true);
	});
});
