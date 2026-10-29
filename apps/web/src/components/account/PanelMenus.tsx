import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../../editor/icons.js';
import { t } from '../../i18n/t.js';
import { OptionsMenu, type OptionsMenuItem } from '../OptionsMenu.js';
import { type AccountSlot } from '../SourceTabs.js';

/**
 * The panel's actions as one `⋯` menu, drawn into the end of the showing
 * source's row as every other row's is drawn into its own (`RowOptions`, whose
 * names it takes). There with nothing in it too, disabled, so the rows keep
 * their shape from source to source.
 */
export const ActionsMenu = ({
	slot,
	items,
	triggerRef,
	onOpen,
}: {
	slot: AccountSlot;
	items: readonly OptionsMenuItem[];
	triggerRef?: RefObject<HTMLButtonElement | null>;
	onOpen?: () => void;
}) => {
	// First, as a notebook's menu has it: what the source is called, then what
	// can be done with it.
	const all =
		slot.onRename === undefined
			? items
			: [{ label: t('account.menu.rename'), onChoose: slot.onRename }, ...items];
	return slot.menuIn === null
		? null
		: createPortal(
				<OptionsMenu
					label={t('account.menu.sourceLabel', { name: slot.name })}
					title={t('account.menu.sourceTitle')}
					groupLabel={t('account.menu.sourceGroup', { name: slot.name })}
					triggerClassName="icon icon-quiet"
					trigger={<Icon name="overflow" />}
					disabled={all.length === 0}
					items={all}
					{...(triggerRef === undefined ? {} : { triggerRef })}
					{...(onOpen === undefined ? {} : { onOpen })}
				/>,
				slot.menuIn
			);
};

/**
 * The panel's actions, behind a gear at the end of its status line: what the
 * showing source's `⋯` offers in a compact window's source dropdown, from the
 * same lists. It opens upwards, being at the foot of the window.
 */
export const GearMenu = ({
	items,
	triggerRef,
	onOpen,
}: {
	items: readonly OptionsMenuItem[];
	triggerRef?: RefObject<HTMLButtonElement | null>;
	onOpen?: () => void;
}) => (
	<OptionsMenu
		label={t('account.menu.label')}
		title={t('account.menu.label')}
		groupLabel={t('account.menu.group')}
		triggerClassName="icon icon-quiet"
		trigger={<Icon name="gear" />}
		disabled={items.length === 0}
		items={items}
		rises
		{...(triggerRef === undefined ? {} : { triggerRef })}
		{...(onOpen === undefined ? {} : { onOpen })}
	/>
);

/**
 * The gear and, in a compact window, the source's `⋯` — two menus of one
 * list — and `openButton` kept on the one opened last, which is where the
 * focus goes back to once a question asked from it is put away. The gear,
 * until either is opened. Each has its own ref: a menu's button is also where
 * it is anchored, so the two cannot share one.
 */
export const useMenuButtons = (openButtonRef: RefObject<HTMLButtonElement | null>) => {
	const gear = useRef<HTMLButtonElement>(null);
	const dots = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		openButtonRef.current ??= gear.current;
	});
	const onGear = useCallback(() => {
		openButtonRef.current = gear.current;
	}, [openButtonRef]);
	const onDots = useCallback(() => {
		openButtonRef.current = dots.current;
	}, [openButtonRef]);
	return { gear, dots, onGear, onDots };
};
