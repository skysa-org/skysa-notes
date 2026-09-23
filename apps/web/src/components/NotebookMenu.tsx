import { OptionsMenu } from './OptionsMenu.js';

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
 * The menu itself is `OptionsMenu`, which the note's header uses too.
 */

export interface NotebookMenuProps {
	/** The open notebook's name, which every item is about. */
	name: string;
	/** No notebook open, or the loose notes, which are not a notebook. */
	disabled: boolean;
	onNewInside: () => void;
	onRename: () => void;
	onMove: () => void;
	onDelete: () => void;
}

export const NotebookMenu = ({
	name,
	disabled,
	onNewInside,
	onRename,
	onMove,
	onDelete,
}: NotebookMenuProps) => (
	<OptionsMenu
		// Named for the notebook, so a screen-reader user knows what the menu is
		// about before opening it — there is one of these and it changes subject
		// as they move around the tree.
		label={disabled ? 'Notebook options' : `Options for “${name}”`}
		title="Notebook options"
		groupLabel={`Notebook “${name}”`}
		triggerClassName="icon"
		trigger="⋯"
		disabled={disabled}
		items={[
			{ label: `New notebook inside “${name}”`, onChoose: onNewInside },
			{ label: 'Rename', onChoose: onRename },
			{ label: 'Move', onChoose: onMove },
			{ label: 'Delete', onChoose: onDelete, danger: true },
		]}
	/>
);
