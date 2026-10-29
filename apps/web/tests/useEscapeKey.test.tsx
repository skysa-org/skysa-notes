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

	it('answered, is claimed, so one Escape shuts the nearest thing only', () => {
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
		unmount();
		escape();
		expect(onEscape).not.toHaveBeenCalled();
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
