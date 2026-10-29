import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type PressAwayOptions, usePressAway } from '../src/components/ui/usePressAway.js';

/**
 * A press anywhere outside what listens (#455): the menus, lists, cards and
 * panels that go when the user presses somewhere else, each with its own few
 * exceptions.
 */

const Listens = ({
	onAway,
	options,
}: {
	onAway: (event: PointerEvent) => void;
	options?: PressAwayOptions;
}) => {
	const card = useRef<HTMLDivElement>(null);
	usePressAway([card], onAway, options);
	return (
		<>
			<div ref={card}>
				<button type="button">Inside</button>
			</div>
			<button type="button" className="kept">
				Kept
			</button>
			<div role="dialog" aria-modal="true">
				<button type="button">In a dialog</button>
			</div>
			<button type="button">Elsewhere</button>
		</>
	);
};

const press = (name: string) => {
	fireEvent.pointerDown(screen.getByRole('button', { name }));
};

describe('a press away', () => {
	it('is a press outside, handed over, and not one inside', () => {
		const onAway = vi.fn();
		render(<Listens onAway={onAway} />);

		press('Inside');
		expect(onAway).not.toHaveBeenCalled();

		press('Elsewhere');
		expect(onAway).toHaveBeenCalledOnce();
		expect(onAway.mock.calls[0]?.[0]).toBeInstanceOf(Event);
	});

	it('is not a press on what else it is told is inside', () => {
		const onAway = vi.fn();
		render(<Listens onAway={onAway} options={{ inside: '.kept' }} />);

		press('Kept');

		expect(onAway).not.toHaveBeenCalled();
	});

	it('is a press in a dialog over the page, unless told otherwise', () => {
		const onAway = vi.fn();
		const { unmount } = render(<Listens onAway={onAway} />);
		press('In a dialog');
		expect(onAway).toHaveBeenCalledOnce();
		unmount();

		const answers = vi.fn();
		render(<Listens onAway={answers} options={{ ignoreModals: true }} />);
		press('In a dialog');
		expect(answers).not.toHaveBeenCalled();
	});

	it('is not listened for while it is not wanted', () => {
		const onAway = vi.fn();
		const { rerender } = render(<Listens onAway={onAway} options={{ enabled: false }} />);
		press('Elsewhere');
		expect(onAway).not.toHaveBeenCalled();

		rerender(<Listens onAway={onAway} options={{ enabled: true }} />);
		press('Elsewhere');
		expect(onAway).toHaveBeenCalledOnce();
	});

	it('is heard on the way down where asked, before what it lands on can stop it', () => {
		const stopped = vi.fn();
		const heard = vi.fn();
		render(
			<>
				<Listens onAway={stopped} />
				<Listens onAway={heard} options={{ capture: true }} />
			</>
		);
		const [elsewhere] = screen.getAllByRole('button', { name: 'Elsewhere' });
		elsewhere?.addEventListener('pointerdown', (event) => {
			event.stopPropagation();
		});

		if (elsewhere !== undefined) fireEvent.pointerDown(elsewhere);

		expect(heard).toHaveBeenCalledOnce();
		expect(stopped).not.toHaveBeenCalled();
	});

	it('calls the latest handler rendered', () => {
		const first = vi.fn();
		const latest = vi.fn();
		const { rerender } = render(<Listens onAway={first} />);
		rerender(<Listens onAway={latest} />);

		press('Elsewhere');

		expect(latest).toHaveBeenCalledOnce();
		expect(first).not.toHaveBeenCalled();
	});

	it('is not listened for once what listens has gone', () => {
		const onAway = vi.fn();
		const { unmount } = render(<Listens onAway={onAway} />);
		unmount();
		render(<button type="button">Elsewhere</button>);

		press('Elsewhere');

		expect(onAway).not.toHaveBeenCalled();
	});
});
