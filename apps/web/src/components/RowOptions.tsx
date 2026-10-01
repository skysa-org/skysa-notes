import { Icon } from '../editor/icons.js';
import { OptionsMenu, type OptionsMenuItem } from './OptionsMenu.js';

/**
 * A row's own `⋯`: what can be done to the notebook, note or source on that
 * row, at its right-hand end, on every row of the list (2026-10-01).
 *
 * Beside the row's button rather than in it, since the row is a button and a
 * drag source, and a button inside a button is not a thing HTML has. Both sit
 * in the row's `<li>` (`.row-item`): the row keeps its whole width, so its
 * highlight, its drop outline and its hit area are what they were, and this is
 * drawn over the end the row leaves free for it (`.row-options`).
 *
 * A right-click on the row opens the same items (`FloatingMenu`). With none to
 * offer — a move under way, a note begun and not stored — it is there and
 * disabled, so the rows keep their shape.
 */
export const RowOptions = ({
	name,
	kind,
	items,
	disabled = false,
	align = 'end',
}: {
	/** What the row is called, so each button says which row it is about. */
	name: string;
	/** What the row is: "Notebook", "Note", "Source". */
	kind: string;
	items: readonly OptionsMenuItem[];
	disabled?: boolean;
	align?: 'start' | 'end';
}) => (
	<div className="row-options">
		<OptionsMenu
			label={`Options for “${name}”`}
			title={`${kind} options`}
			groupLabel={`${kind} “${name}”`}
			triggerClassName="icon icon-quiet"
			trigger={<Icon name="overflow" />}
			disabled={disabled || items.length === 0}
			align={align}
			items={items}
		/>
	</div>
);
