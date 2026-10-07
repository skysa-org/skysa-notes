import { SCRATCH_COLORS, type ScratchColor } from '@skysa/core';

import { t } from '../i18n/t.js';
import { type OptionsMenuItem } from './OptionsMenu.js';

/**
 * What can be done to a scratch card, wherever it is offered from: the card's
 * own buttons on the scratchpad, and the bar under its editor
 * (docs/ARCHITECTURE.md §7, "The scratchpad").
 */

/** What making a scratch card a note is called, wherever it is offered. */
export const MOVE_LABEL = t('scratchpad.menu.move');

/**
 * Each colour's name, as a menu says it. Only the name: what a note's
 * frontmatter holds is the colour's id (`color: red`), whatever the language.
 */
export const COLOR_LABELS: Readonly<Record<ScratchColor, string>> = {
	red: t('scratchpad.color.red'),
	orange: t('scratchpad.color.orange'),
	yellow: t('scratchpad.color.yellow'),
	green: t('scratchpad.color.green'),
	teal: t('scratchpad.color.teal'),
	blue: t('scratchpad.color.blue'),
	purple: t('scratchpad.color.purple'),
	pink: t('scratchpad.color.pink'),
};

/** The colours to choose from, the one the card has pressed. */
export const colorItems = (
	current: ScratchColor | undefined,
	onColor: (color: ScratchColor | undefined) => void
): OptionsMenuItem[] => [
	{
		label: t('scratchpad.color.none'),
		swatch: '',
		pressed: current === undefined,
		onChoose: () => {
			onColor(undefined);
		},
	},
	...SCRATCH_COLORS.map((color): OptionsMenuItem => ({
		label: COLOR_LABELS[color],
		swatch: color,
		pressed: current === color,
		onChoose: () => {
			onColor(color);
		},
	})),
];

/**
 * The card's `⋯`: making it a note, which is offered only while nothing else
 * is being moved, and deleting it. Pinning has a button of its own.
 */
export const cardMenuItems = ({
	onMove,
	onDelete,
}: {
	onMove: (() => void) | undefined;
	onDelete: () => void;
}): OptionsMenuItem[] => [
	...(onMove === undefined ? [] : [{ label: MOVE_LABEL, onChoose: onMove }]),
	{ label: t('scratchpad.menu.delete'), onChoose: onDelete, danger: true },
];
