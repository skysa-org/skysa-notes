import { Icon } from '../editor/icons.js';
import { OptionsMenu, type OptionsMenuItem } from './OptionsMenu.js';

/**
 * What can be done to the open notebook, behind one button in the pane header.
 *
 * In the header rather than on every row. The rows are drag sources now, and a
 * button inside a button is not a thing HTML has — each row would have to
 * become a wrapper holding two controls, which is a lot of chrome and a lot of
 * hit area taken from the thing the row is for. The open notebook is already
 * the subject of the pane beside it ("New note" puts one there), so it is the
 * subject here too, and opening a notebook to act on it costs one click that
 * changes nothing.
 *
 * The menu itself is `OptionsMenu`, which the note's header uses too. A
 * right-click on any notebook's row opens the same items about that notebook
 * (`notebookMenuItems`, `ContextMenu`).
 */

export interface NotebookActions {
	onNewInside: () => void;
	onRename: () => void;
	onMove: () => void;
	onDelete: () => void;
}

/** What can be done to a notebook, wherever it is offered from. */
export const notebookMenuItems = (
	name: string,
	{ onNewInside, onRename, onMove, onDelete }: NotebookActions
): OptionsMenuItem[] => [
	{ label: `New notebook inside “${name}”`, onChoose: onNewInside },
	{ label: 'Rename', onChoose: onRename },
	{ label: 'Move', onChoose: onMove },
	{ label: 'Delete', onChoose: onDelete, danger: true },
];

export interface NotebookMenuProps extends NotebookActions {
	/** The open notebook's name, which every item is about. */
	name: string;
	/** No notebook open, or the loose notes, which are not a notebook. */
	disabled: boolean;
}

export const NotebookMenu = ({ name, disabled, ...actions }: NotebookMenuProps) => (
	<OptionsMenu
		// Named for the notebook, so a screen-reader user knows what the menu is
		// about before opening it — there is one of these and it changes subject
		// as they move around the tree.
		label={disabled ? 'Notebook options' : `Options for “${name}”`}
		title="Notebook options"
		groupLabel={`Notebook “${name}”`}
		triggerClassName="icon icon-quiet"
		// The note menu's glyph, not a `⋮` character: a character sits on its
		// font's baseline, and the two buttons should draw the same three dots.
		trigger={<Icon name="overflow" />}
		disabled={disabled}
		// Rightwards, over the note list: the button is at the sidebar's end, a
		// sidebar's width from the window's left edge, and a card opened
		// leftwards from it went off the window in a narrow one.
		align="start"
		items={notebookMenuItems(name, actions)}
	/>
);
