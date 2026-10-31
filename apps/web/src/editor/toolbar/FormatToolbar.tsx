import { type ReactNode, useMemo, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import type { EditorCommand } from '../commands.js';
import { Icon } from '../icons.js';
import { onPress } from '../press.js';
import { LinkForm, LinkPanel } from './LinkForm.js';
import {
	MenuCommand,
	MoreFormatting,
	Placement,
	TextStyleMenu,
	ToolbarButton,
	ToolbarPopover,
} from './menus.js';
import {
	commandsIn,
	firstStop,
	type Group,
	GROUP_LABELS,
	type Slot,
	type SlotId,
	SLOTS,
} from './slots.js';
import type { FormatToolbarProps, ToolbarPlacement } from './types.js';
import { useRoving } from './useRoving.js';
import { useToolbarFit } from './useToolbarFit.js';

/**
 * The formatting toolbar across the top of the rich editor.
 *
 * Grouped the way Atlassian's editor groups it — text style, then the inline
 * marks, then lists, then indentation, then the link — because that order is
 * what most people writing in a browser already have in their hands. What is
 * missing from it is missing for one reason: markdown cannot hold it. There is
 * no text colour, no highlight and no alignment in a `.md` file, and a button
 * that wrote one would put something in the user's note that the file format
 * loses on the next save. Insert — tables, quotes, dividers — is the slash
 * menu's job here and is deliberately not duplicated; the code block, a file and
 * a secret are the exceptions, and `INSERT_COMMANDS` says why each earns a
 * button.
 *
 * Every button is a view of `FormatState` and an action on the editor, and
 * nothing else: the component holds no document state, so it cannot disagree
 * with the text.
 */

/**
 * What did not fit on the bar, in the order it would have been drawn.
 *
 * A menu that was a slot of its own — "more formatting" — is spread out here
 * rather than nested: a menu inside a menu is two presses and a hover-target
 * for what was one press on a wider screen. The link is the one control that
 * is more than a press, so choosing it swaps the rows for the link's own form,
 * in the same panel.
 *
 * Mounted with the panel, so the form is gone again the next time it opens.
 */
const OverflowItems = ({
	slots,
	hidden,
	format,
	run,
	close,
}: FormatToolbarProps & {
	slots: readonly Slot[];
	hidden: ReadonlySet<string>;
	close: () => void;
}) => {
	const [linking, setLinking] = useState(false);
	if (linking) return <LinkForm href={format.link} run={run} close={close} />;

	return slots
		.filter((slot) => hidden.has(slot.id))
		.flatMap((slot) =>
			slot.id === 'link' ? (
				<button
					key={slot.id}
					type="button"
					className="toolbar-item"
					aria-pressed={format.link !== null}
					{...onPress(() => {
						setLinking(true);
					})}
				>
					<Icon name="link" />
					<span>{t('editor.toolbar.link')}</span>
				</button>
			) : (
				commandsIn(slot.id).map((command) => (
					<MenuCommand
						key={command.id}
						command={command}
						format={format}
						run={run}
						close={close}
					/>
				))
			)
		);
};

/**
 * One line, always. When the bar is too narrow for everything on it, what is
 * least used goes into a menu at the end (`GIVE_UP_ORDER`) and comes back as
 * soon as there is room for it — measured against the bar's own width rather
 * than the window's, since the same window gives the editor very different
 * room depending on what is beside it.
 */
export const FormatToolbar = ({
	format,
	run,
	placement = 'top',
	only,
}: FormatToolbarProps & {
	placement?: ToolbarPlacement;
	/** The slots to draw, by id (`BASIC_SLOTS`); every one, unsaid. */
	only?: readonly SlotId[];
}) => {
	const root = useRef<HTMLDivElement>(null);
	const slots = useMemo(
		() => (only === undefined ? SLOTS : SLOTS.filter(({ id }) => only.includes(id))),
		[only]
	);
	const hidden = useToolbarFit(root, slots);
	const { onKeyDown, stop } = useRoving(root, hidden, firstStop(slots));
	/** At most one panel is open, so which one is the whole of the state. */
	const [open, setOpen] = useState<string | null>(null);
	const opener = (id: string) => (wanted: boolean) => {
		setOpen(wanted ? id : null);
	};
	// A panel whose button has gone into the menu goes with it, and the menu's
	// own panel goes when there is nothing left in it.
	const drawn = open === 'overflow' ? hidden.size > 0 : open === null || !hidden.has(open);
	const openNow = drawn ? open : null;

	const button = (command: EditorCommand) => (
		<ToolbarButton
			key={command.id}
			command={command}
			format={format}
			run={run}
			stop={stop(command.id)}
		/>
	);

	const slot = (id: SlotId): ReactNode => {
		switch (id) {
			case 'text-style':
				return (
					<TextStyleMenu
						format={format}
						run={run}
						open={openNow === id}
						setOpen={opener(id)}
						stop={stop(id)}
					/>
				);
			case 'more-formatting':
				return (
					<MoreFormatting
						format={format}
						run={run}
						open={openNow === id}
						setOpen={opener(id)}
						stop={stop(id)}
					/>
				);
			case 'link':
				return (
					<LinkPanel
						format={format}
						run={run}
						open={openNow === id}
						setOpen={opener(id)}
						stop={stop(id)}
					/>
				);
			default:
				return commandsIn(id).map(button);
		}
	};

	// The slots still on the bar, grouped; a group with nothing left in it is
	// not drawn, and its separator goes with it.
	const groups = slots
		.filter(({ id }) => !hidden.has(id))
		.reduce(
			(drawn, { id, group }) => drawn.set(group, [...(drawn.get(group) ?? []), id]),
			new Map<Group, SlotId[]>()
		);

	return (
		<Placement.Provider value={placement}>
			<div
				className={
					placement === 'bottom'
						? 'format-toolbar format-toolbar-bottom'
						: 'format-toolbar'
				}
				ref={root}
				role="toolbar"
				aria-label={t('editor.toolbar.label')}
				aria-orientation="horizontal"
				onKeyDown={onKeyDown}
			>
				{[...groups].map(([group, ids]) => (
					<div
						key={group}
						className="toolbar-group"
						role="group"
						aria-label={GROUP_LABELS[group]}
						data-group={group}
					>
						{ids.map((id) => (
							<span key={id} className="toolbar-slot" data-slot={id}>
								{slot(id)}
							</span>
						))}
					</div>
				))}

				{hidden.size > 0 && (
					<ToolbarPopover
						id="overflow"
						label={t('editor.toolbar.moreTools')}
						trigger={<Icon name="overflow" />}
						chevron={false}
						className="toolbar-overflow"
						open={openNow === 'overflow'}
						setOpen={opener('overflow')}
						stop={stop('overflow')}
					>
						<OverflowItems
							slots={slots}
							hidden={hidden}
							format={format}
							run={run}
							close={() => {
								setOpen(null);
							}}
						/>
					</ToolbarPopover>
				)}
			</div>
		</Placement.Provider>
	);
};
