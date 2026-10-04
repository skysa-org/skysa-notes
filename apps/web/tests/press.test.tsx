import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { onPress } from '../src/editor/press.js';

/**
 * A toolbar control pressed by a mouse, a key or a screen reader: acted on
 * once, whichever it was.
 */

afterEach(cleanup);

const controls = (...names: string[]) => {
	const acted = names.map(() => vi.fn());
	render(
		<>
			{names.map((name, index) => (
				<button key={name} type="button" {...onPress(acted[index] ?? (() => undefined))}>
					{name}
				</button>
			))}
		</>
	);
	return { acted, control: (name: string) => screen.getByRole('button', { name }) };
};

describe('a toolbar control', () => {
	it('acts on a mouse press as it goes down, and not again on the click it ends in', async () => {
		const { acted, control } = controls('Bold');
		const [bold] = acted;

		fireEvent.mouseDown(control('Bold'));
		expect(bold).toHaveBeenCalledOnce();
		fireEvent.click(control('Bold'));
		expect(bold).toHaveBeenCalledOnce();

		await userEvent.click(control('Bold'));
		expect(bold).toHaveBeenCalledTimes(2);
	});

	it('leaves the focus where it was on a mouse press', () => {
		const { control } = controls('Bold');

		// Not prevented, the browser would move focus out of the editor and
		// take its selection with it.
		expect(fireEvent.mouseDown(control('Bold'))).toBe(false);
	});

	it('acts on Enter, and on Space', async () => {
		const user = userEvent.setup();
		const { acted, control } = controls('Bold');
		control('Bold').focus();

		await user.keyboard('{Enter}');
		expect(acted[0]).toHaveBeenCalledOnce();
		await user.keyboard(' ');
		expect(acted[0]).toHaveBeenCalledTimes(2);
	});

	it('acts once on a press that is a click alone', () => {
		const { acted, control } = controls('Bold');

		fireEvent.click(control('Bold'));

		expect(acted[0]).toHaveBeenCalledOnce();
	});

	it('acts on a key after a mouse press that was let go of somewhere else', async () => {
		const user = userEvent.setup();
		const { acted, control } = controls('Bold');
		fireEvent.mouseDown(control('Bold'));
		expect(acted[0]).toHaveBeenCalledOnce();

		control('Bold').focus();
		await user.keyboard('{Enter}');

		expect(acted[0]).toHaveBeenCalledTimes(2);
	});

	it('acts on a click on one control after a mouse press on another', () => {
		const { acted, control } = controls('Bold', 'Italic');
		const [bold, italic] = acted;

		fireEvent.mouseDown(control('Bold'));
		fireEvent.click(control('Italic'));

		expect(bold).toHaveBeenCalledOnce();
		expect(italic).toHaveBeenCalledOnce();
	});
});
