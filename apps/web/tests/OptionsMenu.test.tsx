import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { OptionsMenu } from '../src/components/ui/OptionsMenu.js';

/**
 * A `⋯` button's menu, and the ways it goes besides a choice: its own button
 * pressed again, and a press anywhere else.
 */

const shown = () =>
	render(
		<>
			<OptionsMenu
				label="Note options"
				title="Options"
				groupLabel="Note"
				triggerClassName="row-options"
				trigger="⋯"
				items={[{ label: 'Rename', onChoose: vi.fn() }]}
			/>
			<p>Elsewhere</p>
		</>
	);

const menu = () => screen.queryByRole('group', { name: 'Note' });

describe('a menu opened from its button', () => {
	it('shuts on a second press on the button, which is not a press outside', async () => {
		// Taken as a press outside, the menu would shut on the way down and the
		// button's click would open it again.
		const user = userEvent.setup();
		shown();
		const button = screen.getByRole('button', { name: 'Note options' });

		await user.click(button);
		expect(menu()).not.toBeNull();

		await user.click(button);
		expect(menu()).toBeNull();
	});

	it('goes at a press elsewhere, and leaves the focus where the press put it', async () => {
		// The user has said where they want to be; taking the focus back to the
		// button would undo the press.
		const user = userEvent.setup();
		shown();
		const button = screen.getByRole('button', { name: 'Note options' });
		await user.click(button);

		fireEvent.pointerDown(screen.getByText('Elsewhere'));

		expect(menu()).toBeNull();
		expect(document.activeElement).not.toBe(button);
	});
});
