import { useLayoutEffect, useRef } from 'react';

import { t } from '../i18n/t.js';

/**
 * How many characters each of a recovery key's groups holds: eleven of five,
 * then three, as the key is shown and printed (`recoveryKeyGroups`).
 */
export const SIZES: readonly number[] = [...Array.from({ length: 11 }, () => 5), 3];

/** What was typed in a group, as the key spells it: no spaces or hyphens, in capitals. */
export const asTyped = (text: string): string => text.replace(/[\s-]+/gu, '').toUpperCase();

/** What the cells hold after a keystroke or a paste, and the cell the cursor goes to. */
export type Typed = Readonly<{ groups: readonly string[]; focus: number }>;

/** `text` in the cells from `from` on, as far as it goes; the cells before kept. */
const filledFrom = (
	sizes: readonly number[],
	groups: readonly string[],
	from: number,
	text: string
) => {
	// Where in `text` each cell from `from` on begins.
	const starts = sizes.map((_, index) =>
		sizes.slice(from, index).reduce((sum, size) => sum + size, 0)
	);
	const reached = (index: number) => index >= from && (starts[index] ?? 0) < text.length;
	const next = groups.map((group, index) => {
		const start = starts[index] ?? 0;
		return reached(index) ? text.slice(start, start + (sizes[index] ?? 0)) : group;
	});
	return { groups: next, last: sizes.findLastIndex((_, index) => reached(index)) };
};

/**
 * What typing `value` into cell `at`, of cells holding `sizes`, makes of them:
 * a cell that fills goes on to the next, and more than it holds, as a paste
 * is, goes on into those after it, as far as the last.
 */
export const spilled = (
	sizes: readonly number[],
	groups: readonly string[],
	at: number,
	value: string
): Typed => {
	const typed = asTyped(value);
	if (typed === '') {
		return { groups: groups.map((group, index) => (index === at ? '' : group)), focus: at };
	}
	const filled = filledFrom(sizes, groups, at, typed);
	const full = (filled.groups[filled.last]?.length ?? 0) === sizes[filled.last];
	return {
		groups: filled.groups,
		focus: full ? Math.min(filled.last + 1, sizes.length - 1) : filled.last,
	};
};

export interface GroupCellsProps {
	/** Which of the key's groups each cell is, counted from 0: its number over it. */
	numbers: readonly number[];
	/** What each cell holds. */
	groups: readonly string[];
	/** What typing into a cell makes of them all, and the cell to go on to. */
	typedIn: (groups: readonly string[], at: number, value: string) => Typed;
	onChange: (groups: readonly string[]) => void;
}

/**
 * A recovery key's groups typed into cells, each numbered as the key is shown
 * and printed, and laid out as it is: the whole key (`PasteKey`), or the two
 * of a new one asked back (`SecretsDialog`). Typing goes on from a cell that
 * fills to the next, and Backspace in an empty one goes back to the one before.
 */
export const GroupCells = ({ numbers, groups, typedIn, onChange }: GroupCellsProps) => {
	const fields = useRef<(HTMLInputElement | null)[]>([]);
	// The cell to go on to, once what was typed is drawn: its own words
	// selected, to be typed over, unless what was typed went on into them.
	const going = useRef<Readonly<{ at: number; over: boolean }> | undefined>(undefined);
	useLayoutEffect(() => {
		const to = going.current;
		going.current = undefined;
		const field = to === undefined ? null : fields.current[to.at];
		if (to === undefined || field === null || field === undefined) return;
		field.focus();
		field.setSelectionRange(to.over ? 0 : field.value.length, field.value.length);
	});
	return (
		<div className="recovery-cells">
			{groups.map((group, at) => {
				const number = (numbers[at] ?? at) + 1;
				return (
					// The groups are the key: their place is what tells them apart.
					<label key={at} className="recovery-cell">
						<span aria-hidden="true">{number}</span>
						<input
							ref={(element) => {
								fields.current[at] = element;
							}}
							className="group-field"
							aria-label={t('secrets.check.group', { number })}
							autoComplete="off"
							autoCapitalize="characters"
							autoCorrect="off"
							spellCheck={false}
							value={group}
							onChange={(event) => {
								const next = typedIn(groups, at, event.target.value);
								if (next.focus !== at) {
									going.current = {
										at: next.focus,
										over: next.groups[next.focus] === groups[next.focus],
									};
								}
								onChange(next.groups);
							}}
							onKeyDown={(event) => {
								// Back over an empty cell, to the end of the one before it.
								if (event.key !== 'Backspace' || group !== '' || at === 0) return;
								event.preventDefault();
								const before = fields.current[at - 1];
								before?.focus();
								before?.setSelectionRange(before.value.length, before.value.length);
							}}
						/>
					</label>
				);
			})}
		</div>
	);
};
