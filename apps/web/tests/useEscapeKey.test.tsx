import { fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useEscapeKey } from '../src/components/ui/useEscapeKey.js';

/**
 * Escape as a way out (#455): the nearest thing answers it, and once one has,
 * nothing further out does.
 */

const OnWindow = ({ onEscape, enabled }: { onEscape: () => void; enabled?: boolean }) => {
	useEscapeKey(onEscape, { enabled });
	return null;
};

const Within = ({ onEscape, children }: { onEscape: () => void; children?: ReactNode }) => {
	const group = useRef<HTMLDivElement>(null);
	useEscapeKey(onEscape, { within: group });
	return (
		<div ref={group}>
			<button type="button">Inside</button>
			{children}
		</div>
	);
};

const escape = (on: Element | Window = document.body) => fireEvent.keyDown(on, { key: 'Escape' });

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Escape', () => {
	it('is answered from anywhere when it is heard on the window', () => {
		const onEscape = vi.fn();
		render(<OnWindow onEscape={onEscape} />);

		escape();

		expect(onEscape).toHaveBeenCalledOnce();
	});

	it('is not answered for another key', () => {
		const onEscape = vi.fn();
		render(<OnWindow onEscape={onEscape} />);

		fireEvent.keyDown(document.body, { key: 'Enter' });

		expect(onEscape).not.toHaveBeenCalled();
	});

	it('is left alone once something nearer has answered it', () => {
		const onEscape = vi.fn();
		render(<OnWindow onEscape={onEscape} />);
		const nearer = (event: KeyboardEvent) => {
			event.preventDefault();
		};
		document.addEventListener('keydown', nearer);

		escape();
		document.removeEventListener('keydown', nearer);

		expect(onEscape).not.toHaveBeenCalled();
	});

	it('answered within an element, is claimed, so what it is in stays', () => {
		const inner = vi.fn();
		const outer = vi.fn();
		render(
			<>
				<OnWindow onEscape={outer} />
				<Within onEscape={inner} />
			</>
		);

		escape(screen.getByRole('button', { name: 'Inside' }));

		expect(inner).toHaveBeenCalledOnce();
		expect(outer).not.toHaveBeenCalled();
	});

	it('answered on the window, is not claimed: two things there both go', () => {
		// Side by side rather than one in the other — a dropdown, a move — so
		// which listened first is no reason for one to stay.
		const first = vi.fn();
		const second = vi.fn();
		render(
			<>
				<OnWindow onEscape={first} />
				<OnWindow onEscape={second} />
			</>
		);

		escape();

		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
	});

	it('is left to a field ending a composition with it', () => {
		const onEscape = vi.fn();
		render(<OnWindow onEscape={onEscape} />);

		fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });

		expect(onEscape).not.toHaveBeenCalled();
	});

	it('within an element, is answered only there', () => {
		const onEscape = vi.fn();
		render(
			<>
				<Within onEscape={onEscape} />
				<button type="button">Outside</button>
			</>
		);

		escape(screen.getByRole('button', { name: 'Outside' }));
		expect(onEscape).not.toHaveBeenCalled();

		escape(screen.getByRole('button', { name: 'Inside' }));
		expect(onEscape).toHaveBeenCalledOnce();
	});

	it('is not listened for while it is not wanted, nor once what listened has gone', () => {
		const onEscape = vi.fn();
		const { rerender, unmount } = render(<OnWindow onEscape={onEscape} enabled={false} />);
		escape();
		expect(onEscape).not.toHaveBeenCalled();

		rerender(<OnWindow onEscape={onEscape} enabled />);
		escape();
		expect(onEscape).toHaveBeenCalledOnce();

		unmount();
		escape();
		expect(onEscape).toHaveBeenCalledOnce();
	});

	it('calls the latest handler rendered', () => {
		const first = vi.fn();
		const latest = vi.fn();
		const { rerender } = render(<OnWindow onEscape={first} />);
		rerender(<OnWindow onEscape={latest} />);

		escape();

		expect(latest).toHaveBeenCalledOnce();
		expect(first).not.toHaveBeenCalled();
	});
});
