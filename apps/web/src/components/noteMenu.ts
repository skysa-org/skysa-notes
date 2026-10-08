import { t } from '../i18n/t.js';
import { type OptionsMenuItem } from './OptionsMenu.js';

/**
 * What can be done to a note, wherever it is offered from: the `⋯` at the
 * end of its row in the list, and a right-click on the row. Move is offered
 * only when given — nothing can be picked up while something else already is.
 * Pinning first, as the one thing here that is undone by choosing it again.
 */
export const noteMenuItems = ({
	pinned,
	onPin,
	onMove,
	onDelete,
}: {
	/** Pinned to the top of its notebook's list on this device (`store/pins.ts`). */
	pinned?: boolean;
	/** Pin or unpin it, whichever it is not. */
	onPin?: (() => void) | undefined;
	onMove?: (() => void) | undefined;
	onDelete: () => void;
}): OptionsMenuItem[] => [
	...pinItem(pinned, onPin),
	...(onMove === undefined ? [] : [{ label: t('notes.menu.move'), onChoose: onMove }]),
	{ label: t('notes.menu.delete'), onChoose: onDelete, danger: true },
];

/** "Pin to top", or "Unpin" where it is pinned: a notebook's and a note's. */
export const pinItem = (
	pinned: boolean | undefined,
	onPin: (() => void) | undefined
): OptionsMenuItem[] =>
	onPin === undefined
		? []
		: [{ label: pinned === true ? t('rows.unpin') : t('rows.pin'), onChoose: onPin }];
