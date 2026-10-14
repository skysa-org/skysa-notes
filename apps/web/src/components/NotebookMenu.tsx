import { t } from '../i18n/t.js';
import { type NotebookPin } from '../store/pins.js';
import { type OptionsMenuItem } from './OptionsMenu.js';

/**
 * What can be done to a notebook: offered by the `⋯` at the end of its row
 * (`RowOptions`), and by a right-click on the row (`FloatingMenu`).
 *
 * It was one `⋯` in the pane header, about the open notebook, from 2026-09-21
 * until 2026-10-01: the rows were drag sources, a button inside a button is not
 * a thing HTML has, and a control on every row is chrome and hit area taken
 * from the row. It is on every row now, beside the row's button rather than in
 * it, because a menu in the header did not say which notebook it was about
 * until it was opened, and the open notebook is not always the one the user is
 * looking at.
 */

export interface NotebookActions {
	/** Pinned to the top or the bottom of its level on this device (`store/pins.ts`). */
	pinned?: NotebookPin;
	/** Pin it to an end, or unpin it (`undefined`). */
	onPin?: (pin: NotebookPin | undefined) => void;
	onNewInside: () => void;
	onRename: () => void;
	onMove: () => void;
	/** Only where the notebook has files in it (`AttachedFiles.tsx`). */
	onFiles?: () => void;
	onDelete: () => void;
}

/**
 * "Pin to top" and "Pin to bottom", the end it is pinned to said as "Unpin":
 * each in its own place, so a notebook pinned to one end goes to the other in
 * one choice, and the menu does not move about under the pointer.
 */
const pinItems = (
	pinned: NotebookPin | undefined,
	onPin: NotebookActions['onPin']
): OptionsMenuItem[] => {
	if (onPin === undefined) return [];
	const end = (pin: NotebookPin, label: string): OptionsMenuItem =>
		pinned === pin
			? {
					label: t('rows.unpin'),
					onChoose: () => {
						onPin(undefined);
					},
				}
			: {
					label,
					onChoose: () => {
						onPin(pin);
					},
				};
	return [end('top', t('rows.pin')), end('bottom', t('rows.pinBottom'))];
};

/** What can be done to a notebook, wherever it is offered from. */
export const notebookMenuItems = (
	name: string,
	{ pinned, onPin, onNewInside, onRename, onMove, onFiles, onDelete }: NotebookActions
): OptionsMenuItem[] => [
	...pinItems(pinned, onPin),
	{ label: t('notebooks.menu.newInside', { name }), onChoose: onNewInside },
	{ label: t('notebooks.menu.rename'), onChoose: onRename },
	{ label: t('notebooks.menu.move'), onChoose: onMove },
	...(onFiles === undefined ? [] : [{ label: t('notebooks.menu.files'), onChoose: onFiles }]),
	{ label: t('notebooks.menu.delete'), onChoose: onDelete, danger: true },
];
