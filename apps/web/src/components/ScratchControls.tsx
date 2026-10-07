import { type ScratchColor } from '@skysa/core';

import { Icon } from '../editor/icons.js';
import { t } from '../i18n/t.js';
import { OptionsMenu } from './OptionsMenu.js';
import { cardMenuItems, colorItems } from './scratchMenus.js';

/**
 * The controls a scratch note has, on its card and under its editor alike
 * (docs/ARCHITECTURE.md §7, "The scratchpad"): its pin, its colour, and the
 * `⋯` that makes it a note or deletes it.
 */

/**
 * Pinned or not, as a button that stays pressed. Its name says what it is and
 * `aria-pressed` whether it is on, so a screen reader hears "Pin, pressed"
 * rather than a label that changes under it.
 */
export const PinButton = ({
	pinned,
	onToggle,
	className = 'note-icon',
}: {
	pinned: boolean;
	onToggle: () => void;
	className?: string;
}) => (
	<button
		type="button"
		className={`${className} pin-button`}
		aria-label={t('scratchpad.pin.label')}
		aria-pressed={pinned}
		title={pinned ? t('scratchpad.pin.unpin') : t('scratchpad.pin.pin')}
		onClick={onToggle}
	>
		<Icon name="pin" />
	</button>
);

/** The colours, behind the palette. */
export const ColorMenu = ({
	color,
	onColor,
	rises = false,
	align = 'start',
}: {
	color: ScratchColor | undefined;
	onColor: (color: ScratchColor | undefined) => void;
	rises?: boolean;
	align?: 'start' | 'end';
}) => (
	<OptionsMenu
		label={t('scratchpad.color.menu')}
		title={t('scratchpad.color.menu')}
		groupLabel={t('scratchpad.color.menu')}
		triggerClassName="icon icon-quiet"
		trigger={<Icon name="palette" />}
		items={colorItems(color, onColor)}
		align={align}
		rises={rises}
	/>
);

/** Make it a note, or delete it. */
export const CardMenu = ({
	name,
	onMove,
	onDelete,
	rises = false,
	align = 'start',
}: {
	/** What the card is called, for a screen reader. */
	name: string;
	onMove: (() => void) | undefined;
	onDelete: () => void;
	rises?: boolean;
	align?: 'start' | 'end';
}) => (
	<OptionsMenu
		label={t('scratchpad.menu.options', { name })}
		title={t('scratchpad.menu.title')}
		groupLabel={t('scratchpad.menu.group', { name })}
		triggerClassName="icon icon-quiet"
		trigger={<Icon name="overflow" />}
		items={cardMenuItems({ onMove, onDelete })}
		align={align}
		rises={rises}
	/>
);

/**
 * The bar under a scratch note's editor: its colour, its `⋯` once it is
 * stored (a note not stored yet has nothing to move or delete), and Close.
 */
export const ScratchBar = ({
	name,
	color,
	onColor,
	onMove,
	onDelete,
	onClose,
}: {
	name: string;
	color: ScratchColor | undefined;
	onColor: (color: ScratchColor | undefined) => void;
	onMove: (() => void) | undefined;
	/** Unsaid for a note not stored yet. */
	onDelete: (() => void) | undefined;
	onClose: () => void;
}) => (
	<div className="scratch-bar" role="group" aria-label={t('scratchpad.note')}>
		<ColorMenu color={color} onColor={onColor} rises />
		{onDelete !== undefined && (
			<CardMenu name={name} onMove={onMove} onDelete={onDelete} rises />
		)}
		<button type="button" className="scratch-close" onClick={onClose}>
			{t('common.close')}
		</button>
	</div>
);
