import { t } from '../i18n/t.js';
import { pinItem } from './noteMenu.js';
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
	/** Pinned to the top of its level on this device (`store/pins.ts`). */
	pinned?: boolean;
	/** Pin or unpin it, whichever it is not. */
	onPin?: () => void;
	onNewInside: () => void;
	onRename: () => void;
	onMove: () => void;
	/** Only where the notebook has files in it (`AttachedFiles.tsx`). */
	onFiles?: () => void;
	onDelete: () => void;
}

/** What can be done to a notebook, wherever it is offered from. */
export const notebookMenuItems = (
	name: string,
	{ pinned, onPin, onNewInside, onRename, onMove, onFiles, onDelete }: NotebookActions
): OptionsMenuItem[] => [
	...pinItem(pinned, onPin),
	{ label: t('notebooks.menu.newInside', { name }), onChoose: onNewInside },
	{ label: t('notebooks.menu.rename'), onChoose: onRename },
	{ label: t('notebooks.menu.move'), onChoose: onMove },
	...(onFiles === undefined ? [] : [{ label: t('notebooks.menu.files'), onChoose: onFiles }]),
	{ label: t('notebooks.menu.delete'), onChoose: onDelete, danger: true },
];
