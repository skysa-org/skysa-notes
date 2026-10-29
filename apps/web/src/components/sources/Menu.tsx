import { type ReactNode, type RefObject, useEffect } from 'react';

import { useEscape } from '../useEscape.js';

/**
 * What the `+` opens. Closes on Escape and on a press anywhere outside it, which is the whole of
 * what a menu this small owes anyone: the buttons inside are ordinary buttons.
 *
 * Dressed as the editor toolbar's menus are (`.toolbar-panel`, `.toolbar-item`
 * in the stylesheet), so the app has one kind of menu rather than one per
 * place: a card hung under the control that opened it, with a row per choice.
 *
 * `frame` is the element around both the menu and the control that opened it,
 * and it is what "inside" means. A press on the control is not a press outside:
 * the control closes the menu itself, and letting this close it first had the
 * control's own click open it straight back up. And Escape is heard from the
 * control as well as from the menu, since the control is where the focus is
 * when a menu has just been opened with the keyboard.
 */
export const Menu = ({
	children,
	className,
	label,
	frame,
	onClose,
}: {
	children: ReactNode;
	className: string;
	label: string;
	frame: RefObject<HTMLElement | null>;
	onClose: () => void;
}) => {
	useEscape(frame, true, onClose);

	useEffect(() => {
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && frame.current?.contains(target) === true) return;
			// A dialog is over everything, this menu included, and one opened from
			// in here is drawn at the end of the page (`ConnectButton`): a press in
			// it is an answer to it, not a press outside.
			if (target instanceof Element && target.closest('[aria-modal="true"]') !== null) return;
			onClose();
		};
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [onClose, frame]);

	return (
		<div className={`toolbar-panel ${className}`} role="group" aria-label={label}>
			{children}
		</div>
	);
};
