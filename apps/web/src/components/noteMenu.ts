import { type OptionsMenuItem } from './OptionsMenu.js';

/**
 * What can be done to a note, wherever it is offered from: the `⋯` at the
 * end of its row in the list, and a right-click on the row. Move is offered
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
