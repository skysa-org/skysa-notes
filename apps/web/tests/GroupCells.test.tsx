import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { GroupCells, SIZES, spilled } from '../src/components/GroupCells.js';

/**
 * A recovery key's groups typed into cells (`GroupCells`): the whole key's
 * twelve, or the two of a new key asked back, going on from a cell that fills
 * to the next.
 */

afterEach(cleanup);

describe('what typing into a cell makes of them', () => {
	const two = [5, 5];

	it('keeps what fits, in capitals, and stays while the cell is not full', () => {
		expect(spilled(two, ['', ''], 0, 'ab-c')).toEqual({ groups: ['ABC', ''], focus: 0 });
	});

	it('goes on to the next cell as one fills, and spills what is over into it', () => {
		expect(spilled(two, ['', ''], 0, 'abcde')).toEqual({ groups: ['ABCDE', ''], focus: 1 });
		expect(spilled(two, ['', ''], 0, 'abcde fg')).toEqual({
			groups: ['ABCDE', 'FG'],
			focus: 1,
		});
	});

	it('stays in the last cell, and drops what none of them has room for', () => {
		expect(spilled(two, ['ABCDE', ''], 1, 'fghijklm')).toEqual({
			groups: ['ABCDE', 'FGHIJ'],
			focus: 1,
		});
		// The key's last group holds three.
		expect(spilled([5, SIZES[11] ?? 0], ['', ''], 0, 'ABCDEFGHIJ').groups).toEqual([
			'ABCDE',
			'FGH',
		]);
	});

	it('empties only the cell emptied', () => {
		expect(spilled(two, ['ABCDE', 'FG'], 1, '')).toEqual({ groups: ['ABCDE', ''], focus: 1 });
	});
});

describe('the cells', () => {
	const Two = () => {
		const [groups, setGroups] = useState<readonly string[]>(['', '']);
		return (
			<GroupCells
				numbers={[2, 8]}
				groups={groups}
				typedIn={(cells, at, value) => spilled([5, 5], cells, at, value)}
				onChange={setGroups}
			/>
		);
	};

	it('are numbered as the key’s groups, and go on from one to the next and back', async () => {
		const user = userEvent.setup();
		render(<Two />);
		const third = screen.getByLabelText<HTMLInputElement>('Group 3');
		const ninth = screen.getByLabelText<HTMLInputElement>('Group 9');
		expect(
			[...document.querySelectorAll('.recovery-cell span')].map((n) => n.textContent)
		).toEqual(['3', '9']);

		await user.click(third);
		await user.keyboard('abcdefg');
		expect([third.value, ninth.value]).toEqual(['ABCDE', 'FG']);
		expect(document.activeElement).toBe(ninth);

		await user.keyboard('{Backspace}{Backspace}{Backspace}');
		// Back over the empty cell, to the end of the one before it.
		expect(document.activeElement).toBe(third);
		expect(third.selectionStart).toBe(5);
		expect(third.value).toBe('ABCDE');
	});
});
