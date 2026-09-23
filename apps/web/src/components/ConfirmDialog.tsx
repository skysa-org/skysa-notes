import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useSuspendShortcuts } from '../commands/context.js';

/**
 * A question the app asks over everything, with one answer and Cancel.
 *
 * At the end of the page rather than where it was asked from. The `+` menu
 * (z-index 20) and the compact source panel (15) are each a stacking context,
 * and a dialog inside either is only as high as they are — under the toast
 * stack (30), which it has to be over. The `+` menu knows a press in a modal
 * dialog is not a press outside it.
 *
 * Cancel has the focus, as it does everywhere the app asks something, and
 * Escape is Cancel. Tab goes between the buttons and nowhere else: `aria-modal`
 * says the rest of the page is out of reach, so it has to be. The shortcuts
 * are held for as long as it is up, for the same reason — a chord pressed out
 * of habit would act on a page the user cannot get at.
 *
 * `tone` is how the answer is drawn: `primary` for the one the question
 * expects, `danger` for one that deletes.
 */
export interface ConfirmDialogProps {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	tone: 'primary' | 'danger';
	onConfirm: () => void;
	onCancel: () => void;
	/**
	 * Where the focus goes when the dialog does. Without it, back to whatever
	 * had it before, if that is still on the page.
	 */
	returnFocus?: RefObject<HTMLElement | null>;
}

export const ConfirmDialog = ({
	title,
	children,
	confirmLabel,
	tone,
	onConfirm,
	onCancel,
	returnFocus,
}: ConfirmDialogProps) => {
	const titleId = useId();
	const textId = useId();
	const dialog = useRef<HTMLDivElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	useSuspendShortcuts();

	useEffect(() => {
		// Read now: what it names is on the page for as long as the question is.
		const back = returnFocus?.current ?? document.activeElement;
		cancel.current?.focus();
		return () => {
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
		// Mount and unmount only: the focus is taken once and given back once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onCancel();
				return;
			}
			if (event.key !== 'Tab') return;
			const buttons = [...element.querySelectorAll('button')];
			const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
			const next = (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
			event.preventDefault();
			buttons[next]?.focus();
		};
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, [onCancel]);

	return createPortal(
		<div className="modal-backdrop">
			<div
				ref={dialog}
				className="modal"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={textId}
			>
				<h2 id={titleId}>{title}</h2>
				<p id={textId}>{children}</p>
				<div className="modal-actions">
					<button type="button" className={tone} onClick={onConfirm}>
						{confirmLabel}
					</button>
					<button ref={cancel} type="button" onClick={onCancel}>
						Cancel
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
};
