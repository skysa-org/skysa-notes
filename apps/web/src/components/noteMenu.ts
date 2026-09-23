import { type OptionsMenuItem } from './OptionsMenu.js';

/**
 * What can be done to a note, wherever it is offered from: the `⋯` in the
 * note's own header and a right-click on its row in the list. Move is offered
 * only when given — nothing can be picked up while something else already is.
 */
export const noteMenuItems = ({
	onMove,
	onDelete,
}: {
	onMove?: (() => void) | undefined;
	onDelete: () => void;
}): OptionsMenuItem[] => [
	...(onMove === undefined ? [] : [{ label: 'Move to notebook…', onChoose: onMove }]),
	{ label: 'Delete', onChoose: onDelete, danger: true },
];
