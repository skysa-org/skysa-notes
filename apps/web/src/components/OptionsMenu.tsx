import { type ReactNode, useEffect, useRef, useState } from 'react';

import { useEscape } from './useEscape.js';

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
}

export const OptionsMenu = ({
	label,
	title,
	groupLabel,
	triggerClassName,
	trigger,
	disabled = false,
	items,
}: OptionsMenuProps) => {
	const [open, setOpen] = useState(false);
	const frame = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	/** Whether closing should put the focus back where it came from. */
	const handBack = useRef(false);

	const close = () => {
		setOpen(false);
	};

	useEscape(frame, open, close);

	/**
	 * The items have gone, and focus left on a removed element is a keyboard
	 * user back at the top of the document. Not done inside `close`, so that a
	 * press somewhere else on the page — which closes this too — is not
	 * answered by snatching the focus back here.
	 */
	useEffect(() => {
		if (open) {
			handBack.current = true;
			return;
		}
		if (!handBack.current) return;
		handBack.current = false;
		button.current?.focus();
	}, [open]);

	useEffect(() => {
		if (!open) return undefined;
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && frame.current?.contains(target) === true) return;
			handBack.current = false;
			setOpen(false);
		};
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [open]);

	return (
		<div ref={frame} className="options-menu">
			<button
				ref={button}
				type="button"
				className={triggerClassName}
				aria-label={label}
				title={title}
				aria-expanded={open}
				disabled={disabled}
				onClick={() => {
					setOpen((was) => !was);
				}}
			>
				{trigger}
			</button>
			{open && (
				<div className="options-menu-items" role="group" aria-label={groupLabel}>
					{items.map((item) => (
						<button
							key={item.label}
							type="button"
							{...(item.danger === true ? { className: 'danger' } : {})}
							onClick={() => {
								close();
								item.onChoose();
							}}
						>
							{item.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
};
