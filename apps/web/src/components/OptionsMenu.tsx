import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * What can be done to one thing, behind one button: the notebook menu in the
 * sidebar's header (`NotebookMenu`) and the note's in its own.
 *
 * `role="group"` and plain buttons rather than `role="menu"` and `menuitem`,
 * which is the same choice `SourceTabs` made about `tablist`: the ARIA menu
 * pattern owes arrow-key navigation and a roving `tabindex`, and a handful of
 * buttons a user can Tab through already works for everyone. Escape closes it,
 * a press anywhere else closes it, and the button says whether it is open.
 *
 * Drawn as the `+` menu and the editor toolbar's menus are (`.toolbar-panel`,
 * `.toolbar-item`), so the app has one kind of dropdown: a card hung under the
 * control that opened it, with a row per choice. The card itself is the
 * `FloatingMenu` a right-click on a row opens.
 *
 * The items are data rather than children. A `children(close)` render prop
 * reads better from the outside and hands the close out to be called while the
 * items are still rendering, which is exactly what it must not be.
 */

export interface OptionsMenuItem {
	label: string;
	onChoose: () => void;
	/** Said in the colour of bad news, for what cannot be taken back. */
	danger?: boolean;
}

export interface OptionsMenuProps {
	/** What a screen reader hears for the button. */
	label: string;
	/** The tooltip. */
	title: string;
	/** What the open items are about, for a screen reader. */
	groupLabel: string;
	/** The button's own look: its class, and what is drawn in it. */
	triggerClassName: string;
	trigger: ReactNode;
	disabled?: boolean;
	items: readonly OptionsMenuItem[];
	/**
	 * Which edge of the button the card lines up with. `end` (the default)
	 * opens it back across the bar, for a button at the bar's end; `start` the
	 * other way, for one a sidebar's width from the window's left edge. Either
	 * way it is kept inside the window (`FloatingMenu`).
	 */
	align?: 'start' | 'end';
}

/** The gap between a button and the card it opens, as `.toolbar-panel` has it. */
const DROP = 4;

export const OptionsMenu = ({
	label,
	title,
	groupLabel,
	triggerClassName,
	trigger,
	disabled = false,
	items,
	align = 'end',
}: OptionsMenuProps) => {
	/** Where the card is open, under the button, or null while it is shut. */
	const [open, setOpen] = useState<MenuPoint | null>(null);
	const button = useRef<HTMLButtonElement>(null);

	return (
		<div className="options-menu">
			<button
				ref={button}
				type="button"
				className={triggerClassName}
				aria-label={label}
				title={title}
				aria-expanded={open !== null}
				disabled={disabled}
				onClick={(event) => {
					if (open !== null) {
						setOpen(null);
						return;
					}
					const edge = event.currentTarget.getBoundingClientRect();
					setOpen({
						x: align === 'start' ? edge.left : edge.right,
						y: edge.bottom + DROP,
					});
				}}
			>
				{trigger}
			</button>
			{open !== null && (
				<FloatingMenu
					at={open}
					align={align}
					label={groupLabel}
					items={items}
					anchor={button}
					onClose={() => {
						setOpen(null);
					}}
				/>
			)}
		</div>
	);
};

/**
 * The card and its rows: what the `⋯` button opens and what a right-click
 * opens, so the two cannot come to look or behave differently. Choosing closes
 * it first and then acts, so a choice that opens something of its own — a
 * dialog, a field — does so with the menu already gone.
 */
const MenuCard = ({
	label,
	items,
	onChosen,
	cardRef,
	at,
}: {
	label: string;
	items: readonly OptionsMenuItem[];
	onChosen: () => void;
	cardRef: RefObject<HTMLDivElement | null>;
	at: MenuPoint;
}) => (
	<div
		ref={cardRef}
		className="toolbar-panel options-menu-items"
		role="group"
		aria-label={label}
		style={{ left: at.x, top: at.y }}
	>
		{items.map((item) => (
			<button
				key={item.label}
				type="button"
				className={item.danger === true ? 'toolbar-item danger' : 'toolbar-item'}
				onClick={() => {
					onChosen();
					item.onChoose();
				}}
			>
				{item.label}
			</button>
		))}
	</div>
);

/** Where on the page a menu opens, in viewport pixels. */
export interface MenuPoint {
	x: number;
	y: number;
}

/**
 * Where a `contextmenu` event asks for its menu: at the pointer, or — opened
 * from the keyboard, with the menu key or Shift+F10, when the event has no
 * pointer to report and says 0,0 — under the row that has the focus.
 */
export const menuPoint = (event: ReactMouseEvent<HTMLElement>): MenuPoint => {
	if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
	const row = event.currentTarget.getBoundingClientRect();
	return { x: row.left + 16, y: row.bottom };
};

/** Kept this far inside the window, so the card's shadow is not cut off. */
const EDGE = 4;

export interface FloatingMenuProps {
	at: MenuPoint;
	/**
	 * Which of the card's edges is at `at`: its left (`start`, the default, as a
	 * right-click menu opens) or its right (`end`, under the end of a button).
	 */
	align?: 'start' | 'end';
	/** What the items are about, for a screen reader. */
	label: string;
	items: readonly OptionsMenuItem[];
	onClose: () => void;
	/**
	 * The button that opened it, if one did: a press on it is not a press
	 * outside, since the button closes the menu itself, and it is where the
	 * focus goes back to.
	 */
	anchor?: RefObject<HTMLElement | null>;
}

/**
 * A menu of things to do to one thing — a note, a notebook — opened by its
 * `⋯` button or by a right-click on its row.
 *
 * At the end of the page, fixed, for the reason `ConfirmDialog` is: a card
 * inside the sidebar or the note list is only as high as they are, and is cut
 * off where the sidebar ends. Moved back inside the window once it has been
 * measured, so a menu opened near an edge — the notebook's `⋯`, a sidebar's
 * width from the left of a narrow window — is never hung off it.
 *
 * The first item takes the focus, so a menu opened from the keyboard can be
 * used from it, and Escape or a choice hands it back — to the button, or to
 * whatever had it. A press anywhere else closes it without taking the focus
 * back, as does anything that would leave it pointing at something that has
 * moved: scrolling, resizing, or the window losing focus.
 */
export const FloatingMenu = ({
	at,
	align = 'start',
	label,
	items,
	onClose,
	anchor,
}: FloatingMenuProps) => {
	const card = useRef<HTMLDivElement>(null);
	/** Whether closing should put the focus back on what had it. */
	const handBack = useRef(true);

	// Placed on the element itself rather than through state: it is a
	// measurement of what has just been drawn, and a second render to apply it
	// would draw the card once in the wrong place first.
	useLayoutEffect(() => {
		const element = card.current;
		if (element === null) return;
		const { width, height } = element.getBoundingClientRect();
		const left = align === 'end' ? at.x - width : at.x;
		element.style.left = `${String(Math.max(EDGE, Math.min(left, innerWidth - width - EDGE)))}px`;
		element.style.top = `${String(Math.max(EDGE, Math.min(at.y, innerHeight - height - EDGE)))}px`;
	}, [at, align]);

	useEffect(() => {
		const before = anchor?.current ?? document.activeElement;
		card.current?.querySelector('button')?.focus();
		return () => {
			if (handBack.current && before instanceof HTMLElement && before.isConnected) {
				before.focus();
			}
		};
		// Mount and unmount only: the focus is taken once and given back once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const element = card.current;
		const away = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (element?.contains(target) === true || anchor?.current?.contains(target) === true) {
				return;
			}
			handBack.current = false;
			onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener('pointerdown', away);
		// Capture: a scroll in any pane, not only the page's own.
		document.addEventListener('scroll', away, true);
		window.addEventListener('resize', away);
		window.addEventListener('blur', away);
		element?.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', away);
			document.removeEventListener('scroll', away, true);
			window.removeEventListener('resize', away);
			window.removeEventListener('blur', away);
			element?.removeEventListener('keydown', onKey);
		};
	}, [onClose, anchor]);

	return createPortal(
		<MenuCard cardRef={card} label={label} items={items} onChosen={onClose} at={at} />,
		document.body
	);
};
