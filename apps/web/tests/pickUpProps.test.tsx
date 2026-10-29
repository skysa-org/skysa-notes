import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { pickUpProps } from '../src/components/ui/pickUpProps.js';

/**
 * A row's drag and right-click, a notebook's and a note's alike: where the row
 * has neither, it is left to the browser.
 */

const row = (given: Partial<Parameters<typeof pickUpProps>[0]> = {}) => {
	render(
		<button
			type="button"
			{...pickUpProps({
				text: 'Work',
				onPickUp: undefined,
				onCancelMove: () => undefined,
				onMenu: undefined,
				...given,
			})}
		>
			Work
		</button>
	);
	return screen.getByRole('button', { name: 'Work' });
};

describe('pickUpProps', () => {
	it('makes a row draggable only where it can be picked up', () => {
		expect(row().getAttribute('draggable')).toBe('false');
		cleanup();
		expect(row({ onPickUp: () => undefined }).getAttribute('draggable')).toBe('true');
	});

	it('opens the row’s menu at the pointer, in place of the browser’s', () => {
		const onMenu = vi.fn();
		// `fireEvent` answers false where the default was prevented.
		expect(fireEvent.contextMenu(row({ onMenu }), { clientX: 30, clientY: 40 })).toBe(false);
		expect(onMenu).toHaveBeenCalledWith({ x: 30, y: 40 });
	});

	it('leaves the browser’s menu alone on a row with none of its own', () => {
		expect(fireEvent.contextMenu(row(), { clientX: 30, clientY: 40 })).toBe(true);
	});
});
